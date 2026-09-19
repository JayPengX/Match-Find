// Tests for the pure helper functions exported from scripts/build-data.mjs
// (isTimeTbd/parseOverallRecord/oddsContext/heuristicScore). Importing this
// file does NOT run a live build - see build-data.mjs's own entry-module
// guard at the bottom (`if (isMain) { main()... }`), added specifically so
// these helpers could be unit-tested without a network call.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isTimeTbd, parseOverallRecord, oddsContext, heuristicScore } from '../scripts/build-data.mjs';

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
