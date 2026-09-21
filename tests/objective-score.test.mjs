// Tests for public/lib/objective-score.mjs - the deterministic, API-data-based
// scoring engine that replaced asking Gemini for competitiveness/
// watchability/enduranceScore from scratch. Every function here is pure,
// so these tests use plain hand-built numbers rather than real API
// responses (see public/lib/sport-signals.mjs's own tests for the parsing
// half of this pipeline).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  weightedAverage,
  closenessFromWinPctGap,
  closenessFromSpread,
  playoffProximityScore,
  streakMomentum,
  closenessFromLastTen,
  estimateBroadcastQualityBaseline,
  computeMlbObjectiveScore,
  computeNbaObjectiveScore,
  computeEplObjectiveScore,
  computeF1ObjectiveScore,
  skillFromWinPct
} from '../public/lib/objective-score.mjs';

describe('clamp', () => {
  test('bounds a value inside [min, max]', () => {
    assert.equal(clamp(15, 1, 10), 10);
    assert.equal(clamp(-5, 1, 10), 1);
    assert.equal(clamp(5, 1, 10), 5);
  });
});

describe('weightedAverage', () => {
  test('a plain weighted average when every value is present', () => {
    assert.equal(weightedAverage([[10, 0.5], [0, 0.5]]), 5);
  });

  test('renormalizes weights when some values are missing (null/undefined/NaN)', () => {
    // Only the first pair survives - its weight becomes 100% of the total,
    // so the result is just that value, not pulled toward zero.
    assert.equal(weightedAverage([[8, 0.5], [null, 0.5]]), 8);
    assert.equal(weightedAverage([[8, 0.3], [undefined, 0.3], [NaN, 0.4]]), 8);
  });

  test('returns null when every value is missing', () => {
    assert.equal(weightedAverage([[null, 1], [undefined, 1]]), null);
  });
});

describe('closenessFromWinPctGap', () => {
  test('a zero gap (dead-even records) scores a perfect 10', () => {
    assert.equal(closenessFromWinPctGap(0), 10);
  });

  test('a large gap bottoms out at 1, never below', () => {
    assert.equal(closenessFromWinPctGap(0.9), 1);
  });

  test('the sign of the gap does not matter, only its magnitude', () => {
    assert.equal(closenessFromWinPctGap(0.2), closenessFromWinPctGap(-0.2));
  });

  test('returns null for a non-finite input rather than throwing', () => {
    assert.equal(closenessFromWinPctGap(null), null);
    assert.equal(closenessFromWinPctGap(undefined), null);
    assert.equal(closenessFromWinPctGap(NaN), null);
  });
});

describe('closenessFromSpread', () => {
  test('a zero spread (a pick\'em) scores a perfect 10', () => {
    assert.equal(closenessFromSpread(0, 3), 10);
  });

  test('a spread at the lopsided threshold scores near the bottom', () => {
    assert.equal(closenessFromSpread(3, 3), 1);
  });

  test('a spread beyond the threshold still clamps at 1, never negative', () => {
    assert.equal(closenessFromSpread(20, 3), 1);
  });

  test('returns null when the spread or threshold is missing/invalid', () => {
    assert.equal(closenessFromSpread(null, 3), null);
    assert.equal(closenessFromSpread(1, 0), null);
    assert.equal(closenessFromSpread(1, null), null);
  });
});

describe('playoffProximityScore', () => {
  test('leading a race (0 games back) scores a perfect 10', () => {
    assert.equal(playoffProximityScore(0, 0), 10);
  });

  test('takes the SMALLER of division/wild-card deficits (either keeps the race alive)', () => {
    assert.equal(playoffProximityScore(8, 0.5), playoffProximityScore(0.5, 0.5));
  });

  test('a large deficit floors at 0, not 1 (a genuinely decided race contributes nothing)', () => {
    assert.equal(playoffProximityScore(20, 20), 0);
  });

  test('returns null when neither figure is known', () => {
    assert.equal(playoffProximityScore(null, undefined), null);
  });

  test('a division leader tied for the lead (margin 0) still scores a perfect 10', () => {
    assert.equal(playoffProximityScore(0, 5, 0), 10);
  });

  test('a division leader with a comfortable lead is discounted, not maxed out', () => {
    // Live case this fixes (2026-09-26): a 96-60 Dodgers team up 9 games
    // on the Padres - gamesBack reads 0 either way, but a real 9-game
    // cushion is not a live race.
    const comfortable = playoffProximityScore(0, 0, 9);
    assert.ok(comfortable < 10);
    assert.ok(comfortable >= 2, 'never floors below 2 - a leader still has real stakes');
  });

  test('a huge division lead floors at 2, not 0 - a leader always keeps some stakes', () => {
    assert.equal(playoffProximityScore(0, 0, 30), 2);
  });

  test('divisionLeadMargin is ignored for a team that is NOT leading (gamesBack > 0)', () => {
    assert.equal(playoffProximityScore(8, 8, 30), playoffProximityScore(8, 8, undefined));
  });
});

describe('streakMomentum', () => {
  test('a winning streak scores above the neutral midpoint', () => {
    assert.ok(streakMomentum('W5') > 5);
  });

  test('a losing streak scores below the neutral midpoint', () => {
    assert.ok(streakMomentum('L4') < 5);
  });

  test('a longer streak in either direction moves further from neutral, capped at 8 games', () => {
    assert.ok(streakMomentum('W8') > streakMomentum('W2'));
    assert.equal(streakMomentum('W20'), streakMomentum('W8')); // capped
  });

  test('returns null for a missing or malformed streak code', () => {
    assert.equal(streakMomentum(null), null);
    assert.equal(streakMomentum(''), null);
    assert.equal(streakMomentum('bogus'), null);
  });
});

describe('closenessFromLastTen', () => {
  test('identical last-10 records score a perfect 10', () => {
    assert.equal(closenessFromLastTen({ wins: 6, losses: 4 }, { wins: 6, losses: 4 }), 10);
  });

  test('a large last-10 gap scores low', () => {
    const close = closenessFromLastTen({ wins: 9, losses: 1 }, { wins: 1, losses: 9 });
    assert.ok(close <= 2);
  });

  test('returns null when either side\'s last-10 record is missing', () => {
    assert.equal(closenessFromLastTen(null, { wins: 5, losses: 5 }), null);
    assert.equal(closenessFromLastTen({ wins: 5, losses: 5 }, null), null);
  });

  // Same class of bug as computeMatchObjectiveScore's own live-verified
  // 0-0 preseason regression (tests/build-data.test.mjs) - 0 games played
  // must never read as a real, tied 0.000 recent-form pct.
  test('returns null (not a maxed-out 10) when either side has played 0 of its own last 10', () => {
    assert.equal(closenessFromLastTen({ wins: 0, losses: 0 }, { wins: 6, losses: 4 }), null);
    assert.equal(closenessFromLastTen({ wins: 6, losses: 4 }, { wins: 0, losses: 0 }), null);
    assert.equal(closenessFromLastTen({ wins: 0, losses: 0 }, { wins: 0, losses: 0 }), null);
  });
});

describe('estimateBroadcastQualityBaseline', () => {
  test('a known flagship network scores above neutral', () => {
    assert.equal(estimateBroadcastQualityBaseline('ESPN'), 7);
    assert.equal(estimateBroadcastQualityBaseline('apple tv'), 7); // case-insensitive
  });

  test('an empty or unrecognized broadcaster scores neutral', () => {
    assert.equal(estimateBroadcastQualityBaseline(''), 5);
    assert.equal(estimateBroadcastQualityBaseline('Bally Sports Some Region'), 5);
  });
});

describe('skillFromWinPct', () => {
  test('a perfectly average .500 win% is the neutral midpoint', () => {
    assert.equal(skillFromWinPct(0.5), 5);
  });

  test('a realistic elite team win% scores near the top', () => {
    assert.ok(skillFromWinPct(0.6) >= 7);
  });

  test('a realistic also-ran win% scores near the bottom', () => {
    assert.ok(skillFromWinPct(0.4) <= 3);
  });

  test('is always clamped to [1, 10] even for an unrealistic win%', () => {
    assert.equal(skillFromWinPct(1), 10);
    assert.equal(skillFromWinPct(0), 1);
  });

  test('returns null, not NaN, when no win% is available', () => {
    assert.equal(skillFromWinPct(null), null);
    assert.equal(skillFromWinPct(undefined), null);
  });
});

describe('computeMlbObjectiveScore', () => {
  test('skill reflects the AVERAGE quality of both teams, not how close the game is - two elite teams score higher skill than two also-rans, even at the identical win% gap', () => {
    const eliteMatchup = computeMlbObjectiveScore({ awayWinPct: 0.62, homeWinPct: 0.58, away: null, home: null, isPostseason: false });
    const alsoRanMatchup = computeMlbObjectiveScore({ awayWinPct: 0.42, homeWinPct: 0.38, away: null, home: null, isPostseason: false });
    // Both pairings have the same 0.04 win% gap, so competitiveness should
    // be identical - it's SKILL, not competitiveness, that should tell
    // these two matchups apart.
    assert.equal(eliteMatchup.competitiveness, alsoRanMatchup.competitiveness);
    assert.ok(eliteMatchup.skill > alsoRanMatchup.skill);
  });

  test('skill is null, not a guessed default, when no win% is available', () => {
    const result = computeMlbObjectiveScore({ awayWinPct: null, homeWinPct: null, away: null, home: null, isPostseason: false });
    assert.equal(result.skill, null);
  });

  test('a known historic rivalry raises watchability over an otherwise-identical non-rivalry fixture - the deterministic fix for a real, current-record-mediocre-but-historically-major matchup (e.g. Dodgers vs Giants) losing its slot by a razor-thin scheduling margin', () => {
    const plain = computeMlbObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.48, away: null, home: null, isPostseason: false, isRivalry: false });
    const rivalry = computeMlbObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.48, away: null, home: null, isPostseason: false, isRivalry: true });
    assert.ok(rivalry.watchability > plain.watchability);
  });


  test('two evenly-matched teams with no other signals score high competitiveness', () => {
    const result = computeMlbObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.5, away: null, home: null, isPostseason: false });
    assert.ok(result.competitiveness >= 9);
  });

  test('a lopsided season record scores low competitiveness', () => {
    const result = computeMlbObjectiveScore({ awayWinPct: 0.75, homeWinPct: 0.25, away: null, home: null, isPostseason: false });
    assert.ok(result.competitiveness <= 3);
  });

  test('a postseason game always gets maximum stakes, regardless of the records', () => {
    const result = computeMlbObjectiveScore({ awayWinPct: 0.75, homeWinPct: 0.25, away: null, home: null, isPostseason: true });
    // Watchability blends stakes(=10) with the (low) competitiveness, so it
    // should still land meaningfully above a non-postseason equivalent.
    const regularSeason = computeMlbObjectiveScore({ awayWinPct: 0.75, homeWinPct: 0.25, away: null, home: null, isPostseason: false });
    assert.ok(result.watchability > regularSeason.watchability);
  });

  test('two teams both close to a playoff spot raises watchability over two teams far from one', () => {
    const closeRace = computeMlbObjectiveScore({
      awayWinPct: 0.5,
      homeWinPct: 0.5,
      away: { gamesBack: 0.5, wildCardGamesBack: 0.5, lastTen: null, streakCode: null },
      home: { gamesBack: 1, wildCardGamesBack: 0.5, lastTen: null, streakCode: null },
      isPostseason: false
    });
    const decidedRace = computeMlbObjectiveScore({
      awayWinPct: 0.5,
      homeWinPct: 0.5,
      away: { gamesBack: 20, wildCardGamesBack: 20, lastTen: null, streakCode: null },
      home: { gamesBack: 20, wildCardGamesBack: 20, lastTen: null, streakCode: null },
      isPostseason: false
    });
    assert.ok(closeRace.watchability > decidedRace.watchability);
  });

  test('a team on a hot streak raises watchability over otherwise-identical teams with no streak data', () => {
    const withStreak = computeMlbObjectiveScore({
      awayWinPct: 0.5,
      homeWinPct: 0.5,
      away: { gamesBack: null, wildCardGamesBack: null, lastTen: null, streakCode: 'W8' },
      home: null,
      isPostseason: false
    });
    const withoutStreak = computeMlbObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.5, away: null, home: null, isPostseason: false });
    assert.ok(withStreak.watchability >= withoutStreak.watchability);
  });

  test('a real odds spread contributes to competitiveness even with no record signal at all', () => {
    const result = computeMlbObjectiveScore({
      awayWinPct: null,
      homeWinPct: null,
      away: null,
      home: null,
      isPostseason: false,
      oddsSpread: 0.5
    });
    assert.ok(result.competitiveness >= 8);
  });

  test('every score is always within [1, 10] and factors is always an array', () => {
    const result = computeMlbObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.5, away: null, home: null, isPostseason: false });
    for (const key of ['competitiveness', 'watchability', 'enduranceScore']) {
      assert.ok(result[key] >= 1 && result[key] <= 10, `${key} out of range: ${result[key]}`);
    }
    assert.ok(Array.isArray(result.factors));
  });

  test('with literally no signals at all, every score falls back to a neutral 5', () => {
    const result = computeMlbObjectiveScore({ awayWinPct: null, homeWinPct: null, away: null, home: null, isPostseason: false });
    assert.equal(result.competitiveness, 5);
    assert.equal(result.watchability, 5);
  });
});

describe('computeNbaObjectiveScore', () => {
  test('a rivalry and a national broadcast both raise watchability', () => {
    const plain = computeNbaObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.5, isPostseason: false, isRivalry: false, isNationalBroadcast: false });
    const rivalryAndNational = computeNbaObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.5, isPostseason: false, isRivalry: true, isNationalBroadcast: true });
    assert.ok(rivalryAndNational.watchability > plain.watchability);
  });

  test('a postseason game raises watchability', () => {
    const regularSeason = computeNbaObjectiveScore({ awayWinPct: 0.6, homeWinPct: 0.4, isPostseason: false, isRivalry: false, isNationalBroadcast: false });
    const postseason = computeNbaObjectiveScore({ awayWinPct: 0.6, homeWinPct: 0.4, isPostseason: true, isRivalry: false, isNationalBroadcast: false });
    assert.ok(postseason.watchability > regularSeason.watchability);
  });

  test('skill is a real, computed value from the two teams average win%', () => {
    const result = computeNbaObjectiveScore({ awayWinPct: 0.7, homeWinPct: 0.7, isPostseason: false, isRivalry: false, isNationalBroadcast: false });
    assert.ok(result.skill >= 8);
  });
});

describe('computeEplObjectiveScore', () => {
  test('a derby raises watchability over an otherwise-identical non-derby fixture', () => {
    // Win rates deliberately not identical (which would already max out
    // competitiveness at 10 and leave no room for the derby bonus to show)
    // - a realistic, moderately-close gap instead.
    const plain = computeEplObjectiveScore({ awayWinPct: 0.55, homeWinPct: 0.45, isDerby: false });
    const derby = computeEplObjectiveScore({ awayWinPct: 0.55, homeWinPct: 0.45, isDerby: true });
    assert.ok(derby.watchability > plain.watchability);
  });

  test('a big-club fixture raises watchability over an otherwise-identical non-big-club fixture', () => {
    // Live-verified case: Liverpool @ AFC Bournemouth (2026-09-20) scored
    // watchability=3 from a noisy, small-sample early-season win% gap alone
    // - a genuinely elite, globally-followed club's own real-world draw
    // doesn't depend on this season's record the way skill/competitiveness
    // necessarily do (see sport-duration.mjs's EPL_BIG_CLUBS).
    const plain = computeEplObjectiveScore({ awayWinPct: 0.2, homeWinPct: 0.6, isDerby: false, isBigClub: false });
    const bigClub = computeEplObjectiveScore({ awayWinPct: 0.2, homeWinPct: 0.6, isDerby: false, isBigClub: true });
    assert.ok(bigClub.watchability > plain.watchability);
  });

  test('a derby between two big clubs stacks both bonuses rather than picking one', () => {
    const derbyOnly = computeEplObjectiveScore({ awayWinPct: 0.55, homeWinPct: 0.45, isDerby: true, isBigClub: false });
    const derbyAndBigClub = computeEplObjectiveScore({ awayWinPct: 0.55, homeWinPct: 0.45, isDerby: true, isBigClub: true });
    assert.ok(derbyAndBigClub.watchability >= derbyOnly.watchability);
    assert.ok(derbyAndBigClub.factors.includes('known derby fixture'));
    assert.ok(derbyAndBigClub.factors.includes('known big-club fixture'));
  });
});

describe('computeF1ObjectiveScore', () => {
  test('has no per-competitor skill signal - null, never a guessed default', () => {
    const result = computeF1ObjectiveScore({ titleRaceIntensity: 1 });
    assert.equal(result.skill, null);
  });

  test('a live, dead-heat title race scores near the top', () => {
    const result = computeF1ObjectiveScore({ titleRaceIntensity: 1 });
    assert.ok(result.watchability >= 9);
  });

  test('a fully decided title race scores near the bottom', () => {
    const result = computeF1ObjectiveScore({ titleRaceIntensity: 0 });
    assert.ok(result.watchability <= 5);
  });

  test('missing intensity data falls back to a neutral middle score', () => {
    const result = computeF1ObjectiveScore({ titleRaceIntensity: null });
    assert.equal(result.competitiveness, 5);
    assert.equal(result.watchability, 5);
  });
});
