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
// isQuietHours/effectiveInterval's own use of the current wall clock via
// `new Date`, which is inherent to "is this match on right now", not a
// hidden dependency on outside state).

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

// ---- Recommendation-style blending -----------------------------------------
//
// How much broadcastQuality tips the chosen style's own primary score, on
// the same 1-10 scale both sides are already on - see app.js's "Recommendation
// style setting" section for the full reasoning. Kept a genuine, noticeably-
// felt nudge without ever letting it dominate: competitiveness/watchability
// still make up 85% of the blend.
export const BROADCAST_QUALITY_WEIGHT = 0.15;

// The chosen style's own primary score, nudged by broadcastQuality when
// it's actually available - falls back to the build-time composite
// `match.score` for 'competitive' (or any unrecognized style), and skips
// the broadcastQuality blend entirely rather than producing NaN when a
// match has no real basis for it (a heuristic-scored/finished match with no
// real AI judgment behind it at all).
export function recommendStyleScore(match, style) {
  const primary =
    style === 'entertainment' && Number.isFinite(match.watchability) ? match.watchability : match.score;
  if (!Number.isFinite(match.broadcastQuality)) return primary;
  return primary * (1 - BROADCAST_QUALITY_WEIGHT) + match.broadcastQuality * BROADCAST_QUALITY_WEIGHT;
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
// relative nudge), `styleScore` is that same match after the chosen
// recommendation style + broadcastQuality blend (recommendStyleScore), and
// `adjustments` names every further nudge stacked on top of it, so a given
// effectiveScore is never just an opaque number - see docs/
// recommendation-engine-audit.md for why this exists. `effectiveScore`
// itself is exactly what app.js's resolveViewingPlan/computeDayPlan has
// always computed; this function only makes the arithmetic explicit and
// independently testable, it doesn't change it.
export function computeEffectiveScore(match, { priorityOrder = [], myServiceIds = new Set(), recommendStyle = 'entertainment' } = {}) {
  const centerRank = (priorityOrder.length - 1) / 2;
  const rank = priorityOrder.indexOf(match.sport);
  const priorityNudge = rank === -1 ? 0 : (centerRank - rank) * PRIORITY_SCORE_DELTA;
  const service = resolveService(match.whereToWatchTw);
  const serviceNudge = service && myServiceIds.has(service.id) ? OWNED_SERVICE_SCORE_BONUS : 0;

  const baseScore = Number.isFinite(match.score) ? match.score : 0;
  const styleScore = recommendStyleScore(match, recommendStyle);
  // How much of styleScore is attributable to the broadcastQuality blend
  // alone, isolated from the style choice itself - lets an explanation say
  // "production quality nudged this up/down by X" instead of just "the
  // style score is Y", per docs/recommendation-engine-audit.md's stated
  // goal of never leaving an adjustment implicit.
  const styleBase = recommendStyle === 'entertainment' && Number.isFinite(match.watchability) ? match.watchability : match.score;
  const broadcastAdjustment = Number.isFinite(styleBase) ? styleScore - styleBase : 0;

  return {
    baseScore,
    styleScore,
    adjustments: {
      broadcastQuality: Math.round(broadcastAdjustment * 1000) / 1000,
      priority: priorityNudge,
      service: serviceNudge
    },
    effectiveScore: styleScore + priorityNudge + serviceNudge
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
//   - 'ai' + refined: the base pass PLUS a second, comparative pass
//     against its specific contested neighbors (see build-data.mjs's
//     refineContestedClusters) - the strongest evidence this pipeline ever
//     produces for a match.
//   - 'ai', not refined: one independent Gemini judgment, grounded in real
//     signals (current odds, win-loss record, postseason flag - see
//     build-data.mjs's oddsContext/context) but never cross-checked against
//     its own neighbors.
//   - 'heuristic': PROXY_URL was unset or the call failed - a local
//     win-loss-record-only stand-in with no real sports judgment behind it
//     at all (see build-data.mjs's heuristicScore).
export const CONFIDENCE_BY_SOURCE = {
  finished: null,
  aiRefined: 0.9,
  ai: 0.7,
  heuristic: 0.35
};

export function computeConfidence(match) {
  if (!match || match.source === 'finished' || match.source == null) return CONFIDENCE_BY_SOURCE.finished;
  if (match.source === 'ai') return match.refined ? CONFIDENCE_BY_SOURCE.aiRefined : CONFIDENCE_BY_SOURCE.ai;
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
    confidence: computeConfidence(match)
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

// ---- Quiet hours ------------------------------------------------------------

export const QUIET_HOUR_START = 0;
export const QUIET_HOUR_END = 5;

export function isQuietHours(match) {
  const hour = new Date(match.startTimeUtc).getHours(); // local hour, deliberately not getUTCHours
  return QUIET_HOUR_START <= QUIET_HOUR_END
    ? hour >= QUIET_HOUR_START && hour < QUIET_HOUR_END
    : hour >= QUIET_HOUR_START || hour < QUIET_HOUR_END;
}

// ---- Slot grouping (near-total-overlap dedup within one day) --------------
//
// Groups a day's candidate matches into "slots" - anchor-claiming,
// highest-effectiveScore-first: an unclaimed match becomes a slot's anchor,
// and only matches that are near-totally overlapping THAT SPECIFIC anchor
// join it and get claimed. This IS the "duplicate recommendation" guard for
// same-day fixtures - two fixtures that overlap so much you couldn't
// actually watch both become one slot (a swipeable choice), never two
// separate "recommended: true" picks. See docs/recommendation-engine-audit.md
// for why cross-DAY repeats of the same two teams (e.g. a 4-game series) are
// a different, deliberate thing this function does NOT dedupe - each date's
// game is a distinct, real event with its own plan.
export function groupIntoSlots(dayMatches) {
  const claimed = new Set();
  const slots = [];
  dayMatches
    .slice()
    .sort((a, b) => b.effectiveScore - a.effectiveScore)
    .forEach(anchor => {
      if (claimed.has(anchor.id)) return;
      claimed.add(anchor.id);
      const members = dayMatches.filter(m => !claimed.has(m.id) && isNearTotalOverlap(anchor, m));
      members.forEach(m => claimed.add(m.id));
      slots.push({ members: [anchor, ...members] });
    });
  return slots;
}

export function slotKeyFromMembers(members) {
  return members.map(m => m.id).sort().join('|');
}

export function bestMember(members) {
  return members.slice().sort((a, b) => b.effectiveScore - a.effectiveScore)[0];
}

// ---- Weighted interval scheduling ------------------------------------------
//
// Classic weighted interval scheduling: the maximum-total-choice.effectiveScore
// subset of `items` (each {interval, choice}) whose intervals don't
// overlap. O(n^2) in the inner "find the latest compatible previous item"
// scan - fine at the scale one day's fixture list ever reaches.
export function weightedIntervalSchedule(items) {
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
    const withCur = { score: prevBest.score + cur.choice.effectiveScore, picks: [...prevBest.picks, cur] };
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
export function computeDayPlan(dayKey, dayMatches, pinnedForDay = null) {
  dayMatches.forEach(match => {
    match.recommended = false;
    match.alternativeIds = null;
    match.isPreferred = false;
  });
  const candidates = dayMatches.filter(m => !isQuietHours(m) && !m.isFinished);
  if (!candidates.length) return [];

  const slots = groupIntoSlots(candidates);
  const resolved = slots.map(slot => {
    const pinnedId = pinnedForDay && pinnedForDay.get(slotKeyFromMembers(slot.members));
    const pinnedMember = pinnedId ? slot.members.find(m => m.id === pinnedId) : null;
    const choice = pinnedMember || bestMember(slot.members);
    return { members: slot.members, choice, interval: effectiveInterval(choice), isPinned: !!pinnedMember };
  });

  // Pinned slots split the day into independent gaps - the free (unpinned)
  // slots in each gap get their own scheduling run, bounded so nothing
  // scheduled there can creep into a pinned pick's own fixed window.
  const forced = resolved.filter(r => r.isPinned).sort((a, b) => a.interval.start - b.interval.start);
  const free = resolved.filter(r => !r.isPinned);
  const picks = [];
  let cursor = -Infinity;
  forced.forEach(f => {
    picks.push(...weightedIntervalSchedule(free.filter(r => r.interval.start >= cursor && r.interval.end <= f.interval.start)));
    picks.push(f);
    cursor = f.interval.end;
  });
  picks.push(...weightedIntervalSchedule(free.filter(r => r.interval.start >= cursor)));

  picks.sort((a, b) => a.interval.start - b.interval.start);
  picks.forEach(({ members, choice, isPinned }) => {
    choice.recommended = true;
    // Distinguishes "the system picked this" (推薦) from "you swiped to
    // this" (偏好, see app.js's buildMatchCard) - a viewer-made choice
    // isn't the same claim as the algorithm's own judgment.
    choice.isPreferred = isPinned;
    if (members.length > 1) choice.alternativeIds = members.filter(m => m.id !== choice.id).map(m => m.id);
  });
  return picks.map(p => p.choice);
}

// ---- Viewer-relative score resolution --------------------------------------
//
// `priorityOrder` nudges effectiveScore away from the AI's own score - the
// displayed reason/.score always stay the true, un-nudged values; only
// effectiveScore (the day plan's own DP weight, and groupIntoSlots' own
// anchor ordering) sees the adjusted number.
export function resolveViewingPlan(matches, priorityOrder = [], myServiceIds = new Set(), recommendStyle = 'entertainment') {
  const context = { priorityOrder, myServiceIds, recommendStyle };
  const withScores = matches.map(match => {
    const breakdown = computeEffectiveScore(match, context);
    return {
      ...match,
      score: breakdown.styleScore,
      effectiveScore: breakdown.effectiveScore,
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
