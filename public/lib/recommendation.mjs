// ---- public/lib/recommendation.mjs ----
//
// The pure, viewer-relative-clock-aside, DOM-free half of "what's worth
// watching": turning a fixture's AI scores (competitiveness/watchability/
// broadcastQuality/enduranceScore - all decided once at build time, see
// scripts/build-data.mjs) into a day's back-to-back viewing plan, plus the
// score/confidence bookkeeping that decision is built from.
//
// Extracted out of public/app.js (which still owns everything DOM/
// localStorage/render-related) so this logic can be:
//   - imported by scripts/build-data.mjs too (confidence is computed once,
//     at build time, from the same source/refined signals the cache already
//     tracks - see computeConfidence below), and
//   - unit-tested directly with Node's built-in test runner (see
//     tests/recommendation.test.mjs) without needing a DOM.
//
// Nothing in this file reads or writes localStorage, the network, or the
// DOM - every function here is a pure function of its arguments (aside from
// isQuietHours/effectiveInterval/isEvidenceFresh's own use of the current
// wall clock via `new Date`, which is inherent to "is this match on right
// now"/"is this evidence still current", not a hidden dependency on
// outside state).
//
// The viewing-plan pipeline (see docs/recommendation-engine-audit.md for
// the fuller writeup this follows) is deliberately one straight line:
//   raw AI scores -> effectiveScore (viewer preference) -> planningScore
//   (+ cross-day repeat penalty) -> schedulingInterval (duration
//   uncertainty + transition buffer) -> computeDayPlan's scheduler -> the
//   day's picks -> conflict clusters (presentation only, computed AFTER
//   scheduling, never before it)
// No step secretly does another step's job: scoring never decides
// timing, and the scheduler never re-judges how good a match is.

// ---- Broadcast service registry -------------------------------------------
//
// `whereToWatchTw` (see the shared proxy's /match-recommend) is free-form
// text written by Gemini, not a fixed enum - this registry is what turns
// that text back into a stable id, both for app.js's badge rendering and
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
// pairing - see scripts/objective-score.mjs's skillFromWinPct), genuine
// COMPETITIVENESS (how CLOSE tonight's specific pairing is - competitiveness
// - plus whether those stakes actually stay meaningful all the way through
// rather than just at kickoff - enduranceScore), and broad ENTERTAINMENT/
// public attention (watchability - itself already folded together from the
// deterministic objective score AND Gemini's own real-world-knowledge/
// search-grounded validation pass, see build-data.mjs's fetchAiScores and
// the shared proxy's own mediaAttention evidence category - plus
// broadcastQuality's production-quality signal) - never a match that only
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
// present" posture scripts/objective-score.mjs's own weightedAverage uses.
// Falls back to the build-time composite `match.score` only when NONE of
// these dimensions are set at all (nothing left to blend).
export const BEST_MATCH_WEIGHTS = {
  skill: 0.2, // how good the two teams actually are
  competitiveness: 0.2, // how close tonight's specific pairing is
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
      service: serviceNudge
    },
    effectiveScore: bestScore + priorityNudge + serviceNudge
  };
}

// ---- Confidence -------------------------------------------------------------
//
// How much a match's score should actually be trusted - NOT a second
// opinion on whether the match itself is good, just on how solid the
// evidence behind that judgment is. Deliberately coarse and grounded in
// exactly what scripts/build-data.mjs's AI score cache already tracks
// (`source`, `refined`) rather than fabricating precision the pipeline has
// no actual data for - see docs/recommendation-engine-audit.md's "known
// limitations" for why this isn't the fuller freshness-decay/feature-
// completeness model a from-scratch design might use (there's no per-
// feature fetchedAt timestamp anywhere in this pipeline to decay against
// yet, so pretending otherwise would just be a more precise-looking guess).
//
//   - 'finished': no score was ever computed (see build-data.mjs) - null,
//     not a number, since "how confident is this score" is meaningless
//     when there isn't one.
//   - 'ai' + refined: a deterministic, real-data objective score (see
//     build-data.mjs's computeMatchObjectiveScore/scripts/objective-score.mjs)
//     validated by Gemini PLUS a second, comparative pass against its
//     specific contested neighbors (see build-data.mjs's
//     refineContestedClusters) - the strongest evidence this pipeline ever
//     produces for a match.
//   - 'ai', not refined: the same objective score, validated by one
//     independent Gemini pass, but never cross-checked against its own
//     neighbors.
//   - 'api-objective': the objective score on its own, with a zero
//     adjustment - PROXY_URL was unset, the call failed, or this fixture is
//     still waiting its turn (see build-data.mjs's needsScoring/throttling).
//     Real, current, statistically-grounded data (season record, recent
//     form, standings proximity, betting odds - see
//     scripts/objective-score.mjs), just without Gemini's own validation
//     pass on top yet - meaningfully more trustworthy than the OLD
//     win-loss-only 'heuristic' fallback this replaced (see below), but
//     still a notch below anything Gemini has actually looked at.
//   - 'heuristic': retained only so an OLDER cached/exported match (from
//     before this pipeline's API-data rewrite) still maps to a sensible
//     confidence value rather than falling through to null - no build
//     produces this source value anymore.
export const CONFIDENCE_BY_SOURCE = {
  finished: null,
  aiRefined: 0.9,
  ai: 0.75,
  apiObjective: 0.55,
  heuristic: 0.35
};

export function computeConfidence(match) {
  if (!match || match.source === 'finished' || match.source == null) return CONFIDENCE_BY_SOURCE.finished;
  if (match.source === 'ai') return match.refined ? CONFIDENCE_BY_SOURCE.aiRefined : CONFIDENCE_BY_SOURCE.ai;
  if (match.source === 'api-objective') return CONFIDENCE_BY_SOURCE.apiObjective;
  if (match.source === 'heuristic') return CONFIDENCE_BY_SOURCE.heuristic;
  return null;
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
    // needs same-day scheduling context and cross-day repeat history
    // (see applyRecentRepeatPenalties below), which a single match has no
    // way to know on its own.
    eventScore: breakdown.baseScore,
    viewerScore: breakdown.effectiveScore
  };
}

// ---- Structured evidence -----------------------------------------------
//
// scripts/build-data.mjs's cache stores each match's `evidence` (a small
// array of {category, finding, source, retrievedAt} - see that script's
// EVIDENCE_CATEGORIES/sanitizeCachedEvidenceItem, and the shared proxy's
// own worker.js for where it's actually produced) and surfaces it, along
// with `evidenceRetrievedAt` (the most recent item's own timestamp), onto
// every match this module's resolveViewingPlan hands back - both fields
// pass straight through resolveViewingPlan's own `{...match, ...}` spread
// with no extra work needed there. This section is what turns that raw
// array into something a caller (app.js's buildMatchCard, or a future UI)
// can render without re-deriving the same grouping/labels itself, and
// gives "how current is this" its own explicit signal - separate from
// confidence (which is about how much the SCORE should be trusted, not how
// current the evidence behind it is; see computeConfidence's own "refined
// does not mean current" comment above).
export const EVIDENCE_CATEGORY_LABELS = {
  competitiveness: '競爭力',
  mediaAttention: '媒體關注度',
  eventImportance: '重要性',
  recentContext: '近況'
};

// A display-ready form of match.evidence - never mutates or re-validates
// the array itself (scripts/build-data.mjs already did that before it ever
// reached matches.json), just attaches the Traditional Chinese label a
// caller would otherwise have to look up in EVIDENCE_CATEGORY_LABELS
// itself. Returns [] for a match with no evidence, same "explicit empty,
// not absent" convention the rest of this pipeline uses.
export function describeEvidence(match) {
  if (!Array.isArray(match?.evidence) || !match.evidence.length) return [];
  return match.evidence.map(item => ({
    category: item.category,
    label: EVIDENCE_CATEGORY_LABELS[item.category] || EVIDENCE_CATEGORY_LABELS.recentContext,
    finding: item.finding,
    source: item.source,
    retrievedAt: item.retrievedAt
  }));
}

// How long a match's own evidence stays "fresh" for display purposes -
// intentionally the same threshold build-data.mjs's own
// EVIDENCE_MAX_AGE_HOURS uses to decide when to actually re-fetch, so a
// viewer is never shown a "current as of..." claim that the build pipeline
// itself would already consider stale enough to be retrying.
export const EVIDENCE_FRESH_MAX_AGE_HOURS = 24;

// True when match.evidenceRetrievedAt exists and is within
// EVIDENCE_FRESH_MAX_AGE_HOURS of right now - reads the wall clock via
// `new Date`, the same documented exception this file's own top comment
// already carves out for isQuietHours/effectiveInterval ("is this current
// right now" is inherently relative to the current moment, not a hidden
// dependency on outside state). A match with no evidence at all is never
// "fresh" - there's nothing to be fresh.
export function isEvidenceFresh(match, maxAgeHours = EVIDENCE_FRESH_MAX_AGE_HOURS) {
  if (!match?.evidenceRetrievedAt) return false;
  const ageMs = Date.now() - Date.parse(match.evidenceRetrievedAt);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeHours * 60 * 60 * 1000;
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
export const DURATION_OVERRUN_BUFFER_BY_RELIABILITY = { high: 0, medium: 0.1, low: 0.25 };

// A small, deliberately flat realism buffer between two back-to-back picks
// (see docs/recommendation-engine-audit.md's "no transition buffer" bug) -
// two matches that are technically non-overlapping down to the minute
// (one ends exactly when the next starts) still aren't a plan a real
// viewer can execute. Kept small and sport-independent on purpose - the
// goal is closing that one gap, not making scheduling broadly conservative.
export const TRANSITION_BUFFER_MINUTES = 10;

// How much of a match's schedule block a LATER pick actually has to wait
// out. Starts from effectiveDurationMinutes (the endurance-based "still
// worth watching" judgment - a genuine blowout can still free the slot up
// sooner, that's unchanged and unrelated to the fix below) and then PADS
// it, never shrinks it further, by this sport's own real-clock overrun
// risk (see DURATION_OVERRUN_BUFFER_BY_RELIABILITY) - the scheduling
// number can never end up SMALLER than the value judgment that produced it
// in the first place, only equal (high-reliability sports) or larger
// (a no-clock sport padded for its own real overrun risk). This is
// deliberately the ONLY duration figure the scheduler itself ever reads
// (see schedulingInterval) - there is no second, separately-tuned notion
// of "how long is this event" anywhere else in the planner.
export function schedulingDurationMinutes(match) {
  // A FINISHED match's own durationMinutes (see build-data.mjs's
  // finishedDurationMinutes) is already the real observed elapsed time as
  // of the last fetch, not a pre-game guess - there is no forward
  // uncertainty left to hedge once ESPN itself confirms the fixture is
  // over, so the overrun buffer below only ever applies to a match that
  // HASN'T finished yet. Without this, a no-clock sport's game that
  // genuinely ran SHORT (the reported "obvious continuation" bug: a game
  // that dropped 30-60 minutes off its own predicted length) still got its
  // already-real, already-short duration padded by another 25% on top,
  // reserving time for overrun risk that had already definitively NOT
  // happened - exactly what kept blocking a next match that could clearly,
  // obviously follow it in real life.
  const overrun = match.isFinished
    ? 0
    : DURATION_OVERRUN_BUFFER_BY_RELIABILITY[resolveSportTiming(match.sport).durationReliability] ?? 0;
  return effectiveDurationMinutes(match) * (1 + overrun);
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
// scripts/sport-duration.mjs's predictions are necessarily PRE-GAME
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
// instead (see applyRecentRepeatPenalties) so a soft cross-day repeat
// penalty can steer WHICH sequence wins without needing a second copy of
// this function, or mutating effectiveScore itself (see Invariant 4 in
// docs/recommendation-engine-audit.md - a diversity penalty can reduce a
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
    // A viewer-preference/variety penalty (priority nudge, cross-day repeat,
    // sport concentration - see applyRecentRepeatPenalties) is a
    // TIE-BREAKER between competing alternatives, never a verdict that a
    // fixture isn't worth watching at all - but the raw DP as "maximize
    // total score of chosen non-overlapping items" doesn't know that
    // distinction: if enough stacked penalties push a candidate's own score
    // negative, ADDING it to an otherwise-empty, genuinely non-conflicting
    // slot makes the running total go DOWN, so the unfloored DP would
    // rather recommend NOTHING there at all - discarding a fixture that
    // costs the viewer literally nothing to also watch, for no real reason.
    // This was the direct cause of a reported bug: a day with a perfectly
    // fine, non-overlapping evening fixture ended up with only one
    // recommended match because that fixture's stacked penalties (repeat +
    // sport-concentration + a low sport-priority rank) happened to net
    // negative. Flooring here means a non-conflicting candidate can only
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
  // it alone represents its conflict cluster now, so EVERY OTHER member of
  // that same cluster is excluded, not just whichever ones directly
  // (pairwise) near-totally overlap the pin. An earlier version excluded
  // only the direct pairwise overlaps, on the theory that a member which
  // doesn't itself conflict with the pin should stay a normal free
  // candidate the planner can still schedule elsewhere. In practice that
  // broke the swipeable card stack itself: a 3+ member chain cluster (A-B
  // near-total-overlap, B-C near-total-overlap, but A and C NOT direct
  // overlapping each other) presents as ONE 3-card "pick one of these"
  // stack, backed by the fact that with no pin the DP naturally picks only
  // one of the three (whichever has the best single/combined value). The
  // moment a viewer swiped to pin the lowest-scored, non-adjacent member
  // (C), forcing it in let the DP ALSO freely re-add the other end of the
  // chain (A) purely because forcing a pick skips the "is this worth it"
  // comparison altogether - the result was BOTH A and C independently
  // "recommended", silently fracturing the single 3-member stack the
  // viewer was mid-swipe on into two separate 2-member stacks (a jarring
  // "swipe to the last card and the dots jump/shrink" regression - see
  // README). A pin's whole point is "I am committing to this cluster's
  // choice being exactly this one" - so it now always owns the full
  // cluster, keeping every stack's member set stable across every pin.
  const forcedIds = new Set();
  const excludedIds = new Set();
  clusters.forEach(cluster => {
    const pinnedId = pinnedForDay && pinnedForDay.get(slotKeyFromMembers(cluster.members));
    if (!pinnedId) return;
    const pinnedMatch = cluster.members.find(m => m.id === pinnedId);
    if (!pinnedMatch) return;
    forcedIds.add(pinnedMatch.id);
    cluster.members.forEach(m => {
      if (m.id !== pinnedMatch.id) excludedIds.add(m.id);
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
  // every other member of a picked match's own conflict cluster that the
  // scheduler didn't also independently pick. A match is never both
  // recommended and listed as someone else's alternative (docs/
  // recommendation-engine-audit.md's Invariant 1).
  //
  // slotKey is the FULL cluster's own stable key (every member, whether or
  // not it ended up recommended) - deliberately NOT derived from whatever
  // subset a particular card's stack happens to display. A cluster of 3+
  // near-total-overlapping matches where the scheduler independently
  // recommends more than one of them (e.g. two matches that only each
  // conflict with a third, not with each other - see Test 3's A/B/C in
  // recommendation.test.mjs) renders as TWO separate swipeable stacks, one
  // per recommended pick, each showing only the leftover match as its own
  // alternative. Both stacks are really the same underlying conflict
  // cluster, though, and app.js's pinSlotChoice has to record a pin under
  // the key computeDayPlan will actually look up on the next render
  // (pinnedForDay.get(slotKeyFromMembers(cluster.members)) above, always
  // the full cluster) - keying off only the 2 matches visible in whichever
  // stack the viewer happened to swipe would silently never match that
  // lookup, so the pin would appear to take (the swipe animates, the dot
  // updates) but get thrown away on the very next render, reverting right
  // back. Exposing the real key here, once, is what makes every stack for
  // the same cluster agree on where a pin against it lives.
  picks.forEach(({ choice }) => {
    const cluster = clusterByMatchId.get(choice.id);
    if (!cluster || cluster.members.length < 2) return;
    choice.slotKey = slotKeyFromMembers(cluster.members);
    const alternatives = cluster.members.filter(m => m.id !== choice.id && !m.recommended);
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
  const withoutThisSlot = new Map(pinnedForDay ? pinnedForDay.entries() : []);
  withoutThisSlot.delete(slotKey);
  const clone = dayMatches.map(m => ({ ...m }));
  const picks = computeDayPlan(dayKey, clone, withoutThisSlot, options);
  const picked = picks.find(m => m.slotKey === slotKey);
  return picked ? picked.id : null;
}

// ---- Cross-day variety (soft recent-repeat penalty) ------------------------
//
// computeDayPlan only ever sees one calendar day, so left alone the same
// highest-scoring matchup can win every single day of a multi-game series
// even when a comparably good alternative exists (docs/
// recommendation-engine-audit.md's "cross-day repetition needs to become a
// real planning input" finding). This section is what lets a caller feed
// "what did we already recommend on an EARLIER day" into today's plan,
// without computeDayPlan itself needing to know anything about other days.
//
// A team-sport matchup's identity, independent of which side is home/away
// or which export produced it (so "A @ B" and "B @ A" - a return leg, or
// just a different [away, home] ordering - count as the same matchup). An
// F1 session has no `competitors` (see build-data.mjs's fetchF1Matches), so
// it falls back to its own name, which already includes the session suffix
// - qualifying and the race itself are correctly two different keys, never
// folded together as "the same event recommended twice". The one
// definition of "same matchup" this codebase has - scripts/
// evaluate-recommendations.mjs's own descriptive report uses this same
// function rather than a second copy of this logic.
export function matchupKey(match) {
  if (Array.isArray(match.competitors) && match.competitors.length === 2) {
    const names = match.competitors.map(c => c.name || c.abbreviation || '?').sort();
    return `${match.sport}: ${names.join(' vs ')}`;
  }
  return `${match.sport}: ${match.name || match.id}`;
}

// How many local calendar days apart two "YYYY-MM-DD" day keys are -
// parsed as UTC midnight purely so the arithmetic is exact; the keys
// themselves already represent a viewer's own local calendar date (see
// app.js's localDateKey), this just diffs two date strings, not instants.
export function daysBetweenDayKeys(laterDayKey, earlierDayKey) {
  return Math.round((Date.parse(`${laterDayKey}T00:00:00Z`) - Date.parse(`${earlierDayKey}T00:00:00Z`)) / 86_400_000);
}

// Small and DECAYING, never a hard ban (docs/recommendation-engine-audit.md
// section 14 is explicit about this) - a genuinely great matchup can still
// win on consecutive days, this just stops it from winning by default
// every time an alternative is close. Anything 4+ days back is
// indistinguishable from "not recently recommended" at this scale.
// Bumped up from the original {1: 1.5, 2: 0.75, 3: 0.25} - a reported real
// case (the same MLB matchup recommended as the day's bridge/secondary pick
// on three straight days) showed the old weights were too small to matter
// against a matchup that's merely a BIT better than that day's alternative,
// even though "include some variety unless the alternative is genuinely
// much worse" is exactly the intended behavior. Still soft and decaying,
// never a hard ban - a dramatically better repeat can still win - just with
// real teeth against a close call now instead of a token nudge.
export const RECENT_REPEAT_PENALTY_BY_GAP_DAYS = { 1: 2.5, 2: 1.5, 3: 0.75 };
export function recentRepeatPenalty(daysSinceLastRecommended) {
  if (!Number.isFinite(daysSinceLastRecommended) || daysSinceLastRecommended <= 0) return 0;
  return RECENT_REPEAT_PENALTY_BY_GAP_DAYS[daysSinceLastRecommended] || 0;
}

// ---- Sport-level variety (soft concentration penalty) ---------------------
//
// The repeat penalty above only tracks a specific matchup (the same two
// teams) - docs/recommendation-engine-audit.md section 15 asks for variety
// "at multiple levels", not just that one: "Avoid accidentally producing:
// MLB MLB MLB MLB MLB when equally compelling alternatives exist." A sport
// that plays every day (MLB) is EXPECTED to win most days when it
// genuinely has the best fixture - this only nudges the call when today's
// other candidates are close enough for the recent concentration to
// matter, same "soft, decaying, never a hard ban" design as the matchup
// penalty.
//
// The share of RECENT PICKS (not candidates - a 15-game MLB slate vs. one
// F1 session isn't "concentration", what actually happened is) that
// belong to one sport, over the last SPORT_CONCENTRATION_LOOKBACK_DAYS
// days.
export const SPORT_CONCENTRATION_LOOKBACK_DAYS = 3;
// Below this share, a sport isn't "dominating" enough to nudge - two or
// three sports roughly splitting recent picks is exactly the normal, fine
// case this should leave alone entirely (0 penalty).
export const SPORT_CONCENTRATION_THRESHOLD = 0.75;
// Bumped up from 1 alongside RECENT_REPEAT_PENALTY_BY_GAP_DAYS above - same
// "variety needs real teeth against a close call" reasoning.
export const SPORT_CONCENTRATION_PENALTY = 1.5;

// Map<sport, share 0..1> of how much of `picks` belongs to each sport -
// also what "the planner should expose that concentration" (section 15's
// own words, on team/league concentration) resolves to: computeWindowPlan
// returns this computed over the WHOLE window's own final picks, not just
// the short lookback used for the penalty itself, for a caller (or a
// developer inspecting an export) to actually see it.
export function computeSportConcentration(picks) {
  const bySport = new Map();
  picks.forEach(m => bySport.set(m.sport, (bySport.get(m.sport) || 0) + 1));
  const total = picks.length;
  const shares = new Map();
  bySport.forEach((count, sport) => shares.set(sport, total > 0 ? count / total : 0));
  return shares;
}

function sportConcentrationPenalty(sport, recentPicks) {
  if (!recentPicks.length) return 0;
  const share = computeSportConcentration(recentPicks).get(sport) || 0;
  return share >= SPORT_CONCENTRATION_THRESHOLD ? SPORT_CONCENTRATION_PENALTY : 0;
}

// Sets `.planningScore`/`.recentRepeatPenalty`/`.sportConcentrationPenalty`
// on every match in `dayMatches`. `lastRecommendedDayKey` (a
// Map<matchupKey, dayKey>) and `recentPicks` (a flat array of matches
// recommended over the last SPORT_CONCENTRATION_LOOKBACK_DAYS days, BEFORE
// today - see computeWindowPlan) both come from a caller that's tracking
// history across days; this function itself stays a pure function of its
// arguments. Deliberately separate fields from effectiveScore, never
// overwritten in place: effectiveScore stays the viewer's own true,
// un-penalized judgment of the match (docs/recommendation-engine-audit.md's
// Invariant 4 - a diversity penalty can reduce a score, never delete or
// corrupt the one it's derived from); planningScore is only what the
// scheduler's DP weighs picks by (see computeDayPlan's `scoreField`
// option).
export function applyRecentRepeatPenalties(dayMatches, dayKey, lastRecommendedDayKey, recentPicks = []) {
  dayMatches.forEach(match => {
    const lastDayKey = lastRecommendedDayKey.get(matchupKey(match));
    const gap = lastDayKey ? daysBetweenDayKeys(dayKey, lastDayKey) : null;
    const repeatPenalty = gap != null && gap > 0 ? recentRepeatPenalty(gap) : 0;
    const sportPenalty = sportConcentrationPenalty(match.sport, recentPicks);
    // Recomputed fresh every call (never accumulated) from match's own
    // CURRENT competitor scores - see liveExcitementBonus's own comment.
    const liveBonus = liveExcitementBonus(match);
    match.recentRepeatPenalty = repeatPenalty;
    match.sportConcentrationPenalty = sportPenalty;
    match.liveExcitementBonus = liveBonus;
    match.planningScore =
      (Number.isFinite(match.effectiveScore) ? match.effectiveScore : 0) - repeatPenalty - sportPenalty + liveBonus;
  });
}

// Runs computeDayPlan once per day, IN CHRONOLOGICAL ORDER, across a whole
// fetched window - the only way a later day's plan can actually know what
// an earlier day already recommended. `matchesByDayKey` is a
// Map<dayKey, matches> (app.js's own per-day buckets); `pinnedChoices` is
// state.pinnedChoices as-is (a Map<dayKey, Map<slotKey, matchId>>).
//
// Returns:
//   - `plan`: Map<dayKey, picks>
//   - `lastRecommendedDayKey`: the FINAL matchup-repeat history, as it
//     stands after every day in the window has been processed - useful as
//     a whole-window summary/diagnostic, but NOT what a later per-day
//     re-query (app.js's dayCandidatesForPlan/pinSlotChoice) should use as
//     "history" for that day - see historyByDayKey below for why.
//   - `historyByDayKey`: Map<dayKey, Map<matchupKey, dayKey>> - the
//     matchup-repeat history AS IT STOOD immediately BEFORE that day's own
//     picks were folded in, i.e. exactly what applyRecentRepeatPenalties
//     actually used to score that day's candidates the one time this
//     function computed them. This is the one a caller re-deriving a
//     SINGLE day's candidates later (outside this same chronological pass)
//     must use instead of the flat `lastRecommendedDayKey` above: that flat
//     map only holds each matchup's LAST occurrence across the ENTIRE
//     window, which for a real short back-to-back series (the reported
//     "same MLB matchup recommended 3 days running" bug) is very often a
//     day AFTER the one being re-queried - daysBetweenDayKeys(dayKey,
//     future-day) is negative, so applyRecentRepeatPenalties's own `gap > 0`
//     guard silently treats it as "no history at all" and the repeat
//     penalty this whole mechanism exists for never actually applies,
//     however many times that same matchup was already recommended on
//     earlier days in the window.
//   - `recentPicksByDayKey`: Map<dayKey, matches[]> - exactly the rolling
//     "last few days' picks" this function itself used to weigh THAT day's
//     sport-concentration penalty, reusable as-is by a caller scoped to
//     one (possibly sport-filtered) day - see app.js's
//     renderRecommendedSection - so it doesn't have to re-derive the same
//     rolling window from `plan` itself.
//   - `sportConcentration`: Map<sport, share> over the WHOLE window's own
//     final picks (see computeSportConcentration) - the "expose that
//     concentration" diagnostic section 15 asks for.
export function computeWindowPlan(matchesByDayKey, pinnedChoices = new Map()) {
  const dayKeys = [...matchesByDayKey.keys()].sort();
  const lastRecommendedDayKey = new Map();
  const plan = new Map();
  const recentPicksByDayKey = new Map();
  const historyByDayKey = new Map();
  const recentDayPicks = []; // rolling [{dayKey, picks}], oldest first
  dayKeys.forEach(dayKey => {
    const dayMatches = matchesByDayKey.get(dayKey) || [];
    const recentPicks = recentDayPicks
      .filter(entry => daysBetweenDayKeys(dayKey, entry.dayKey) <= SPORT_CONCENTRATION_LOOKBACK_DAYS)
      .flatMap(entry => entry.picks);
    recentPicksByDayKey.set(dayKey, recentPicks);
    // Snapshotted BEFORE this day's own picks are folded into
    // lastRecommendedDayKey below - see historyByDayKey's own comment.
    historyByDayKey.set(dayKey, new Map(lastRecommendedDayKey));
    applyRecentRepeatPenalties(dayMatches, dayKey, lastRecommendedDayKey, recentPicks);
    const picks = computeDayPlan(dayKey, dayMatches, pinnedChoices.get(dayKey), { scoreField: 'planningScore' });
    picks.forEach(match => lastRecommendedDayKey.set(matchupKey(match), dayKey));
    recentDayPicks.push({ dayKey, picks });
    plan.set(dayKey, picks);
  });
  return {
    plan,
    lastRecommendedDayKey,
    historyByDayKey,
    recentPicksByDayKey,
    sportConcentration: computeSportConcentration(recentDayPicks.flatMap(entry => entry.picks))
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
  // viewer swipe uses (see pinSlotChoice in app.js), then let the
  // scheduler find the best plan that actually includes it.
  const forced = dayMatches.map(m => ({ ...m }));
  const forcedCandidates = forced.filter(m => !isQuietHours(m));
  const cluster = groupIntoSlots(forcedCandidates).find(c => c.members.some(m => m.id === candidateId));
  const forcedKey = cluster ? slotKeyFromMembers(cluster.members) : candidateId;
  const forcedPinnedForDay = new Map(pinnedForDay ? pinnedForDay.entries() : []);
  forcedPinnedForDay.set(forcedKey, candidateId);
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
      // same-day scheduling + cross-day history (applyRecentRepeatPenalties)
      // neither of which this function has.
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
