// Tests for the pure helper functions exported from scripts/build-data.mjs
// (isTimeTbd/parseOverallRecord/oddsContext/computeMatchObjectiveScore/...).
// Importing this file does NOT run a live build - see build-data.mjs's own
// entry-module guard at the bottom (`if (isMain) { main()... }`), added
// specifically so these helpers could be unit-tested without a network call.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTimeTbd,
  parseOverallRecord,
  oddsContext,
  parseOddsSignal,
  sanitizeCachedEvidenceItem,
  resolveWhereToWatchTw,
  computeDurationMinutes,
  finishedDurationMinutes,
  MIN_FINISHED_DURATION_MINUTES,
  computeMatchObjectiveScore,
  describeFactorsZh,
  buildObjectiveReasonZh,
  applyCachedAdjustments
} from '../scripts/build-data.mjs';

describe('isTimeTbd', () => {
  test('flags a status whose shortDetail contains TBD', () => {
    assert.ok(isTimeTbd({ shortDetail: 'TBD', detail: 'TBD' }));
  });
  test('a normal scheduled status is not TBD', () => {
    assert.ok(!isTimeTbd({ shortDetail: '7:05 PM EDT', detail: 'Fri, September 19th at 7:05 PM EDT' }));
  });
  test('handles a missing statusType gracefully', () => {
    assert.ok(!isTimeTbd(undefined));
    assert.ok(!isTimeTbd({}));
  });
});

describe('parseOverallRecord', () => {
  test('parses a plain win-loss summary', () => {
    assert.deepEqual(parseOverallRecord({ records: [{ type: 'total', summary: '93-60' }] }), { wins: 93, losses: 60 });
  });
  test('parses a win-loss-tie summary (ignores the tie count, same as the rest of this codebase)', () => {
    assert.deepEqual(parseOverallRecord({ records: [{ name: 'overall', summary: '10-4-2' }] }), { wins: 10, losses: 4 });
  });
  test('returns null when no total/overall record is present', () => {
    assert.equal(parseOverallRecord({ records: [{ type: 'home', summary: '5-2' }] }), null);
  });
  test('returns null when records is missing entirely', () => {
    assert.equal(parseOverallRecord({}), null);
  });
});

describe('oddsContext', () => {
  test('formats a details string with an over/under when both are present', () => {
    assert.equal(oddsContext({ odds: [{ details: 'LAD -1.5', overUnder: 8.5 }] }), ' [Odds: LAD -1.5, O/U 8.5]');
  });
  test('formats without an over/under clause when overUnder is not a number', () => {
    assert.equal(oddsContext({ odds: [{ details: 'LAD -1.5' }] }), ' [Odds: LAD -1.5]');
  });
  test('returns empty string when no provider has posted odds', () => {
    assert.equal(oddsContext({}), '');
    assert.equal(oddsContext({ odds: [] }), '');
  });
});

describe('parseOddsSignal', () => {
  test('extracts spread/overUnder as plain numbers', () => {
    assert.deepEqual(parseOddsSignal({ odds: [{ spread: -1.5, overUnder: 8.5 }] }), { spread: -1.5, overUnder: 8.5 });
  });
  test('returns nulls (never NaN) when no provider has posted odds', () => {
    assert.deepEqual(parseOddsSignal({}), { spread: null, overUnder: null });
    assert.deepEqual(parseOddsSignal({ odds: [] }), { spread: null, overUnder: null });
  });
});

describe('computeMatchObjectiveScore (the API-data-driven primary score)', () => {
  test('dispatches an MLB fixture to the MLB formula, using its own competitor records', () => {
    const match = {
      sport: 'MLB',
      broadcast: 'Fox',
      isPostseason: false,
      oddsSpread: null,
      oddsOverUnder: null,
      competitors: [
        { name: 'New York Yankees', record: { wins: 70, losses: 30 } },
        { name: 'Tampa Bay Rays', record: { wins: 30, losses: 70 } }
      ]
    };
    const result = computeMatchObjectiveScore(match, { mlbStandings: new Map(), f1TitleRaceIntensity: null });
    assert.ok(result.competitiveness <= 3); // a genuinely lopsided record (0.7 vs 0.3 win%)
    assert.equal(typeof result.broadcastQuality, 'number');
    assert.ok(Array.isArray(result.factors));
  });

  test('looks up MLB standings signals by team display name from the provided map', () => {
    const withStreak = {
      sport: 'MLB',
      broadcast: '',
      isPostseason: false,
      competitors: [
        { name: 'New York Yankees', record: { wins: 50, losses: 50 } },
        { name: 'Tampa Bay Rays', record: { wins: 50, losses: 50 } }
      ]
    };
    const mlbStandings = new Map([
      ['New York Yankees', { gamesBack: null, wildCardGamesBack: null, lastTen: null, streakCode: 'W8' }]
    ]);
    const withoutSignal = computeMatchObjectiveScore(withStreak, { mlbStandings: new Map(), f1TitleRaceIntensity: null });
    const withSignal = computeMatchObjectiveScore(withStreak, { mlbStandings, f1TitleRaceIntensity: null });
    assert.ok(withSignal.watchability >= withoutSignal.watchability);
  });

  test('dispatches F1 to the title-race formula regardless of competitors (F1 has none)', () => {
    const match = { sport: 'F1', broadcast: 'Apple TV', competitors: [] };
    const result = computeMatchObjectiveScore(match, { mlbStandings: new Map(), f1TitleRaceIntensity: 1 });
    assert.ok(result.watchability >= 9);
  });

  test('an unrecognized sport falls back to a neutral score rather than throwing', () => {
    const result = computeMatchObjectiveScore({ sport: 'Curling', broadcast: '', competitors: [] }, {});
    assert.equal(result.competitiveness, 5);
    assert.equal(result.watchability, 5);
  });

  test('broadcastQuality is always a number, derived from the broadcast field', () => {
    const match = { sport: 'NBA', broadcast: 'ESPN', competitors: [{ record: null }, { record: null }] };
    const result = computeMatchObjectiveScore(match, {});
    assert.equal(result.broadcastQuality, 7);
  });
});

describe('describeFactorsZh', () => {
  test('maps recognized English factor strings to short Traditional Chinese labels', () => {
    const labels = describeFactorsZh(['season win% gap 5.0pp', 'postseason game']);
    assert.deepEqual(labels, ['雙方戰績', '季後賽']);
  });
  test('deduplicates labels and ignores unrecognized factors', () => {
    const labels = describeFactorsZh(['season win% gap 1pp', 'season win% gap 2pp', 'some unrecognized thing']);
    assert.deepEqual(labels, ['雙方戰績']);
  });
  test('returns an empty array for no/empty factors, never throws', () => {
    assert.deepEqual(describeFactorsZh([]), []);
    assert.deepEqual(describeFactorsZh(undefined), []);
  });
});

describe('buildObjectiveReasonZh', () => {
  test('builds a sentence grounded in the real factors behind the score', () => {
    assert.match(buildObjectiveReasonZh(['season win% gap 5pp']), /雙方戰績/);
  });
  test('falls back to an honest "no data" sentence when there are no factors at all', () => {
    assert.match(buildObjectiveReasonZh([]), /沒有足夠的客觀數據/);
  });
});

describe('sanitizeCachedEvidenceItem', () => {
  test('keeps a well-formed item as-is', () => {
    const item = sanitizeCachedEvidenceItem({
      category: 'eventImportance',
      finding: 'This decides the division.',
      source: 'current standings',
      retrievedAt: '2026-09-19T12:00:00.000Z'
    });
    assert.deepEqual(item, {
      category: 'eventImportance',
      finding: 'This decides the division.',
      source: 'current standings',
      retrievedAt: '2026-09-19T12:00:00.000Z'
    });
  });

  test('an unrecognized category falls back to recentContext, never dropped', () => {
    const item = sanitizeCachedEvidenceItem({ category: 'bogus', finding: 'still a real fact', source: 'x', retrievedAt: 'now' });
    assert.equal(item.category, 'recentContext');
    assert.equal(item.finding, 'still a real fact');
  });

  test('non-string fields become empty strings rather than throwing', () => {
    const item = sanitizeCachedEvidenceItem({ category: null, finding: 42, source: {}, retrievedAt: null });
    assert.equal(item.finding, '');
    assert.equal(item.source, '');
    assert.equal(typeof item.retrievedAt, 'string'); // stamped with a real timestamp, not null
  });

  test('bounds finding/source length', () => {
    const item = sanitizeCachedEvidenceItem({ category: 'recentContext', finding: 'x'.repeat(500), source: 'y'.repeat(500) });
    assert.ok(item.finding.length <= 200);
    assert.ok(item.source.length <= 80);
  });
});

describe('resolveWhereToWatchTw (the hardcoded Taiwan broadcast rule)', () => {
  test('defaults every sport to 愛爾達體育台', () => {
    assert.equal(resolveWhereToWatchTw({ sport: 'Premier League', broadcast: 'Peacock' }), '愛爾達體育台');
    assert.equal(resolveWhereToWatchTw({ sport: 'NBA', broadcast: 'TNT' }), '愛爾達體育台');
    assert.equal(resolveWhereToWatchTw({ sport: 'F1', broadcast: 'Apple TV' }), '愛爾達體育台');
  });

  test('an MLB fixture ESPN lists as Apple TV overrides the default', () => {
    assert.equal(resolveWhereToWatchTw({ sport: 'MLB', broadcast: 'Apple TV' }), 'Apple TV');
    assert.equal(resolveWhereToWatchTw({ sport: 'MLB', broadcast: 'AppleTV+' }), 'Apple TV');
  });

  test('an ordinary MLB broadcaster still defaults to 愛爾達體育台', () => {
    assert.equal(resolveWhereToWatchTw({ sport: 'MLB', broadcast: 'Fox' }), '愛爾達體育台');
    assert.equal(resolveWhereToWatchTw({ sport: 'MLB', broadcast: '' }), '愛爾達體育台');
  });
});

describe('computeDurationMinutes', () => {
  test('routes MLB/NBA/EPL through their own sport-duration.mjs formula', () => {
    const away = { name: 'New York Yankees' };
    const home = { name: 'Tampa Bay Rays' };
    const mlb = computeDurationMinutes({ id: 'mlb', durationMinutes: 190 }, away, home, '', '');
    assert.notEqual(mlb, 190); // the flat fallback would have been 190 - this should be the real formula's output
  });

  test('falls back to the league\'s own flat duration for an unrecognized league id', () => {
    const duration = computeDurationMinutes({ id: 'mls', durationMinutes: 120 }, { name: 'A' }, { name: 'B' }, '', '');
    assert.equal(duration, 120);
  });
});

describe('finishedDurationMinutes', () => {
  test('returns the real elapsed minutes between kickoff and this fetch', () => {
    const start = '2026-09-19T18:00:00.000Z';
    const now = new Date('2026-09-19T20:30:00.000Z'); // 150 real minutes later
    assert.equal(finishedDurationMinutes(start, now), 150);
  });

  test('floors an implausibly tiny reading (e.g. a fixture marked post almost immediately)', () => {
    const start = '2026-09-19T18:00:00.000Z';
    const now = new Date('2026-09-19T18:05:00.000Z');
    assert.equal(finishedDurationMinutes(start, now), MIN_FINISHED_DURATION_MINUTES);
  });
});

describe('applyCachedAdjustments (AI validation stays visible across throttled runs)', () => {
  const NOW_MS = Date.parse('2026-09-20T12:00:00.000Z');

  test('leaves a fresh-this-run adjustment alone (never overwritten by a cache entry)', () => {
    const adjustments = new Map([['a', { source: 'ai', reason: 'fresh' }]]);
    const cached = { a: { source: 'ai', reason: 'stale', cachedAt: new Date(NOW_MS - 60_000).toISOString() } };
    applyCachedAdjustments(adjustments, [{ id: 'a' }], cached, NOW_MS, 6);
    assert.equal(adjustments.get('a').reason, 'fresh');
  });

  test('falls back to a cache entry within the max age for a fixture with no fresh pick', () => {
    const adjustments = new Map();
    const cached = { a: { source: 'ai', reason: 'from 2 hours ago', cachedAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString() } };
    applyCachedAdjustments(adjustments, [{ id: 'a' }], cached, NOW_MS, 6);
    assert.equal(adjustments.get('a').reason, 'from 2 hours ago');
  });

  test('ignores a cache entry older than the max age - falls through to the objective-score default', () => {
    const adjustments = new Map();
    const cached = { a: { source: 'ai', reason: 'from 7 hours ago', cachedAt: new Date(NOW_MS - 7 * 60 * 60 * 1000).toISOString() } };
    applyCachedAdjustments(adjustments, [{ id: 'a' }], cached, NOW_MS, 6);
    assert.equal(adjustments.has('a'), false);
  });

  test('ignores a missing or malformed cachedAt rather than treating it as infinitely fresh', () => {
    const adjustments = new Map();
    const cached = { a: { source: 'ai', reason: 'no timestamp' } };
    applyCachedAdjustments(adjustments, [{ id: 'a' }], cached, NOW_MS, 6);
    assert.equal(adjustments.has('a'), false);
  });

  test('never invents an entry for a fixture with no cache record at all', () => {
    const adjustments = new Map();
    applyCachedAdjustments(adjustments, [{ id: 'never-validated' }], {}, NOW_MS, 6);
    assert.equal(adjustments.has('never-validated'), false);
  });
});

