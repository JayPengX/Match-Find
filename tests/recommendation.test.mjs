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
  OWNED_SERVICE_SCORE_BONUS,
  resolveSportTiming,
  schedulingDurationMinutes,
  schedulingInterval,
  canWatchSequentially,
  SPORT_TIMING,
  DURATION_UNCERTAINTY_BY_RELIABILITY,
  TRANSITION_BUFFER_MINUTES,
  matchupKey,
  daysBetweenDayKeys,
  recentRepeatPenalty,
  applyRecentRepeatPenalties,
  computeWindowPlan,
  describeEvidence,
  isEvidenceFresh,
  EVIDENCE_CATEGORY_LABELS,
  EVIDENCE_FRESH_MAX_AGE_HOURS
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

  test('MLB (low reliability) schedulingInterval ends earlier than its full nominal length would suggest', () => {
    const game = mlbMatch({ startTimeUtc: '2026-09-19T18:00:00.000Z' });
    const nominalEnd = Date.parse('2026-09-19T18:00:00.000Z') + 190 * 60_000;
    assert.ok(schedulingInterval(game).end < nominalEnd);
  });

  test('resolveSportTiming falls back to a medium default for an unlisted sport', () => {
    assert.equal(resolveSportTiming('Curling').durationReliability, 'medium');
    assert.equal(DURATION_UNCERTAINTY_BY_RELIABILITY[resolveSportTiming('Curling').durationReliability], 0.1);
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

describe('Test 5 - MLB continuation (duration uncertainty)', () => {
  test('a later match can follow an MLB game once its uncertainty-adjusted end has passed, even though the nominal 190-minute length has not', () => {
    const game = mlbMatch({ id: 'mlb', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 7 });
    // 20:30 is well before MLB's nominal end (21:10) but after its
    // schedulingInterval end (~20:23, see the worked example above).
    const next = footballMatch({ id: 'next', startTimeUtc: '2026-09-19T20:30:00.000Z', effectiveScore: 7 });
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
    assert.equal(a2.planningScore, 6.5); // only planningScore carries the penalty
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
