// ---- public/lib/match-builder.mjs ----
// Fetches upcoming AND currently-live fixtures for the Premier League, MLB,
// NBA, and F1 from ESPN's public scoreboard API (no key required) across
// the next `daysAhead` days, and scores each one for competitiveness/
// watchability. Only a FINISHED fixture is excluded - a live one is
// exactly what "what's worth watching" should be able to recommend.
//
// The one exported entry point, buildMatches (right at the bottom), runs
// in TWO very different places, both real, neither a fallback for the
// other:
//   - scripts/build-data.mjs's Node CLI, for local dev/debugging tooling
//     (dump-day-plan.mjs/evaluate-recommendations.mjs both read a
//     matches.json snapshot from disk) - it can reach every host below
//     directly.
//   - public/app.js's own browser build, called directly by every viewer's
//     own tab on load and on a recurring refresh (see that file's own
//     comment on why - this used to be a static matches.json rebuilt by a
//     scheduled GitHub Action and redeployed every 15 minutes; that whole
//     deploy-to-refresh cycle is gone, replaced by the viewer's OWN browser
//     doing this fetch+score work itself, live, through the shared proxy).
// Every fetch this needs is passed in as an injected `fetchJson(url)`
// rather than called directly (see buildMatches's own comment) precisely
// because Node and the browser reach these hosts completely differently -
// none of this module's own code needs to know or care which one is
// calling it.
//
// ---- API-data-driven scoring, no AI involved anywhere (this is the ------
// ---- architecture, not a detail) ----------------------------------------
//
// competitiveness/watchability/enduranceScore/broadcastQuality/skill are
// computed entirely deterministically, by public/lib/objective-score.mjs, from
// real statistical signals - season record, recent form and standings
// proximity from the MLB Stats API, championship-race intensity from the
// Ergast-compatible Jolpica F1 API, and betting-market odds/national-
// broadcaster data already fetched from ESPN (see public/lib/sport-signals.mjs
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
import { teamNameZh, f1RaceNameZh } from './team-names.mjs';
// Confidence is computed from exactly the same source/refined fields this
// module sets on each match below (see computeConfidence's own comment) -
// shared with public/app.js's resolveViewingPlan (which recomputes the
// same number purely for display, since a finished match's confidence
// can't be baked in once and stay correct forever the way an
// already-computed score can) so there's exactly one definition of what
// "confidence" means, not two that could drift.
import { computeConfidence } from './recommendation.mjs';
// The on-card win% odds come from Polymarket, not ESPN - see that module's
// own top-of-file comment for why (a real prediction market's own trade
// price needs no American-odds conversion, and it's the only feed here
// that covers F1 at all). enrichWithPolymarketOdds below is what actually
// wires this in, once per build/refresh, after every match is otherwise
// built.
import {
  POLYMARKET_TAG_ID,
  fetchAllPolymarketEvents,
  resolveTeamOdds,
  resolveF1WinnerOdds,
  resolvePoleWinnerOdds
} from './polymarket.mjs';
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
// score - standings/form (MLB Stats API, and ESPN's own /standings for
// NBA/EPL) and championship intensity (Jolpica F1 API) - see that
// module's own top-of-file comment for the honest caveat on how the MLB/F1
// ones were built without live network access (the NBA/EPL ones were
// added later, against real live responses).
import {
  fetchMlbStandings,
  fetchNbaStandings,
  fetchEplStandings,
  fetchF1TitleRaceIntensity
} from './sport-signals.mjs';

// How many calendar days ahead (from today, UTC) buildMatches fetches by
// default - the FULL horizon the day-scroller can ever show a pill for.
// public/app.js calls buildMatches with a much smaller daysAhead for its
// own frequent near-term refresh (today/tomorrow's scores and odds
// actually move; a fixture 10 days out doesn't), and this larger default
// only for its own slower, full-window refresh (new fixtures entering the
// far end of the window, standings/title-race drift) - see that file's
// own comment for the exact two-tier split and why fetching this whole
// window on every refresh isn't practical (ESPN's own scoreboard endpoint
// has no multi-day range query for a team sport - confirmed live, only
// F1's own racing/f1 endpoint accepts one - so this really is one request
// per league per day across the whole window, not something a single
// cheap query could replace).
export const DEFAULT_DAYS_AHEAD = 14;

// Team-sport leagues, all sharing the same ESPN scoreboard shape
// (site.api.espn.com/apis/site/v2/sports/<sportKey>/<leagueKey>/scoreboard).
// durationMinutes here is only a FALLBACK flat average - see
// computeDurationMinutes below, which computes a real per-fixture estimate
// from public/lib/sport-duration.mjs for every league listed here.
const TEAM_LEAGUES = [
  { id: 'epl', sportKey: 'soccer', leagueKey: 'eng.1', label: 'Premier League', durationMinutes: 115 },
  { id: 'mlb', sportKey: 'baseball', leagueKey: 'mlb', label: 'MLB', durationMinutes: 190 },
  { id: 'nba', sportKey: 'basketball', leagueKey: 'nba', label: 'NBA', durationMinutes: 150 }
];

// The one place that decides "how long will this specific fixture's
// broadcast run" - a real per-team/circuit formula for the three leagues
// this build actually has one for (see public/lib/sport-duration.mjs), and
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
// length is simply how long ago it started, as of this fetch - and
// categorically better than the PRE-GAME estimate computeDurationMinutes
// above returns for a fixture that hasn't started yet. This is the direct
// fix for a reported bug: a finished MLB game whose broadcast genuinely
// ran 30-60 minutes SHORTER than its own pre-game prediction still
// reserved a schedule block sized to that longer, now-known-wrong guess
// (see recommendation.mjs's schedulingDurationMinutes, which also stops
// adding its own overrun buffer once isFinished is true - there's no
// forward uncertainty left to hedge once the real length is already
// known), which kept blocking a next match that could obviously, actually
// follow it. Floored well below any realistic finished-game length so a
// data glitch (ESPN marking a fixture 'post' almost immediately, e.g. a
// postponement) can't produce a laughably tiny reserved block.
//
// "As of this fetch" used to mean "shortly after the fixture ends", back
// when this whole app rebuilt matches.json on a 15-minute GitHub Actions
// cron. That's stale now - this app has no scheduled rebuild at all
// anymore (see scripts/build-data.mjs's own top comment); buildMatches
// runs live, in every viewer's own browser, on both the 60s near-term and
// 5min full-window polls (app.js). Calling this function fresh on EVERY
// one of those polls means "now" keeps advancing for as long as a tab
// stays open or a viewer revisits later, so THIS function alone would
// make an already-finished match's own reported duration keep growing
// toward its per-sport cap purely from elapsed VIEWING time - live-
// reported as "today's and yesterday's finished MLB matches" showing a
// suspiciously long duration next to upcoming ones' flat pre-game
// estimate. The actual fix lives one layer up, in app.js's
// mergeFreshMatches: once a match is first seen finished, its
// durationMinutes is FROZEN (carried forward on every later merge)
// instead of being recomputed via this function again - this function
// itself still only ever returns a fresh, unfrozen "elapsed since start"
// number, exactly as it always has.
export const MIN_FINISHED_DURATION_MINUTES = 30;
// Ceilinged at a genuinely REALISTIC worst-case broadcast length, per
// sport - not "how high can a stale fetch's elapsed-to-now number get
// before it looks obviously wrong" (Round 45's own live-reported failure:
// MLB's old cap, 360 minutes/6 hours, was picked as "well above genuine
// worst-case overruns" and then itself became the displayed number for
// EVERY finished MLB match sitting in the fetched window more than 6
// hours after kickoff - which is the NORMAL case now, not a rare cron
// hiccup, since this app polls continuously and retains a match through
// the rest of today plus one day back. A real MLB game, even with extra
// innings, essentially never runs 6 hours - this cap is now what a
// genuinely long broadcast could plausibly be, and once the naive
// elapsed-to-now number exceeds it, `finishedDurationMinutes` below no
// longer trusts "elapsed since start" as a length signal AT ALL (see its
// own comment) rather than clamping at, and displaying, this ceiling as
// if it meant something real.
// Premier League's own 140 (not just "a bit above" the 108-125 pre-game
// estimate range in sport-duration.mjs) is deliberately picked so that two
// back-to-back league fixtures scheduled the real-world-standard 2h30m
// apart (e.g. two 13:00 UTC kickoffs vs. a 15:30 UTC one, a live-reported
// case from before this cap existed at all) never fall on the wrong side
// of the TRANSITION_BUFFER_MINUTES boundary in recommendation.mjs's
// scheduler purely because a late fetch inflated one of them - 140 + 10
// minutes of transition buffer lands exactly at 2h30m, matching that real
// broadcast gap instead of quietly eating into it.
export const FINISHED_DURATION_CAP_MINUTES_BY_SPORT = {
  'Premier League': 140,
  NBA: 180,
  // Round 45: was 360 (6 hours) - live-reported as itself becoming the
  // displayed duration for every finished MLB match viewed more than 6
  // hours after its own kickoff, which this app's own continuous polling
  // (no more "shortly after the fixture ends" cron) makes the norm, not
  // an edge case. 280 (4h40m) still comfortably covers a genuine extra-
  // innings marathon - MLB's real all-time longest games run 6-8 hours,
  // but those are historically rare enough (a handful of times per
  // decade, league-wide) that this cap exists to bound the COMMON case
  // (a normal game, viewed hours or a day late), not the record book.
  MLB: 280,
  F1: 180
};
const DEFAULT_FINISHED_DURATION_CAP_MINUTES = 240;
// `pregameEstimateMinutes` is the SAME per-fixture prediction an upcoming
// match already shows (computeDurationMinutes's own real team/venue/odds-
// informed estimate, not just the league's flat average) - passed in by
// every call site below regardless of isFinished, specifically so this
// function has a real, sport-and-fixture-aware fallback the moment
// "elapsed since start" stops being trustworthy (see
// FINISHED_DURATION_CAP_MINUTES_BY_SPORT's own comment for why that's the
// COMMON case now, not rare): once the observation is clearly happening
// well after the real final whistle, guessing "the average/predicted
// fixture length" is honest about what this app actually knows, where
// clamping at an arbitrary ceiling and showing THAT instead just
// substitutes one wrong number for a differently-wrong one.
export function finishedDurationMinutes(startTimeUtc, now, sport, pregameEstimateMinutes) {
  const elapsedMinutes = Math.round((now.getTime() - Date.parse(startTimeUtc)) / 60_000);
  const cap = FINISHED_DURATION_CAP_MINUTES_BY_SPORT[sport] ?? DEFAULT_FINISHED_DURATION_CAP_MINUTES;
  if (elapsedMinutes > cap) {
    return Number.isFinite(pregameEstimateMinutes)
      ? Math.max(MIN_FINISHED_DURATION_MINUTES, pregameEstimateMinutes)
      : cap;
  }
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

// `fetchJson(url)` is INJECTED into every function below that needs it
// (fetchTeamLeagueMatches/fetchF1Matches/enrichWithPolymarketOdds/
// fetchMlbStandings/fetchF1TitleRaceIntensity), never called directly from
// this module - this file now runs in two very different places:
// scripts/build-data.mjs's Node CLI (which can reach ESPN/Polymarket/the
// MLB Stats API/Jolpica directly - see that file's own fetchJson, which
// sends a real, honest User-Agent after a live-confirmed Akamai bot-block
// on ESPN's scoreboard API keyed to the UA string) and public/app.js's
// browser build (which cannot - none of those four hosts sends CORS
// headers, so every request has to go through the shared proxy's
// /sports-proxy passthrough instead). See buildMatches below for where
// the injected fetchJson actually gets threaded through.

// One competitor's overall record as {wins, losses, ties}, or null if ESPN
// didn't report one (a brand new season, or a sport/league whose records
// aren't shaped like this at all). `ties` is the regex's own third group -
// 0 for MLB/NBA's plain "W-L" summary (no such thing as a tie), but a real,
// load-bearing number for EPL's own "W-L-D" summary, where it means DRAWS.
// Live-verified bug this fixes: Crystal Palace's real 2026-09-20 summary was
// "1-1-3" (1 win, 1 loss, 3 draws - 5 games played), but this function used
// to keep only the first two numbers, silently discarding the draws from
// BOTH the numerator and the denominator - not merely rounding them off,
// but deleting 3 of the team's 5 games from existence. That read Palace as
// a small-sample 1-1 (.500) side instead of the real, much worse 1-1-3
// (.200) one, directly inflating computeEplObjectiveScore's season-closeness
// signal (a fake near-.500-vs-.400 "close game" instead of the real
// .200-vs-.400 gap) - see docs/recommendation-engine-audit.md's Round 14.
// Feeds both the objective scoring engine's win% signal and the short
// human-readable context string handed to Gemini - never trusted for
// anything more precise than "roughly how good is this team right now".
export function parseOverallRecord(competitor) {
  const summary = (competitor.records || []).find(r => r.type === 'total' || r.name === 'overall')
    ?.summary;
  const match = /^(\d+)-(\d+)(?:-(\d+))?$/.exec(summary || '');
  if (!match) return null;
  return { wins: Number(match[1]), losses: Number(match[2]), ties: Number(match[3] || 0) };
}

function buildCompetitor(leagueId, c) {
  const abbreviation = c.team?.abbreviation || '';
  return {
    name: c.team?.displayName || 'Unknown',
    nameZh: teamNameZh(leagueId, abbreviation),
    abbreviation,
    logo: c.team?.logo || '',
    homeAway: c.homeAway || '',
    // ESPN's own bare hex strings (no leading #, e.g. "d00027") for this
    // team's real brand colors - see public/lib/color.mjs's
    // pickReadableTeamColor, which is what actually decides whether either
    // one is legible enough to use on the odds bar (some teams' own
    // primary color is near-black/near-white and unreadable on this app's
    // background - live-verified real example: Inter Miami CF's primary
    // is "231f20", almost invisible on this app's dark theme).
    color: c.team?.color || '',
    altColor: c.team?.alternateColor || '',
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
  if (!record) return competitor.name;
  // Ties only ever print for a sport that actually has them (EPL) - a
  // trailing "-0" on every MLB/NBA context string would be dead noise.
  const suffix = record.ties ? `-${record.ties}` : '';
  return `${competitor.name} (${record.wins}-${record.losses}${suffix})`;
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
// public/lib/objective-score.mjs's closenessFromSpread actually consumes.
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

async function fetchTeamLeagueMatches(league, now, windowEndMs, daysAhead, fetchJson) {
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
      // ESPN's season.type is 1 for the preseason (confirmed live against a
      // real 2026-27 NBA preseason fixture: season.type=1,
      // season.slug='preseason'), 2 for the regular season, 3 for the
      // postseason. Preseason exhibitions are skipped entirely, not just
      // excluded from 推薦賽事 - direct feedback: this site's own real
      // broadcast source (愛爾達體育台) doesn't air NBA preseason games at
      // all, so a fixture no one can actually watch through this site's own
      // whereToWatchTw answer has no business appearing anywhere on it, the
      // same "not a fixture this site can say anything useful about"
      // reasoning as the TBD-competitor skip just above.
      if (event.season?.type === 1) continue;

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
        // Filled in afterward, once per build, by enrichWithPolymarketOdds
        // below - never from ESPN.
        oddsWinPctAway: null,
        oddsWinPctHome: null,
        oddsWinPctDraw: null,
        oddsFavorites: null,
        durationMinutes: (() => {
          const pregameEstimateMinutes = computeDurationMinutes(
            league,
            away,
            home,
            competition.venue?.fullName || '',
            broadcast || '',
            oddsSignal.overUnder
          );
          return isFinished
            ? finishedDurationMinutes(new Date(startMs).toISOString(), now, league.label, pregameEstimateMinutes)
            : pregameEstimateMinutes;
        })(),
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

async function fetchF1Matches(now, windowEndMs, daysAhead, fetchJson) {
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
      const pregameEstimateMinutes = sessionType.abbreviation === 'Race'
        ? predictF1RaceDurationMinutes(venue)
        : sessionType.durationMinutes;
      const durationMinutes = isFinished
        ? finishedDurationMinutes(new Date(startMs).toISOString(), now, 'F1', pregameEstimateMinutes)
        : pregameEstimateMinutes;

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
        // No away/home concept for a multi-driver race - see
        // oddsFavorites below (filled in for the Race session only, by
        // enrichWithPolymarketOdds) for F1's own real odds instead.
        oddsWinPctAway: null,
        oddsWinPctHome: null,
        oddsWinPctDraw: null,
        oddsFavorites: null,
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
// deterministic formula (public/lib/objective-score.mjs) - the PRIMARY score
// for every dimension the shared proxy used to be asked to invent from
// scratch. `signals` carries the once-per-build API fetches (MLB
// standings, F1 title-race intensity) every fixture of that sport shares.
// A sport with no dedicated formula yet falls back to a plain neutral
// score rather than crashing the build.
export function computeMatchObjectiveScore(match, { mlbStandings, nbaStandings, eplStandings, f1TitleRaceIntensity } = {}) {
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
  // Ties count toward games PLAYED (the denominator) but never toward wins
  // (the numerator) - a draw is worth more than a loss but isn't a win, and
  // leaving it out of the denominator entirely (the bug parseOverallRecord's
  // own comment documents) understates how many games a draw-heavy team has
  // actually played, inflating its win% toward whatever its wins/losses
  // alone happen to divide out to.
  const awayGames = away?.record ? away.record.wins + away.record.losses + (away.record.ties || 0) : 0;
  const homeGames = home?.record ? home.record.wins + home.record.losses + (home.record.ties || 0) : 0;
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
        away: nbaStandings?.get(away?.name) || null,
        home: nbaStandings?.get(home?.name) || null,
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
        away: eplStandings?.get(away?.name) || null,
        home: eplStandings?.get(home?.name) || null,
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

// One request per sport that actually has an unfinished fixture this build
// - not once per fixture, same "one batch request, shared across every
// fixture that needs it" shape as fetchMlbStandings/fetchF1TitleRaceIntensity
// just below main(). A finished match keeps null odds (see main's own
// comment on why finished matches still get scored - odds is different: a
// game that's already over has no "will they win" left to ask a market).
// Best-effort per sport: one league's Polymarket fetch failing (rate limit,
// a transient 5xx) never blocks the rest of the build - those matches just
// keep their default null odds, same as a fixture no market has posted a
// line for yet.
async function enrichWithPolymarketOdds(matches, fetchJson) {
  const sportsNeeded = new Set();
  matches.forEach(m => {
    if (!m.isFinished && POLYMARKET_TAG_ID[m.sport] != null) sportsNeeded.add(m.sport);
  });
  const eventsBySport = {};
  await Promise.all(
    [...sportsNeeded].map(async sport => {
      try {
        eventsBySport[sport] = await fetchAllPolymarketEvents(POLYMARKET_TAG_ID[sport], fetchJson);
      } catch (error) {
        console.warn(`Failed to fetch Polymarket odds for ${sport}: ${error.message}`);
        eventsBySport[sport] = [];
      }
    })
  );

  for (const match of matches) {
    if (match.isFinished) continue;
    const events = eventsBySport[match.sport];
    if (!events) continue;

    if (match.sport === 'F1') {
      // The Race session gets an outright-winner odds display, and
      // Qualifying gets Polymarket's own separate "Driver Pole Position"
      // outright market (confirmed live - same per-driver Yes/No shape,
      // see resolvePoleWinnerOdds's own comment) - a practice session
      // isn't "who wins" anything Polymarket has a market for, so it's
      // left alone (see build-data.mjs's own F1_SESSION_TYPES/match id
      // convention for the `-race`/`-qual` suffixes checked here).
      const sessionDateUtc = match.startTimeUtc.slice(0, 10);
      const favorites = match.id.endsWith('-race')
        ? resolveF1WinnerOdds(events, sessionDateUtc)
        : match.id.endsWith('-qual')
          ? resolvePoleWinnerOdds(events, sessionDateUtc)
          : null;
      if (favorites) match.oddsFavorites = favorites.slice(0, 3);
      continue;
    }

    if (!Array.isArray(match.competitors) || match.competitors.length !== 2) continue;
    const [away, home] = match.competitors;
    const result = resolveTeamOdds(events, {
      awayName: away.name,
      homeName: home.name,
      startTimeUtc: match.startTimeUtc,
      hasDraw: match.sport === 'Premier League'
    });
    if (result) {
      match.oddsWinPctAway = result.away;
      match.oddsWinPctHome = result.home;
      match.oddsWinPctDraw = result.draw;
    }
  }
}

// The one exported entry point - fetches every fixture in [now, now +
// daysAhead days], enriches it with Polymarket odds and the
// MLB-standings/F1-title-race signals, scores it, and returns the flat
// `{ generatedAt, matches }` shape both scripts/build-data.mjs (writing it
// to disk) and public/app.js (applying it straight to the page) use
// identically.
//
// `fetchJson(url)` is the ONE thing callers must inject (see this file's
// own top comment) - everything else defaults sensibly. `now`/`daysAhead`
// are exposed specifically so app.js's own two-tier refresh (a frequent
// small-`daysAhead` call for near-term freshness, a slower full-
// `DEFAULT_DAYS_AHEAD` call for the rest of the day-scroller's window) can
// both call this same function instead of two different code paths.
export async function buildMatches({ now = new Date(), daysAhead = DEFAULT_DAYS_AHEAD, fetchJson, enabledSports = null }) {
  if (typeof fetchJson !== 'function') {
    throw new TypeError('buildMatches requires a fetchJson(url) function - see this file\'s own top comment');
  }
  const windowEndMs = now.getTime() + daysAhead * 24 * 60 * 60 * 1000;

  // `enabledSports` (a Set/array of the exact `match.sport` labels below,
  // e.g. from app.js's own Settings toggle) skips fetching a league's
  // fixtures entirely when it isn't one of them - left `null` (the
  // default), every league is fetched, same as before this existed
  // (scripts/build-data.mjs and dump-day-plan.mjs have no such concept of
  // "the viewer's own enabled sports", so they always get everything).
  // Direct performance win: a viewer who's turned off 3 of 4 sports in
  // Settings was still paying for ALL of them on every single refresh
  // tier - fetching (and, via hasActiveX below, standings-fetching and
  // Polymarket-odds-enriching) fixtures for a league nothing on screen
  // will ever show.
  const leagues = enabledSports ? TEAM_LEAGUES.filter(league => enabledSports.has(league.label)) : TEAM_LEAGUES;
  const shouldFetchF1 = !enabledSports || enabledSports.has('F1');

  // The (filtered) team leagues and F1 are entirely independent fetches (no
  // team league's own result depends on F1's, or on any other league's) -
  // an earlier version awaited the team leagues' own Promise.all to FULLY
  // finish before even starting the F1 fetch, adding one whole extra
  // serial network round-trip for no reason (live-measured as a real,
  // avoidable contributor to a reported "updating data takes 10-20
  // seconds, sometimes more, sometimes less" - see this function's own
  // second Promise.all below for the other half of that same fix).
  // Bundling them into one Promise.all lets every one of these requests
  // race in parallel instead.
  const [teamMatchLists, f1Matches] = await Promise.all([
    Promise.all(
      leagues.map(league =>
        fetchTeamLeagueMatches(league, now, windowEndMs, daysAhead, fetchJson).catch(error => {
          console.warn(`Failed to fetch ${league.label}: ${error.message}`);
          return [];
        })
      )
    ),
    shouldFetchF1
      ? fetchF1Matches(now, windowEndMs, daysAhead, fetchJson).catch(error => {
          console.warn(`Failed to fetch F1: ${error.message}`);
          return [];
        })
      : Promise.resolve([])
  ]);

  const matches = [...teamMatchLists.flat(), ...f1Matches];

  // The extra, dedicated-API signals the objective scoring engine needs -
  // fetched ONCE per call, not once per fixture (every MLB game that day
  // shares the same league-wide standings snapshot; every F1 session that
  // weekend shares the same championship intensity). Skipped entirely when
  // there's no live use for them this run (an all-EPL/NBA window, or the
  // off-season) so a quiet day doesn't cost a request for nothing.
  const hasActiveMlb = matches.some(m => m.sport === 'MLB' && !m.isFinished);
  const hasActiveNba = matches.some(m => m.sport === 'NBA' && !m.isFinished);
  const hasActiveEpl = matches.some(m => m.sport === 'Premier League' && !m.isFinished);
  const hasActiveF1 = matches.some(m => m.sport === 'F1' && !m.isFinished);
  // Polymarket odds enrichment and the standings/title-race fetch above
  // are ALSO independent of each other (both only need `matches` to exist,
  // neither reads the other's result) - run together rather than one
  // fully finishing before the other starts, same reasoning as the
  // team-league/F1 merge above.
  const [, [mlbStandings, nbaStandings, eplStandings, f1TitleRaceIntensity]] = await Promise.all([
    enrichWithPolymarketOdds(matches, fetchJson),
    Promise.all([
      hasActiveMlb ? fetchMlbStandings(now.getUTCFullYear(), fetchJson) : Promise.resolve(new Map()),
      hasActiveNba ? fetchNbaStandings(fetchJson) : Promise.resolve(new Map()),
      hasActiveEpl ? fetchEplStandings(fetchJson) : Promise.resolve(new Map()),
      hasActiveF1 ? fetchF1TitleRaceIntensity(fetchJson) : Promise.resolve(null)
    ])
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
    const objective = computeMatchObjectiveScore(match, { mlbStandings, nbaStandings, eplStandings, f1TitleRaceIntensity });
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
    // Only MLB's own computeMlbObjectiveScore sets this (a graduated 0..1
    // marquee-credit fraction, see marqueeCreditFraction's own comment) -
    // undefined for NBA/EPL/F1, which recommendation.mjs's own
    // computeEffectiveScore treats as full credit (1), preserving their
    // existing unconditional rivalry/derby/big-club bonus behavior exactly.
    match.marqueeCredit = objective.marqueeCredit;
    match.score = Math.round(((match.competitiveness + match.watchability) / 2) * 10) / 10;
    // How much this score should actually be trusted - see
    // computeConfidence's own comment for what it's grounded in.
    match.confidence = computeConfidence(match);
  }

  matches.sort((a, b) => Date.parse(a.startTimeUtc) - Date.parse(b.startTimeUtc));

  return { generatedAt: now.toISOString(), daysAhead, matches };
}
