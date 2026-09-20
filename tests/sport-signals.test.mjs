// Tests for scripts/sport-signals.mjs's own PURE parsing functions -
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
  computeTitleRaceIntensity,
  parseF1DriverStandingsResponse,
  F1_TITLE_RACE_DECIDED_GAP_POINTS
} from '../scripts/sport-signals.mjs';

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
