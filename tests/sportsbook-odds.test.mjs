// Tests for public/lib/sportsbook-odds.mjs - ESPN's sportsbook moneyline as
// the odds bar's pre-game fallback behind Polymarket. The MLB `odds[0]`
// shape below is trimmed from a real 2026-09-25 ESPN scoreboard response
// (Cubs @ Red Sox, DraftKings).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { americanOddsToProbability, parseSportsbookWinPct, resolveDisplayOdds } from '../public/lib/sportsbook-odds.mjs';

const mlbCompetition = {
  odds: [
    {
      provider: { id: '100', name: 'DraftKings', displayName: 'DraftKings' },
      details: 'CHC -122',
      overUnder: 6.5,
      spread: 1.5,
      moneyline: {
        home: { close: { odds: '+101' }, open: { odds: '+102' } },
        away: { close: { odds: '-122' }, open: { odds: '-120' } }
      }
    }
  ]
};

describe('americanOddsToProbability', () => {
  test('favorite, underdog and even money', () => {
    assert.ok(Math.abs(americanOddsToProbability('-122') - 122 / 222) < 1e-9);
    assert.ok(Math.abs(americanOddsToProbability('+101') - 100 / 201) < 1e-9);
    assert.equal(americanOddsToProbability(100), 0.5);
    assert.equal(americanOddsToProbability('EVEN'), 0.5);
  });
  test('rejects missing or malformed prices', () => {
    assert.equal(americanOddsToProbability(null), null);
    assert.equal(americanOddsToProbability(''), null);
    assert.equal(americanOddsToProbability('abc'), null);
    assert.equal(americanOddsToProbability('50'), null);
  });
});

describe('parseSportsbookWinPct', () => {
  test('devigs a real MLB moneyline', () => {
    const result = parseSportsbookWinPct(mlbCompetition);
    assert.equal(result.provider, 'DraftKings');
    assert.equal(result.draw, null);
    assert.ok(result.away > result.home);
    assert.ok(Math.abs(result.away + result.home - 100) < 0.2);
  });
  test('null when ESPN has no line posted', () => {
    assert.equal(parseSportsbookWinPct({ odds: null }), null);
    assert.equal(parseSportsbookWinPct({}), null);
    assert.equal(parseSportsbookWinPct({ odds: [{ spread: 1.5 }] }), null);
  });
  test('soccer needs a draw price, and gets a three-way split', () => {
    assert.equal(parseSportsbookWinPct(mlbCompetition, { hasDraw: true }), null);
    const soccer = {
      odds: [
        {
          provider: { name: 'DraftKings' },
          moneyline: { away: { close: { odds: '+250' } }, home: { close: { odds: '-110' } }, draw: { close: { odds: '+260' } } }
        }
      ]
    };
    const result = parseSportsbookWinPct(soccer, { hasDraw: true });
    assert.ok(result.home > result.away && result.home > result.draw);
    assert.ok(Math.abs(result.away + result.draw + result.home - 100) < 0.2);
  });
  test('falls back to the flat moneyLine fields', () => {
    const result = parseSportsbookWinPct({ odds: [{ awayTeamOdds: { moneyLine: 150 }, homeTeamOdds: { moneyLine: -170 } }] });
    assert.ok(result.home > result.away);
  });
});

describe('resolveDisplayOdds', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const upcoming = { startTimeUtc: '2026-09-25T23:10:00Z' };
  const started = { startTimeUtc: '2026-09-25T11:00:00Z' };
  const market = { oddsWinPctAway: 55, oddsWinPctHome: 45, oddsWinPctDraw: null };
  const book = { oddsBookWinPctAway: 53.8, oddsBookWinPctHome: 46.2, oddsBookWinPctDraw: null, oddsBookProvider: 'DraftKings' };

  test('Polymarket wins when its market is liquid', () => {
    const odds = resolveDisplayOdds({ ...upcoming, ...market, ...book, oddsMarketLiquidity: 50000 }, now);
    assert.equal(odds.source, 'polymarket');
    assert.equal(odds.away, 55);
  });
  test('Polymarket wins when liquidity is unknown', () => {
    assert.equal(resolveDisplayOdds({ ...upcoming, ...market, ...book }, now).source, 'polymarket');
  });
  test('sportsbook takes over from a thin Polymarket market before kickoff', () => {
    const odds = resolveDisplayOdds({ ...upcoming, ...market, ...book, oddsMarketLiquidity: 300 }, now);
    assert.equal(odds.source, 'sportsbook');
    assert.equal(odds.provider, 'DraftKings');
    assert.equal(odds.away, 53.8);
  });
  test('sportsbook fills in when Polymarket has no market', () => {
    assert.equal(resolveDisplayOdds({ ...upcoming, ...book }, now).source, 'sportsbook');
  });
  test('never the sportsbook once the game has started', () => {
    assert.equal(resolveDisplayOdds({ ...started, ...book }, now), null);
    assert.equal(resolveDisplayOdds({ ...started, ...market, ...book, oddsMarketLiquidity: 300 }, now).source, 'polymarket');
  });
  test('null with no price from either source', () => {
    assert.equal(resolveDisplayOdds({ ...upcoming }, now), null);
  });
});
