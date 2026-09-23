// ---- public/lib/objective-score.mjs ----
// Deterministic, per-sport "objective" competitiveness/watchability/
// enduranceScore/broadcastQuality scoring, computed from real statistical
// signals (season record, recent form, standings proximity to a playoff
// spot, championship-race intensity, betting-market spread) rather than
// asked from Gemini's own training-data impression of two teams.
//
// This is the architectural inversion public/lib/match-builder.mjs's own
// top-of-file comment describes: these numbers are now the PRIMARY score,
// computed the same way every time from the same inputs, before Gemini
// ever sees the fixture. The shared proxy's `/match-recommend` is asked
// only to VALIDATE this score against its own real-world knowledge and
// return a small, bounded adjustment (see that repo's worker.js) - never
// to invent competitiveness/watchability from scratch the way it used to.
//
// Every function here is pure (no network, no Date.now(), no randomness) -
// public/lib/sport-signals.mjs owns fetching/parsing the real API data these
// functions consume, kept deliberately separate so the SCORING LOGIC is
// testable with plain hand-built numbers, independent of whatever a real
// API response happens to look like on a given day.
//
// A signal this module doesn't have (a standings fetch failed, an odds
// provider hasn't posted a line, a team is missing from a mapping table)
// is passed in as `null`/`undefined`, never a guessed default - every
// combining step below is built to renormalize around whichever inputs are
// actually present (see `weightedAverage`) rather than silently treating a
// missing signal as a specific value like "average" or "unknown-bad".

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Weighted average over a list of [value, weight] pairs where `value` may
// be null/undefined/NaN (a signal that wasn't available) - those pairs are
// dropped and the remaining weights are renormalized to sum to 1, so a
// fixture with only 1 of 3 possible signals still gets a real number built
// entirely from what IS known, rather than a null result or a value
// silently pulled toward zero by treating the missing signals as 0.
// Returns null only when EVERY pair is missing.
export function weightedAverage(pairs) {
  const present = pairs.filter(([value]) => Number.isFinite(value));
  if (!present.length) return null;
  const totalWeight = present.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight <= 0) return null;
  return present.reduce((sum, [value, weight]) => sum + value * (weight / totalWeight), 0);
}

// ---- Shared building blocks -------------------------------------------

// A win-percentage gap of 0 (dead-even records) scores a 10; a gap of 0.5+
// (one team has won essentially everything, the other essentially nothing)
// bottoms out at 1. 18 is chosen so a realistic "quite lopsided" gap of
// ~0.35-0.4 (e.g. a 100-win team against a 60-win team over a 162-game MLB
// season) already lands near the bottom of the scale, rather than needing
// a near-impossible 0.5 gap to get there.
export function closenessFromWinPctGap(gap) {
  if (!Number.isFinite(gap)) return null;
  return clamp(Math.round(10 - Math.abs(gap) * 18), 1, 10);
}

// A betting-market spread of 0 (a genuine pick'em) scores a 10; a spread at
// or beyond `lopsidedAt` (sport-specific - a run line vs. a point spread
// are completely different scales) bottoms out at 1. The market's own
// spread is a more current, more complete signal than a season record
// alone (it already prices in injuries, recent form, home/road splits,
// starting pitcher/starting lineup for that specific fixture), which is
// exactly why this gets its own weight alongside record-based closeness
// rather than replacing it outright - not every fixture has a posted line.
export function closenessFromSpread(absSpread, lopsidedAt) {
  if (!Number.isFinite(absSpread) || !Number.isFinite(lopsidedAt) || lopsidedAt <= 0) return null;
  return clamp(Math.round(10 - (Math.abs(absSpread) / lopsidedAt) * 9), 1, 10);
}

// A real prediction-market win-probability gap of 0 (a genuine 50/50, or a
// soccer market pricing a real chance of a draw with neither side a clear
// favorite) scores a 10; a gap at or beyond WINPROB_LOPSIDED_GAP_AT bottoms
// out at 1 - same shape as closenessFromSpread just above, but for
// Polymarket's own devigged win% (see public/lib/polymarket.mjs) instead of
// a sportsbook spread. A percentage-point gap is already sport-agnostic
// (unlike a spread's own units, which genuinely differ by sport - MLB run
// lines vs NBA point spreads is exactly why closenessFromSpread takes a
// per-sport `lopsidedAt`), so one shared threshold covers MLB/NBA/EPL alike
// here, never mixed with closenessFromSpread's own inputs for the same
// fixture - see this file's MLB/NBA/EPL sections for how the two are
// combined (whichever is actually available, never both at once).
//
// WINPROB_LOPSIDED_GAP_AT calibrated against real live Polymarket data, not
// guessed: 232 genuinely-liquid (liquidity >= POLYMARKET_MIN_LIQUIDITY_FOR_
// SCORING) pregame MLB moneylines fetched live 2026-09-23 had a gap
// distribution of min 0 / median 22 / p90 54 / p99 66 / max 73 percentage
// points - a single MLB game's own starting-pitcher-driven variance means
// even a clear favorite rarely prices past the mid-70s. 70 sits just above
// that real observed ceiling, so only a fixture at least as lopsided as the
// most lopsided genuinely-traded game actually seen bottoms out, rather
// than an arbitrary round number.
export const WINPROB_LOPSIDED_GAP_AT = 70;
export function closenessFromWinProb(awayPct, homePct) {
  if (!Number.isFinite(awayPct) || !Number.isFinite(homePct)) return null;
  const gap = Math.abs(awayPct - homePct);
  return clamp(Math.round(10 - (gap / WINPROB_LOPSIDED_GAP_AT) * 9), 1, 10);
}

// How close a team is to a real playoff spot right now - the smaller of
// its division-race and wild-card-race deficits (a team can clinch either
// way, so being close on EITHER axis keeps the race alive), turned into a
// 0-10 stakes contribution. 0 games back (leading or tied) scores a 10;
// 12.5+ games back (the race is decided in practice) bottoms out at 0 -
// unlike the closeness functions above, this is allowed to floor at 0, not
// 1, since a genuinely decided race really does contribute nothing to
// stakes, as opposed to "still contributes a LITTLE".
//
// `divisionLeadMargin` (division LEADERS only - see sport-signals.mjs's
// parseMlbStandingsResponse) is the real fix for a gap this function used
// to have: `gamesBack === 0` reads identically whether a team is tied for
// the lead or is 20+ games clear of the field, since a leader's own
// gamesBack is 0 either way by definition - it has no way to see the size
// of its OWN cushion. Live case this fixes (2026-09-26): a 96-60 Dodgers
// team, up 9 games on the Padres, blowing out the last-place Giants still
// scored a maxed-out stakes=10, identical to a genuine nail-biter. When a
// real margin is known, a comfortable leader is discounted the same
// 0.8-per-game way a team chasing from behind already is - a 10+ game
// division lead isn't realistically "a race" just because this team's own
// deficit reads zero. Never discounted below 2 - a leader still has real
// stakes (a magic number to reach, a division title/home-field edge to
// protect), just not a live race's full 10.
//
// `magicNumber` (also leaders only, see sport-signals.mjs's parseMagicNumber)
// is preferred over `divisionLeadMargin` whenever the API still has one to
// report (the leader hasn't clinched yet) - a REAL win-or-opponent-loss
// countdown to actually clinching, already accounting for how many games
// are even left to play, rather than today's lead margin alone, which
// can't tell "6 games up in June" (genuinely not urgent yet) apart from "6
// games up with a week left" (already a near-certain, imminent clinch).
// Live case validated against real reporting (2026-09-23): Cleveland
// Guardians @ Boston Red Sox, division lead margin only 1 (over a Chicago
// White Sox team a single game back - real, live AL Central race per
// contemporary coverage), magic number 5 - both read as genuinely tense,
// and score similarly high here (0.25/point - a gentler slope than
// divisionLeadMargin's own 0.8/point, chosen specifically so a magic
// number this small still lands close to what the ALREADY-tuned
// leadMargin reading gives an equally tense same-day race, rather than
// discounting it further just for being read a different way). A
// comfortable 6+ game leader with a SMALL magic number this late in the
// season (a real, imminent clinch) would score as only moderately
// discounted under lead-margin alone, when the countdown itself says the
// story is "could clinch any day now", not "a comfortable, unremarkable
// lead". Falls back to `divisionLeadMargin` once the leader has clinched
// (the API stops reporting a magic number at that point - see
// parseMagicNumber) - a clinched leader still has real, if lesser, stakes
// (seeding, a title to be crowned with, a personal/team milestone), same
// as before this existed.
export function playoffProximityScore(gamesBack, wildCardGamesBack, divisionLeadMargin, magicNumber) {
  const candidates = [gamesBack, wildCardGamesBack].filter(Number.isFinite);
  if (!candidates.length) return null;
  const proximity = Math.min(...candidates);
  if (proximity <= 0) {
    if (Number.isFinite(magicNumber)) return clamp(Math.round(10 - Math.max(0, magicNumber - 1) * 0.25), 2, 10);
    if (Number.isFinite(divisionLeadMargin) && divisionLeadMargin > 0) {
      return clamp(Math.round(10 - divisionLeadMargin * 0.8), 2, 10);
    }
  }
  return clamp(Math.round(10 - proximity * 0.8), 0, 10);
}

// The general form of playoffProximityScore's own discount above, for a
// sport where the relevant "race" is against a specific TABLE CUTOFF
// (a playoff seed line, a Champions League/relegation points line) rather
// than MLB's own division-leader/wild-card shape - see
// sport-signals.mjs's NBA/EPL standings parsers for where `gap` comes
// from. Symmetric around a gap of 0 (the tensest possible position - a
// team sitting exactly ON the cutoff line): scores fall away the same
// 0.8-per-unit way on EITHER side, so a team comfortably past a cutoff
// (a negative gap - see those parsers' own sign convention) is discounted
// exactly like a team hopelessly short of it, instead of every "ahead of
// the line" reading as an undifferentiated maximum the way a naive re-use
// of playoffProximityScore's own one-sided formula would. `unit` rescales
// `gap` into the same games-back-sized scale that slope assumes - NBA's
// own gap is already in games (1, matches sport-signals.mjs's
// seedCutoffGap), EPL's is in league POINTS (divide by ~3, a win's worth,
// to approximate an equivalent game count - soccer has no native
// "games back" unit the way a league with no draws does).
export function cutoffProximityScore(gap, unit = 1) {
  if (!Number.isFinite(gap) || !Number.isFinite(unit) || unit <= 0) return null;
  return clamp(Math.round(10 - Math.abs(gap / unit) * 0.8), 0, 10);
}

// A team's own recent streak as a momentum signal, centered on a neutral 5
// (streakCode is the "W3"/"L2"-style notation both the MLB Stats API and
// ESPN's own NBA standings endpoint use) - capped at an 8-game streak so
// one extreme outlier season-opening/closing streak doesn't dominate the
// whole matchup's watchability on its own.
export function streakMomentum(streakCode) {
  const match = /^([WL])(\d+)$/.exec(streakCode || '');
  if (!match) return null;
  const length = Math.min(Number(match[2]), 8);
  return match[1] === 'W' ? 5 + length * 0.5 : 5 - length * 0.5;
}

// Recent-form closeness between two teams' own last-10-games records -
// conceptually the same idea as closenessFromWinPctGap but over a much
// smaller, much more CURRENT sample, so it moves faster than a full-season
// record does. Returns null when either side's last-10 record isn't known
// OR either side has genuinely played 0 of its own last-10 games yet (a
// brand-new season/roster edge case) - same fix as
// computeMatchObjectiveScore's own awayWinPct/homeWinPct guard in
// build-data.mjs: `wins / Math.max(1, wins + losses)` used to silently
// turn "no games played" into a real, finite 0.000, which two 0-0 sides
// then read as a perfectly even recent-form matchup (maximum closeness)
// instead of "no signal at all".
export function closenessFromLastTen(awayLastTen, homeLastTen) {
  if (!awayLastTen || !homeLastTen) return null;
  const awayGames = awayLastTen.wins + awayLastTen.losses;
  const homeGames = homeLastTen.wins + homeLastTen.losses;
  if (awayGames <= 0 || homeGames <= 0) return null;
  const awayPct = awayLastTen.wins / awayGames;
  const homePct = homeLastTen.wins / homeGames;
  return closenessFromWinPctGap(Math.abs(awayPct - homePct));
}

// A plain, deterministic starting point for "how good is the viewing
// experience itself" (broadcastQuality) - a flagship national network or a
// well-known premium/exclusive streaming package starts higher than an
// unlisted or bare regional feed. This is deliberately coarse (a single
// flat tier per network, not a real production-quality dataset, which
// doesn't exist anywhere as structured data this build could fetch) - it
// exists so Gemini has a concrete NUMBER to validate/adjust against,
// instead of being asked to invent one from nothing the way this field
// used to be scored end to end.
export const FLAGSHIP_BROADCAST_NETWORKS = [
  'espn',
  'espn2',
  'abc',
  'fox',
  'fs1',
  'nbc',
  'tbs',
  'tnt',
  'nba tv',
  'mlb network',
  'apple tv',
  'peacock',
  'prime video'
];

export function estimateBroadcastQualityBaseline(broadcast) {
  const normalized = (broadcast || '').trim().toLowerCase();
  if (!normalized) return 5;
  return FLAGSHIP_BROADCAST_NETWORKS.includes(normalized) ? 7 : 5;
}

// How GOOD a team (or a pairing of teams) actually is, independent of how
// CLOSE tonight's particular pairing is - a genuinely distinct axis from
// `competitiveness` above, which only measures the GAP between two records
// and scores two elite 95-win teams identically to two last-place 95-loss
// teams as long as they're equally matched against each other. A viewer
// asking "is this worth watching" cares about both: a close game between
// two great teams (a real playoff-caliber matchup) and a close game between
// two also-rans are not the same recommendation, even though this repo's
// own `competitiveness` alone can't tell them apart. .500 (a perfectly
// average team) is the neutral midpoint (5); the scale is deliberately wide
// enough that a realistic elite team (~.600, a 97-win MLB pace) already
// lands near the top and a realistic also-ran (~.400) near the bottom,
// without needing a mathematically-rare .700+/.300- record to reach either
// end. Takes a single win%, deliberately agnostic about whose - NBA/EPL
// pass the two teams' average (see their own `skill` calls below);
// computeMlbObjectiveScore instead passes the BETTER team's own win% (see
// its own `skill` comment for why an average is the wrong choice there).
export function skillFromWinPct(winPct) {
  if (!Number.isFinite(winPct)) return null;
  return clamp(Math.round(5 + (winPct - 0.5) * 20), 1, 10);
}

// A run line beyond ~3 runs, or a point spread beyond ~15 points, is
// already a blowout by market consensus for that sport - see
// closenessFromSpread's own comment for why this varies by sport rather
// than being one shared constant.
export const MLB_SPREAD_LOPSIDED_AT = 3;
export const MLB_STANDARD_RUN_LINE = 1.5;
export const NBA_SPREAD_LOPSIDED_AT = 15;

// ---- "Fame" is its own, unblended axis now ---------------------------------
//
// Direct instruction, replacing the whole model this section used to patch:
// "best match" should read the way a TV producer would - what would the
// most people actually tune into - not "which game is the tensest
// nail-biter". A close game between two irrelevant teams isn't what
// mainstream media consider must-watch; a blowout between two star teams
// often draws more. That reprioritization is what makes this whole former
// section (a competitiveness-gated marquee-credit fraction, a hard-then-
// softened watchability-over-competitiveness ceiling, three different
// per-sport excess-damping constants) unnecessary: all of it existed only
// to stop a famous name from dragging a decided game's rating too far above
// how close tonight's score is - which only mattered because closeness used
// to be the dominant signal watchability was blended into and implicitly
// measured against. Closeness (`competitiveness`) is now just one minor
// factor in the final ranking (see recommendation.mjs's BEST_MATCH_WEIGHTS),
// not the yardstick fame has to be protected from overriding - so fame
// (each sport's own `watchability` below) is free to be exactly what it
// sounds like: a clean, unblended read of "is this a mainstream draw", from
// real team-identity signals (a historic rivalry, a big-market/marquee
// franchise, national broadcast placement), never blended with skill/
// stakes/momentum and never gated by or capped against competitiveness.
//
// "How much this actually matters" (`stakes` - playoff-race/championship
// proximity) is the other axis fame used to be blended together with, and
// is now its own returned field too (see each sport's own function below) -
// it was always computed, just discarded into watchability's old blend
// instead of exposed on its own.

// ---- MLB ----------------------------------------------------------------
//
// `away`/`home` are each either null (no MLB Stats API standings entry
// found for this team - see sport-signals.mjs's own comment on why that's
// a normal, harmless outcome, not an error) or
// `{ gamesBack, wildCardGamesBack, lastTen: {wins, losses} | null, streakCode }`.
export function computeMlbObjectiveScore({
  awayWinPct,
  homeWinPct,
  away,
  home,
  isPostseason,
  isRivalry,
  isBigClub,
  isNationalBroadcast,
  oddsSpread,
  oddsOverUnder,
  marketWinPctAway,
  marketWinPctHome
}) {
  const factors = [];
  const seasonCloseness = closenessFromWinPctGap(
    Number.isFinite(awayWinPct) && Number.isFinite(homeWinPct) ? awayWinPct - homeWinPct : null
  );
  if (Number.isFinite(seasonCloseness)) {
    factors.push(`season win% gap ${(Math.abs(awayWinPct - homeWinPct) * 100).toFixed(1)}pp`);
  }

  const recentCloseness = closenessFromLastTen(away?.lastTen, home?.lastTen);
  if (Number.isFinite(recentCloseness) && away?.lastTen && home?.lastTen) {
    factors.push(`last 10: ${away.lastTen.wins}-${away.lastTen.losses} vs ${home.lastTen.wins}-${home.lastTen.losses}`);
  }

  // The standard ±1.5 run line is what nearly every MLB game is posted at,
  // favorite or not (the real price lives in the moneyline), so it says
  // nothing about THIS matchup - blending it in only dragged every game
  // whose line happened to be posted toward the same constant (a 6), which
  // made a game's score drop by up to a point the day its line appeared
  // and reshuffled a plan the viewer had already seen the day before. Only
  // a non-standard run line is treated as a real signal.
  const isStandardRunLine = Number.isFinite(oddsSpread) && Math.abs(oddsSpread) === MLB_STANDARD_RUN_LINE;
  const oddsCloseness = isStandardRunLine ? null : closenessFromSpread(oddsSpread, MLB_SPREAD_LOPSIDED_AT);
  // Polymarket's own devigged moneyline win% (see match-builder.mjs's
  // enrichWithPolymarketOdds - already gated there to only ever arrive here
  // once the market clears POLYMARKET_MIN_LIQUIDITY_FOR_SCORING, never a
  // thin/untraded stub) replaces the run-line signal above rather than
  // stacking with it: both measure the exact same thing (how lopsided this
  // specific fixture is expected to be), and a real moneyline needs no
  // spread-to-closeness heuristic the run line does, so it wins whenever
  // it's actually available. The run line survives purely as the fallback
  // for the (common, given real Polymarket liquidity data) case of a
  // fixture more than ~1.5 days out, before the market has real depth.
  const marketCloseness = closenessFromWinProb(marketWinPctAway, marketWinPctHome);
  const priceCloseness = marketCloseness ?? oddsCloseness;
  if (Number.isFinite(marketCloseness)) {
    factors.push(`market win% ${marketWinPctAway}/${marketWinPctHome}`);
  } else if (Number.isFinite(oddsCloseness)) {
    factors.push(`odds spread ${oddsSpread}`);
  }

  const competitiveness = clamp(
    Math.round(
      weightedAverage([
        [seasonCloseness, 0.45],
        [recentCloseness, 0.3],
        [priceCloseness, 0.25]
      ]) ?? 5
    ),
    1,
    10
  );

  const awayProximity = playoffProximityScore(away?.gamesBack, away?.wildCardGamesBack, away?.divisionLeadMargin, away?.magicNumber);
  const homeProximity = playoffProximityScore(home?.gamesBack, home?.wildCardGamesBack, home?.divisionLeadMargin, home?.magicNumber);
  const proximityInputs = [awayProximity, homeProximity].filter(Number.isFinite);
  let stakes = proximityInputs.length ? Math.max(...proximityInputs) : 5;
  if (proximityInputs.length) factors.push(`playoff proximity ${proximityInputs.join('/')}`);
  if (isPostseason) {
    stakes = 10;
    factors.push('postseason game');
  }

  const awayMomentum = streakMomentum(away?.streakCode);
  const homeMomentum = streakMomentum(home?.streakCode);
  const momentumInputs = [awayMomentum, homeMomentum].filter(Number.isFinite);
  const momentum = momentumInputs.length ? Math.max(...momentumInputs) : null;
  if (Number.isFinite(momentum)) factors.push(`streak ${away?.streakCode || ''}/${home?.streakCode || ''}`.trim());

  // How good the two teams actually are, independent of tonight's own
  // closeness - moved up from after watchability (where it used to sit as
  // a dead-end, separately-returned value nothing else here consumed) since
  // it's now a genuine INPUT to watchability below.
  //
  // MLB-only divergence from NBA/EPL's own skill below: this uses the
  // BETTER of the two teams' win%, not their average. Live-verified reason
  // (2026-09-21): an elite 96-60 Dodgers team (.615) against a rebuilding
  // 64-92 Giants team (.410) averages to .5125 - a `skill` of ~5, textbook
  // neutral, indistinguishable from two genuinely mediocre .500ish teams.
  // Averaging cancels out exactly the signal this exists to capture,
  // because a bad opponent always drags the average back toward neutral
  // regardless of how good the OTHER team is. A viewer's interest in
  // watching a great team play doesn't depend on the opponent also being
  // great - that's what `competitiveness` (the gap between them) already
  // measures separately - so skill here answers "is there a genuinely good
  // team in this matchup at all", which the max, not the average, answers.
  const bestTeamWinPct =
    Number.isFinite(awayWinPct) && Number.isFinite(homeWinPct) ? Math.max(awayWinPct, homeWinPct) : null;
  const skill = skillFromWinPct(bestTeamWinPct);
  if (Number.isFinite(skill)) factors.push(`best team win% ${(bestTeamWinPct * 100).toFixed(1)}%`);

  // Fame - a clean, unblended read of "is this a mainstream draw", from
  // real team-identity signals alone (never mixed with skill/stakes/
  // momentum, never gated by or capped against competitiveness - see this
  // section's own top comment for why that's no longer needed once
  // closeness is just a minor factor in the final ranking, not the
  // yardstick this has to be protected from overriding). Neutral baseline
  // 5, same convention every other axis in this module uses; a historic
  // rivalry and a big-market/marquee franchise each add their own full,
  // undiscounted lift and stack when a fixture is genuinely both (a
  // Yankees @ Red Sox game is both a rivalry AND two marquee franchises,
  // and draws more than either fact alone would). `isBigClub` (see
  // sport-duration.mjs's MLB_BIG_CLUBS) is EPL's own isBigClub brought to
  // MLB - direct instruction: "we prioritize star/team power".
  let watchability = 5;
  if (isRivalry) {
    watchability += 2;
    factors.push('known historic rivalry matchup');
  }
  if (isBigClub) {
    watchability += 2;
    factors.push('known marquee-franchise fixture');
  }
  // ESPN (or another flagship partner) choosing to air THIS specific game
  // nationally is itself a real producer signal, not something this module
  // has to infer from team identity/stakes alone - same axis NBA's own
  // watchability already had, MLB's never did until this real gap was
  // caught live (see sport-duration.mjs's own MLB_NATIONAL_BROADCAST_NETWORKS
  // comment for the live case). A flat, undiscounted +1, same increment
  // NBA's own isNationalBroadcast uses - stacks with rivalry/big-club
  // exactly like every other fame factor in this section does.
  if (isNationalBroadcast) {
    watchability += 1;
    factors.push('national broadcast');
  }
  watchability = clamp(watchability, 1, 10);

  const enduranceScore = clamp(
    Math.round(weightedAverage([[competitiveness, 0.6], [recentCloseness, 0.4]]) ?? competitiveness),
    1,
    10
  );

  return { competitiveness, watchability, stakes, enduranceScore, skill, factors };
}

// ---- NBA ------------------------------------------------------------------
//
// `away`/`home` are each either null (no ESPN standings entry found for
// this team - a brand-new season, or the fetch itself failed - see
// sport-signals.mjs's own comment on why that's a normal, harmless
// outcome) or `{ sixSeedGap, tenSeedGap, lastTen: {wins,losses}|null,
// streakCode }` from parseNbaStandingsResponse - the same depth MLB's own
// standings integration already has (playoff-cutoff proximity, last-10
// closeness, streak momentum), now real for NBA too rather than a flat
// season-record-and-odds-only stand-in.
//
// `closestCutoffGap` picks whichever of a team's own two seed gaps (the
// direct-playoff line, the play-in line) is CLOSER to zero - the cutoff
// that's actually live for that team right now, the same "either race
// keeps it alive" reasoning MLB's own division/wild-card pair already
// uses.
function closestCutoffGap(...gaps) {
  const candidates = gaps.filter(Number.isFinite);
  if (!candidates.length) return null;
  return candidates.reduce((best, gap) => (best == null || Math.abs(gap) < Math.abs(best) ? gap : best), null);
}

export function computeNbaObjectiveScore({
  awayWinPct,
  homeWinPct,
  away,
  home,
  isPostseason,
  isRivalry,
  isNationalBroadcast,
  oddsSpread,
  oddsOverUnder,
  marketWinPctAway,
  marketWinPctHome
}) {
  const factors = [];
  const seasonCloseness = closenessFromWinPctGap(
    Number.isFinite(awayWinPct) && Number.isFinite(homeWinPct) ? awayWinPct - homeWinPct : null
  );
  if (Number.isFinite(seasonCloseness)) {
    factors.push(`season win% gap ${(Math.abs(awayWinPct - homeWinPct) * 100).toFixed(1)}pp`);
  }

  const recentCloseness = closenessFromLastTen(away?.lastTen, home?.lastTen);
  if (Number.isFinite(recentCloseness) && away?.lastTen && home?.lastTen) {
    factors.push(`last 10: ${away.lastTen.wins}-${away.lastTen.losses} vs ${home.lastTen.wins}-${home.lastTen.losses}`);
  }

  const oddsCloseness = closenessFromSpread(oddsSpread, NBA_SPREAD_LOPSIDED_AT);
  // Same replacement, not stacking, as MLB's own - see that function's own
  // comment on marketCloseness/priceCloseness for the full reasoning.
  const marketCloseness = closenessFromWinProb(marketWinPctAway, marketWinPctHome);
  const priceCloseness = marketCloseness ?? oddsCloseness;
  if (Number.isFinite(marketCloseness)) {
    factors.push(`market win% ${marketWinPctAway}/${marketWinPctHome}`);
  } else if (Number.isFinite(oddsCloseness)) {
    factors.push(`odds spread ${oddsSpread}`);
  }

  const competitiveness = clamp(
    Math.round(
      weightedAverage([
        [seasonCloseness, 0.45],
        [recentCloseness, 0.3],
        [priceCloseness, 0.25]
      ]) ?? 5
    ),
    1,
    10
  );

  const awayStakes = cutoffProximityScore(closestCutoffGap(away?.sixSeedGap, away?.tenSeedGap));
  const homeStakes = cutoffProximityScore(closestCutoffGap(home?.sixSeedGap, home?.tenSeedGap));
  const stakesInputs = [awayStakes, homeStakes].filter(Number.isFinite);
  let stakes = stakesInputs.length ? Math.max(...stakesInputs) : 5;
  if (stakesInputs.length) factors.push(`playoff-seed proximity ${stakesInputs.join('/')}`);
  if (isPostseason) {
    stakes = 10;
    factors.push('postseason game');
  }

  const awayMomentum = streakMomentum(away?.streakCode);
  const homeMomentum = streakMomentum(home?.streakCode);
  const momentumInputs = [awayMomentum, homeMomentum].filter(Number.isFinite);
  const momentum = momentumInputs.length ? Math.max(...momentumInputs) : null;
  if (Number.isFinite(momentum)) factors.push(`streak ${away?.streakCode || ''}/${home?.streakCode || ''}`.trim());

  // How good the two teams actually are - same MLB-review fix
  // (Round 29/30, see computeMlbObjectiveScore's own comment for the full
  // reasoning), applied here for the same underlying reason: a contender
  // resting starters or blowing out a tanking team averages back toward a
  // neutral skill reading exactly the way an elite-vs-bad MLB pairing does,
  // which would hide the one signal this axis exists to capture. Uses the
  // BETTER team's own win%, not the average of both.
  const bestTeamWinPct =
    Number.isFinite(awayWinPct) && Number.isFinite(homeWinPct) ? Math.max(awayWinPct, homeWinPct) : null;
  const skill = skillFromWinPct(bestTeamWinPct);
  if (Number.isFinite(skill)) factors.push(`best team win% ${(bestTeamWinPct * 100).toFixed(1)}%`);

  // Fame - same clean, unblended, unstacked-with-skill/stakes model as MLB's
  // own (see this file's own "Fame is its own, unblended axis" comment).
  // Neutral baseline 5; rivalry and national broadcast each add their own
  // full, undiscounted lift and stack when both apply.
  let watchability = 5;
  if (isRivalry) {
    watchability += 1.5;
    factors.push('known rivalry matchup');
  }
  if (isNationalBroadcast) {
    watchability += 1;
    factors.push('national broadcast');
  }
  watchability = clamp(watchability, 1, 10);

  const enduranceScore = clamp(
    Math.round(weightedAverage([[competitiveness, 0.6], [recentCloseness, 0.4]]) ?? competitiveness),
    1,
    10
  );

  return { competitiveness, watchability, stakes, enduranceScore, skill, factors };
}

// ---- Premier League ---------------------------------------------------
//
// `away`/`home` are each either null (no ESPN standings entry - a brand-
// new season, or the fetch failed) or `{ points, gamesPlayed,
// pointDifferential, championsLeagueGap, relegationGap }` from
// parseEplStandingsResponse - real table position now feeds a genuine
// STAKES dimension (Champions League qualification / relegation danger)
// EPL never had before, the same "how much does this actually matter"
// axis MLB's playoff proximity and NBA's seed proximity already give
// their own sports. `EPL_STAKES_UNIT_POINTS` (3, a win's worth) rescales
// a raw POINTS gap into the same games-back-sized unit
// cutoffProximityScore's own slope assumes - soccer has no native "games
// back" the way a league without draws does.
//
// Still no recent-form signal, unlike MLB/NBA above - ESPN's EPL
// standings response has no per-team streak/last-5 figure at all (checked
// against a real live response), only points/goal-difference/rank. A
// genuine gap, not silently pretended away.
export const EPL_STAKES_UNIT_POINTS = 3;

export function computeEplObjectiveScore({
  awayWinPct,
  homeWinPct,
  away,
  home,
  isDerby,
  isBigClub,
  isNationalBroadcast,
  oddsSpread,
  oddsOverUnder,
  marketWinPctAway,
  marketWinPctHome
}) {
  const factors = [];
  const seasonCloseness = closenessFromWinPctGap(
    Number.isFinite(awayWinPct) && Number.isFinite(homeWinPct) ? awayWinPct - homeWinPct : null
  );
  if (Number.isFinite(seasonCloseness)) {
    factors.push(`season points-rate gap ${(Math.abs(awayWinPct - homeWinPct) * 100).toFixed(1)}pp`);
  }
  const oddsCloseness = closenessFromSpread(oddsSpread, NBA_SPREAD_LOPSIDED_AT);
  // Same replacement, not stacking, as MLB's own - see computeMlbObjectiveScore's
  // own comment on marketCloseness/priceCloseness. Worth more here than for
  // MLB/NBA (ESPN essentially never posts a real spread for EPL at all - see
  // match-builder.mjs's oddsContext comment - so this is usually the ONLY
  // market-based closeness signal EPL ever gets, not a liquidity-gated
  // upgrade over an already-present one). `closenessFromWinProb` reads
  // straight off market.oddsMarketWinPctAway/Home regardless of a real draw
  // chance already being priced in - a market pricing a likely draw already
  // has away/home probabilities close together, so it naturally scores as
  // "close" without EPL needing its own three-way variant of this function.
  const marketCloseness = closenessFromWinProb(marketWinPctAway, marketWinPctHome);
  const priceCloseness = marketCloseness ?? oddsCloseness;
  if (Number.isFinite(marketCloseness)) {
    factors.push(`market win% ${marketWinPctAway}/${marketWinPctHome}`);
  } else if (Number.isFinite(oddsCloseness)) {
    factors.push(`odds spread ${oddsSpread}`);
  }

  const competitiveness = clamp(
    Math.round(weightedAverage([[seasonCloseness, 0.7], [priceCloseness, 0.3]]) ?? 5),
    1,
    10
  );

  const awayStakes = cutoffProximityScore(
    closestCutoffGap(away?.championsLeagueGap, away?.relegationGap),
    EPL_STAKES_UNIT_POINTS
  );
  const homeStakes = cutoffProximityScore(
    closestCutoffGap(home?.championsLeagueGap, home?.relegationGap),
    EPL_STAKES_UNIT_POINTS
  );
  const stakesInputs = [awayStakes, homeStakes].filter(Number.isFinite);
  const stakes = stakesInputs.length ? Math.max(...stakesInputs) : null;
  if (stakesInputs.length) factors.push(`table-position proximity ${stakesInputs.join('/')}`);

  // How good the two teams actually are - same fix as MLB/NBA above, and
  // for the same reason: a genuinely elite club (Manchester City) grinding
  // out a currently-lopsided result against a struggling newly-promoted
  // side would average back toward a neutral skill reading, hiding exactly
  // the "there's a genuinely great team out there tonight" signal this
  // exists to capture - and unlike `isBigClub` (a fixed, hand-maintained
  // list, see sport-duration.mjs's EPL_BIG_CLUBS), this is a continuous,
  // table-driven signal that also catches a genuinely in-form club that
  // simply isn't on that list yet.
  const bestTeamWinPct =
    Number.isFinite(awayWinPct) && Number.isFinite(homeWinPct) ? Math.max(awayWinPct, homeWinPct) : null;
  const skill = skillFromWinPct(bestTeamWinPct);
  if (Number.isFinite(skill)) factors.push(`best team points-rate ${(bestTeamWinPct * 100).toFixed(1)}%`);

  // Fame - same clean, unblended, unstacked-with-skill/stakes model as
  // MLB/NBA's own (see this file's own "Fame is its own, unblended axis"
  // comment). Neutral baseline 5; derby and big-club each add their own
  // full, undiscounted lift and stack when a fixture is genuinely both (a
  // Manchester United vs Liverpool fixture is both, and is a bigger draw
  // than either fact alone).
  let watchability = 5;
  if (isDerby) {
    watchability += 2;
    factors.push('known derby fixture');
  }
  if (isBigClub) {
    watchability += 2;
    factors.push('known big-club fixture');
  }
  // A real broadcaster's own editorial choice - see sport-duration.mjs's
  // own EPL_NATIONAL_BROADCAST_NETWORKS comment for exactly which real
  // signal this is (a standalone showcase kickoff slot the Premier
  // League/Sky Sports/TNT Sports themselves chose to single a fixture out
  // for, inherited by NBC's own flagship broadcast placement - never the
  // wider US cable/streaming tier, which live-checked evidence showed is
  // confounded by NBC's own domestic scheduling and doesn't reliably track
  // real magnitude the same clean way). Same +1 increment as MLB/NBA's own.
  if (isNationalBroadcast) {
    watchability += 1;
    factors.push('national broadcast');
  }
  watchability = clamp(watchability, 1, 10);

  const enduranceScore = clamp(Math.round(competitiveness), 1, 10);

  return { competitiveness, watchability, stakes, enduranceScore, skill, factors };
}

// ---- F1 -------------------------------------------------------------------
//
// F1 doesn't have two named competitors the way a team sport does, so
// "competitiveness" here means something different: how alive the
// CHAMPIONSHIP race is right now, from the real, current standings gap
// between the top two drivers (see sport-signals.mjs's fetchF1TitleRaceIntensity)
// - every race in a season with a live title fight is more watchable than
// the equivalent race in a season that's already been decided, independent
// of which circuit it's at. `titleRaceIntensity` is 0 (decided) to 1 (a
// dead heat) - null when the standings fetch failed or the season hasn't
// started, in which case this falls back to a neutral middle score rather
// than guessing.
export function computeF1ObjectiveScore({ titleRaceIntensity }) {
  const factors = [];
  const hasIntensity = Number.isFinite(titleRaceIntensity);
  if (hasIntensity) factors.push(`championship gap intensity ${(titleRaceIntensity * 100).toFixed(0)}%`);

  const competitiveness = clamp(Math.round(hasIntensity ? 3 + titleRaceIntensity * 7 : 5), 1, 10);
  const watchability = clamp(Math.round(hasIntensity ? 4 + titleRaceIntensity * 6 : 5), 1, 10);
  const enduranceScore = clamp(Math.round(hasIntensity ? 4 + titleRaceIntensity * 5 : 5), 1, 10);
  // No separate "does this matter for the championship" signal exists apart
  // from the title-race intensity that already drives competitiveness/
  // watchability above - a live title fight IS the stakes for F1, there's
  // no second axis to measure it on.
  const stakes = competitiveness;

  // No per-competitor "how good are they" signal exists for a single-driver
  // race the way a two-team win% average does - null, renormalized away by
  // bestMatchScore's own weightedBlend, same posture as every other missing
  // signal in this module rather than a guessed default.
  const skill = null;

  return { competitiveness, watchability, stakes, enduranceScore, skill, factors };
}
