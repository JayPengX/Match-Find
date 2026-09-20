// ---- scripts/build-data.mjs ----
// Fetches upcoming AND currently-live fixtures for the Premier League, MLB,
// NBA, and F1 from ESPN's public scoreboard API (no key required)
// across the next DAYS_AHEAD days, scores each one for competitiveness/
// watchability, and writes the flat result to public/data/matches.json for
// the static site to render. Only a FINISHED fixture is excluded - a live
// one is exactly what "what's worth watching" should be able to recommend.
//
// Runs at build time only (a scheduled GitHub Action, see
// .github/workflows/deploy.yml) - never per page view, and never triggered
// by a visitor's browser.
//
// ---- API-data-driven scoring (this is the architecture, not a detail) ----
//
// competitiveness/watchability/enduranceScore/broadcastQuality are computed
// FIRST, deterministically, by scripts/objective-score.mjs from real
// statistical signals - season record, recent form and standings proximity
// from the MLB Stats API, championship-race intensity from the Ergast-
// compatible Jolpica F1 API, and betting-market odds/national-broadcaster
// data already fetched from ESPN (see scripts/sport-signals.mjs for the
// fetching/parsing half of this). This objective score is the PRIMARY
// result - it's computed every run, for every fixture, whether or not the
// shared proxy below is even configured.
//
// The shared Cloudflare Worker in its own repo, jaypengx-collab/shared-proxy
// (see PROXY_URL below, route /match-recommend), is asked only to VALIDATE
// that objective score against real-world knowledge no formula can see (an
// injury, a hot narrative, a rivalry's real history) and return a small,
// bounded ADJUSTMENT - never a score invented from scratch the way this
// route used to work. If PROXY_URL isn't configured, or a call to it fails,
// a fixture simply keeps its objective score with a zero adjustment - a
// real, current, data-grounded number either way, just without that one
// extra layer of judgment.
//
// Every unthrottled run (see AI_FETCH_MIN_INTERVAL_HOURS below) sends EVERY
// currently non-finished fixture in the fetch window to Gemini fresh - not
// just newly-appeared ones - since the objective score itself is also
// recomputed fresh every run and a stale validation from hours ago is worth
// less than re-checking against today's actual data.
//
// A throttled scheduled run in between doesn't just leave every fixture on
// its objective score alone, though - it reuses each fixture's own LAST
// real Gemini adjustment from data/ai-meta.json (see
// AI_ADJUSTMENT_CACHE_MAX_AGE_HOURS) until either that cache entry goes
// stale or the next unthrottled run replaces it with a fresh one. Without
// this, "AI-validated" status flickered on and off roughly every 15
// minutes on the deployed site: the schedule runs 4x as often as Gemini is
// actually allowed to be called, so 3 out of 4 runs used to silently
// overwrite matches.json with every fixture's validation reset to zero,
// even fixtures a call earlier that same hour had already validated -
// confirmed as the real cause of reports that "AI validation isn't showing
// consistently" (nothing was wrong with the validation calls themselves;
// their own results were just being discarded by the very next routine
// rebuild).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { teamNameZh, f1RaceNameZh } from './team-names.mjs';
// Confidence is computed from exactly the same source/refined fields this
// script sets on each match below (see computeConfidence's own comment) -
// shared with public/app.js's resolveViewingPlan (which
// recomputes the same number client-side purely for display, since a
// finished match's confidence can't be baked in once and stay correct
// forever the way an already-computed score can) so there's exactly one
// definition of what "confidence" means, not two that could drift.
import { computeConfidence } from '../public/lib/recommendation.mjs';
// Deterministic, per-fixture broadcast-length formulas (MLB team pace,
// NBA/EPL modifiers, F1 circuit baselines), plus the rivalry/derby/
// national-broadcast detectors the objective scoring engine below reuses
// for watchability - see that module's own top-of-file comment.
import {
  predictMlbDurationMinutes,
  predictNbaDurationMinutes,
  predictEplDurationMinutes,
  predictF1RaceDurationMinutes,
  isMlbRivalry,
  isNbaRivalry,
  isEplDerby,
  isNationalBroadcast
} from './sport-duration.mjs';
// The deterministic, API-data-based scoring engine - see that module's own
// top-of-file comment for why this replaced asking Gemini to score a
// fixture from scratch.
import {
  clamp,
  estimateBroadcastQualityBaseline,
  computeMlbObjectiveScore,
  computeNbaObjectiveScore,
  computeEplObjectiveScore,
  computeF1ObjectiveScore
} from './objective-score.mjs';
// Fetches the real, current API signals the functions above turn into a
// score - standings/form (MLB Stats API) and championship intensity
// (Jolpica F1 API) - see that module's own top-of-file comment for the
// honest caveat on how these were built without live network access.
import { fetchMlbStandings, fetchF1TitleRaceIntensity } from './sport-signals.mjs';

const PROXY_URL = (process.env.PROXY_URL || '').trim().replace(/\/+$/, '');
// The commit this build ran from (.github/workflows/deploy.yml passes
// github.sha) - lets a long-open tab tell a genuine code deploy (a new
// commit) apart from a routine scheduled rebuild of the same commit (see
// public/app.js's update-check polling). Falls back to a fixed string for
// local runs, where there's no meaningful "commit this build is from".
const BUILD_ID = (process.env.BUILD_ID || 'local').trim();
const OUTPUT_PATH = new URL('../public/data/matches.json', import.meta.url);
// Committed to the repo (unlike matches.json, which is fully regenerated
// every run) - NOT a cache of match data (see the top-of-file comment: this
// pipeline no longer keeps a persistent per-match AI cache at all, so every
// unthrottled run revalidates everything fresh). The one thing that
// genuinely needs to survive between separate workflow runs is a plain
// timestamp: when Gemini was last actually called, which
// AI_FETCH_MIN_INTERVAL_HOURS below reads to decide whether a routine
// scheduled run should call it again. See .github/workflows/deploy.yml's
// "Commit AI fetch timestamp" step for how it gets pushed back.
const AI_META_PATH = new URL('../data/ai-meta.json', import.meta.url);

// A validation adjustment from the shared proxy is clamped to this range in
// EITHER direction, regardless of what it actually returns (the proxy
// itself already clamps its own output - see that repo's worker.js - but
// this is still a network response crossing a repo boundary into a file
// this script commits back to git, so it gets the same "never fully trust
// upstream" treatment as every other AI-sourced number in this file). This
// bound is the whole point of "validation, not replacement": even a
// maximally confident Gemini disagreement can only nudge the objective
// score, never override it outright.
const AI_ADJUSTMENT_BOUND = 2;

function clampAdjustment(value) {
  return Number.isFinite(value) ? clamp(value, -AI_ADJUSTMENT_BOUND, AI_ADJUSTMENT_BOUND) : 0;
}

// Allowed evidence categories - the audit's own vocabulary (see
// docs/recommendation-engine-audit.md section 19), kept identical to the
// shared proxy's own EVIDENCE_CATEGORIES so both sides of this boundary
// agree on what a category value means without either one importing the
// other (separate repos - see sanitizeCachedEvidenceItem's own comment for
// why this re-validates rather than trusting the proxy's own
// already-sanitized response blindly).
const EVIDENCE_CATEGORIES = ['competitiveness', 'mediaAttention', 'eventImportance', 'recentContext'];

// Bounds/re-validates one evidence item pulled from the shared proxy's
// /match-recommend response before it's written into matches.json - the
// proxy already sanitizes its own response (see that repo's
// sanitizeEvidence), but this is still a network response crossing a repo
// boundary, so it gets the same "never fully trust upstream" treatment as
// every adjustment above.
export function sanitizeCachedEvidenceItem(item) {
  return {
    category: EVIDENCE_CATEGORIES.includes(item?.category) ? item.category : 'recentContext',
    finding: typeof item?.finding === 'string' ? item.finding.slice(0, 200) : '',
    source: typeof item?.source === 'string' ? item.source.slice(0, 80) : '',
    retrievedAt: typeof item?.retrievedAt === 'string' ? item.retrievedAt : new Date().toISOString()
  };
}

// Which GitHub Actions event triggered this run - 'schedule' for the
// routine rerun, 'push' for a real commit landing on main, or
// 'workflow_dispatch' for a manual "Run workflow" click OR the shared
// proxy's own /match-dispatch route (see that repo's worker.js - both
// ordinary viewers' "重新整理資料"/"AI 重新評估" Settings buttons and this
// site's own owner manually running the workflow land here). Empty string
// for a local run.
const GITHUB_EVENT_NAME = (process.env.GITHUB_EVENT_NAME || '').trim();
// A run only actually calls Gemini if it's been at least this long since
// the last real call - the ESPN-only refresh (and the objective score
// recompute, which is free and local) runs far more often than this (see
// .github/workflows/deploy.yml's cron), so this constant alone is what
// keeps the actual Gemini-validation cadence down regardless of how often
// the workflow itself fires OR what triggered any one run.
//
// Applied UNIFORMLY to every event type now, not just 'schedule' - an
// earlier version let push/workflow_dispatch always bypass this throttle
// ("someone specifically wants fresh data now"), which made sense back when
// the only way to trigger either was a real code push or this site's own
// owner manually running the workflow from the Actions tab. Now that
// ordinary VIEWERS can also trigger a workflow_dispatch (the shared proxy's
// /match-dispatch, wired to Settings' "重新整理資料"/"AI 重新評估" buttons),
// that bypass would have meant mashing a button burns a fresh Gemini call
// every single time - exactly the "AI reevaluation limited to once per
// hour, applied everywhere, to save quota" this site's own design now
// promises. One shared clock, one shared rule, regardless of who or what
// triggered the run - a genuine code push doesn't need special treatment
// either, since ESPN data (the actually time-sensitive half) is refetched
// unconditionally on every run no matter what this throttle decides.
const AI_FETCH_MIN_INTERVAL_HOURS = 1;

// How long a match's own last real Gemini validation stays usable across
// runs that don't call Gemini again for it (a throttled scheduled run, or
// a batch that failed) - see the "AI validation" section's own note on why
// this exists at all. Deliberately several throttle windows long (the
// schedule fires every 15 minutes, Gemini is only actually called once an
// hour), so a viewer's browser doesn't see a fixture's validated reason/
// evidence appear for one 15-minute window and then vanish back to the
// generic objective-score reason for the next three, purely because that
// particular run happened to be throttled - not because anything about the
// match actually changed. Still bounded, not indefinite: a validation from
// a real Gemini call several hours ago is old enough that re-checking
// against by-then-current data is worth more than keeping it forever.
const AI_ADJUSTMENT_CACHE_MAX_AGE_HOURS = 6;

// ---- Contested-cluster refinement (the shared proxy's /match-recommend-refine) ------
//
// The base validation pass above validates every fixture independently, in
// one big batch - fine for "is this objective score roughly right", weak at
// "which of these two SPECIFIC overlapping fixtures is the bigger deal",
// since nothing about that call lets the model weigh them against each
// other. Fixtures that overlap in time AND land within CONTESTED_SCORE_DELTA
// of each other's final score are genuinely contesting the same viewing
// slot, and get a second, comparative pass with the shared proxy's
// Pro-tier-first refine route - deliberately only THOSE fixtures, never the
// full list, since a Pro-tier model's free-tier quota is far smaller than
// Flash's and shared across every feature the shared proxy Worker serves.
const CONTESTED_SCORE_DELTA = 1;
// Not worth refining two mediocre matches into a slightly-more-precisely-
// ranked pair of mediocre matches - this keeps refinement calls spent on
// slots that actually matter.
const CONTESTED_MIN_SCORE = 6;
// Hard cap on how many separate refine calls one run makes, regardless of
// how many contested clusters exist - bounds worst-case Pro-tier quota use
// per run even on an unusually contested day.
const MAX_REFINE_CLUSTERS_PER_RUN = 5;
// Mirrors the shared proxy's own MATCH_RECOMMEND_REFINE_MAX_ITEMS - kept as
// a separate constant here (repos can't share code) purely so an unusually
// large cluster gets trimmed to its own highest-scoring members before
// sending, rather than firing a request the server would just 400 anyway.
const REFINE_CLUSTER_MAX_ITEMS = 6;

// How many calendar days ahead (from today, UTC) to fetch. The site's day
// scroller shows the first 7 of these up front and reveals the rest on a
// "load more" click - all client-side, no extra network request, since
// everything through DAYS_AHEAD is already baked into matches.json by the
// time anyone opens the page. 14 gives that click something real to reveal.
const DAYS_AHEAD = 14;
// The shared proxy's /match-recommend route caps a single request at 80
// fixtures (see that repo's worker.js) - an unthrottled run against a
// 14-day window sends EVERY non-finished fixture (there's no cache to
// shrink that list), so those get sent in sequential batches under that cap
// rather than in one oversized request.
const AI_SCORE_BATCH_SIZE = 75;

// Team-sport leagues, all sharing the same ESPN scoreboard shape
// (site.api.espn.com/apis/site/v2/sports/<sportKey>/<leagueKey>/scoreboard).
// durationMinutes here is only a FALLBACK flat average - see
// computeDurationMinutes below, which computes a real per-fixture estimate
// from scripts/sport-duration.mjs for every league listed here.
const TEAM_LEAGUES = [
  { id: 'epl', sportKey: 'soccer', leagueKey: 'eng.1', label: 'Premier League', durationMinutes: 115 },
  { id: 'mlb', sportKey: 'baseball', leagueKey: 'mlb', label: 'MLB', durationMinutes: 190 },
  { id: 'nba', sportKey: 'basketball', leagueKey: 'nba', label: 'NBA', durationMinutes: 150 }
];

// The one place that decides "how long will this specific fixture's
// broadcast run" - a real per-team/circuit formula for the three leagues
// this build actually has one for (see scripts/sport-duration.mjs), and
// the league's own flat average for anything else. away/home are this
// function's own buildCompetitor objects (`.name` is ESPN's team
// displayName, exactly what sport-duration.mjs's tables are keyed by).
export function computeDurationMinutes(league, away, home, venue, broadcast, oddsOverUnder) {
  switch (league.id) {
    case 'mlb':
      return predictMlbDurationMinutes({ awayTeam: away.name, homeTeam: home.name, venue, oddsOverUnder });
    case 'nba':
      return predictNbaDurationMinutes({ awayTeam: away.name, homeTeam: home.name, broadcast });
    case 'epl':
      return predictEplDurationMinutes({ awayTeam: away.name, homeTeam: home.name });
    default:
      return league.durationMinutes;
  }
}

// Once ESPN itself confirms a fixture is over (isFinished), its real
// length is simply how long ago it started, as of this fetch - exact
// modulo this workflow's own 15-minute cron cadence, and categorically
// better than the PRE-GAME estimate computeDurationMinutes above returns
// for a fixture that hasn't started yet. This is the direct fix for a
// reported bug: a finished MLB game whose broadcast genuinely ran 30-60
// minutes SHORTER than its own pre-game prediction still reserved a
// schedule block sized to that longer, now-known-wrong guess (see
// recommendation.mjs's schedulingDurationMinutes, which also stops adding
// its own overrun buffer once isFinished is true - there's no forward
// uncertainty left to hedge once the real length is already known), which
// kept blocking a next match that could obviously, actually follow it.
// Floored well below any realistic finished-game length so a data glitch
// (ESPN marking a fixture 'post' almost immediately, e.g. a postponement)
// can't produce a laughably tiny reserved block.
export const MIN_FINISHED_DURATION_MINUTES = 30;
export function finishedDurationMinutes(startTimeUtc, now) {
  const elapsedMinutes = Math.round((now.getTime() - Date.parse(startTimeUtc)) / 60_000);
  return Math.max(MIN_FINISHED_DURATION_MINUTES, elapsedMinutes);
}

// ---- Taiwan broadcast source (a hardcoded rule, not an AI guess) --------
//
// Product decision: 愛爾達體育台 carries nearly everything this site
// recommends in Taiwan, and the one real, well-documented exception is
// MLB's Apple TV "Friday Night Baseball" package - a genuine GLOBAL
// streaming exclusive with no regional blackout, unlike an ordinary US
// national cable network name. ESPN's own scoreboard already reports the
// on-record broadcaster for every fixture (the `broadcast` field built
// below), which is already a reliable, free, zero-latency signal for
// exactly that one case. Every other MLB game and every other sport this
// site covers (EPL, NBA, F1) defaults to 愛爾達體育台 unconditionally.
export function resolveWhereToWatchTw(match) {
  if (match.sport === 'MLB' && /apple\s*tv/i.test(match.broadcast || '')) return 'Apple TV';
  return '愛爾達體育台';
}

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
// detail containing "TBD" rather than a separate boolean flag.
export function isTimeTbd(statusType) {
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
// aren't summarized here at all). Feeds both the objective scoring engine's
// win% signal and the short human-readable context string handed to
// Gemini - never trusted for anything more precise than "roughly how good
// is this team right now".
export function parseOverallRecord(competitor) {
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
    record: parseOverallRecord(c),
    // Only meaningful once the fixture is live or finished ('pre' fixtures
    // report "0" same as a real scoreless one) - the client only ever reads
    // this for a finished match's final-score line (see buildMatchCard),
    // so a 'pre' fixture's meaningless "0" is harmless dead weight, not a
    // bug worth filtering out here.
    score: c.score ?? null
  };
}

function competitorContext(competitor) {
  const record = competitor.record;
  return record ? `${competitor.name} (${record.wins}-${record.losses})` : competitor.name;
}

// ESPN's own on-record betting line for the fixture, when a provider has
// actually posted one (mainstream US sports only in practice - MLB/NBA
// typically have one most days, soccer/EPL and F1 essentially never do via
// this API) - a short, human-readable string for Gemini's own context
// (e.g. "LAD -1.5"). See parseOddsSignal just below for the same data as
// plain numbers, which is what the objective scoring engine actually
// computes from.
export function oddsContext(competition) {
  const odds = competition.odds?.[0];
  const details = typeof odds?.details === 'string' ? odds.details.trim() : '';
  if (!details) return '';
  const overUnder = Number(odds?.overUnder);
  return ` [Odds: ${details}${Number.isFinite(overUnder) ? `, O/U ${overUnder}` : ''}]`;
}

// The SAME `competition.odds[0]` object oddsContext reads, as plain numbers
// instead of a formatted string meant for a language model - what
// scripts/objective-score.mjs's closenessFromSpread actually consumes.
// Returns nulls (never NaN) when no provider has posted a line, which is
// the common case for most non-mainstream-US fixtures.
export function parseOddsSignal(competition) {
  const odds = competition.odds?.[0];
  const spread = Number(odds?.spread);
  const overUnder = Number(odds?.overUnder);
  return {
    spread: Number.isFinite(spread) ? spread : null,
    overUnder: Number.isFinite(overUnder) ? overUnder : null
  };
}

async function fetchTeamLeagueMatches(league, now, windowEndMs, daysAhead) {
  // Queries `now`'s own UTC date AND the day before it - not just `now`
  // onward. This script runs on a schedule/on push, at whatever UTC
  // instant that happens to be, and ESPN's own `dates=YYYYMMDD` scoreboard
  // query groups a game under the calendar day IT started on by ESPN's own
  // reckoning (for MLB in particular, that tracks the US Eastern "game
  // date", not the UTC one) - the two only diverge for part of the day,
  // but this script's own `now` can easily land inside that gap. Asking
  // for one more day up front costs one extra request per league and
  // risks nothing (the state/bounds checks below already correctly filter
  // it).
  //
  // length is daysAhead + 2, not + 1: one extra day for the `now - 1`
  // lookback above, PLUS one more so the loop's own far end actually
  // reaches windowEndMs.
  const dates = Array.from({ length: daysAhead + 2 }, (_, i) =>
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
      // 'pre'/'in'/'post' all kept - a live/finished fixture stays visible
      // and continuous across the whole day rather than vanishing off the
      // page the moment its status changes (see isFinished below for how
      // the client renders each state).
      if (!['pre', 'in', 'post'].includes(statusType?.state)) continue;
      const isLive = statusType.state === 'in';
      const isFinished = statusType.state === 'post';
      const timeTbd = isTimeTbd(statusType);
      const startMs = Date.parse(event.date);
      if (!Number.isFinite(startMs)) continue;
      // A TBD/live/finished fixture is exempted from the plain bounds
      // check below for the reasons documented at length in this repo's
      // git history (isTimeTbd's own comment covers TBD; live/finished
      // fixtures necessarily already started in the past, which the bound
      // would otherwise wrongly reject).
      if (!timeTbd && !isLive && !isFinished && (startMs < now.getTime() || startMs > windowEndMs)) continue;
      seenIds.add(event.id);

      // Always [away, home] regardless of the order ESPN happens to list
      // them in, so `name`/`nameZh` below are built consistently as
      // "AWAY @ HOME" for every sport.
      const rawCompetitors = (competition.competitors || []).map(c => buildCompetitor(league.id, c));
      const away = rawCompetitors.find(c => c.homeAway === 'away') || rawCompetitors[0];
      const home = rawCompetitors.find(c => c.homeAway === 'home') || rawCompetitors[1];
      const competitors = [away, home].filter(Boolean);
      if (competitors.length !== 2) continue;
      // A playoff slot ESPN has reserved but not yet assigned real teams to
      // isn't a fixture this site can say anything useful about - skip it
      // entirely until ESPN itself knows who's actually playing (see this
      // repo's git history for the "TBD @ TBD" case this was written for).
      if (competitors.some(c => c.abbreviation === 'TBD' || c.name === 'TBD')) continue;

      const broadcast = (competition.broadcasts || [])
        .flatMap(b => b.names || [])
        .slice(0, 1)[0];
      // ESPN's season.type is 2 for the regular season and 3 for the
      // postseason (confirmed against the live API) - now feeds the
      // objective scoring engine's own stakes calculation directly (see
      // computeMatchObjectiveScore below), not just Gemini's own context.
      const isPostseason = event.season?.type === 3;
      const oddsSignal = parseOddsSignal(competition);

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
        // isFinished is authoritative (ESPN's own status), unlike "is this
        // live right now" which the client derives itself from the current
        // time against startTimeUtc/durationMinutes.
        isFinished,
        isPostseason,
        oddsSpread: oddsSignal.spread,
        oddsOverUnder: oddsSignal.overUnder,
        durationMinutes: isFinished
          ? finishedDurationMinutes(new Date(startMs).toISOString(), now)
          : computeDurationMinutes(
              league,
              away,
              home,
              competition.venue?.fullName || '',
              broadcast || '',
              oddsSignal.overUnder
            ),
        venue: competition.venue?.fullName || '',
        broadcast: broadcast || '',
        logo: '',
        competitors,
        context:
          competitors.map(competitorContext).join(' vs ') +
          (isPostseason ? ' (postseason/playoff game)' : '') +
          oddsContext(competition)
      });
    }
  }
  return matches;
}

// F1 has a completely different ESPN shape: one "event" is a whole race
// weekend, and its "competitions" array is the individual sessions (FP1,
// FP2, FP3, Qualifying, Sprint Shootout, Sprint, Race) rather than
// per-team competitors. Confirmed live across both ordinary and sprint
// weekends: `type.abbreviation` is a stable, non-colliding key per session.
//
// Practice sessions (FP1-3) and the sprint shootout ("SS") aren't included.
// Qualifying and the sprint race ARE: both are genuinely watchable events
// in their own right, not just a preview of the race.
const F1_SESSION_TYPES = [
  { abbreviation: 'Race', labelSuffix: '', labelSuffixZh: '', durationMinutes: 120 },
  { abbreviation: 'Qual', labelSuffix: ' Qualifying', labelSuffixZh: '排位賽', durationMinutes: 75 },
  { abbreviation: 'SR', labelSuffix: ' Sprint', labelSuffixZh: '衝刺賽', durationMinutes: 60 }
];

async function fetchF1Matches(now, windowEndMs, daysAhead) {
  // Starts one day before `now`, same reasoning and same fix as
  // fetchTeamLeagueMatches's own `dates` array above.
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
      // session should still be recommendable, and a FINISHED one stays
      // visible instead of vanishing off the day's schedule the moment it
      // ends.
      if (!['pre', 'in', 'post'].includes(statusType?.state)) continue;
      const isLive = statusType.state === 'in';
      const isFinished = statusType.state === 'post';
      const timeTbd = isTimeTbd(statusType);
      const startMs = Date.parse(session.date || event.date);
      if (!Number.isFinite(startMs)) continue;
      if (!timeTbd && !isLive && !isFinished && (startMs < now.getTime() || startMs > windowEndMs)) continue;

      const broadcast = (session.broadcasts || []).flatMap(b => b.names || []).slice(0, 1)[0];
      const venue = event.circuit?.fullName || '';
      // Only the main Race gets a circuit-specific prediction - see
      // sport-duration.mjs's own comment for why Qualifying/Sprint keep
      // their flat session.durationMinutes instead.
      const durationMinutes = isFinished
        ? finishedDurationMinutes(new Date(startMs).toISOString(), now)
        : sessionType.abbreviation === 'Race'
          ? predictF1RaceDurationMinutes(venue)
          : sessionType.durationMinutes;

      matches.push({
        id: `f1-${event.id}-${sessionType.abbreviation.toLowerCase()}`,
        sport: 'F1',
        name: `${event.name}${sessionType.labelSuffix}`,
        nameZh: raceNameZh ? `${raceNameZh}${sessionType.labelSuffixZh ? '－' + sessionType.labelSuffixZh : ''}` : '',
        startTimeUtc: new Date(startMs).toISOString(),
        timeTbd,
        isFinished,
        isPostseason: false,
        oddsSpread: null,
        oddsOverUnder: null,
        durationMinutes,
        venue,
        broadcast: broadcast || '',
        logo: F1_LOGO,
        competitors: [],
        context: `${event.name}${sessionType.labelSuffix} - Formula 1${sessionType.labelSuffix ? ' ' + sessionType.labelSuffix.trim().toLowerCase() : ' race'}`
      });
    }
  }
  return matches;
}

// ---- Objective scoring: dispatch + the local-only reason text -----------

// The one place that dispatches a fixture to its own sport-specific
// deterministic formula (scripts/objective-score.mjs) - the PRIMARY score
// for every dimension the shared proxy used to be asked to invent from
// scratch. `signals` carries the once-per-build API fetches (MLB
// standings, F1 title-race intensity) every fixture of that sport shares.
// A sport with no dedicated formula yet falls back to a plain neutral
// score rather than crashing the build.
export function computeMatchObjectiveScore(match, { mlbStandings, f1TitleRaceIntensity } = {}) {
  const broadcastQuality = estimateBroadcastQualityBaseline(match.broadcast);
  const [away, home] = match.competitors;
  const awayWinPct = away?.record ? away.record.wins / Math.max(1, away.record.wins + away.record.losses) : null;
  const homeWinPct = home?.record ? home.record.wins / Math.max(1, home.record.wins + home.record.losses) : null;

  let result;
  switch (match.sport) {
    case 'MLB':
      result = computeMlbObjectiveScore({
        awayWinPct,
        homeWinPct,
        away: mlbStandings?.get(away?.name) || null,
        home: mlbStandings?.get(home?.name) || null,
        isPostseason: match.isPostseason,
        isRivalry: isMlbRivalry(away?.name, home?.name),
        oddsSpread: match.oddsSpread,
        oddsOverUnder: match.oddsOverUnder
      });
      break;
    case 'NBA':
      result = computeNbaObjectiveScore({
        awayWinPct,
        homeWinPct,
        isPostseason: match.isPostseason,
        isRivalry: isNbaRivalry(away?.name, home?.name),
        isNationalBroadcast: isNationalBroadcast(match.broadcast),
        oddsSpread: match.oddsSpread,
        oddsOverUnder: match.oddsOverUnder
      });
      break;
    case 'Premier League':
      result = computeEplObjectiveScore({
        awayWinPct,
        homeWinPct,
        isDerby: isEplDerby(away?.name, home?.name),
        oddsSpread: match.oddsSpread,
        oddsOverUnder: match.oddsOverUnder
      });
      break;
    case 'F1':
      result = computeF1ObjectiveScore({ titleRaceIntensity: f1TitleRaceIntensity });
      break;
    default:
      result = { competitiveness: 5, watchability: 5, enduranceScore: 5, skill: null, factors: [] };
  }
  return { ...result, broadcastQuality };
}

// A short, human-readable label per recognized factor prefix - deliberately
// coarse (a category, not the exact number) since the factor strings
// themselves are internal/English (e.g. "season win% gap 12.3pp"), not
// meant for display. Order matters only in that the FIRST match per
// pattern wins; patterns are specific enough that a factor rarely matches
// more than one anyway.
const FACTOR_ZH_HINTS = [
  [/season win% gap|season points-rate gap/, '雙方戰績'],
  [/last 10/, '近期戰況'],
  [/odds spread/, '盤口數據'],
  [/playoff proximity/, '季後賽晉級形勢'],
  [/postseason game/, '季後賽'],
  [/streak/, '近期連勝連敗'],
  [/known rivalry matchup|known derby fixture/, '宿敵對戰'],
  [/national broadcast/, '全國轉播'],
  [/championship gap intensity/, '冠軍積分差距']
];

// The objective score's own `factors` array (English, internal) -> a short
// list of Traditional Chinese labels describing what real data went into
// it - used when there's no AI-written reason yet (see
// buildObjectiveReasonZh) and exported mainly so it's independently
// testable.
export function describeFactorsZh(factors) {
  const labels = [];
  for (const factor of factors || []) {
    for (const [pattern, label] of FACTOR_ZH_HINTS) {
      if (pattern.test(factor) && !labels.includes(label)) {
        labels.push(label);
        break;
      }
    }
  }
  return labels;
}

// The reason text a fixture gets BEFORE (or without) Gemini's own
// validation pass - grounded in the actual data that produced its
// objective score, not a static "no data" placeholder the way the old
// heuristicScore's fallback reason was, since there almost always IS real
// data behind this score now.
export function buildObjectiveReasonZh(factors) {
  const labels = describeFactorsZh(factors);
  if (!labels.length) return '目前沒有足夠的客觀數據可供估計。';
  return `依${labels.slice(0, 3).join('、')}計算。`;
}

// ---- AI validation (no persistent per-match cache) --------------------
// picks (built fresh in main(), per run, keyed by match id) holds an
// ADJUSTMENT - a small number added to whatever the objective score
// computes THIS run, never an absolute score - but it lives only in memory
// for the duration of one build. Nothing about a fixture's AI validation
// survives to the next run: every unthrottled run (see
// AI_FETCH_MIN_INTERVAL_HOURS) re-sends every currently non-finished
// fixture to Gemini, whether or not an earlier run already validated it.
//
// The one thing that DOES need to survive between separate workflow runs
// is a plain timestamp - when Gemini was last actually called - so a
// routine scheduled run can tell "we just called it" apart from "it's been
// hours, call it again" without needing a full per-match record.
async function loadMeta() {
  try {
    const parsed = JSON.parse(await readFile(AI_META_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

// The shape sent to both /match-recommend and /match-recommend-refine - a
// fixture's usual identifying fields PLUS its own already-computed
// objective score and the real factors behind it, so the proxy validates
// against something concrete rather than starting from nothing.
function toRecommendPayloadItem(m) {
  return {
    id: m.id,
    sport: m.sport,
    name: m.name,
    startTimeUtc: m.startTimeUtc,
    context: m.context,
    venue: m.venue,
    broadcast: m.broadcast,
    objective: {
      competitiveness: m.objectiveScore.competitiveness,
      watchability: m.objectiveScore.watchability,
      enduranceScore: m.objectiveScore.enduranceScore,
      broadcastQuality: m.objectiveScore.broadcastQuality,
      skill: m.objectiveScore.skill,
      factors: m.objectiveScore.factors
    }
  };
}

// Fills in `adjustments` (mutated in place) for every fixture in
// `needsScoring` that didn't already get a fresh Gemini pick THIS run (a
// throttled run skipped Gemini entirely, or this one specific fixture's
// batch failed), from its own last real validation in `cachedAdjustments` -
// as long as that entry isn't older than `maxAgeHours`. Without this, a
// fixture's validated reason/evidence would reset to the generic
// objective-score default on every run except the roughly 1-in-4 that
// actually calls Gemini (the schedule fires 4x more often than
// AI_FETCH_MIN_INTERVAL_HOURS allows) - confirmed as the real cause behind
// reports that "AI validation isn't showing consistently" on the deployed
// site. A cache entry's own `cachedAt` is never bumped here - it keeps
// aging normally across however many runs reuse it, so it eventually falls
// out of the window on its own rather than looking permanently fresh.
export function applyCachedAdjustments(adjustments, needsScoring, cachedAdjustments, nowMs, maxAgeHours) {
  for (const match of needsScoring) {
    if (adjustments.has(match.id)) continue;
    const cached = cachedAdjustments[match.id];
    if (!cached) continue;
    const ageMs = nowMs - Date.parse(cached.cachedAt || '');
    if (!Number.isFinite(ageMs) || ageMs > maxAgeHours * 60 * 60 * 1000) continue;
    adjustments.set(match.id, cached);
  }
}

// Sends every fixture that needs scoring this run to the shared Cloudflare
// Worker (jaypengx-collab/shared-proxy), which owns the actual Gemini
// prompt/schema (see that repo's worker.js, route /match-recommend) and
// holds the real API key. Batched under AI_SCORE_BATCH_SIZE so a full
// 14-day window's worth of fixtures never exceeds the proxy's per-request
// cap.
async function fetchAiScores(matchesNeedingScore) {
  if (!PROXY_URL || !matchesNeedingScore.length) return new Map();
  const picks = new Map();
  for (const batch of chunk(matchesNeedingScore, AI_SCORE_BATCH_SIZE)) {
    const payload = batch.map(toRecommendPayloadItem);
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
// same slot" - pairwise time overlap AND a close final score, unioned
// transitively (union-find) so a three- or four-way pileup becomes one
// cluster rather than several overlapping pairs. TBD and already-finished
// fixtures are excluded up front - a finished fixture's own place in the
// day's plan is settled history now (see this file's own comment on why it
// still gets a real objective score), never worth spending refine quota
// re-litigating which of two ALREADY-OVER games was the bigger deal.
function findContestedClusters(matches) {
  const candidates = matches.filter(m => !m.timeTbd && !m.isFinished && m.score >= CONTESTED_MIN_SCORE);
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
// proxy's /match-recommend-refine as its own small request - mutates
// `adjustments` (the in-memory Map main() built from the base validation
// pass) directly: competitiveness/watchability adjustment + reason only;
// enduranceScore/broadcastQuality/venueZh stay whatever the base pass
// already decided, since re-litigating those isn't what this pass is for.
// Every fixture actually sent is stamped `refined: true` so this same run's
// own final assembly loop knows to use the refined numbers over the base
// pass's.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function refineContestedClusters(matches, adjustments) {
  if (!PROXY_URL) return false;
  const clusters = findContestedClusters(matches)
    // Closest, highest-scoring contests first - if the per-run cap leaves
    // some clusters for next time, it's the lower-stakes ones that wait.
    .sort((a, b) => {
      const avg = group => group.reduce((sum, m) => sum + m.score, 0) / group.length;
      return avg(b) - avg(a);
    })
    .slice(0, MAX_REFINE_CLUSTERS_PER_RUN);
  if (!clusters.length) return false;

  let anyAttempted = false;
  for (const [index, cluster] of clusters.entries()) {
    // Spaced ~4s apart rather than fired back-to-back - see this repo's
    // git history for the live rate-limit this avoids.
    if (index > 0) await sleep(4000);
    const picked = cluster
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, REFINE_CLUSTER_MAX_ITEMS);
    const payload = picked.map(toRecommendPayloadItem);
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
      const refinePicks = new Map((Array.isArray(data.picks) ? data.picks : []).map(p => [p.id, p]));
      for (const match of picked) {
        const pick = refinePicks.get(match.id);
        const entry = adjustments.get(match.id);
        if (!entry) continue;
        if (pick) {
          entry.competitivenessAdjustment = clampAdjustment(pick.competitivenessAdjustment);
          entry.watchabilityAdjustment = clampAdjustment(pick.watchabilityAdjustment);
          entry.reason = String(pick.reason || entry.reason || '').slice(0, 300);
          // A genuinely fresh Gemini response just now, whether `entry`
          // started this run as a fresh pick or a carried-over cache entry
          // (see main()'s own cachedAdjustments fallback) - either way this
          // resets how long it's allowed to keep being reused.
          entry.cachedAt = new Date().toISOString();
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

  // The extra, dedicated-API signals the objective scoring engine needs -
  // fetched ONCE per build, not once per fixture (every MLB game that day
  // shares the same league-wide standings snapshot; every F1 session that
  // weekend shares the same championship intensity). Skipped entirely when
  // there's no live use for them this run (an all-EPL/NBA window, or the
  // off-season) so a quiet day doesn't cost a request for nothing.
  const hasActiveMlb = matches.some(m => m.sport === 'MLB' && !m.isFinished);
  const hasActiveF1 = matches.some(m => m.sport === 'F1' && !m.isFinished);
  const [mlbStandings, f1TitleRaceIntensity] = await Promise.all([
    hasActiveMlb ? fetchMlbStandings(now.getUTCFullYear()) : Promise.resolve(new Map()),
    hasActiveF1 ? fetchF1TitleRaceIntensity() : Promise.resolve(null)
  ]);

  // The PRIMARY score - computed for EVERY fixture, finished or not, before
  // Gemini ever sees any of them. A finished fixture's own real underlying
  // data (final record, that day's odds/standings context) doesn't stop
  // being real once the game ends, and this pipeline runs the recommended
  // lineup as ONE calendar-day plan, decided once, not a moving "what's
  // left as of right now" - see recommendation.mjs's computeDayPlan and its
  // own comment on why a finished fixture is a normal scheduling candidate.
  // A viewer opening the page mid-afternoon should see the SAME whole-day
  // plan a viewer this morning would have (this morning's game shown as
  // 已結束 in its own rightful slot, not silently dropped from the lineup),
  // rather than a plan that keeps shrinking to "only what's still ahead"
  // depending purely on when it happens to be loaded.
  for (const match of matches) {
    match.objectiveScore = computeMatchObjectiveScore(match, { mlbStandings, f1TitleRaceIntensity });
  }

  const meta = await loadMeta();

  // No persisted cache - EVERY currently non-finished fixture in the fetch
  // window is sent to Gemini again this run (see the "AI validation"
  // section above), not just newly-appeared ones.
  const needsScoring = matches.filter(m => !m.isFinished);

  // Skips calling Gemini at all when the last real call was recent (see
  // AI_FETCH_MIN_INTERVAL_HOURS's own comment on why this now applies to
  // EVERY event type uniformly, not just 'schedule') - fixtures just run on
  // their objective score alone for now and get validated on the next
  // eligible run, whatever triggers it. A local run (no GITHUB_EVENT_NAME
  // at all) is the one exception - there's no "someone might mash the
  // button" concern to throttle against when a person is sitting at a
  // terminal running this directly themselves.
  const lastAiFetchMs = Date.parse(meta.lastAiFetchAt || '');
  const throttled =
    GITHUB_EVENT_NAME !== '' &&
    Number.isFinite(lastAiFetchMs) &&
    now.getTime() - lastAiFetchMs < AI_FETCH_MIN_INTERVAL_HOURS * 60 * 60 * 1000;
  const toFetchNow = throttled ? [] : needsScoring;
  if (throttled && needsScoring.length) {
    console.log(
      `Skipping Gemini this run (throttled, last called ${meta.lastAiFetchAt}) - ${needsScoring.length} match(es) pending for the next unthrottled run.`
    );
  }

  if (toFetchNow.length && PROXY_URL) meta.lastAiFetchAt = now.toISOString();
  const freshPicks = await fetchAiScores(toFetchNow);

  // Persisted across runs in data/ai-meta.json (see AI_ADJUSTMENT_CACHE_MAX_AGE_HOURS
  // and the "AI validation" section's own note on why this exists) - keyed
  // by match id, each entry stamped with WHEN it was actually produced by a
  // real Gemini call, not when this particular run happened to write it.
  const cachedAdjustments = meta.adjustments && typeof meta.adjustments === 'object' ? meta.adjustments : {};

  const adjustments = new Map();
  for (const match of toFetchNow) {
    const pick = freshPicks.get(match.id);
    if (!pick) continue; // no matching pick this run - falls through to the cache/objective-score fallback below
    adjustments.set(match.id, {
      competitivenessAdjustment: clampAdjustment(pick.competitivenessAdjustment),
      watchabilityAdjustment: clampAdjustment(pick.watchabilityAdjustment),
      enduranceScoreAdjustment: clampAdjustment(pick.enduranceScoreAdjustment),
      broadcastQualityAdjustment: clampAdjustment(pick.broadcastQualityAdjustment),
      reason: String(pick.reason || '').slice(0, 300),
      venueZh: String(pick.venueZh || '').slice(0, 100),
      // Structured evidence - kept even when empty (a genuine "search found
      // nothing current" is real information, not a missing field).
      evidence: Array.isArray(pick.evidence)
        ? pick.evidence.slice(0, 5).map(sanitizeCachedEvidenceItem).filter(item => item.finding)
        : [],
      source: 'ai',
      cachedAt: now.toISOString()
    });
  }

  // Every OTHER currently-needed fixture that didn't get a fresh pick this
  // run (a throttled run skipped Gemini entirely, or this one specific
  // fixture's batch failed) falls back to its own last real validation, as
  // long as it's not too stale - see applyCachedAdjustments' own comment.
  applyCachedAdjustments(adjustments, needsScoring, cachedAdjustments, now.getTime(), AI_ADJUSTMENT_CACHE_MAX_AGE_HOURS);

  let usedAi = false;
  for (const match of matches) {
    // A finished match is never sent to Gemini (see needsScoring above), so
    // `adjustments` never has an entry for one - it always falls through to
    // this same api-objective default, same as any other not-yet-validated
    // fixture. That's deliberate: its objectiveScore above is computed the
    // exact same way as any other match, so it gets a real, stable score
    // here too instead of being zeroed out - see this function's own
    // comment above on why a finished match still needs a real score to
    // stay a normal candidate in computeDayPlan's whole-day plan.
    const adjustment = adjustments.get(match.id) || {
      competitivenessAdjustment: 0,
      watchabilityAdjustment: 0,
      enduranceScoreAdjustment: 0,
      broadcastQualityAdjustment: 0,
      reason: '',
      venueZh: '',
      evidence: [],
      source: 'api-objective'
    };
    const objective = match.objectiveScore;
    match.competitiveness = clamp(Math.round(objective.competitiveness + adjustment.competitivenessAdjustment), 1, 10);
    match.watchability = clamp(Math.round(objective.watchability + adjustment.watchabilityAdjustment), 1, 10);
    match.enduranceScore = clamp(Math.round(objective.enduranceScore + adjustment.enduranceScoreAdjustment), 1, 10);
    match.broadcastQuality = clamp(Math.round(objective.broadcastQuality + adjustment.broadcastQualityAdjustment), 1, 10);
    // Purely deterministic (average win%/points-rate, see
    // objective-score.mjs's skillFromWinPct) - never adjusted by Gemini,
    // unlike the four dimensions above. Team quality is exactly the kind of
    // fact a real standings record already settles; there's nothing left
    // for a validation pass to add on top the way there is for
    // watchability's "is this secretly a bigger story than the numbers
    // suggest" judgment call.
    match.skill = Number.isFinite(objective.skill) ? objective.skill : null;
    // A locally-built, data-grounded reason (see buildObjectiveReasonZh)
    // until Gemini's own validated one arrives - real and specific to this
    // fixture's actual numbers, not a placeholder.
    match.reason = adjustment.reason || buildObjectiveReasonZh(objective.factors);
    match.venueZh = adjustment.venueZh || '';
    // Always the hardcoded rule, never anything AI-sourced - see that
    // function's own comment.
    match.whereToWatchTw = resolveWhereToWatchTw(match);
    match.objectiveFactors = objective.factors;
    match.evidence = Array.isArray(adjustment.evidence) ? adjustment.evidence : [];
    match.evidenceRetrievedAt = match.evidence.length
      ? new Date(
          Math.max(...match.evidence.map(item => Date.parse(item.retrievedAt)).filter(Number.isFinite))
        ).toISOString()
      : null;
    match.source = adjustment.source || 'api-objective';
    match.refined = !!adjustment.refined;
    if (match.source === 'ai') usedAi = true;
    match.score = Math.round(((match.competitiveness + match.watchability) / 2) * 10) / 10;
    // How much this score should actually be trusted - see
    // computeConfidence's own comment for what it's grounded in.
    match.confidence = computeConfidence(match);
  }

  // Same throttle as the base validation pass above - a comparative
  // re-check is still a Gemini call (a Pro-tier one, at that).
  if (!throttled) {
    const refined = await refineContestedClusters(matches, adjustments);
    if (refined) {
      meta.lastAiFetchAt = now.toISOString();
      for (const match of matches) {
        const entry = adjustments.get(match.id);
        if (!entry?.refined || !match.objectiveScore) continue;
        match.competitiveness = clamp(Math.round(match.objectiveScore.competitiveness + entry.competitivenessAdjustment), 1, 10);
        match.watchability = clamp(Math.round(match.objectiveScore.watchability + entry.watchabilityAdjustment), 1, 10);
        match.reason = entry.reason;
        match.score = Math.round(((match.competitiveness + match.watchability) / 2) * 10) / 10;
        match.refined = true;
        match.confidence = computeConfidence(match);
      }
    }
  }

  // Persists exactly the adjustments this run actually ended up using
  // (fresh Gemini picks, refined picks, and cache entries reused as-is)
  // back into data/ai-meta.json for the NEXT run's own cache fallback
  // above - pruned to only matches still in this run's own fetch window,
  // so a fixture that ages out of the schedule doesn't linger in this file
  // forever.
  const currentMatchIds = new Set(matches.map(m => m.id));
  meta.adjustments = Object.fromEntries([...adjustments].filter(([id]) => currentMatchIds.has(id)));

  matches.sort((a, b) => Date.parse(a.startTimeUtc) - Date.parse(b.startTimeUtc));

  // Not part of the public matches.json shape - only ever used internally,
  // above, to compute the final competitiveness/watchability/enduranceScore/
  // broadcastQuality. Dropped before writing so the objective breakdown
  // (`objectiveFactors`) is the one thing exposed for transparency, not a
  // second, redundant copy of the pre-adjustment numbers.
  for (const match of matches) delete match.objectiveScore;

  const output = {
    generatedAt: now.toISOString(),
    buildId: BUILD_ID,
    daysAhead: DAYS_AHEAD,
    lastAiFetchAt: meta.lastAiFetchAt || null,
    // The shared proxy's own base URL, plain (no path suffix) - so the
    // BROWSER can build its own `${proxyUrl}/sports-proxy`/`/match-dispatch`
    // requests for live-score polling and the on-demand refresh/reevaluate
    // buttons (see app.js), without this ever having to be hardcoded into
    // app.js itself or shipped as a second, separately-configured setting.
    // Not a secret - this is the exact same public Worker base URL
    // scripts/build-data.mjs already reads from PROXY_URL to call
    // /match-recommend; a static site's own client bundle can't keep
    // anything truly hidden anyway (see this repo's README on PROXY_URL
    // being a plain GitHub Actions Variable, not a Secret). null when
    // PROXY_URL isn't configured - app.js already treats every feature that
    // depends on it as optional, degrading gracefully with it unset.
    proxyUrl: PROXY_URL || null,
    // 'finished' matches are excluded from this "is everything AI-validated"
    // check - they're never scored at all, so counting them here would
    // report 'mixed' the instant even one match on the page has ended.
    source:
      matches.length === 0
        ? 'none'
        : usedAi
          ? matches.every(m => m.isFinished || m.source === 'ai')
            ? 'ai'
            : 'mixed'
          : 'api-objective',
    matches
  };

  await mkdir(new URL('.', OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  await mkdir(new URL('.', AI_META_PATH), { recursive: true });
  await writeFile(AI_META_PATH, JSON.stringify(meta, null, 2) + '\n');
  console.log(
    `Wrote ${matches.length} matches to ${OUTPUT_PATH.pathname} (source: ${output.source}, ${toFetchNow.length} sent to Gemini this run, ${needsScoring.length - toFetchNow.length} throttled)`
  );
}

// Only actually runs the build when this file is executed directly (`node
// scripts/build-data.mjs`) - not when it's merely imported, e.g. by
// tests/build-data.test.mjs importing the exported pure helpers above.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
