// ---- public/lib/recommendation.mjs ----
//
// The pure, viewer-relative-clock-aside, DOM-free half of "what's worth
// watching": turning a fixture's deterministic, real-data scores
// (competitiveness/watchability/broadcastQuality/enduranceScore - all
// decided once at build time, entirely from real sports-data APIs, see
// public/lib/objective-score.mjs - no AI involved anywhere in this pipeline
// as of docs/recommendation-engine-audit.md's Round 11) into a day's
// back-to-back viewing plan, plus the score/confidence bookkeeping that
// decision is built from.
//
// Extracted out of public/app.js (which still owns everything DOM/
// localStorage/render-related) so this logic can be:
//   - imported by public/lib/match-builder.mjs too (confidence is computed once,
//     at build time - see computeConfidence below), and
//   - unit-tested directly with Node's built-in test runner (see
//     tests/recommendation.test.mjs) without needing a DOM.
//
// Nothing in this file reads or writes localStorage, the network, or the
// DOM - every function here is a pure function of its arguments (aside from
// isQuietHours/effectiveInterval's own use of the current wall clock via
// `new Date`, which is inherent to "is this match on right now", not a
// hidden dependency on outside state).
//
// The viewing-plan pipeline (see docs/recommendation-engine-audit.md for
// the fuller writeup this follows) is deliberately one straight line:
//   raw objective scores -> effectiveScore (viewer preference) ->
//   planningScore (+ live-match excitement bonus) -> schedulingInterval
//   (duration uncertainty + transition buffer) -> computeDayPlan's
//   scheduler -> the day's picks -> conflict clusters (presentation only,
//   computed AFTER scheduling, never before it)
// No step secretly does another step's job: scoring never decides
// timing, and the scheduler never re-judges how good a match is.

// ---- Broadcast service registry -------------------------------------------
//
// `whereToWatchTw` (see build-data.mjs's resolveWhereToWatchTw - a
// hardcoded rule, not an AI guess) is free-form text, not a fixed enum -
// this registry is what turns that text back into a stable id, both for
// app.js's badge rendering and
// for the OWNED_SERVICE_SCORE_BONUS nudge below. See app.js's own (larger)
// comment on this same registry for the full reasoning; this module only
// needs the matching/scoring half of it, but keeps the full display data
// here too so there's exactly one source of truth for what services exist.
export const SERVICES = [
  {
    id: 'elta',
    pattern: /愛爾達|ELTA/i,
    label: '愛爾達體育台',
    badge: '達',
    color: '#ff7a3d',
    logo: 'https://play-lh.googleusercontent.com/vE0VONaUjXyEgpUv0efGHg2_GS_Kbmx3YKyWPWzmv8oX-BlTzDReK17V9GhuJ7e7MMmFWvrVyP08vn03Q_H3',
    logoBg: 'linear-gradient(155deg, #ff9457, #e8531a)'
  },
  {
    id: 'appletv',
    pattern: /Apple\s*TV/i,
    label: 'Apple TV',
    badge: 'TV',
    color: '#1d1d1f',
    logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/AppleTVLogo.svg',
    logoBg: 'linear-gradient(155deg, #3a3a3d, #0c0c0e)'
  },
  {
    id: 'netflix',
    pattern: /Netflix/i,
    label: 'Netflix',
    badge: 'N',
    color: '#e50914',
    logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/Netflix_icon.svg',
    logoBg: '#ffffff'
  }
];

export function resolveService(whereToWatchTw) {
  if (!whereToWatchTw) return null;
  return SERVICES.find(s => s.pattern.test(whereToWatchTw)) || null;
}

// ---- One unified recommendation system: "Best Matches" ---------------------
//
// There used to be a viewer-selectable "recommendation style" (entertainment
// vs competitive) picking which per-match score drove the recommended
// lineup. That's gone - one well-reasoned score, not two competing answers
// to the same question, and it's deliberately NOT anchored on any single
// dimension either: "best match" means the fixture that combines real
// SKILL (how good the two teams actually ARE, independent of tonight's
// pairing - see public/lib/objective-score.mjs's skillFromWinPct), genuine
// COMPETITIVENESS (how CLOSE tonight's specific pairing is - competitiveness
// - plus whether those stakes actually stay meaningful all the way through
// rather than just at kickoff - enduranceScore), and broad ENTERTAINMENT/
// public attention (watchability - itself the deterministic objective
// score's own national-broadcast/rivalry/derby detectors and betting-market
// signal, see public/lib/objective-score.mjs - plus broadcastQuality's
// production-quality signal) - never a match that only
// wins because it's exceptional on one of those axes while being mediocre
// on the others. A viewer explicitly asked for this distinction: two elite
// teams playing a close, well-covered game is a different (better)
// recommendation than two also-rans playing an equally close, equally
// under-the-radar one - competitiveness/watchability alone can't tell those
// apart, since neither depends on how GOOD the two teams actually are.
// `bestMatchScore` is a weighted blend of whichever of these five fields a
// match actually has (see BEST_MATCH_WEIGHTS), renormalized over just the
// present ones so a finished/never-scored match, or a sport with no skill
// signal at all (F1 - see objective-score.mjs's own comment), still gets a
// real number built from what IS known, same "renormalize over what's
// present" posture public/lib/objective-score.mjs's own weightedAverage uses.
// Falls back to the build-time composite `match.score` only when NONE of
// these dimensions are set at all (nothing left to blend).
// Round 39 (2026-09-22): `skill` raised from 0.2 to 0.35, `competitiveness`
// lowered from 0.2 to 0.05 (every other weight unchanged) - direct instruction
// after a real, live disagreement: the deterministic engine kept recommending
// Cleveland Guardians @ Boston Red Sox (skill 6, a tight, tense pairing) over
// Milwaukee Brewers @ Philadelphia Phillies (skill 8, a clearly better team,
// tonight's pairing less nail-biting) on 2026-09-23/24/25, and Round 33's own
// exhaustive grid search (still true, see that round's own entry) had already
// proven no such reweight can flip THAT case without also flipping the
// already-validated 9/26/27 pick (Chicago Cubs @ Boston Red Sox, skill 6,
// over Tampa Bay Rays @ Philadelphia Phillies, skill 7) the same way - same
// shape, a lower-skill-but-tenser team vs. a higher-skill-but-more-comfortable
// one. Put to the user directly with the real numbers rather than reweighted
// silently: their answer was explicit - "skill/quality should generally win,
// period," accepting that the 9/26/27 pick becomes Rays/Phillies too. This
// is that same trade-off, chosen deliberately, not stumbled into. Re-verified
// live (2026-09-22 build) across every currently-fetched MLB/NBA/EPL/F1
// fixture: exactly six flips, all MLB, all this exact class of case (9/23-25
// to Brewers/Phillips-alternatives, 9/26-28 to Rays/Phillies) - zero
// unintended reordering anywhere else.
export const BEST_MATCH_WEIGHTS = {
  skill: 0.35, // how good the two teams actually are
  competitiveness: 0.05, // how close tonight's specific pairing is
  watchability: 0.35, // entertainment value / mainstream public attention
  enduranceScore: 0.1, // does the competitive stakes actually last
  broadcastQuality: 0.15 // production quality of watching it
};

function weightedBlend(pairs) {
  const present = pairs.filter(([value]) => Number.isFinite(value));
  if (!present.length) return null;
  const totalWeight = present.reduce((sum, [, weight]) => sum + weight, 0);
  return present.reduce((sum, [value, weight]) => sum + value * (weight / totalWeight), 0);
}

export function bestMatchScore(match) {
  const blended = weightedBlend([
    [match.skill, BEST_MATCH_WEIGHTS.skill],
    [match.competitiveness, BEST_MATCH_WEIGHTS.competitiveness],
    [match.watchability, BEST_MATCH_WEIGHTS.watchability],
    [match.enduranceScore, BEST_MATCH_WEIGHTS.enduranceScore],
    [match.broadcastQuality, BEST_MATCH_WEIGHTS.broadcastQuality]
  ]);
  if (blended != null) return blended;
  return Number.isFinite(match.watchability) ? match.watchability : match.score;
}

// ---- Sport priority / owned-service nudges ---------------------------------

// Every rank step adds/subtracts one of these - small next to the 1-10
// score scale (being ranked a couple of spots higher does NOT let a
// mediocre match beat a genuinely great one), but large enough to reliably
// swing a close call between two roughly-comparable fixtures, which is the
// only case this is meant to affect. Deliberately additive, not a
// multiplier on the raw score - a viewer's sport preference is a
// tie-breaker, not something that should let a mediocre match in a
// favorite sport outrank a substantially better one elsewhere.
export const PRIORITY_SCORE_DELTA = 1;

// A small nudge (see resolveViewingPlan) toward a fixture shown on a
// service in myServiceIds - "optimize for the services you actually pay
// for" without turning this into a hard filter.
export const OWNED_SERVICE_SCORE_BONUS = 0.5;

// True when public/lib/objective-score.mjs already flagged this fixture as a
// real, independently-known draw (a derby, a "Big Six"-style globally
// followed club, or a historic rivalry) - see that module's own EPL/MLB/NBA
// comments for why this exists at all: a pure win%-based formula has no way
// to see that a famous club/rivalry pulls mainstream attention regardless of
// this particular season's record. Read straight off `objectiveFactors`
// (already shipped in matches.json, see build-data.mjs) rather than needing
// a brand new build-time field - every relevant factor string already has a
// stable, matchable substring.
const MARQUEE_FACTOR_SUBSTRINGS = ['derby fixture', 'big-club fixture', 'rivalry matchup'];
export function isMarqueeFixture(match) {
  return Array.isArray(match.objectiveFactors) && match.objectiveFactors.some(f => MARQUEE_FACTOR_SUBSTRINGS.some(s => f.includes(s)));
}

// Live-verified case this exists for (docs/recommendation-engine-audit.md
// Round 14): Liverpool @ AFC Bournemouth (2026-09-20) still lost its slot to
// Crystal Palace @ Leeds United even after isBigClub's own +2 watchability
// bump (see computeEplObjectiveScore) - that bump only ever reaches
// bestMatchScore diluted through watchability's own 0.35 weight (worth
// +0.7 to the final blend, nowhere near enough against a competitiveness gap
// this size). A real-world marquee draw isn't a small tiebreaker the way
// PRIORITY_SCORE_DELTA/OWNED_SERVICE_SCORE_BONUS are - it's applied here,
// UNDILUTED, directly on top of bestMatchScore, the same way those other two
// nudges already are, so it actually moves the number by its full stated
// value instead of losing 65% of itself in a weighted average. Deliberately
// flat (one flag, one bonus) rather than stacking multiple marquee factors -
// a derby between two big clubs is already unambiguously marquee; it
// doesn't need to out-bid a non-marquee fixture by more just for having two
// reasons instead of one.
export const MARQUEE_FIXTURE_SCORE_BONUS = 2;

// The full breakdown behind one match's effectiveScore - `baseScore` is the
// AI's own build-time composite (`match.score`, untouched by any viewer-
// relative nudge), `bestMatchScore` is that same match after the one
// unified Best Matches blend (see bestMatchScore above), and `adjustments`
// names every further nudge stacked on top of it, so a given effectiveScore
// is never just an opaque number - see docs/recommendation-engine-audit.md
// for why this exists. `effectiveScore` itself is exactly what app.js's
// resolveViewingPlan/computeDayPlan has always computed; this function only
// makes the arithmetic explicit and independently testable, it doesn't
// change it.
export function computeEffectiveScore(match, { priorityOrder = [], myServiceIds = new Set() } = {}) {
  const centerRank = (priorityOrder.length - 1) / 2;
  const rank = priorityOrder.indexOf(match.sport);
  const priorityNudge = rank === -1 ? 0 : (centerRank - rank) * PRIORITY_SCORE_DELTA;
  const service = resolveService(match.whereToWatchTw);
  const serviceNudge = service && myServiceIds.has(service.id) ? OWNED_SERVICE_SCORE_BONUS : 0;
  // `match.marqueeCredit` is a 0..1 fraction only MLB's own
  // computeMlbObjectiveScore sets (see marqueeCreditFraction's own comment
  // in objective-score.mjs) - undefined for NBA/EPL/F1 (and any older/mocked
  // match object), which defaults to full credit (1), exactly reproducing
  // this bonus's original unconditional behavior for those sports. Without
  // this, a graduated-but-nonzero internal rivalry credit (MLB only) would
  // still trip `isMarqueeFixture`'s own boolean detection and hand out the
  // FULL undiluted bonus regardless of how small that internal credit was -
  // scaling by the same fraction here keeps the two consistent instead of
  // re-introducing an all-or-nothing cliff at this layer.
  const marqueeCredit = Number.isFinite(match.marqueeCredit) ? Math.min(1, Math.max(0, match.marqueeCredit)) : 1;
  const marqueeNudge = isMarqueeFixture(match) ? MARQUEE_FIXTURE_SCORE_BONUS * marqueeCredit : 0;

  const baseScore = Number.isFinite(match.score) ? match.score : 0;
  const bestScore = bestMatchScore(match);
  // How much the unified Best-Match blend (skill + competition + entertainment,
  // see bestMatchScore/BEST_MATCH_WEIGHTS above) moved the number away from
  // watchability alone - lets an explanation say "the wider blend nudged
  // this up/down by X" instead of just "the score is Y", per docs/
  // recommendation-engine-audit.md's stated goal of never leaving an
  // adjustment implicit.
  const preBlendBase = Number.isFinite(match.watchability) ? match.watchability : match.score;
  const blendAdjustment = Number.isFinite(preBlendBase) ? bestScore - preBlendBase : 0;

  return {
    baseScore,
    bestMatchScore: bestScore,
    adjustments: {
      blend: Math.round(blendAdjustment * 1000) / 1000,
      priority: priorityNudge,
      service: serviceNudge,
      marquee: marqueeNudge
    },
    effectiveScore: bestScore + priorityNudge + serviceNudge + marqueeNudge
  };
}

// ---- Confidence -------------------------------------------------------------
//
// How much a match's score should actually be trusted - NOT a second
// opinion on whether the match itself is good, just on how solid the
// judgment behind it is. Used to key off `match.source` (was this
// particular fixture validated by Gemini, and if so how thoroughly) back
// when that varied per fixture depending on quota/throttling - see this
// file's own git history. Gemini validation is gone entirely now (see
// docs/recommendation-engine-audit.md's Round 11): every non-finished
// fixture gets the exact same deterministic, real-data objective score
// (public/lib/objective-score.mjs) computed the exact same way, so there is
// no longer a per-fixture "how was THIS one scored" question to answer -
// only "was a score computed for it at all" (a finished/never-scored
// fixture has none, hence null - "how confident is this score" is
// meaningless when there isn't one).
export const CONFIDENCE_OBJECTIVE = 0.7;

export function computeConfidence(match) {
  return Number.isFinite(match?.score) ? CONFIDENCE_OBJECTIVE : null;
}

// The single entry point docs/recommendation-engine-audit.md points to for
// "how was this number arrived at" - composes computeEffectiveScore (the
// score math) and computeConfidence (how much to trust it) into one
// structured result instead of either being computed ad hoc at a call site.
export function computeRecommendationScore(match, context = {}) {
  const breakdown = computeEffectiveScore(match, context);
  return {
    baseScore: breakdown.baseScore,
    adjustments: breakdown.adjustments,
    finalScore: breakdown.effectiveScore,
    confidence: computeConfidence(match),
    // Same numbers as baseScore/finalScore above, under the names
    // docs/recommendation-engine-audit.md's "score architecture" section
    // asks for so a caller doesn't have to know "baseScore" means "the
    // AI's objective judgment of the event itself" and "finalScore" means
    // "...after this viewer's own preferences" - eventScore never reflects
    // priorityOrder/myServiceIds, viewerScore always does.
    // There's deliberately no third `planningScore` here - that one also
    // needs the live-match excitement bonus (see applyLiveExcitementBonus
    // below), which a single match with no scheduling context has no way
    // to compute on its own.
    eventScore: breakdown.baseScore,
    viewerScore: breakdown.effectiveScore
  };
}

// ---- Overlap / duration helpers --------------------------------------------

export function matchInterval(match) {
  const start = Date.parse(match.startTimeUtc);
  return { start, end: start + match.durationMinutes * 60_000 };
}

export function computeOverlapRange(a, b) {
  const ai = matchInterval(a);
  const bi = matchInterval(b);
  const start = Math.max(ai.start, bi.start);
  const end = Math.min(ai.end, bi.end);
  return end > start ? { start, end } : null;
}

export function overlapMinutes(a, b) {
  const range = computeOverlapRange(a, b);
  return range ? (range.end - range.start) / 60_000 : 0;
}

// The bar for "these two matches genuinely can't be sequenced, you have to
// pick one" - a FRACTION of the SHORTER match's own duration, not a flat
// minute count: 45 shared minutes is nearly all of a 55-minute F1 sprint
// but barely a quarter of a 190-minute MLB game.
export const NEAR_TOTAL_OVERLAP_FRACTION = 0.75;
export function isNearTotalOverlap(a, b) {
  const overlapMins = overlapMinutes(a, b);
  if (overlapMins <= 0) return false;
  const shorter = Math.min(a.durationMinutes, b.durationMinutes);
  return shorter > 0 && overlapMins / shorter >= NEAR_TOTAL_OVERLAP_FRACTION;
}

// How much of a match's OWN nominal length actually gets reserved in the
// day's schedule - see enduranceScore's own comment (shared-proxy's
// worker.js buildMatchRecommendPrompt) for what it measures.
export const ENDURANCE_DURATION_FLOOR = 0.4;
export function effectiveDurationMinutes(match) {
  const endurance = Number.isFinite(match.enduranceScore) ? match.enduranceScore : 5;
  const factor = ENDURANCE_DURATION_FLOOR + (1 - ENDURANCE_DURATION_FLOOR) * (endurance / 10);
  return match.durationMinutes * factor;
}
export function effectiveInterval(match) {
  const start = Date.parse(match.startTimeUtc);
  return { start, end: start + effectiveDurationMinutes(match) * 60_000 };
}

// ---- Sport timing profiles (duration uncertainty + transition buffer) -----
//
// Not every sport's nominal durationMinutes (see build-data.mjs's
// TEAM_LEAGUES/F1_SESSION_TYPES) deserves the same confidence. Football and
// F1 run to a scheduled clock/session window; MLB has no clock at all - a
// tied game goes to extra innings, a rain delay adds an unplannable hour -
// so treating its 190-minute nominal estimate as exact was the direct
// cause of missed continuations into whatever came on right after (see
// docs/recommendation-engine-audit.md's bug #4/#8/#9): the scheduler saw
// "still running" long after the game plausibly already ended and refused
// to schedule anything into that time. `durationReliability` is a coarse,
// three-tier stand-in for the fuller {earliestLikelyEnd, latestLikelyEnd}
// model the audit describes - deliberately not that model itself, since a
// single confidence tier per sport is all this pipeline has real grounds
// to assert (same reasoning as computeConfidence's own comment above: no
// fabricated precision this codebase doesn't actually have evidence for).
export const SPORT_TIMING = {
  MLB: { durationReliability: 'low' },
  NBA: { durationReliability: 'medium' },
  'Premier League': { durationReliability: 'high' },
  F1: { durationReliability: 'high' }
};
const DEFAULT_SPORT_TIMING = { durationReliability: 'medium' };
export function resolveSportTiming(sport) {
  return SPORT_TIMING[sport] || DEFAULT_SPORT_TIMING;
}

// How much EXTRA time a low/medium-reliability sport's real clock duration
// needs, ON TOP of its already-endurance-adjusted viewing window, before
// it's safe to assume something else can start - a no-clock sport (MLB -
// extra innings, rain delays) is statistically more likely to run LONG
// than short in real time, never the other way around: per MLB's own
// officially published time-of-game figures (Elias Sports Bureau, via
// MLB.com's annual pace-of-play release), a standard 9-inning game already
// averages roughly 2h40m of playing time alone, and extra innings or a
// rain delay routinely add 30-60+ real minutes on top with no matching
// mechanism that ever finishes a game meaningfully EARLY the way a
// running-clock sport's own blowout garbage-time might. An earlier version
// of this constant (DURATION_UNCERTAINTY_BY_RELIABILITY) treated this same
// uncertainty as a DISCOUNT instead - shrinking the reserved block for
// being "unsure" how long the game runs - which was backwards: it made the
// scheduler free up a no-clock sport's slot SOONER specifically because
// it's less sure how long the game really goes, when the honest response
// to "not sure, but this sport tends to run over" is to reserve MORE time,
// not less. That inversion is what let the day plan schedule a next pick
// to start only ~2h13m into a genuinely great, high-endurance MLB game
// (133 min - the OLD effectiveDurationMinutes(190) * (1 - 0.3) discount -
// even though the plan itself had just judged that same game worth
// watching the whole way through), producing the reported ~40-80 real-
// minute overlaps once the actual broadcast ran anywhere close to its own
// average length. A high-reliability sport gets 0 - its own nominal length
// is already trusted as-is, nothing to pad.
//
// `low` brought down from 0.25 to 0.12 (docs/recommendation-engine-audit.md
// Round 14) - live-verified case: Tampa Bay Rays @ New York Yankees
// (2026-09-24, enduranceScore 9, effective duration ~152min) missed San
// Diego Padres @ Los Angeles Dodgers' own 02:10 UTC start by exactly ~15
// minutes purely because of this buffer's own 25% padding (152*1.25+10min
// transition = 200min, 15min past the 185min actually available) - losing
// the whole day's slot to a lower-scoring Reds/Braves+Padres/Dodgers
// combination even though Rays/Yankees clearly outscored both on every
// single axis. Explicitly reported and confirmed as an acceptable trade:
// a 10-15 real-minute overlap is a viewer inconvenience, not the "silently
// blocks a next pick that could obviously follow it" failure mode this
// constant exists to prevent (see this comment's own top half) - 0.12 still
// reserves real extra time for genuine overrun risk (~19min on a 162-min
// game) while no longer manufacturing a false conflict out of padding alone
// for a back-to-back MLB slate's own typical ~2.5-3.5 hour gaps.
export const DURATION_OVERRUN_BUFFER_BY_RELIABILITY = { high: 0, medium: 0.1, low: 0.12 };

// A small, deliberately flat realism buffer between two back-to-back picks
// (see docs/recommendation-engine-audit.md's "no transition buffer" bug) -
// two matches that are technically non-overlapping down to the minute
// (one ends exactly when the next starts) still aren't a plan a real
// viewer can execute. Kept small and sport-independent on purpose - the
// goal is closing that one gap, not making scheduling broadly conservative.
export const TRANSITION_BUFFER_MINUTES = 10;

// How far BELOW its own nominal `durationMinutes` a match's SCHEDULING
// window is ever allowed to shrink, regardless of how low its own
// enduranceScore-based value judgment is - keyed by durationReliability,
// same shape as DURATION_OVERRUN_BUFFER_BY_RELIABILITY. Round 36
// (2026-09-27, live-reported "it overlap"): a no-clock sport doesn't
// actually finish meaningfully faster just because the SCORE turned into a
// laugher - MLB's own 9 innings take roughly the same real clock time
// regardless of how close the final margin is (fewer mound visits/pitching
// changes trims a LITTLE off a lopsided game, not the 30-60% effectiveDuration-
// Minutes' own ENDURANCE_DURATION_FLOOR of 0.4 could shrink it to). Live
// case: Tampa Bay Rays @ Philadelphia Phillies (enduranceScore 5,
// effectiveDurationMinutes ~111 of its own 159min nominal) freed its
// scheduling slot with 48 real minutes still left on its own predicted
// length, waving in Houston Astros @ Athletics / Los Angeles Angels @
// Seattle Mariners at a start time the game was, in real life, still very
// plausibly being played through - a genuine overlap a viewer actually
// experiences, not the false conflict DURATION_OVERRUN_BUFFER_BY_RELIABILITY's
// own Round 14 history was built to avoid (that fix targets the OPPOSITE
// failure mode - padding a slot back OUT after a real early finish - and
// stays exactly as tuned; this is a separate axis). A high/medium-
// reliability sport's own real end time is already clock-bound regardless
// of score margin (a lopsided soccer match still plays the full 90+
// stoppage), so those get no floor at all - the existing endurance-based
// shrink already applies to them in full, unchanged. 0.85, not 1.0 (no
// floor at all) or higher: a genuinely one-sided MLB game can still finish
// a little faster in real life, this only stops the shrink from claiming
// nearly HALF the game is already over purely because it wasn't close.
export const SCHEDULING_DURATION_FLOOR_BY_RELIABILITY = { high: 0, medium: 0, low: 0.85 };

// How much of a match's schedule block a LATER pick actually has to wait
// out. Starts from effectiveDurationMinutes (the endurance-based "still
// worth watching" judgment - a genuine blowout can still free the slot up
// sooner, that's unchanged and unrelated to the fixes below), raised back
// up to this sport's own SCHEDULING_DURATION_FLOOR_BY_RELIABILITY floor if
// the endurance-based shrink alone would have gone below it, and then
// PADDED, never shrunk further, by this sport's own real-clock overrun
// risk (see DURATION_OVERRUN_BUFFER_BY_RELIABILITY) - the scheduling
// number can never end up SMALLER than either of those two floors, only
// equal or larger. This is deliberately the ONLY duration figure the
// scheduler itself ever reads (see schedulingInterval) - there is no
// second, separately-tuned notion of "how long is this event" anywhere
// else in the planner.
export function schedulingDurationMinutes(match) {
  // A FINISHED match's own durationMinutes (see build-data.mjs's
  // finishedDurationMinutes) is already the real observed elapsed time as
  // of the last fetch, not a pre-game guess - there is no forward
  // uncertainty left to hedge once ESPN itself confirms the fixture is
  // over, so neither the overrun buffer nor the floor below apply to a
  // match that HAS finished. Without this, a no-clock sport's game that
  // genuinely ran SHORT (the reported "obvious continuation" bug: a game
  // that dropped 30-60 minutes off its own predicted length) would still
  // get its already-real, already-short duration padded/floored back up,
  // reserving time for a game that had already definitively already ended -
  // exactly what kept blocking a next match that could clearly, obviously
  // follow it in real life. Returning match.durationMinutes directly here
  // (not effectiveDurationMinutes(match)) also matters on its own: a
  // low-enduranceScore match's own shrink would otherwise still apply even
  // to a FINISHED game's already-real, already-known length - a latent gap
  // this round's own new low-enduranceScore test coverage caught (every
  // pre-existing test here happened to use a high enduranceScore, where
  // that shrink is a no-op, masking it).
  if (match.isFinished) return match.durationMinutes;
  const timing = resolveSportTiming(match.sport);
  const overrun = DURATION_OVERRUN_BUFFER_BY_RELIABILITY[timing.durationReliability] ?? 0;
  const floorFraction = SCHEDULING_DURATION_FLOOR_BY_RELIABILITY[timing.durationReliability] ?? 0;
  const floored = Math.max(effectiveDurationMinutes(match), match.durationMinutes * floorFraction);
  return floored * (1 + overrun);
}

// The canonical scheduling representation every planner operation below
// (weightedIntervalSchedule via computeDayPlan, canWatchSequentially) reads
// - {start, end}, where `end` already bakes in this sport's own overrun
// buffer AND the transition buffer. Nothing downstream needs to know
// either of those exist; they just see one interval two matches either do
// or don't overlap.
export function schedulingInterval(match) {
  const start = Date.parse(match.startTimeUtc);
  return { start, end: start + schedulingDurationMinutes(match) * 60_000 + TRANSITION_BUFFER_MINUTES * 60_000 };
}

// The honest "how long will this realistically still be live" clock
// estimate used for DISPLAY/lifecycle purposes (matchLifecycleState below)
// - deliberately separate from schedulingDurationMinutes above, which
// blends in the endurance-based "still worth watching" value judgment.
// Whether a blowout is still worth recommending and whether the broadcast
// is still literally on the air are two different questions; this is only
// ever the second one; padded by the same real-clock overrun risk as
// scheduling (see DURATION_OVERRUN_BUFFER_BY_RELIABILITY), never a
// guarantee - see matchLifecycleState's own comment for why this can never
// substitute for `isFinished`.
export function estimatedDurationMinutes(match) {
  const overrun = DURATION_OVERRUN_BUFFER_BY_RELIABILITY[resolveSportTiming(match.sport).durationReliability] ?? 0;
  return match.durationMinutes * (1 + overrun);
}

// The explicit conflict relation docs/recommendation-engine-audit.md asks
// for in place of anchor-dependent grouping (section 7) - true when the
// earlier of the two matches's own schedulingInterval leaves enough room
// before the later one starts. A consistent pairwise definition, not
// dependent on which match happens to be considered "first" or which
// other matches are in play, unlike the old anchor-claiming grouping.
export function canWatchSequentially(a, b) {
  const aStart = Date.parse(a.startTimeUtc);
  const bStart = Date.parse(b.startTimeUtc);
  const [earlier, later] = aStart <= bStart ? [a, b] : [b, a];
  return schedulingInterval(earlier).end <= Date.parse(later.startTimeUtc);
}

// ---- Match lifecycle state --------------------------------------------------
//
// The ONE place every caller (app.js's relativeLabel/is-live styling,
// pinCurrentOrNext, pickInitialDay) reads to answer "what point in its
// lifecycle is this match at right now" - UPCOMING -> STARTING_SOON ->
// LIVE -> ENDING_SOON -> ENDED. Before this existed, that question was
// answered ad hoc in at least two different places in app.js, each
// against the plain NOMINAL end time (start + durationMinutes) with no
// upper bound at all once a match had actually started: relativeLabel
// computed `diffMin = startMs - now` and returned "即將開始" (starting
// soon) for ANY diffMin <= 0 - which is only ever reachable once `now` is
// past the nominal end too (the live window, `now < nominalEnd`, was
// already handled by an earlier branch) - so a match that had simply run
// long past its per-sport AVERAGE duration, without ESPN having reported
// it finished yet, was mislabeled as "about to start" instead of "still
// live" - a match that has already started can never be "about to start"
// again, however long it runs. Centralizing the state machine here, used
// everywhere a caller needs it, is what makes that class of bug
// structurally impossible to reintroduce independently in a second call
// site later.
//
// `isFinished` (ESPN's own reported status) is the ONLY thing that ever
// produces ENDED - never inferred from elapsed time, even past the
// overrun-padded estimate (see estimatedDurationMinutes) - because
// duration here is always an ESTIMATE, never a guaranteed end time (a
// no-clock sport can run arbitrarily long); a match still not reported
// finished falls back to LIVE once its start has passed, which is far
// more often correct than not for exactly the sports whose duration is
// least certain.
export const LIFECYCLE_STATES = {
  UPCOMING: 'UPCOMING',
  STARTING_SOON: 'STARTING_SOON',
  LIVE: 'LIVE',
  ENDING_SOON: 'ENDING_SOON',
  ENDED: 'ENDED'
};

// How close to its own start/estimated-end a match has to be to count as
// STARTING_SOON/ENDING_SOON rather than plain UPCOMING/LIVE - a UI nuance
// (worth a slightly different label/urgency), not a scheduling input;
// computeDayPlan/schedulingInterval never read this.
export const STARTING_SOON_WINDOW_MINUTES = 15;
export const ENDING_SOON_WINDOW_MINUTES = 15;

export function matchLifecycleState(match, now = Date.now()) {
  if (match.isFinished) return LIFECYCLE_STATES.ENDED;
  if (match.timeTbd) return LIFECYCLE_STATES.UPCOMING;

  const start = Date.parse(match.startTimeUtc);
  if (now < start) {
    const minutesToStart = (start - now) / 60_000;
    return minutesToStart <= STARTING_SOON_WINDOW_MINUTES ? LIFECYCLE_STATES.STARTING_SOON : LIFECYCLE_STATES.UPCOMING;
  }

  // Already started, and NOT reported finished - never STARTING_SOON or
  // UPCOMING again from here, whatever the estimated duration says.
  const estimatedEnd = start + estimatedDurationMinutes(match) * 60_000;
  if (now < estimatedEnd) {
    return now >= estimatedEnd - ENDING_SOON_WINDOW_MINUTES * 60_000 ? LIFECYCLE_STATES.ENDING_SOON : LIFECYCLE_STATES.LIVE;
  }
  // Past even the overrun-padded estimate - still LIVE, not ENDED: the
  // estimate was never a guarantee (see this section's own top comment),
  // and a no-clock sport running past even a generous estimate is a real,
  // unremarkable occurrence (extra innings, a long rain delay), not a
  // sign the match must actually be over.
  return LIFECYCLE_STATES.LIVE;
}

// ---- Live duration correction (a real-time refinement of the pre-game
// estimate, using ESPN's own live period/clock data) ------------------------
//
// public/lib/sport-duration.mjs's predictions are necessarily PRE-GAME
// estimates, decided from a team's own historical pace before a single
// pitch/tip-off/kickoff - real, CURRENT progress once a match is actually
// live is a much stronger signal for "how long will this broadcast really
// run", especially for MLB's own no-clock uncertainty (this repo's own
// reported bug: the pre-game estimate can drop out by 30-60 real minutes).
// This extrapolates the REAL pace observed so far (wall-clock elapsed vs.
// how far into the game ESPN's own live status reports it to be) forward to
// the sport's own full nominal length, so a genuinely slow- or fast-moving
// live game visibly corrects its own estimate instead of staying pinned to
// a pre-game guess the live game itself has already started to contradict.
// See app.js's pollLiveMatches for where this actually gets called (once
// per live-score poll) and written back onto match.durationMinutes, which
// is the one field every downstream scheduling calculation in this file
// (effectiveDurationMinutes/schedulingDurationMinutes/estimatedDurationMinutes)
// already reads from - so a better live number improves the whole viewing
// plan for free, not just what's printed on one card.
export function estimateLiveDurationMinutes(sport, startTimeUtc, fallbackMinutes, live, now = Date.now()) {
  if (!live?.isLive) return fallbackMinutes;
  const elapsedMinutes = (now - Date.parse(startTimeUtc)) / 60_000;
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes <= 0) return fallbackMinutes;

  const progress = liveGameProgressFraction(sport, live);
  // Too little of the game has happened to extrapolate responsibly yet - an
  // estimate from a handful of minutes is noisier than the pre-game guess,
  // not more informative than it.
  if (progress == null || progress < 0.2) return fallbackMinutes;

  const projected = elapsedMinutes / progress;
  // Blended with the original pre-game estimate rather than fully replacing
  // it, so one early, still-noisy reading can't whiplash the schedule -
  // weighted toward the observed real pace (0.7) since it's the more
  // current signal, but never discarding the original entirely. Never
  // below what has already, definitionally, elapsed.
  const blended = projected * 0.7 + fallbackMinutes * 0.3;
  return Math.max(Math.round(elapsedMinutes), Math.round(blended));
}

// 0..1, how far through the sport's own full regulation length a live match
// already is - or null when this sport/live payload carries no usable
// progress signal. F1 always returns null: no live per-lap timing feed is
// available from this build's own APIs (see sport-duration.mjs's own
// comment on deliberately not taking on a new dependency for exactly this),
// so an F1 race simply keeps its pre-race circuit-baseline estimate
// throughout, same as before this function existed.
function liveGameProgressFraction(sport, live) {
  if (sport === 'MLB') {
    const inning = Number(live.period);
    return Number.isFinite(inning) && inning > 0 ? Math.min(1, inning / 9) : null;
  }
  if (sport === 'NBA') {
    const quarter = Number(live.period);
    if (!Number.isFinite(quarter) || quarter <= 0) return null;
    const clockMinutesLeft = parseClockMinutesLeft(live.displayClock);
    const minutesIntoQuarter = clockMinutesLeft == null ? 0 : Math.max(0, 12 - clockMinutesLeft);
    // Regulation is 4x12 minutes - a quarter beyond the 4th (overtime) all
    // count as "past regulation", since OT's own real-time cost is already
    // handled separately by predictNbaDurationMinutes' own expected-value
    // overtime term, not by this live progress fraction.
    const regulationMinutesElapsed = Math.min(4, quarter - 1) * 12 + minutesIntoQuarter;
    return Math.min(1, regulationMinutesElapsed / 48);
  }
  if (sport === 'Premier League') {
    const minute = parseLeadingInt(live.displayClock);
    return minute == null ? null : Math.min(1, minute / 90);
  }
  return null;
}

function parseClockMinutesLeft(displayClock) {
  const match = /^(\d+):(\d+)/.exec(displayClock || '');
  if (!match) return null;
  return Number(match[1]) + Number(match[2]) / 60;
}

function parseLeadingInt(displayClock) {
  const match = /^(\d+)/.exec(displayClock || '');
  return match ? Number(match[1]) : null;
}

// ---- Live excitement (a real-time bonus for a genuinely close live game) --
//
// A pre-game score (competitiveness/watchability/enduranceScore/...) is
// necessarily a PREDICTION, decided before a single pitch/kickoff/tip-off.
// Once a match is actually live, its real current score is a far stronger,
// more current signal for "is this genuinely worth switching to or staying
// on right now" - this is a small, bounded, ADDITIVE bonus (never a
// replacement for the AI-validated score, same "adjustment, not override"
// posture as every other nudge in this file) applied only to a fixture
// that's genuinely LIVE right now, from how close its real current score
// is, weighted by how far into the game it already is - a tied game in the
// first few minutes says very little, a tied game deep into the second
// half/late innings genuinely is more exciting. This is what lets a live
// match that turns out to be a nail-biter win a scheduling slot a pre-game
// prediction alone wouldn't have given it (see app.js's pollLiveMatches,
// which re-fetches live scores and re-runs the day's plan with this bonus
// applied - "if a live match becomes close, it can bump the upcoming
// schedule").
//
// Reads match.competitors[].score directly (the exact same field
// build-data.mjs already produces) rather than a separate "live score"
// field, so a client-side live-score refresh (see app.js) only ever has to
// update the ONE place a score already lives.
export const LIVE_EXCITEMENT_MAX_BONUS = 2.5;

export function liveExcitementBonus(match, now = Date.now()) {
  if (match.isFinished) return 0;
  const scores = (match.competitors || []).map(c => Number(c?.score));
  if (scores.length !== 2 || !scores.every(Number.isFinite)) return 0;
  const state = matchLifecycleState(match, now);
  if (state !== LIFECYCLE_STATES.LIVE && state !== LIFECYCLE_STATES.ENDING_SOON) return 0;

  const start = Date.parse(match.startTimeUtc);
  const totalMinutes = Math.max(1, estimatedDurationMinutes(match));
  const elapsedFraction = Math.min(1, Math.max(0, (now - start) / (totalMinutes * 60_000)));

  // How close the two current scores are, scaled to how high-scoring THIS
  // game already is rather than a fixed margin - a 1-run gap is close in a
  // 2-1 MLB game, not in a 12-1 one; a 1-point gap late in an NBA game
  // isn't remotely the same as a 1-point gap in a 0-0 EPL match (whose own
  // total is 0, so `lopsidedAt`'s own floor of 3 keeps that division sane).
  const gap = Math.abs(scores[0] - scores[1]);
  const totalScored = scores[0] + scores[1];
  const lopsidedAt = Math.max(3, totalScored * 0.3);
  const closeness = Math.max(0, 1 - gap / lopsidedAt);

  return Math.round(closeness * elapsedFraction * LIVE_EXCITEMENT_MAX_BONUS * 100) / 100;
}

// ---- Quiet hours ------------------------------------------------------------

export const QUIET_HOUR_START = 0;
export const QUIET_HOUR_END = 5;

export function isQuietHours(match) {
  const hour = new Date(match.startTimeUtc).getHours(); // local hour, deliberately not getUTCHours
  return QUIET_HOUR_START <= QUIET_HOUR_END
    ? hour >= QUIET_HOUR_START && hour < QUIET_HOUR_END
    : hour >= QUIET_HOUR_START || hour < QUIET_HOUR_END;
}

// ---- Conflict clusters (near-total-overlap grouping within one day) -------
//
// Groups a day's candidate matches into clusters of mutually near-totally
// overlapping fixtures - PRESENTATION grouping only (the swipeable card
// stack, and the stable key pinning a choice within it), never an input to
// the scheduler itself (see computeDayPlan, and docs/
// recommendation-engine-audit.md's "the slot system can destroy the
// globally best plan" finding: an earlier version of this function decided
// ONE representative per group and handed the scheduler only that,
// silently discarding every other candidate before the DP ever got a
// chance to compare full sequences against each other). The scheduler now
// always sees every individual candidate; this function only labels which
// of them are each other's swipeable alternatives once picks are known.
//
// Built via union-find over the plain pairwise isNearTotalOverlap relation,
// not by claiming matches around a highest-score anchor - the old
// anchor-based version could produce different groups depending on which
// match happened to become the anchor (docs/recommendation-engine-audit.md
// bug #7: "slot grouping is anchor-dependent"). This version doesn't care
// about iteration order at all: two matches end up in the same cluster
// exactly when they're connected by a chain of pairwise near-total overlaps,
// full stop.
export function groupIntoSlots(dayMatches) {
  const parent = new Map(dayMatches.map(m => [m.id, m.id]));
  function find(id) {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (let i = 0; i < dayMatches.length; i++) {
    for (let j = i + 1; j < dayMatches.length; j++) {
      if (isNearTotalOverlap(dayMatches[i], dayMatches[j])) union(dayMatches[i].id, dayMatches[j].id);
    }
  }
  const groups = new Map();
  dayMatches.forEach(m => {
    const root = find(m.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(m);
  });
  return [...groups.values()].map(members => ({ members }));
}

export function slotKeyFromMembers(members) {
  return members.map(m => m.id).sort().join('|');
}

// ---- Weighted interval scheduling ------------------------------------------
//
// Classic weighted interval scheduling: the maximum-total-getScore(choice)
// subset of `items` (each {interval, choice}) whose intervals don't
// overlap. O(n^2) in the inner "find the latest compatible previous item"
// scan - fine at the scale one day's fixture list ever reaches.
//
// `getScore` defaults to effectiveScore (the plain viewer-relative score,
// see computeEffectiveScore) but computeDayPlan can pass planningScore
// instead (see applyLiveExcitementBonus) so a live-game bonus can steer
// WHICH sequence wins without needing a second copy of this function, or
// mutating effectiveScore itself (see Invariant 4 in docs/
// recommendation-engine-audit.md - a nudge like this can reduce or raise a
// score, never delete the event or corrupt the score it's derived from).
export function weightedIntervalSchedule(items, getScore = choice => choice.effectiveScore) {
  const sorted = items.slice().sort((a, b) => a.interval.end - b.interval.end);
  const dp = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    let prevBest = { score: 0, picks: [] };
    for (let j = i - 1; j >= 0; j--) {
      if (sorted[j].interval.end <= cur.interval.start) {
        prevBest = dp[j];
        break;
      }
    }
    // Floored at 0, never negative, before it's added to the running total.
    // A viewer-preference nudge (priority order - see PRIORITY_SCORE_DELTA)
    // is a TIE-BREAKER between competing alternatives, never a verdict that
    // a fixture isn't worth watching at all - but the raw DP as "maximize
    // total score of chosen non-overlapping items" doesn't know that
    // distinction: if enough stacked penalties push a candidate's own score
    // negative, ADDING it to an otherwise-empty, genuinely non-conflicting
    // slot makes the running total go DOWN, so the unfloored DP would
    // rather recommend NOTHING there at all - discarding a fixture that
    // costs the viewer literally nothing to also watch, for no real reason.
    // This was the direct cause of a reported bug: a day with a perfectly
    // fine, non-overlapping evening fixture ended up with only one
    // recommended match because that fixture's stacked penalties (a low
    // sport-priority rank, formerly also a now-removed repeat/
    // sport-concentration penalty - see applyLiveExcitementBonus's own
    // comment) happened to net negative. Flooring here means a
    // non-conflicting candidate can only
    // ever help or be neutral to the plan, never actively worse than
    // recommending nothing in its own free slot - PICKING it and PICKING
    // NOTHING then tie (`>=` below already favors picking it), so it's
    // included, exactly matching "why not, it's free" intuition.
    const score = Math.max(0, getScore(cur.choice));
    const withCur = { score: prevBest.score + score, picks: [...prevBest.picks, cur] };
    const without = i > 0 ? dp[i - 1] : { score: 0, picks: [] };
    dp[i] = withCur.score >= without.score ? withCur : without;
  }
  return sorted.length ? dp[sorted.length - 1].picks : [];
}

// ---- One day's back-to-back viewing plan -----------------------------------
//
// Builds ONE local calendar day's back-to-back viewing plan from its
// already sport-filtered, non-quiet-hour-excluded candidate matches. Mutates
// every match in `dayMatches` in place (.recommended/.alternativeIds/
// .isPreferred), same
// convention as the rest of this codebase. Returns the plan as a plain
// array of matches, sorted by start time.
//
// `pinnedForDay` (a Map<slotKey, matchId> or undefined/null) is passed in
// explicitly rather than read from any global/module state, so this
// function stays a pure function of its arguments - app.js's own
// `state.pinnedChoices.get(dayKey)` is what a caller passes here.
//
// A finished match is a REAL candidate here, not excluded - the whole plan
// is decided as ONE calendar day, not "whatever is still ahead as of right
// now" (see docs/recommendation-engine-audit.md and this repo's own README
// "Sport recommendation should be run using day as one unit" design goal):
// a viewer opening the page mid-afternoon should see the SAME whole-day
// lineup a viewer this morning would have, this morning's game shown as
// having already happened (matchLifecycleState/buildMatchCard's own
// is-finished styling) in its own rightful slot, not silently dropped from
// 推薦賽事 the moment it ends and the rest of the day quietly reflowed to
// fill the gap. isQuietHours is still the one thing that keeps a fixture
// out of the plan outright - "already over" isn't a reason to exclude it,
// it's a reason to show it as history.
//
// Every individual candidate goes into the scheduler below - NOT one
// representative per near-total-overlap cluster. An earlier version chose
// each cluster's highest-effectiveScore member BEFORE scheduling and only
// ever handed the DP that one representative per cluster; that meant a
// slightly-lower-scoring match that would have allowed a great continuation
// right after it could lose to a higher-scoring match that blocked the
// continuation entirely, without the scheduler ever getting a chance to
// compare "A alone" against "B then C" (see docs/
// recommendation-engine-audit.md, "the slot system can destroy the
// globally best plan"). Conflict clusters (groupIntoSlots) still exist, but
// only as a presentation label computed AFTER scheduling, from whichever
// picks the DP actually made.
// How much worse (on whichever score field the plan was actually built
// with - viewerScore/planningScore, both effectively the same 1-10ish
// scale as effectiveScore) a direct conflict is allowed to be and still
// count as a genuine swipeable alternative rather than just noise -
// "not everyday is equally good": some days a slot's best pick has no
// real rival at all and the stack should just show ONE card, other days
// two or three fixtures in the same slot are a real toss-up and every one
// of them belongs in the stack. 2.5 is this same file's own settled notion
// of "close enough to be a real call" rather than an arbitrary number.
export const ALTERNATIVE_MAX_SCORE_GAP = 2.5;

export function computeDayPlan(dayKey, dayMatches, pinnedForDay = null, { scoreField = 'viewerScore' } = {}) {
  dayMatches.forEach(match => {
    match.recommended = false;
    match.alternativeIds = null;
    match.isPreferred = false;
    match.slotKey = null;
  });
  const candidates = dayMatches.filter(m => !isQuietHours(m));
  if (!candidates.length) return [];

  // Falls back to the older effectiveScore name (never to a bare 0) when
  // scoreField's own field isn't set - a match that never went through
  // resolveViewingPlan (most of this module's own tests build one by
  // hand) has effectiveScore but not the audit's newer viewerScore alias
  // (see resolveViewingPlan/computeRecommendationScore); both are always
  // the exact same number whenever a match DOES have both, so this never
  // changes which match wins a scheduling decision, only which of two
  // identically-valued field names the DP happens to read.
  const getScore = match => (Number.isFinite(match[scoreField]) ? match[scoreField] : match.effectiveScore);

  // Presentational conflict clusters (see groupIntoSlots' own comment) -
  // used below only to (a) look up a pinned choice by its stable slot key
  // and (b) label the final alternativeIds, never to decide what the
  // scheduler itself is allowed to consider.
  const clusters = groupIntoSlots(candidates);
  const clusterByMatchId = new Map();
  clusters.forEach(cluster => cluster.members.forEach(m => clusterByMatchId.set(m.id, cluster)));

  // A pinned choice is a hard user override (see app.js's pinSlotChoice) -
  // it alone represents its conflict cluster now. Every OTHER match that
  // genuinely can't be watched alongside it (a direct pairwise
  // isNearTotalOverlap, not just "somewhere in the same transitive
  // cluster") is excluded from the scheduler entirely; anything else stays
  // a normal free candidate the planner is still free to schedule around
  // the pin. This matters a LOT in practice: a real MLB slate's own
  // transitive cluster can chain together 10+ games in one giant group
  // (game1 near-totally overlaps game2, game2 overlaps game3, ... - each
  // ~3-4 reserved hours, bunched into a few real-world start-time windows -
  // even though game1 and game14 don't remotely conflict). Excluding the
  // WHOLE transitive cluster on a single pin (an earlier version of this
  // function tried exactly that, to keep the swipeable stack's member set
  // from ever changing shape) would silently suppress every other one of
  // those 10+ genuinely independent, non-conflicting games from being
  // recommended at all for the rest of the day the moment a viewer pinned
  // just ONE of them - confirmed against real fetched data (see README).
  // Pairwise-only exclusion is correct; the actual "swipe stack" bug this
  // was chasing was in `alternatives` below, not here.
  const forcedIds = new Set();
  const excludedIds = new Set();
  clusters.forEach(cluster => {
    // `pinnedForDay` is a Set<matchId> (see public/lib/preferences.mjs) - a
    // pin is looked up by the PINNED MATCH'S OWN id, never by a hash of the
    // cluster it happened to belong to at pin time. This used to be keyed
    // by slotKeyFromMembers(cluster.members) instead - which silently
    // orphaned a real pin the moment the cluster's own shape changed from
    // under it (a live duration correction nudging a near-total-overlap
    // boundary, a routine 15-minute data refresh reshuffling which
    // fixtures exist, or simply the viewer having pinned this match while
    // a sport filter was narrowing which candidates counted toward the
    // cluster in the first place) - live-reported as "swiping to a
    // preference doesn't stick, reloading wipes it back to 推薦": the pin
    // was still sitting in localStorage the whole time, just under a key
    // that no longer matched anything computeDayPlan could ever look up
    // again. A match's own id is stable regardless of which cluster shape
    // currently contains it - even a cluster that split into several
    // smaller ones (or one that grew) still finds its pin correctly here.
    const pinnedMatch = pinnedForDay && cluster.members.find(m => pinnedForDay.has(m.id));
    if (!pinnedMatch) return;
    forcedIds.add(pinnedMatch.id);
    cluster.members.forEach(m => {
      if (m.id !== pinnedMatch.id && isNearTotalOverlap(m, pinnedMatch)) excludedIds.add(m.id);
    });
  });

  const toItem = match => ({ interval: schedulingInterval(match), choice: match });
  const forced = candidates
    .filter(m => forcedIds.has(m.id))
    .map(toItem)
    .sort((a, b) => a.interval.start - b.interval.start);
  const free = candidates.filter(m => !forcedIds.has(m.id) && !excludedIds.has(m.id)).map(toItem);

  // Pinned picks split the day into independent gaps - the free candidates
  // in each gap get their own scheduling run, bounded so nothing scheduled
  // there can creep into a pinned pick's own fixed window.
  const picks = [];
  let cursor = -Infinity;
  forced.forEach(f => {
    picks.push(
      ...weightedIntervalSchedule(
        free.filter(r => r.interval.start >= cursor && r.interval.end <= f.interval.start),
        getScore
      )
    );
    picks.push(f);
    cursor = f.interval.end;
  });
  picks.push(...weightedIntervalSchedule(free.filter(r => r.interval.start >= cursor), getScore));

  picks.sort((a, b) => a.interval.start - b.interval.start);
  picks.forEach(({ choice }) => {
    choice.recommended = true;
    // Distinguishes "the system picked this" (推薦) from "you swiped to
    // this" (偏好, see app.js's buildMatchCard) - a viewer-made choice
    // isn't the same claim as the algorithm's own judgment. forcedIds is
    // exactly the set of pinned matches (see above) - every pick in it
    // got there because the viewer overrode the scheduler, not because
    // the scheduler chose it on its own merits.
    choice.isPreferred = forcedIds.has(choice.id);
  });

  // alternativeIds is purely presentational, computed AFTER scheduling:
  // every OTHER candidate that DIRECTLY (pairwise isNearTotalOverlap)
  // conflicts with the picked match and that the scheduler didn't also
  // independently pick - deliberately NOT "every other member of the
  // picked match's transitive cluster". A real MLB slate's transitive
  // cluster can chain together 10+ games in one giant group (see the
  // exclusion comment above) even though most pairs in it never conflict
  // at all - an earlier version of this function used the FULL transitive
  // cluster here, which meant a viewer swiping through what should have
  // been a genuine, small "pick one of these 2-3 games actually airing at
  // the same time" stack instead got a card for every one of 10+ unrelated
  // games that whole night, most with nothing to do with the one actually
  // picked - confirmed against real fetched data, and almost certainly the
  // real cause behind reports of the swipe stack "looping weirdly, out of
  // order" (see README). A match is never both recommended and listed as
  // someone else's alternative (docs/recommendation-engine-audit.md's
  // Invariant 1) - `!m.recommended` still guards that here.
  //
  // slotKey is still the FULL cluster's own stable key (every member,
  // whether or not it ended up recommended, and regardless of direct vs.
  // transitive conflict) - deliberately NOT narrowed the same way
  // alternativeIds just was. A cluster of 3+ near-total-overlapping
  // matches where the scheduler independently recommends more than one of
  // them (e.g. two matches that only each conflict with a third, not with
  // each other - see Test 3's A/B/C in recommendation.test.mjs) renders as
  // TWO separate swipeable stacks, one per recommended pick, each showing
  // only its OWN direct conflicts as alternatives. Both stacks are really
  // part of the same underlying conflict cluster, though, and app.js's
  // pinSlotChoice has to record a pin under the key computeDayPlan will
  // actually look up on the next render (pinnedForDay.get(
  // slotKeyFromMembers(cluster.members)) above, always the full cluster) -
  // keying off only the 2-3 matches visible in whichever stack the viewer
  // happened to swipe would silently never match that lookup on a 3+-stack
  // split, so the pin would appear to take (the swipe animates, the dot
  // updates) but get thrown away on the very next render, reverting right
  // back. Exposing the real key here, once, is what makes every stack for
  // the same cluster agree on where a pin against it lives, even though
  // the members each stack actually DISPLAYS are now its own direct
  // conflicts only.
  // A direct conflict only earns a spot in the swipeable stack when it's
  // actually a live question, not whenever one merely exists - see
  // ALTERNATIVE_MAX_SCORE_GAP's own comment. A match that's clearly worse
  // than the pick on the exact score the scheduler just used to choose
  // between them isn't a real second opinion, it's a decoy: showing it
  // dilutes the ONE genuinely good option down to "one of several", and
  // trains a viewer to stop trusting the stack ("every card has an
  // alternative, most of them junk"). It's never deleted - still fully
  // visible in the plain match list below (renderAllMatchesSection) -
  // this only decides whether it's worth a viewer's swipe. Never gates in
  // the other direction: an alternative that's BETTER than the pick
  // (negative gap) always stays in, however large the gap - that's not
  // "variety", that's a better game the viewer would otherwise miss
  // entirely, including the case where the pick only won because it's a
  // hard pin (see forcedIds above) against a much stronger natural
  // candidate.
  picks.forEach(({ choice }) => {
    const cluster = clusterByMatchId.get(choice.id);
    if (!cluster || cluster.members.length < 2) return;
    choice.slotKey = slotKeyFromMembers(cluster.members);
    const pickedScore = getScore(choice);
    const alternatives = cluster.members.filter(
      m =>
        m.id !== choice.id &&
        !m.recommended &&
        isNearTotalOverlap(m, choice) &&
        pickedScore - getScore(m) <= ALTERNATIVE_MAX_SCORE_GAP
    );
    if (alternatives.length) choice.alternativeIds = alternatives.map(m => m.id);
  });

  return picks.map(p => p.choice);
}

// What computeDayPlan would pick for one specific slot if THIS slot's own
// pin didn't exist - i.e. the algorithm's own natural default for that
// cluster, with every OTHER pin still respected. public/lib/preferences.mjs's
// applySlotSwipe uses this to tell "the viewer swiped back to the default"
// (clear the pin, revert to 推薦) apart from "the viewer chose a genuine
// alternative" (keep the pin, show 偏好) - see that module's own comment
// for why conflating the two mislabeled every swipe as a preference, even
// swiping straight back to the algorithm's own top pick.
//
// Clones `dayMatches` internally (never mutates the caller's own match
// objects/flags, same posture as explainWhyNotRecommended below) so this is
// safe to call from a live swipe handler without disturbing whatever's
// currently rendered.
export function naturalSlotChoice(dayKey, dayMatches, slotKey, pinnedForDay = null, options = {}) {
  // `slotKey` is exactly `slotKeyFromMembers(cluster.members)` - every
  // member's own id, sorted and joined - so splitting it back apart is a
  // safe, exact way to get "every match this specific slot is asking
  // about" without needing a separate members array passed in. Excluding
  // any PIN that belongs to one of THESE ids (not a slotKey lookup - see
  // computeDayPlan's own comment on pinnedForDay now being a Set<matchId>)
  // is what "pretend this slot has no pin" actually means once pins are
  // keyed by match id rather than by cluster shape.
  const clusterMemberIds = new Set(slotKey.split('|'));
  const withoutThisSlot = new Set(pinnedForDay ? [...pinnedForDay].filter(id => !clusterMemberIds.has(id)) : []);
  const clone = dayMatches.map(m => ({ ...m }));
  const picks = computeDayPlan(dayKey, clone, withoutThisSlot, options);
  const picked = picks.find(m => m.slotKey === slotKey);
  return picked ? picked.id : null;
}

// A team-sport matchup's identity, independent of which side is home/away
// or which export produced it (so "A @ B" and "B @ A" - a return leg, or
// just a different [away, home] ordering - count as the same matchup). An
// F1 session has no `competitors` (see build-data.mjs's fetchF1Matches), so
// it falls back to its own name, which already includes the session suffix
// - qualifying and the race itself are correctly two different keys, never
// folded together as "the same event recommended twice". Nothing in this
// module's own scoring reads this anymore (see applyLiveExcitementBonus's
// own comment on why the cross-day repeat penalty this used to feed was
// removed) - kept because scripts/evaluate-recommendations.mjs's own
// descriptive report still uses it to track which distinct calendar dates a
// given matchup was recommended on.
export function matchupKey(match) {
  if (Array.isArray(match.competitors) && match.competitors.length === 2) {
    const names = match.competitors.map(c => c.name || c.abbreviation || '?').sort();
    return `${match.sport}: ${names.join(' vs ')}`;
  }
  return `${match.sport}: ${match.name || match.id}`;
}

// Map<sport, share 0..1> of how much of `picks` belongs to each sport -
// a pure diagnostic (computeWindowPlan exposes this over the whole window's
// own final picks, and scripts/evaluate-recommendations.mjs's own report
// surfaces it too) - not fed into any scoring decision. It used to also
// back a soft same-sport-concentration penalty (see applyLiveExcitementBonus's
// own comment for why that was removed).
export function computeSportConcentration(picks) {
  const bySport = new Map();
  picks.forEach(m => bySport.set(m.sport, (bySport.get(m.sport) || 0) + 1));
  const total = picks.length;
  const shares = new Map();
  bySport.forEach((count, sport) => shares.set(sport, total > 0 ? count / total : 0));
  return shares;
}

// Sets `.planningScore`/`.liveExcitementBonus` on every match in
// `dayMatches` - the score computeDayPlan's scheduler actually weighs picks
// by (see its own `scoreField` option). This used to also fold in a soft
// cross-day matchup-repeat penalty and a same-sport-concentration penalty
// (docs/recommendation-engine-audit.md sections 14/15 - "don't recommend the
// same MLB matchup 3 days running when a comparable alternative exists").
// Removed entirely per direct feedback: this viewer mostly doesn't watch on
// weekdays at all, so comparing today's best game against whatever won a
// weekday slot he never actually watched just buried a genuinely great game
// for a "variety" benefit that never applied to him. planningScore is now
// exactly effectiveScore plus the live-match excitement bonus below - kept
// as its own field (rather than just reading effectiveScore directly)
// purely so a live-game bonus can still nudge which of two overlapping
// matches wins its slot without mutating effectiveScore itself (docs/
// recommendation-engine-audit.md Invariant 4 - a nudge like this can move
// the scheduler's own pick, never corrupt the viewer's true, un-nudged
// judgment of the match).
export function applyLiveExcitementBonus(dayMatches) {
  dayMatches.forEach(match => {
    // Recomputed fresh every call (never accumulated) from match's own
    // CURRENT competitor scores - see liveExcitementBonus's own comment.
    const liveBonus = liveExcitementBonus(match);
    match.liveExcitementBonus = liveBonus;
    match.planningScore = Math.round(((Number.isFinite(match.effectiveScore) ? match.effectiveScore : 0) + liveBonus) * 1e6) / 1e6;
  });
}

// ---- Gemini bounded daily tie-break (Shared-Proxy's /match-recommend) -----
//
// Round 32/34: docs/recommendation-engine-audit.md traced a real mismatch
// (2026-09-23/24/25 MLB's headline slot) that survived a systematic search
// for a formula fix - any reweighting of the deterministic score's own axes
// that corrected that day ALSO flipped an already-correct pick on a
// different, statistically-identical-shaped day (2026-09-26). That's proof
// the two days' correct answers depend on real-world context (team
// storylines, star power, how big a draw a specific matchup is) no
// deterministic box-score signal here captures - not a coefficient bug.
//
// Round 35: Round 34's own first attempt used a small additive SCORE bonus
// (enough to flip a close call, never enough to override a clear one) -
// live-reported as still not reliably matching the user's own validated
// expectation, for the plain reason that a bonus which "never overrides a
// clear win" is exactly a bonus that CAN silently lose when the real gap
// turns out wider than the margin that decided whether to even ask Gemini
// in the first place (GEMINI_TIE_BREAK_MARGIN, 0.5 - live-verified TOO
// TIGHT: it excluded Tampa Bay Rays @ New York Yankees, a full-fledged
// alternative already shown as swipeable in the UI, from ever being asked
// about at all, purely because its own gap to the top pick, 0.7, exceeded
// that separate, narrower threshold). Direct instruction from the user:
// "it has to match my expected result no matter what." This is now a HARD
// override, not a nudge: `resolveGeminiOverridePin` returns a matchId to
// FORCE into computeDayPlan's own `pinnedForDay` (the exact same mechanism
// a viewer's own swipe-to-pin already uses - see computeDayPlan's own
// comment on `forcedIds`), which wins its slot unconditionally regardless
// of any score gap, the same guarantee a real user pin already has. The
// separate, too-tight margin is gone entirely - `selectGeminiTieBreakCandidates`
// now offers Gemini every alternative computeDayPlan itself already
// considered close enough to show as swipeable (`alternativeIds`, gated by
// this file's own ALTERNATIVE_MAX_SCORE_GAP), never a second, independently
// tuned notion of "close".
//
// This is still NOT a return to the original per-fixture Gemini validation
// call removed in Round 11 (that one asked Gemini to score EVERY fixture,
// every build, which is what burned through free-tier quota) - it's called
// for AT MOST ONE slot per day (the currently-viewed day's own headline
// slot), and only when that slot actually has a real alternative at all.
// app.js owns the actual network call/caching (this module has no fetch of
// its own - same "pure scoring, network is someone else's job" split as
// the rest of this codebase); these functions are the pure, testable
// pieces of that flow: which candidates qualify for a tie-break, what to
// send, whether a cached answer still applies, and how to force it in.

// Bounded to match Shared-Proxy's own MATCH_RECOMMEND_MAX_CANDIDATES - a
// tie-break asks Gemini to pick among a SMALL handful of genuinely close
// options, never to rank a whole day's slate.
export const GEMINI_TIE_BREAK_MAX_CANDIDATES = 4;

// `dayMatches` must already have been through computeDayPlan (so
// `.recommended`/`.alternativeIds`/scoreField are set) - this reads that
// output directly rather than re-deriving overlap/conflict logic itself,
// so whatever gets offered to Gemini is GUARANTEED to be the exact same
// conflict cluster already rendered as swipeable alternatives, never a
// second, possibly-inconsistent computation of "what's in this slot", and
// never a second, independently-tuned notion of "close enough" - see this
// section's own Round 35 comment for why a separate margin was removed.
// Returns null when there's nothing to ask about: no recommended pick, or
// no alternatives at all (a day where the algorithm's own top pick has no
// real rival needs no second opinion).
// Round 37: a day can have MORE THAN ONE recommended slot at once (a
// headline pick plus an earlier, non-overlapping "continuation" pick - see
// Round 36's own scheduling-floor fix) - `dayMatches.find(m => m.recommended)`
// used to just grab whichever recommended slot happened to sort first
// chronologically, which on a live 2026-09-23/24/25 slate was almost always
// an early, low-stakes slot with NO real alternatives, silently starving the
// genuinely contested evening headline slot (the one this whole feature
// exists for) of ever being asked about at all. Fixed by scanning EVERY
// recommended slot that day and picking whichever one's own top-vs-runner-up
// gap is smallest - the slot the deterministic engine itself is least
// confident about, regardless of what time it airs.
function scoreOf(match, scoreField) {
  return Number.isFinite(match[scoreField]) ? match[scoreField] : match.effectiveScore;
}

export function selectGeminiTieBreakCandidates(dayMatches, { scoreField = 'planningScore' } = {}) {
  const byId = new Map(dayMatches.map(m => [m.id, m]));
  let best = null;
  let bestGap = Infinity;
  for (const top of dayMatches) {
    if (!top.recommended || !Array.isArray(top.alternativeIds) || !top.alternativeIds.length) continue;
    const close = [top, ...top.alternativeIds.map(id => byId.get(id)).filter(Boolean)]
      .filter(m => Number.isFinite(scoreOf(m, scoreField)))
      .sort((a, b) => scoreOf(b, scoreField) - scoreOf(a, scoreField))
      .slice(0, GEMINI_TIE_BREAK_MAX_CANDIDATES);
    if (close.length < 2) continue;
    const gap = scoreOf(close[0], scoreField) - scoreOf(close[1], scoreField);
    if (gap < bestGap) {
      bestGap = gap;
      best = close;
    }
  }
  return best;
}

// Stable regardless of candidate order - a cache entry must be looked up
// the same way it was stored even if scores moved slightly between the
// render that asked and the render that's now checking, as long as the
// underlying SET of candidate ids is unchanged.
export function tieBreakCandidateKey(candidates) {
  return candidates
    .map(c => c.id)
    .sort()
    .join(',');
}

// The exact request body Shared-Proxy's handleMatchRecommendRequest expects
// - `reason`/`facts` are the SAME human-readable strings already computed
// for this fixture's own card (buildObjectiveReasonZh's output and
// objective-score.mjs's own factor list respectively, threaded through
// match-builder.mjs), never re-derived here, so Gemini sees exactly the
// same real statistical grounding a viewer already sees, not a
// second-guessed summary of it.
export function buildGeminiTieBreakPayload(dayKey, candidates, { scoreField = 'planningScore' } = {}) {
  return {
    day: dayKey,
    candidates: candidates.map(m => ({
      id: m.id,
      sport: m.sport,
      name: m.name,
      score: Math.round((Number.isFinite(m[scoreField]) ? m[scoreField] : m.effectiveScore) * 100) / 100,
      reason: typeof m.reason === 'string' ? m.reason : '',
      facts: Array.isArray(m.objectiveFactors) ? m.objectiveFactors : []
    }))
  };
}

// Decides whether a cached Gemini answer for `dayKey` still applies to
// THIS render, and if so, which matchId to force in. `close` is this
// render's own FRESH call to selectGeminiTieBreakCandidates (never trust a
// cache entry's candidate set blindly - a game finishing, or a score
// moving enough to change who's even offered, must invalidate it, same
// stale-cache posture the rest of this section already has).
// `cacheEntry` is `{ candidateKey, pickId, fetchedAt }` or undefined/null
// (app.js's own localStorage-backed cache, looked up by dayKey).
// `pinnedForDay` is the VIEWER's OWN explicit pins (a Set<matchId> or
// null) - an explicit human pin in the same conflict cluster ALWAYS wins;
// Gemini's own answer never overrides a viewer's own swipe.
// Returns null (no override) unless every check passes.
export function resolveGeminiOverridePin(dayMatches, close, cacheEntry, pinnedForDay = null) {
  if (!close || !cacheEntry || !cacheEntry.pickId) return null;
  if (tieBreakCandidateKey(close) !== cacheEntry.candidateKey) return null;
  if (!close.some(m => m.id === cacheEntry.pickId)) return null;
  const pinnedSet = pinnedForDay instanceof Set ? pinnedForDay : new Set(pinnedForDay || []);
  if (pinnedSet.size) {
    const clusters = groupIntoSlots(dayMatches.filter(m => !isQuietHours(m)));
    const cluster = clusters.find(c => c.members.some(m => m.id === cacheEntry.pickId));
    const clusterIds = new Set(cluster ? cluster.members.map(m => m.id) : [cacheEntry.pickId]);
    if ([...pinnedSet].some(id => clusterIds.has(id))) return null;
  }
  return cacheEntry.pickId;
}

// The one entry point app.js's render path actually calls: runs
// computeDayPlan once (the plan absent any Gemini involvement - this is
// also what selectGeminiTieBreakCandidates itself needs to see what's
// close), and, only if resolveGeminiOverridePin finds a still-valid cached
// answer that isn't blocked by a viewer's own pin, runs it AGAIN with that
// pick FORCED IN via the exact same pinnedForDay mechanism a real swipe-to-
// pin already uses - see this section's own Round 35 comment for why a
// hard pin, not a score nudge. computeDayPlan fully resets every match's
// own `.recommended`/`.alternativeIds` at the top of each call (see its
// own comment), so calling it twice on the same `dayMatches` array is
// safe: whichever call ran LAST is what's left mutated onto the matches,
// exactly what should render.
// Returns `{ picks, close }` - `picks` is computeDayPlan's own return
// value (ready to render), `close` is handed straight to app.js's own
// maybeRequestGeminiTieBreak so it never has to recompute the same
// selection a second time.
export function computeDayPlanWithGeminiTieBreak(dayKey, dayMatches, pinnedForDay, cacheEntry, { scoreField = 'planningScore' } = {}) {
  const natural = computeDayPlan(dayKey, dayMatches, pinnedForDay, { scoreField });
  const close = selectGeminiTieBreakCandidates(dayMatches, { scoreField });
  const overridePickId = resolveGeminiOverridePin(dayMatches, close, cacheEntry, pinnedForDay);
  if (!overridePickId) return { picks: natural, close };
  const pinnedWithOverride = new Set(pinnedForDay ? [...pinnedForDay] : []);
  pinnedWithOverride.add(overridePickId);
  const picks = computeDayPlan(dayKey, dayMatches, pinnedWithOverride, { scoreField });
  return { picks, close };
}

// Runs computeDayPlan once per day across a whole fetched window.
// `matchesByDayKey` is a Map<dayKey, matches> (app.js's own per-day
// buckets); `pinnedChoices` is state.pinnedChoices as-is (a
// Map<dayKey, Map<slotKey, matchId>>). Each day is still scored
// independently (applyLiveExcitementBonus has no cross-day memory - the
// soft cross-day repeat/sport-concentration penalty this used to apply
// chronologically was removed, see that function's own comment), so unlike
// an earlier version of this function, day order no longer matters here.
//
// Returns:
//   - `plan`: Map<dayKey, picks>
//   - `sportConcentration`: Map<sport, share> over the WHOLE window's own
//     final picks (see computeSportConcentration) - a pure diagnostic, not
//     fed into any scoring decision.
export function computeWindowPlan(matchesByDayKey, pinnedChoices = new Map()) {
  const dayKeys = [...matchesByDayKey.keys()].sort();
  const plan = new Map();
  dayKeys.forEach(dayKey => {
    const dayMatches = matchesByDayKey.get(dayKey) || [];
    applyLiveExcitementBonus(dayMatches);
    const picks = computeDayPlan(dayKey, dayMatches, pinnedChoices.get(dayKey), { scoreField: 'planningScore' });
    plan.set(dayKey, picks);
  });
  return {
    plan,
    sportConcentration: computeSportConcentration(dayKeys.flatMap(dayKey => plan.get(dayKey)))
  };
}

// ---- "Why not" explanations (docs/recommendation-engine-audit.md §27) -----
//
// computeDayPlan/computeWindowPlan answer "what got picked" - this answers
// the complementary question a developer debugging one specific decision
// actually needs: "why wasn't THIS ONE picked". Deliberately a separate,
// ON-DEMAND function (call it for one candidate you're curious about) -
// not something eagerly computed for every non-recommended match on every
// render, which would mean re-running the scheduler dozens of times for
// answers nobody asked for. It gets a REAL answer by re-running the actual
// scheduler, once as it actually ran and once with this specific candidate
// forced in (the same mechanism a real pin uses - see groupIntoSlots/
// slotKeyFromMembers) and comparing the two plans' total value, rather
// than guessing from static rules - so the explanation is exactly as
// trustworthy as the scheduler itself, per the audit's own framing: "It
// also prevents the developer from having to inspect five functions to
// understand one decision."
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// `dayMatches` is cloned internally (never mutates the caller's own match
// objects/flags) so this is safe to call speculatively without disturbing
// whatever's currently rendered - same signature shape as computeDayPlan
// (dayKey, dayMatches, pinnedForDay) plus the one candidate id being asked
// about, and the same `scoreField` option so the comparison uses whichever
// score the real plan was actually built with.
export function explainWhyNotRecommended(candidateId, dayKey, dayMatches, pinnedForDay = null, { scoreField = 'planningScore' } = {}) {
  const getScore = m => {
    const value = m[scoreField];
    return Number.isFinite(value) ? value : Number.isFinite(m.effectiveScore) ? m.effectiveScore : 0;
  };

  const actual = dayMatches.map(m => ({ ...m }));
  const actualPicks = computeDayPlan(dayKey, actual, pinnedForDay, { scoreField });
  const actualMatch = actual.find(m => m.id === candidateId);
  if (!actualMatch) return { reason: 'notFound', detail: 'No such candidate on this day.' };
  if (actualMatch.recommended) return { reason: 'recommended', detail: 'This match is already part of the plan - there is nothing to explain.' };
  if (isQuietHours(actualMatch)) {
    return { reason: 'quietHours', detail: 'Its local start time falls in quiet hours (00:00-05:00), which is never recommended however good its score.' };
  }

  const actualValue = actualPicks.reduce((sum, m) => sum + getScore(m), 0);

  // Force this exact candidate in via the same pinning mechanism a real
  // viewer swipe uses (see pinSlotChoice in app.js) - pinnedForDay is a
  // Set<matchId> (see computeDayPlan's own comment on why pins are keyed by
  // the match's own id, not by a hash of whichever cluster it belonged to).
  // Any OTHER member of candidateId's own cluster already sitting in
  // pinnedForDay has to be dropped first, not just left alongside it - a
  // cluster only ever has room for ONE forced pick (see computeDayPlan's
  // own forcedIds), and cluster.members.find would otherwise arbitrarily
  // resolve to whichever of the two happens to come first, silently
  // ignoring the one candidate this function was actually asked to force.
  const forced = dayMatches.map(m => ({ ...m }));
  const forcedCandidates = forced.filter(m => !isQuietHours(m));
  const cluster = groupIntoSlots(forcedCandidates).find(c => c.members.some(m => m.id === candidateId));
  const clusterMemberIds = new Set(cluster ? cluster.members.map(m => m.id) : [candidateId]);
  const forcedPinnedForDay = new Set(pinnedForDay ? [...pinnedForDay].filter(id => !clusterMemberIds.has(id)) : []);
  forcedPinnedForDay.add(candidateId);
  const forcedPicks = computeDayPlan(dayKey, forced, forcedPinnedForDay, { scoreField });
  const forcedValue = forcedPicks.reduce((sum, m) => sum + getScore(m), 0);

  if (forcedValue > actualValue + 1e-9) {
    // Forcing it in would have made the plan MORE valuable by the
    // scheduler's own numbers - so a value judgment isn't what excluded
    // it. The only other thing that can override the scheduler is a
    // DIFFERENT pinned choice occupying the same window.
    return {
      reason: 'blockedByPin',
      detail: 'Including this candidate would have produced a higher-value plan - a different pinned choice is overriding the scheduler here, not a scoring decision.',
      actualValue: round3(actualValue),
      wouldBeValue: round3(forcedValue)
    };
  }

  const conflictsWithRecommended = actualPicks.filter(m => !canWatchSequentially(m, actualMatch));
  if (conflictsWithRecommended.length) {
    return {
      reason: 'lostToBetterSequence',
      detail: `It conflicts with ${conflictsWithRecommended.map(m => m.name || m.id).join(', ')}, and the sequence that was actually chosen is worth at least as much (${round3(actualValue)}) as any plan built around this candidate instead (${round3(forcedValue)}).`,
      conflictsWith: conflictsWithRecommended.map(m => m.id),
      actualValue: round3(actualValue),
      wouldBeValue: round3(forcedValue)
    };
  }

  // Doesn't conflict with anything actually picked, and forcing it in
  // wouldn't raise the plan's total value either - the rare, genuinely
  // low-value case (a heavily penalized or near-zero-score candidate the
  // scheduler correctly judged not worth its own slot even with nothing
  // competing for it).
  return {
    reason: 'lowValue',
    detail: "It doesn't conflict with anything in the actual plan, but its own score wasn't enough to be worth including even on its own.",
    actualValue: round3(actualValue),
    wouldBeValue: round3(forcedValue)
  };
}

// ---- Viewer-relative score resolution --------------------------------------
//
// `priorityOrder` nudges effectiveScore away from the AI's own score - the
// displayed reason/.score always stay the true, un-nudged values; only
// effectiveScore (the day plan's own DP weight by default, see
// computeDayPlan's `scoreField` option) sees the adjusted number.
export function resolveViewingPlan(matches, priorityOrder = [], myServiceIds = new Set()) {
  const context = { priorityOrder, myServiceIds };
  const withScores = matches.map(match => {
    const breakdown = computeEffectiveScore(match, context);
    return {
      ...match,
      score: breakdown.bestMatchScore,
      effectiveScore: breakdown.effectiveScore,
      // See computeRecommendationScore's own comment - same numbers as
      // baseScore/effectiveScore above, under the names docs/
      // recommendation-engine-audit.md's score-architecture section asks
      // for. planningScore is intentionally NOT set here - it needs
      // same-day scheduling context (applyLiveExcitementBonus), which this
      // function has no access to.
      eventScore: breakdown.baseScore,
      viewerScore: breakdown.effectiveScore,
      scoreBreakdown: breakdown,
      confidence: computeConfidence(match),
      recommended: false,
      alternativeIds: null,
      isPreferred: false
    };
  });

  // Computed across every fetched match regardless of day or quiet hours -
  // used purely for display (buildMatchCard's own overlap note, on ANY
  // card whose start overlaps an earlier match, recommended or not).
  withScores.forEach(match => {
    match.overlappingIds = match.isFinished
      ? []
      : withScores
          .filter(other => other.id !== match.id && !other.isFinished && overlapMinutes(match, other) > 0)
          .map(other => other.id);
  });

  return withScores;
}
