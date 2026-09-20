// Tests for public/lib/odds.mjs - the shared American-odds-to-devigged-
// win% math both scripts/build-data.mjs (pregame build) and public/lib/
// espn.mjs (live-poll refresh) use.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { americanOddsToImpliedProbability, devigTwoWayOdds, parseMoneylineWinPct } from '../public/lib/odds.mjs';

describe('americanOddsToImpliedProbability', () => {
  test('a favorite (-odds): risk `-odds` to win 100', () => {
    // -200 means risking $200 to win $100 - implied probability 200/300.
    assert.equal(Math.round(americanOddsToImpliedProbability(-200) * 1000) / 1000, 0.667);
  });
  test('an underdog (+odds): risk 100 to win `odds`', () => {
    // +200 means risking $100 to win $200 - implied probability 100/300.
    assert.equal(Math.round(americanOddsToImpliedProbability(200) * 1000) / 1000, 0.333);
  });
  test('a real pick-em-ish number (-115)', () => {
    assert.equal(Math.round(americanOddsToImpliedProbability(-115) * 1000) / 1000, 0.535);
  });
  test('null/NaN/0 all return null, never a guessed value', () => {
    assert.equal(americanOddsToImpliedProbability(null), null);
    assert.equal(americanOddsToImpliedProbability(NaN), null);
    assert.equal(americanOddsToImpliedProbability(0), null);
    assert.equal(americanOddsToImpliedProbability(undefined), null);
  });
});

describe('devigTwoWayOdds', () => {
  test('strips the vig so both sides sum to exactly 100%', () => {
    // -115/-105 (both "negative", a normal two-sided vig'd line) raw-sums
    // to more than 100% before devigging.
    const result = devigTwoWayOdds(-115, -105);
    assert.equal(Math.round((result.away + result.home) * 10) / 10, 100);
    // -105 (home) is the smaller magnitude negative number here, so it's
    // actually the SLIGHT underdog relative to -115 (away) - away favored.
    assert.ok(result.away > result.home);
  });
  test('a genuine pick-em (+100/-102ish) devigs close to 50/50', () => {
    const result = devigTwoWayOdds(-102, -102);
    assert.equal(result.away, 50);
    assert.equal(result.home, 50);
  });
  test('a lopsided favorite/underdog pair', () => {
    const result = devigTwoWayOdds(-300, 250);
    assert.ok(result.away > 70); // heavy favorite
    assert.equal(Math.round((result.away + result.home) * 10) / 10, 100);
  });
  test('missing/non-finite either side returns null, never a half-computed number', () => {
    assert.equal(devigTwoWayOdds(null, -110), null);
    assert.equal(devigTwoWayOdds(-110, undefined), null);
    assert.equal(devigTwoWayOdds(NaN, NaN), null);
  });
});

describe('parseMoneylineWinPct', () => {
  test('reads ESPN\'s own moneyline.{away,home}.close.odds shape (string odds)', () => {
    const result = parseMoneylineWinPct({
      away: { close: { odds: '-115' }, open: { odds: '-122' } },
      home: { close: { odds: '-104' }, open: { odds: '+102' } }
    });
    assert.ok(result.away > result.home);
    assert.equal(Math.round((result.away + result.home) * 10) / 10, 100);
  });
  test('falls back to the opening line when no close has posted yet', () => {
    const result = parseMoneylineWinPct({
      away: { open: { odds: '+120' } },
      home: { open: { odds: '-140' } }
    });
    assert.ok(result.home > result.away);
  });
  test('a missing moneyline (soccer/F1, or a US game with no line yet) returns null', () => {
    assert.equal(parseMoneylineWinPct(undefined), null);
    assert.equal(parseMoneylineWinPct({}), null);
    assert.equal(parseMoneylineWinPct({ away: { close: { odds: '-115' } } }), null); // one-sided only
  });
});
