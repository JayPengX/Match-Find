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
// isQuietHours's own use of the current wall clock via
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
// `whereToWatchTw` (see match-builder.mjs's resolveWhereToWatchTw - a
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
// Full rewrite, direct instruction: rank the way a TV network producer
// would - "what would the most people actually tune into" - not "which
// game is the tensest nail-biter". The old model blended five fields
// (skill/competitiveness/watchability/enduranceScore/broadcastQuality)
// together and then had to bolt an extra, separately-gated "marquee
// fixture" bonus on top just to give a famous team enough real weight -
// a patch that (once MLB's own star-power big-club list was added
// alongside its existing rivalry bonus) could blank a genuinely
// competitive small-market race out of the schedule for a week straight
// any time literally any bigger name played that day, because the patch's
// own undiluted +2 dwarfed the ~0.6-point gap the variety-rotation
// mechanism needs to treat two matchups as real rivals. Replaced with one
// clean, four-factor blend, no patch layer:
//   - FAME (40%) - is this a mainstream draw on name recognition alone
//     (a historic rivalry, a big-market/marquee franchise, national
//     broadcast placement)? See public/lib/objective-score.mjs's own
//     `watchability` - now a clean, unblended read of exactly this,
//     never mixed with skill/stakes/momentum and never gated by or capped
//     against competitiveness.
//   - QUALITY (30%) - how good are the two teams actually, independent of
//     tonight's own pairing (`skill` - the better team's own win%, so a
//     genuinely elite team gets credit even against a weak opponent).
//   - STAKES (20%) - how much does this game matter for the season/
//     championship race right now (`stakes` - playoff/seed/table-cutoff
//     proximity, maxed for a postseason game).
//   - CLOSENESS (10%) - how close is tonight's specific score expected to
//     be (`competitiveness`) - a real but minor factor: a coin-flip game
//     earns a little extra credit, but isn't the deciding signal the way
//     it used to be.
// `bestMatchScore` is a weighted blend of whichever of these four fields a
// match actually has, renormalized over just the present ones so a sport
// with no skill signal at all (F1 - see objective-score.mjs's own comment)
// still gets a real number built from what IS known, same "renormalize
// over what's present" posture public/lib/objective-score.mjs's own
// weightedAverage uses. Falls back to the build-time composite
// `match.score` only when NONE of these dimensions are set at all.
export const BEST_MATCH_WEIGHTS = {
  watchability: 0.4, // FAME - mainstream/TV draw on name recognition alone
  skill: 0.3, // QUALITY - how good the two teams actually are
  stakes: 0.2, // STAKES - how much this matters for the season/championship
  competitiveness: 0.1 // CLOSENESS - how close tonight's specific score is
};

function weightedBlend(pairs) {
  const present = pairs.filter(([value]) => Number.isFinite(value));
  if (!present.length) return null;
  const totalWeight = present.reduce((sum, [, weight]) => sum + weight, 0);
  return present.reduce((sum, [value, weight]) => sum + value * (weight / totalWeight), 0);
}

export function bestMatchScore(match) {
  const blended = weightedBlend([
    [match.watchability, BEST_MATCH_WEIGHTS.watchability],
    [match.skill, BEST_MATCH_WEIGHTS.skill],
    [match.stakes, BEST_MATCH_WEIGHTS.stakes],
    [match.competitiveness, BEST_MATCH_WEIGHTS.competitiveness]
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

  const baseScore = Number.isFinite(match.score) ? match.score : 0;
  const bestScore = bestMatchScore(match);
  // How much the unified Best-Match blend (fame + quality + stakes +
  // closeness, see bestMatchScore/BEST_MATCH_WEIGHTS above) moved the
  // number away from watchability alone - lets an explanation say "the
  // wider blend nudged this up/down by X" instead of just "the score is
  // Y", per docs/recommendation-engine-audit.md's stated goal of never
  // leaving an adjustment implicit. Fame (a rivalry, a marquee franchise,
  // national broadcast) is now folded directly into this blend at its own
  // 40% weight (see objective-score.mjs's own "watchability" - no separate,
  // undiluted bonus stacked on top of it any more, see BEST_MATCH_WEIGHTS'
  // own comment for why that patch was removed).
  const preBlendBase = Number.isFinite(match.watchability) ? match.watchability : match.score;
  const blendAdjustment = Number.isFinite(preBlendBase) ? bestScore - preBlendBase : 0;

  return {
    baseScore,
    bestMatchScore: bestScore,
    adjustments: {
      blend: Math.round(blendAdjustment * 1000) / 1000,
      priority: priorityNudge,
      service: serviceNudge
    },
    effectiveScore: bestScore + priorityNudge + serviceNudge
  };
}

// ---- Confidence -------------------------------------------------------------
//
// How much a match's score should actually be trusted - NOT a second
// opinion on whether the match itself is good, just on how solid the
// judgment behind it is. Every non-finished fixture gets the same
// deterministic objective score (public/lib/objective-score.mjs), so the
// only question left is whether a score was computed at all - a
// finished/never-scored fixture has none, hence null.
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
// day's schedule - scaled by enduranceScore (see objective-score.mjs's
// per-sport formulas for how it's computed).
export const ENDURANCE_DURATION_FLOOR = 0.4;
export function effectiveDurationMinutes(match) {
  const endurance = Number.isFinite(match.enduranceScore) ? match.enduranceScore : 5;
  const factor = ENDURANCE_DURATION_FLOOR + (1 - ENDURANCE_DURATION_FLOOR) * (endurance / 10);
  return match.durationMinutes * factor;
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
  //
  // ...but never LONGER than the game's own pre-game estimate
  // (`plannedDurationMinutes`, when the build supplied one). A finished game
  // can't block anything that starts after it ended - it's over - so its
  // real length only ever mattered for games that started while it was
  // still on, and a plan already made around it shouldn't be rewritten
  // because it ran long. Live-reported: Brewers @ Phillies ran 210 minutes
  // against a shorter estimate, which pushed its block into the 10:10
  // Padres @ Dodgers start, flipped that day's natural plan to a different
  // game after the fact, and broke the variety rotation for the whole
  // Brewers series (see computeVarietyRotation).
  if (match.isFinished) {
    return Number.isFinite(match.plannedDurationMinutes)
      ? Math.min(match.durationMinutes, match.plannedDurationMinutes)
      : match.durationMinutes;
  }
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

// Which of a day's previously shown plan picks (`planIds`, the ids of the
// last plan this browser rendered for that day - see app.js's
// state.dayPlanHistory) have already started, live or finished. Those are
// locked into every later plan for the day via computeDayPlan's own
// `lockedIds` option: a game the viewer was told to watch, and may already
// be watching or have watched, is history, not something a later refresh
// gets to re-decide. Without this, the whole day was re-planned from
// scratch on every refresh, and the moment a recommended game ended its
// score and scheduling block were rebuilt from ESPN's post-game feed (no
// pre-game line any more, standings already counting the result, the real
// duration instead of the estimate) - and after an app update or a
// reopen more than MATCH_SNAPSHOT_MAX_AGE_MS later, with none of the
// pre-game values left in memory to carry forward at all. That rescoring
// let a different game take the finished one's slot and reshuffled the
// rest of the day around it - live-reported as "a recommended game ended
// and it started recommending other games, killing the day's schedule".
// Upcoming picks are deliberately NOT locked: they're still free to
// improve with fresher data, just never at the expense of what already
// started.
export function startedPlanLockIds(planIds, dayMatches, now = Date.now()) {
  if (!planIds || !planIds.length) return new Set();
  const wanted = new Set(planIds);
  return new Set(
    dayMatches
      .filter(m => wanted.has(m.id) && !m.timeTbd && (m.isFinished || Date.parse(m.startTimeUtc) <= now))
      .map(m => m.id)
  );
}

// `lockedIds` (optional Set<matchId>, see startedPlanLockIds) - earlier
// plan picks that have already started. Each is forced into the plan the
// same way a pin is (its direct conflicts excluded, the free candidates
// scheduled around it), but it stays the SYSTEM's pick (推薦, never
// isPreferred), and a real viewer pin always wins over it: a lock whose
// block clashes with a pinned match is simply dropped, so swiping to a
// live alternative mid-game still works exactly as before.
export function computeDayPlan(
  dayKey,
  dayMatches,
  pinnedForDay = null,
  { scoreField = 'viewerScore', lockedIds = null, priorityPinnedIds = null } = {}
) {
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
  // Shared by both forcing passes below (a real pin, and a started-pick
  // lock): claim `match`'s own slot outright and exclude every OTHER
  // candidate that directly (isNearTotalOverlap) conflicts with it from
  // ever being scheduled elsewhere. Checked against the FULL candidate list
  // rather than just `match`'s own conflict cluster - equivalent, since a
  // direct near-total-overlap edge always puts both matches in the same
  // cluster to begin with (see groupIntoSlots), but one shared definition
  // of "force this in" instead of two separately maintained copies of it.
  const forcedIds = new Set();
  const excludedIds = new Set();
  function forceIntoPlan(match) {
    forcedIds.add(match.id);
    candidates.forEach(m => {
      if (m.id !== match.id && !forcedIds.has(m.id) && isNearTotalOverlap(m, match)) excludedIds.add(m.id);
    });
  }

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
  //
  // `pinnedForDay` can legitimately contain MORE THAN ONE member of the
  // same cluster - callers merge the viewer's own real pins together with
  // other forced-in ids from an entirely different mechanism (app.js's
  // pinnedForDayWithRotation unions a real pin with computeVarietyRotation's
  // own forced winner for that slot, see mergeVarietyForcedIds). Which one
  // "wins" the cluster then used to depend on nothing more than which
  // happened to sort first in `dayMatches` - live-reported directly: a
  // viewer's own swipe-to-pin (Cleveland Guardians @ Boston Red Sox)
  // visibly re-rendered (the card's own team logos flash on every
  // computeDayPlan-driven re-render) but the card silently snapped straight
  // back to the earlier-in-the-array incumbent (Milwaukee Brewers @
  // Philadelphia Phillies) every single time, on every input (drag AND the
  // dots), because that incumbent was ALSO the rotation's own separately-
  // forced pick for the exact same slot and simply sorted first. Confirmed
  // directly: computeDayPlan([brewers, cleveland], pinnedForDay =
  // {brewers, cleveland}) always returned brewers, regardless of viewer
  // intent, purely from array order.
  //
  // `priorityPinnedIds` breaks that tie in the viewer's favor: when a
  // cluster has more than one pinned candidate, whichever one is ALSO in
  // this set (the viewer's own real, un-merged pins - see app.js's
  // renderRecommendedSection) wins outright, no matter what else forced
  // its way into the same slot. Optional and additive - every existing
  // caller that doesn't pass it (computeVarietyRotation's own internal
  // planning, dump-day-plan.mjs, every test) keeps today's plain
  // first-in-`dayMatches` behavior exactly as before.
  clusters.forEach(cluster => {
    const clusterPinned = pinnedForDay ? cluster.members.filter(m => pinnedForDay.has(m.id)) : [];
    if (!clusterPinned.length) return;
    const pinnedMatch = (priorityPinnedIds && clusterPinned.find(m => priorityPinnedIds.has(m.id))) || clusterPinned[0];
    if (pinnedMatch) forceIntoPlan(pinnedMatch);
  });

  const pinnedIds = new Set(forcedIds);
  if (lockedIds && lockedIds.size) {
    const pinnedMatches = candidates.filter(m => pinnedIds.has(m.id));
    const clashes = (a, b) => {
      const ai = schedulingInterval(a);
      const bi = schedulingInterval(b);
      return ai.start < bi.end && bi.start < ai.end;
    };
    candidates
      .filter(m => lockedIds.has(m.id))
      .sort((a, b) => Date.parse(a.startTimeUtc) - Date.parse(b.startTimeUtc))
      .forEach(locked => {
        if (forcedIds.has(locked.id) || excludedIds.has(locked.id)) return;
        if (pinnedMatches.some(p => clashes(p, locked))) return;
        forceIntoPlan(locked);
      });
  }

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
    // the scheduler chose it on its own merits. A lock (see `lockedIds`)
    // is forced too, but it's the system's own earlier pick, so it isn't.
    choice.isPreferred = pinnedIds.has(choice.id);
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
    // Excluding any live-pick stickiness (see applyLiveExcitementBonus) -
    // that's a "don't switch away mid-game" nudge, not a real quality gap.
    const gapScore = m => getScore(m) - (m.liveStickyBonus || 0);
    const pickedScore = gapScore(choice);
    const alternatives = cluster.members.filter(
      m =>
        m.id !== choice.id &&
        !m.recommended &&
        // A finished game is never a real alternative to one that isn't -
        // there's nothing left to switch to. Offering it let a swipe pin a
        // game that was already over, which (rendered as a plain,
        // unswipeable 已結束 card) blocked every live game it overlapped
        // out of the plan with no way to swipe back.
        (choice.isFinished || !m.isFinished) &&
        isNearTotalOverlap(m, choice) &&
        pickedScore - gapScore(m) <= ALTERNATIVE_MAX_SCORE_GAP
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
// F1 session has no `competitors` (see match-builder.mjs's fetchF1Matches), so
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
//
// `stickyIds` (optional Set<matchId>) - live picks the plan already
// recommended once they were underway (see app.js's own
// state.liveStickyIds). Each still-live one gets LIVE_PICK_STICKY_BONUS on
// top, so a close game elsewhere can bump what's COMING UP next, but can't
// pull the game a viewer is already watching out of its slot mid-game.
//
// `{ live: false }` sets planningScore from the pre-game score alone (no
// live bonus, no stickiness) through this SAME rounding path - what
// app.js's variety rotation plans from. It must be this exact path, not a
// raw effectiveScore: two fixtures can tie after rounding while differing
// by ~1e-15 before it (6.85 vs 6.8499999...), and a rotation that saw the
// unrounded winner while the render saw a tie broke the other way let the
// same matchup be recommended two days running.
export function applyLiveExcitementBonus(dayMatches, stickyIds = null, { live = true } = {}) {
  dayMatches.forEach(match => {
    // Recomputed fresh every call (never accumulated) from match's own
    // CURRENT competitor scores - see liveExcitementBonus's own comment.
    const liveBonus = live ? liveExcitementBonus(match) : 0;
    match.liveExcitementBonus = liveBonus;
    match.liveStickyBonus = live && stickyIds && stickyIds.has(match.id) && isUnderway(match) ? LIVE_PICK_STICKY_BONUS : 0;
    match.planningScore =
      Math.round(((Number.isFinite(match.effectiveScore) ? match.effectiveScore : 0) + liveBonus + match.liveStickyBonus) * 1e6) / 1e6;
  });
}

// Twice the largest swing live excitement alone can cause (0 to
// LIVE_EXCITEMENT_MAX_BONUS on either side of a comparison), so no amount of
// live-score movement can flip a sticky live pick - only a viewer's own
// swipe (a hard pin) can. Never counted toward the stack's "is this
// alternative close enough to show" gap (see computeDayPlan), so a sticky
// pick's swipe stack keeps every alternative it had.
export const LIVE_PICK_STICKY_BONUS = LIVE_EXCITEMENT_MAX_BONUS * 2;

export function isUnderway(match, now = Date.now()) {
  if (match.isFinished) return false;
  const state = matchLifecycleState(match, now);
  return state === LIFECYCLE_STATES.LIVE || state === LIFECYCLE_STATES.ENDING_SOON;
}

// ---- Back-to-back variety (bounded, elite-exempt) --------------------------
//
// Direct feedback that the
// deterministic scheduler's own math will happily recommend the exact same
// matchup three (or more) real calendar days running whenever a live
// series/back-to-back naturally scores best every one of those days -
// "I don't like that, add variety... but real good games get kept, like
// the Dodgers @ Padres back-to-back game." This is a DELIBERATELY NARROWER
// reintroduction of the cross-day repeat penalty removed in Round 25 (see
// applyLiveExcitementBonus's own comment above) - that older version
// compared today's pick against ANY recent day in the whole window,
// including weekdays this viewer never watches, which is exactly what
// silently buried a genuinely great weekend game for a "variety" benefit
// nobody wanted. This version only ever looks at the REAL two immediately
// PRECEDING calendar days (VARIETY_MAX_FREE_REPEATS).
//
// Round 42: the first cut of this feature (isVarietyExempt keyed off an
// absolute `skill >= 7` bar) got the EXEMPTION criterion backwards - direct
// correction: "I want variety, because the Brewer time they got equal
// match ups[,] the dodger one in it's time it['s] the best[,] no
// alternative." A second attempt (exempt whenever `.alternativeIds` is
// merely non-empty) turned out too permissive on real data: San Diego
// Padres @ Los Angeles Dodgers DOES technically have an `.alternativeIds`
// entry every day (Houston Astros @ Seattle Mariners etc.) because
// ALTERNATIVE_MAX_SCORE_GAP (2.5, this file's own "worth a swipe" bar) is
// deliberately generous - but real live numbers show its actual margin
// over that alternative is 0.75-1.0, while Milwaukee Brewers @
// Philadelphia Phillies's own margin over ITS closest real rival is only
// 0.15-0.45 on the exact same days. VARIETY_CLOSE_CALL_GAP (0.5) sits
// directly in that real, observed gap (Brewers tops out at 0.45; Dodgers
// bottoms out at 0.75 across five real repeat days, 2026-09-22 through
// 09-27) - not an arbitrary number, a threshold chosen because a genuine
// dividing line exists there in this exact data.
//
// Raised to 0.6, still inside that same observed gap: a game that has
// already finished is re-scored from post-game data (the standings already
// count its result) and can land a little further from its series' top
// than it was pre-game - live case: Cleveland Guardians @ Boston Red Sox on
// 9/23, 0.6 behind Brewers @ Phillies once over, which at 0.5 fell out of
// the Brewers series' pool and flipped the rest of that series.
//
// Round 43: Round 41/42's model still only ever penalized the incumbent
// once it had already won twice, handing the NEXT day to whichever single
// alternative happened to be closest that specific day - it never gave
// more than one real alternative an actual turn, even when several
// existed across the whole repeat span. Direct correction: "it should
// first determine how many days, then see how many alternative, if there
// is alternative more than one, then three day mean each winning once."
// This replaces the penalize-the-incumbent model with an explicit
// ROTATION: find the whole maximal run of consecutive real calendar days
// a matchup would naturally win, find every OTHER matchup close enough
// (VARIETY_CLOSE_CALL_GAP) to it on any day of that run, and - once that
// pool has more than one member - cycle the win through every pool member
// once per day, for the length of the run (a 3-day run with 3 real
// contenders shows each of them exactly once, not the same one twice and
// an alternative once).
//
// This is only feasible because Match Find already has the WHOLE fetched
// window's own match data in hand before any single day renders - unlike
// Round 25's removed cross-day penalty (which only ever looked backward at
// history), this looks at the KNOWN, ALREADY-FETCHED remainder of a real
// multi-game series to plan the whole run's rotation at once, then each
// individual day's render just looks up its own assignment.
export const VARIETY_CLOSE_CALL_GAP = 0.6;

// Every match in `choice`'s own `.alternativeIds` (already gated by the
// wider, UI-facing ALTERNATIVE_MAX_SCORE_GAP - "worth a swipe") that is ALSO
// within VARIETY_CLOSE_CALL_GAP of `choice`'s own score - the tighter set
// that actually counts as "equal match ups" worth rotating into, not merely
// "technically swipeable". `byId` is a Map<matchId, match> for the same
// day `choice` came from.
function closeAlternativeMatches(choice, byId) {
  if (!Array.isArray(choice.alternativeIds) || !choice.alternativeIds.length) return [];
  const score = Number.isFinite(choice.planningScore) ? choice.planningScore : choice.effectiveScore;
  return choice.alternativeIds
    .map(id => byId.get(id))
    .filter(m => m && score - (Number.isFinite(m.planningScore) ? m.planningScore : m.effectiveScore) <= VARIETY_CLOSE_CALL_GAP + 1e-9);
}

// The one entry point: computes a whole-window rotation PLAN, without
// mutating anything the caller didn't already hand it to mutate.
// `matchesByDayKey` is a Map<dayKey, matches> covering the WHOLE relevant
// window (every calendar day worth considering, even one with zero
// matches - see this function's own comment below on why a gap day must
// still be present, as an empty array, rather than simply absent) -
// already however the caller wants it scored/filtered (sport filter,
// applyLiveExcitementBonus already run). `pinnedChoices` is
// state.pinnedChoices as-is (a Map<dayKey, Set<matchId>> or empty) - a
// viewer's own real pin is respected exactly like computeDayPlan's own
// `pinnedForDay` everywhere else, so rotation can never override a genuine
// swipe-to-pin (a pinned day simply can't be a middle day of a rotation
// run - see the run-detection loop below for why that falls out naturally
// rather than needing a special case).
//
// Mutates every match's own `.recommended`/`.alternativeIds`/etc. via the
// computeDayPlan passes it runs internally (same "pure scoring, this
// module mutates its OWN inputs in place" convention as the rest of this
// file) - but this is explicitly a PLANNING pass, not the real one: the
// caller is expected to re-run computeDayPlan itself afterward (with
// `applyVarietyRotationPenalties`'s own adjustment folded into
// `planningScore`) to get the actual, final result to render. Calling
// computeDayPlan twice on the same match objects is safe (see its own
// comment: every call fully resets `.recommended`/`.alternativeIds` at the
// top) - only the LAST call's result is left mutated onto the matches.
//
// Returns Map<dayKey, Set<matchId>> - the matchId(s) that must be FORCED
// to win their own slot that day so the rotation's own assignment
// actually happens (see this section's own Round 44 comment for why a
// hard force, not a score nudge). A day absent from the map needs no
// intervention at all - either no rotation run touches it, or its own
// natural winner already IS that day's assigned turn.
// Fri/Sat/Sun (by the viewer's own local calendar day - dayKeys are local
// dates, see app.js's localDateKey) - when the viewer actually has time to
// watch, per direct request: "I want the best match when it's closer to
// weekend, because that's when I actually watch those games". Only used to
// decide WHICH day of a rotated run each contender gets (see
// arrangeRunDays) - never whether a run rotates or who gets a turn.
export const WEEKEND_WEEKDAYS = new Set([5, 6, 0]);

export function isWeekendDayKey(dayKey) {
  return WEEKEND_WEEKDAYS.has(new Date(`${dayKey}T12:00:00Z`).getUTCDay());
}

// Final arrangement of a rotated run's already-decided assignment. Swaps two
// days' members (only when each is eligible for the other's day) whenever
// that strictly improves, in order of priority:
//   1. fewer back-to-back repeats of the same matchup - when a run has more
//      days than close contenders, someone plays twice, and the leftover-
//      day step above can hand it a day right next to its other one (a
//      Thu/Fri/Sat run with two contenders came out alt/best/best);
//   2. a stronger game on the weekend days (see WEEKEND_WEEKDAYS);
//   3. otherwise, stronger contenders on earlier days - ranked by each
//      one's best score across the whole run (`strengthOf`), not its score
//      on the one day, so a contender that's clearly the stronger of two
//      over the series goes first even on a day its own number dips.
// Only ever swaps, so every contender keeps exactly as many days as the
// matching gave it - who gets a turn is untouched, only the ORDER changes.
function arrangeRunDays(run, dayAssignedTo, closeMatchByDay, fixedDayKeys = new Set(), strengthOf = () => 0) {
  const dayKeys = run.entries.map(e => e.dayKey); // consecutive, in order
  if (dayKeys.length < 2) return;
  const scoreOn = (dayKey, member) => {
    const m = closeMatchByDay.get(dayKey).get(member);
    return Number.isFinite(m.planningScore) ? m.planningScore : m.effectiveScore;
  };
  const repeats = assignment => dayKeys.filter((dayKey, i) => i > 0 && assignment.get(dayKey) === assignment.get(dayKeys[i - 1])).length;
  const weekendTotal = assignment =>
    dayKeys.reduce((sum, dayKey) => (isWeekendDayKey(dayKey) ? sum + scoreOn(dayKey, assignment.get(dayKey)) : sum), 0);
  const better = (next, current) => {
    const r = repeats(next) - repeats(current);
    if (r !== 0) return r < 0;
    const w = weekendTotal(next) - weekendTotal(current);
    if (Math.abs(w) > 1e-9) return w > 0;
    // Strict at every step, so this always terminates.
    for (const dayKey of dayKeys) {
      const d = strengthOf(next.get(dayKey)) - strengthOf(current.get(dayKey));
      if (Math.abs(d) > 1e-9) return d > 0;
    }
    return false;
  };

  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < dayKeys.length && !improved; i += 1) {
      for (let j = i + 1; j < dayKeys.length && !improved; j += 1) {
        const [a, b] = [dayKeys[i], dayKeys[j]];
        if (fixedDayKeys.has(a) || fixedDayKeys.has(b)) continue; // a started pick never moves
        const memberA = dayAssignedTo.get(a);
        const memberB = dayAssignedTo.get(b);
        if (memberA === memberB) continue;
        if (!closeMatchByDay.get(a).has(memberB) || !closeMatchByDay.get(b).has(memberA)) continue;
        const swapped = new Map(dayAssignedTo);
        swapped.set(a, memberB);
        swapped.set(b, memberA);
        if (better(swapped, dayAssignedTo)) {
          dayAssignedTo.set(a, memberB);
          dayAssignedTo.set(b, memberA);
          improved = true;
        }
      }
    }
  }
}

// `lockedByDay` (optional Map<dayKey, Set<matchId>>, see startedPlanLockIds)
// - plan picks that have already started. A run day holding one keeps it:
// that day is fixed to the locked matchup before anything else is decided,
// and that matchup doesn't get a second day of the run, so the rest of the
// series rotates around what the viewer was already shown instead of
// re-deciding it from after-the-fact scores.
export function computeVarietyRotation(matchesByDayKey, pinnedChoices = new Map(), lockedByDay = new Map()) {
  const dayKeys = [...matchesByDayKey.keys()].sort();
  const byIdByDay = new Map();
  const naturalPicksByDay = new Map();

  dayKeys.forEach(dayKey => {
    const dayMatches = matchesByDayKey.get(dayKey);
    // Deliberately WITHOUT `lockedByDay`: a run is "the same matchup keeps
    // winning its slot on its own merits", and a locked day that went to a
    // rotation alternative would otherwise break the run apart right there
    // and let the next day hand that same alternative a second turn. Locks
    // are applied per run below instead (fixedDays).
    computeDayPlan(dayKey, dayMatches, pinnedChoices.get(dayKey), { scoreField: 'planningScore' });
    byIdByDay.set(dayKey, new Map(dayMatches.map(m => [m.id, m])));
    naturalPicksByDay.set(dayKey, dayMatches.filter(m => m.recommended));
  });

  // Maximal consecutive runs, per matchupKey - a day genuinely missing from
  // `matchesByDayKey` entirely (never happens; the caller is expected to
  // include every day, even an empty array for one with no fixtures at
  // all - see this function's own top comment) would otherwise silently
  // stitch two runs across a real gap day together, which is why an empty
  // day still needs to be present here: its own empty `naturalPicksByDay`
  // entry correctly closes every active run that day.
  const completedRuns = [];
  let active = new Map(); // matchupKey -> { matchupKey, entries: [{dayKey, match}] }
  dayKeys.forEach(dayKey => {
    const picks = naturalPicksByDay.get(dayKey);
    const todaysPickByKey = new Map(picks.map(p => [matchupKey(p), p]));
    [...active.entries()].forEach(([mk, run]) => {
      if (!todaysPickByKey.has(mk)) {
        completedRuns.push(run);
        active.delete(mk);
      }
    });
    todaysPickByKey.forEach((match, mk) => {
      if (!active.has(mk)) active.set(mk, { matchupKey: mk, entries: [] });
      active.get(mk).entries.push({ dayKey, match });
    });
  });
  completedRuns.push(...active.values());

  const result = new Map();
  function addForced(dayKey, matchId) {
    if (!result.has(dayKey)) result.set(dayKey, new Set());
    result.get(dayKey).add(matchId);
  }

  completedRuns.forEach(run => {
    if (run.entries.length < 2) return; // never even repeated - nothing to rotate
    // The pool: this run's own matchupKey, plus every OTHER matchupKey
    // that was a genuinely close alternative on AT LEAST ONE day of the
    // run - a matchup that was only ever close on day 2 still earns a
    // pool seat (and therefore a turn), the same as one close every day.
    // `eligibleDaysByMember` is the same information indexed the other
    // way - which days each pool member could actually win on, which is
    // exactly what the matching below needs.
    const poolKeys = new Set([run.matchupKey]);
    const closeMatchByDay = new Map(); // dayKey -> Map<matchupKey, match>
    const eligibleDaysByMember = new Map(); // matchupKey -> Set<dayKey>
    run.entries.forEach(({ dayKey, match }) => {
      const byId = byIdByDay.get(dayKey);
      // The run's own matchupKey is trivially eligible every day of the
      // run (it's the natural winner there) - every OTHER member is only
      // eligible on the specific days it was actually a close rival.
      const map = new Map([[run.matchupKey, match]]);
      closeAlternativeMatches(match, byId).forEach(alt => {
        poolKeys.add(matchupKey(alt));
        map.set(matchupKey(alt), alt);
      });
      closeMatchByDay.set(dayKey, map);
      map.forEach((m, key) => {
        if (!eligibleDaysByMember.has(key)) eligibleDaysByMember.set(key, new Set());
        eligibleDaysByMember.get(key).add(dayKey);
      });
    });
    // Drop any OTHER member (never the run's own matchupKey) that's only
    // ever close on a SINGLE day of the run - it isn't a recurring rival to
    // rotate into, just a coincidence: some unrelated game that happened to
    // overlap the incumbent's slot on the one day it's actually scheduled,
    // with a score that happened to fall inside the generous
    // VARIETY_CLOSE_CALL_GAP window. There's no "variety" value in it (a
    // run rotates BECAUSE the same matchup keeps recurring; a one-off has
    // nothing to recur INTO), and including it anyway risks it displacing a
    // genuine, multi-day rival for the one day they both happen to want -
    // live case: Miami Marlins @ Chicago Cubs (eligible only on the single
    // day it plays) claimed the incumbent Milwaukee Brewers @ Philadelphia
    // Phillies's own opening day over Cleveland Guardians @ Boston Red Sox
    // (eligible, like the incumbent, on every day of the run - a real
    // 3-game series), even though Guardians was the clearly stronger real
    // rival. A day this drops a member's only entry from still correctly
    // shows nothing else close there (closeMatchByDay, used for
    // alternativeIds/arrangeRunDays, is untouched - only pool MEMBERSHIP,
    // i.e. whether it can be handed a day of its own, is affected).
    [...poolKeys].forEach(key => {
      if (key !== run.matchupKey && eligibleDaysByMember.get(key).size < 2) poolKeys.delete(key);
    });
    // Days already fixed by a started pick (see `lockedByDay` above): the
    // locked match is either the run's own game or one of its direct
    // conflicts - one in some unrelated slot that day doesn't touch this run.
    const fixedDays = new Map(); // dayKey -> matchupKey
    run.entries.forEach(({ dayKey, match }) => {
      const locks = lockedByDay.get(dayKey);
      if (!locks || !locks.size) return;
      const locked = [...locks].map(id => byIdByDay.get(dayKey).get(id)).find(m => m && (m.id === match.id || isNearTotalOverlap(m, match)));
      if (!locked) return;
      const key = matchupKey(locked);
      poolKeys.add(key);
      closeMatchByDay.get(dayKey).set(key, locked);
      if (!eligibleDaysByMember.has(key)) eligibleDaysByMember.set(key, new Set());
      eligibleDaysByMember.get(key).add(dayKey);
      fixedDays.set(dayKey, key);
    });
    // A real broadcaster's own editorial choice (`match.isNationalBroadcast`
    // - see match-builder.mjs's own comment on where this comes from and
    // why EPL never sets it) gets the same standing an uncontested "no
    // alternative" incumbent already has: locked to whichever candidate it
    // was for that day, never traded away for a same-slot rival just
    // because the rival's own score happened to land inside
    // VARIETY_CLOSE_CALL_GAP. Direct instruction: "look at what actual TV
    // networks and public media actually push" - a network already
    // deciding this is THE game to air nationally on this specific day is
    // real-world ground truth, not something this scheduler's own variety
    // preference should override. Checks every candidate already known for
    // that day (the run's own incumbent AND every close rival in
    // `closeMatchByDay`), not just the incumbent - the real pick some days
    // could just as easily be the rival, not the matchup that happens to
    // win this scheduler's own race. Skips a day a started pick already
    // fixed above (that's real, already-happened history and takes
    // priority over a pre-game broadcast fact).
    run.entries.forEach(({ dayKey }) => {
      if (fixedDays.has(dayKey)) return;
      const nationalPick = [...closeMatchByDay.get(dayKey)].find(([, m]) => m.isNationalBroadcast);
      if (nationalPick) fixedDays.set(dayKey, nationalPick[0]);
    });
    if (poolKeys.size < 2) return; // genuinely nothing else close, on any day - nothing to rotate (the real Padres @ Dodgers case)

    // Round 44: "if Brewer win day three outright then day one should be
    // someone else" - a fixed `pool[i % pool.length]` rotation (Round 43's
    // first cut) always gave day 1 to the run's own matchupKey regardless
    // of what happened on later days, so a later day falling back to the
    // incumbent (because that day's OWN assigned pool member wasn't
    // actually close then) meant the incumbent won TWICE while some other
    // real contender never won at all - exactly the double-booking
    // reported. This replaces the fixed rotation with a proper maximum
    // bipartite matching (Kuhn's algorithm - days on one side, pool
    // members on the other, an edge wherever `eligibleDaysByMember` says a
    // member could win that day): it finds the assignment that covers as
    // many DISTINCT pool members as possible, so a day only "reuses" a
    // member already assigned elsewhere when the run truly has more pool
    // members than days can otherwise accommodate, never merely because
    // the naive day-index happened to land on that member.
    //
    // Best pre-game score each member reaches on any of its eligible days -
    // what decides the order members are placed in (see membersByStrength
    // below).
    const bestScoreByMember = new Map();
    closeMatchByDay.forEach(map =>
      map.forEach((m, key) => {
        const score = Number.isFinite(m.planningScore) ? m.planningScore : m.effectiveScore;
        if (!(bestScoreByMember.get(key) >= score)) bestScoreByMember.set(key, score);
      })
    );
    // Strongest first, so when a run has more contenders than days the one
    // left out is always the weakest. This used to go scarcest-first (fewest
    // eligible days), which let a borderline contender that was only close
    // on one day - live case: Cincinnati Reds @ Toronto Blue Jays, 6.45,
    // exactly on the VARIETY_CLOSE_CALL_GAP edge - claim that day ahead of a
    // much stronger one (Baltimore Orioles @ New York Yankees, 6.85), which
    // then never got a day at all. Ties go to the run's own matchup, then to
    // whoever was close on more days of the run (a steadier contender), then
    // by name.
    const membersByStrength = [...poolKeys].sort((a, b) => {
      const scoreDiff = (bestScoreByMember.get(b) ?? 0) - (bestScoreByMember.get(a) ?? 0);
      if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
      if (a === run.matchupKey) return -1;
      if (b === run.matchupKey) return 1;
      return eligibleDaysByMember.get(b).size - eligibleDaysByMember.get(a).size || a.localeCompare(b);
    });
    const dayAssignedTo = new Map(fixedDays); // dayKey -> matchupKey (the assignment result so far)
    const fixedMembers = new Set(fixedDays.values());
    const openDaysOf = member => [...eligibleDaysByMember.get(member)].filter(dayKey => !fixedDays.has(dayKey)).sort();
    // Takes its earliest FREE day first, and only then tries bumping
    // someone, so members settle in strength order day by day (a run's own
    // matchup keeps its first day when nothing else decides) instead of
    // reshuffling earlier placements for no reason. Bumping itself - the
    // standard Kuhn's-algorithm augmenting-path step, moving a
    // already-placed member to a DIFFERENT one of its OWN eligible days to
    // make room - is safe here specifically BECAUSE `poolKeys` was already
    // filtered, just above, to drop any member that isn't a genuine
    // multi-day rival (a one-off single-day coincidence has no seat to
    // bump anyone OUT of in the first place). Every member left in
    // `membersByStrength` is a real, recurring contender the run's own
    // days should be fairly split between - live case: Cleveland Guardians
    // @ Boston Red Sox (a real 3-game series against the incumbent) has to
    // be able to bump Milwaukee Brewers @ Philadelphia Phillies off a day
    // that a started pick elsewhere in the run has already claimed, or it
    // can be squeezed out of every day entirely just because Brewers
    // (stronger, and processed first) happened to claim its own only
    // remaining shared day first.
    function tryAssign(member, visitedDays) {
      const days = openDaysOf(member);
      const free = days.find(dayKey => !dayAssignedTo.has(dayKey));
      if (free) {
        dayAssignedTo.set(free, member);
        return true;
      }
      for (const dayKey of days) {
        if (visitedDays.has(dayKey)) continue;
        visitedDays.add(dayKey);
        const current = dayAssignedTo.get(dayKey);
        // Its current occupant can be bumped to a DIFFERENT one of ITS OWN
        // eligible days (the standard augmenting-path step) - only then
        // does `member` get to claim it.
        if (tryAssign(current, visitedDays)) {
          dayAssignedTo.set(dayKey, member);
          return true;
        }
      }
      return false;
    }
    membersByStrength.filter(member => !fixedMembers.has(member)).forEach(member => tryAssign(member, new Set()));

    // The matching above can only ever cover min(days, pool members) of
    // the run's own days - if the pool is BIGGER than the run (as in the
    // real Brewers @ Phillies case: a 4-member pool over a 3-day run),
    // every day still gets assigned above (there are enough days to match
    // 3 of the 4 members 1:1), so this loop is a no-op there. It only ever
    // does real work the other way around - a run LONGER than its own
    // pool (e.g. a 5-day series with only 2 real contenders) - where the
    // leftover days beyond what a 1:1 matching can cover fall back to
    // whichever eligible member has won the FEWEST days so far, spreading
    // any unavoidable repeat out evenly rather than dumping every leftover
    // day on the same member.
    const winCount = new Map([...poolKeys].map(key => [key, 0]));
    dayAssignedTo.forEach(member => winCount.set(member, winCount.get(member) + 1));
    run.entries.forEach(({ dayKey }) => {
      if (dayAssignedTo.has(dayKey)) return;
      // Restricted to `poolKeys` - a single-day member dropped just above
      // isn't in `winCount` at all, and letting it through here would leave
      // this exactly where that filtering was trying to avoid.
      const eligible = [...closeMatchByDay.get(dayKey).keys()].filter(key => poolKeys.has(key));
      const chosen = eligible[0];
      dayAssignedTo.set(dayKey, chosen);
      winCount.set(chosen, winCount.get(chosen) + 1);
    });

    arrangeRunDays(run, dayAssignedTo, closeMatchByDay, new Set(fixedDays.keys()), member => bestScoreByMember.get(member) ?? 0);

    // Every day of a rotated run is forced - INCLUDING the days the
    // incumbent keeps. Leaving those "to happen naturally" assumed the
    // render would land on the same natural winner this pass saw, but any
    // difference between the two (an exact tie broken the other way, a
    // live bonus on today's render only) silently handed the incumbent's
    // day to the alternative that was ALREADY forced in on another day -
    // the same matchup recommended two days running, exactly what this
    // exists to prevent (live-reported: Orioles @ Yankees on both 9/26 and
    // 9/27). Forcing the whole assignment makes the render follow it.
    run.entries.forEach(({ dayKey }) => {
      const assignedKey = dayAssignedTo.get(dayKey);
      addForced(dayKey, closeMatchByDay.get(dayKey).get(assignedKey).id);
    });
  });

  return result;
}

// Round 44: forcing a rotation assignment by PENALIZING the incumbent's
// `planningScore` (this section's own first cut) only ever guaranteed the
// incumbent LOST - not that the intended rotation winner in particular
// WON. Live-observed failure: penalizing Milwaukee Brewers @ Philadelphia
// Phillies to hand its day to Cleveland Guardians @ Boston Red Sox instead
// actually handed the slot to Tampa Bay Rays @ New York Yankees - a
// candidate outside the rotation's own pool entirely, because the day's
// OTHER scheduling constraints (weightedIntervalSchedule re-solving the
// whole day fresh once a score changes) fit it slightly better once
// Brewers dropped. A soft nudge can't account for that; only an outright
// FORCE can. `mergeVarietyForcedIds` merges computeVarietyRotation's own
// forced id(s) for a day into the SAME `pinnedForDay` shape a real
// viewer's own swipe-to-pin already uses, so the assignment wins its slot
// unconditionally (forcedIds' own `excludedIds` mechanism also correctly
// excludes any other near-total-overlap conflict, exactly like a real pin
// would) - never merely "probably wins once nudged".
export function mergeVarietyForcedIds(pinnedForDay, forcedIds) {
  if (!forcedIds || !forcedIds.size) return pinnedForDay;
  return new Set([...(pinnedForDay ? [...pinnedForDay] : []), ...forcedIds]);
}

// computeDayPlan's own forcedIds mechanism marks EVERY forced pick as
// `.isPreferred` (indistinguishable from a real viewer swipe-to-pin), which
// would render a system decision as 偏好 "Prefer" instead of 推薦
// "Recommended". Call this immediately after the real, final
// computeDayPlan pass (the one using `mergeVarietyForcedIds`'s own merged
// pin set) to put the correct `.isPreferred = false` back on every id
// THIS rotation forced in - `pinnedForDay` is the viewer's own REAL pins
// for the day, checked so an id that happens to be both rotation-forced
// AND genuinely pinned (the viewer swiped there themselves) still keeps
// its true 偏好 tag.
export function clearRotationIsPreferred(dayMatches, forcedIds, pinnedForDay) {
  if (!forcedIds || !forcedIds.size) return;
  const realPins = pinnedForDay instanceof Set ? pinnedForDay : new Set(pinnedForDay || []);
  dayMatches.forEach(match => {
    if (forcedIds.has(match.id) && !realPins.has(match.id)) match.isPreferred = false;
  });
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
