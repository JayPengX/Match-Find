// Tests for public/lib/sport-signals.mjs's own PURE parsing functions -
// parseMlbTeamRecord/parseMlbStandingsResponse/computeTitleRaceIntensity/
// parseF1DriverStandingsResponse - against small, hand-built fixtures
// shaped like these APIs' own long-documented public response formats.
// This does NOT verify those shapes against a live response (this module
// was written without live network access - see its own top-of-file
// comment); it verifies the PARSING LOGIC is internally correct for
// exactly the shape it assumes, and that it never throws on a
// missing/malformed input.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MLB_STATS_API_TEAM_IDS,
  parseMlbTeamRecord,
  parseMlbStandingsResponse,
  parseNbaStandingsResponse,
  parseEplStandingsResponse,
  computeTitleRaceIntensity,
  parseF1DriverStandingsResponse,
  F1_TITLE_RACE_DECIDED_GAP_POINTS,
  parseMlbGameEnds,
  applyMlbActualEnds
} from '../public/lib/sport-signals.mjs';

// A stat entry in ESPN's own /standings shape (both NBA and EPL below use
// this exact shape) - `type` is the stable machine key parseNbaStandingsResponse/
// parseEplStandingsResponse actually match against.
function stat(type, value, displayValue) {
  return { type, value, displayValue: displayValue ?? String(value) };
}

describe('MLB_STATS_API_TEAM_IDS', () => {
  test('has exactly 30 teams, one per MLB club, with unique numeric ids', () => {
    const entries = Object.entries(MLB_STATS_API_TEAM_IDS);
    assert.equal(entries.length, 30);
    const ids = entries.map(([, id]) => id);
    assert.equal(new Set(ids).size, ids.length, 'every team id should be unique');
    for (const [team, id] of entries) {
      assert.equal(typeof id, 'number', `${team}'s id should be a number`);
    }
  });
});

describe('parseMlbTeamRecord', () => {
  test('parses a well-formed teamRecord entry', () => {
    const record = parseMlbTeamRecord({
      gamesBack: '2.5',
      wildCardGamesBack: '-',
      streak: { streakCode: 'W4' },
      records: { splitRecords: [{ type: 'lastTen', wins: 7, losses: 3 }, { type: 'home', wins: 40, losses: 20 }] }
    });
    assert.deepEqual(record, {
      gamesBack: 2.5,
      wildCardGamesBack: 0,
      lastTen: { wins: 7, losses: 3 },
      streakCode: 'W4'
    });
  });

  test('treats "-" as 0 games back (leading the race), not null', () => {
    const record = parseMlbTeamRecord({ gamesBack: '-', wildCardGamesBack: '-' });
    assert.equal(record.gamesBack, 0);
    assert.equal(record.wildCardGamesBack, 0);
  });

  test('a missing lastTen split record yields null, not a crash', () => {
    const record = parseMlbTeamRecord({ gamesBack: '1', records: { splitRecords: [{ type: 'home', wins: 1, losses: 1 }] } });
    assert.equal(record.lastTen, null);
  });

  test('handles a completely empty/malformed input gracefully', () => {
    assert.deepEqual(parseMlbTeamRecord({}), {
      gamesBack: null,
      wildCardGamesBack: null,
      lastTen: null,
      streakCode: null
    });
    assert.deepEqual(parseMlbTeamRecord(null), {
      gamesBack: null,
      wildCardGamesBack: null,
      lastTen: null,
      streakCode: null
    });
  });
});

describe('parseMlbStandingsResponse', () => {
  test('walks every division\'s teamRecords into one map keyed by team id', () => {
    const json = {
      records: [
        {
          division: { name: 'AL East' },
          teamRecords: [
            { team: { id: 147 }, gamesBack: '-', streak: { streakCode: 'W2' } },
            { team: { id: 139 }, gamesBack: '4.0', streak: { streakCode: 'L1' } }
          ]
        },
        {
          division: { name: 'NL West' },
          teamRecords: [{ team: { id: 119 }, gamesBack: '-', streak: { streakCode: 'W6' } }]
        }
      ]
    };
    const parsed = parseMlbStandingsResponse(json);
    assert.equal(parsed.size, 3);
    assert.equal(parsed.get(147).streakCode, 'W2');
    assert.equal(parsed.get(139).gamesBack, 4.0);
    assert.equal(parsed.get(119).streakCode, 'W6');
  });

  test('a team record with no numeric team id is skipped, not a crash', () => {
    const json = { records: [{ teamRecords: [{ team: {}, gamesBack: '1' }] }] };
    assert.equal(parseMlbStandingsResponse(json).size, 0);
  });

  test('a completely empty/malformed response yields an empty map, not a throw', () => {
    assert.equal(parseMlbStandingsResponse({}).size, 0);
    assert.equal(parseMlbStandingsResponse(null).size, 0);
    assert.equal(parseMlbStandingsResponse({ records: null }).size, 0);
  });

  test('the leader gets divisionLeadMargin = the runner-up\'s own gamesBack', () => {
    const json = {
      records: [
        {
          division: { name: 'NL West' },
          teamRecords: [
            { team: { id: 119 }, gamesBack: '-' }, // Dodgers, leading
            { team: { id: 135 }, gamesBack: '9.0' }, // Padres, runner-up
            { team: { id: 137 }, gamesBack: '32.0' } // Giants, last place
          ]
        }
      ]
    };
    const parsed = parseMlbStandingsResponse(json);
    assert.equal(parsed.get(119).divisionLeadMargin, 9.0, 'leader\'s margin is the CLOSEST rival, not the farthest');
    assert.equal(parsed.get(135).divisionLeadMargin, undefined, 'only ever set for the leader itself');
    assert.equal(parsed.get(137).divisionLeadMargin, undefined);
  });

  test('a lone team in its own division group has no runner-up, so no margin', () => {
    const json = { records: [{ teamRecords: [{ team: { id: 119 }, gamesBack: '-' }] }] };
    assert.equal(parseMlbStandingsResponse(json).get(119).divisionLeadMargin, null);
  });

  describe('magicNumber (leader only, see objective-score.mjs\'s playoffProximityScore)', () => {
    test('the leader gets a real, still-counting-down magic number parsed from the API', () => {
      const json = {
        records: [
          {
            teamRecords: [
              { team: { id: 114 }, gamesBack: '-', magicNumber: '5' }, // Guardians, leading, not yet clinched
              { team: { id: 145 }, gamesBack: '1.0', magicNumber: undefined } // White Sox, runner-up
            ]
          }
        ]
      };
      const parsed = parseMlbStandingsResponse(json);
      assert.equal(parsed.get(114).magicNumber, 5);
      assert.equal(parsed.get(145).magicNumber, undefined, 'only ever set for the leader itself');
    });

    test('"-" (already clinched) parses as null, not 0', () => {
      const json = { records: [{ teamRecords: [{ team: { id: 139 }, gamesBack: '-', magicNumber: '-' }] }] };
      assert.equal(parseMlbStandingsResponse(json).get(139).magicNumber, null);
    });

    test('a missing magicNumber field (a division with no live race at all) parses as null', () => {
      const json = { records: [{ teamRecords: [{ team: { id: 119 }, gamesBack: '-' }] }] };
      assert.equal(parseMlbStandingsResponse(json).get(119).magicNumber, null);
    });
  });
});

// Unlike the MLB parser above, these two ARE verified against real live
// ESPN /standings responses (2026-09-21, plus a real historical 2024-25
// NBA response for a non-zero mid-season shape) - see this repo's own
// session notes for the exact curl output these fixtures are modeled on.
describe('parseNbaStandingsResponse', () => {
  function nbaEntry(name, wins, losses, { lastTen, streak } = {}) {
    const stats = [stat('wins', wins), stat('losses', losses)];
    if (lastTen) stats.push(stat('lasttengames', null, `${lastTen.wins}-${lastTen.losses}`));
    stats.push(stat('streak', null, streak ?? '-'));
    return { team: { displayName: name }, stats };
  }

  test('computes a signed gap to the 6-seed and 10-seed cutoffs from real wins/losses', () => {
    // A 12-team conference (only the top/bottom matter here) shaped like a
    // real, tight bubble race - several teams within a game of a cutoff,
    // same shape live-confirmed in a real 2024-25 ESPN response.
    const entries = [
      nbaEntry('Team A', 50, 20),
      nbaEntry('Team B', 45, 25),
      nbaEntry('Team C', 42, 28),
      nbaEntry('Team D', 40, 30),
      nbaEntry('Team E', 39, 31),
      nbaEntry('Team F', 38, 32, { lastTen: { wins: 6, losses: 4 }, streak: 'W2' }), // 6th - direct-playoff line
      nbaEntry('Team G', 37, 33),
      nbaEntry('Team H', 36, 34),
      nbaEntry('Team I', 35, 35),
      nbaEntry('Team J', 34, 36, { lastTen: { wins: 3, losses: 7 }, streak: 'L4' }), // 10th - play-in line
      nbaEntry('Team K', 33, 37),
      nbaEntry('Team L', 20, 50)
    ];
    const parsed = parseNbaStandingsResponse({ children: [{ standings: { entries } }] });
    assert.equal(parsed.get('Team F').sixSeedGap, 0, 'the 6th-place team itself sits exactly on the cutoff');
    assert.equal(parsed.get('Team J').tenSeedGap, 0, 'the 10th-place team itself sits exactly on the cutoff');
    assert.ok(parsed.get('Team A').sixSeedGap < 0, 'the 1st-place team is well AHEAD of the cutoff');
    assert.ok(parsed.get('Team L').tenSeedGap > 0, 'the last-place team is well BEHIND the cutoff');
    assert.deepEqual(parsed.get('Team F').lastTen, { wins: 6, losses: 4 });
    assert.equal(parsed.get('Team F').streakCode, 'W2');
    assert.equal(parsed.get('Team J').streakCode, 'L4');
    assert.equal(parsed.get('Team A').streakCode, null, '"-" (no streak reported) reads as null, never guessed');
  });

  test('before the season starts (every team 0-0), every gap is null, not a false "tied for the cutoff" 0', () => {
    const entries = Array.from({ length: 12 }, (_, i) => nbaEntry(`Team ${i}`, 0, 0));
    const parsed = parseNbaStandingsResponse({ children: [{ standings: { entries } }] });
    for (const [, signal] of parsed) {
      assert.equal(signal.sixSeedGap, null);
      assert.equal(signal.tenSeedGap, null);
    }
  });

  test('a team that individually has not played yet gets no gap, even once the league has started', () => {
    // Needs at least NBA_PLAYOFF_SEED_CUTOFF (6) teams with real games
    // played for the cutoff itself to exist at all.
    const entries = [
      nbaEntry('Played A', 10, 2),
      nbaEntry('Played B', 9, 3),
      nbaEntry('Played C', 8, 4),
      nbaEntry('Played D', 7, 5),
      nbaEntry('Played E', 6, 6),
      nbaEntry('Played F', 5, 7),
      nbaEntry('Not Yet', 0, 0)
    ];
    const parsed = parseNbaStandingsResponse({ children: [{ standings: { entries } }] });
    assert.equal(parsed.get('Not Yet').sixSeedGap, null);
    assert.ok(Number.isFinite(parsed.get('Played A').sixSeedGap));
  });

  test('handles a missing/malformed response gracefully', () => {
    assert.equal(parseNbaStandingsResponse({}).size, 0);
    assert.equal(parseNbaStandingsResponse(null).size, 0);
    assert.equal(parseNbaStandingsResponse({ children: [{}] }).size, 0);
  });
});

describe('parseEplStandingsResponse', () => {
  function eplEntry(name, points, gamesPlayed = 10) {
    return {
      team: { displayName: name },
      stats: [stat('points', points), stat('gamesplayed', gamesPlayed), stat('pointdifferential', 0)]
    };
  }

  test('computes a signed points gap to the Champions League and relegation cutoffs', () => {
    // 20 clubs, descending points - the real EPL shape (top 4 = Champions
    // League, bottom 3 of 20 = relegated), live-confirmed against a real
    // current-season response.
    const points = [60, 55, 50, 45, 44, 40, 38, 36, 34, 32, 30, 28, 26, 24, 22, 20, 18, 16, 14, 10];
    const entries = points.map((p, i) => eplEntry(`Team ${i + 1}`, p));
    const parsed = parseEplStandingsResponse({ children: [{ standings: { entries } }] });
    assert.equal(parsed.get('Team 4').championsLeagueGap, 0, 'the 4th-place team itself sits exactly on the CL cutoff');
    assert.equal(parsed.get('Team 18').relegationGap, 0, 'the 18th-place team itself sits exactly on the relegation cutoff');
    assert.ok(parsed.get('Team 1').championsLeagueGap < 0, 'the runaway leader is well clear of the CL cutoff');
    assert.ok(parsed.get('Team 20').relegationGap > 0, 'last place is well short of the safety cutoff');
  });

  test('before a ball is kicked (every team on 0 games played), every gap is null, not a false 0', () => {
    const entries = Array.from({ length: 20 }, (_, i) => eplEntry(`Team ${i}`, 0, 0));
    const parsed = parseEplStandingsResponse({ children: [{ standings: { entries } }] });
    for (const [, signal] of parsed) {
      assert.equal(signal.championsLeagueGap, null);
      assert.equal(signal.relegationGap, null);
    }
  });

  test('handles a missing/malformed response gracefully', () => {
    assert.equal(parseEplStandingsResponse({}).size, 0);
    assert.equal(parseEplStandingsResponse(null).size, 0);
    assert.equal(parseEplStandingsResponse({ children: [] }).size, 0);
  });
});

describe('computeTitleRaceIntensity', () => {
  test('a dead-heat for the lead (zero point gap) is maximum intensity', () => {
    const intensity = computeTitleRaceIntensity([{ points: '300' }, { points: '300' }]);
    assert.equal(intensity, 1);
  });

  test('a gap at or beyond the decided threshold is zero intensity', () => {
    assert.equal(
      computeTitleRaceIntensity([{ points: String(F1_TITLE_RACE_DECIDED_GAP_POINTS) }, { points: '0' }]),
      0
    );
    assert.equal(computeTitleRaceIntensity([{ points: '500' }, { points: '0' }]), 0);
  });

  test('a half-sized gap is roughly half intensity', () => {
    const halfGap = F1_TITLE_RACE_DECIDED_GAP_POINTS / 2;
    const intensity = computeTitleRaceIntensity([{ points: String(halfGap) }, { points: '0' }]);
    assert.ok(Math.abs(intensity - 0.5) < 0.001);
  });

  test('returns null when there are fewer than two ranked drivers', () => {
    assert.equal(computeTitleRaceIntensity([{ points: '100' }]), null);
    assert.equal(computeTitleRaceIntensity([]), null);
    assert.equal(computeTitleRaceIntensity(null), null);
  });

  test('returns null on non-numeric points rather than NaN/throwing', () => {
    assert.equal(computeTitleRaceIntensity([{ points: 'x' }, { points: '0' }]), null);
  });
});

describe('parseF1DriverStandingsResponse', () => {
  test('extracts the DriverStandings array from the Ergast/Jolpica response shape', () => {
    const json = {
      MRData: {
        StandingsTable: {
          StandingsLists: [{ season: '2026', DriverStandings: [{ position: '1', points: '350' }, { position: '2', points: '310' }] }]
        }
      }
    };
    const standings = parseF1DriverStandingsResponse(json);
    assert.equal(standings.length, 2);
    assert.equal(standings[0].points, '350');
  });

  test('returns an empty array for a missing/malformed shape, never throws', () => {
    assert.deepEqual(parseF1DriverStandingsResponse({}), []);
    assert.deepEqual(parseF1DriverStandingsResponse(null), []);
    assert.deepEqual(parseF1DriverStandingsResponse({ MRData: { StandingsTable: { StandingsLists: [] } } }), []);
  });
});

describe('applyMlbActualEnds (real end times from the MLB Stats API)', () => {
  const game = (homeId, gameDate, firstPitch, minutes, delay = 0) => ({
    gameDate,
    status: { abstractGameState: 'Final' },
    teams: { home: { team: { id: homeId } } },
    gameInfo: { firstPitch, gameDurationMinutes: minutes, delayDurationMinutes: delay }
  });
  const mlb = (id, home, start) => ({
    id,
    sport: 'MLB',
    isFinished: true,
    startTimeUtc: start,
    durationMinutes: 999,
    competitors: [{ name: 'Toronto Blue Jays', homeAway: 'away' }, { name: home, homeAway: 'home' }]
  });

  test('parseMlbGameEnds: first pitch + game time + delay', () => {
    const [end] = parseMlbGameEnds({ dates: [{ games: [game(116, '2026-09-23T17:10:00Z', '2026-09-23T17:12:00.000Z', 164, 5)] }] });
    assert.equal(end.endMs, Date.parse('2026-09-23T17:12:00Z') + 169 * 60_000);
  });

  test('matches each game of a doubleheader by home team and start time', async () => {
    const early = mlb('a', 'Baltimore Orioles', '2026-09-23T17:35:00.000Z');
    const late = mlb('b', 'Baltimore Orioles', '2026-09-23T22:35:00.000Z');
    const json = {
      dates: [
        {
          games: [
            game(110, '2026-09-23T17:35:00Z', '2026-09-23T17:36:00.000Z', 158),
            game(110, '2026-09-23T22:35:00Z', '2026-09-23T22:35:00.000Z', 142)
          ]
        }
      ]
    };
    await applyMlbActualEnds([early, late], async () => json);
    assert.equal(early.durationMinutes, 159);
    assert.equal(early.actualEndUtc, '2026-09-23T20:14:00.000Z');
    assert.equal(late.durationMinutes, 142);
  });

  test('a failed lookup keeps the estimate', async () => {
    const m = mlb('a', 'Baltimore Orioles', '2026-09-23T17:35:00.000Z');
    await applyMlbActualEnds([m], async () => {
      throw new Error('down');
    });
    assert.equal(m.durationMinutes, 999);
    assert.equal(m.actualEndUtc, undefined);
  });
});
