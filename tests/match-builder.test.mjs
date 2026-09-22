// Tests for the pure helper functions exported from public/lib/match-builder.mjs
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
  resolveWhereToWatchTw,
  computeDurationMinutes,
  finishedDurationMinutes,
  MIN_FINISHED_DURATION_MINUTES,
  FINISHED_DURATION_CAP_MINUTES_BY_SPORT,
  computeMatchObjectiveScore,
  describeFactorsZh,
  buildObjectiveReasonZh
} from '../public/lib/match-builder.mjs';

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
    assert.deepEqual(parseOverallRecord({ records: [{ type: 'total', summary: '93-60' }] }), { wins: 93, losses: 60, ties: 0 });
  });
  test('parses a win-loss-tie summary, keeping the tie count (EPL: wins-losses-draws)', () => {
    assert.deepEqual(parseOverallRecord({ records: [{ name: 'overall', summary: '10-4-2' }] }), { wins: 10, losses: 4, ties: 2 });
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
  // The win% odds display comes from Polymarket now (see
  // public/lib/polymarket.mjs and tests/polymarket.test.mjs) - this only
  // ever feeds the objective scoring engine's own closeness-from-spread
  // signal, so it only ever reads spread/overUnder from ESPN.
  test('extracts spread/overUnder as plain numbers', () => {
    assert.deepEqual(parseOddsSignal({ odds: [{ spread: -1.5, overUnder: 8.5 }] }), {
      spread: -1.5,
      overUnder: 8.5
    });
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

  // Live-verified regression: a real 0-0 NBA preseason exhibition (Miami
  // Heat @ Toronto Raptors, Quebec City, no betting line posted) scored a
  // maxed-out 10/10 competitiveness and 9.0 overall on the deployed site -
  // ABOVE genuine September MLB pennant-race games with real stakes.
  // awayWinPct/homeWinPct used to compute as `0 / Math.max(1, 0) = 0` for a
  // 0-games-played team - a real, finite 0, not null - which
  // closenessFromWinPctGap then read as "both teams verified at an
  // identical 0.000 win%", i.e. a perfectly even matchup, maximum
  // closeness. Two teams that HAVEN'T PLAYED YET carry no competitiveness
  // signal at all; this must renormalize away to the neutral default, not
  // max out.
  test('a 0-0 (preseason/no games played) record carries no competitiveness signal, never scores as a perfectly even matchup', () => {
    const match = {
      sport: 'NBA',
      broadcast: '',
      isPostseason: false,
      oddsSpread: null,
      oddsOverUnder: null,
      competitors: [
        { name: 'Miami Heat', record: { wins: 0, losses: 0 } },
        { name: 'Toronto Raptors', record: { wins: 0, losses: 0 } }
      ]
    };
    const result = computeMatchObjectiveScore(match, {});
    assert.equal(result.competitiveness, 5); // renormalized neutral default, not the old maxed-out 10
    assert.equal(result.enduranceScore, 5);
    assert.equal(result.skill, null); // no games played - genuinely no skill signal either
    assert.ok(!result.factors.some(f => f.includes('win%')));
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

  // Live-verified regression (2026-09-20, docs/recommendation-engine-audit.md
  // Round 14): Crystal Palace's real ESPN summary that day was "1-1-3" (1
  // win, 1 loss, 3 draws), parsed by the OLD parseOverallRecord into just
  // {wins: 1, losses: 1} - reading Palace as a small-sample 1-1 (.500) side
  // instead of the real 1-1-3 (.200) one. That fake near-even record made
  // Crystal Palace @ Leeds United (a genuinely draw-heavy, below-average
  // side) score competitiveness 8, outranking Liverpool @ AFC Bournemouth
  // purely on this distortion. Draws must count as games played (denominator)
  // without ever counting as a win (numerator).
  test('EPL draws count as games played but never as a win (Crystal Palace 1-1-3 case)', () => {
    const match = {
      sport: 'Premier League',
      broadcast: 'Peacock',
      oddsSpread: null,
      oddsOverUnder: null,
      competitors: [
        { name: 'Crystal Palace', record: { wins: 1, losses: 1, ties: 3 } },
        { name: 'Leeds United', record: { wins: 2, losses: 3, ties: 0 } }
      ]
    };
    const result = computeMatchObjectiveScore(match, {});
    // Real win% gap: Palace 1/5=0.2 vs Leeds 2/5=0.4 -> gap 0.2 -> closeness 6.
    // The old (buggy) gap was 0.5 vs 0.4 -> gap 0.1 -> closeness 8.
    assert.ok(result.competitiveness <= 6, `expected the real .2/.4 gap, got competitiveness ${result.competitiveness}`);
    // best team points-rate = max(0.2, 0.4) = 40.0% - the OLD bug (ignoring
    // ties) would have reported an inflated max(0.5, 0.4) = 50.0% here instead.
    assert.ok(result.factors.some(f => f.includes('best team points-rate 40.0%')));
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
  test('maps the big-club factor to its own distinct label, stacking with a derby label', () => {
    const labels = describeFactorsZh(['known derby fixture', 'known big-club fixture']);
    assert.deepEqual(labels, ['宿敵對戰', '豪門球隊']);
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

  // Live-verified regression: a real finished EPL fixture (Crystal Palace
  // vs Leeds United, kicked off 13:00 UTC) was still fetched again at
  // 17:41 UTC by this workflow's own 15-minute cron - "how long ago did
  // this start" (281 minutes) got recorded as the match's own
  // `durationMinutes`, even though a Premier League league fixture is
  // never remotely close to running that long. That 290-minute reserved
  // schedule block (used by public/lib/recommendation.mjs's own
  // scheduler) then crowded out a later match that could have easily,
  // actually followed it - the real mechanism behind several live reports
  // of "the best/most-hyped match of the day wasn't recommended" that had
  // nothing wrong with that match's own score at all.
  test('caps an implausibly large reading at this sport\'s own realistic ceiling, per FINISHED_DURATION_CAP_MINUTES_BY_SPORT', () => {
    const start = '2026-09-20T13:00:00.000Z';
    const now = new Date('2026-09-20T17:41:00.000Z'); // 281 real minutes later
    assert.equal(
      finishedDurationMinutes(start, now, 'Premier League'),
      FINISHED_DURATION_CAP_MINUTES_BY_SPORT['Premier League']
    );
    assert.ok(FINISHED_DURATION_CAP_MINUTES_BY_SPORT['Premier League'] < 281);
  });

  test('a genuine same-cycle fetch (elapsed time well under the cap) is unaffected by the cap', () => {
    const start = '2026-09-20T13:00:00.000Z';
    const now = new Date('2026-09-20T14:55:00.000Z'); // 115 real minutes later
    assert.equal(finishedDurationMinutes(start, now, 'Premier League'), 115);
  });

  // Live-reported follow-up: freezing durationMinutes after first sighting
  // (app.js's mergeFreshMatches) only stops it from GROWING further - it
  // does nothing for a match whose very FIRST observation already happens
  // long after the final out (this app has no scheduled rebuild anymore,
  // so "viewed hours or a day late" is the common case, not rare). Without
  // a real fallback, that first observation clamped at the sport's cap and
  // then FROZE there, so every finished MLB match sitting in the window
  // more than ~4h40m after kickoff displayed a flat ~280-minute duration -
  // "spanning across 6 hours" even after the cap itself was lowered.
  // Passing the same pre-game estimate an upcoming match already shows
  // (computeDurationMinutes) gives this function an honest, fixture-aware
  // number to fall back to instead of the arbitrary cap itself.
  test('falls back to the real pre-game estimate once elapsed time exceeds the cap, instead of displaying the cap itself', () => {
    const start = '2026-09-20T13:00:00.000Z';
    const now = new Date('2026-09-21T13:00:00.000Z'); // a full day later
    const pregameEstimateMinutes = 165;
    assert.equal(
      finishedDurationMinutes(start, now, 'MLB', pregameEstimateMinutes),
      pregameEstimateMinutes
    );
  });

  test('still falls back to the cap when no pre-game estimate is available', () => {
    const start = '2026-09-20T13:00:00.000Z';
    const now = new Date('2026-09-21T13:00:00.000Z'); // a full day later
    assert.equal(
      finishedDurationMinutes(start, now, 'MLB'),
      FINISHED_DURATION_CAP_MINUTES_BY_SPORT.MLB
    );
  });

  test('a pre-game estimate below MIN_FINISHED_DURATION_MINUTES is still floored', () => {
    const start = '2026-09-20T13:00:00.000Z';
    const now = new Date('2026-09-21T13:00:00.000Z'); // a full day later
    assert.equal(
      finishedDurationMinutes(start, now, 'MLB', 5),
      MIN_FINISHED_DURATION_MINUTES
    );
  });

  test('an unrecognized/missing sport falls back to a generous default cap, never Infinity', () => {
    const start = '2026-09-20T13:00:00.000Z';
    const now = new Date('2026-09-21T13:00:00.000Z'); // a full day later
    const result = finishedDurationMinutes(start, now, 'Curling');
    assert.ok(Number.isFinite(result));
    assert.ok(result < 24 * 60);
  });
});

