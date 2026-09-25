// Tests for public/lib/espn.mjs's own PURE extraction functions -
// extractLiveUpdates/extractF1LiveUpdates - against fixtures shaped
// exactly like the real ESPN scoreboard responses this app fetches
// through the shared proxy, captured live (2026-09-20's Tigers @ White
// Sox/Brewers @ Orioles MLB games for extractLiveUpdates's own baseball
// `situation` handling, and a completed 2025 Azerbaijan Grand Prix for
// extractF1LiveUpdates's own competitor/leaderboard shape).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractLiveUpdates, extractF1LiveUpdates, liveScoreboardUrls, sizedEspnLogoUrl, darkEspnLogoUrl } from '../public/lib/espn.mjs';

describe('liveScoreboardUrls', () => {
  test('builds TWO single-date requests, never one range request', () => {
    // Live-confirmed (2026-09-20): ESPN's team-sport scoreboard endpoint
    // returns a flat HTTP 400 for a `dates=YYYYMMDD-YYYYMMDD` range, unlike
    // its racing/f1 endpoint - every one of these must be a single bare
    // `dates=YYYYMMDD` value, no hyphenated range.
    const urls = liveScoreboardUrls('MLB', new Date('2026-09-20T12:00:00Z'));
    assert.equal(urls.length, 2);
    for (const url of urls) {
      assert.match(url, /^https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\/baseball\/mlb\/scoreboard\?dates=\d{8}$/);
    }
    assert.match(urls[0], /dates=20260919$/, 'first url should be yesterday (UTC)');
    assert.match(urls[1], /dates=20260920$/, 'second url should be today (UTC)');
  });

  test('returns an empty array for a sport with no ESPN team-league entry (e.g. F1)', () => {
    assert.deepEqual(liveScoreboardUrls('F1'), []);
  });
});

describe('extractLiveUpdates', () => {
  test('extracts score/period/displayClock/situation from a live baseball event', () => {
    const scoreboard = {
      events: [
        {
          id: '401817019',
          competitions: [
            {
              status: {
                period: 6,
                displayClock: '0:00',
                type: { state: 'in', shortDetail: 'Top 6th' }
              },
              competitors: [
                { homeAway: 'away', score: '2' },
                { homeAway: 'home', score: '1' }
              ],
              situation: {
                balls: 1,
                strikes: 2,
                outs: 2,
                onFirst: false,
                onSecond: true,
                onThird: false
              },
              odds: [{ spread: -1.5, overUnder: 8.5 }]
            }
          ]
        }
      ]
    };
    const updates = extractLiveUpdates('MLB', scoreboard);
    const update = updates.get('mlb-401817019');
    assert.ok(update, 'should key by the mlb-<eventId> convention');
    assert.equal(update.isLive, true);
    assert.equal(update.isFinished, false);
    assert.deepEqual(update.scores, [2, 1]);
    assert.equal(update.period, 6);
    assert.equal(update.shortDetail, 'Top 6th');
    assert.deepEqual(update.situation, {
      balls: 1,
      strikes: 2,
      outs: 2,
      onFirst: false,
      onSecond: true,
      onThird: false
    });
    assert.equal(update.oddsSpread, -1.5);
    assert.equal(update.oddsOverUnder, 8.5);
  });

  test('situation is null for a sport/state that never reports one (soccer, or a not-yet-started game)', () => {
    const scoreboard = {
      events: [
        {
          id: '1',
          competitions: [
            {
              status: { period: 0, displayClock: '', type: { state: 'pre', shortDetail: '3:00 PM' } },
              competitors: [
                { homeAway: 'away', score: '0' },
                { homeAway: 'home', score: '0' }
              ]
            }
          ]
        }
      ]
    };
    const update = extractLiveUpdates('Premier League', scoreboard).get('epl-1');
    assert.equal(update.situation, null);
  });

  test('returns an empty map for an unknown sport rather than throwing', () => {
    const updates = extractLiveUpdates('F1', { events: [{ id: '1', competitions: [{ status: { type: { state: 'in' } } }] }] });
    assert.equal(updates.size, 0);
  });

  test('handles a missing/malformed response gracefully', () => {
    assert.equal(extractLiveUpdates('MLB', {}).size, 0);
    assert.equal(extractLiveUpdates('MLB', null).size, 0);
    assert.equal(extractLiveUpdates('MLB', { events: [{ id: '1' }] }).size, 0);
  });
});

describe('extractF1LiveUpdates', () => {
  test('extracts lap/status/top-3 leaderboard from a live race session, sorted by classification order', () => {
    const scoreboard = {
      events: [
        {
          id: '600052060',
          competitions: [
            {
              type: { abbreviation: 'Race' },
              status: {
                period: 23,
                type: { state: 'in', detail: 'Safety Car', shortDetail: 'Lap 23/53 - Safety Car' }
              },
              // Deliberately out of classification order, to prove the
              // extractor sorts by `order` itself rather than trusting
              // array position.
              competitors: [
                { order: 2, athlete: { fullName: 'Lando Norris', shortName: 'L. Norris' } },
                { order: 1, athlete: { fullName: 'Max Verstappen', shortName: 'M. Verstappen' } },
                { order: 3, athlete: { fullName: 'Oscar Piastri', shortName: 'O. Piastri' } },
                { order: 4, athlete: { fullName: 'Charles Leclerc', shortName: 'C. Leclerc' } }
              ]
            }
          ]
        }
      ]
    };
    const updates = extractF1LiveUpdates(scoreboard);
    const update = updates.get('f1-600052060-race');
    assert.ok(update, 'should key by the f1-<eventId>-race convention');
    assert.equal(update.isLive, true);
    assert.equal(update.isFinished, false);
    assert.equal(update.lap, 23);
    assert.equal(update.statusDetail, 'Lap 23/53 - Safety Car');
    assert.deepEqual(update.leaderboard, [
      { name: 'M. Verstappen', position: 1, flagUrl: '', flagAlt: '', interval: null },
      { name: 'L. Norris', position: 2, flagUrl: '', flagAlt: '', interval: null },
      { name: 'O. Piastri', position: 3, flagUrl: '', flagAlt: '', interval: null }
    ]);
  });

  test('a finished race still reports its final top 3 (winner included)', () => {
    const scoreboard = {
      events: [
        {
          id: '600052060',
          competitions: [
            {
              type: { abbreviation: 'Race' },
              status: { period: 53, type: { state: 'post', detail: 'Final', shortDetail: 'Final' } },
              competitors: [{ order: 1, winner: true, athlete: { fullName: 'Max Verstappen', shortName: 'M. Verstappen' } }]
            }
          ]
        }
      ]
    };
    const update = extractF1LiveUpdates(scoreboard).get('f1-600052060-race');
    assert.equal(update.isFinished, true);
    assert.equal(update.lap, 53);
    assert.deepEqual(update.leaderboard, [{ name: 'M. Verstappen', position: 1, flagUrl: '', flagAlt: '', interval: null }]);
  });

  test('a live qualifying session reports no lap and drops the bare "In Progress" status', () => {
    // Shaped like the live 2026 Azerbaijan GP qualifying response: ESPN
    // fills `period` (26) even though qualifying has no race lap count.
    const scoreboard = {
      events: [
        {
          id: '600057444',
          competitions: [
            {
              type: { abbreviation: 'Qual' },
              status: {
                period: 26,
                type: { state: 'in', description: 'In Progress', detail: 'In Progress', shortDetail: 'In Progress' }
              },
              competitors: [{ order: 1, athlete: { fullName: 'George Russell', shortName: 'G. Russell' } }]
            }
          ]
        }
      ]
    };
    const update = extractF1LiveUpdates(scoreboard).get('f1-600057444-qual');
    assert.equal(update.isLive, true);
    assert.equal(update.lap, null);
    assert.equal(update.statusDetail, '');
    assert.equal(update.leaderboard[0].name, 'G. Russell');
  });

  test('an ended-but-still-"in" qualifying session is flagged sessionComplete, top 3 kept', () => {
    // Live 2026 Azerbaijan GP response right after qualifying ended.
    const scoreboard = {
      events: [
        {
          id: '600057444',
          competitions: [
            {
              type: { abbreviation: 'Qual' },
              status: {
                period: 26,
                type: { name: 'STATUS_SESSION_COMPLETE', state: 'in', detail: 'End of Session', shortDetail: '' }
              },
              competitors: [{ order: 1, athlete: { shortName: 'G. Russell' } }]
            }
          ]
        }
      ]
    };
    const update = extractF1LiveUpdates(scoreboard).get('f1-600057444-qual');
    assert.equal(update.sessionComplete, true);
    assert.equal(update.statusDetail, '');
    assert.equal(update.leaderboard[0].name, 'G. Russell');
  });

  test('a live race with only the generic "In Progress" status keeps its lap', () => {
    const scoreboard = {
      events: [
        {
          id: '600057444',
          competitions: [
            {
              type: { abbreviation: 'Race' },
              status: { period: 19, type: { state: 'in', detail: 'In Progress', shortDetail: 'In Progress' } }
            }
          ]
        }
      ]
    };
    const update = extractF1LiveUpdates(scoreboard).get('f1-600057444-race');
    assert.equal(update.lap, 19);
    assert.equal(update.statusDetail, '');
  });

  test('a not-yet-started session (period 0, no competitors yet) has no lap/leaderboard', () => {
    const scoreboard = {
      events: [
        {
          id: '600057444',
          competitions: [
            {
              type: { abbreviation: 'Race' },
              status: { period: 0, type: { state: 'pre', detail: 'Scheduled', shortDetail: '9/26 - 7:00 AM EDT' } }
            }
          ]
        }
      ]
    };
    const update = extractF1LiveUpdates(scoreboard).get('f1-600057444-race');
    assert.equal(update.isLive, false);
    assert.equal(update.statusDetail, '', 'a scheduled start time is not live status');
    assert.equal(update.lap, null);
    assert.equal(update.leaderboard, null);
  });

  test('only tracks Race/Qual/SR sessions, ignoring practice sessions entirely', () => {
    const scoreboard = {
      events: [
        {
          id: '1',
          competitions: [{ type: { abbreviation: 'FP1' }, status: { period: 1, type: { state: 'in' } }, competitors: [] }]
        }
      ]
    };
    assert.equal(extractF1LiveUpdates(scoreboard).size, 0);
  });

  test('handles a missing/malformed response gracefully', () => {
    assert.equal(extractF1LiveUpdates({}).size, 0);
    assert.equal(extractF1LiveUpdates(null).size, 0);
    assert.equal(extractF1LiveUpdates({ events: [{ id: '1' }] }).size, 0);
  });

  test('reads each driver\'s nationality flag and a gap/interval stat when ESPN reports one', () => {
    const scoreboard = {
      events: [
        {
          id: '1',
          competitions: [
            {
              type: { abbreviation: 'Race' },
              status: { period: 10, type: { state: 'in' } },
              competitors: [
                {
                  order: 1,
                  athlete: {
                    shortName: 'M. Verstappen',
                    flag: { href: 'https://a.espncdn.com/i/teamlogos/countries/500/ned.png', alt: 'Netherlands' }
                  },
                  statistics: [{ abbreviation: 'GAP', displayValue: '+2.341' }]
                },
                { order: 2, athlete: { shortName: 'L. Norris' }, statistics: [] }
              ]
            }
          ]
        }
      ]
    };
    const update = extractF1LiveUpdates(scoreboard).get('f1-1-race');
    assert.deepEqual(update.leaderboard[0], {
      name: 'M. Verstappen',
      position: 1,
      flagUrl: 'https://a.espncdn.com/i/teamlogos/countries/500/ned.png',
      flagAlt: 'Netherlands',
      interval: '+2.341'
    });
    assert.deepEqual(update.leaderboard[1], { name: 'L. Norris', position: 2, flagUrl: '', flagAlt: '', interval: null });
  });
});

describe('sizedEspnLogoUrl', () => {
  test('routes a plain ESPN logo path through the combiner resizer', () => {
    assert.equal(
      sizedEspnLogoUrl('https://a.espncdn.com/i/teamlogos/nba/500/scoreboard/cle.png'),
      'https://a.espncdn.com/combiner/i?img=/i/teamlogos/nba/500/scoreboard/cle.png&w=64&h=64'
    );
    assert.equal(
      sizedEspnLogoUrl('https://a.espncdn.com/guid/abc/logos/default.png', 48),
      'https://a.espncdn.com/combiner/i?img=/guid/abc/logos/default.png&w=48&h=48'
    );
  });
  test('adds a size to an existing combiner URL without nesting it', () => {
    assert.equal(
      sizedEspnLogoUrl('https://a.espncdn.com/combiner/i?img=/i/teamlogos/leagues/500/f1.png'),
      'https://a.espncdn.com/combiner/i?img=/i/teamlogos/leagues/500/f1.png&w=64&h=64'
    );
  });
  test('keeps a combiner URL that already has its own size (e.g. a crop)', () => {
    const cropped = 'https://a.espncdn.com/combiner/i?img=/i/leaguelogos/soccer/500/23.png&w=128&h=80&scale=crop&location=origin';
    assert.equal(sizedEspnLogoUrl(cropped), cropped);
  });
  test('leaves non-ESPN, empty, and malformed URLs untouched', () => {
    assert.equal(sizedEspnLogoUrl('https://example.com/x.png'), 'https://example.com/x.png');
    assert.equal(sizedEspnLogoUrl(''), '');
    assert.equal(sizedEspnLogoUrl(undefined), undefined);
    assert.equal(sizedEspnLogoUrl('not a url'), 'not a url');
  });
});

describe('darkEspnLogoUrl', () => {
  test('points a team crest at its 500-dark twin', () => {
    assert.equal(
      darkEspnLogoUrl('https://a.espncdn.com/i/teamlogos/mlb/500/scoreboard/nyy.png'),
      'https://a.espncdn.com/i/teamlogos/mlb/500-dark/scoreboard/nyy.png'
    );
    assert.equal(
      darkEspnLogoUrl('https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500/360.png&w=64&h=64'),
      'https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500-dark/360.png&w=64&h=64'
    );
  });

  test('leaves league logos, other hosts and empty values alone', () => {
    const league = 'https://a.espncdn.com/i/leaguelogos/soccer/500/23.png';
    assert.equal(darkEspnLogoUrl(league), league);
    const other = 'https://example.com/i/teamlogos/mlb/500/nyy.png';
    assert.equal(darkEspnLogoUrl(other), other);
    assert.equal(darkEspnLogoUrl(''), '');
  });
});
