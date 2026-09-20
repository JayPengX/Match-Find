// ---- public/lib/sport-signals.mjs ----
// Fetches the real, current statistical signals public/lib/objective-score.mjs
// turns into a deterministic competitiveness/watchability/enduranceScore -
// standings proximity, recent form, and championship-race intensity - from
// dedicated, official/well-established sports-data APIs, deliberately NOT
// limited to ESPN's own scoreboard (see this repo's README, "API data-
// driven scoring engine"):
//
//   - MLB: the official MLB Stats API (statsapi.mlb.com) - free, no API
//     key, and the same API MLB's own apps and countless public tools are
//     built against. Used for division/wild-card standings proximity,
//     each team's own last-10-games record, and its current streak.
//   - F1: the Ergast-compatible Jolpica API (api.jolpi.ca) - free, no API
//     key. Ergast itself (the original, long-standing F1 data API) shut
//     down at the end of the 2024 season; Jolpica is its community-run
//     successor serving the exact same request/response shape. Used for
//     the current drivers' championship standings gap, to gauge how alive
//     the title race is race to race.
//
// IMPORTANT, HONEST CAVEAT: this build environment could not reach EITHER
// host live while this module was written (outbound network access in
// that development session was restricted to a small allowlist that did
// not include these hosts, or even ESPN's own API - see this repo's git
// history for the session this was built in). Every shape assumed below
// is instead taken from these APIs' own long-stable, widely-documented
// public response formats, not confirmed against a live response. Every
// fetch function here is written the same defensive way as the rest of
// this codebase's ESPN calls (try/catch, a hard timeout, Promise.allSettled
// where relevant) specifically because of that: a network failure OR a
// response shape that doesn't match what's assumed here both fail exactly
// the same way - this returns an empty Map/null signal, never throws - so
// public/lib/match-builder.mjs's own scoring always degrades gracefully to
// whatever OTHER signals it does have (season record from ESPN, betting
// odds, or ultimately the plain heuristic) instead of breaking the build.
// If a real run ever shows these coming back empty in practice, the fix is
// to adjust the parsing below against the real response, not to remove the
// integration - the fetch itself is the well-documented, free, no-key part
// that should work; only the exact parsing might need a correction once
// someone can see a live response.

// Both fetch functions below take an INJECTED `fetchJson(url)` rather than
// calling fetch() themselves - this module now runs in two very different
// places (public/lib/match-builder.mjs's Node CLI, which can call these hosts
// directly, and public/app.js's browser build, which cannot: neither
// statsapi.mlb.com nor api.jolpi.ca sends CORS headers, so a browser needs
// to go through the shared proxy's /sports-proxy passthrough instead -
// same reasoning as ./espn.mjs/./polymarket.mjs already being pure
// URL-building/parsing modules that never fetch themselves). See
// public/lib/match-builder.mjs's own comment for the two real
// implementations this gets called with.
export function mlbStandingsUrl(season) {
  return `https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${encodeURIComponent(season)}&standingsTypes=regularSeason`;
}

export function f1DriverStandingsUrl() {
  return 'https://api.jolpi.ca/ergast/f1/current/driverStandings.json';
}

// ---- MLB: statsapi.mlb.com -----------------------------------------------
//
// Stable, long-published numeric team ids from the MLB Stats API - these
// have been unchanged for many seasons and are independent of a team's own
// on-field record, so this table almost never needs updating. Keyed by the
// exact same ESPN `team.displayName` strings public/lib/sport-duration.mjs's
// own MLB_TEAM_PACE_OFFSET_MINUTES table uses, on purpose - both tables
// describe the same 30 teams and must never silently drift apart from each
// other under different spellings.
export const MLB_STATS_API_TEAM_IDS = {
  'Los Angeles Angels': 108,
  'Arizona Diamondbacks': 109,
  'Baltimore Orioles': 110,
  'Boston Red Sox': 111,
  'Chicago Cubs': 112,
  'Cincinnati Reds': 113,
  'Cleveland Guardians': 114,
  'Colorado Rockies': 115,
  'Detroit Tigers': 116,
  'Houston Astros': 117,
  'Kansas City Royals': 118,
  'Los Angeles Dodgers': 119,
  'Washington Nationals': 120,
  'New York Mets': 121,
  'Oakland Athletics': 133,
  'Pittsburgh Pirates': 134,
  'San Diego Padres': 135,
  'Seattle Mariners': 136,
  'San Francisco Giants': 137,
  'St. Louis Cardinals': 138,
  'Tampa Bay Rays': 139,
  'Texas Rangers': 140,
  'Toronto Blue Jays': 141,
  'Minnesota Twins': 142,
  'Philadelphia Phillies': 143,
  'Atlanta Braves': 144,
  'Chicago White Sox': 145,
  'Miami Marlins': 146,
  'New York Yankees': 147,
  'Milwaukee Brewers': 158
};

// "-" is the MLB Stats API's own notation for "leading this race" (zero
// games back) - everything else is a plain decimal string. Missing/
// malformed values return null (a genuinely absent signal), never 0 (which
// would misread as "tied for the lead").
function parseGamesBack(value) {
  if (value === '-') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// One teamRecord entry (per the MLB Stats API's own standings response
// shape) -> the signal shape public/lib/objective-score.mjs's
// computeMlbObjectiveScore expects. Exported and pure specifically so it's
// testable against a small hand-built fixture without needing a real,
// live API response (see this file's own top comment on why that's the
// only way this parsing can be verified in the environment it was written
// in).
export function parseMlbTeamRecord(teamRecord) {
  const lastTenSplit = (teamRecord?.records?.splitRecords || []).find(record => record.type === 'lastTen');
  return {
    gamesBack: parseGamesBack(teamRecord?.gamesBack),
    wildCardGamesBack: parseGamesBack(teamRecord?.wildCardGamesBack),
    lastTen:
      lastTenSplit && Number.isFinite(lastTenSplit.wins) && Number.isFinite(lastTenSplit.losses)
        ? { wins: lastTenSplit.wins, losses: lastTenSplit.losses }
        : null,
    streakCode: typeof teamRecord?.streak?.streakCode === 'string' ? teamRecord.streak.streakCode : null
  };
}

// The full standings payload -> Map<mlbStatsApiTeamId, signal>. Walks every
// division's teamRecords across every record group the response contains
// (the API returns one entry per division, not one flat list) - a
// malformed/missing `records` array anywhere just contributes nothing
// rather than throwing, so one bad division entry can't blank out every
// other team's real data.
export function parseMlbStandingsResponse(json) {
  const byTeamId = new Map();
  for (const group of json?.records || []) {
    for (const teamRecord of group?.teamRecords || []) {
      const teamId = teamRecord?.team?.id;
      if (typeof teamId !== 'number') continue;
      byTeamId.set(teamId, parseMlbTeamRecord(teamRecord));
    }
  }
  return byTeamId;
}

// Fetches this season's MLB standings once and returns them keyed by ESPN's
// own team displayName (the same string public/lib/match-builder.mjs already has
// on hand for every fixture, via buildCompetitor's `.name`) so callers
// never need to touch a numeric team id themselves. Called ONCE per build
// (not once per fixture - every MLB game that day shares the same league-
// wide standings snapshot), same "one call serves every fixture" shape as
// this repo's own oddsContext/context building already assumes for
// per-match data. Returns an EMPTY Map (never null, never throws) on any
// failure - every team simply reads back as "no standings signal", which
// computeMlbObjectiveScore already treats as a normal, harmless case (see
// its own comment).
export async function fetchMlbStandings(season, fetchJson) {
  const byName = new Map();
  try {
    const json = await fetchJson(mlbStandingsUrl(season));
    const byTeamId = parseMlbStandingsResponse(json);
    for (const [displayName, teamId] of Object.entries(MLB_STATS_API_TEAM_IDS)) {
      const signal = byTeamId.get(teamId);
      if (signal) byName.set(displayName, signal);
    }
  } catch (error) {
    console.warn(`MLB Stats API standings fetch failed (falling back to no standings signal): ${error.message}`);
  }
  return byName;
}

// ---- F1: the Ergast-compatible Jolpica API -------------------------------
//
// A modern F1 season's champion has usually been mathematically decided
// once the points gap between the top two drivers passes roughly this
// many points (a win is worth 25, so this is a bit over four clean race
// wins' worth of cushion with few enough rounds left that a comeback
// becomes very unlikely) - not an official number, a reasonable modeling
// choice for "the title race, specifically, isn't realistically alive
// anymore" that intensity should taper toward as the gap grows, not a
// precise cutoff.
export const F1_TITLE_RACE_DECIDED_GAP_POINTS = 100;

// The standings payload's own DriverStandings array (already sorted by
// position by the API) -> a 0 (decided) to 1 (a dead heat for the lead)
// title-race intensity, purely from the gap between the top two drivers'
// points. Returns null when there aren't at least two ranked drivers yet
// (e.g. before a season's first race).
export function computeTitleRaceIntensity(driverStandings) {
  if (!Array.isArray(driverStandings) || driverStandings.length < 2) return null;
  const [first, second] = driverStandings;
  const firstPoints = Number(first?.points);
  const secondPoints = Number(second?.points);
  if (!Number.isFinite(firstPoints) || !Number.isFinite(secondPoints)) return null;
  const gap = Math.max(0, firstPoints - secondPoints);
  return Math.max(0, Math.min(1, 1 - gap / F1_TITLE_RACE_DECIDED_GAP_POINTS));
}

// json -> the raw DriverStandings array (per the Ergast/Jolpica response
// shape: MRData.StandingsTable.StandingsLists[0].DriverStandings), or []
// if any expected level is missing - never throws on an unexpected shape.
export function parseF1DriverStandingsResponse(json) {
  const list = json?.MRData?.StandingsTable?.StandingsLists?.[0];
  return Array.isArray(list?.DriverStandings) ? list.DriverStandings : [];
}

// Fetches the CURRENT season's drivers' championship standings once per
// build (every F1 fixture in the window shares the same title-race
// intensity - it doesn't vary race to race until the standings themselves
// next update) and returns computeTitleRaceIntensity's own result, or null
// on any failure (network, non-OK response, or an empty/malformed
// standings list) - never throws.
export async function fetchF1TitleRaceIntensity(fetchJson) {
  try {
    const json = await fetchJson(f1DriverStandingsUrl());
    const driverStandings = parseF1DriverStandingsResponse(json);
    return computeTitleRaceIntensity(driverStandings);
  } catch (error) {
    console.warn(`F1 championship standings fetch failed (falling back to no title-race signal): ${error.message}`);
    return null;
  }
}
