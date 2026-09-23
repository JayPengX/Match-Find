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

// The API's own `magicNumber` - real wins-or-opponent-losses left before a
// division leader clinches it outright, "-" once it already has (see
// `clinched` below). Unlike gamesBack/divisionLeadMargin (a snapshot of
// today's standings with no idea how many games are even left to play), a
// magic number already bakes the schedule in: it can't reach 0 before the
// leader has genuinely locked the race up, so a small one is real,
// verifiable, close-to-clinching drama - not just "comfortably ahead" -
// see playoffProximityScore's own comment for the live case this fixes.
// "E" (mathematically eliminated) never applies to a magic number itself,
// but the same defensive parse handles it the same way as any other
// non-numeric value: a genuinely absent signal, never a guessed 0.
function parseMagicNumber(value) {
  if (value == null || value === '-' || value === 'E') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
    const teamRecords = group?.teamRecords || [];
    // The division LEADER's own gamesBack is always 0 by definition (see
    // parseGamesBack's own comment) - that alone can't tell a real,
    // down-to-the-wire race apart from a 20+ game runaway. The runner-up's
    // OWN gamesBack IS that missing number (how far back the closest rival
    // actually is), so it doubles as the leader's own lead margin -
    // computed here, once per division, from data already in this same
    // response, no second fetch needed. See objective-score.mjs's
    // playoffProximityScore for why this exists: a live 2026-09-26 case
    // had a 96-60 division leader blowing out a last-place team still
    // score a maxed-out "stakes" reading, identical to a genuine
    // nail-biter, purely because its own gamesBack read 0 either way.
    const runnerUpGamesBack = teamRecords
      .map(r => parseGamesBack(r?.gamesBack))
      .filter(gb => Number.isFinite(gb) && gb > 0)
      .reduce((min, gb) => (min == null || gb < min ? gb : min), null);
    for (const teamRecord of teamRecords) {
      const teamId = teamRecord?.team?.id;
      if (typeof teamId !== 'number') continue;
      const signal = parseMlbTeamRecord(teamRecord);
      // Only meaningful for the leader itself (gamesBack === 0) - a team
      // that's already behind has its own real deficit in `gamesBack`
      // already, this field would just be noise for it.
      if (signal.gamesBack === 0) {
        signal.divisionLeadMargin = runnerUpGamesBack;
        // Same "leader only" scoping as divisionLeadMargin above - null
        // once the leader has already clinched (the API itself stops
        // counting down at that point, see parseMagicNumber), which is
        // exactly playoffProximityScore's own cue to fall back to
        // divisionLeadMargin instead.
        signal.magicNumber = parseMagicNumber(teamRecord?.magicNumber);
      }
      byTeamId.set(teamId, signal);
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

// A stat entry lookup by ESPN's own stable, lowercase `type` key (not the
// human-readable `name`, which can contain spaces/mixed case and reads as
// more fragile to match against) - shared by the NBA/EPL standings parsers
// below, both of which read the same `entry.stats` array shape ESPN's own
// /standings endpoint uses for every sport.
function findStat(stats, type) {
  return (stats || []).find(s => s?.type === type);
}

// ---- NBA: ESPN's own /standings endpoint ---------------------------------
//
// Unlike MLB above (a separate Stats API with its own team ids - see
// MLB_STATS_API_TEAM_IDS) and unlike EPL below, NBA's standings come from
// ESPN itself - the SAME host/team-naming convention
// public/lib/match-builder.mjs's own scoreboard fetch already uses, live-
// confirmed identical team `displayName` strings ("LA Clippers", not
// "Los Angeles Clippers") - so this needs no separate id-mapping table,
// keying straight off `team.displayName` the same way public/lib/espn.mjs's
// own extractors already do.
export function nbaStandingsUrl() {
  return 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings';
}

// The top 6 seeds in each conference get a direct playoff berth; 7-10 go
// to the play-in tournament; 11+ are out entirely. Both cutoffs matter -
// same "either race keeps it alive" reasoning as MLB's own division/wild-
// card pair - a bubble team fighting to avoid falling to 11th cares just
// as much as one fighting to climb into the top 6.
export const NBA_PLAYOFF_SEED_CUTOFF = 6;
export const NBA_PLAY_IN_SEED_CUTOFF = 10;

// A team's real distance to a specific seed cutoff, in the same "games
// back" unit MLB's own gamesBack already reports - the standard sports
// formula (half the gap between each side's own win-loss differential),
// computed here from wins/losses already in this same response, nothing
// ESPN doesn't already report. SIGNED, on purpose: positive means BEHIND
// that seed (still chasing it), negative means AHEAD of it (already
// holding a cushion over it) - see objective-score.mjs's
// cutoffProximityScore for why a signed gap, not just a distance, is what
// actually lets a comfortable leader get discounted the same real way a
// team with no realistic shot already is, instead of both reading as a
// flat, undifferentiated "in".
function seedCutoffGap(teamDiff, cutoffDiff) {
  return (cutoffDiff - teamDiff) / 2;
}

export function parseNbaStandingsResponse(json) {
  const byName = new Map();
  for (const conference of json?.children || []) {
    const entries = conference?.standings?.entries || [];
    const withDiff = entries
      .map(entry => {
        const wins = Number(findStat(entry?.stats, 'wins')?.value);
        const losses = Number(findStat(entry?.stats, 'losses')?.value);
        return { entry, diff: wins - losses, gamesPlayed: wins + losses };
      })
      .filter(e => Number.isFinite(e.diff));
    if (!withDiff.length) continue;
    // ESPN's own entry order should already be standings order, but this
    // sorts explicitly rather than trusting that - the cutoff computation
    // below only works against the ACTUAL 6th/10th-best record in this
    // conference, not whatever position ESPN happened to list 6th/10th.
    withDiff.sort((a, b) => b.diff - a.diff);
    // Before the season actually starts, every team is still 0-0 - every
    // team's own diff reads 0, which would otherwise compute a "razor-
    // tight, tied-for-the-cutoff" gap of exactly 0 for EVERY SINGLE team,
    // the same "0 games played is a real no-signal case, not a genuine
    // 0.000-average tie" gap match-builder.mjs's own computeMatchObjectiveScore
    // comment already documents for win% - live-checked case this guards
    // against: the 2026-27 preseason, every NBA team still 0-0, would
    // otherwise report a maxed-out "playoff race" for every exhibition
    // game on the schedule.
    const seasonStarted = withDiff.some(e => e.gamesPlayed > 0);
    const sixthDiff = seasonStarted ? withDiff[NBA_PLAYOFF_SEED_CUTOFF - 1]?.diff : null;
    const tenthDiff = seasonStarted ? withDiff[NBA_PLAY_IN_SEED_CUTOFF - 1]?.diff : null;
    for (const { entry, diff, gamesPlayed } of withDiff) {
      const displayName = entry?.team?.displayName;
      if (typeof displayName !== 'string') continue;
      const lastTenMatch = /^(\d+)-(\d+)$/.exec(findStat(entry.stats, 'lasttengames')?.displayValue || '');
      const streakDisplay = findStat(entry.stats, 'streak')?.displayValue;
      // This team's OWN gap is only real once IT has actually played a
      // game - even once the rest of the league has started, a team that
      // hasn't played yet has no real signal of its own to report either.
      const hasPlayed = gamesPlayed > 0;
      byName.set(displayName, {
        sixSeedGap: hasPlayed && Number.isFinite(sixthDiff) ? seedCutoffGap(diff, sixthDiff) : null,
        tenSeedGap: hasPlayed && Number.isFinite(tenthDiff) ? seedCutoffGap(diff, tenthDiff) : null,
        lastTen: lastTenMatch ? { wins: Number(lastTenMatch[1]), losses: Number(lastTenMatch[2]) } : null,
        // "-" is ESPN's own notation for no streak yet (season-opening
        // game) - same "never a guessed/defaulted value" posture as
        // parseGamesBack above.
        streakCode: typeof streakDisplay === 'string' && streakDisplay !== '-' ? streakDisplay : null
      });
    }
  }
  return byName;
}

// Same "fetch once per build, degrade to an empty Map on any failure"
// contract as fetchMlbStandings above.
export async function fetchNbaStandings(fetchJson) {
  try {
    return parseNbaStandingsResponse(await fetchJson(nbaStandingsUrl()));
  } catch (error) {
    console.warn(`NBA standings fetch failed (falling back to no standings signal): ${error.message}`);
    return new Map();
  }
}

// ---- EPL: ESPN's own /standings endpoint ---------------------------------
//
// Same host/naming convention as NBA above - no separate id-mapping table
// needed, keyed straight off `team.displayName`. Real, long-stable English
// top-flight rules, not something this build invented: the top 4
// finishers qualify for the Champions League, the bottom 3 (of 20) are
// relegated - both have been the format for many seasons and aren't
// expected to need updating season to season.
export const EPL_CHAMPIONS_LEAGUE_CUTOFF_RANK = 4;
export const EPL_RELEGATION_CUTOFF_RANK = 18; // 18th of 20 - the first team IN the drop zone

export function eplStandingsUrl() {
  return 'https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings';
}

// EPL has no per-team "streak"/"last 5" figure anywhere in this endpoint
// (checked against a real live response) - only points/goal difference/
// rank, so unlike MLB/NBA above this has no recent-form signal to offer;
// computeEplObjectiveScore's own comment covers what that means for its
// scoring (a real, stated limitation, not silently dropped). What this
// DOES give that a bare win/loss/draw record can't: real league POINTS
// (3 for a win, 1 for a draw) - what English football actually decides
// places by, not something derivable from parseOverallRecord's coarser
// W-L-D split alone.
export function parseEplStandingsResponse(json) {
  const byName = new Map();
  const entries = json?.children?.[0]?.standings?.entries || [];
  const withPoints = entries
    .map(entry => ({
      entry,
      points: Number(findStat(entry?.stats, 'points')?.value),
      gamesPlayed: Number(findStat(entry?.stats, 'gamesplayed')?.value)
    }))
    .filter(e => Number.isFinite(e.points));
  if (!withPoints.length) return byName;
  withPoints.sort((a, b) => b.points - a.points);
  // Same guard as parseNbaStandingsResponse's own `seasonStarted` - before
  // a ball's been kicked, every team is 0 points, which would otherwise
  // report a "razor-tight" gap of exactly 0 for all 20 teams rather than
  // the genuine no-signal case it actually is.
  const seasonStarted = withPoints.some(e => e.gamesPlayed > 0);
  const clPoints = seasonStarted ? withPoints[EPL_CHAMPIONS_LEAGUE_CUTOFF_RANK - 1]?.points : null;
  const relegationPoints = seasonStarted ? withPoints[EPL_RELEGATION_CUTOFF_RANK - 1]?.points : null;
  for (const { entry, points, gamesPlayed } of withPoints) {
    const displayName = entry?.team?.displayName;
    if (typeof displayName !== 'string') continue;
    const pointDifferential = Number(findStat(entry.stats, 'pointdifferential')?.value);
    // This team's OWN gap is only real once IT has actually played -
    // matches parseNbaStandingsResponse's own per-team `hasPlayed` guard.
    const hasPlayed = gamesPlayed > 0;
    byName.set(displayName, {
      points,
      gamesPlayed: Number.isFinite(gamesPlayed) ? gamesPlayed : null,
      pointDifferential: Number.isFinite(pointDifferential) ? pointDifferential : null,
      // A POINTS gap, not a games-back one (soccer has no equivalent unit -
      // objective-score.mjs's cutoffProximityScore converts this to a
      // comparable scale itself, see its own comment). Signed the same way
      // NBA's seed gaps are above: positive = behind the cutoff (still
      // chasing it), negative = ahead of it (already holding a cushion).
      championsLeagueGap: hasPlayed && Number.isFinite(clPoints) ? clPoints - points : null,
      relegationGap: hasPlayed && Number.isFinite(relegationPoints) ? relegationPoints - points : null
    });
  }
  return byName;
}

export async function fetchEplStandings(fetchJson) {
  try {
    return parseEplStandingsResponse(await fetchJson(eplStandingsUrl()));
  } catch (error) {
    console.warn(`EPL standings fetch failed (falling back to no standings signal): ${error.message}`);
    return new Map();
  }
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
