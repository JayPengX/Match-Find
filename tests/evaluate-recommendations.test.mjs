import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMatches,
  summarize,
  computePlannerOracle,
  computeDimensionCorrelations
} from '../scripts/evaluate-recommendations.mjs';
import { computeDayPlan, CONFIDENCE_OBJECTIVE, matchupKey } from '../public/lib/recommendation.mjs';

function match(overrides = {}) {
  return {
    id: 'x',
    sport: 'MLB',
    name: 'Away @ Home',
    startTimeUtc: '2026-09-19T23:00:00.000Z',
    isFinished: false,
    recommended: true,
    score: 7,
    effectiveScore: 7,
    competitors: [{ name: 'Away Team' }, { name: 'Home Team' }],
    ...overrides
  };
}

describe('extractMatches', () => {
  test('accepts {matches: [...]} exports', () => {
    assert.deepEqual(extractMatches({ matches: [1, 2] }), [1, 2]);
  });
  test('accepts a bare array', () => {
    assert.deepEqual(extractMatches([1, 2, 3]), [1, 2, 3]);
  });
  test('returns [] for anything else', () => {
    assert.deepEqual(extractMatches(null), []);
    assert.deepEqual(extractMatches({}), []);
  });
});

describe('matchupKey', () => {
  test('is order-independent for a two-competitor match', () => {
    const a = match({ competitors: [{ name: 'Rays' }, { name: 'Yankees' }] });
    const b = match({ competitors: [{ name: 'Yankees' }, { name: 'Rays' }] });
    assert.equal(matchupKey(a), matchupKey(b));
  });
  test('an F1 session (no competitors) keys off its own name, keeping qualifying/race distinct', () => {
    const qual = match({ sport: 'F1', name: 'Azerbaijan Grand Prix Qualifying', competitors: [] });
    const race = match({ sport: 'F1', name: 'Azerbaijan Grand Prix', competitors: [] });
    assert.notEqual(matchupKey(qual), matchupKey(race));
  });
});

describe('summarize', () => {
  test('counts recommended vs total and computes the recommended rate against upcoming/live only', () => {
    const finished = match({ id: 'f', isFinished: true, recommended: false, score: 0 });
    const rec = match({ id: 'r', recommended: true });
    const notRec = match({ id: 'n', recommended: false });
    const report = summarize([finished, rec, notRec]);
    assert.equal(report.totalMatches, 3);
    assert.equal(report.upcomingOrLiveMatches, 2);
    assert.equal(report.recommendedCount, 1);
    assert.equal(report.recommendedRate, 0.5);
  });

  test('sport concentration tallies recommended matches per sport', () => {
    const report = summarize([
      match({ id: 'a', sport: 'MLB', recommended: true }),
      match({ id: 'b', sport: 'MLB', recommended: true }),
      match({ id: 'c', sport: 'F1', recommended: true, competitors: [] })
    ]);
    assert.equal(report.sportConcentration.MLB.count, 2);
    assert.equal(report.sportConcentration.F1.count, 1);
  });

  test('flags the same matchup recommended across multiple distinct dates, without treating it as an error', () => {
    const gameOne = match({
      id: 'g1',
      startTimeUtc: '2026-09-19T23:00:00.000Z',
      competitors: [{ name: 'Rays' }, { name: 'Yankees' }]
    });
    const gameTwo = match({
      id: 'g2',
      startTimeUtc: '2026-09-20T23:00:00.000Z',
      competitors: [{ name: 'Rays' }, { name: 'Yankees' }]
    });
    const unrelated = match({ id: 'u', startTimeUtc: '2026-09-21T23:00:00.000Z', competitors: [{ name: 'A' }, { name: 'B' }] });
    const report = summarize([gameOne, gameTwo, unrelated]);
    assert.equal(report.recurringMatchups.matchupsRecommendedOnMultipleDays, 1);
    assert.equal(report.recurringMatchups.topRecurring[0].recommendedOnDistinctDays, 2);
  });

  test('falls back to computeConfidence when a match has no baked-in confidence field', () => {
    const report = summarize([match({ confidence: undefined })]);
    assert.equal(report.confidenceDistribution.avg, CONFIDENCE_OBJECTIVE);
  });

  test('an empty match list produces a well-formed, non-crashing report', () => {
    const report = summarize([]);
    assert.equal(report.totalMatches, 0);
    assert.equal(report.recommendedRate, 0);
    assert.deepEqual(report.recurringMatchups.topRecurring, []);
  });

  test('includes a plannerOracle and dimensionCorrelations section', () => {
    const report = summarize([]);
    assert.ok(report.plannerOracle);
    assert.ok(report.dimensionCorrelations);
  });
});

// A high-reliability, fully-controllable-timing fixture - same shape as
// recommendation.test.mjs's own footballMatch helper, kept separate since
// these two test files don't share fixtures across the module boundary.
function footballMatch(overrides = {}) {
  return {
    id: 'm', sport: 'Premier League', startTimeUtc: '2026-09-19T18:00:00.000Z',
    durationMinutes: 60, enduranceScore: 10, isFinished: false, timeTbd: false,
    effectiveScore: 5, recommended: false,
    ...overrides
  };
}

describe('computePlannerOracle', () => {
  test('a genuinely optimal plan (as computeDayPlan itself would produce) scores a 100% ratio', () => {
    // Same "A alone (9.5) loses to B+C (9+9=18)" scenario as
    // recommendation.test.mjs's Test 3 - let the real scheduler decide,
    // then verify the oracle agrees it was optimal.
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 150, effectiveScore: 9.5 });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T19:20:00.000Z', durationMinutes: 60, effectiveScore: 9 });
    computeDayPlan('2026-09-19', [a, b, c]);
    const oracle = computePlannerOracle([a, b, c]);
    assert.equal(oracle.overallRatio, 1);
    assert.equal(oracle.daysBelowOptimal, 0);
  });

  test('catches a genuinely suboptimal plan and reports a ratio below 1', () => {
    // Same three matches, but hand-set to the WORSE "pick A alone" outcome
    // a broken scheduler might produce - the oracle should independently
    // discover B+C (18) beats A (10) and report actual/oracle = 10/18.
    const a = footballMatch({ id: 'a', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 150, effectiveScore: 10, recommended: true });
    const b = footballMatch({ id: 'b', startTimeUtc: '2026-09-19T18:00:00.000Z', durationMinutes: 60, effectiveScore: 9, recommended: false });
    const c = footballMatch({ id: 'c', startTimeUtc: '2026-09-19T19:20:00.000Z', durationMinutes: 60, effectiveScore: 9, recommended: false });
    const oracle = computePlannerOracle([a, b, c]);
    assert.ok(oracle.overallRatio < 1);
    assert.equal(oracle.totalActualValue, 10);
    assert.equal(oracle.totalOracleValue, 18);
    assert.equal(oracle.daysBelowOptimal, 1);
  });

  test('a pinned (isPreferred) pick is honored as a hard constraint, not penalized as suboptimal', () => {
    const higher = footballMatch({ id: 'higher', startTimeUtc: '2026-09-21T18:00:00.000Z', effectiveScore: 9, recommended: false });
    const pinned = footballMatch({ id: 'pinned', startTimeUtc: '2026-09-21T18:02:00.000Z', effectiveScore: 5, recommended: true, isPreferred: true });
    const oracle = computePlannerOracle([higher, pinned]);
    assert.equal(oracle.overallRatio, 1);
  });

  test('an empty match list produces a well-formed, non-crashing report', () => {
    const oracle = computePlannerOracle([]);
    assert.equal(oracle.dayCount, 0);
    assert.equal(oracle.overallRatio, null);
    assert.deepEqual(oracle.worstDays, []);
  });

  test('finished and quiet-hours matches are excluded from candidacy, same as computeDayPlan', () => {
    const finished = footballMatch({ id: 'f', isFinished: true, recommended: false });
    const quiet = footballMatch({ id: 'q', startTimeUtc: '2026-09-19T03:00:00.000Z', recommended: false }); // 03:00 UTC local hour 3 - quiet hours
    const oracle = computePlannerOracle([finished, quiet]);
    assert.equal(oracle.dayCount, 0);
  });
});

describe('computeDimensionCorrelations', () => {
  function scored(overrides) {
    return { sport: 'MLB', isFinished: false, competitiveness: 5, watchability: 5, enduranceScore: 5, broadcastQuality: 5, ...overrides };
  }

  test('identical dimensions correlate perfectly (r=1) and get flagged as highly correlated', () => {
    const matches = Array.from({ length: 6 }, (_, i) =>
      scored({ id: 'm' + i, competitiveness: i + 1, watchability: i + 1 })
    );
    const result = computeDimensionCorrelations(matches);
    assert.equal(result.MLB.pairs['competitiveness<->watchability'], 1);
    assert.ok(result.MLB.highlyCorrelated.includes('competitiveness<->watchability'));
  });

  test('a dimension with zero variance reports null (undefined), not a fabricated 0', () => {
    const matches = Array.from({ length: 6 }, (_, i) => scored({ id: 'm' + i, competitiveness: i + 1, enduranceScore: 5 }));
    const result = computeDimensionCorrelations(matches);
    assert.equal(result.MLB.pairs['competitiveness<->enduranceScore'], null);
  });

  test('sports with fewer than the minimum sample size are excluded entirely', () => {
    const matches = [scored({ id: 'a' }), scored({ id: 'b' })];
    assert.deepEqual(computeDimensionCorrelations(matches), {});
  });

  test('correlations are computed separately per sport', () => {
    const mlb = Array.from({ length: 5 }, (_, i) => scored({ id: 'mlb' + i, sport: 'MLB', competitiveness: i + 1, watchability: i + 1 }));
    const f1 = Array.from({ length: 5 }, (_, i) => scored({ id: 'f1' + i, sport: 'F1', competitiveness: i + 1, watchability: 5 - i }));
    const result = computeDimensionCorrelations([...mlb, ...f1]);
    assert.equal(result.MLB.pairs['competitiveness<->watchability'], 1);
    assert.equal(result.F1.pairs['competitiveness<->watchability'], -1);
  });

  test('a finished match (null dimensions) is excluded rather than crashing the calculation', () => {
    const matches = [
      ...Array.from({ length: 5 }, (_, i) => scored({ id: 'm' + i })),
      { id: 'done', sport: 'MLB', isFinished: true, competitiveness: null, watchability: null, enduranceScore: null, broadcastQuality: null }
    ];
    assert.doesNotThrow(() => computeDimensionCorrelations(matches));
  });
});
