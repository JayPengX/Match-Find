import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractMatches, matchupKey, summarize } from '../scripts/evaluate-recommendations.mjs';

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
    source: 'ai',
    refined: false,
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
    const report = summarize([match({ source: 'ai', refined: true, confidence: undefined })]);
    assert.equal(report.confidenceDistribution.avg, 0.9);
  });

  test('an empty match list produces a well-formed, non-crashing report', () => {
    const report = summarize([]);
    assert.equal(report.totalMatches, 0);
    assert.equal(report.recommendedRate, 0);
    assert.deepEqual(report.recurringMatchups.topRecurring, []);
  });
});
