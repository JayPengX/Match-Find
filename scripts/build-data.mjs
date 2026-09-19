// ---- scripts/build-data.mjs ----
// Fetches upcoming AND currently-live fixtures for the Premier League, MLS,
// MLB, NBA, and F1 from ESPN's public scoreboard API (no key required)
// across the next DAYS_AHEAD days, scores each one for competitiveness/
// watchability, and writes the flat result to public/data/matches.json for
// the static site to render. Only a FINISHED fixture is excluded - a live
// one is exactly what "what's worth watching" should be able to recommend.
//
// Runs at build time only (a scheduled GitHub Action, see
// .github/workflows/deploy.yml) - never per page view, and never triggered
// by a visitor's browser. This is the "AI recommendation runs automatically
// in the background" half of the site: Gemini scoring happens here, on a
// schedule, independent of anyone looking at the page.
//
// This script deliberately does NOT decide which matches get recommended,
// or exclude any time of day - see public/app.js's resolveViewingPlan for
// why that part has to run in the browser instead: "don't recommend a
// midnight fixture" and "what's the closest match right now" are both
// relative to a viewer's own local clock, which this script has no way to
// know at build time (one build serves every viewer, in every timezone).
// What this script DOES own is the one thing that isn't viewer-relative:
// how competitive/watchable a fixture is, which is why that scoring still
// happens once here and gets cached rather than recomputed per viewer.
//
// The "worth watching" judgment (competitiveness/watchability scores) comes
// from a shared Cloudflare Worker in its own repo, jaypengx-collab/shared-proxy
// (see PROXY_URL below), which holds a Gemini API key server-side - this
// script never needs one of its own.
// If PROXY_URL isn't configured, or a call to it fails, matches fall back
// to a simple local heuristic (see heuristicScore) so the site still works,
// just with less insightful picks.
//
// Gemini is only ever asked to score a given match ONCE, the first build
// where that match appears inside the fetch window - see the AI score
// cache section below. A scheduled run every 6 hours would otherwise
// re-score the same heavily-overlapping window of fixtures on every single
// run, burning quota for a judgment that doesn't change between builds.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { teamNameZh, f1RaceNameZh } from './team-names.mjs';

const PROXY_URL = (process.env.PROXY_URL || '').trim().replace(/\/+$/, '');
// The commit this build ran from (.github/workflows/deploy.yml passes
// github.sha) - lets a long-open tab tell a genuine code deploy (a new
// commit) apart from a routine scheduled rebuild of the same commit (see
// public/app.js's update-check polling). Falls back to a fixed string for
// local runs, where there's no meaningful "commit this build is from".
const BUILD_ID = (process.env.BUILD_ID || 'local').trim();
const OUTPUT_PATH = new URL('../public/data/matches.json', import.meta.url);
// Committed to the repo (unlike matches.json, which is fully regenerated
// every run) - this is the persistent record of which matches have already
// been scored by Gemini, so it has to survive between separate workflow
// runs. See .github/workflows/deploy.yml's "Commit updated AI score cache"
// step for how it gets pushed back.
const CACHE_PATH = new URL('../data/ai-cache.json', import.meta.url);
// Sibling to CACHE_PATH, committed the same way (see .github/workflows/
// deploy.yml's "Commit updated AI score cache" step) - holds the one thing
// that isn't keyed by match id: when Gemini was last actually called. Kept
// out of ai-cache.json itself so that file stays a pure match-id map.
const AI_META_PATH = new URL('../data/ai-meta.json', import.meta.url);

// Bumped whenever a change to the shared proxy's /match-recommend prompt is worth
// re-scoring already-cached matches for (e.g. teaching it to ground
// whereToWatchTw in an actual search instead of guessing) - every cache
// entry stamps the PROMPT_VERSION it was scored under, and needsScoring
// below retries anything scored under an older one. A one-time full
// re-score costs quota, but it's the only way an already-cached match ever
// benefits from a prompt fix instead of keeping a stale answer forever.
const PROMPT_VERSION = 5;

// Which GitHub Actions event triggered this run - 'schedule' for the
// routine 6-hourly rerun, 'push' for a real commit landing on main, or
// 'workflow_dispatch' for someone manually clicking "Run workflow" (see
// .github/workflows/deploy.yml). Empty string for a local run, which is
// treated the same as an explicit request below - there's no "routine
// background job" to throttle when a person is sitting there running it.
const GITHUB_EVENT_NAME = (process.env.GITHUB_EVENT_NAME || '').trim();
// A scheduled run only actually calls Gemini if it's been at least this
// long since the last real call - seeing a couple of newly-in-window
// fixtures every 6 hours would otherwise mean several small Gemini calls a
// day for no real benefit (see the top-of-file comment: quota only cares
// about calling once per MATCH, but a steady trickle of small requests all
// day is still more calls than one batched one). A push or manual dispatch
// always calls it regardless - see main()'s throttling check.
const AI_FETCH_MIN_INTERVAL_HOURS = 20;

// ---- Contested-cluster refinement (the shared proxy's /match-recommend-refine) ------
//
// The base scoring pass above scores every fixture independently, in one
// big batch - fine for "roughly how good is this", weak at "which of these
// two SPECIFIC overlapping fixtures is the bigger deal", since nothing
// about that call lets the model weigh them against each other. Fixtures
// that overlap in time AND land within CONTESTED_SCORE_DELTA of each
// other's score are genuinely contesting the same viewing slot, and get a
// second, comparative pass with the shared proxy's Pro-tier-first refine
// route (see that repo's, jaypengx-collab/shared-proxy, MATCH_RECOMMEND_REFINE_MODELS) -
// deliberately only THOSE fixtures, never the full list, since a Pro-tier model's free-tier quota
// is far smaller than Flash's and shared across every feature the shared
// proxy Worker serves, not just this one.
const CONTESTED_SCORE_DELTA = 1;
// Not worth refining two mediocre matches into a slightly-more-precisely-
// ranked pair of mediocre matches - this keeps refinement calls spent on
// slots that actually matter.
const CONTESTED_MIN_SCORE = 6;
// Hard cap on how many separate refine calls one run makes, regardless of
// how many contested clusters exist - bounds worst-case Pro-tier quota use
// per run even on an unusually contested day. Clusters beyond this cap
// just keep their base-pass scores and get reconsidered on the next
// eligible (unthrottled) run.
const MAX_REFINE_CLUSTERS_PER_RUN = 5;
// Mirrors the shared proxy's own MATCH_RECOMMEND_REFINE_MAX_ITEMS - kept as a
// separate constant here (repos can't share code) purely so an unusually
// large cluster gets trimmed to its own highest-scoring members before
// sending, rather than firing a request the server would just 400 anyway.
const REFINE_CLUSTER_MAX_ITEMS = 6;

// How many calendar days ahead (from today, UTC) to fetch. The site's day
// scroller shows the first 7 of these up front and reveals the rest on a
// "load more" click - all client-side, no extra network request, since
// everything through DAYS_AHEAD is already baked into matches.json by the
// time anyone opens the page. 14 gives that click something real to reveal.
const DAYS_AHEAD = 14;
// Cache entries for matches that started more than this long ago are
// dropped on every run - once a match has aired there's no reason to keep
// re-shipping its score in the cache file forever.
const CACHE_RETENTION_HOURS = 12;
// The shared proxy's /match-recommend route caps a single request at 80 fixtures (see
// that repo's worker.js) - a 14-day window's first
// ever build can easily find several hundred NEW fixtures at once (nothing
// is cached yet), so those get sent in sequential batches under that cap
// rather than in one oversized request. Once the cache is warm, a normal
// 6-hourly run only has a handful of newly-in-window fixtures per batch.
const AI_SCORE_BATCH_SIZE = 75;

// Team-sport leagues, all sharing the same ESPN scoreboard shape
// (site.api.espn.com/apis/site/v2/sports/<sportKey>/<leagueKey>/scoreboard).
// durationMinutes is this script's only notion of "how long a match runs" -
// ESPN's scoreboard never gives an end time, so every conflict/scheduling
// decision (see app.js's resolveViewingPlan) works off this per-sport
// AVERAGE broadcast length, not any per-match actual duration.
const TEAM_LEAGUES = [
  { id: 'epl', sportKey: 'soccer', leagueKey: 'eng.1', label: 'Premier League', durationMinutes: 115 },
  { id: 'mls', sportKey: 'soccer', leagueKey: 'usa.1', label: 'MLS', durationMinutes: 115 },
  { id: 'mlb', sportKey: 'baseball', leagueKey: 'mlb', label: 'MLB', durationMinutes: 190 },
  { id: 'nba', sportKey: 'basketball', leagueKey: 'nba', label: 'NBA', durationMinutes: 150 }
];

const F1_LOGO = 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/leagues/500/f1.png';

function espnScoreboardUrl(sportKey, leagueKey, datesParam) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${sportKey}/${leagueKey}/scoreboard`;
  return datesParam ? `${base}?dates=${datesParam}` : base;
}

function yyyymmddUtc(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

// True when ESPN has a fixture on the schedule (a real event id, real
// competitors) but hasn't nailed down a kickoff time yet - confirmed live
// against the NFL's own flex-scheduled slate (same "state: pre,
// STATUS_SCHEDULED" shape MLB postseason games use before a bracket/TV slot
// is set): `date` still holds SOME timestamp, but it's a placeholder, not a
// real kickoff, and ESPN's own signal for that is status.type.shortDetail/
// detail containing "TBD" rather than a separate boolean flag. Most common
// for MLB/NBA playoff games scheduled before their exact date and time is
// announced - see fetchTeamLeagueMatches below for how this changes what
// gets built.
function isTimeTbd(statusType) {
  return /\bTBD\b/i.test(statusType?.shortDetail || statusType?.detail || '');
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

// One competitor's overall win-loss record as {wins, losses}, or null if
// ESPN didn't report one (a brand new season, or a sport/league whose
// records aren't shaped like "W-L", e.g. soccer's points-based standings
// aren't summarized here at all). Only used for the local heuristic
// fallback and for the short human-readable context string handed to
// Gemini - never trusted for anything more precise than "roughly how good
// is this team right now".
function parseOverallRecord(competitor) {
  const summary = (competitor.records || []).find(r => r.type === 'total' || r.name === 'overall')
    ?.summary;
  const match = /^(\d+)-(\d+)(?:-(\d+))?$/.exec(summary || '');
  if (!match) return null;
  return { wins: Number(match[1]), losses: Number(match[2]) };
}

function buildCompetitor(leagueId, c) {
  const abbreviation = c.team?.abbreviation || '';
  return {
    name: c.team?.displayName || 'Unknown',
    nameZh: teamNameZh(leagueId, abbreviation),
    abbreviation,
    logo: c.team?.logo || '',
    homeAway: c.homeAway || '',
    record: parseOverallRecord(c)
  };
}

function competitorContext(competitor) {
  const record = competitor.record;
  return record ? `${competitor.name} (${record.wins}-${record.losses})` : competitor.name;
}

async function fetchTeamLeagueMatches(league, now, windowEndMs, daysAhead) {
  // Queries `now`'s own UTC date AND the day before it - not just `now`
  // onward. This script runs on a schedule/on push, at whatever UTC
  // instant that happens to be, and ESPN's own `dates=YYYYMMDD` scoreboard
  // query groups a game under the calendar day IT started on by ESPN's own
  // reckoning (for MLB in particular, that tracks the US Eastern "game
  // date", not the UTC one) - the two only diverge for part of the day,
  // but this script's own `now` can easily land inside that gap: at, say,
  // 03:00 UTC the U.S. is still on the PREVIOUS Eastern calendar date
  // (23:00 ET), so a West Coast night game running long (extra innings,
  // a rain delay) is still genuinely live RIGHT NOW but was filed under a
  // UTC date this loop would otherwise never even ask ESPN about - it
  // wouldn't be missing because it's not "pre"/"in" (see the state filter
  // below), it would be missing because this script never requested that
  // day's scoreboard at all. Confirmed as a real, live miss: a viewer
  // reported watching an MLB game this site's recommendations showed
  // nothing for. The state filter and the startMs bounds check just below
  // already correctly exclude anything from that extra day that ISN'T
  // still 'pre' or 'in' and within window, so asking for one more day up
  // front costs one extra request per league and risks nothing.
  const dates = Array.from({ length: daysAhead + 1 }, (_, i) =>
    yyyymmddUtc(new Date(now.getTime() + (i - 1) * 86_400_000))
  );
  const results = await Promise.allSettled(
    dates.map(date => fetchJson(espnScoreboardUrl(league.sportKey, league.leagueKey, date)))
  );

  const matches = [];
  const seenIds = new Set();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const event of result.value.events || []) {
      if (seenIds.has(event.id)) continue; // a doubleheader's 2nd game can appear under both query dates near midnight UTC
      const competition = event.competitions?.[0];
      const statusType = competition?.status?.type;
      // Only a truly FINISHED fixture ('post') is excluded - a LIVE one
      // ('in') is exactly what this site should be recommending someone
      // watch right now, and used to be dropped here by mistake: this
      // script re-fetches ESPN's feed on every scheduled run (every ~6h)
      // AND on every push, and a fixture that was 'pre' (upcoming) at one
      // run has very often flipped to 'in' by the time the next run
      // happens mid-game - previously that meant a match simply vanished
      // from matches.json the moment it actually started, taking its
      // "recommended" status and the client's own "直播中"/is-live
      // styling (public/app.js's relativeLabel/buildMatchCard - both
      // already built to handle a live match, just never fed one) with it.
      // Confirmed live: a viewer mid-game, asking why "today" suddenly
      // showed nothing for the sport they were actively watching.
      if (statusType?.state !== 'pre' && statusType?.state !== 'in') continue;
      const isLive = statusType.state === 'in';
      const timeTbd = isTimeTbd(statusType);
      const startMs = Date.parse(event.date);
      if (!Number.isFinite(startMs)) continue;
      // A TBD fixture's `date` is only a placeholder (see isTimeTbd's own
      // comment) - it can read as already past, or outside the requested
      // window, even though the fixture itself is real and upcoming. It was
      // only ever returned here because this whole request was already
      // scoped to one day inside [now, now+daysAhead) (see the `dates` loop
      // above), so that alone is enough to know it belongs in this window -
      // a non-TBD fixture still needs the precise bounds check since ESPN's
      // per-day results occasionally spill a neighboring day's event across
      // a UTC midnight boundary. A LIVE fixture is exempted from the lower
      // bound the same way TBD is, for the same underlying reason: its
      // start time is necessarily already in the past (that's what "live"
      // means), which the plain `startMs < now` check would otherwise
      // reject as if it were a stale event from outside the window - the
      // upper bound still applies (windowEndMs is always well in the
      // future, so this never actually lets in anything unreasonable).
      if (!timeTbd && !isLive && (startMs < now.getTime() || startMs > windowEndMs)) continue;
      seenIds.add(event.id);

      // Always [away, home] regardless of the order ESPN happens to list
      // them in, so `name`/`nameZh` below are built consistently as
      // "AWAY @ HOME" for every sport - the same convention ESPN's own
      // shortName uses, just under this script's own control so an English
      // and a Chinese version can be built the same way.
      const rawCompetitors = (competition.competitors || []).map(c => buildCompetitor(league.id, c));
      const away = rawCompetitors.find(c => c.homeAway === 'away') || rawCompetitors[0];
      const home = rawCompetitors.find(c => c.homeAway === 'home') || rawCompetitors[1];
      const competitors = [away, home].filter(Boolean);
      if (competitors.length !== 2) continue;
      // A playoff slot ESPN has reserved but not yet assigned real teams to
      // (confirmed live: MLB Wild Card slots show up as literally "TBD @
      // TBD", weeks before either team is known) isn't a fixture this site
      // can say anything useful about, and worse, caching a score for it
      // under its event id would leave that stale "no info yet" answer
      // stuck forever once ESPN DOES fill in the real teams later - this
      // script has no signal that would ever invalidate it (same id, same
      // PROMPT_VERSION, different opponents). Simplest correct fix: don't
      // surface it at all until ESPN itself knows who's actually playing.
      if (competitors.some(c => c.abbreviation === 'TBD' || c.name === 'TBD')) continue;

      const broadcast = (competition.broadcasts || [])
        .flatMap(b => b.names || [])
        .slice(0, 1)[0];
      // ESPN's season.type is 2 for the regular season and 3 for the
      // postseason (confirmed against the live API) - surfaced to Gemini as
      // plain context, not scored locally, since "this is a playoff game"
      // is exactly the kind of stakes judgment the AI prompt already asks
      // for (see the shared proxy's buildMatchRecommendPrompt) and this script has no
      // real basis to weigh it itself.
      const isPostseason = event.season?.type === 3;

      matches.push({
        id: `${league.id}-${event.id}`,
        sport: league.label,
        name: `${away.name} @ ${home.name}`,
        nameZh: away.nameZh && home.nameZh ? `${away.nameZh} @ ${home.nameZh}` : '',
        startTimeUtc: new Date(startMs).toISOString(),
        // See isTimeTbd's own comment - when true, startTimeUtc above is
        // only a placeholder and the client (public/app.js) knows not to
        // schedule or display this fixture by clock time at all.
        timeTbd,
        durationMinutes: league.durationMinutes,
        venue: competition.venue?.fullName || '',
        broadcast: broadcast || '',
        logo: '',
        competitors,
        context:
          competitors.map(competitorContext).join(' vs ') + (isPostseason ? ' (postseason/playoff game)' : '')
      });
    }
  }
  return matches;
}

// F1 has a completely different ESPN shape: one "event" is a whole race
// weekend, and its "competitions" array is the individual sessions (FP1,
// FP2, FP3, Qualifying, Sprint Shootout, Sprint, Race) rather than
// per-team competitors - see the research notes in this repo's history.
// Confirmed live across both ordinary and sprint weekends: `type.
// abbreviation` is a stable, non-colliding key per session ("Race" is
// always the main race even on a sprint weekend, which uses "SR"/"SS" for
// its own sprint race/shootout instead) - unlike the team leagues, this
// needs an actual date-RANGE query (confirmed against the live API) to
// return more than just the single nearest race weekend.
//
// Practice sessions (FP1-3) and the sprint shootout (sprint-specific
// qualifying, "SS") aren't included - not "a match to watch" in the sense
// this site recommends, same reasoning as before. Qualifying and the
// sprint race itself ARE included now: both are genuinely watchable
// events in their own right, not just a preview of the race - a fast
// qualifying lap or a 30-lap sprint has its own drama independent of
// Sunday's race.
const F1_SESSION_TYPES = [
  { abbreviation: 'Race', labelSuffix: '', labelSuffixZh: '', durationMinutes: 120 },
  { abbreviation: 'Qual', labelSuffix: ' Qualifying', labelSuffixZh: '排位賽', durationMinutes: 75 },
  { abbreviation: 'SR', labelSuffix: ' Sprint', labelSuffixZh: '衝刺賽', durationMinutes: 60 }
];

async function fetchF1Matches(now, windowEndMs, daysAhead) {
  // Starts one day before `now`, same reasoning and same fix as
  // fetchTeamLeagueMatches's own `dates` array above - a session ESPN
  // files under the previous UTC date that's still live right now
  // shouldn't be invisible to this query just because it started
  // yesterday by ESPN's own reckoning.
  const rangeParam = `${yyyymmddUtc(new Date(now.getTime() - 86_400_000))}-${yyyymmddUtc(new Date(now.getTime() + daysAhead * 86_400_000))}`;
  let data;
  try {
    data = await fetchJson(espnScoreboardUrl('racing', 'f1', rangeParam));
  } catch {
    return [];
  }
  const matches = [];
  for (const event of data.events || []) {
    const raceNameZh = f1RaceNameZh(event.name);
    for (const sessionType of F1_SESSION_TYPES) {
      const session = (event.competitions || []).find(c => c.type?.abbreviation === sessionType.abbreviation);
      if (!session) continue; // e.g. no "SR" on a non-sprint weekend
      const statusType = session.status?.type;
      // Same fix as fetchTeamLeagueMatches above, same reasoning: a LIVE
      // session ('in' - e.g. an in-progress qualifying or race) should
      // still be recommendable, not dropped the moment it starts.
      if (statusType?.state !== 'pre' && statusType?.state !== 'in') continue;
      const isLive = statusType.state === 'in';
      const timeTbd = isTimeTbd(statusType);
      const startMs = Date.parse(session.date || event.date);
      if (!Number.isFinite(startMs)) continue;
      if (!timeTbd && !isLive && (startMs < now.getTime() || startMs > windowEndMs)) continue;

      const broadcast = (session.broadcasts || []).flatMap(b => b.names || []).slice(0, 1)[0];

      matches.push({
        id: `f1-${event.id}-${sessionType.abbreviation.toLowerCase()}`,
        sport: 'F1',
        name: `${event.name}${sessionType.labelSuffix}`,
        nameZh: raceNameZh ? `${raceNameZh}${sessionType.labelSuffixZh ? '－' + sessionType.labelSuffixZh : ''}` : '',
        startTimeUtc: new Date(startMs).toISOString(),
        timeTbd,
        durationMinutes: sessionType.durationMinutes,
        venue: event.circuit?.fullName || '',
        broadcast: broadcast || '',
        logo: F1_LOGO,
        competitors: [],
        context: `${event.name}${sessionType.labelSuffix} - Formula 1${sessionType.labelSuffix ? ' ' + sessionType.labelSuffix.trim().toLowerCase() : ' race'}`
      });
    }
  }
  return matches;
}

// Used when Gemini scoring isn't available (PROXY_URL unset, or the call
// failed) - a rough, purely local stand-in so the site still has something
// to show. Closer win-loss records score more "competitive"; two strong
// records score more "watchable". Deliberately conservative (never above 8)
// since this has no real sports knowledge behind it.
function heuristicScore(match) {
  const records = match.competitors.map(c => c.record).filter(Boolean);
  // The site is Traditional Chinese throughout (see public/app.js) - this
  // reason has to read that way too even though it never touched Gemini,
  // same as venueZh/whereToWatchTw below staying empty rather than an
  // untranslated English placeholder. The UI itself appends an "(估計，非
  // AI 推薦)" caveat (see styles.css .is-heuristic) - this stays purely
  // descriptive so the two don't repeat each other.
  if (records.length !== 2) {
    return { competitiveness: 5, watchability: 5, reason: '目前沒有雙方的戰績資料可供估計。', venueZh: '', whereToWatchTw: '' };
  }
  const winRates = records.map(r => r.wins / Math.max(1, r.wins + r.losses));
  const diff = Math.abs(winRates[0] - winRates[1]);
  const avg = (winRates[0] + winRates[1]) / 2;
  return {
    competitiveness: Math.max(1, Math.min(8, Math.round(8 - diff * 16))),
    watchability: Math.max(1, Math.min(8, Math.round(avg * 10))),
    reason: `依雙方目前戰績估計（${records[0].wins}勝${records[0].losses}敗 對 ${records[1].wins}勝${records[1].losses}敗）。`,
    // Neither can be guessed locally - no real-world knowledge behind this
    // fallback path at all (see this function's own top comment) - so both
    // stay empty and the UI just omits that line rather than showing a
    // fabricated translation or broadcaster.
    venueZh: '',
    whereToWatchTw: ''
  };
}

// ---- AI score cache ---------------------------------------------------
// Keyed by match id (stable across runs - see how ids are built above), so
// a match already scored BY GEMINI on an earlier run is never re-sent.
// Only startTimeUtc is kept alongside the score, purely so pruneCache can
// drop entries for matches that have already aired without needing to
// re-fetch anything.
//
// A cached entry with source:'heuristic' is deliberately NOT treated as
// done (see needsScoring in main()) - it means an earlier run couldn't
// reach the proxy (PROXY_URL unset, or the call failed) and fell back
// locally, not that Gemini actually judged this match. Caching that as
// final would permanently lock a match onto the heuristic the moment the
// proxy happened to be unavailable for even one run, with no way to ever
// pick up a real score later even after the proxy starts working - so
// every build keeps retrying any match that hasn't been scored by Gemini
// yet, for as long as it's still in the fetch window.
async function loadCache() {
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function loadMeta() {
  try {
    const parsed = JSON.parse(await readFile(AI_META_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function pruneCache(cache, now) {
  const cutoff = now.getTime() - CACHE_RETENTION_HOURS * 60 * 60 * 1000;
  const pruned = {};
  for (const [id, entry] of Object.entries(cache)) {
    if (Date.parse(entry.startTimeUtc) >= cutoff) pruned[id] = entry;
  }
  return pruned;
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

// Sends only the fixtures NOT already in the cache to the shared
// Cloudflare Worker (jaypengx-collab/shared-proxy), which owns the actual Gemini prompt/schema (see that
// repo's worker.js, route /match-recommend) and
// holds the real API key - this script only ever sends {id, sport, name,
// startTimeUtc, context, venue, broadcast}, the same shape for every
// fixture regardless of sport. This is the entire reason Gemini quota use
// stays flat no matter how often the build runs: a match that was already
// scored on a previous run simply isn't included in the request body at
// all. Batched under
// AI_SCORE_BATCH_SIZE (see that constant's own comment) so a cold cache
// across a 14-day window never exceeds the proxy's per-request cap.
//
// `broadcast` is ESPN's own on-record national broadcaster for the
// fixture (e.g. "Apple TV", "TBS", "Fox") - not a Taiwan answer by itself,
// but a concrete, per-fixture signal the prompt can reason from instead of
// guessing blind. A generic web search for "which channel shows this one
// specific game in Taiwan" often has thin coverage; knowing the game is,
// say, one of MLB's Apple TV-exclusive "Friday Night Baseball" slate (a
// genuinely global exclusive with no regional blackout, unlike a plain US
// cable network name) is a much stronger and cheaper hint than hoping
// search finds an authoritative Taiwan-specific source for one game.
async function fetchAiScores(matchesNeedingScore) {
  if (!PROXY_URL || !matchesNeedingScore.length) return new Map();
  const picks = new Map();
  for (const batch of chunk(matchesNeedingScore, AI_SCORE_BATCH_SIZE)) {
    const payload = batch.map(m => ({
      id: m.id,
      sport: m.sport,
      name: m.name,
      startTimeUtc: m.startTimeUtc,
      context: m.context,
      venue: m.venue,
      broadcast: m.broadcast
    }));
    try {
      const response = await fetch(`${PROXY_URL}/match-recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matches: payload }),
        signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok) {
        console.warn(`/match-recommend -> HTTP ${response.status}: ${await response.text().catch(() => '')}`);
        continue;
      }
      const data = await response.json();
      for (const pick of Array.isArray(data.picks) ? data.picks : []) {
        picks.set(pick.id, pick);
      }
    } catch (error) {
      console.warn(`/match-recommend request failed: ${error.message}`);
    }
  }
  return picks;
}

function matchInterval(match) {
  const start = Date.parse(match.startTimeUtc);
  return { start, end: start + match.durationMinutes * 60_000 };
}

function intervalsOverlap(a, b) {
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

// Groups fixtures into connected clusters of "genuinely contesting the
// same slot" - pairwise time overlap AND a close score, unioned
// transitively (union-find) so a three- or four-way pileup becomes one
// cluster rather than several overlapping pairs. TBD fixtures (no real
// time - see isTimeTbd) and anything already marked `refined` in the cache
// (a previous run already gave it the comparative treatment) are excluded
// up front. Only returns clusters of 2+ - a fixture with no contested
// neighbor has nothing to compare against.
function findContestedClusters(matches, cache) {
  const candidates = matches.filter(
    m => !m.timeTbd && m.score >= CONTESTED_MIN_SCORE && !(cache[m.id] && cache[m.id].refined)
  );
  const intervalById = new Map(candidates.map(m => [m.id, matchInterval(m)]));
  const parent = new Map(candidates.map(m => [m.id, m.id]));
  function find(id) {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  }
  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (
        intervalsOverlap(intervalById.get(a.id), intervalById.get(b.id)) &&
        Math.abs(a.score - b.score) <= CONTESTED_SCORE_DELTA
      ) {
        union(a.id, b.id);
      }
    }
  }
  const groups = new Map();
  for (const match of candidates) {
    const root = find(match.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(match);
  }
  return [...groups.values()].filter(group => group.length >= 2);
}

// Sends each contested cluster (see findContestedClusters) to the shared
// proxy's /match-recommend-refine as its own small request - mutates `cache`
// directly (competitiveness/watchability/reason only; venueZh and
// whereToWatchTw stay whatever the base pass + grounded lookup already
// decided, since re-litigating the broadcast question isn't what this
// pass is for). Every fixture actually sent - whether or not its
// particular pick came back valid - is stamped `refined: true` so a
// persistently-malformed response can't cause the same cluster to be
// resent every single eligible run forever.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function refineContestedClusters(matches, cache) {
  if (!PROXY_URL) return false;
  const clusters = findContestedClusters(matches, cache)
    // Closest, highest-scoring contests first - if the per-run cap (see
    // MAX_REFINE_CLUSTERS_PER_RUN) leaves some clusters for next time,
    // it's the lower-stakes ones that wait.
    .sort((a, b) => {
      const avg = group => group.reduce((sum, m) => sum + m.score, 0) / group.length;
      return avg(b) - avg(a);
    })
    .slice(0, MAX_REFINE_CLUSTERS_PER_RUN);
  if (!clusters.length) return false;

  let anyAttempted = false;
  for (const [index, cluster] of clusters.entries()) {
    // Confirmed live: the Pro-tier models in MATCH_RECOMMEND_REFINE_MODELS
    // aren't currently reachable on this account (each attempt falls
    // through to the same gemini-3.7-flash the base scoring pass already
    // uses, near-instantly), so a burst of refine calls fired back-to-back
    // right after the base pass's own calls can blow straight through
    // Gemini's free-tier requests-PER-MINUTE cap even though the total
    // count for the whole run is small - a real 429 seen live confirmed
    // this. Spacing calls out costs a few seconds of build time, which is
    // free; retrying every eligible run forever because of a rate limit
    // that was entirely avoidable is not.
    if (index > 0) await sleep(4000);
    const picked = cluster
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, REFINE_CLUSTER_MAX_ITEMS);
    const payload = picked.map(m => ({
      id: m.id,
      sport: m.sport,
      name: m.name,
      startTimeUtc: m.startTimeUtc,
      context: m.context,
      venue: m.venue,
      broadcast: m.broadcast
    }));
    anyAttempted = true;
    try {
      const response = await fetch(`${PROXY_URL}/match-recommend-refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matches: payload }),
        signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok) {
        console.warn(`/match-recommend-refine -> HTTP ${response.status}: ${await response.text().catch(() => '')}`);
        continue;
      }
      const data = await response.json();
      const picks = new Map((Array.isArray(data.picks) ? data.picks : []).map(p => [p.id, p]));
      for (const match of picked) {
        const pick = picks.get(match.id);
        const entry = cache[match.id];
        if (!entry) continue;
        if (pick && Number.isFinite(pick.competitiveness) && Number.isFinite(pick.watchability)) {
          entry.competitiveness = Math.max(1, Math.min(10, Math.round(pick.competitiveness)));
          entry.watchability = Math.max(1, Math.min(10, Math.round(pick.watchability)));
          entry.reason = String(pick.reason || entry.reason || '').slice(0, 300);
        }
        entry.refined = true;
      }
    } catch (error) {
      console.warn(`/match-recommend-refine request failed: ${error.message}`);
    }
  }
  return anyAttempted;
}

async function main() {
  const now = new Date();
  const windowEndMs = now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000;

  const teamMatchLists = await Promise.all(
    TEAM_LEAGUES.map(league => fetchTeamLeagueMatches(league, now, windowEndMs, DAYS_AHEAD).catch(error => {
      console.warn(`Failed to fetch ${league.label}: ${error.message}`);
      return [];
    }))
  );
  const f1Matches = await fetchF1Matches(now, windowEndMs, DAYS_AHEAD).catch(error => {
    console.warn(`Failed to fetch F1: ${error.message}`);
    return [];
  });

  const matches = [...teamMatchLists.flat(), ...f1Matches];

  // TEMPORARY diagnostic - user disputes the exact start times of the
  // "tomorrow" MLB slate; need the real, exact, sorted per-match times
  // (not just counts) for both today's and tomorrow's Taipei-day buckets
  // to settle it against real ESPN data rather than assumption. Removed
  // in the immediate follow-up once confirmed.
  {
    const taipeiParts = iso => {
      const d = new Date(Date.parse(iso) + 8 * 3600_000);
      const dateKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const clock = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
      return { dateKey, clock };
    };
    const nowTaipei = taipeiParts(now.toISOString());
    console.log('[debug] now UTC:', now.toISOString(), '-> Taipei:', nowTaipei.dateKey, nowTaipei.clock);
    for (const sport of ['MLB', 'MLS']) {
      const rows = matches
        .filter(m => m.sport === sport && !m.timeTbd)
        .map(m => ({ id: m.id, name: m.name, ...taipeiParts(m.startTimeUtc) }))
        .sort((a, b) => (a.dateKey + a.clock).localeCompare(b.dateKey + b.clock));
      console.log(`[debug] ${sport} full sorted Taipei times:`, JSON.stringify(rows));
    }
  }

  let cache = pruneCache(await loadCache(), now);
  const meta = await loadMeta();

  // Retries a cached entry that either was never scored by Gemini
  // (source !== 'ai') or was scored under an older PROMPT_VERSION (see that
  // constant's own comment) - the latter is what makes an already-cached
  // match benefit from a prompt fix (e.g. teaching whereToWatchTw to
  // actually search instead of guess) instead of keeping a stale answer
  // forever, since source: 'ai' alone would otherwise mark it "done" for
  // good.
  const needsScoring = matches.filter(m => {
    const cached = cache[m.id];
    return !cached || cached.source !== 'ai' || cached.promptVersion !== PROMPT_VERSION;
  });

  // A routine scheduled run skips calling Gemini at all when the last real
  // call was recent (see AI_FETCH_MIN_INTERVAL_HOURS) - matches that still
  // need scoring just stay on their current cached/heuristic answer for
  // now and get retried on a later run, same as any other still-pending
  // entry. A push or manual dispatch (or a local run, with no event name at
  // all) always calls it: either one means someone specifically wants
  // fresh data now, not "whatever's due on the usual schedule".
  const lastAiFetchMs = Date.parse(meta.lastAiFetchAt || '');
  const throttled =
    GITHUB_EVENT_NAME === 'schedule' &&
    Number.isFinite(lastAiFetchMs) &&
    now.getTime() - lastAiFetchMs < AI_FETCH_MIN_INTERVAL_HOURS * 60 * 60 * 1000;
  const toFetchNow = throttled ? [] : needsScoring;
  if (throttled && needsScoring.length) {
    console.log(
      `Skipping Gemini this run (throttled, last called ${meta.lastAiFetchAt}) - ${needsScoring.length} match(es) still pending.`
    );
  }

  if (toFetchNow.length && PROXY_URL) meta.lastAiFetchAt = now.toISOString();
  const freshPicks = await fetchAiScores(toFetchNow);

  for (const match of toFetchNow) {
    const pick = freshPicks.get(match.id);
    if (pick && Number.isFinite(pick.competitiveness) && Number.isFinite(pick.watchability)) {
      cache[match.id] = {
        startTimeUtc: match.startTimeUtc,
        competitiveness: Math.max(1, Math.min(10, Math.round(pick.competitiveness))),
        watchability: Math.max(1, Math.min(10, Math.round(pick.watchability))),
        reason: String(pick.reason || '').slice(0, 300),
        venueZh: String(pick.venueZh || '').slice(0, 100),
        whereToWatchTw: String(pick.whereToWatchTw || '').slice(0, 100),
        source: 'ai',
        promptVersion: PROMPT_VERSION
      };
    } else if (!cache[match.id]) {
      // Only seeds a heuristic fallback for a match that's never been
      // scored at all - a match that already has an older AI answer keeps
      // that answer (still better than the heuristic) until Gemini is
      // actually reachable again, rather than regressing it just because
      // this run's re-score attempt didn't come back.
      cache[match.id] = { startTimeUtc: match.startTimeUtc, ...heuristicScore(match), source: 'heuristic', promptVersion: PROMPT_VERSION };
    }
  }

  let usedAi = false;
  for (const match of matches) {
    const scored = cache[match.id] || { ...heuristicScore(match), source: 'heuristic' };
    match.competitiveness = scored.competitiveness;
    match.watchability = scored.watchability;
    match.reason = scored.reason;
    match.venueZh = scored.venueZh || '';
    match.whereToWatchTw = scored.whereToWatchTw || '';
    match.source = scored.source;
    if (scored.source === 'ai') usedAi = true;
    match.score = Math.round(((match.competitiveness + match.watchability) / 2) * 10) / 10;
  }

  // Same throttle as the base scoring pass above - a comparative re-score
  // is still a Gemini call (a Pro-tier one, at that), so it only ever runs
  // as often as the base pass itself is allowed to.
  if (!throttled) {
    const refined = await refineContestedClusters(matches, cache);
    if (refined) {
      meta.lastAiFetchAt = now.toISOString();
      for (const match of matches) {
        const scored = cache[match.id];
        if (!scored?.refined) continue;
        match.competitiveness = scored.competitiveness;
        match.watchability = scored.watchability;
        match.reason = scored.reason;
        match.score = Math.round(((match.competitiveness + match.watchability) / 2) * 10) / 10;
      }
    }
  }

  matches.sort((a, b) => Date.parse(a.startTimeUtc) - Date.parse(b.startTimeUtc));

  const output = {
    generatedAt: now.toISOString(),
    buildId: BUILD_ID,
    daysAhead: DAYS_AHEAD,
    lastAiFetchAt: meta.lastAiFetchAt || null,
    source: matches.length === 0 ? 'none' : usedAi ? (matches.every(m => m.source === 'ai') ? 'ai' : 'mixed') : 'heuristic',
    // Baked in at build time so the browser knows where to send its own
    // settings-sync calls (see public/app.js's sync section) - a plain
    // variable, not a secret (same reasoning as PROXY_URL's own comment
    // above): it's just a fetch target with no credential in it, and it's
    // already effectively public the moment it ships in this static file
    // regardless of where it came from.
    proxyUrl: PROXY_URL || null,
    matches
  };

  await mkdir(new URL('.', OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  await mkdir(new URL('.', CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
  await writeFile(AI_META_PATH, JSON.stringify(meta, null, 2) + '\n');
  console.log(
    `Wrote ${matches.length} matches to ${OUTPUT_PATH.pathname} (source: ${output.source}, ${toFetchNow.length} sent to Gemini this run, ${needsScoring.length - toFetchNow.length} still pending, ${Object.keys(cache).length} cached)`
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
