// ---- public/lib/sport-duration.mjs ----
// Deterministic, per-fixture broadcast-length predictions for every sport
// this site covers - MLB, NBA, Premier League, and F1's race session.
//
// Why this exists: `durationMinutes` used to be one flat per-league
// constant (see public/lib/match-builder.mjs's old TEAM_LEAGUES table) - every
// MLB game got the exact same 190 minutes regardless of which two teams
// were actually playing, even though real per-team pace varies by roughly
// 20 minutes end to end (a Tampa Bay-Cleveland game runs meaningfully
// shorter than a Boston-New York one, as a matter of publicly documented
// average time-of-game). That flat number is what public/lib/
// recommendation.mjs's whole scheduling model (effectiveDurationMinutes,
// schedulingDurationMinutes, the overrun buffer) works FROM, so a more
// accurate per-fixture estimate makes every downstream scheduling decision
// - not just the on-card time range - more accurate too, for free.
//
// Every formula here is intentionally a plain, auditable arithmetic model
// over facts ESPN's own scoreboard API already gives this build for every
// fixture (team display names, venue, national broadcaster) - never a
// Gemini call. This is the deterministic, authoritative source for how
// long a broadcast is expected to run; Gemini is never asked to predict
// duration at all, and nothing here depends on it being reachable. This
// mirrors the same posture the shared proxy's own prompt already takes
// toward its scoring judgment ("a SIGNAL feeding computeDayPlan's
// deterministic scheduler, never the final decision by itself" - see this
// repo's README) - applied here to duration and (see build-data.mjs's own
// resolveWhereToWatchTw) to the Taiwan broadcast source as well, both of
// which are now fixed, explainable rules rather than a per-fixture AI
// guess.
//
// A team/venue/circuit this module doesn't recognize never throws or
// blocks a build - every lookup below falls back to a neutral default
// (an offset of 0, or a sport's own flat baseline), same "a missing entry
// just means less precision, never a crash" posture as team-names.mjs's
// own teamNameZh.

// ---- MLB --------------------------------------------------------------
//
// Real per-team pace varies by close to 20 minutes across the league (a
// team that works fast on the mound and puts the ball in play often vs.
// one that runs deep counts and makes a lot of pitching changes) - far
// too much spread for one flat league-wide average to represent well.
// Offsets are in minutes relative to the 164-minute two-team-average
// baseline below; keyed by each team's ESPN `team.displayName` exactly
// (the same field build-data.mjs already reads into `competitor.name`),
// not by ESPN's shorter `abbreviation` the way team-names.mjs's own table
// is keyed - full display names are what this table was authored against
// and read more naturally as a standalone reference table.
export const MLB_TEAM_PACE_OFFSET_MINUTES = {
  // Fast-pace tier
  'Tampa Bay Rays': -13,
  'Cleveland Guardians': -11,
  'Seattle Mariners': -10,
  'Milwaukee Brewers': -9,
  'Detroit Tigers': -9,
  'Kansas City Royals': -8,
  'Oakland Athletics': -8,
  'Minnesota Twins': -7,
  'Cincinnati Reds': -7,
  'Pittsburgh Pirates': -6,
  // Median-pace tier
  'St. Louis Cardinals': -5,
  'San Francisco Giants': -4,
  'Washington Nationals': -3,
  'Atlanta Braves': -2,
  'Chicago White Sox': -2,
  'Miami Marlins': -2,
  'Baltimore Orioles': -1,
  'Houston Astros': 0,
  'Philadelphia Phillies': 0,
  'Texas Rangers': 1,
  'Los Angeles Angels': 2,
  // Slow-pace tier
  'Toronto Blue Jays': 3,
  'San Diego Padres': 3,
  'Chicago Cubs': 3,
  'New York Mets': 4,
  'Los Angeles Dodgers': 4,
  'Colorado Rockies': 5, // + a separate, larger high-altitude venue modifier below - see MLB_COORS_FIELD_VENUE_MODIFIER_MINUTES
  'Arizona Diamondbacks': 5,
  'Boston Red Sox': 6,
  'New York Yankees': 6
};

// Two-team-average, 9-inning MLB broadcast length this table's offsets are
// relative to (2 hours 44 minutes) - matches this codebase's own prior
// documented figure for a standard 9-inning game's real playing time (see
// README's "Baseball (and other no-clock sports) get a real overrun
// buffer" section), used here as the neutral center of the whole offset
// table rather than a second, disconnected number.
export const MLB_BASE_DURATION_MINUTES = 164;
// A fixed per-game buffer for the 2026-season Automated Ball-Strike
// challenge review system - every game absorbs a small amount of extra
// real time for a review to resolve, independent of which two teams are
// playing.
export const MLB_ABS_CHALLENGE_SYSTEM_PADDING_MINUTES = 1;
// Coors Field's altitude has a well-documented effect on game length
// (thinner air carries the ball further, producing more extra-base hits,
// more runs, and more pitching changes than the exact same two teams would
// produce at sea level) - large enough, and specific enough to one venue,
// that it's modeled as its own additive term rather than folded into the
// Colorado Rockies' own home/away offset above (which only reflects the
// team's own pace, not their specific ballpark's physics).
export const MLB_COORS_FIELD_VENUE_MODIFIER_MINUTES = 10;

// True for exactly the one venue this module has a specific modifier for.
// A plain string-equality check (not a substring/case-insensitive match)
// on purpose - ESPN's own `competition.venue?.fullName` is a clean,
// consistently-formatted proper name for a fixed, known set of MLB parks,
// unlike F1's own circuit naming (see resolveF1CircuitKey below, which
// does need fuzzy matching against a much less consistent set of names).
export function isCoorsField(venueFullName) {
  return venueFullName === 'Coors Field';
}

// A real, pre-game-available signal this formula didn't use before: the
// betting market's own total-runs line (already fetched for every MLB
// fixture - see build-data.mjs's oddsContext/parseOddsSignal). More total
// runs means more baserunners, more pitching changes, more mound visits -
// all real, additional broadcast time a low-scoring pitchers' duel simply
// doesn't accumulate; fewer means the opposite. `MLB_LEAGUE_AVG_OVER_UNDER`
// is a plain, stable estimate of a typical MLB total (this league-wide
// average moves only slightly year to year, and this modifier is a soft,
// bounded nudge, not a value the exact number needs to be precise for).
// Bounded to +-MLB_ODDS_DURATION_MODIFIER_CAP_MINUTES since a market's total
// is one more real signal to weigh, not one that should dominate the
// team-pace-based estimate this already is.
export const MLB_LEAGUE_AVG_OVER_UNDER = 8.5;
export const MLB_ODDS_DURATION_MINUTES_PER_RUN = 2;
export const MLB_ODDS_DURATION_MODIFIER_CAP_MINUTES = 8;

export function mlbOddsDurationModifier(oddsOverUnder) {
  if (!Number.isFinite(oddsOverUnder)) return 0;
  const raw = (oddsOverUnder - MLB_LEAGUE_AVG_OVER_UNDER) * MLB_ODDS_DURATION_MINUTES_PER_RUN;
  return Math.max(-MLB_ODDS_DURATION_MODIFIER_CAP_MINUTES, Math.min(MLB_ODDS_DURATION_MODIFIER_CAP_MINUTES, raw));
}

// away/home team names are ESPN's own `team.displayName` (already what
// build-data.mjs's buildCompetitor stores as `competitor.name`) - an
// unrecognized team (a spring-training/exhibition opponent, or a rename
// this table hasn't caught up with yet) contributes an offset of 0 rather
// than skewing the estimate in either direction or failing the build.
// `oddsOverUnder` is optional (most fixtures have one via ESPN's own odds
// provider, but never guaranteed) - see mlbOddsDurationModifier's own
// comment; missing/non-numeric contributes 0, same "a missing signal is
// neutral, never guessed" posture as every other optional input here.
export function predictMlbDurationMinutes({ awayTeam, homeTeam, venue, oddsOverUnder }) {
  const awayOffset = MLB_TEAM_PACE_OFFSET_MINUTES[awayTeam] ?? 0;
  const homeOffset = MLB_TEAM_PACE_OFFSET_MINUTES[homeTeam] ?? 0;
  const teamPaceModifier = (awayOffset + homeOffset) / 2;
  const venueModifier = isCoorsField(venue) ? MLB_COORS_FIELD_VENUE_MODIFIER_MINUTES : 0;
  const oddsModifier = mlbOddsDurationModifier(oddsOverUnder);
  return Math.round(
    MLB_BASE_DURATION_MINUTES +
      teamPaceModifier +
      MLB_ABS_CHALLENGE_SYSTEM_PADDING_MINUTES +
      venueModifier +
      oddsModifier
  );
}

// ---- NBA ----------------------------------------------------------------
//
// baseline_minutes is the standard 2h20m broadcast window; overtime is
// folded in as its own EXPECTED-VALUE term (probability x real-time cost of
// one 5-minute OT period) rather than an all-or-nothing modifier, since
// whether a given game actually reaches overtime isn't knowable ahead of
// time the way "is this a nationally televised game" already is.
//
// "blowout_game" (from the original spec this module implements) is
// deliberately NOT applied here: it's only knowable from the final score
// margin, which doesn't exist yet at prediction time (this runs against
// ESPN's PRE-game scoreboard data, the same point in time every other
// prediction in this module runs at) - applying it would require guessing
// the outcome of the game whose length is being predicted. "rivalry" and
// "national broadcast" both stay because they're facts already true and
// knowable before tip-off.
export const NBA_BASELINE_MINUTES = 140;
export const NBA_OVERTIME_PROBABILITY = 0.063;
export const NBA_OVERTIME_REAL_MINUTES_PER_PERIOD = 18;
export const NBA_MODIFIERS = {
  rivalryOrCloseMatchup: 6,
  nationalTvBroadcast: 5
};

// ESPN's own `broadcasts[].names` for a nationally-carried NBA game - a
// game with no national deal simply airs on a regional network ESPN either
// omits or reports differently, which this treats as "not national" rather
// than trying to enumerate every regional network by name.
export const NBA_NATIONAL_BROADCAST_NETWORKS = ['ESPN', 'ESPN2', 'ABC', 'TNT', 'NBA TV', 'Prime Video', 'Peacock'];

export function isNationalBroadcast(broadcast, networks = NBA_NATIONAL_BROADCAST_NETWORKS) {
  return networks.some(network => network.toLowerCase() === (broadcast || '').trim().toLowerCase());
}

// A short, deliberately conservative list of enduring, widely-recognized
// NBA rivalries - the same "best-effort, missing is harmless" posture as
// team-names.mjs's own translation table (a real rivalry not on this list
// just doesn't get the modifier, it doesn't break anything). Unordered
// pairs - `isNbaRivalry` checks both directions.
export const NBA_RIVALRY_PAIRS = [
  ['Los Angeles Lakers', 'Boston Celtics'],
  ['Los Angeles Lakers', 'LA Clippers'],
  ['New York Knicks', 'Brooklyn Nets'],
  ['Chicago Bulls', 'Detroit Pistons'],
  ['Golden State Warriors', 'Cleveland Cavaliers'],
  ['Boston Celtics', 'Philadelphia 76ers']
];

export function isNbaRivalry(awayTeam, homeTeam, pairs = NBA_RIVALRY_PAIRS) {
  return pairs.some(
    ([a, b]) => (a === awayTeam && b === homeTeam) || (a === homeTeam && b === awayTeam)
  );
}

// A short, deliberately conservative list of MLB's own enduring, widely-
// recognized rivalries - same "best-effort, a miss just loses one small
// modifier, never breaks anything" posture as NBA_RIVALRY_PAIRS above.
// Exists because a pure win%/standings-based objective score has no way to
// know a matchup is a bigger draw than its current-season record alone
// suggests - two historically significant franchises (Dodgers-Giants, the
// oldest rivalry in MLB) drawing real, current, heavy media attention
// regardless of either team's record this particular season is exactly the
// kind of real-world fact this list captures deterministically, the same
// way NBA_RIVALRY_PAIRS/EPL_DERBY_PAIRS already do for their own sports.
export const MLB_RIVALRY_PAIRS = [
  ['Los Angeles Dodgers', 'San Francisco Giants'],
  ['New York Yankees', 'Boston Red Sox'],
  ['New York Yankees', 'New York Mets'],
  ['Chicago Cubs', 'St. Louis Cardinals'],
  ['Chicago Cubs', 'Chicago White Sox'],
  ['Los Angeles Angels', 'Los Angeles Dodgers'],
  ['Houston Astros', 'Texas Rangers'],
  ['Baltimore Orioles', 'Washington Nationals']
];

export function isMlbRivalry(awayTeam, homeTeam, pairs = MLB_RIVALRY_PAIRS) {
  return pairs.some(
    ([a, b]) => (a === awayTeam && b === homeTeam) || (a === homeTeam && b === awayTeam)
  );
}

// MLB's own counterpart to EPL_BIG_CLUBS below - a short, deliberately
// conservative list of the sport's biggest, most nationally-followed
// brands, a fact about EACH club on its own (either side alone qualifies -
// see isMlbBigClub), not about a specific pairing the way MLB_RIVALRY_PAIRS
// is. Direct instruction: "we prioritize star/team power" - a pure win%/
// standings-based objective score has no way to see that a marquee
// franchise draws real, national attention essentially independent of this
// particular season's record, the same gap MLB_RIVALRY_PAIRS already
// covers for a specific historic pairing but not for a big name against an
// otherwise-unremarkable opponent. Stacks additively with a genuine rivalry
// in computeMlbObjectiveScore (a Yankees @ Red Sox game is both) rather
// than competing with it, same as EPL's own derby+big-club stacking.
export const MLB_BIG_CLUBS = [
  'New York Yankees',
  'Los Angeles Dodgers',
  'Boston Red Sox',
  'Chicago Cubs',
  'San Francisco Giants',
  'St. Louis Cardinals',
  'Atlanta Braves',
  'New York Mets'
];

export function isMlbBigClub(awayTeam, homeTeam, bigClubs = MLB_BIG_CLUBS) {
  return bigClubs.includes(awayTeam) || bigClubs.includes(homeTeam);
}

export function predictNbaDurationMinutes({ awayTeam, homeTeam, broadcast }) {
  const expectedOvertimeMinutes = NBA_OVERTIME_PROBABILITY * NBA_OVERTIME_REAL_MINUTES_PER_PERIOD;
  let modifierTotal = 0;
  if (isNbaRivalry(awayTeam, homeTeam)) modifierTotal += NBA_MODIFIERS.rivalryOrCloseMatchup;
  if (isNationalBroadcast(broadcast)) modifierTotal += NBA_MODIFIERS.nationalTvBroadcast;
  return Math.round(NBA_BASELINE_MINUTES + expectedOvertimeMinutes + modifierTotal);
}

// ---- Premier League -------------------------------------------------------
//
// baseline_minutes already bakes in 90 minutes of play, a 15-minute half,
// and 8 minutes of default stoppage time - close/derby fixtures tend to
// draw more fouls, injuries, and disputed calls, which is what
// derbyHighFoulMatch models. "heavy_var_reliance_teams" (from the original
// spec) is deliberately NOT applied: unlike a derby (a fixed, knowable fact
// about which two clubs are playing), which teams draw unusually
// meticulous VAR review has no reliable, publicly documented per-team
// signal this build can read from ESPN's own fixture data - applying it
// would mean guessing rather than modeling a known fact, which is exactly
// what this module's whole design tries to avoid.
export const EPL_BASELINE_MINUTES = 113;
export const EPL_MIN_DURATION_MINUTES = 108;
export const EPL_MAX_DURATION_MINUTES = 125;
export const EPL_MODIFIERS = {
  derbyHighFoulMatch: 4
};

// A short list of England's own longest-running, most widely recognized
// derbies - same "best-effort, a miss just loses one small modifier, never
// breaks anything" posture as NBA_RIVALRY_PAIRS above. Keyed by ESPN's own
// soccer `team.displayName`.
export const EPL_DERBY_PAIRS = [
  ['Arsenal', 'Tottenham Hotspur'],
  ['Liverpool', 'Everton'],
  ['Manchester United', 'Manchester City'],
  ['Manchester United', 'Liverpool'],
  ['Chelsea', 'Arsenal'],
  ['Chelsea', 'Tottenham Hotspur'],
  ['West Ham United', 'Tottenham Hotspur']
];

export function isEplDerby(awayTeam, homeTeam, pairs = EPL_DERBY_PAIRS) {
  return pairs.some(
    ([a, b]) => (a === awayTeam && b === homeTeam) || (a === homeTeam && b === awayTeam)
  );
}

// The globally recognized "Big Six" - a real, stable, widely-used term in
// English football media (not something invented for this fix) for the six
// EPL clubs that draw outsized global broadcast/media attention essentially
// regardless of any one season's table position. Exists for the exact same
// reason MLB_RIVALRY_PAIRS/NBA_RIVALRY_PAIRS exist: a pure win%/standings-
// based objective score has no way to see this - live-verified case:
// Liverpool @ AFC Bournemouth (2026-09-20, early in a new EPL season) scored
// competitiveness=3/watchability=3/skill=1 purely from a small, noisy
// early-season sample (both teams' win% still swinging wildly game to
// game), even though a Liverpool fixture is a major global draw independent
// of that. Deliberately a plain per-club list, not a pairs list like the
// derby table above - unlike a derby (a fact about a SPECIFIC pairing),
// star power is a fact about EACH club on its own, so either side alone is
// enough to qualify (see isEplBigClub below), and it stacks additively with
// a genuine derby (Manchester United vs Liverpool is both) rather than
// competing with it.
export const EPL_BIG_CLUBS = [
  'Arsenal',
  'Chelsea',
  'Liverpool',
  'Manchester City',
  'Manchester United',
  'Tottenham Hotspur'
];

export function isEplBigClub(awayTeam, homeTeam, bigClubs = EPL_BIG_CLUBS) {
  return bigClubs.includes(awayTeam) || bigClubs.includes(homeTeam);
}

export function predictEplDurationMinutes({ awayTeam, homeTeam }) {
  const modifierTotal = isEplDerby(awayTeam, homeTeam) ? EPL_MODIFIERS.derbyHighFoulMatch : 0;
  const predicted = EPL_BASELINE_MINUTES + modifierTotal;
  return Math.max(EPL_MIN_DURATION_MINUTES, Math.min(EPL_MAX_DURATION_MINUTES, Math.round(predicted)));
}

// ---- F1 (race session only) ---------------------------------------------
//
// Only the main "Race" session gets a circuit-specific prediction -
// Qualifying/Sprint keep their own flat durations in build-data.mjs's
// F1_SESSION_TYPES, since there's no equivalent per-circuit baseline table
// for those shorter, more uniform sessions. "safety_car_deployment" and
// "rain_wet_track_modifier" (from the original spec) are deliberately NOT
// applied: neither is knowable before a race starts (a safety car is a
// during-race event, and reliable per-race-day precipitation data would
// mean pulling in a whole separate weather API this build has no key or
// established need for yet - see this repo's own README on how PROXY_URL
// is optional so the site still works without extra external dependencies;
// the same reasoning applies to not taking on a new one here for a
// modifier this build can't verify anyway). max_active_racing_minutes
// (120) is kept as a hard ceiling regardless - every baseline below is
// already under it, but a future circuit added with a higher baseline
// still can't silently exceed the regulatory cap.
export const F1_CIRCUIT_BASELINE_MINUTES = {
  // Fast circuits
  Monza: 75,
  'Red Bull Ring': 76,
  'Spa-Francorchamps': 80,
  Silverstone: 82,
  // Average circuits
  Suzuka: 90,
  Interlagos: 91,
  COTA: 93,
  Bahrain: 94,
  // Street/slow circuits
  'Las Vegas': 98,
  Jeddah: 100,
  'Marina Bay': 108,
  Monaco: 110
};
// Used when a race weekend's circuit isn't recognized below - the original
// spec's own fallback value for exactly this case.
export const F1_DEFAULT_CIRCUIT_BASELINE_MINUTES = 92;
export const F1_MAX_ACTIVE_RACING_MINUTES = 120;

// Matched by lowercase substring rather than an exact map: ESPN's own
// `event.circuit?.fullName` for F1 has been observed to vary in exactly
// how a circuit's full formal name is written (e.g. sponsor names change
// year to year), while the short, distinctive place-name substrings below
// are stable across those variations. Order doesn't matter - each pattern
// is specific enough to one circuit that no fixture should ever match two.
const F1_CIRCUIT_NAME_PATTERNS = [
  [/monza/i, 'Monza'],
  [/red bull ring|spielberg/i, 'Red Bull Ring'],
  [/spa/i, 'Spa-Francorchamps'],
  [/silverstone/i, 'Silverstone'],
  [/suzuka/i, 'Suzuka'],
  [/interlagos|jos[eé] carlos pace|s[aã]o paulo/i, 'Interlagos'],
  [/circuit of the americas|cota/i, 'COTA'],
  [/bahrain/i, 'Bahrain'],
  [/las vegas/i, 'Las Vegas'],
  [/jeddah/i, 'Jeddah'],
  [/marina bay|singapore/i, 'Marina Bay'],
  [/monaco/i, 'Monaco']
];

// Returns one of F1_CIRCUIT_BASELINE_MINUTES' own keys, or null when no
// pattern matches (predictF1RaceDurationMinutes falls back to the default
// baseline in that case) - never throws on an empty/missing venue name.
export function resolveF1CircuitKey(venueFullName) {
  const name = (venueFullName || '').trim();
  if (!name) return null;
  const match = F1_CIRCUIT_NAME_PATTERNS.find(([pattern]) => pattern.test(name));
  return match ? match[1] : null;
}

export function predictF1RaceDurationMinutes(venueFullName) {
  const circuitKey = resolveF1CircuitKey(venueFullName);
  const baseline = circuitKey
    ? F1_CIRCUIT_BASELINE_MINUTES[circuitKey]
    : F1_DEFAULT_CIRCUIT_BASELINE_MINUTES;
  return Math.min(baseline, F1_MAX_ACTIVE_RACING_MINUTES);
}
