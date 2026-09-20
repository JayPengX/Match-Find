// Tests for scripts/sport-duration.mjs - the deterministic, per-fixture
// broadcast-length formulas that replaced the old flat per-league average
// (see that module's own top-of-file comment).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MLB_BASE_DURATION_MINUTES,
  MLB_TEAM_PACE_OFFSET_MINUTES,
  isCoorsField,
  predictMlbDurationMinutes,
  mlbOddsDurationModifier,
  MLB_LEAGUE_AVG_OVER_UNDER,
  MLB_ODDS_DURATION_MODIFIER_CAP_MINUTES,
  isMlbRivalry,
  NBA_BASELINE_MINUTES,
  isNationalBroadcast,
  isNbaRivalry,
  predictNbaDurationMinutes,
  EPL_BASELINE_MINUTES,
  EPL_MIN_DURATION_MINUTES,
  EPL_MAX_DURATION_MINUTES,
  isEplDerby,
  predictEplDurationMinutes,
  F1_MAX_ACTIVE_RACING_MINUTES,
  resolveF1CircuitKey,
  predictF1RaceDurationMinutes
} from '../scripts/sport-duration.mjs';

describe('MLB duration prediction', () => {
  test('two teams with no offsets recognized average to the flat baseline plus the ABS padding', () => {
    const duration = predictMlbDurationMinutes({ awayTeam: 'Unknown Team A', homeTeam: 'Unknown Team B', venue: '' });
    assert.equal(duration, MLB_BASE_DURATION_MINUTES + 1); // +1 ABS challenge padding, 0 team/venue modifiers
  });

  test('a fast-pace team paired with a slow-pace team averages both offsets', () => {
    // Yankees (+6) @ Rays (-13) -> average -3.5, rounds to -4 once combined with the +1 ABS pad
    const duration = predictMlbDurationMinutes({ awayTeam: 'New York Yankees', homeTeam: 'Tampa Bay Rays', venue: '' });
    assert.equal(duration, Math.round(MLB_BASE_DURATION_MINUTES + (6 + -13) / 2 + 1));
  });

  test('an unrecognized team contributes a zero offset rather than throwing', () => {
    const duration = predictMlbDurationMinutes({ awayTeam: 'Spring Training All-Stars', homeTeam: 'Tampa Bay Rays', venue: '' });
    assert.equal(duration, Math.round(MLB_BASE_DURATION_MINUTES + (0 + -13) / 2 + 1));
  });

  test('Coors Field adds its own venue modifier on top of the Rockies\' own team offset', () => {
    const atCoors = predictMlbDurationMinutes({ awayTeam: 'Houston Astros', homeTeam: 'Colorado Rockies', venue: 'Coors Field' });
    const elsewhere = predictMlbDurationMinutes({ awayTeam: 'Houston Astros', homeTeam: 'Colorado Rockies', venue: 'Some Other Park' });
    assert.equal(atCoors - elsewhere, 10);
  });

  test('mlbOddsDurationModifier is 0 at the league-average total, positive above it, negative below', () => {
    assert.equal(mlbOddsDurationModifier(MLB_LEAGUE_AVG_OVER_UNDER), 0);
    assert.ok(mlbOddsDurationModifier(MLB_LEAGUE_AVG_OVER_UNDER + 1) > 0);
    assert.ok(mlbOddsDurationModifier(MLB_LEAGUE_AVG_OVER_UNDER - 1) < 0);
  });

  test('mlbOddsDurationModifier is capped in both directions and neutral for a missing line', () => {
    assert.equal(mlbOddsDurationModifier(MLB_LEAGUE_AVG_OVER_UNDER + 100), MLB_ODDS_DURATION_MODIFIER_CAP_MINUTES);
    assert.equal(mlbOddsDurationModifier(MLB_LEAGUE_AVG_OVER_UNDER - 100), -MLB_ODDS_DURATION_MODIFIER_CAP_MINUTES);
    assert.equal(mlbOddsDurationModifier(null), 0);
    assert.equal(mlbOddsDurationModifier(undefined), 0);
  });

  test('predictMlbDurationMinutes folds the odds modifier into the total when given one', () => {
    const withHighTotal = predictMlbDurationMinutes({
      awayTeam: 'Unknown Team A',
      homeTeam: 'Unknown Team B',
      venue: '',
      oddsOverUnder: MLB_LEAGUE_AVG_OVER_UNDER + 2
    });
    const withoutOdds = predictMlbDurationMinutes({ awayTeam: 'Unknown Team A', homeTeam: 'Unknown Team B', venue: '' });
    assert.ok(withHighTotal > withoutOdds);
  });

  test('isCoorsField only matches the exact venue name', () => {
    assert.ok(isCoorsField('Coors Field'));
    assert.ok(!isCoorsField('coors field'));
    assert.ok(!isCoorsField(''));
    assert.ok(!isCoorsField(undefined));
  });

  test('every team offset is a finite number (data-table sanity check)', () => {
    for (const [team, offset] of Object.entries(MLB_TEAM_PACE_OFFSET_MINUTES)) {
      assert.ok(Number.isFinite(offset), `${team} has a non-numeric offset`);
    }
  });
});

describe('isMlbRivalry', () => {
  test('recognizes a known historic rivalry in either direction', () => {
    assert.ok(isMlbRivalry('Los Angeles Dodgers', 'San Francisco Giants'));
    assert.ok(isMlbRivalry('San Francisco Giants', 'Los Angeles Dodgers'));
  });

  test('a non-rivalry matchup is not flagged', () => {
    assert.ok(!isMlbRivalry('Los Angeles Dodgers', 'Miami Marlins'));
  });
});

describe('NBA duration prediction', () => {
  test('two unrecognized teams with no national broadcast fall back to baseline plus expected overtime', () => {
    const duration = predictNbaDurationMinutes({ awayTeam: 'A', homeTeam: 'B', broadcast: '' });
    assert.equal(duration, Math.round(NBA_BASELINE_MINUTES + 0.063 * 18));
  });

  test('a known rivalry adds its own modifier', () => {
    const rivalry = predictNbaDurationMinutes({ awayTeam: 'Los Angeles Lakers', homeTeam: 'Boston Celtics', broadcast: '' });
    const nonRivalry = predictNbaDurationMinutes({ awayTeam: 'A', homeTeam: 'B', broadcast: '' });
    assert.equal(rivalry - nonRivalry, 6);
  });

  test('rivalry detection is direction-independent', () => {
    assert.ok(isNbaRivalry('Boston Celtics', 'Los Angeles Lakers'));
    assert.ok(isNbaRivalry('Los Angeles Lakers', 'Boston Celtics'));
    assert.ok(!isNbaRivalry('Los Angeles Lakers', 'Miami Heat'));
  });

  test('a national broadcast network adds its own modifier', () => {
    const national = predictNbaDurationMinutes({ awayTeam: 'A', homeTeam: 'B', broadcast: 'TNT' });
    const regional = predictNbaDurationMinutes({ awayTeam: 'A', homeTeam: 'B', broadcast: 'Bally Sports' });
    assert.equal(national - regional, 5);
  });

  test('isNationalBroadcast is case-insensitive and exact, not a substring match', () => {
    assert.ok(isNationalBroadcast('tnt'));
    assert.ok(isNationalBroadcast('ESPN'));
    assert.ok(!isNationalBroadcast('ESPN Deportes'));
    assert.ok(!isNationalBroadcast(''));
  });
});

describe('EPL duration prediction', () => {
  test('a non-derby fixture returns the flat baseline', () => {
    assert.equal(predictEplDurationMinutes({ awayTeam: 'A', homeTeam: 'B' }), EPL_BASELINE_MINUTES);
  });

  test('a known derby adds its own modifier', () => {
    const derby = predictEplDurationMinutes({ awayTeam: 'Arsenal', homeTeam: 'Tottenham Hotspur' });
    assert.equal(derby, EPL_BASELINE_MINUTES + 4);
  });

  test('derby detection is direction-independent', () => {
    assert.ok(isEplDerby('Tottenham Hotspur', 'Arsenal'));
    assert.ok(isEplDerby('Arsenal', 'Tottenham Hotspur'));
    assert.ok(!isEplDerby('Arsenal', 'Aston Villa'));
  });

  test('the result is always clamped inside [min, max]', () => {
    const duration = predictEplDurationMinutes({ awayTeam: 'Arsenal', homeTeam: 'Tottenham Hotspur' });
    assert.ok(duration >= EPL_MIN_DURATION_MINUTES);
    assert.ok(duration <= EPL_MAX_DURATION_MINUTES);
  });
});

describe('F1 race duration prediction', () => {
  test('resolves a well-known circuit from a fuzzy venue name', () => {
    assert.equal(resolveF1CircuitKey('Circuit de Monaco'), 'Monaco');
    assert.equal(resolveF1CircuitKey('Autodromo Nazionale di Monza'), 'Monza');
    assert.equal(resolveF1CircuitKey('Marina Bay Street Circuit'), 'Marina Bay');
  });

  test('returns null for an unrecognized venue rather than throwing', () => {
    assert.equal(resolveF1CircuitKey('Some New Circuit'), null);
    assert.equal(resolveF1CircuitKey(''), null);
    assert.equal(resolveF1CircuitKey(undefined), null);
  });

  test('an unrecognized circuit falls back to the default baseline', () => {
    assert.equal(predictF1RaceDurationMinutes('Some New Circuit'), 92);
  });

  test('Monaco predicts its own known, longer baseline', () => {
    assert.equal(predictF1RaceDurationMinutes('Circuit de Monaco'), 110);
  });

  test('no circuit baseline ever exceeds the hard regulatory cap', () => {
    assert.ok(predictF1RaceDurationMinutes('Circuit de Monaco') <= F1_MAX_ACTIVE_RACING_MINUTES);
    assert.ok(predictF1RaceDurationMinutes('Some New Circuit') <= F1_MAX_ACTIVE_RACING_MINUTES);
  });
});
