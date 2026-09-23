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
  devigPowerMethod,
  findTeamEvent,
  parseCombinedMoneylineMarket,
  parseSoccerThreeWayMarkets,
  resolveTeamOdds,
  findRaceWinnerEvent,
  parseOutrightWinnerMarkets,
  resolveF1WinnerOdds,
  findPoleWinnerEvent,
  resolvePoleWinnerOdds,
  polymarketEventsByTagUrl,
  fetchAllPolymarketEvents,
  POLYMARKET_EVENTS_PAGE_SIZE,
  POLYMARKET_MIN_LIQUIDITY_FOR_SCORING
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

// Real fixture: the 23 raw "Yes" prices from a live Azerbaijan GP driver
// pole-position market (one independent Yes/No book per driver) - these
// sum to 4.519, not ~1, since nothing forces separately-priced longshot
// books to add up correctly the way one single combined market does.
const REAL_F1_POLE_RAW_PROBABILITIES = [
  0.455, 0.335, 0.31, 0.305, 0.275, 0.275, 0.275, 0.265, 0.265, 0.26, 0.26, 0.2505, 0.2395, 0.245, 0.23, 0.155,
  0.0505, 0.0155, 0.0155, 0.0105, 0.0105, 0.0105, 0.006
];

describe('devigPowerMethod', () => {
  test('sums to 100 even when raw prices sum to far more than 1 (real F1 pole data)', () => {
    const result = devigPowerMethod(REAL_F1_POLE_RAW_PROBABILITIES);
    assert.equal(Math.round(result.reduce((sum, p) => sum + p, 0)), 100);
  });
  test('keeps the same favorite-first ranking as naive proportional rescaling', () => {
    const power = devigPowerMethod(REAL_F1_POLE_RAW_PROBABILITIES);
    const naive = devigNWay(REAL_F1_POLE_RAW_PROBABILITIES);
    const powerOrder = power.map((_, i) => i).sort((a, b) => power[b] - power[a]);
    const naiveOrder = naive.map((_, i) => i).sort((a, b) => naive[b] - naive[a]);
    assert.deepEqual(powerOrder, naiveOrder);
  });
  test('gives the real favorite a noticeably higher share than naive proportional rescaling would', () => {
    // Naive division by the raw total (4.519) crushes the favorite down to
    // ~10.1% - live-reported as looking like "no real favorite" even
    // though the raw price (45.5%) says otherwise. The power method should
    // recover more of that signal instead of discounting the favorite by
    // the same proportion as every long-shot driver in the field.
    const power = devigPowerMethod(REAL_F1_POLE_RAW_PROBABILITIES);
    const naive = devigNWay(REAL_F1_POLE_RAW_PROBABILITIES);
    assert.ok(power[0] > naive[0] * 1.5);
  });
  test('already-near-exact two-way input is left essentially unchanged (agrees with devigNWay)', () => {
    const power = devigPowerMethod([0.015, 0.985]);
    assert.equal(power[0], 1.5);
    assert.equal(power[1], 98.5);
  });
  test('returns null for empty input, a negative probability, or a non-finite one', () => {
    assert.equal(devigPowerMethod([]), null);
    assert.equal(devigPowerMethod([0.5, -0.1]), null);
    assert.equal(devigPowerMethod([0.5, NaN]), null);
    assert.equal(devigPowerMethod([0, 0]), null);
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

  // Real live liquidity figures, 2026-09-23: Washington Nationals @ Detroit
  // Tigers (11.9 hours out) vs. a same-shape market ~4.5 days out - see
  // POLYMARKET_MIN_LIQUIDITY_FOR_SCORING's own comment for the full
  // investigation these numbers come from.
  describe('liquidity', () => {
    test('a real, deeply-liquid pregame market reports its own liquidity as a number, not a string', () => {
      const event = {
        ...REAL_MLB_EVENT,
        markets: [{ ...REAL_MLB_EVENT.markets[0], liquidity: '137017.6445' }, REAL_MLB_EVENT.markets[1]]
      };
      const result = parseCombinedMoneylineMarket(event.markets, 'San Francisco Giants', 'Los Angeles Dodgers');
      assert.equal(result.liquidity, 137017.6445);
      assert.ok(result.liquidity >= POLYMARKET_MIN_LIQUIDITY_FOR_SCORING);
    });

    test('a real but genuinely untraded stub market (days out, nothing traded yet) reports its own low liquidity', () => {
      const event = {
        ...REAL_MLB_EVENT,
        markets: [{ ...REAL_MLB_EVENT.markets[0], liquidity: '95.5' }, REAL_MLB_EVENT.markets[1]]
      };
      const result = parseCombinedMoneylineMarket(event.markets, 'San Francisco Giants', 'Los Angeles Dodgers');
      assert.ok(result.liquidity < POLYMARKET_MIN_LIQUIDITY_FOR_SCORING);
    });

    test('defaults to 0, never NaN/undefined, when the field is missing entirely', () => {
      const result = parseCombinedMoneylineMarket(REAL_MLB_EVENT.markets, 'San Francisco Giants', 'Los Angeles Dodgers');
      assert.equal(result.liquidity, 0);
    });
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
    assert.equal(result.liquidity, 0);
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

  test('liquidity is the WEAKEST of the three separate legs, not any one of them alone', () => {
    const markets = [
      { ...REAL_EPL_EVENT.markets[0], liquidity: '50000' }, // home win
      { ...REAL_EPL_EVENT.markets[1], liquidity: '80' }, // draw - genuinely thin
      { ...REAL_EPL_EVENT.markets[2], liquidity: '45000' } // away win
    ];
    const result = parseSoccerThreeWayMarkets(markets, 'Liverpool', 'AFC Bournemouth');
    assert.equal(result.liquidity, 80);
    assert.ok(result.liquidity < POLYMARKET_MIN_LIQUIDITY_FOR_SCORING);
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

// Real (trimmed) fixture: Azerbaijan Grand Prix Driver Pole Position
// market, 2026-09-25 (the day BEFORE the race itself - Qualifying's own
// real date, confirmed live) - same per-driver Yes/No shape as the winner
// market, plus a same-date Constructor Pole Position event this app has no
// use for, to prove the "driver" match is specific.
const REAL_F1_POLE_EVENT = {
  slug: 'f1-azerbaijan-grand-prix-driver-pole-position-2026-09-25',
  eventDate: '2026-09-25',
  markets: [
    { question: 'Will Max Verstappen get pole position at the 2026 F1 Azerbaijan Grand Prix?', outcomes: '["Yes", "No"]', outcomePrices: '["0.4", "0.6"]' },
    { question: 'Will Pierre Gasly get pole position at the 2026 F1 Azerbaijan Grand Prix?', outcomes: '["Yes", "No"]', outcomePrices: '["0.26", "0.74"]' }
  ]
};
const REAL_F1_CONSTRUCTOR_POLE_EVENT = {
  slug: 'f1-azerbaijan-grand-prix-constructor-pole-position-2026-09-25',
  eventDate: '2026-09-25',
  markets: [{ question: 'Will Red Bull get pole position?', outcomes: '["Yes", "No"]', outcomePrices: '["0.4", "0.6"]' }]
};

describe('findPoleWinnerEvent', () => {
  test('finds the DRIVER pole-position event, not the same-date constructor one', () => {
    assert.equal(
      findPoleWinnerEvent([REAL_F1_CONSTRUCTOR_POLE_EVENT, REAL_F1_POLE_EVENT], '2026-09-25'),
      REAL_F1_POLE_EVENT
    );
  });
  test('returns null for a date with no matching qualifying market', () => {
    assert.equal(findPoleWinnerEvent([REAL_F1_POLE_EVENT], '2026-09-26'), null);
  });
});

describe('resolvePoleWinnerOdds', () => {
  test('end to end: finds the qualifying market and returns favorites sorted descending', () => {
    const result = resolvePoleWinnerOdds([REAL_F1_POLE_EVENT], '2026-09-25');
    assert.equal(result[0].name, 'Max Verstappen');
    assert.equal(result.length, 2);
  });
  test('returns null when no qualifying market is open for that date', () => {
    assert.equal(resolvePoleWinnerOdds([REAL_F1_POLE_EVENT], '2026-09-26'), null);
  });
});

describe('polymarketEventsByTagUrl', () => {
  test('sorts by the fixture\'s own real startTime, not Polymarket\'s listing-creation startDate', () => {
    const url = polymarketEventsByTagUrl(100381);
    assert.ok(url.includes('order=startTime'));
    assert.ok(!url.includes('startDate'));
  });
  test('supports an offset for pagination past the endpoint\'s own per-request cap', () => {
    const url = polymarketEventsByTagUrl(100381, { offset: 100 });
    assert.ok(url.includes('offset=100'));
  });
});

describe('fetchAllPolymarketEvents', () => {
  test('stops after a short (non-full) page - the common case, one request', async () => {
    const calls = [];
    const fetchJson = async url => {
      calls.push(url);
      return [{ id: 1 }, { id: 2 }];
    };
    const events = await fetchAllPolymarketEvents(100381, fetchJson);
    assert.equal(events.length, 2);
    assert.equal(calls.length, 1);
  });
  test('pages past a full page until a short one is found, merging every event', async () => {
    const fullPage = Array.from({ length: POLYMARKET_EVENTS_PAGE_SIZE }, (_, i) => ({ id: i }));
    const shortPage = [{ id: 'last' }];
    let calls = 0;
    const fetchJson = async () => {
      calls += 1;
      return calls === 1 ? fullPage : shortPage;
    };
    const events = await fetchAllPolymarketEvents(100381, fetchJson);
    assert.equal(events.length, POLYMARKET_EVENTS_PAGE_SIZE + 1);
    assert.equal(events.at(-1).id, 'last');
    assert.ok(calls >= 2);
  });
  test('requests every page after a full first one in parallel, merging in page order up to the first short page', async () => {
    const pages = [
      Array.from({ length: POLYMARKET_EVENTS_PAGE_SIZE }, (_, i) => ({ id: `a${i}` })),
      Array.from({ length: POLYMARKET_EVENTS_PAGE_SIZE }, (_, i) => ({ id: `b${i}` })),
      [{ id: 'c0' }],
      [{ id: 'never-merged' }]
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchJson = async url => {
      const page = Number(new URL(url).searchParams.get('offset')) / POLYMARKET_EVENTS_PAGE_SIZE;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Later pages resolve FIRST - order must still come from page index.
      await new Promise(resolve => setTimeout(resolve, 10 - page));
      inFlight -= 1;
      return pages[page] || [];
    };
    const events = await fetchAllPolymarketEvents(100381, fetchJson);
    assert.equal(events.length, POLYMARKET_EVENTS_PAGE_SIZE * 2 + 1);
    assert.equal(events[0].id, 'a0');
    assert.equal(events[POLYMARKET_EVENTS_PAGE_SIZE].id, 'b0');
    assert.equal(events.at(-1).id, 'c0');
    assert.ok(maxInFlight > 1);
  });
  test('stops on an empty or malformed page rather than looping/throwing', async () => {
    const events = await fetchAllPolymarketEvents(100381, async () => []);
    assert.deepEqual(events, []);
  });
});
