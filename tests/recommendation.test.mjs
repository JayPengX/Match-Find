// Tests for public/lib/recommendation.mjs - the pure scoring/viewing-plan
// math extracted out of public/app.js (see that module's own top comment).
// Run with `npm test` (node --test tests/).
//
// Fixed to UTC regardless of the runner's own default timezone -
// isQuietHours works off the LOCAL wall-clock hour (`new Date(...).getHours()`),
// deliberately, since "don't recommend a 3am fixture" is relative to a
// viewer's own clock - so a test asserting a specific quiet-hours outcome
// needs a known local timezone to assert against, same reasoning as the
// deploy workflow always running on UTC-default GitHub-hosted runners.
process.env.TZ = 'UTC';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bestMatchScore,
  computeEffectiveScore,
  computeRecommendationScore,
  computeConfidence,
  computeOverlapRange,
  overlapMinutes,
  isNearTotalOverlap,
  effectiveDurationMinutes,
  groupIntoSlots,
  weightedIntervalSchedule,
  computeDayPlan,
  resolveViewingPlan,
  isQuietHours,
  resolveService,
  BROADCAST_QUALITY_WEIGHT,
  PRIORITY_SCORE_DELTA,
  OWNED_SERVICE_SCORE_BONUS,
  resolveSportTiming,
  schedulingDurationMinutes,
  schedulingInterval,
  canWatchSequentially,
  SPORT_TIMING,
  DURATION_OVERRUN_BUFFER_BY_RELIABILITY,
  TRANSITION_BUFFER_MINUTES,
  matchLifecycleState,
  LIFECYCLE_STATES,
  matchupKey,
  daysBetweenDayKeys,
  recentRepeatPenalty,
  applyRecentRepeatPenalties,
  computeWindowPlan,
  describeEvidence,
  isEvidenceFresh,
  EVIDENCE_CATEGORY_LABELS,
  EVIDENCE_FRESH_MAX_AGE_HOURS,
  computeSportConcentration,
  SPORT_CONCENTRATION_PENALTY,
  naturalSlotChoice,
  estimatedDurationMinutes,
  STARTING_SOON_WINDOW_MINUTES,
  explainWhyNotRecommended,
  slotKeyFromMembers
} from '../public/lib/recommendation.mjs';

// A local noon kickoff, expressed in UTC, so isQuietHours' local-hour check
// behaves the same regardless of which timezone CI happens to run tests in.
const NOON_UTC = '2026-09-19T12:00:00.000Z';

function makeMatch(overrides = {}) {
  return {
    id: 'm1',
    sport: 'MLB',
    startTimeUtc: NOON_UTC,
    durationMinutes: 190,
    isFinished: false,
    timeTbd: false,
    competitiveness: 6,
    watchability: 6,
    broadcastQuality: 6,
    enduranceScore: 5,
    score: 6,
    whereToWatchTw: '',
    source: 'ai',
    refined: false,
    ...overrides
  };
}

describe('bestMatchScore (the one unified Best Matches blend)', () => {
  test('blends watchability with broadcastQuality at the documented weight', () => {
    const match = makeMatch({ watchability: 8, broadcastQuality: 4, score: 5 });
    const expected = 8 * (1 - BROADCAST_QUALITY_WEIGHT) + 4 * BROADCAST_QUALITY_WEIGHT;
    assert.equal(bestMatchScore(match), expected);
  });

  test('falls back to the build-time composite score when watchability is missing', () => {
    const match = makeMatch({ watchability: undefined, score: 5, broadcastQuality: 5 });
    assert.equal(bestMatchScore(match), 5 * (1 - BROADCAST_QUALITY_WEIGHT) + 5 * BROADCAST_QUALITY_WEIGHT);
  });

  test('a missing broadcastQuality (finished/never-scored match) skips the blend entirely', () => {
    const match = makeMatch({ watchability: 8, broadcastQuality: null });
    assert.equal(bestMatchScore(match), 8);
  });
});

describe('computeEffectiveScore / computeRecommendationScore', () => {
  test('priority nudge is symmetric around the middle rank and zero with no ranking', () => {
    const order = ['Premier League', 'MLB', 'NBA']; // center rank = 1 (MLB)
    const first = computeEffectiveScore(makeMatch({ sport: 'Premier League', broadcastQuality: null, score: 5 }), {
      priorityOrder: order
    });
    const middle = computeEffectiveScore(makeMatch({ sport: 'MLB', broadcastQuality: null, score: 5 }), {
      priorityOrder: order
    });
    const last = computeEffectiveScore(makeMatch({ sport: 'NBA', broadcastQuality: null, score: 5 }), {
      priorityOrder: order
    });
    assert.equal(first.adjustments.priority, PRIORITY_SCORE_DELTA);
    assert.equal(middle.adjustments.priority, 0);
    assert.equal(last.adjustments.priority, -PRIORITY_SCORE_DELTA);

    const unranked = computeEffectiveScore(makeMatch({ sport: 'F1', broadcastQuality: null, score: 5 }), {
      priorityOrder: order
    });
    assert.equal(unranked.adjustments.priority, 0);
  });

  test('service nudge only applies when the resolved service is in myServiceIds', () => {
    const match = makeMatch({ whereToWatchTw: '愛爾達體育台', broadcastQuality: null, score: 5 });
    const owned = computeEffectiveScore(match, { myServiceIds: new Set(['elta']) });
    const notOwned = computeEffectiveScore(match, { myServiceIds: new Set(['appletv']) });
    assert.equal(owned.adjustments.service, OWNED_SERVICE_SCORE_BONUS);
    assert.equal(notOwned.adjustments.service, 0);
  });

  test('effectiveScore is exactly bestMatchScore + priority + service, nothing hidden', () => {
    const match = makeMatch({ sport: 'MLB', watchability: 7, broadcastQuality: 9, whereToWatchTw: 'Apple TV' });
    const breakdown = computeEffectiveScore(match, {
      priorityOrder: ['MLB', 'NBA'],
      myServiceIds: new Set(['appletv'])
    });
    assert.equal(
      breakdown.effectiveScore,
      breakdown.bestMatchScore + breakdown.adjustments.priority + breakdown.adjustments.service
    );
  });

  test('computeRecommendationScore composes the score breakdown with confidence', () => {
    const match = makeMatch({ source: 'ai', refined: true });
    const result = computeRecommendationScore(match, {});
    assert.equal(result.finalScore, computeEffectiveScore(match, {}).effectiveScore);
    assert.equal(result.confidence, 0.9);
    assert.ok(result.adjustments);
    assert.equal(typeof result.baseScore, 'number');
  });
});

describe('computeConfidence', () => {
  test('a finished match (no score at all) has null confidence', () => {
    assert.equal(computeConfidence(makeMatch({ source: 'finished' })), null);
  });
  test('an AI-scored match that survived the comparative refine pass is most confident', () => {
    assert.equal(computeConfidence(makeMatch({ source: 'ai', refined: true })), 0.9);
  });
  test('a base-pass-only AI score is confident but less so', () => {
    assert.equal(computeConfidence(makeMatch({ source: 'ai', refined: false })), 0.7);
  });
  test('the local heuristic fallback (no real AI judgment) is the least confident', () => {
    assert.equal(computeConfidence(makeMatch({ source: 'heuristic' })), 0.35);
  });
  test('an unrecognized/missing source is treated the same as finished (null), not fabricated', () => {
    assert.equal(computeConfidence(makeMatch({ source: undefined })), null);
  });
});

describe('overlap helpers', () => {
  test('two fixtures with no time in common do not overlap', () => {
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 60 });
    const b = makeMatch({ id: 'b', startTimeUtc: '2026-09-19T13:30:00.000Z', durationMinutes: 60 });
    assert.equal(computeOverlapRange(a, b), null);
    assert.equal(overlapMinutes(a, b), 0);
  });

  test('overlapMinutes reports the exact shared window', () => {
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 120 });
    const b = makeMatch({ id: 'b', startTimeUtc: '2026-09-19T13:00:00.000Z', durationMinutes: 120 });
    assert.equal(overlapMinutes(a, b), 60);
  });

  test('isNearTotalOverlap is true right at the 75%-of-the-shorter-match threshold', () => {
    // shorter match is 60 min; 45 shared minutes is exactly 75% of it.
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 60 });
    const b = makeMatch({ id: 'b', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 190 });
    assert.equal(overlapMinutes(a, b), 60); // fully contained
    assert.ok(isNearTotalOverlap(a, b));

    const c = makeMatch({ id: 'c', startTimeUtc: '2026-09-19T12:15:00.000Z', durationMinutes: 60 });
    const d = makeMatch({ id: 'd', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 60 });
    // c starts 15 min into d's 60-minute window -> 45 shared minutes / 60 = 0.75 exactly.
    assert.equal(overlapMinutes(c, d), 45);
    assert.ok(isNearTotalOverlap(c, d));

    const e = makeMatch({ id: 'e', startTimeUtc: '2026-09-19T12:16:00.000Z', durationMinutes: 60 });
    const f = makeMatch({ id: 'f', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 60 });
    // 44 shared minutes / 60 < 0.75 -> not near-total, genuinely sequenceable.
    assert.equal(overlapMinutes(e, f), 44);
    assert.ok(!isNearTotalOverlap(e, f));
  });
});

describe('effectiveDurationMinutes (enduranceScore-shortened scheduling window)', () => {
  test('enduranceScore 10 reserves the full nominal length', () => {
    assert.equal(effectiveDurationMinutes(makeMatch({ durationMinutes: 190, enduranceScore: 10 })), 190);
  });
  test('enduranceScore 1 reserves only the floor fraction (0.4) of the nominal length', () => {
    // factor = 0.4 + 0.6 * (1/10) = 0.46
    assert.equal(effectiveDurationMinutes(makeMatch({ durationMinutes: 190, enduranceScore: 1 })), 87.4);
  });
  test('a missing enduranceScore defaults to the neutral midpoint (5)', () => {
    // factor = 0.4 + 0.6 * 0.5 = 0.7
    assert.equal(effectiveDurationMinutes(makeMatch({ durationMinutes: 100, enduranceScore: undefined })), 70);
  });
});

describe('groupIntoSlots (the same-day "duplicate recommendation" guard)', () => {
  test('two near-totally overlapping fixtures become ONE slot, never two separate picks', () => {
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const b = makeMatch({ id: 'b', startTimeUtc: '2026-09-19T12:05:00.000Z', durationMinutes: 60, effectiveScore: 7 });
    const c = makeMatch({ id: 'c', startTimeUtc: '2026-09-19T20:00:00.000Z', durationMinutes: 60, effectiveScore: 5 });
    const slots = groupIntoSlots([a, b, c]);
    assert.equal(slots.length, 2);
    const bigSlot = slots.find(s => s.members.length > 1);
    assert.ok(bigSlot);
    assert.deepEqual(new Set(bigSlot.members.map(m => m.id)), new Set(['a', 'b']));
  });

  test('a fixture with nothing near-totally overlapping it becomes its own one-member slot', () => {
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const slots = groupIntoSlots([a]);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].members.length, 1);
  });
});

describe('weightedIntervalSchedule', () => {
  test('picks the two non-overlapping matches over one overlapping match when their combined score wins', () => {
    // [0,60) score 5, [50,110) score 6 (overlaps both), [100,160) score 5
    // -> best is either {0-60, 100-160} (score 10) or {50-110} alone (score 6). 10 > 6.
    const items = [
      { interval: { start: 0, end: 60 }, choice: { effectiveScore: 5, id: 'a' } },
      { interval: { start: 50, end: 110 }, choice: { effectiveScore: 6, id: 'b' } },
      { interval: { start: 100, end: 160 }, choice: { effectiveScore: 5, id: 'c' } }
    ];
    const picks = weightedIntervalSchedule(items).map(p => p.choice.id);
    assert.deepEqual(picks.sort(), ['a', 'c']);
  });

  test('picks the single higher-value match when it beats the combined alternative', () => {
    const items = [
      { interval: { start: 0, end: 60 }, choice: { effectiveScore: 2, id: 'a' } },
      { interval: { start: 50, end: 110 }, choice: { effectiveScore: 100, id: 'b' } },
      { interval: { start: 100, end: 160 }, choice: { effectiveScore: 2, id: 'c' } }
    ];
    const picks = weightedIntervalSchedule(items).map(p => p.choice.id);
    assert.deepEqual(picks, ['b']);
  });

  test('an empty input returns an empty plan', () => {
    assert.deepEqual(weightedIntervalSchedule([]), []);
  });
});

describe('computeDayPlan', () => {
  test('a finished match is never a candidate, however good its score', () => {
    const finished = makeMatch({ id: 'f', isFinished: true, effectiveScore: 99, startTimeUtc: '2026-09-19T12:00:00.000Z' });
    const plan = computeDayPlan('2026-09-19', [finished]);
    assert.deepEqual(plan, []);
    assert.equal(finished.recommended, false);
  });

  test('a fixture whose local start falls in quiet hours (00:00-05:00) is never a candidate', () => {
    const match = makeMatch({ id: 'q', startTimeUtc: '2026-09-19T03:00:00.000Z', effectiveScore: 99 });
    assert.ok(isQuietHours(match));
    assert.deepEqual(computeDayPlan('2026-09-19', [match]), []);
    assert.equal(match.recommended, false);
  });

  test('a fixture just outside quiet hours (05:00) is a normal candidate', () => {
    const match = makeMatch({ id: 'ok', startTimeUtc: '2026-09-19T05:00:00.000Z', effectiveScore: 5 });
    assert.ok(!isQuietHours(match));
    const plan = computeDayPlan('2026-09-19', [match]);
    assert.equal(plan.length, 1);
    assert.equal(match.recommended, true);
  });

  test('near-total-overlap fixtures resolve to one recommended pick with the other as an alternative', () => {
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T20:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const b = makeMatch({ id: 'b', startTimeUtc: '2026-09-19T20:05:00.000Z', durationMinutes: 60, effectiveScore: 7 });
    const plan = computeDayPlan('2026-09-19', [a, b]);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].id, 'a'); // higher effectiveScore wins the slot
    assert.equal(a.recommended, true);
    assert.equal(b.recommended, false);
    assert.deepEqual(a.alternativeIds, ['b']);
  });

  test('a pinned choice overrides the highest-scoring member of its slot', () => {
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T20:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const b = makeMatch({ id: 'b', startTimeUtc: '2026-09-19T20:05:00.000Z', durationMinutes: 60, effectiveScore: 7 });
    const pinnedForDay = new Map([[[a.id, b.id].sort().join('|'), 'b']]);
    const plan = computeDayPlan('2026-09-19', [a, b], pinnedForDay);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].id, 'b');
    assert.equal(b.recommended, true);
    assert.equal(a.recommended, false);
    // A viewer-swiped pick is "偏好" (isPreferred), not "推薦" (the
    // system's own unforced judgment) - see app.js's buildMatchCard.
    assert.equal(b.isPreferred, true);
  });

  test('a match the scheduler picks on its own merits is never flagged isPreferred', () => {
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 60, effectiveScore: 6 });
    const plan = computeDayPlan('2026-09-19', [a]);
    assert.equal(plan[0].id, 'a');
    assert.equal(a.isPreferred, false);
  });

  test('non-overlapping fixtures across the day are all recommended independently', () => {
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 60, effectiveScore: 6 });
    const b = makeMatch({ id: 'b', startTimeUtc: '2026-09-19T20:00:00.000Z', durationMinutes: 60, effectiveScore: 6 });
    const plan = computeDayPlan('2026-09-19', [a, b]);
    assert.equal(plan.length, 2);
    assert.ok(a.recommended && b.recommended);
  });

  test('defaults to weighing picks by viewerScore (the audit\'s own name) when a match has one', () => {
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T20:00:00.000Z', durationMinutes: 60, effectiveScore: 9, viewerScore: 3 });
    const b = makeMatch({ id: 'b', startTimeUtc: '2026-09-19T20:05:00.000Z', durationMinutes: 60, effectiveScore: 3, viewerScore: 9 });
    // Same conflict window - effectiveScore alone would pick 'a', but the
    // default scoreField is now 'viewerScore', so 'b' should win instead.
    const plan = computeDayPlan('2026-09-19', [a, b]);
    assert.equal(plan[0].id, 'b');
  });

  test('falls back to effectiveScore when a match has no viewerScore at all (e.g. a hand-built fixture)', () => {
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T20:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const b = makeMatch({ id: 'b', startTimeUtc: '2026-09-19T20:05:00.000Z', durationMinutes: 60, effectiveScore: 3 });
    const plan = computeDayPlan('2026-09-19', [a, b]);
    assert.equal(plan[0].id, 'a');
  });
});

describe('resolveViewingPlan', () => {
  test('a finished match is excluded from every other match\'s overlappingIds, and vice versa', () => {
    const live = makeMatch({ id: 'live', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 60, isFinished: false });
    const finished = makeMatch({ id: 'done', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 60, isFinished: true });
    const [liveOut, finishedOut] = resolveViewingPlan([live, finished]);
    assert.deepEqual(liveOut.overlappingIds, []);
    assert.deepEqual(finishedOut.overlappingIds, []);
  });

  test('overlapping upcoming matches list each other in overlappingIds', () => {
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 60 });
    const b = makeMatch({ id: 'b', startTimeUtc: '2026-09-19T12:30:00.000Z', durationMinutes: 60 });
    const [aOut, bOut] = resolveViewingPlan([a, b]);
    assert.deepEqual(aOut.overlappingIds, ['b']);
    assert.deepEqual(bOut.overlappingIds, ['a']);
  });

  test('every match comes out with an explicit scoreBreakdown and confidence, not just a bare number', () => {
    const [out] = resolveViewingPlan([makeMatch({ source: 'ai', refined: true })]);
    assert.ok(out.scoreBreakdown);
    assert.equal(out.confidence, 0.9);
    assert.equal(out.effectiveScore, out.scoreBreakdown.effectiveScore);
  });

  test('eventScore/viewerScore are the same numbers as baseScore/effectiveScore, under the audit\'s own names', () => {
    const [out] = resolveViewingPlan([makeMatch({ sport: 'MLB' })], ['NBA', 'MLB']);
    assert.equal(out.eventScore, out.scoreBreakdown.baseScore);
    assert.equal(out.viewerScore, out.effectiveScore);
    assert.notEqual(out.eventScore, out.viewerScore); // priority nudge actually moved it
  });
});

describe('resolveService', () => {
  test('matches known Taiwan broadcast text to a stable service id', () => {
    assert.equal(resolveService('愛爾達體育台')?.id, 'elta');
    assert.equal(resolveService('Apple TV')?.id, 'appletv');
  });
  test('unrecognized or empty broadcast text resolves to no service', () => {
    assert.equal(resolveService(''), null);
    assert.equal(resolveService('緯來體育台'), null);
  });
});

// ---- Scheduling correctness regression tests -------------------------------
// docs/recommendation-engine-audit.md section 35 - one test per reported
// bug, not just per function, so a future change that re-breaks the
// BEHAVIOR (not just some internal helper's own return value) gets caught
// even if it technically routes through different code.

// A high-reliability, fixed-length fixture with full endurance (enduranceScore
// 10 => effectiveDurationMinutes === durationMinutes exactly) and no viewer
// nudges, so its schedulingInterval is fully predictable by hand:
// start + durationMinutes + TRANSITION_BUFFER_MINUTES.
function footballMatch(overrides = {}) {
  return makeMatch({ sport: 'Premier League', durationMinutes: 115, enduranceScore: 10, ...overrides });
}
function mlbMatch(overrides = {}) {
  return makeMatch({ sport: 'MLB', durationMinutes: 190, enduranceScore: 10, ...overrides });
}

describe('schedulingInterval / canWatchSequentially (canonical duration model)', () => {
  test('a high-reliability sport gets no uncertainty shrink - schedulingInterval is just duration + the transition buffer', () => {
    const a = footballMatch({ startTimeUtc: '2026-09-19T18:00:00.000Z' });
    const interval = schedulingInterval(a);
    assert.equal(interval.start, Date.parse('2026-09-19T18:00:00.000Z'));
    assert.equal(interval.end, Date.parse('2026-09-19T18:00:00.000Z') + (115 + TRANSITION_BUFFER_MINUTES) * 60_000);
  });

  test('MLB (low reliability) schedulingInterval ends LATER than its nominal length, padded for real overrun risk', () => {
    const game = mlbMatch({ startTimeUtc: '2026-09-19T18:00:00.000Z' });
    const nominalEnd = Date.parse('2026-09-19T18:00:00.000Z') + 190 * 60_000;
    // A no-clock sport is more likely to run LONG than short (extra
    // innings, rain delays) - see DURATION_OVERRUN_BUFFER_BY_RELIABILITY's
    // own comment. Padding the reserved block, never shrinking it below
    // the value judgment that produced it, is the direct fix for the
    // reported "40-80 minute overlap despite watching sequentially being
    // clearly unrealistic" bug.
    assert.ok(schedulingInterval(game).end > nominalEnd);
  });

  test('resolveSportTiming falls back to a medium default for an unlisted sport', () => {
    assert.equal(resolveSportTiming('Curling').durationReliability, 'medium');
    assert.equal(DURATION_OVERRUN_BUFFER_BY_RELIABILITY[resolveSportTiming('Curling').durationReliability], 0.1);
  });

  test('canWatchSequentially is symmetric - argument order never changes the answer', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z' });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T20:20:00.000Z' });
    assert.equal(canWatchSequentially(a, b), canWatchSequentially(b, a));
    assert.ok(canWatchSequentially(a, b));
  });
});

describe('Test 1 - obvious continuation', () => {
  test('a match ending before another begins selects BOTH, not just the higher scorer', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 7 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T20:10:00.000Z', effectiveScore: 8 });
    const plan = computeDayPlan('2026-09-19', [a, b]);
    assert.deepEqual(plan.map(m => m.id).sort(), ['a', 'b']);
    assert.ok(a.recommended && b.recommended);
  });
});

describe('Test 2 - three-event continuation', () => {
  test('A -> B -> C all get selected when each genuinely fits after the last', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', effectiveScore: 7 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T14:10:00.000Z', effectiveScore: 7 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T16:20:00.000Z', effectiveScore: 7 });
    const plan = computeDayPlan('2026-09-19', [a, b, c]);
    assert.deepEqual(plan.map(m => m.id), ['a', 'b', 'c']);
  });
});

describe('Test 3 - a better SEQUENCE beats a single higher-scoring match', () => {
  test('the scheduler compares "A alone" against "B then C", not just each match\'s own score', () => {
    // A (score 10) overlaps both B and C individually, but B ends early
    // enough to let C follow it - see this file's own worked timing in the
    // audit response. B + C (9 + 9 = 18) beats A alone (10).
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 150, effectiveScore: 10 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T19:20:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    assert.ok(!canWatchSequentially(a, c)); // A genuinely blocks C
    assert.ok(canWatchSequentially(b, c)); // B genuinely allows C
    const plan = computeDayPlan('2026-09-19', [a, b, c]);
    assert.deepEqual(plan.map(m => m.id), ['b', 'c']);
    assert.equal(a.recommended, false);
    // A is still visible to the viewer as a real alternative, never deleted
    // (Invariant: a diversity/sequencing loss can't delete the event).
    assert.ok(b.alternativeIds?.includes('a') || c.alternativeIds?.includes('a'));
  });

  test('b and c each expose the SAME slotKey - the whole 3-way cluster\'s, not just their own 2-member stack', () => {
    // Reproduces the "some cards are unswipable" report: b and c both
    // render as their own separate swipeable stack (each showing only 'a'
    // as its alternative, per the test above), but a pin against either
    // stack has to land somewhere computeDayPlan will actually look it up
    // from on the next render - that's the full cluster's key, always
    // slotKeyFromMembers([a, b, c]), never slotKeyFromMembers([b, a]) or
    // slotKeyFromMembers([c, a]) (what app.js's old members-based key
    // would have produced for each stack individually, and what silently
    // dropped every pin against a cluster like this one before this fix).
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 150, effectiveScore: 10 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T19:20:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    computeDayPlan('2026-09-19', [a, b, c]);
    const fullClusterKey = slotKeyFromMembers([a, b, c]);
    assert.equal(b.slotKey, fullClusterKey);
    assert.equal(c.slotKey, fullClusterKey);
    assert.notEqual(fullClusterKey, slotKeyFromMembers([b, a]));
    assert.notEqual(fullClusterKey, slotKeyFromMembers([c, a]));
  });

  test('a pin keyed by the full 3-way cluster reaches a member that only conflicts with the OTHER two individually', () => {
    // Follows directly from the slotKey test above: once app.js keys the
    // pin off the full cluster, swiping stack 'a' to reach 'c' correctly
    // forces c and excludes BOTH a and b (each of which does directly
    // near-total-overlap c, even though a and b don't overlap each other).
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 150, effectiveScore: 10 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T19:20:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const pinnedForDay = new Map([[slotKeyFromMembers([a, b, c]), 'a']]);
    const plan = computeDayPlan('2026-09-19', [a, b, c], pinnedForDay);
    assert.deepEqual(plan.map(m => m.id), ['a']);
    assert.equal(a.isPreferred, true);
    assert.equal(b.recommended, false);
    assert.equal(c.recommended, false);
  });
});

describe('Test 4 - one winner per genuine conflict window', () => {
  test('three mutually near-totally overlapping matches produce exactly one recommended pick', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 9 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:02:00.000Z', effectiveScore: 8 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T18:04:00.000Z', effectiveScore: 7 });
    const plan = computeDayPlan('2026-09-19', [a, b, c]);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].id, 'a');
    assert.deepEqual(new Set(a.alternativeIds), new Set(['b', 'c']));
  });
});

describe('Test 5 - MLB continuation respects the real overrun-padded end, not just the nominal length', () => {
  test('a later match canNOT follow an MLB game before its overrun-padded end, even one well past the nominal length', () => {
    const game = mlbMatch({ id: 'mlb', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 7 });
    // 20:30 is well past MLB's own nominal end (21:10 is actually LATER
    // than 20:30, so this is comfortably inside the nominal window too) -
    // the OLD discount-based model (DURATION_UNCERTAINTY_BY_RELIABILITY)
    // would have allowed something to start here, which is exactly the
    // reported "40-80 minute unrealistic overlap" bug: the schedule
    // treated a plain, unremarkable MLB game as safely over well before
    // its own broadcast realistically ends.
    const tooSoon = footballMatch({ id: 'too-soon', startTimeUtc: '2026-09-19T20:30:00.000Z', effectiveScore: 7 });
    assert.ok(!canWatchSequentially(game, tooSoon));
  });

  test('a later match CAN follow an MLB game once its overrun-padded end has passed', () => {
    const game = mlbMatch({ id: 'mlb', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 7 });
    // schedulingInterval(game).end = 18:00 + 190*1.25 (overrun) + 10
    // (transition buffer) minutes = 22:07:30.
    const next = footballMatch({ id: 'next', startTimeUtc: '2026-09-19T22:10:00.000Z', effectiveScore: 7 });
    assert.ok(canWatchSequentially(game, next));
    const plan = computeDayPlan('2026-09-19', [game, next]);
    assert.deepEqual(plan.map(m => m.id).sort(), ['mlb', 'next']);
  });
});

describe('Test 6 - football/F1 keep their tighter timing (no blanket permissiveness)', () => {
  test('the same gap that works after an MLB game is still a genuine conflict between two football matches', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 7 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T19:30:00.000Z', effectiveScore: 7 }); // well inside A's 115+10min window
    assert.ok(!canWatchSequentially(a, b));
    const plan = computeDayPlan('2026-09-19', [a, b]);
    assert.equal(plan.length, 1);
  });
});

describe('Tests 7/8 - cross-day matchup variety (soft recent-repeat penalty)', () => {
  test('a close alternative wins the day after its rival matchup was already recommended', () => {
    const day1 = [footballMatch({ id: 'a1', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 8 })];
    const a2 = footballMatch({ id: 'a2', startTimeUtc: '2026-09-20T18:00:00.000Z', effectiveScore: 8, name: 'Same Matchup' });
    const b = footballMatch({ id: 'b2', startTimeUtc: '2026-09-20T18:00:00.000Z', effectiveScore: 7.8, name: 'Different Matchup' });
    day1[0].name = 'Same Matchup';
    const { plan } = computeWindowPlan(
      new Map([
        ['2026-09-19', day1],
        ['2026-09-20', [a2, b]]
      ])
    );
    assert.deepEqual(plan.get('2026-09-19').map(m => m.id), ['a1']);
    // a2's own matchup was just recommended yesterday (penalty 1.5) -
    // 8 - 1.5 = 6.5 < b's 7.8, so the alternative wins.
    assert.deepEqual(plan.get('2026-09-20').map(m => m.id), ['b2']);
    assert.equal(a2.recentRepeatPenalty, 1.5);
  });

  test('a dramatically better repeat still wins - the penalty is soft, never a hard ban', () => {
    const day1 = [footballMatch({ id: 'a1', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 9, name: 'Great Matchup' })];
    const a2 = footballMatch({ id: 'a2', startTimeUtc: '2026-09-20T18:00:00.000Z', effectiveScore: 9, name: 'Great Matchup' });
    const b = footballMatch({ id: 'b2', startTimeUtc: '2026-09-20T18:00:00.000Z', effectiveScore: 3, name: 'Mediocre Matchup' });
    const { plan } = computeWindowPlan(
      new Map([
        ['2026-09-19', day1],
        ['2026-09-20', [a2, b]]
      ])
    );
    assert.deepEqual(plan.get('2026-09-20').map(m => m.id), ['a2']);
  });

  test('recentRepeatPenalty decays with distance and disappears after 3 days', () => {
    assert.equal(recentRepeatPenalty(1), 1.5);
    assert.equal(recentRepeatPenalty(2), 0.75);
    assert.equal(recentRepeatPenalty(3), 0.25);
    assert.equal(recentRepeatPenalty(4), 0);
    assert.equal(recentRepeatPenalty(0), 0);
    assert.equal(recentRepeatPenalty(null), 0);
  });

  test('matchupKey is order-independent and keeps F1 session types distinct', () => {
    const a = makeMatch({ sport: 'MLB', competitors: [{ name: 'Rays' }, { name: 'Yankees' }] });
    const b = makeMatch({ sport: 'MLB', competitors: [{ name: 'Yankees' }, { name: 'Rays' }] });
    assert.equal(matchupKey(a), matchupKey(b));
    const qual = makeMatch({ sport: 'F1', name: 'GP Qualifying', competitors: [] });
    const race = makeMatch({ sport: 'F1', name: 'GP', competitors: [] });
    assert.notEqual(matchupKey(qual), matchupKey(race));
  });

  test('daysBetweenDayKeys diffs two local calendar date strings as whole days', () => {
    assert.equal(daysBetweenDayKeys('2026-09-20', '2026-09-19'), 1);
    assert.equal(daysBetweenDayKeys('2026-09-22', '2026-09-19'), 3);
    assert.equal(daysBetweenDayKeys('2026-09-19', '2026-09-19'), 0);
  });

  test('applyRecentRepeatPenalties never touches effectiveScore itself, only the new planningScore field', () => {
    const match = footballMatch({ id: 'a', startTimeUtc: '2026-09-20T18:00:00.000Z', effectiveScore: 8 });
    applyRecentRepeatPenalties([match], '2026-09-20', new Map([[matchupKey(match), '2026-09-19']]));
    assert.equal(match.effectiveScore, 8);
    assert.equal(match.planningScore, 6.5);
  });
});

describe('§15 sport-level variety (soft concentration penalty)', () => {
  test('computeSportConcentration reports each sport\'s share of a pick list', () => {
    const picks = [
      makeMatch({ id: 'a', sport: 'MLB' }),
      makeMatch({ id: 'b', sport: 'MLB' }),
      makeMatch({ id: 'c', sport: 'MLB' }),
      makeMatch({ id: 'd', sport: 'F1' })
    ];
    const shares = computeSportConcentration(picks);
    assert.equal(shares.get('MLB'), 0.75);
    assert.equal(shares.get('F1'), 0.25);
  });

  test('an empty pick list reports no shares at all, not NaN', () => {
    assert.deepEqual([...computeSportConcentration([])], []);
  });

  test('a sport dominating the recent lookback window is penalized enough to let a close alternative from another sport win', () => {
    // Three straight days of MLB winning the slot (100% share in the
    // lookback window) - a comparably-scored NBA candidate should win
    // today instead, per section 15's own "MLB MLB MLB MLB MLB" example.
    const day1 = [mlbMatch({ id: 'd1', startTimeUtc: '2026-09-17T20:00:00.000Z', effectiveScore: 8 })];
    const day2 = [mlbMatch({ id: 'd2', startTimeUtc: '2026-09-18T20:00:00.000Z', effectiveScore: 8, name: 'Different Matchup 2' })];
    const day3 = [mlbMatch({ id: 'd3', startTimeUtc: '2026-09-19T20:00:00.000Z', effectiveScore: 8, name: 'Different Matchup 3' })];
    const mlbToday = mlbMatch({ id: 'mlb-today', startTimeUtc: '2026-09-20T20:00:00.000Z', effectiveScore: 8, name: 'Different Matchup 4' });
    const nbaToday = makeMatch({
      id: 'nba-today',
      sport: 'NBA',
      startTimeUtc: '2026-09-20T20:00:00.000Z',
      durationMinutes: 150,
      enduranceScore: 10,
      effectiveScore: 7.5
    });
    const { plan } = computeWindowPlan(
      new Map([
        ['2026-09-17', day1],
        ['2026-09-18', day2],
        ['2026-09-19', day3],
        ['2026-09-20', [mlbToday, nbaToday]]
      ])
    );
    assert.equal(mlbToday.sportConcentrationPenalty, SPORT_CONCENTRATION_PENALTY);
    assert.equal(nbaToday.sportConcentrationPenalty, 0); // NBA had zero share of the recent window
    assert.deepEqual(plan.get('2026-09-20').map(m => m.id), ['nba-today']);
  });

  test('two sports roughly splitting recent picks are never penalized - only genuine domination is', () => {
    const day1 = [mlbMatch({ id: 'd1', startTimeUtc: '2026-09-18T20:00:00.000Z', effectiveScore: 8 })];
    const day2 = [makeMatch({ id: 'd2', sport: 'NBA', startTimeUtc: '2026-09-19T20:00:00.000Z', durationMinutes: 150, enduranceScore: 10, effectiveScore: 8 })];
    const mlbToday = mlbMatch({ id: 'mlb-today', startTimeUtc: '2026-09-20T20:00:00.000Z', effectiveScore: 8, name: 'Different Matchup' });
    const { plan } = computeWindowPlan(
      new Map([
        ['2026-09-18', day1],
        ['2026-09-19', day2],
        ['2026-09-20', [mlbToday]]
      ])
    );
    assert.equal(mlbToday.sportConcentrationPenalty, 0); // MLB was only 50% of the recent window
    assert.deepEqual(plan.get('2026-09-20').map(m => m.id), ['mlb-today']);
  });

  test('a lone sport with no genuine alternative today still wins despite the penalty - it\'s soft, not a ban', () => {
    const day1 = [mlbMatch({ id: 'd1', startTimeUtc: '2026-09-19T20:00:00.000Z', effectiveScore: 8 })];
    const mlbToday = mlbMatch({ id: 'mlb-today', startTimeUtc: '2026-09-20T20:00:00.000Z', effectiveScore: 8, name: 'Different Matchup' });
    const { plan } = computeWindowPlan(new Map([['2026-09-19', day1], ['2026-09-20', [mlbToday]]]));
    assert.deepEqual(plan.get('2026-09-20').map(m => m.id), ['mlb-today']);
  });

  test('computeWindowPlan exposes sportConcentration over the whole window\'s own final picks', () => {
    const day1 = [mlbMatch({ id: 'd1', startTimeUtc: '2026-09-19T20:00:00.000Z', effectiveScore: 8 })];
    const day2 = [makeMatch({ id: 'd2', sport: 'F1', startTimeUtc: '2026-09-20T20:00:00.000Z', durationMinutes: 75, enduranceScore: 10, effectiveScore: 8 })];
    const { sportConcentration } = computeWindowPlan(new Map([['2026-09-19', day1], ['2026-09-20', day2]]));
    assert.equal(sportConcentration.get('MLB'), 0.5);
    assert.equal(sportConcentration.get('F1'), 0.5);
  });

  test('recentPicksByDayKey exposes exactly the rolling window each day\'s own penalty was weighed against', () => {
    const day1 = [mlbMatch({ id: 'd1', startTimeUtc: '2026-09-19T20:00:00.000Z', effectiveScore: 8 })];
    const day2 = [mlbMatch({ id: 'd2', startTimeUtc: '2026-09-20T20:00:00.000Z', effectiveScore: 8, name: 'Different Matchup' })];
    const { recentPicksByDayKey } = computeWindowPlan(new Map([['2026-09-19', day1], ['2026-09-20', day2]]));
    assert.deepEqual(recentPicksByDayKey.get('2026-09-19'), []); // nothing before the first day
    assert.deepEqual(
      recentPicksByDayKey.get('2026-09-20').map(m => m.id),
      ['d1']
    );
  });
});

describe('Test 9 - deterministic planning', () => {
  test('the same input always produces the same plan', () => {
    const build = () => [
      footballMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', effectiveScore: 7 }),
      footballMatch({ id: 'b', startTimeUtc: '2026-09-19T12:05:00.000Z', effectiveScore: 6.5 }),
      footballMatch({ id: 'c', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 8 })
    ];
    const runs = Array.from({ length: 5 }, () => computeDayPlan('2026-09-19', build()).map(m => m.id));
    runs.forEach(run => assert.deepEqual(run, runs[0]));
  });
});

describe('Test 10 - an unselected alternative stays visible, never deleted', () => {
  test('the losing member of a conflict window is still in the returned day list, flagged as an alternative', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 9 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:02:00.000Z', effectiveScore: 7 });
    const dayMatches = [a, b];
    computeDayPlan('2026-09-19', dayMatches);
    assert.equal(dayMatches.length, 2); // nothing removed from the input array
    assert.equal(b.recommended, false);
    assert.deepEqual(a.alternativeIds, ['b']);
  });
});

describe('Invariant checks', () => {
  test('Invariant 1: a match is never both recommended and listed as someone else\'s alternative', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', effectiveScore: 7 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T14:10:00.000Z', effectiveScore: 7 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T14:12:00.000Z', effectiveScore: 6 });
    const plan = computeDayPlan('2026-09-19', [a, b, c]);
    const recommendedIds = new Set(plan.map(m => m.id));
    [a, b, c].forEach(m => {
      (m.alternativeIds || []).forEach(altId => assert.ok(!recommendedIds.has(altId)));
    });
  });

  test('Invariant 2: no two selected matches have a genuine scheduling conflict', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', effectiveScore: 7 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T14:10:00.000Z', effectiveScore: 7 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T16:20:00.000Z', effectiveScore: 7 });
    const plan = computeDayPlan('2026-09-19', [a, b, c]);
    for (let i = 0; i < plan.length; i++) {
      for (let j = i + 1; j < plan.length; j++) {
        assert.ok(canWatchSequentially(plan[i], plan[j]));
      }
    }
  });

  test('Invariant 3: a valid continuation is never discarded merely because another match won an EARLIER conflict', () => {
    // Same setup as Test 3 - A "won" its own head-to-head against B on raw
    // score, but the scheduler still finds B->C over A alone.
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 150, effectiveScore: 10 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T19:20:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const plan = computeDayPlan('2026-09-19', [a, b, c]);
    assert.deepEqual(plan.map(m => m.id), ['b', 'c']);
  });

  test('Invariant 4: a diversity penalty reduces planningScore but never deletes the match or corrupts effectiveScore', () => {
    const day1 = [footballMatch({ id: 'a1', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 8, name: 'X' })];
    const a2 = footballMatch({ id: 'a2', startTimeUtc: '2026-09-20T18:00:00.000Z', effectiveScore: 8, name: 'X' });
    const { plan } = computeWindowPlan(new Map([['2026-09-19', day1], ['2026-09-20', [a2]]]));
    assert.ok(plan.get('2026-09-20').some(m => m.id === 'a2')); // still recommended - no rival to lose to
    assert.equal(a2.effectiveScore, 8); // never mutated
    // Both the matchup-repeat penalty (1.5, same matchup as yesterday) AND
    // the sport-concentration penalty (1, day1's only pick was also
    // Premier League - 100% share) apply here since this is a
    // single-candidate day with nothing to diversify against; still never
    // enough to drop the pick when nothing else is competing for the slot.
    assert.equal(a2.planningScore, 5.5);
  });
});

describe('groupIntoSlots is anchor-independent (docs bug #7)', () => {
  test('the resulting clusters do not depend on the input array\'s order', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 9 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:02:00.000Z', effectiveScore: 5 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T18:04:00.000Z', effectiveScore: 7 });
    const forward = groupIntoSlots([a, b, c]);
    const reversed = groupIntoSlots([c, b, a]);
    const normalize = clusters => clusters.map(s => s.members.map(m => m.id).sort().join(',')).sort();
    assert.deepEqual(normalize(forward), normalize(reversed));
  });
});

describe('a pinned choice only excludes matches it directly conflicts with', () => {
  test('pinning one member of a wider cluster leaves an unrelated free candidate schedulable', () => {
    // a-b near-totally overlap, b-c near-totally overlap, but a-c do not -
    // one transitive presentational cluster, but pinning b should only
    // hard-exclude a and c if THEY individually conflict with b.
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 9 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:01:00.000Z', effectiveScore: 8 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T18:02:00.000Z', effectiveScore: 7 });
    const pinnedForDay = new Map([[[a.id, b.id, c.id].sort().join('|'), 'b']]);
    const plan = computeDayPlan('2026-09-19', [a, b, c], pinnedForDay);
    assert.deepEqual(plan.map(m => m.id), ['b']);
    assert.equal(b.recommended, true);
  });
});

describe('§27 explainWhyNotRecommended', () => {
  test('a match that IS recommended has nothing to explain', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 8 });
    computeDayPlan('2026-09-19', [a]);
    const result = explainWhyNotRecommended('a', '2026-09-19', [a]);
    assert.equal(result.reason, 'recommended');
  });

  test('a finished match is explained as finished, never re-scheduled', () => {
    const a = footballMatch({ id: 'a', isFinished: true, effectiveScore: 99 });
    assert.equal(explainWhyNotRecommended('a', '2026-09-19', [a]).reason, 'finished');
  });

  test('a quiet-hours match is explained as such', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T03:00:00.000Z', effectiveScore: 99 });
    assert.equal(explainWhyNotRecommended('a', '2026-09-19', [a]).reason, 'quietHours');
  });

  test('lostToBetterSequence: names the real conflicting winners and gives real, comparable values', () => {
    // Same "A alone (10) loses to B+C (18)" scenario as Test 3.
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 150, effectiveScore: 10, name: 'A' });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 60, effectiveScore: 9, name: 'B' });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T19:20:00.000Z', durationMinutes: 60, effectiveScore: 9, name: 'C' });
    computeDayPlan('2026-09-19', [a, b, c], null, { scoreField: 'effectiveScore' });
    const result = explainWhyNotRecommended('a', '2026-09-19', [a, b, c], null, { scoreField: 'effectiveScore' });
    assert.equal(result.reason, 'lostToBetterSequence');
    assert.deepEqual(new Set(result.conflictsWith), new Set(['b', 'c']));
    assert.equal(result.actualValue, 18);
    assert.equal(result.wouldBeValue, 10);
  });

  test('blockedByPin: a pin is genuinely what excluded a candidate that would otherwise have won', () => {
    const pinned = footballMatch({ id: 'pinned', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 2, name: 'Pinned' });
    const wouldWin = footballMatch({ id: 'would-win', startTimeUtc: '2026-09-19T18:01:00.000Z', effectiveScore: 9, name: 'Would Win' });
    const key = [pinned.id, wouldWin.id].sort().join('|');
    const pinnedForDay = new Map([[key, 'pinned']]);
    computeDayPlan('2026-09-19', [pinned, wouldWin], pinnedForDay, { scoreField: 'effectiveScore' });
    assert.equal(pinned.recommended, true);
    assert.equal(wouldWin.recommended, false);
    const result = explainWhyNotRecommended('would-win', '2026-09-19', [pinned, wouldWin], pinnedForDay, { scoreField: 'effectiveScore' });
    assert.equal(result.reason, 'blockedByPin');
    assert.equal(result.wouldBeValue, 9);
    assert.equal(result.actualValue, 2);
  });

  test('lowValue: a standalone candidate whose own score genuinely wasn\'t worth its slot', () => {
    const negative = footballMatch({ id: 'negative', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: -5 });
    const result = explainWhyNotRecommended('negative', '2026-09-19', [negative], null, { scoreField: 'effectiveScore' });
    assert.equal(result.reason, 'lowValue');
    assert.deepEqual(result.conflictsWith, undefined);
  });

  test('an unknown candidate id is reported plainly, never throws', () => {
    const a = footballMatch({ id: 'a', effectiveScore: 5 });
    assert.equal(explainWhyNotRecommended('does-not-exist', '2026-09-19', [a]).reason, 'notFound');
  });

  test('never mutates the caller\'s own match objects (clones internally)', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 150, effectiveScore: 10 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T19:20:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    computeDayPlan('2026-09-19', [a, b, c], null, { scoreField: 'effectiveScore' });
    const beforeA = { ...a };
    explainWhyNotRecommended('a', '2026-09-19', [a, b, c], null, { scoreField: 'effectiveScore' });
    assert.deepEqual(a, beforeA); // untouched by the speculative re-runs
  });
});

describe('describeEvidence / isEvidenceFresh (structured evidence)', () => {
  function evidenceMatch(overrides = {}) {
    return makeMatch({
      evidence: [
        { category: 'eventImportance', finding: 'This decides the division.', source: 'current standings', retrievedAt: '2026-09-19T06:00:00.000Z' },
        { category: 'bogus', finding: 'mislabeled but real', source: 'x', retrievedAt: '2026-09-19T00:00:00.000Z' }
      ],
      evidenceRetrievedAt: '2026-09-19T06:00:00.000Z',
      ...overrides
    });
  }

  test('describeEvidence attaches the Traditional Chinese label for each category', () => {
    const items = describeEvidence(evidenceMatch());
    assert.equal(items.length, 2);
    assert.equal(items[0].label, EVIDENCE_CATEGORY_LABELS.eventImportance);
    assert.equal(items[0].finding, 'This decides the division.');
  });

  test('an unrecognized category still gets labeled (falls back to the recentContext label), never dropped', () => {
    const items = describeEvidence(evidenceMatch());
    assert.equal(items[1].category, 'bogus'); // the raw category is passed through as-is
    assert.equal(items[1].label, EVIDENCE_CATEGORY_LABELS.recentContext);
  });

  test('a match with no evidence returns an empty array, not null/undefined', () => {
    assert.deepEqual(describeEvidence(makeMatch({ evidence: [] })), []);
    assert.deepEqual(describeEvidence(makeMatch({ evidence: undefined })), []);
    assert.deepEqual(describeEvidence(null), []);
  });

  test('isEvidenceFresh is true within the freshness window, false once past it', () => {
    const recent = evidenceMatch({ evidenceRetrievedAt: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(isEvidenceFresh(recent), true);

    const stale = evidenceMatch({ evidenceRetrievedAt: new Date(Date.now() - (EVIDENCE_FRESH_MAX_AGE_HOURS + 1) * 3_600_000).toISOString() });
    assert.equal(isEvidenceFresh(stale), false);
  });

  test('isEvidenceFresh is false when there is no evidenceRetrievedAt at all', () => {
    assert.equal(isEvidenceFresh(makeMatch({ evidenceRetrievedAt: null })), false);
    assert.equal(isEvidenceFresh(makeMatch({})), false);
  });
});

describe('matchLifecycleState (UPCOMING -> STARTING_SOON -> LIVE -> ENDING_SOON -> ENDED)', () => {
  const START = Date.parse('2026-09-19T18:00:00.000Z');
  function timedMatch(overrides = {}) {
    return makeMatch({ startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 190, sport: 'Premier League', ...overrides });
  }

  test('isFinished is authoritative - ENDED regardless of how much time has or has not passed', () => {
    assert.equal(matchLifecycleState(timedMatch({ isFinished: true }), START - 60_000), LIFECYCLE_STATES.ENDED);
    assert.equal(matchLifecycleState(timedMatch({ isFinished: true }), START + 60_000), LIFECYCLE_STATES.ENDED);
  });

  test('a TBD fixture is always UPCOMING - there is no trustworthy time to schedule STARTING_SOON/LIVE against', () => {
    assert.equal(matchLifecycleState(timedMatch({ timeTbd: true }), START - 60_000), LIFECYCLE_STATES.UPCOMING);
  });

  test('well before start: UPCOMING', () => {
    assert.equal(matchLifecycleState(timedMatch(), START - 60 * 60_000), LIFECYCLE_STATES.UPCOMING);
  });

  test('within STARTING_SOON_WINDOW_MINUTES of start: STARTING_SOON, never before it', () => {
    assert.equal(matchLifecycleState(timedMatch(), START - STARTING_SOON_WINDOW_MINUTES * 60_000), LIFECYCLE_STATES.STARTING_SOON);
    assert.equal(
      matchLifecycleState(timedMatch(), START - (STARTING_SOON_WINDOW_MINUTES + 1) * 60_000),
      LIFECYCLE_STATES.UPCOMING
    );
  });

  test('between start and the estimated end (minus the ending-soon window): LIVE', () => {
    assert.equal(matchLifecycleState(timedMatch(), START + 5_000), LIFECYCLE_STATES.LIVE);
    assert.equal(matchLifecycleState(timedMatch(), START + 60 * 60_000), LIFECYCLE_STATES.LIVE);
  });

  test('near the estimated end: ENDING_SOON', () => {
    const estimatedEnd = START + estimatedDurationMinutes(timedMatch()) * 60_000;
    assert.equal(matchLifecycleState(timedMatch(), estimatedEnd - 60_000), LIFECYCLE_STATES.ENDING_SOON);
  });

  // The direct regression test for the reported bug: a match whose expected
  // (estimated) time has passed, but that ESPN hasn't reported finished yet,
  // must NEVER read as "about to start" again - it was already live. The
  // OLD relativeLabel computed diffMin = start - now and returned "即將開始"
  // (starting soon) for ANY diffMin <= 0, which was only ever reachable once
  // `now` was already past the nominal end.
  test('past the estimated end but still not isFinished: stays LIVE, never STARTING_SOON/UPCOMING/ENDED', () => {
    const match = timedMatch({ sport: 'MLB', durationMinutes: 190, enduranceScore: 10 });
    const wellPastEstimatedEnd = START + 10 * 60 * 60_000; // 10 real hours after kickoff
    assert.equal(matchLifecycleState(match, wellPastEstimatedEnd), LIFECYCLE_STATES.LIVE);
  });
});

describe('naturalSlotChoice (what the algorithm would pick absent THIS pin)', () => {
  test('returns the unpinned winner of a slot when nothing else is pinned', () => {
    const a = makeMatch({ id: 'a', sport: 'Premier League', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 115, enduranceScore: 10, effectiveScore: 9 });
    const b = makeMatch({ id: 'b', sport: 'Premier League', startTimeUtc: '2026-09-19T18:02:00.000Z', durationMinutes: 115, enduranceScore: 10, effectiveScore: 7 });
    const dayMatches = [a, b];
    const natural = naturalSlotChoice('2026-09-19', dayMatches, slotKeyFromMembers([a, b]));
    assert.equal(natural, 'a');
  });

  test('this exact slot\'s own pin is set aside, so it reflects the TRUE unpinned default, not whatever is currently pinned there', () => {
    const a = makeMatch({ id: 'a', sport: 'Premier League', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 115, enduranceScore: 10, effectiveScore: 9 });
    const b = makeMatch({ id: 'b', sport: 'Premier League', startTimeUtc: '2026-09-19T18:02:00.000Z', durationMinutes: 115, enduranceScore: 10, effectiveScore: 7 });
    const slotKey = slotKeyFromMembers([a, b]);
    // Even with b currently pinned, the natural (unpinned) winner is still a.
    const pinnedForDay = new Map([[slotKey, 'b']]);
    const natural = naturalSlotChoice('2026-09-19', [a, b], slotKey, pinnedForDay);
    assert.equal(natural, 'a');
  });

  test('OTHER pins still apply while computing this slot\'s own natural default', () => {
    // c is pinned in a way that blocks a's own slot from winning naturally
    // once c's own fixed window is respected - see this file's Test 3/5
    // family for the same "forced pins split the day into gaps" mechanics.
    const a = makeMatch({ id: 'a', sport: 'Premier League', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 60, enduranceScore: 10, effectiveScore: 5 });
    const b = makeMatch({ id: 'b', sport: 'Premier League', startTimeUtc: '2026-09-19T18:02:00.000Z', durationMinutes: 60, enduranceScore: 10, effectiveScore: 9 });
    const slotAB = slotKeyFromMembers([a, b]);
    const natural = naturalSlotChoice('2026-09-19', [a, b], slotAB, new Map());
    assert.equal(natural, 'b'); // b wins on its own merits absent any pin
  });
});
