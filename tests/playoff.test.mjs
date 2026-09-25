import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlayoffInfo, localizePlayoffRound, playoffSeriesState, isPlayInRound } from '../public/lib/playoff.mjs';

// Shapes copied from ESPN's real 2025 postseason scoreboard responses.
const competition = ({ headline, series, awayId = '6', homeId = '12' }) => ({
  notes: headline ? [{ type: 'event', headline }] : [],
  series,
  competitors: [
    { id: homeId, homeAway: 'home' },
    { id: awayId, homeAway: 'away' }
  ]
});

describe('parsePlayoffInfo', () => {
  test('reads the round and matches series wins to away/home by team id', () => {
    const info = parsePlayoffInfo(
      competition({
        headline: 'NLDS - Game 3',
        awayId: '16',
        homeId: '8',
        series: {
          type: 'playoff',
          summary: 'MIL leads series 2-1',
          totalCompetitions: 5,
          competitors: [
            { id: '16', wins: 1 },
            { id: '8', wins: 2 }
          ]
        }
      })
    );
    assert.deepEqual(info, { round: 'NLDS - Game 3', bestOf: 5, awayWins: 1, homeWins: 2 });
  });

  test('a play-in game has a round but no series', () => {
    const info = parsePlayoffInfo(competition({ headline: 'NBA Play-In - East - 9th Place vs 10th Place' }));
    assert.deepEqual(info, { round: 'NBA Play-In - East - 9th Place vs 10th Place', bestOf: null, awayWins: null, homeWins: null });
  });

  test('null when ESPN sends neither', () => {
    assert.equal(parsePlayoffInfo(competition({})), null);
  });
});

describe('localizePlayoffRound', () => {
  test('translates every MLB and NBA round ESPN uses', () => {
    const cases = {
      'ALWC - Game 1': '美聯外卡系列賽 第1戰',
      'NLWC - Game 3 If Necessary': '國聯外卡系列賽 第3戰（如有需要）',
      'ALDS - Game 4': '美聯分區系列賽 第4戰',
      'NLCS - Game 1': '國聯冠軍賽 第1戰',
      'World Series - Game 7': '世界大賽 第7戰',
      'East 1st Round - Game 6': '東區首輪 第6戰',
      'West Semifinals - Game 1': '西區準決賽 第1戰',
      'East Finals - Game 1': '東區決賽 第1戰',
      'NBA Finals - Game 7': 'NBA 總冠軍賽 第7戰',
      'NBA Play-In - East - 9th Place vs 10th Place': '東區 第9、10名之戰',
      'NBA Play-In - West - 8th Seed Game': '西區 第8種子爭奪戰'
    };
    for (const [round, zh] of Object.entries(cases)) assert.equal(localizePlayoffRound(round, 'zh-TW'), zh, round);
  });

  test('keeps ESPN wording for English and for anything unrecognized', () => {
    assert.equal(localizePlayoffRound('ALDS - Game 4', 'en'), 'ALDS · Game 4');
    assert.equal(localizePlayoffRound('NBA Play-In - West - 8th Seed Game', 'en'), 'West · 8th Seed Game');
    assert.equal(localizePlayoffRound('Some New Round - Game 2', 'zh-TW'), 'Some New Round - Game 2');
  });

  test('isPlayInRound', () => {
    assert.equal(isPlayInRound('NBA Play-In - West - 8th Seed Game'), true);
    assert.equal(isPlayInRound('West Finals - Game 1'), false);
  });
});

describe('playoffSeriesState', () => {
  const series = (bestOf, awayWins, homeWins) => ({ round: 'x', bestOf, awayWins, homeWins });

  test('tied series going into the last game is winner-take-all', () => {
    assert.deepEqual(playoffSeriesState(series(5, 2, 2), false), {
      leader: null,
      leaderWins: 2,
      trailerWins: 2,
      decided: false,
      stakes: 'decider',
      eliminationSide: null
    });
    assert.equal(playoffSeriesState(series(7, 3, 3), false).stakes, 'decider');
    assert.equal(playoffSeriesState(series(3, 1, 1), false).stakes, 'decider');
  });

  test('the side one loss from going out faces elimination', () => {
    const state = playoffSeriesState(series(7, 3, 1), false);
    assert.equal(state.leader, 'away');
    assert.equal(state.stakes, 'elimination');
    assert.equal(state.eliminationSide, 'home');
    assert.equal(playoffSeriesState(series(3, 0, 1), false).eliminationSide, 'away');
  });

  test('nothing on the line early in a series', () => {
    assert.equal(playoffSeriesState(series(7, 1, 1), false).stakes, null);
    assert.equal(playoffSeriesState(series(5, 0, 0), false).stakes, null);
  });

  test('a finished game reports the decided series and no stakes', () => {
    // ESPN's "NY wins series 4-2" after East 1st Round Game 6.
    const state = playoffSeriesState(series(7, 2, 4), true);
    assert.equal(state.decided, true);
    assert.equal(state.leader, 'home');
    assert.equal(state.stakes, null);
    // Counts already include this game, so they'd describe the NEXT game.
    assert.equal(playoffSeriesState(series(7, 3, 3), true).stakes, null);
  });

  test('null without a real series', () => {
    assert.equal(playoffSeriesState(series(null, null, null), false), null);
    assert.equal(playoffSeriesState(null, false), null);
  });
});
