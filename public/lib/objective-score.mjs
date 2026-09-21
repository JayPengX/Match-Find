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

// A team's own recent streak as a momentum signal, centered on a neutral 5
// (streakCode is the MLB Stats API's own "W3"/"L2"-style notation) - capped
// at an 8-game streak so one extreme outlier season-opening/closing streak
// doesn't dominate the whole matchup's watchability on its own.
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

// How GOOD the two teams actually are, independent of how CLOSE tonight's
// particular pairing is - a genuinely distinct axis from `competitiveness`
// above, which only measures the GAP between two records and scores two
// elite 95-win teams identically to two last-place 95-loss teams as long as
// they're equally matched against each other. A viewer asking "is this
// worth watching" cares about both: a close game between two great teams
// (a real playoff-caliber matchup) and a close game between two also-rans
// are not the same recommendation, even though this repo's own
// `competitiveness` alone can't tell them apart. .500 (a perfectly average
// team) is the neutral midpoint (5); the scale is deliberately wide enough
// that a realistic elite team (~.600, a 97-win MLB pace) already lands
// near the top and a realistic also-ran (~.400) near the bottom, without
// needing a mathematically-rare .700+/.300- record to reach either end.
export function skillFromWinPct(avgWinPct) {
  if (!Number.isFinite(avgWinPct)) return null;
  return clamp(Math.round(5 + (avgWinPct - 0.5) * 20), 1, 10);
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
// reads well on paper.
export const MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS = 3;

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

  // Additive, same reasoning as computeNbaObjectiveScore/computeEplObjectiveScore's
  // own rivalry/derby bonuses - a storied historic rivalry (Dodgers-Giants,
  // Yankees-Red Sox) should only ever ADD watchability over the same two
  // teams' non-rivalry competitiveness/stakes, never blend toward a fixed
  // anchor and pull an already-good number down. This is a real, concrete
  // gap the record-based formula alone can't see: two historically
  // significant franchises can be a genuinely bigger draw than their
  // current-season record alone suggests, which is exactly the kind of
  // real-world fact a deterministic win%/stakes formula has no way to
  // capture on its own - see docs/recommendation-engine-audit.md. Gated on
  // MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS (see that constant's own comment
  // for the real Dodgers/Giants blowout this guards against) - a historic
  // name is a reason to lift an otherwise-decent game, not a reason to
  // call a decided one a "must watch".
  let watchability = weightedAverage([
    [stakes, 0.45],
    [competitiveness, 0.35],
    [momentum, 0.2]
  ]) ?? 5;
  // 2, not NBA's 1.5 - matches EPL's own derby bonus.
  if (isRivalry && competitiveness >= MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS) {
    watchability += 2;
    factors.push('known historic rivalry matchup');
  }
  // See MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS's own comment - stakes
  // (from playoffProximityScore) can't tell a nail-biter division race
  // apart from a leader's own already-decided runaway, so this is the
  // backstop that keeps a stakes=10 reading on a lopsided pairing from
  // reaching a high watchability on its own.
  watchability = Math.min(watchability, competitiveness + MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS);
  watchability = clamp(Math.round(watchability), 1, 10);

  const enduranceScore = clamp(
    Math.round(weightedAverage([[competitiveness, 0.6], [recentCloseness, 0.4]]) ?? competitiveness),
    1,
    10
  );

  const skill = skillFromWinPct(
    Number.isFinite(awayWinPct) && Number.isFinite(homeWinPct) ? (awayWinPct + homeWinPct) / 2 : null
  );
  if (Number.isFinite(skill)) factors.push(`avg win% ${(((awayWinPct + homeWinPct) / 2) * 100).toFixed(1)}%`);

  return { competitiveness, watchability, enduranceScore, skill, factors };
}

// ---- NBA ------------------------------------------------------------------
//
// No dedicated standings API integration yet (see this repo's README,
// "Known limitations of the API-driven scoring engine") - competitiveness
// is season-record-and-odds based, same shape as MLB's own record/odds
// terms, just without the last-10/standings-proximity depth MLB gets from
// the MLB Stats API.
export function computeNbaObjectiveScore({
  awayWinPct,
  homeWinPct,
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
  const oddsCloseness = closenessFromSpread(oddsSpread, NBA_SPREAD_LOPSIDED_AT);
  if (Number.isFinite(oddsCloseness)) factors.push(`odds spread ${oddsSpread}`);

  const competitiveness = clamp(
    Math.round(weightedAverage([[seasonCloseness, 0.6], [oddsCloseness, 0.4]]) ?? 5),
    1,
    10
  );

  let stakes = 5;
  if (isPostseason) {
    stakes = 10;
    factors.push('postseason game');
  }
  // Rivalry/national-broadcast are additive bonuses, not blended-in values -
  // a blend can round-collide with (or even pull DOWN) an already-high base
  // score for two evenly-matched teams, which is backwards: a rivalry or a
  // national broadcast should only ever add watchability, never subtract
  // it, whatever the matchup's own competitiveness already is.
  let watchability = weightedAverage([[stakes, 0.5], [competitiveness, 0.5]]) ?? 5;
  // Not gated on competitiveness the way MLB's rivalry bonus is (see
  // MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS's own comment) - NBA has no
  // standings-based signal yet, so a low competitiveness here can still be
  // early-season noise a real rivalry/national broadcast should survive.
  // MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS right below is still the
  // backstop against a genuinely decided blowout.
  if (isRivalry) {
    watchability += 1.5;
    factors.push('known rivalry matchup');
  }
  if (isNationalBroadcast) {
    watchability += 1;
    factors.push('national broadcast');
  }
  // See MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS's own comment.
  watchability = Math.min(watchability, competitiveness + MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS);
  watchability = clamp(Math.round(watchability), 1, 10);

  const enduranceScore = clamp(Math.round(competitiveness), 1, 10);

  const skill = skillFromWinPct(
    Number.isFinite(awayWinPct) && Number.isFinite(homeWinPct) ? (awayWinPct + homeWinPct) / 2 : null
  );
  if (Number.isFinite(skill)) factors.push(`avg win% ${(((awayWinPct + homeWinPct) / 2) * 100).toFixed(1)}%`);

  return { competitiveness, watchability, enduranceScore, skill, factors };
}

// ---- Premier League ---------------------------------------------------
//
// Same "no dedicated standings API yet" posture as NBA above - table
// position/points-per-game would sharpen this further (see README's
// "Known limitations"), but season record + odds (when a provider has
// posted a line, which is rare for EPL via ESPN's API) + the derby flag
// this repo's own sport-duration.mjs already computes for the duration
// model is a real, deterministic starting point today.
export function computeEplObjectiveScore({ awayWinPct, homeWinPct, isDerby, isBigClub, oddsSpread, oddsOverUnder }) {
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
  // MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS's own comment) - EPL has no
  // standings-based signal yet, so a low competitiveness here is exactly
  // the early-season-noise case (Liverpool @ AFC Bournemouth) this bonus
  // was written to survive. MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS
  // right below is still the backstop against a genuinely decided blowout.
  let watchability = competitiveness;
  if (isDerby) {
    watchability += 2;
    factors.push('known derby fixture');
  }
  if (isBigClub) {
    watchability += 2;
    factors.push('known big-club fixture');
  }
  // See MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS's own comment - mostly a
  // no-op here (watchability starts AT competitiveness for EPL, unlike
  // MLB/NBA's separate stakes blend), but keeps a stacked derby+big-club
  // (up to +4) from lifting a genuinely lopsided fixture too far past its
  // own competitiveness either.
  watchability = Math.min(watchability, competitiveness + MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS);
  watchability = clamp(Math.round(watchability), 1, 10);

  const enduranceScore = clamp(Math.round(competitiveness), 1, 10);

  const skill = skillFromWinPct(
    Number.isFinite(awayWinPct) && Number.isFinite(homeWinPct) ? (awayWinPct + homeWinPct) / 2 : null
  );
  if (Number.isFinite(skill)) factors.push(`avg points-rate ${(((awayWinPct + homeWinPct) / 2) * 100).toFixed(1)}%`);

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
