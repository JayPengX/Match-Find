// Tests for public/lib/polymarket.mjs - the win% odds source (replacing an
// earlier ESPN-sportsbook-odds version of this feature entirely). All
// sample shapes below are copied verbatim from real, live
// gamma-api.polymarket.com responses fetched while building this feature
// (a real SF Giants @ LA Dodgers MLB moneyline, a real AFC Bournemouth vs.
// Liverpool FC EPL fixture, and a real Azerbaijan GP F1 winner market), not
// invented test fixtures.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTeamName,
  teamNamesMatch,
  devigNWay,
  findTeamEvent,
  parseCombinedMoneylineMarket,
  parseSoccerThreeWayMarkets,
  resolveTeamOdds,
  findRaceWinnerEvent,
  parseOutrightWinnerMarkets,
  resolveF1WinnerOdds
} from '../public/lib/polymarket.mjs';

describe('normalizeTeamName / teamNamesMatch', () => {
  test('strips club-suffix boilerplate so ESPN and Polymarket names match', () => {
    assert.ok(teamNamesMatch('Liverpool', 'Liverpool FC'));
    assert.ok(teamNamesMatch('AFC Bournemouth', 'AFC Bournemouth'));
  });
  test('never matches two genuinely different teams', () => {
    assert.equal(teamNamesMatch('Liverpool', 'Everton FC'), false);
  });
  test('empty/missing names never match anything', () => {
    assert.equal(teamNamesMatch('', 'Liverpool FC'), false);
    assert.equal(teamNamesMatch(undefined, undefined), false);
  });
  test('normalizeTeamName is case/whitespace/suffix insensitive', () => {
    assert.equal(normalizeTeamName('  Liverpool FC '), normalizeTeamName('liverpool'));
  });
});

describe('devigNWay', () => {
  test('a real, already near-exact two-way price (0.015/0.985) stays essentially unchanged', () => {
    const result = devigNWay([0.015, 0.985]);
    assert.equal(result[0], 1.5);
    assert.equal(result[1], 98.5);
  });
  test('normalizes N probabilities that do not already sum to 1', () => {
    const result = devigNWay([0.5, 0.6]);
    assert.equal(Math.round((result[0] + result[1]) * 10) / 10, 100);
    assert.ok(result[1] > result[0]);
  });
  test('returns null for empty input, a negative probability, or a non-finite one', () => {
    assert.equal(devigNWay([]), null);
    assert.equal(devigNWay([0.5, -0.1]), null);
    assert.equal(devigNWay([0.5, NaN]), null);
    assert.equal(devigNWay([0, 0]), null);
  });
});

// Real fixture: San Francisco Giants @ Los Angeles Dodgers, 2026-09-20.
const REAL_MLB_EVENT = {
  teams: [
    { name: 'San Francisco Giants', ordering: 'away' },
    { name: 'Los Angeles Dodgers', ordering: 'home' }
  ],
  startTime: '2026-09-20T20:10:00Z',
  markets: [
    {
      question: 'San Francisco Giants vs. Los Angeles Dodgers',
      outcomes: '["San Francisco Giants", "Los Angeles Dodgers"]',
      outcomePrices: '["0.015", "0.985"]'
    },
    {
      question: 'Spread: Los Angeles Dodgers (-1.5)',
      outcomes: '["Los Angeles Dodgers", "San Francisco Giants"]',
      outcomePrices: '["0.74", "0.26"]'
    }
  ]
};

describe('findTeamEvent', () => {
  test('finds a real event by team names + kickoff time', () => {
    const found = findTeamEvent(
      [REAL_MLB_EVENT],
      'San Francisco Giants',
      'Los Angeles Dodgers',
      '2026-09-20T20:10:00Z'
    );
    assert.equal(found, REAL_MLB_EVENT);
  });
  test('does not match the same two teams on a different day (a real double-header scenario)', () => {
    const found = findTeamEvent(
      [REAL_MLB_EVENT],
      'San Francisco Giants',
      'Los Angeles Dodgers',
      '2026-09-21T20:10:00Z'
    );
    assert.equal(found, null);
  });
  test('does not match a different team pair', () => {
    const found = findTeamEvent([REAL_MLB_EVENT], 'New York Yankees', 'Boston Red Sox', '2026-09-20T20:10:00Z');
    assert.equal(found, null);
  });
});

describe('parseCombinedMoneylineMarket', () => {
  test('reads the real MLB combined two-outcome market, ignoring the spread prop alongside it', () => {
    const result = parseCombinedMoneylineMarket(REAL_MLB_EVENT.markets, 'San Francisco Giants', 'Los Angeles Dodgers');
    assert.equal(result.away, 1.5);
    assert.equal(result.home, 98.5);
  });
  test('returns null when no matching combined market exists', () => {
    assert.equal(parseCombinedMoneylineMarket(REAL_MLB_EVENT.markets, 'New York Yankees', 'Boston Red Sox'), null);
  });
});

describe('resolveTeamOdds (MLB/NBA path)', () => {
  test('end to end: finds the event and devigs its real moneyline', () => {
    const result = resolveTeamOdds([REAL_MLB_EVENT], {
      awayName: 'San Francisco Giants',
      homeName: 'Los Angeles Dodgers',
      startTimeUtc: '2026-09-20T20:10:00Z',
      hasDraw: false
    });
    assert.equal(result.away, 1.5);
    assert.equal(result.home, 98.5);
    assert.equal(result.draw, null);
  });
});

// Real fixture: AFC Bournemouth vs. Liverpool FC, 2026-09-20 - EPL's own
// three-separate-binary-markets shape (no single combined market at all).
const REAL_EPL_EVENT = {
  teams: [
    { name: 'AFC Bournemouth', ordering: 'home' },
    { name: 'Liverpool FC', ordering: 'away' }
  ],
  startTime: '2026-09-20T13:00:00Z',
  markets: [
    { question: 'Will AFC Bournemouth win on 2026-09-20?', outcomes: '["Yes", "No"]', outcomePrices: '["0.302", "0.698"]' },
    {
      question: 'Will AFC Bournemouth vs. Liverpool FC end in a draw?',
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.257", "0.743"]'
    },
    { question: 'Will Liverpool FC win on 2026-09-20?', outcomes: '["Yes", "No"]', outcomePrices: '["0.442", "0.558"]' }
  ]
};

describe('parseSoccerThreeWayMarkets', () => {
  test('reads all three separate binary markets and devigs them together', () => {
    const result = parseSoccerThreeWayMarkets(REAL_EPL_EVENT.markets, 'Liverpool', 'AFC Bournemouth');
    assert.ok(result.away > result.home);
    assert.ok(result.home > result.draw);
    assert.ok(Math.abs(result.away + result.draw + result.home - 100) <= 0.15);
  });
  test('returns null when one of the three legs is missing', () => {
    const result = parseSoccerThreeWayMarkets(REAL_EPL_EVENT.markets.slice(0, 2), 'Liverpool', 'AFC Bournemouth');
    assert.equal(result, null);
  });
});

describe('resolveTeamOdds (EPL path, hasDraw)', () => {
  test('end to end: finds the event and devigs its real three-way market', () => {
    const result = resolveTeamOdds([REAL_EPL_EVENT], {
      awayName: 'Liverpool',
      homeName: 'AFC Bournemouth',
      startTimeUtc: '2026-09-20T13:00:00Z',
      hasDraw: true
    });
    assert.ok(result.away > result.home);
    assert.ok(result.home > result.draw);
  });
});

// Real (trimmed) fixture: Azerbaijan Grand Prix winner market, 2026-09-26 -
// many separate per-driver binary markets sharing one question template.
const REAL_F1_EVENT = {
  slug: 'f1-azerbaijan-grand-prix-winner-2026-09-26',
  eventDate: '2026-09-26',
  markets: [
    { question: 'Will Max Verstappen win the 2026 F1 Azerbaijan Grand Prix?', outcomes: '["Yes", "No"]', outcomePrices: '["0.34", "0.66"]' },
    { question: 'Will Lando Norris win the 2026 F1 Azerbaijan Grand Prix?', outcomes: '["Yes", "No"]', outcomePrices: '["0.28", "0.72"]' },
    { question: 'Will Pierre Gasly win the 2026 F1 Azerbaijan Grand Prix?', outcomes: '["Yes", "No"]', outcomePrices: '["0.0045", "0.9955"]' },
    { question: 'Will there be a Safety Car?', outcomes: '["Yes", "No"]', outcomePrices: '["0.6", "0.4"]' }
  ]
};

describe('findRaceWinnerEvent', () => {
  test('finds the winner event by slug + eventDate among a whole tag\'s worth of race markets', () => {
    const other = { slug: 'f1-azerbaijan-grand-prix-safety-car-2026-09-26', eventDate: '2026-09-26' };
    assert.equal(findRaceWinnerEvent([other, REAL_F1_EVENT], '2026-09-26'), REAL_F1_EVENT);
  });
  test('returns null for a date with no matching race', () => {
    assert.equal(findRaceWinnerEvent([REAL_F1_EVENT], '2026-10-03'), null);
  });
});

describe('parseOutrightWinnerMarkets', () => {
  test('extracts every named driver, ignoring an unrelated market (Safety Car) in the same event', () => {
    const result = parseOutrightWinnerMarkets(REAL_F1_EVENT.markets, /^Will (.+?) win the \d{4} F1 .+ Grand Prix\?$/i);
    assert.equal(result.length, 3);
    assert.equal(result[0].name, 'Max Verstappen');
    assert.ok(result[0].pct > result[1].pct);
    assert.ok(result[1].pct > result[2].pct);
  });
  test('a regex with a stray global flag still works across repeated calls (no stateful lastIndex bug)', () => {
    const globalRegex = /^Will (.+?) win the \d{4} F1 .+ Grand Prix\?$/gi;
    const first = parseOutrightWinnerMarkets(REAL_F1_EVENT.markets, globalRegex);
    const second = parseOutrightWinnerMarkets(REAL_F1_EVENT.markets, globalRegex);
    assert.equal(first.length, second.length);
  });
});

describe('resolveF1WinnerOdds', () => {
  test('end to end: finds the race and returns favorites sorted descending', () => {
    const result = resolveF1WinnerOdds([REAL_F1_EVENT], '2026-09-26');
    assert.equal(result[0].name, 'Max Verstappen');
    assert.equal(result.length, 3);
  });
  test('returns null when no race is open for that date', () => {
    assert.equal(resolveF1WinnerOdds([REAL_F1_EVENT], '2026-10-03'), null);
  });
});
