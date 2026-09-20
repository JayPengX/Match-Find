// Tests for the pure helper functions exported from scripts/build-data.mjs
// (isTimeTbd/parseOverallRecord/oddsContext/heuristicScore). Importing this
// file does NOT run a live build - see build-data.mjs's own entry-module
// guard at the bottom (`if (isMain) { main()... }`), added specifically so
// these helpers could be unit-tested without a network call.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTimeTbd,
  parseOverallRecord,
  oddsContext,
  heuristicScore,
  isEvidenceStale,
  sanitizeCachedEvidenceItem,
  resolveWhereToWatchTw,
  computeDurationMinutes
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

describe('heuristicScore (the local, no-AI fallback)', () => {
  test('a closer win-loss gap between two teams scores more competitive', () => {
    const close = heuristicScore({ competitors: [{ record: { wins: 50, losses: 50 } }, { record: { wins: 51, losses: 49 } }] });
    const lopsided = heuristicScore({ competitors: [{ record: { wins: 90, losses: 10 } }, { record: { wins: 10, losses: 90 } }] });
    assert.ok(close.competitiveness > lopsided.competitiveness);
  });

  test('never scores above 8 (deliberately conservative, per this function\'s own comment)', () => {
    const bothStrong = heuristicScore({ competitors: [{ record: { wins: 100, losses: 0 } }, { record: { wins: 100, losses: 0 } }] });
    assert.ok(bothStrong.competitiveness <= 8);
    assert.ok(bothStrong.watchability <= 8);
  });

  test('falls back to neutral scores with a Traditional Chinese caveat when records are missing', () => {
    const noRecords = heuristicScore({ competitors: [{ record: null }, { record: null }] });
    assert.equal(noRecords.competitiveness, 5);
    assert.equal(noRecords.watchability, 5);
    assert.match(noRecords.reason, /戰績資料/);
  });

  test('always returns a broadcastQuality/enduranceScore, never leaving them undefined', () => {
    const result = heuristicScore({ competitors: [{ record: { wins: 1, losses: 1 } }, { record: { wins: 2, losses: 2 } }] });
    assert.equal(typeof result.broadcastQuality, 'number');
    assert.equal(typeof result.enduranceScore, 'number');
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

describe('isEvidenceStale', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');

  test('an entry with no evidence at all is never flagged stale', () => {
    assert.equal(isEvidenceStale({ evidence: [] }, now), false);
    assert.equal(isEvidenceStale({}, now), false);
    assert.equal(isEvidenceStale(null, now), false);
  });

  test('evidence retrieved within the freshness window is not stale', () => {
    const cached = { evidence: [{ retrievedAt: '2026-09-19T00:00:00.000Z' }] }; // 12h ago
    assert.equal(isEvidenceStale(cached, now), false);
  });

  test('evidence older than EVIDENCE_MAX_AGE_HOURS (24h) is stale', () => {
    const cached = { evidence: [{ retrievedAt: '2026-09-18T00:00:00.000Z' }] }; // 36h ago
    assert.equal(isEvidenceStale(cached, now), true);
  });

  test('uses the MOST RECENT item when an entry has several evidence items', () => {
    const cached = {
      evidence: [
        { retrievedAt: '2026-09-01T00:00:00.000Z' }, // very old
        { retrievedAt: '2026-09-19T06:00:00.000Z' } // 6h ago - recent
      ]
    };
    assert.equal(isEvidenceStale(cached, now), false);
  });

  test('a malformed/missing retrievedAt never throws or crashes staleness detection', () => {
    assert.equal(isEvidenceStale({ evidence: [{ retrievedAt: 'not a date' }] }, now), false);
    assert.equal(isEvidenceStale({ evidence: [{}] }, now), false);
  });
});
