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
  CONFIDENCE_OBJECTIVE,
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
  BEST_MATCH_WEIGHTS,
  PRIORITY_SCORE_DELTA,
  OWNED_SERVICE_SCORE_BONUS,
  isMarqueeFixture,
  MARQUEE_FIXTURE_SCORE_BONUS,
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
  applyLiveExcitementBonus,
  computeWindowPlan,
  computeSportConcentration,
  naturalSlotChoice,
  estimatedDurationMinutes,
  STARTING_SOON_WINDOW_MINUTES,
  explainWhyNotRecommended,
  slotKeyFromMembers,
  liveExcitementBonus,
  LIVE_EXCITEMENT_MAX_BONUS,
  estimateLiveDurationMinutes,
  ALTERNATIVE_MAX_SCORE_GAP,
  selectGeminiTieBreakCandidates,
  buildGeminiTieBreakPayload,
  tieBreakCandidateKey,
  resolveGeminiOverridePin,
  computeDayPlanWithGeminiTieBreak,
  GEMINI_TIE_BREAK_MAX_CANDIDATES
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
    ...overrides
  };
}

describe('bestMatchScore (the one unified Best Matches blend)', () => {
  test('blends skill/competitiveness/watchability/enduranceScore/broadcastQuality at the documented weights', () => {
    const match = makeMatch({ skill: 9, competitiveness: 7, watchability: 8, enduranceScore: 6, broadcastQuality: 4 });
    const expected =
      9 * BEST_MATCH_WEIGHTS.skill +
      7 * BEST_MATCH_WEIGHTS.competitiveness +
      8 * BEST_MATCH_WEIGHTS.watchability +
      6 * BEST_MATCH_WEIGHTS.enduranceScore +
      4 * BEST_MATCH_WEIGHTS.broadcastQuality;
    assert.ok(Math.abs(bestMatchScore(match) - expected) < 1e-9);
  });

  test('SKILL (how good the teams are) is a genuinely separate axis from competitiveness (how close they are)', () => {
    // Two elite teams in a close game vs. two also-ran teams in an equally
    // close game - competitiveness/watchability alone can't tell these
    // apart, since neither depends on how good the two teams actually are.
    const eliteMatchup = makeMatch({ skill: 9, competitiveness: 8, watchability: 8, enduranceScore: 8, broadcastQuality: 8 });
    const alsoRanMatchup = makeMatch({ skill: 2, competitiveness: 8, watchability: 8, enduranceScore: 8, broadcastQuality: 8 });
    assert.ok(bestMatchScore(eliteMatchup) > bestMatchScore(alsoRanMatchup));
  });

  // Round 39 (2026-09-22): direct instruction, after live-verifying the
  // real numeric consequence first - a clearly better team in a slightly
  // less tense pairing must beat a lesser team in a tense one, generally,
  // not just on one complained-about date. Live-verified case (2026-09-24):
  // Milwaukee Brewers @ Philadelphia Phillies (skill 8, comp 7) must beat
  // Cleveland Guardians @ Boston Red Sox (skill 6, comp 8) - the exact real
  // pairing that motivated raising BEST_MATCH_WEIGHTS.skill from 0.2 to
  // 0.35 (and lowering competitiveness from 0.2 to 0.05 to compensate).
  // Deliberately real numbers, not synthetic ones, so this test would have
  // failed against the OLD weights (7.35 beat 7.05) and correctly reflects
  // the tradeoff the user explicitly accepted (see BEST_MATCH_WEIGHTS' own
  // comment): the SAME shape also flips Chicago Cubs @ Boston Red Sox
  // (skill 6, comp 8) below Tampa Bay Rays @ Philadelphia Phillies (skill 7,
  // comp 7) on 9/26/27 - confirmed acceptable, not a silent regression.
  test('a clearly-better team in a less-tense pairing beats a lesser team in a tenser one (Round 39)', () => {
    const brewersPhillies = makeMatch({ skill: 8, competitiveness: 7, watchability: 8, enduranceScore: 5, broadcastQuality: 5 });
    const guardiansRedSox = makeMatch({ skill: 6, competitiveness: 8, watchability: 8, enduranceScore: 7, broadcastQuality: 7 });
    assert.ok(bestMatchScore(brewersPhillies) > bestMatchScore(guardiansRedSox));
  });

  test('renormalizes over whichever dimensions are actually present', () => {
    const match = makeMatch({
      competitiveness: undefined,
      watchability: 8,
      enduranceScore: undefined,
      broadcastQuality: 4
    });
    const totalWeight = BEST_MATCH_WEIGHTS.watchability + BEST_MATCH_WEIGHTS.broadcastQuality;
    const expected =
      (8 * BEST_MATCH_WEIGHTS.watchability + 4 * BEST_MATCH_WEIGHTS.broadcastQuality) / totalWeight;
    assert.ok(Math.abs(bestMatchScore(match) - expected) < 1e-9);
  });

  test('no dimension can dominate on its own - one exceptional axis alone is not enough to top a well-rounded match', () => {
    // A one-dimensional "10 at watchability, mediocre everywhere else" match
    // should NOT beat a well-rounded match that's merely good across the board.
    const oneDimensional = makeMatch({ competitiveness: 2, watchability: 10, enduranceScore: 2, broadcastQuality: 2 });
    const wellRounded = makeMatch({ competitiveness: 7, watchability: 7, enduranceScore: 7, broadcastQuality: 7 });
    assert.ok(bestMatchScore(wellRounded) > bestMatchScore(oneDimensional));
  });

  test('falls back to watchability, then the build-time composite score, when nothing else is set at all', () => {
    const withWatchability = makeMatch({
      competitiveness: undefined,
      watchability: 8,
      enduranceScore: undefined,
      broadcastQuality: undefined
    });
    assert.equal(bestMatchScore(withWatchability), 8);

    const nothingAtAll = makeMatch({
      competitiveness: undefined,
      watchability: undefined,
      enduranceScore: undefined,
      broadcastQuality: undefined,
      score: 5
    });
    assert.equal(bestMatchScore(nothingAtAll), 5);
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

  test('effectiveScore is exactly bestMatchScore + priority + service + marquee, nothing hidden', () => {
    const match = makeMatch({ sport: 'MLB', watchability: 7, broadcastQuality: 9, whereToWatchTw: 'Apple TV' });
    const breakdown = computeEffectiveScore(match, {
      priorityOrder: ['MLB', 'NBA'],
      myServiceIds: new Set(['appletv'])
    });
    assert.equal(
      breakdown.effectiveScore,
      breakdown.bestMatchScore + breakdown.adjustments.priority + breakdown.adjustments.service + breakdown.adjustments.marquee
    );
  });

  // Live-verified case (docs/recommendation-engine-audit.md Round 14):
  // Liverpool @ AFC Bournemouth (2026-09-20) lost its slot to Crystal Palace
  // @ Leeds United even after isBigClub's own +2 watchability bump, because
  // that bump only reaches bestMatchScore diluted through watchability's own
  // 0.35 weight (worth +0.7 net, nowhere near enough). The marquee bonus is
  // applied UNDILUTED, on top of bestMatchScore, same as priority/service.
  test('a marquee fixture (derby/big-club/rivalry) gets its bonus applied undiluted, not blended through watchability', () => {
    const marquee = makeMatch({ objectiveFactors: ['known big-club fixture'] });
    const plain = makeMatch({ objectiveFactors: ['season win% gap 5.0pp'] });
    const marqueeBreakdown = computeEffectiveScore(marquee, {});
    const plainBreakdown = computeEffectiveScore(plain, {});
    assert.equal(marqueeBreakdown.adjustments.marquee, MARQUEE_FIXTURE_SCORE_BONUS);
    assert.equal(plainBreakdown.adjustments.marquee, 0);
    assert.equal(marqueeBreakdown.effectiveScore, marqueeBreakdown.bestMatchScore + MARQUEE_FIXTURE_SCORE_BONUS);
  });

  // Round 31: MLB's own computeMlbObjectiveScore now sets a graduated
  // marqueeCredit fraction (see objective-score.mjs's marqueeCreditFraction)
  // instead of an all-or-nothing gate. Without threading that fraction
  // through here too, ANY nonzero internal credit would still trip
  // isMarqueeFixture's own boolean detection and hand out the FULL
  // undiluted bonus regardless of how small that credit was - re-creating
  // an all-or-nothing cliff one layer up.
  test('marqueeCredit (when present on the match) scales the undiluted marquee bonus proportionally', () => {
    const full = makeMatch({ objectiveFactors: ['known historic rivalry matchup'], marqueeCredit: 1 });
    const half = makeMatch({ objectiveFactors: ['known historic rivalry matchup'], marqueeCredit: 0.5 });
    const none = makeMatch({ objectiveFactors: ['known historic rivalry matchup'], marqueeCredit: 0 });
    assert.equal(computeEffectiveScore(full, {}).adjustments.marquee, MARQUEE_FIXTURE_SCORE_BONUS);
    assert.equal(computeEffectiveScore(half, {}).adjustments.marquee, MARQUEE_FIXTURE_SCORE_BONUS * 0.5);
    assert.equal(computeEffectiveScore(none, {}).adjustments.marquee, 0);
  });

  test('a match with no marqueeCredit field at all (NBA/EPL, or any older match object) still gets the full undiluted bonus - unchanged behavior', () => {
    const match = makeMatch({ objectiveFactors: ['known derby fixture'] });
    assert.equal(match.marqueeCredit, undefined);
    assert.equal(computeEffectiveScore(match, {}).adjustments.marquee, MARQUEE_FIXTURE_SCORE_BONUS);
  });

  test('computeRecommendationScore composes the score breakdown with confidence', () => {
    const match = makeMatch();
    const result = computeRecommendationScore(match, {});
    assert.equal(result.finalScore, computeEffectiveScore(match, {}).effectiveScore);
    assert.equal(result.confidence, CONFIDENCE_OBJECTIVE);
    assert.ok(result.adjustments);
    assert.equal(typeof result.baseScore, 'number');
  });
});

describe('isMarqueeFixture', () => {
  test('true for derby/big-club/rivalry factor strings, false otherwise', () => {
    assert.equal(isMarqueeFixture(makeMatch({ objectiveFactors: ['known derby fixture'] })), true);
    assert.equal(isMarqueeFixture(makeMatch({ objectiveFactors: ['known big-club fixture'] })), true);
    assert.equal(isMarqueeFixture(makeMatch({ objectiveFactors: ['known historic rivalry matchup'] })), true);
    assert.equal(isMarqueeFixture(makeMatch({ objectiveFactors: ['known rivalry matchup'] })), true);
    assert.equal(isMarqueeFixture(makeMatch({ objectiveFactors: ['season win% gap 5.0pp'] })), false);
    assert.equal(isMarqueeFixture(makeMatch({ objectiveFactors: [] })), false);
    assert.equal(isMarqueeFixture(makeMatch({ objectiveFactors: undefined })), false);
  });
});

describe('computeConfidence', () => {
  test('a match with a real computed score gets the one objective confidence value', () => {
    assert.equal(computeConfidence(makeMatch({ score: 7 })), CONFIDENCE_OBJECTIVE);
  });
  test('a match with no score at all (never scored) has null confidence', () => {
    assert.equal(computeConfidence(makeMatch({ score: undefined })), null);
  });
  test('a missing match object is never confident', () => {
    assert.equal(computeConfidence(null), null);
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

  test('a non-conflicting negative-score candidate is still included, not dropped for "lowering the total"', () => {
    // Reproduces the reported bug: a perfectly fine, non-overlapping evening
    // fixture whose stacked penalties (repeat/sport-concentration/priority)
    // happened to net negative was silently left off the day's plan even
    // though including it cost nothing - the unfloored DP would rather
    // recommend NOTHING in that free slot than add a "negative-value" item.
    const items = [
      { interval: { start: 0, end: 60 }, choice: { effectiveScore: 5, id: 'earlier' } },
      { interval: { start: 100, end: 160 }, choice: { effectiveScore: -0.5, id: 'later' } }
    ];
    const picks = weightedIntervalSchedule(items).map(p => p.choice.id);
    assert.deepEqual(picks.sort(), ['earlier', 'later']);
  });

  test('a negative score still loses to a genuinely better, overlapping alternative', () => {
    const items = [
      { interval: { start: 0, end: 60 }, choice: { effectiveScore: -0.5, id: 'weak' } },
      { interval: { start: 30, end: 90 }, choice: { effectiveScore: 4, id: 'strong' } }
    ];
    const picks = weightedIntervalSchedule(items).map(p => p.choice.id);
    assert.deepEqual(picks, ['strong']);
  });
});

describe('computeDayPlan', () => {
  test('a finished match IS a real candidate - the plan is one whole calendar day, not just what is still ahead', () => {
    // "Sport recommendation runs as one day-unit" - a viewer opening the
    // page mid-afternoon should see the same whole-day lineup a viewer this
    // morning would have, this morning's game shown as history in its own
    // rightful slot rather than silently dropped once it ends.
    const finished = makeMatch({ id: 'f', isFinished: true, effectiveScore: 99, startTimeUtc: '2026-09-19T12:00:00.000Z' });
    const plan = computeDayPlan('2026-09-19', [finished]);
    assert.deepEqual(plan.map(m => m.id), ['f']);
    assert.equal(finished.recommended, true);
  });

  test('a finished match still competes normally for its own slot against another candidate', () => {
    const strongerFinished = makeMatch({ id: 'a', isFinished: true, startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const weakerFinished = makeMatch({ id: 'b', isFinished: true, startTimeUtc: '2026-09-19T18:02:00.000Z', durationMinutes: 60, effectiveScore: 7 });
    const plan = computeDayPlan('2026-09-19', [strongerFinished, weakerFinished]);
    assert.deepEqual(plan.map(m => m.id), ['a']);
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
    const pinnedForDay = new Set(['b']);
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
    const [out] = resolveViewingPlan([makeMatch()]);
    assert.ok(out.scoreBreakdown);
    assert.equal(out.confidence, CONFIDENCE_OBJECTIVE);
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
    const pinnedForDay = new Set(['a']);
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

describe('alternativeIds only surfaces a genuine choice, not every conflict', () => {
  test('a direct conflict clearly worse than the pick is never offered as a swipeable alternative', () => {
    // The pick (9) so thoroughly outclasses its only conflict (3, a gap of
    // 6, well past ALTERNATIVE_MAX_SCORE_GAP) that presenting them as a
    // coin flip would be actively misleading - the loser stays fully
    // visible elsewhere (renderAllMatchesSection), it just isn't offered
    // as if it were a real second opinion in this slot's own stack.
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 9 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:02:00.000Z', effectiveScore: 3 });
    const plan = computeDayPlan('2026-09-19', [a, b]);
    assert.deepEqual(plan.map(m => m.id), ['a']);
    assert.equal(a.recommended, true);
    assert.equal(b.recommended, false);
    assert.equal(a.alternativeIds, null); // no genuine choice here - render as a single card
  });

  test('a direct conflict right at the edge of the gap still counts as a genuine choice', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 9 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:02:00.000Z', effectiveScore: 9 - ALTERNATIVE_MAX_SCORE_GAP });
    const plan = computeDayPlan('2026-09-19', [a, b]);
    assert.deepEqual(plan.map(m => m.id), ['a']);
    assert.deepEqual(a.alternativeIds, ['b']);
  });

  test('a conflict that is BETTER than the pick always stays in, however large the gap', () => {
    // A viewer-forced pin can beat a much stronger natural candidate (see
    // "a pinned choice only excludes matches it directly conflicts with"
    // above) - the quality gate must never hide that stronger option from
    // the stack, since that's the one case a viewer most needs to still
    // see and be able to swipe back to.
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 9 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:02:00.000Z', effectiveScore: 2 });
    const pinnedForDay = new Set(['b']);
    const plan = computeDayPlan('2026-09-19', [a, b], pinnedForDay);
    assert.deepEqual(plan.map(m => m.id), ['b']);
    assert.deepEqual(b.alternativeIds, ['a']);
  });

  test('in a 3-way slot only the genuinely close conflicts are offered, not the far-off one', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 9 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:02:00.000Z', effectiveScore: 8 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T18:04:00.000Z', effectiveScore: 2 });
    const plan = computeDayPlan('2026-09-19', [a, b, c]);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].id, 'a');
    assert.deepEqual(a.alternativeIds, ['b']);
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
    // schedulingInterval(game).end = 18:00 + 190*1.12 (overrun) + 10
    // (transition buffer) minutes = 21:42:48.
    const next = footballMatch({ id: 'next', startTimeUtc: '2026-09-19T22:10:00.000Z', effectiveScore: 7 });
    assert.ok(canWatchSequentially(game, next));
  });

  test('a FINISHED match is never padded with the overrun buffer - its own durationMinutes is already the real observed length', () => {
    // The exact reported bug: a game that dropped 30-60 minutes off its own
    // predicted length still had ANOTHER 25% padded on top once it was
    // already over, keeping an obviously-fine continuation blocked. Once
    // build-data.mjs marks a match isFinished, its durationMinutes is
    // already real (see build-data.mjs's finishedDurationMinutes) - there
    // is no more forward uncertainty left to hedge.
    const liveUncertain = mlbMatch({ durationMinutes: 150 });
    const finished = mlbMatch({ durationMinutes: 150, isFinished: true });
    assert.equal(schedulingDurationMinutes(finished), 150);
    assert.ok(schedulingDurationMinutes(liveUncertain) > 150);
  });

  test('a later match CAN immediately follow a finished MLB game that ran shorter than its own nominal length', () => {
    const game = mlbMatch({
      id: 'mlb',
      startTimeUtc: '2026-09-19T18:00:00.000Z',
      durationMinutes: 150,
      isFinished: true,
      effectiveScore: 7
    });
    // 18:00 + 150 min (no overrun, isFinished) + 10 min transition = 20:40.
    // The OLD (still-padded) model would have needed 18:00 + 150*1.25 + 10
    // = 21:17:30 before allowing this, which is exactly the reported
    // "obvious continuation" bug.
    const next = footballMatch({ id: 'next', startTimeUtc: '2026-09-19T20:45:00.000Z', effectiveScore: 7 });
    assert.ok(canWatchSequentially(game, next));
    const plan = computeDayPlan('2026-09-19', [game, next]);
    assert.deepEqual(plan.map(m => m.id).sort(), ['mlb', 'next']);
  });
});

describe('Test 5b (Round 36) - a LOW-enduranceScore MLB game still can\'t free its slot below the reliability floor', () => {
  test('SCHEDULING_DURATION_FLOOR_BY_RELIABILITY floors MLB at 85% of nominal even when effectiveDurationMinutes would go lower', () => {
    // enduranceScore 5 -> effectiveDurationMinutes = 159 * 0.7 = 111.3, well
    // under 159 * 0.85 = 135.15 - the floor must win.
    const game = mlbMatch({ durationMinutes: 159, enduranceScore: 5 });
    assert.ok(schedulingDurationMinutes(game) >= 159 * 0.85);
    // ...and the overrun buffer still applies ON TOP of the floor, not
    // instead of it.
    assert.ok(Math.abs(schedulingDurationMinutes(game) - 159 * 0.85 * 1.12) < 1e-6);
  });

  test('the exact live-reported bug: a later match canNOT immediately follow a LOW-endurance MLB game at a gap that used to read as safe', () => {
    // Live case (2026-09-27 TW time): Tampa Bay Rays @ Philadelphia
    // Phillies (durationMinutes 159, enduranceScore 5) at 07:15, Houston
    // Astros @ Athletics / Los Angeles Angels @ Seattle Mariners at 09:40 -
    // a 2h25m gap. Before this round's floor, effectiveDurationMinutes's
    // own 111.3min (plus the 12% overrun and 10min transition) ended
    // ~2h14.66m after start, reading as a safe, non-overlapping
    // continuation - "it overlap" was the direct live report this
    // reproduces and fixes. schedulingInterval(game).end with the new
    // floor is 159*0.85*1.12 + 10min transition =~ 2h41.4m after start, so
    // the SAME 2h25m real gap now correctly reads as a genuine conflict.
    const game = mlbMatch({ id: 'mlb', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 159, enduranceScore: 5, effectiveScore: 7 });
    const next = mlbMatch({ id: 'next', startTimeUtc: '2026-09-19T20:25:00.000Z', effectiveScore: 6 });
    assert.ok(!canWatchSequentially(game, next));
    const plan = computeDayPlan('2026-09-19', [game, next], null, { scoreField: 'effectiveScore' });
    assert.deepEqual(plan.map(m => m.id), ['mlb']);
    assert.equal(next.recommended, false);
  });

  test('a later match CAN still follow once the gap clears the new, floored end (the floor is not unconditionally conservative)', () => {
    const game = mlbMatch({ id: 'mlb', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 159, enduranceScore: 5, effectiveScore: 7 });
    // schedulingInterval(game).end =~ 2h41.4m after start (see test above) -
    // a 3-hour gap is comfortably past that, same shape as this file's own
    // already-validated MLB-to-MLB continuations (~3+ hour real gaps).
    const next = mlbMatch({ id: 'next', startTimeUtc: '2026-09-19T21:00:00.000Z', effectiveScore: 6 });
    assert.ok(canWatchSequentially(game, next));
  });

  test('a FINISHED low-endurance MLB game is never floored either - its own real length already stands (no regression of the earlier "obvious continuation" fix)', () => {
    const finished = mlbMatch({ durationMinutes: 150, enduranceScore: 1, isFinished: true });
    assert.equal(schedulingDurationMinutes(finished), 150);
  });

  test('high/medium-reliability sports get no floor at all - unchanged from before this round', () => {
    const lowEndurance = footballMatch({ durationMinutes: 90, enduranceScore: 1 });
    // 90 * ENDURANCE_DURATION_FLOOR(0.4) = 36 - the floor must NOT lift this
    // back up for a high-reliability sport.
    assert.ok(schedulingDurationMinutes(lowEndurance) < 90 * 0.85);
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

describe('Tests 7/8 - cross-day repeat/concentration penalties were removed', () => {
  // Direct user feedback: this viewer mostly doesn't watch on weekdays at
  // all, so a penalty comparing today's best game against whatever won a
  // weekday slot he never watched anyway just buried a genuinely great
  // game for a "variety" benefit that never applied to him. These tests
  // confirm the same matchup (or the same sport) winning its slot on
  // consecutive days is no longer penalized at all - planningScore is
  // exactly effectiveScore plus the live-match excitement bonus.
  test('the same matchup winning on consecutive days is never penalized', () => {
    const day1 = [footballMatch({ id: 'a1', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 8, name: 'Same Matchup' })];
    const a2 = footballMatch({ id: 'a2', startTimeUtc: '2026-09-20T18:00:00.000Z', effectiveScore: 8, name: 'Same Matchup' });
    const b = footballMatch({ id: 'b2', startTimeUtc: '2026-09-20T18:00:00.000Z', effectiveScore: 7.8, name: 'Different Matchup' });
    const { plan } = computeWindowPlan(
      new Map([
        ['2026-09-19', day1],
        ['2026-09-20', [a2, b]]
      ])
    );
    assert.deepEqual(plan.get('2026-09-19').map(m => m.id), ['a1']);
    // a2 still wins on its own merits (8 > 7.8) - no repeat penalty drags
    // it down to lose to the weaker alternative.
    assert.deepEqual(plan.get('2026-09-20').map(m => m.id), ['a2']);
    assert.equal(a2.planningScore, 8);
  });

  test('the same sport winning every day in a row is never penalized', () => {
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
    // MLB still wins today (8 > 7.5) despite winning every prior day too -
    // no sport-concentration penalty ever applied to bury it.
    assert.equal(mlbToday.planningScore, 8);
    assert.deepEqual(plan.get('2026-09-20').map(m => m.id), ['mlb-today']);
  });

  test('matchupKey is order-independent and keeps F1 session types distinct', () => {
    const a = makeMatch({ sport: 'MLB', competitors: [{ name: 'Rays' }, { name: 'Yankees' }] });
    const b = makeMatch({ sport: 'MLB', competitors: [{ name: 'Yankees' }, { name: 'Rays' }] });
    assert.equal(matchupKey(a), matchupKey(b));
    const qual = makeMatch({ sport: 'F1', name: 'GP Qualifying', competitors: [] });
    const race = makeMatch({ sport: 'F1', name: 'GP', competitors: [] });
    assert.notEqual(matchupKey(qual), matchupKey(race));
  });

  test('applyLiveExcitementBonus never touches effectiveScore itself, only the planningScore field', () => {
    const match = footballMatch({ id: 'a', startTimeUtc: '2026-09-20T18:00:00.000Z', effectiveScore: 8 });
    applyLiveExcitementBonus([match]);
    assert.equal(match.effectiveScore, 8);
    assert.equal(match.planningScore, 8); // no live bonus - not a live match
  });
});

describe('sport concentration is a pure diagnostic (no scoring effect)', () => {
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

  test('computeWindowPlan exposes sportConcentration over the whole window\'s own final picks', () => {
    const day1 = [mlbMatch({ id: 'd1', startTimeUtc: '2026-09-19T20:00:00.000Z', effectiveScore: 8 })];
    const day2 = [makeMatch({ id: 'd2', sport: 'F1', startTimeUtc: '2026-09-20T20:00:00.000Z', durationMinutes: 75, enduranceScore: 10, effectiveScore: 8 })];
    const { sportConcentration } = computeWindowPlan(new Map([['2026-09-19', day1], ['2026-09-20', day2]]));
    assert.equal(sportConcentration.get('MLB'), 0.5);
    assert.equal(sportConcentration.get('F1'), 0.5);
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

  test('Invariant 4: a live-excitement nudge can reduce or raise planningScore but never deletes the match or corrupts effectiveScore', () => {
    const day1 = [footballMatch({ id: 'a1', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 8, name: 'X' })];
    const a2 = footballMatch({ id: 'a2', startTimeUtc: '2026-09-20T18:00:00.000Z', effectiveScore: 8, name: 'X' });
    const { plan } = computeWindowPlan(new Map([['2026-09-19', day1], ['2026-09-20', [a2]]]));
    assert.ok(plan.get('2026-09-20').some(m => m.id === 'a2')); // still recommended - no rival to lose to
    assert.equal(a2.effectiveScore, 8); // never mutated
    // Same matchup as yesterday, same sport as yesterday's only pick - none
    // of that carries any scoring penalty anymore (see
    // applyLiveExcitementBonus's own comment on why the cross-day repeat/
    // sport-concentration penalties were removed). planningScore is just
    // effectiveScore plus a live bonus of 0 (not a live match).
    assert.equal(a2.planningScore, 8);
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
  test('pinning one member of a wider chain cluster leaves an unrelated, non-conflicting member freely schedulable', () => {
    // a-b near-totally overlap, b-c near-totally overlap, but a and c do
    // NOT overlap each other at all - one transitive presentational
    // cluster (groupIntoSlots unions by the chain, not by every pair
    // individually), but a and c are otherwise perfectly schedulable
    // together. Confirmed against a real fetched slate (see README): a
    // normal MLB night's own transitive cluster can chain together 10+
    // games this way (game1 overlaps game2, game2 overlaps game3, ...)
    // even though most of them never conflict with each other at all. An
    // earlier version of this function excluded the pinned choice's ENTIRE
    // transitive cluster, on the theory that a pin should always keep its
    // swipe stack's member set stable - but that meant pinning just ONE of
    // those 10+ games silently suppressed every other one of them from
    // being recommended for the rest of the day, genuinely non-conflicting
    // games included. Pairwise-only exclusion is what actually belongs
    // here: forcing c in should free b (its own direct conflict) but leave
    // a - which never conflicted with c - free to still be recommended on
    // its own merits.
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T17:30:00.000Z', durationMinutes: 180, effectiveScore: 100 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T19:30:00.000Z', durationMinutes: 60, effectiveScore: 3 });
    const naturalPlan = computeDayPlan('2026-09-19', [a, b, c].map(m => ({ ...m })));
    // Confirms the setup: unpinned, the DP naturally picks only b (the
    // three-member stack a viewer would actually see and swipe through).
    assert.deepEqual(naturalPlan.map(m => m.id), ['b']);

    const pinnedForDay = new Set(['c']);
    const plan = computeDayPlan('2026-09-19', [a, b, c], pinnedForDay);
    // Both a and c end up recommended - b (which directly conflicts with
    // both) is the one excluded.
    assert.deepEqual(new Set(plan.map(m => m.id)), new Set(['a', 'c']));
    assert.equal(c.recommended, true);
    assert.equal(a.recommended, true);
    assert.equal(b.recommended, false);
    // Each pick's own alternativeIds is its DIRECT conflicts only (b, in
    // both cases) - never the other independently-recommended end of the
    // chain, which it was never actually competing against. This is the
    // real fix for the reported "swipe stack has way more cards than
    // could ever really be watched together and loops unpredictably" bug:
    // an earlier version listed every OTHER member of the whole transitive
    // cluster here, so on a real MLB night a single stack could carry 10+
    // cards, most of which never conflicted with the one actually picked.
    assert.deepEqual(a.alternativeIds, ['b']);
    assert.deepEqual(c.alternativeIds, ['b']);
    // slotKey stays the full cluster's own key regardless - see this
    // function's own comment on why the pin LOOKUP key and the displayed
    // alternatives are deliberately two different notions of "cluster".
    assert.equal(a.slotKey, c.slotKey);
  });
});

describe('§27 explainWhyNotRecommended', () => {
  test('a match that IS recommended has nothing to explain', () => {
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: 8 });
    computeDayPlan('2026-09-19', [a]);
    const result = explainWhyNotRecommended('a', '2026-09-19', [a]);
    assert.equal(result.reason, 'recommended');
  });

  test('a finished match with the winning score for its slot is explained as recommended, not excluded', () => {
    const a = footballMatch({ id: 'a', isFinished: true, effectiveScore: 99 });
    computeDayPlan('2026-09-19', [a]);
    assert.equal(explainWhyNotRecommended('a', '2026-09-19', [a]).reason, 'recommended');
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
    const pinnedForDay = new Set(['pinned']);
    computeDayPlan('2026-09-19', [pinned, wouldWin], pinnedForDay, { scoreField: 'effectiveScore' });
    assert.equal(pinned.recommended, true);
    assert.equal(wouldWin.recommended, false);
    const result = explainWhyNotRecommended('would-win', '2026-09-19', [pinned, wouldWin], pinnedForDay, { scoreField: 'effectiveScore' });
    assert.equal(result.reason, 'blockedByPin');
    assert.equal(result.wouldBeValue, 9);
    assert.equal(result.actualValue, 2);
  });

  test('a standalone candidate is recommended even with a negative score - nothing else competes for its slot', () => {
    // See weightedIntervalSchedule's own score-floor comment: a
    // non-conflicting candidate is never worse than recommending nothing,
    // however negative its own (penalty-laden) score - so this is no
    // longer a "lowValue" case at all, it's simply recommended.
    const negative = footballMatch({ id: 'negative', startTimeUtc: '2026-09-19T18:00:00.000Z', effectiveScore: -5 });
    const result = explainWhyNotRecommended('negative', '2026-09-19', [negative], null, { scoreField: 'effectiveScore' });
    assert.equal(result.reason, 'recommended');
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

describe('estimateLiveDurationMinutes (real-time correction from ESPN live period/clock)', () => {
  const START = '2026-09-19T18:00:00.000Z';
  const startMs = Date.parse(START);

  test('a non-live payload leaves the pre-game estimate untouched', () => {
    assert.equal(estimateLiveDurationMinutes('MLB', START, 164, { isLive: false }, startMs + 60 * 60_000), 164);
  });

  test('too little of the game has happened yet - keeps the pre-game estimate', () => {
    // 1st inning of 9, MLB - progress 1/9 ~= 0.11, under the 0.2 floor.
    const result = estimateLiveDurationMinutes('MLB', START, 164, { isLive: true, period: 1 }, startMs + 20 * 60_000);
    assert.equal(result, 164);
  });

  test('MLB: a game running slower than average extrapolates to a longer estimate', () => {
    // 40 real minutes elapsed to reach the 4th inning (progress 4/9) implies
    // a full-length pace of 40 / (4/9) = 90 real minutes just for that
    // portion - blended 0.7/0.3 with a 164-min pre-game estimate, this
    // should land noticeably ABOVE a fast pace but the blend keeps it
    // sane; the key behavioral assertion is direction, not an exact number.
    const slow = estimateLiveDurationMinutes('MLB', START, 164, { isLive: true, period: 4 }, startMs + 100 * 60_000);
    const fast = estimateLiveDurationMinutes('MLB', START, 164, { isLive: true, period: 4 }, startMs + 40 * 60_000);
    assert.ok(slow > fast);
  });

  test('never estimates less than the time that has already genuinely elapsed', () => {
    const result = estimateLiveDurationMinutes('MLB', START, 50, { isLive: true, period: 9 }, startMs + 300 * 60_000);
    assert.ok(result >= 300);
  });

  test('NBA: reads quarter + clock to compute regulation progress', () => {
    // Start of the 3rd quarter (quarter=3, full 12:00 left) = 24 minutes of
    // regulation elapsed out of 48 -> progress 0.5.
    const result = estimateLiveDurationMinutes(
      'NBA',
      START,
      140,
      { isLive: true, period: 3, displayClock: '12:00' },
      startMs + 80 * 60_000
    );
    assert.ok(Number.isFinite(result) && result > 0);
  });

  test('Premier League: reads the match-minute clock directly', () => {
    // 45 minutes elapsed of 90 -> progress 0.5.
    const result = estimateLiveDurationMinutes(
      'Premier League',
      START,
      113,
      { isLive: true, displayClock: '45' },
      startMs + 50 * 60_000
    );
    assert.ok(Number.isFinite(result) && result > 0);
  });

  test('F1 has no live progress signal - always keeps the pre-race estimate', () => {
    const result = estimateLiveDurationMinutes('F1', START, 92, { isLive: true, period: 30 }, startMs + 60 * 60_000);
    assert.equal(result, 92);
  });
});

describe('liveExcitementBonus (real-time closeness bonus for a live match)', () => {
  function liveMatch(overrides = {}) {
    return makeMatch({
      sport: 'MLB',
      startTimeUtc: '2026-09-19T18:00:00.000Z',
      durationMinutes: 190,
      enduranceScore: 10,
      competitors: [{ homeAway: 'away', score: 3 }, { homeAway: 'home', score: 3 }],
      ...overrides
    });
  }
  const START = Date.parse('2026-09-19T18:00:00.000Z');

  test('a finished match never gets a live bonus', () => {
    assert.equal(liveExcitementBonus(liveMatch({ isFinished: true }), START + 60 * 60_000), 0);
  });

  test('a match with no real competitor scores yet gets no bonus', () => {
    assert.equal(liveExcitementBonus(liveMatch({ competitors: [] }), START + 60 * 60_000), 0);
  });

  test('a tied game deep into its estimated length scores near the max bonus', () => {
    const bonus = liveExcitementBonus(liveMatch(), START + estimatedDurationMinutes(liveMatch()) * 60_000 * 0.95);
    assert.ok(bonus > LIVE_EXCITEMENT_MAX_BONUS * 0.8);
  });

  test('a tied game right at the start gets almost no bonus - closeness alone is not enough', () => {
    const bonus = liveExcitementBonus(liveMatch(), START + 60_000);
    assert.ok(bonus < 0.1);
  });

  test('a lopsided game gets little to no bonus regardless of how far along it is', () => {
    const blowout = liveMatch({ competitors: [{ homeAway: 'away', score: 12 }, { homeAway: 'home', score: 1 }] });
    const bonus = liveExcitementBonus(blowout, START + estimatedDurationMinutes(blowout) * 60_000 * 0.9);
    assert.ok(bonus < 0.3);
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
    const pinnedForDay = new Set(['b']);
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
    const natural = naturalSlotChoice('2026-09-19', [a, b], slotAB, new Set());
    assert.equal(natural, 'b'); // b wins on its own merits absent any pin
  });
});

describe('Gemini bounded daily tie-break (Round 35: a hard pin, not a score nudge)', () => {
  function planFor(matches, pinnedForDay = null) {
    applyLiveExcitementBonus(matches);
    computeDayPlan('2026-09-19', matches, pinnedForDay, { scoreField: 'planningScore' });
    return matches;
  }

  describe('selectGeminiTieBreakCandidates', () => {
    test('returns null when the top pick has no alternatives at all', () => {
      const a = makeMatch({ id: 'a', effectiveScore: 8 });
      const day = planFor([a]);
      assert.equal(selectGeminiTieBreakCandidates(day), null);
    });

    test('offers every alternative computeDayPlan itself already considers close (no separate, extra margin)', () => {
      // A gap of 0.7 - live-verified TOO WIDE for the old, separate
      // GEMINI_TIE_BREAK_MARGIN (0.5) that Round 35 removed, but well
      // within this file's own ALTERNATIVE_MAX_SCORE_GAP (2.5), so
      // computeDayPlan already shows b as a swipeable alternative. It must
      // still be offered to Gemini - this is the exact live bug (Tampa Bay
      // Rays @ New York Yankees excluded from ever being asked about) this
      // round fixes.
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 8 });
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.3 });
      const day = planFor([a, b]);
      const close = selectGeminiTieBreakCandidates(day);
      assert.ok(close);
      assert.equal(close.length, 2);
      assert.equal(close[0].id, 'a');
      assert.equal(close[1].id, 'b');
    });

    test('returns null when there genuinely is no alternative (gap beyond ALTERNATIVE_MAX_SCORE_GAP)', () => {
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 9 });
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 9 - ALTERNATIVE_MAX_SCORE_GAP - 0.1 });
      const day = planFor([a, b]);
      assert.equal(selectGeminiTieBreakCandidates(day), null);
    });

    test('caps the offered set at GEMINI_TIE_BREAK_MAX_CANDIDATES', () => {
      const matches = [0, 1, 2, 3, 4].map(i =>
        makeMatch({ id: `m${i}`, startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 8 - i * 0.1 })
      );
      const day = planFor(matches);
      const close = selectGeminiTieBreakCandidates(day);
      assert.equal(close.length, GEMINI_TIE_BREAK_MAX_CANDIDATES);
    });

    // Round 37: live-verified bug (2026-09-23/24/25) - a day can have MORE
    // THAN ONE recommended slot at once (an early, non-overlapping
    // "continuation" pick alongside the evening headline pick - see Round
    // 36's own scheduling-floor fix). The old `dayMatches.find(m =>
    // m.recommended)` just grabbed whichever recommended slot sorted first
    // chronologically - on the real slate this was always the early,
    // low-stakes slot with NO alternatives, so the genuinely contested
    // evening headline slot (the one this whole feature exists for) was
    // NEVER offered to Gemini at all, silently, every single day.
    test('scans EVERY recommended slot, not just whichever one airs first, and picks the one with a real tie', () => {
      const early = makeMatch({ id: 'early', startTimeUtc: '2026-09-19T06:00:00.000Z', durationMinutes: 60, effectiveScore: 8 });
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 8 });
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.3 });
      const day = planFor([early, a, b]);
      // Both the early slot and the noon slot are independently recommended
      // (they don't overlap) - the bug this guards against is exactly this
      // shape: more than one `recommended` match on the same day.
      assert.deepEqual(day.filter(m => m.recommended).map(m => m.id).sort(), ['a', 'early']);
      const close = selectGeminiTieBreakCandidates(day);
      assert.ok(close, 'must find the noon slot\'s real tie, not bail out because the early slot has none');
      assert.deepEqual(close.map(c => c.id).sort(), ['a', 'b']);
    });

    test('when multiple recommended slots each have alternatives, picks whichever has the SMALLEST top-vs-runner-up gap', () => {
      // Slot 1 (early): a clear win with only a distant alternative - a real
      // tie exists (within ALTERNATIVE_MAX_SCORE_GAP) but it's a wide 1.5
      // gap, not a genuine toss-up.
      const early1 = makeMatch({ id: 'early1', startTimeUtc: '2026-09-19T06:00:00.000Z', durationMinutes: 60, effectiveScore: 8 });
      const early2 = makeMatch({ id: 'early2', startTimeUtc: '2026-09-19T06:00:00.000Z', durationMinutes: 60, effectiveScore: 6.5 });
      // Slot 2 (noon): a genuine near-tie, 0.1 apart.
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 8 });
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.9 });
      const day = planFor([early1, early2, a, b]);
      assert.deepEqual(day.filter(m => m.recommended).map(m => m.id).sort(), ['a', 'early1']);
      const close = selectGeminiTieBreakCandidates(day);
      assert.deepEqual(close.map(c => c.id).sort(), ['a', 'b']);
    });
  });

  describe('tieBreakCandidateKey', () => {
    test('is stable regardless of input order', () => {
      const a = { id: 'a' };
      const b = { id: 'b' };
      assert.equal(tieBreakCandidateKey([a, b]), tieBreakCandidateKey([b, a]));
    });
  });

  describe('buildGeminiTieBreakPayload', () => {
    test('carries id/sport/name/score/reason/facts straight from each candidate, with safe defaults', () => {
      const a = makeMatch({
        id: 'a',
        name: 'A @ B',
        sport: 'MLB',
        startTimeUtc: NOON_UTC,
        durationMinutes: 190,
        effectiveScore: 8,
        reason: 'r',
        objectiveFactors: ['f1', 'f2']
      });
      const b = makeMatch({ id: 'b', name: 'C @ D', sport: 'MLB', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.6 });
      const day = planFor([a, b]);
      const close = selectGeminiTieBreakCandidates(day);
      const payload = buildGeminiTieBreakPayload('2026-09-19', close);
      assert.equal(payload.day, '2026-09-19');
      assert.equal(payload.candidates.length, 2);
      assert.deepEqual(payload.candidates[0], {
        id: 'a',
        sport: 'MLB',
        name: 'A @ B',
        score: day.find(m => m.id === 'a').planningScore,
        reason: 'r',
        facts: ['f1', 'f2']
      });
      assert.equal(payload.candidates[1].reason, '');
      assert.deepEqual(payload.candidates[1].facts, []);
    });
  });

  describe('resolveGeminiOverridePin', () => {
    test('returns null when there is no cached pick at all', () => {
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 8 });
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.3 });
      const day = planFor([a, b]);
      const close = selectGeminiTieBreakCandidates(day);
      assert.equal(resolveGeminiOverridePin(day, close, null), null);
      assert.equal(resolveGeminiOverridePin(day, close, { candidateKey: tieBreakCandidateKey(close), pickId: null }), null);
    });

    test('returns null when the cached candidateKey no longer matches (stale cache safety)', () => {
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 8 });
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.3 });
      const day = planFor([a, b]);
      const close = selectGeminiTieBreakCandidates(day);
      const stale = { candidateKey: 'some-other-id,another-id', pickId: 'b' };
      assert.equal(resolveGeminiOverridePin(day, close, stale), null);
    });

    test('returns null when the cached pickId is not one of the currently-offered candidates', () => {
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 8 });
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.3 });
      const day = planFor([a, b]);
      const close = selectGeminiTieBreakCandidates(day);
      const entry = { candidateKey: tieBreakCandidateKey(close), pickId: 'not-actually-offered' };
      assert.equal(resolveGeminiOverridePin(day, close, entry), null);
    });

    test('returns the pickId when the cache is fresh and valid', () => {
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 8 });
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.3 });
      const day = planFor([a, b]);
      const close = selectGeminiTieBreakCandidates(day);
      const entry = { candidateKey: tieBreakCandidateKey(close), pickId: 'b' };
      assert.equal(resolveGeminiOverridePin(day, close, entry), 'b');
    });

    test('an explicit human pin in the same conflict cluster always wins over Gemini\'s own pick', () => {
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 8 });
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.3 });
      // The viewer has pinned 'a' for this exact slot.
      const day = planFor([a, b], new Set(['a']));
      const close = selectGeminiTieBreakCandidates(day);
      const entry = { candidateKey: tieBreakCandidateKey(close), pickId: 'b' };
      assert.equal(resolveGeminiOverridePin(day, close, entry, new Set(['a'])), null);
    });

    test('a human pin on a DIFFERENT, non-conflicting slot does not block Gemini\'s own pick', () => {
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 8 });
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.3 });
      // c starts well after a/b's own slot ends - a totally separate pin.
      const c = makeMatch({ id: 'c', startTimeUtc: '2026-09-19T20:00:00.000Z', durationMinutes: 60, effectiveScore: 5 });
      const day = planFor([a, b, c], new Set(['c']));
      const close = selectGeminiTieBreakCandidates(day);
      const entry = { candidateKey: tieBreakCandidateKey(close), pickId: 'b' };
      assert.equal(resolveGeminiOverridePin(day, close, entry, new Set(['c'])), 'b');
    });
  });

  describe('computeDayPlanWithGeminiTieBreak', () => {
    test('with no cache entry, behaves exactly like a plain computeDayPlan call', () => {
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 8 });
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.3 });
      applyLiveExcitementBonus([a, b]);
      const { picks, close } = computeDayPlanWithGeminiTieBreak('2026-09-19', [a, b], null, null, { scoreField: 'planningScore' });
      assert.equal(a.recommended, true);
      assert.equal(b.recommended, false);
      assert.equal(picks.length, 1);
      assert.equal(picks[0].id, 'a');
      assert.equal(close.length, 2); // still surfaces the close call for app.js to ask about
    });

    test('a valid cached pick wins its slot UNCONDITIONALLY, regardless of how wide the score gap is - this is the whole point of Round 35', () => {
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 9 });
      // b trails by a full 2.0 - nowhere near the old, removed 0.5 margin,
      // and still not enough for a mere score bonus to safely guarantee a
      // flip - the hard pin guarantees it regardless.
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.0 });
      applyLiveExcitementBonus([a, b]);
      computeDayPlan('2026-09-19', [a, b], null, { scoreField: 'planningScore' });
      const naturalClose = selectGeminiTieBreakCandidates([a, b], { scoreField: 'planningScore' });
      const cacheEntry = { candidateKey: tieBreakCandidateKey(naturalClose), pickId: 'b' };
      const { picks } = computeDayPlanWithGeminiTieBreak('2026-09-19', [a, b], null, cacheEntry, { scoreField: 'planningScore' });
      assert.equal(a.recommended, false);
      assert.equal(b.recommended, true);
      assert.equal(picks.length, 1);
      assert.equal(picks[0].id, 'b');
    });

    test('a viewer\'s own explicit pin still overrides the cached Gemini pick', () => {
      const a = makeMatch({ id: 'a', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 9 });
      const b = makeMatch({ id: 'b', startTimeUtc: NOON_UTC, durationMinutes: 190, effectiveScore: 7.0 });
      applyLiveExcitementBonus([a, b]);
      computeDayPlan('2026-09-19', [a, b], null, { scoreField: 'planningScore' });
      const naturalClose = selectGeminiTieBreakCandidates([a, b], { scoreField: 'planningScore' });
      const cacheEntry = { candidateKey: tieBreakCandidateKey(naturalClose), pickId: 'b' };
      const { picks } = computeDayPlanWithGeminiTieBreak('2026-09-19', [a, b], new Set(['a']), cacheEntry, { scoreField: 'planningScore' });
      assert.equal(a.recommended, true);
      assert.equal(picks[0].id, 'a');
    });
  });
});
