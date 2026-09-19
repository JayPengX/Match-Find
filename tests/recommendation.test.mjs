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
  recommendStyleScore,
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
  OWNED_SERVICE_SCORE_BONUS
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

describe('recommendStyleScore', () => {
  test('entertainment style blends watchability with broadcastQuality at the documented weight', () => {
    const match = makeMatch({ watchability: 8, broadcastQuality: 4, score: 5 });
    const expected = 8 * (1 - BROADCAST_QUALITY_WEIGHT) + 4 * BROADCAST_QUALITY_WEIGHT;
    assert.equal(recommendStyleScore(match, 'entertainment'), expected);
  });

  test('competitive style uses the build-time composite score, not watchability', () => {
    const match = makeMatch({ watchability: 9, score: 5, broadcastQuality: 5 });
    assert.equal(recommendStyleScore(match, 'competitive'), 5);
  });

  test('an unrecognized style falls back to the composite score, same as competitive', () => {
    const match = makeMatch({ watchability: 9, score: 5, broadcastQuality: 5 });
    assert.equal(recommendStyleScore(match, 'nonsense'), 5);
  });

  test('a missing broadcastQuality (finished/never-scored match) skips the blend entirely', () => {
    const match = makeMatch({ watchability: 8, broadcastQuality: null });
    assert.equal(recommendStyleScore(match, 'entertainment'), 8);
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

    const unranked = computeEffectiveScore(makeMatch({ sport: 'MLS', broadcastQuality: null, score: 5 }), {
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

  test('effectiveScore is exactly styleScore + priority + service, nothing hidden', () => {
    const match = makeMatch({ sport: 'MLB', watchability: 7, broadcastQuality: 9, whereToWatchTw: 'Apple TV' });
    const breakdown = computeEffectiveScore(match, {
      priorityOrder: ['MLB', 'NBA'],
      myServiceIds: new Set(['appletv']),
      recommendStyle: 'entertainment'
    });
    assert.equal(
      breakdown.effectiveScore,
      breakdown.styleScore + breakdown.adjustments.priority + breakdown.adjustments.service
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
  });

  test('non-overlapping fixtures across the day are all recommended independently', () => {
    const a = makeMatch({ id: 'a', startTimeUtc: '2026-09-19T12:00:00.000Z', durationMinutes: 60, effectiveScore: 6 });
    const b = makeMatch({ id: 'b', startTimeUtc: '2026-09-19T20:00:00.000Z', durationMinutes: 60, effectiveScore: 6 });
    const plan = computeDayPlan('2026-09-19', [a, b]);
    assert.equal(plan.length, 2);
    assert.ok(a.recommended && b.recommended);
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
