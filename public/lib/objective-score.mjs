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
export function playoffProximityScore(gamesBack, wildCardGamesBack, divisionLeadMargin) {
  const candidates = [gamesBack, wildCardGamesBack].filter(Number.isFinite);
  if (!candidates.length) return null;
  const proximity = Math.min(...candidates);
  if (proximity <= 0 && Number.isFinite(divisionLeadMargin) && divisionLeadMargin > 0) {
    return clamp(Math.round(10 - divisionLeadMargin * 0.8), 2, 10);
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
export const NBA_SPREAD_LOPSIDED_AT = 15;

// ---- Guardrails against a famous name/decided race overriding a real blowout ----
//
// Live-verified failure this exists to fix (2026-09-26): the Dodgers
// (96-60, already clinched the NL West) hosting the Giants (64-92, 32
// games back) still scored a maxed-out watchability=10 and got recommended
// over a genuinely live, 1-game-back AL West race elsewhere that night -
// competitiveness alone correctly read this as a lopsided 5/10 game, but
// two OTHER signals independently overrode that: (1) the historic-rivalry
// bonus (isRivalry/isDerby/isBigClub below) applies from the two teams'
// NAMES alone, with no check on whether tonight's specific pairing is
// still actually close; (2) playoffProximityScore reads a division
// LEADER's own gamesBack as 0 - a perfect 10 "stakes" - identically
// whether that lead is a nail-biter or (as here) a 30+ game runaway, since
// it only ever sees this one team's own distance to a spot it already
// has, never the actual size of its cushion. Neither signal is wrong on
// its own terms (Dodgers/Giants really is a historic rivalry; the Dodgers
// really do have a 0-gamesBack division position) - the fix isn't to
// remove either one, it's to stop letting them, alone or combined, turn a
// pairing `competitiveness` has already identified as lopsided into a
// "must watch" rating neither the current standings nor tonight's actual
// game would earn on its own.
//
// MLB's own rivalry bonus only gets to fire when tonight's specific
// pairing is at least this close. MLB-only (not NBA/EPL's rivalry/derby/
// big-club/national-broadcast bonuses below) - MLB is the one sport this
// build has real, standings-based signals for late in a 162-game season,
// where a wide win% gap really does mean a decided mismatch, not sampling
// noise. NBA/EPL have no standings API integration yet (see this repo's
// README, "Known limitations") - an early-season win% gap there can still
// be a small, noisy sample a genuinely elite club will grow out of, which
// is exactly the real case (Liverpool @ AFC Bournemouth, an early-season
// noisy 0.2/0.6 split) Round 17's own big-club bonus was written to survive
// - gating those the same way MLB's is would silence a big-club/derby bonus
// for precisely the early-season games it exists to correct for.
export const MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS = 6;

// However high stakes/a marquee bonus independently read, neither is
// allowed to lift the final watchability more than this many points above
// tonight's own competitiveness - the one signal that actually looks at
// THIS pairing's real current form, not just a name or a division
// standing that may already be a foregone conclusion. A blowout stays
// capped near its own competitiveness whatever else about the two teams
// reads well on paper. Still used as-is by NBA/EPL below; MLB uses its own
// softer version instead (see MLB_WATCHABILITY_FULL_LIFT_ALLOWANCE) now
// that `skill` is a real weighted component of MLB watchability rather
// than an unused side value - see that constant's own comment for why.
export const MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS = 3;

// MLB-only replacement for the hard ceiling above. A flat `competitiveness
// + 3` wall means no combination of real stakes/skill/momentum/rivalry can
// ever lift a game past a fixed distance from tonight's own closeness -
// which is exactly backwards for a case like Dodgers vs Giants: a close
// game between two mediocre teams and a lopsided game between an elite,
// historic-rivalry team and a bad one are not equally "capped at the same
// distance above their own competitiveness", because the elite/rivalry
// game has real additional entertainment value the wall can't express.
// Below `MLB_WATCHABILITY_FULL_LIFT_ALLOWANCE` of excess (watchability
// pre-cap minus competitiveness), the blend passes through completely
// unchanged - identical to the old hard cap's own behavior for any excess
// under 3 (same numeric allowance, reused on purpose: this is meant to be
// a strict loosening of the old rule, not a wholesale re-tuning of the
// normal case). Only past that allowance does this diverge from the old
// wall: additional excess is damped by `MLB_WATCHABILITY_EXCESS_DAMPING`
// instead of being thrown away outright - diminishing returns rather than
// a hard stop, so a genuinely exceptional combination of skill/stakes/
// rivalry can still nudge watchability higher, just increasingly slowly,
// instead of a blowout-on-paper being flatly unable to ever beat
// competitiveness+3 no matter how good the two teams actually are.
export const MLB_WATCHABILITY_FULL_LIFT_ALLOWANCE = MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS;
export const MLB_WATCHABILITY_EXCESS_DAMPING = 0.4;

// NBA's own version of the same softening, same allowance (reused, same
// reasoning as MLB's own) but a more conservative damping - see
// computeNbaObjectiveScore's own comment on why NBA's is tighter than
// MLB's (rivalry + national broadcast can both stack on top of skill
// there, unlike MLB's single rivalry bonus).
export const NBA_WATCHABILITY_FULL_LIFT_ALLOWANCE = MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS;
export const NBA_WATCHABILITY_EXCESS_DAMPING = 0.3;

// EPL's own version - see computeEplObjectiveScore's own comment. Tightest
// damping of the three sports: EPL can stack TWO name-based bonuses
// (derby +2, big-club +2, up to +4 together) on top of skill, more than
// either MLB's single +2 rivalry bonus or NBA's +2.5 combined rivalry/
// national-broadcast bonus, so the excess this needs to keep in check
// starts from a larger base.
export const EPL_WATCHABILITY_FULL_LIFT_ALLOWANCE = MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS;
export const EPL_WATCHABILITY_EXCESS_DAMPING = 0.25;

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
  oddsSpread,
  oddsOverUnder
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

  const oddsCloseness = closenessFromSpread(oddsSpread, MLB_SPREAD_LOPSIDED_AT);
  if (Number.isFinite(oddsCloseness)) factors.push(`odds spread ${oddsSpread}`);

  const competitiveness = clamp(
    Math.round(
      weightedAverage([
        [seasonCloseness, 0.45],
        [recentCloseness, 0.3],
        [oddsCloseness, 0.25]
      ]) ?? 5
    ),
    1,
    10
  );

  const awayProximity = playoffProximityScore(away?.gamesBack, away?.wildCardGamesBack, away?.divisionLeadMargin);
  const homeProximity = playoffProximityScore(home?.gamesBack, home?.wildCardGamesBack, home?.divisionLeadMargin);
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

  // Game Quality = Stakes + Competitiveness + Team Skill + Momentum, blended
  // together rather than letting competitiveness alone gate everything else
  // via a hard post-hoc cap (see the excess-damping replacement below for
  // the other half of that same fix). `skill` now carries real weight
  // (0.25) instead of being computed and discarded - two elite teams
  // playing a currently-lopsided game (a 96-win Dodgers team against a
  // rebuilding Giants) get real credit for being genuinely good teams, the
  // same way two mediocre teams in an equally lopsided game don't, without
  // this having to become a special-cased "is this team famous" bonus the
  // way isRivalry already is. Weights sum to 1 when every signal is present
  // (stakes/competitiveness always are - see their own fallbacks above -
  // skill/momentum can be null and cleanly drop out of weightedAverage's
  // own renormalization).
  let watchability = weightedAverage([
    [stakes, 0.3],
    [competitiveness, 0.3],
    [skill, 0.25],
    [momentum, 0.15]
  ]) ?? 5;
  // 2, not NBA's 1.5 - matches EPL's own derby bonus.
  if (isRivalry && competitiveness >= MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS) {
    watchability += 2;
    factors.push('known historic rivalry matchup');
  }
  // Softer replacement for the old `Math.min(watchability, competitiveness +
  // MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS)` hard ceiling - see
  // MLB_WATCHABILITY_FULL_LIFT_ALLOWANCE's own comment for why. A real
  // blowout (low stakes, low skill, no rivalry) never builds up much excess
  // here in the first place - stakes/skill/competitiveness all correlate
  // when a game really is one-sided - so this mainly changes the case the
  // old flat wall got wrong: a large excess driven by genuine stakes/skill/
  // rivalry signal on a matchup that still looks lopsided on paper.
  const excess = watchability - competitiveness;
  if (excess > MLB_WATCHABILITY_FULL_LIFT_ALLOWANCE) {
    watchability =
      competitiveness +
      MLB_WATCHABILITY_FULL_LIFT_ALLOWANCE +
      (excess - MLB_WATCHABILITY_FULL_LIFT_ALLOWANCE) * MLB_WATCHABILITY_EXCESS_DAMPING;
  }
  watchability = clamp(Math.round(watchability), 1, 10);

  const enduranceScore = clamp(
    Math.round(weightedAverage([[competitiveness, 0.6], [recentCloseness, 0.4]]) ?? competitiveness),
    1,
    10
  );

  return { competitiveness, watchability, enduranceScore, skill, factors };
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
  oddsOverUnder
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
  if (Number.isFinite(oddsCloseness)) factors.push(`odds spread ${oddsSpread}`);

  const competitiveness = clamp(
    Math.round(
      weightedAverage([
        [seasonCloseness, 0.45],
        [recentCloseness, 0.3],
        [oddsCloseness, 0.25]
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

  // NBA-specific weighting (not MLB's) - stakes keeps the largest single
  // share (0.35, vs MLB's 0.3) since the play-in/playoff cutoff is a much
  // more binary, high-visibility stake than MLB's own wild-card race, and
  // skill gets a smaller share (0.2, vs MLB's 0.25) since NBA already has
  // its OWN two separate name/fame-driven signals below (rivalry,
  // national broadcast) that a continuous skill score would otherwise
  // partially duplicate.
  let watchability = weightedAverage([
    [stakes, 0.35],
    [competitiveness, 0.3],
    [skill, 0.2],
    [momentum, 0.15]
  ]) ?? 5;
  // Rivalry/national-broadcast are additive bonuses, not blended-in values -
  // a blend can round-collide with (or even pull DOWN) an already-high base
  // score for two evenly-matched teams, which is backwards: a rivalry or a
  // national broadcast should only ever add watchability, never subtract
  // it, whatever the matchup's own competitiveness already is. Not gated on
  // competitiveness the way MLB's rivalry bonus is (see
  // MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS's own comment) - a low
  // competitiveness here can still be early-season noise a real rivalry/
  // national broadcast should survive. The soft cap right below is still
  // the backstop against a genuinely decided blowout.
  if (isRivalry) {
    watchability += 1.5;
    factors.push('known rivalry matchup');
  }
  if (isNationalBroadcast) {
    watchability += 1;
    factors.push('national broadcast');
  }
  // Softer, NBA-specific replacement for the old flat
  // `Math.min(watchability, competitiveness + MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS)`
  // ceiling - same direction and same reasoning as MLB's own
  // MLB_WATCHABILITY_FULL_LIFT_ALLOWANCE/_EXCESS_DAMPING (a hard wall can't
  // tell "a famous name propping up a decided blowout" apart from "a
  // genuinely elite team in an otherwise-lopsided game", so a
  // now-real skill signal deserves a chance to move past it, just with
  // diminishing returns rather than unbounded credit). Kept MORE
  // conservative than MLB's own damping (0.3, vs MLB's 0.4): NBA can stack
  // rivalry (+1.5) AND national broadcast (+1) on top of skill, so a
  // gentler damping here keeps the same real protection against a
  // decided blowout getting rescued by name/broadcast alone that the old
  // hard cap provided, even with more bonuses able to stack into the
  // excess than MLB has.
  const excess = watchability - competitiveness;
  if (excess > NBA_WATCHABILITY_FULL_LIFT_ALLOWANCE) {
    watchability =
      competitiveness +
      NBA_WATCHABILITY_FULL_LIFT_ALLOWANCE +
      (excess - NBA_WATCHABILITY_FULL_LIFT_ALLOWANCE) * NBA_WATCHABILITY_EXCESS_DAMPING;
  }
  watchability = clamp(Math.round(watchability), 1, 10);

  const enduranceScore = clamp(
    Math.round(weightedAverage([[competitiveness, 0.6], [recentCloseness, 0.4]]) ?? competitiveness),
    1,
    10
  );

  return { competitiveness, watchability, enduranceScore, skill, factors };
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

export function computeEplObjectiveScore({ awayWinPct, homeWinPct, away, home, isDerby, isBigClub, oddsSpread, oddsOverUnder }) {
  const factors = [];
  const seasonCloseness = closenessFromWinPctGap(
    Number.isFinite(awayWinPct) && Number.isFinite(homeWinPct) ? awayWinPct - homeWinPct : null
  );
  if (Number.isFinite(seasonCloseness)) {
    factors.push(`season points-rate gap ${(Math.abs(awayWinPct - homeWinPct) * 100).toFixed(1)}pp`);
  }
  const oddsCloseness = closenessFromSpread(oddsSpread, NBA_SPREAD_LOPSIDED_AT);
  if (Number.isFinite(oddsCloseness)) factors.push(`odds spread ${oddsSpread}`);

  const competitiveness = clamp(
    Math.round(weightedAverage([[seasonCloseness, 0.7], [oddsCloseness, 0.3]]) ?? 5),
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

  // EPL-specific weighting - skill gets the largest share of the three
  // (0.3) of any sport in this module, because EPL has no recent-form/
  // momentum signal at all (see this function's own header comment) to
  // otherwise fill that weight budget, unlike MLB/NBA's four-way blend.
  let watchability = weightedAverage([
    [stakes, 0.4],
    [competitiveness, 0.3],
    [skill, 0.3]
  ]) ?? competitiveness;
  // Additive, same reasoning as computeNbaObjectiveScore's own rivalry/
  // national-broadcast bonuses - a derby/big-club fixture should only ever
  // ADD watchability over the same two teams' plain competitiveness, never
  // pull it down by blending toward a fixed anchor value. Both bonuses can
  // stack (a Manchester United vs Liverpool fixture is both a derby AND a
  // big-club matchup, and is a bigger draw than either fact alone) - see
  // sport-duration.mjs's EPL_BIG_CLUBS for why this exists: a genuinely
  // elite, globally-followed club's own real-world draw doesn't depend on
  // this particular season's (often early, noisy, small-sample) win% record
  // the way `competitiveness`/`skill` necessarily do.
  // Not gated on competitiveness the way MLB's rivalry bonus is (see
  // MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS's own comment) - a low
  // competitiveness here can still be the early-season-noise case
  // (Liverpool @ AFC Bournemouth) this bonus was written to survive. The
  // soft cap right below is still the backstop against a genuinely
  // decided blowout.
  if (isDerby) {
    watchability += 2;
    factors.push('known derby fixture');
  }
  if (isBigClub) {
    watchability += 2;
    factors.push('known big-club fixture');
  }
  // Softer, EPL-specific replacement for the old flat
  // `Math.min(watchability, competitiveness + MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS)`
  // ceiling - same direction as MLB/NBA's own softened caps (see
  // MLB_WATCHABILITY_FULL_LIFT_ALLOWANCE's own comment for the shared
  // rationale). Uses the TIGHTEST damping of the three sports
  // (EPL_WATCHABILITY_EXCESS_DAMPING = 0.25) - a stacked derby+big-club
  // bonus (up to +4) plus a now-real skill signal plus a maxed table-
  // stakes reading can accumulate more excess here than MLB's single
  // rivalry bonus or NBA's rivalry+broadcast pair ever can, so this needs
  // the strongest brake to keep a genuinely decided blowout from getting
  // too much lift out of name value alone.
  const excess = watchability - competitiveness;
  if (excess > EPL_WATCHABILITY_FULL_LIFT_ALLOWANCE) {
    watchability =
      competitiveness +
      EPL_WATCHABILITY_FULL_LIFT_ALLOWANCE +
      (excess - EPL_WATCHABILITY_FULL_LIFT_ALLOWANCE) * EPL_WATCHABILITY_EXCESS_DAMPING;
  }
  watchability = clamp(Math.round(watchability), 1, 10);

  const enduranceScore = clamp(Math.round(competitiveness), 1, 10);

  return { competitiveness, watchability, enduranceScore, skill, factors };
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

  // No per-competitor "how good are they" signal exists for a single-driver
  // race the way a two-team win% average does - null, renormalized away by
  // bestMatchScore's own weightedBlend, same posture as every other missing
  // signal in this module rather than a guessed default.
  const skill = null;

  return { competitiveness, watchability, enduranceScore, skill, factors };
}
