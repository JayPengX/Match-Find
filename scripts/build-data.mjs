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
// ---- API-data-driven scoring, no AI involved anywhere (this is the ------
// ---- architecture, not a detail) ----------------------------------------
//
// competitiveness/watchability/enduranceScore/broadcastQuality/skill are
// computed entirely deterministically, by scripts/objective-score.mjs, from
// real statistical signals - season record, recent form and standings
// proximity from the MLB Stats API, championship-race intensity from the
// Ergast-compatible Jolpica F1 API, and betting-market odds/national-
// broadcaster data already fetched from ESPN (see scripts/sport-signals.mjs
// for the fetching/parsing half of this). This objective score is not a
// baseline something else refines - it's the WHOLE score, for every
// fixture, every run.
//
// This pipeline used to also send every fixture to Gemini (via the shared
// Cloudflare Worker in jaypengx-collab/shared-proxy, route
// /match-recommend) for a small, bounded validation adjustment on top of
// this score - removed entirely as of docs/recommendation-engine-audit.md's
// Round 11. Two independent reasons, not one: (1) free-tier Gemini quota
// proved unable to sustain this workload - Round 9 found Google Search
// grounding (the one thing that could have added real signal a formula
// can't see - an injury, a hot narrative) failing with 429
// RESOURCE_EXHAUSTED on 100% of requests, a billing-tier wall, not a bug;
// (2) even where the plain (non-grounded) validation call succeeded, its
// own adjustment was clamped to ±2 specifically so it could never do more
// than nudge this same objective score - Round 9's own live-verified case
// (a 0-0 preseason exhibition scoring near-maximum) showed Gemini's
// validation correctly IDENTIFYING the problem in its own reasoning text
// while being structurally unable to fix it, because the bound meant only
// the deterministic formula itself ever could. Losing a bounded nudge that
// was already quota-starved and already couldn't fix what it correctly
// noticed is a real loss of a little variety in the `reason` text (see
// buildObjectiveReasonZh below - always built from the same objective
// factors now, not sometimes replaced with Gemini's own prose), not a loss
// of scoring quality - every fixture's actual number is computed exactly
// the same way it always was.
//
// PROXY_URL survives this removal - it's still how the BROWSER reaches
// /sports-proxy (live score/odds polling) and /match-dispatch (the
// "重新整理資料" manual refresh button), neither of which ever touched
// Gemini. This script itself no longer calls the proxy for anything.

import { writeFile, mkdir } from 'node:fs/promises';
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
  isEplBigClub,
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

// Still what the BROWSER uses for /sports-proxy (live score/odds polling)
// and /match-dispatch (the manual "重新整理資料" refresh button) - see
// output.proxyUrl below. This script itself no longer calls the proxy for
// anything (no more Gemini scoring/validation - see this file's top
// comment).
const PROXY_URL = (process.env.PROXY_URL || '').trim().replace(/\/+$/, '');
// The commit this build ran from (.github/workflows/deploy.yml passes
// github.sha) - lets a long-open tab tell a genuine code deploy (a new
// commit) apart from a routine scheduled rebuild of the same commit (see
// public/app.js's update-check polling). Falls back to a fixed string for
// local runs, where there's no meaningful "commit this build is from".
const BUILD_ID = (process.env.BUILD_ID || 'local').trim();
const OUTPUT_PATH = new URL('../public/data/matches.json', import.meta.url);

// How many calendar days ahead (from today, UTC) to fetch. The site's day
// scroller shows the first 7 of these up front and reveals the rest on a
// "load more" click - all client-side, no extra network request, since
// everything through DAYS_AHEAD is already baked into matches.json by the
// time anyone opens the page. 14 gives that click something real to reveal.
const DAYS_AHEAD = 14;

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

// A real, live 403 hit while working on this file: ESPN's own scoreboard
// API sits behind Akamai's bot manager, which blocks Node's own default
// fetch User-Agent (the literal string "node") outright - and, more
// surprisingly, ALSO blocks a fabricated real-browser UA (Chrome's, tried
// live), while a plain, honest self-identifying UA and even bare `curl`'s
// own default both sail through untouched. This isn't a targeted block on
// automation as such, just a specific blocklisted token - a transparent,
// honest bot UA (contact URL included, standard practice for a script
// polling a public, no-auth, no-rate-limit-documented endpoint like this
// one) is both the more honest choice and the one confirmed live to work,
// unlike pretending to be a browser this build isn't. Whether this
// specific block is active in the real GitHub Actions runner pool at any
// given moment is unknown - this fixes it either way, at zero cost, rather
// than leaving `matches: []` (a silently empty deploy) as a real possible
// outcome of nothing more than which default string a fetch call happened
// to send.
const FETCH_USER_AGENT = 'Match-Find-Bot/1.0 (+https://github.com/jaypengx-collab/Match-Find)';

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': FETCH_USER_AGENT },
    signal: AbortSignal.timeout(15_000)
  });
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
  // Queries `now`'s own UTC date AND the two days before it - not just
  // `now` onward. This script runs on a schedule/on push, at whatever UTC
  // instant that happens to be, and ESPN's own `dates=YYYYMMDD` scoreboard
  // query groups a game under the calendar day IT started on by ESPN's own
  // reckoning (for MLB in particular, that tracks the US Eastern "game
  // date", not the UTC one) - the two only diverge for part of the day,
  // which a single extra day of lookback already covers on its own.
  //
  // A SECOND lookback day exists for a completely different reason: this
  // site's own "昨天" (Yesterday) section is in the VIEWER's local
  // calendar day (Taiwan, UTC+8 - see public/app.js's dayLabelFor), not
  // this build's own UTC `now`. A US evening MLB fixture (US Eastern is
  // UTC-4/-5) lands, in Taiwan local time, on the viewer's NEXT calendar
  // date - so the EARLIEST instant of the viewer's own "yesterday" can
  // correspond to an ESPN/US game date a full 2 UTC-calendar-days behind
  // this build's own `now`, not just 1. A single day of lookback (this
  // repo's own original fix, aimed only at the ESPN-reckoning-vs-UTC gap
  // above) was live-confirmed to still miss real, already-finished MLB
  // fixtures that should have appeared in "昨天" while same-day EPL
  // fixtures (whose UK kickoffs sit much closer to UTC, so this same gap
  // rarely bites them) correctly did - "Yesterday only shows Premier
  // League, no MLB" is exactly what that half-covered lookback produces.
  // Two extra requests per league up front costs nothing and risks nothing
  // (the state/bounds checks below already correctly filter anything
  // outside the real window; only a genuinely FINISHED fixture is exempted
  // from that bound at all - see the isFinished check below).
  //
  // length is daysAhead + 3, not + 1: two extra days for the lookback
  // above, PLUS one more so the loop's own far end actually reaches
  // windowEndMs.
  const dates = Array.from({ length: daysAhead + 3 }, (_, i) =>
    yyyymmddUtc(new Date(now.getTime() + (i - 2) * 86_400_000))
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
  // Starts two days before `now`, same reasoning and same fix as
  // fetchTeamLeagueMatches's own `dates` array above (the Taiwan-viewer
  // "昨天" lookback needs a full 2 UTC-calendar-days of margin, not just 1).
  const rangeParam = `${yyyymmddUtc(new Date(now.getTime() - 2 * 86_400_000))}-${yyyymmddUtc(new Date(now.getTime() + daysAhead * 86_400_000))}`;
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
  // `null` for a team with zero games played (preseason/season-opener,
  // record 0-0), never `0` - a 0.000 win% is a REAL, verified fact about a
  // team that's played games and lost all of them; "hasn't played yet" is a
  // completely different, no-signal case that Math.max(1, ...)'s old
  // divide-by-zero guard silently conflated with it. Both teams sharing the
  // same "no signal" 0 used to read as a perfectly even 0.0pp win% gap -
  // maximum closeness - to closenessFromWinPctGap, which is exactly
  // backwards: a live-verified case was a 0-0 NBA preseason exhibition in
  // Quebec City (no betting line posted either) scoring a maxed-out 10/10
  // competitiveness and 9.0 overall, ranking ABOVE real September MLB
  // pennant-race games with genuine stakes. Every per-sport function
  // already guards `Number.isFinite(awayWinPct) && Number.isFinite(homeWinPct)`
  // before using either one specifically so a genuinely missing signal
  // renormalizes away via weightedAverage instead of being treated as a
  // real value - that guard just never worked while a missing record's
  // "0 games" was itself indistinguishable from "a real 0.000 average".
  const awayGames = away?.record ? away.record.wins + away.record.losses : 0;
  const homeGames = home?.record ? home.record.wins + home.record.losses : 0;
  const awayWinPct = awayGames > 0 ? away.record.wins / awayGames : null;
  const homeWinPct = homeGames > 0 ? home.record.wins / homeGames : null;

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
        isBigClub: isEplBigClub(away?.name, home?.name),
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
  [/known big-club fixture/, '豪門球隊'],
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

  // The WHOLE score - computed for EVERY fixture, finished or not. A
  // finished fixture's own real underlying data (final record, that day's
  // odds/standings context) doesn't stop being real once the game ends,
  // and this pipeline runs the recommended lineup as ONE calendar-day plan,
  // decided once, not a moving "what's left as of right now" - see
  // recommendation.mjs's computeDayPlan and its own comment on why a
  // finished fixture is a normal scheduling candidate. A viewer opening the
  // page mid-afternoon should see the SAME whole-day plan a viewer this
  // morning would have (this morning's game shown as 已結束 in its own
  // rightful slot, not silently dropped from the lineup), rather than a
  // plan that keeps shrinking to "only what's still ahead" depending purely
  // on when it happens to be loaded.
  for (const match of matches) {
    const objective = computeMatchObjectiveScore(match, { mlbStandings, f1TitleRaceIntensity });
    match.competitiveness = clamp(Math.round(objective.competitiveness), 1, 10);
    match.watchability = clamp(Math.round(objective.watchability), 1, 10);
    match.enduranceScore = clamp(Math.round(objective.enduranceScore), 1, 10);
    match.broadcastQuality = clamp(Math.round(objective.broadcastQuality), 1, 10);
    match.skill = Number.isFinite(objective.skill) ? objective.skill : null;
    // A locally-built, data-grounded reason - real and specific to this
    // fixture's actual numbers, not a placeholder.
    match.reason = buildObjectiveReasonZh(objective.factors);
    // Always the hardcoded rule, never an AI guess - see that function's
    // own comment.
    match.whereToWatchTw = resolveWhereToWatchTw(match);
    match.objectiveFactors = objective.factors;
    match.score = Math.round(((match.competitiveness + match.watchability) / 2) * 10) / 10;
    // How much this score should actually be trusted - see
    // computeConfidence's own comment for what it's grounded in.
    match.confidence = computeConfidence(match);
  }

  matches.sort((a, b) => Date.parse(a.startTimeUtc) - Date.parse(b.startTimeUtc));

  const output = {
    generatedAt: now.toISOString(),
    buildId: BUILD_ID,
    daysAhead: DAYS_AHEAD,
    // The shared proxy's own base URL, plain (no path suffix) - so the
    // BROWSER can build its own `${proxyUrl}/sports-proxy`/`/match-dispatch`
    // requests for live-score polling and the on-demand refresh button (see
    // app.js), without this ever having to be hardcoded into app.js itself
    // or shipped as a second, separately-configured setting. Not a secret -
    // a static site's own client bundle can't keep anything truly hidden
    // anyway (see this repo's README on PROXY_URL being a plain GitHub
    // Actions Variable, not a Secret). null when PROXY_URL isn't
    // configured - app.js already treats every feature that depends on it
    // as optional, degrading gracefully with it unset.
    proxyUrl: PROXY_URL || null,
    matches
  };

  await mkdir(new URL('.', OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${matches.length} matches to ${OUTPUT_PATH.pathname}`);
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
