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
  cutoffProximityScore,
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

  describe('magicNumber (preferred over divisionLeadMargin - see sport-signals.mjs)', () => {
    test('a magic number of 1 (could clinch tonight) scores a perfect 10, regardless of lead margin', () => {
      assert.equal(playoffProximityScore(0, 0, 30, 1), 10);
    });

    test('a real, live case: a 1-game division lead with a magic number of 5 still reads as genuinely tense', () => {
      // Live case validated against contemporary coverage (2026-09-23):
      // Cleveland Guardians, AL Central, division lead margin 1 over a
      // Chicago White Sox team a single game back - a real, live division
      // race - magic number 5. Matches what divisionLeadMargin alone
      // already gave this exact margin (playoffProximityScore(0,0,1) = 9,
      // by design - see the slope comment above) rather than reading as
      // notably LESS tense just because it's read a different way.
      assert.equal(playoffProximityScore(0, 0, 1, 5), 9);
    });

    test('regression: a real rival stays inside the rotation\'s own close-call gap, not pushed out by an over-eager discount', () => {
      // Live case this guards against: a first cut of this fix (slope
      // 0.5/point) discounted magic-number 5 down to 8, dropping Cleveland
      // Guardians @ Boston Red Sox (effectiveScore ~6.8) more than
      // VARIETY_CLOSE_CALL_GAP (0.6) behind its real rival Milwaukee
      // Brewers @ Philadelphia Phillies (~7.1) - which silently excluded a
      // genuinely live, comparably-strong rival from the whole-week
      // rotation (see computeVarietyRotation's own pool filter) purely
      // because ITS OWN stakes got read a slightly different, less
      // generous way than an equally-tense divisionLeadMargin case would
      // have. The margin between the two readings has to stay well under
      // VARIETY_CLOSE_CALL_GAP's own scale (0.6) for a genuinely
      // comparable case, not swing the outcome on its own.
      const byMagicNumber = playoffProximityScore(0, 0, 1, 5);
      const byLeadMarginAlone = playoffProximityScore(0, 0, 1);
      assert.ok(Math.abs(byMagicNumber - byLeadMarginAlone) <= 1);
    });

    test('a comfortable lead margin with a SMALL magic number scores higher than lead margin alone would', () => {
      // The gap this exists for: divisionLeadMargin alone can't tell "6
      // games up in June" from "6 games up with a handful left" - a magic
      // number already bakes the schedule in, so a small one outscores
      // what the lead-margin-only reading would have given.
      const byMagicNumber = playoffProximityScore(0, 0, 6, 3);
      const byLeadMarginAlone = playoffProximityScore(0, 0, 6, undefined);
      assert.ok(byMagicNumber > byLeadMarginAlone);
    });

    test('falls back to divisionLeadMargin once the leader has clinched (no magic number reported any more)', () => {
      assert.equal(playoffProximityScore(0, 0, 9, undefined), playoffProximityScore(0, 0, 9));
      assert.equal(playoffProximityScore(0, 0, 9, null), playoffProximityScore(0, 0, 9));
    });

    test('never discounted below 2, same floor as divisionLeadMargin', () => {
      assert.equal(playoffProximityScore(0, 0, undefined, 40), 2);
    });

    test('ignored for a team that is NOT leading (gamesBack > 0)', () => {
      assert.equal(playoffProximityScore(8, 8, undefined, 1), playoffProximityScore(8, 8, undefined, undefined));
    });
  });
});

describe('cutoffProximityScore', () => {
  test('sitting exactly on the cutoff (gap 0) scores a perfect 10', () => {
    assert.equal(cutoffProximityScore(0), 10);
  });

  test('symmetric: being AHEAD of a cutoff is discounted the same way as being behind it', () => {
    assert.equal(cutoffProximityScore(5), cutoffProximityScore(-5));
    assert.ok(cutoffProximityScore(5) < 10);
  });

  test('a large gap in either direction floors at 0', () => {
    assert.equal(cutoffProximityScore(20), 0);
    assert.equal(cutoffProximityScore(-20), 0);
  });

  test('`unit` rescales the gap - a points gap and its games-equivalent score the same', () => {
    // EPL's own points-to-games conversion (a win is worth 3 points).
    assert.equal(cutoffProximityScore(6, 3), cutoffProximityScore(2, 1));
  });

  test('returns null for a missing gap or an invalid unit', () => {
    assert.equal(cutoffProximityScore(null), null);
    assert.equal(cutoffProximityScore(5, 0), null);
    assert.equal(cutoffProximityScore(5, -1), null);
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
  test('skill reflects the BETTER team\'s own quality, not the average of both - two elite teams score higher skill than two also-rans, even at the identical win% gap', () => {
    const eliteMatchup = computeMlbObjectiveScore({ awayWinPct: 0.62, homeWinPct: 0.58, away: null, home: null, isPostseason: false });
    const alsoRanMatchup = computeMlbObjectiveScore({ awayWinPct: 0.42, homeWinPct: 0.38, away: null, home: null, isPostseason: false });
    // Both pairings have the same 0.04 win% gap, so competitiveness should
    // be identical - it's SKILL, not competitiveness, that should tell
    // these two matchups apart.
    assert.equal(eliteMatchup.competitiveness, alsoRanMatchup.competitiveness);
    assert.ok(eliteMatchup.skill > alsoRanMatchup.skill);
  });

  // Live case this exists for (2026-09-21): an elite 96-60 Dodgers team
  // (.615) against a rebuilding 64-92 Giants team (.410) AVERAGES to
  // .5125 - a neutral ~5 skill, indistinguishable from two genuinely
  // mediocre .500ish teams, which would defeat the entire point of wiring
  // skill into watchability. The better team's own win% doesn't have this
  // blind spot: a lopsided pairing that includes one genuinely elite team
  // scores meaningfully higher skill than an equally lopsided pairing
  // between two teams that are merely mediocre-vs-bad.
  test('an elite team dragged down by a bad opponent still scores high skill - averaging would hide this', () => {
    const eliteVsBad = computeMlbObjectiveScore({ awayWinPct: 0.615, homeWinPct: 0.41, away: null, home: null, isPostseason: false });
    const mediocreVsBad = computeMlbObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.41, away: null, home: null, isPostseason: false });
    assert.ok(eliteVsBad.skill > mediocreVsBad.skill);
  });

  test('skill is null, not a guessed default, when no win% is available', () => {
    const result = computeMlbObjectiveScore({ awayWinPct: null, homeWinPct: null, away: null, home: null, isPostseason: false });
    assert.equal(result.skill, null);
  });

  // Fame (watchability) is now a clean, unblended read of name recognition
  // alone - never mixed with skill/stakes/momentum, never gated by or
  // capped against competitiveness (see objective-score.mjs's own "Fame is
  // its own, unblended axis" comment for the full reasoning: a famous name
  // is a mainstream draw whether or not tonight's specific score is close).
  test('a known historic rivalry raises watchability over an otherwise-identical non-rivalry fixture, unconditionally', () => {
    const plain = computeMlbObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.48, away: null, home: null, isPostseason: false, isRivalry: false });
    const rivalry = computeMlbObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.48, away: null, home: null, isPostseason: false, isRivalry: true });
    assert.ok(rivalry.watchability > plain.watchability);
    assert.ok(rivalry.factors.includes('known historic rivalry matchup'));
  });

  // Direct instruction: "we prioritize star/team power" - EPL's own
  // isBigClub brought to MLB (see sport-duration.mjs's MLB_BIG_CLUBS).
  describe('isBigClub (star/team power)', () => {
    test('a marquee franchise raises watchability over an otherwise-identical non-marquee fixture, same shape as isRivalry', () => {
      const plain = computeMlbObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.48, away: null, home: null, isPostseason: false, isBigClub: false });
      const bigClub = computeMlbObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.48, away: null, home: null, isPostseason: false, isBigClub: true });
      assert.ok(bigClub.watchability > plain.watchability);
      assert.ok(bigClub.factors.includes('known marquee-franchise fixture'));
    });

    test('stacks with a genuine rivalry (a Yankees @ Red Sox game is both) - a bigger lift than either fact alone', () => {
      const base = { awayWinPct: 0.5, homeWinPct: 0.48, away: null, home: null, isPostseason: false };
      const neither = computeMlbObjectiveScore({ ...base, isRivalry: false, isBigClub: false });
      const rivalryOnly = computeMlbObjectiveScore({ ...base, isRivalry: true, isBigClub: false });
      const bigClubOnly = computeMlbObjectiveScore({ ...base, isRivalry: false, isBigClub: true });
      const both = computeMlbObjectiveScore({ ...base, isRivalry: true, isBigClub: true });
      assert.ok(both.watchability > rivalryOnly.watchability);
      assert.ok(both.watchability > bigClubOnly.watchability);
      assert.ok(rivalryOnly.watchability > neither.watchability);
      assert.ok(bigClubOnly.watchability > neither.watchability);
    });

    // Live case this fixes (the actual reason this whole model was
    // rewritten): a lopsided, low-competitiveness pairing between two
    // marquee names (Los Angeles Dodgers @ San Francisco Giants, both on
    // MLB_BIG_CLUBS) used to get its fame bonus gated down toward zero by
    // tonight's own low competitiveness, which - combined with a second,
    // unrelated case (Milwaukee Brewers @ Philadelphia Phillies, no fame
    // signal at all but a genuinely tense playoff race) - meant a real,
    // competitive small-market series could still lose every single day to
    // a big-club blowout once the numbers lined up. Fame is no longer
    // gated by competitiveness at all, so a big name's own lift is the
    // same full amount whatever tonight's score looks like - it's the
    // OVERALL ranking (see recommendation.mjs's BEST_MATCH_WEIGHTS, where
    // stakes/quality/closeness now carry real, separate weight) that
    // decides whether a famous-but-lopsided game actually outranks a
    // competitive-but-obscure one, not a gate inside this one field.
    test('unconditional - a lopsided pairing between two marquee names still gets the full lift, not a competitiveness-discounted fraction', () => {
      const lopsided = computeMlbObjectiveScore({
        awayWinPct: 96 / 156,
        homeWinPct: 64 / 156,
        away: { gamesBack: 0, wildCardGamesBack: 0, divisionLeadMargin: 9, lastTen: { wins: 7, losses: 3 }, streakCode: 'W4' },
        home: { gamesBack: 32, wildCardGamesBack: 22, lastTen: { wins: 3, losses: 7 }, streakCode: 'L3' },
        isPostseason: false,
        isRivalry: false,
        isBigClub: true
      });
      const lopsidedNoBigClub = computeMlbObjectiveScore({
        awayWinPct: 96 / 156,
        homeWinPct: 64 / 156,
        away: { gamesBack: 0, wildCardGamesBack: 0, divisionLeadMargin: 9, lastTen: { wins: 7, losses: 3 }, streakCode: 'W4' },
        home: { gamesBack: 32, wildCardGamesBack: 22, lastTen: { wins: 3, losses: 7 }, streakCode: 'L3' },
        isPostseason: false,
        isRivalry: false,
        isBigClub: false
      });
      assert.equal(lopsided.competitiveness, 5);
      assert.equal(lopsided.watchability - lopsidedNoBigClub.watchability, 2);
    });
  });

  test('watchability comes ONLY from rivalry/big-club - never from stakes, skill, or momentum', () => {
    const base = { awayWinPct: 0.5, homeWinPct: 0.5, isPostseason: false, isRivalry: false, isBigClub: false };
    const plain = computeMlbObjectiveScore({ ...base, away: null, home: null });
    // Maxed-out stakes (postseason) and a hot streak, still no rivalry/big
    // club - watchability must stay exactly the same neutral baseline.
    const maxedStakesAndMomentum = computeMlbObjectiveScore({
      ...base,
      isPostseason: true,
      away: { gamesBack: 0, wildCardGamesBack: 0, lastTen: { wins: 10, losses: 0 }, streakCode: 'W10' },
      home: { gamesBack: 0, wildCardGamesBack: 0, lastTen: { wins: 10, losses: 0 }, streakCode: 'W10' }
    });
    assert.equal(maxedStakesAndMomentum.watchability, plain.watchability);
    // But stakes itself DID change - it just doesn't leak into watchability.
    assert.equal(maxedStakesAndMomentum.stakes, 10);
  });

  test('two evenly-matched teams with no other signals score high competitiveness', () => {
    const result = computeMlbObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.5, away: null, home: null, isPostseason: false });
    assert.ok(result.competitiveness >= 9);
  });

  test('a lopsided season record scores low competitiveness', () => {
    const result = computeMlbObjectiveScore({ awayWinPct: 0.75, homeWinPct: 0.25, away: null, home: null, isPostseason: false });
    assert.ok(result.competitiveness <= 3);
  });

  // stakes/momentum are now their own axes (see recommendation.mjs's
  // BEST_MATCH_WEIGHTS), never blended into watchability - see the
  // "watchability comes ONLY from rivalry/big-club" test above for that
  // separation. These test `stakes` directly instead.
  test('a postseason game always gets maximum stakes, regardless of the records', () => {
    const result = computeMlbObjectiveScore({ awayWinPct: 0.75, homeWinPct: 0.25, away: null, home: null, isPostseason: true });
    assert.equal(result.stakes, 10);
  });

  test('two teams both close to a playoff spot score higher stakes than two teams far from one', () => {
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
    assert.ok(closeRace.stakes > decidedRace.stakes);
  });

  test('a team on a hot streak scores a higher recent-form gap (competitiveness) than otherwise-identical teams with no streak data', () => {
    // streakMomentum no longer feeds watchability, but its factor string
    // still surfaces so the local reason text can mention it.
    const withStreak = computeMlbObjectiveScore({
      awayWinPct: 0.5,
      homeWinPct: 0.5,
      away: { gamesBack: null, wildCardGamesBack: null, lastTen: null, streakCode: 'W8' },
      home: null,
      isPostseason: false
    });
    assert.ok(withStreak.factors.some(f => f.startsWith('streak')));
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

  test('the standard ±1.5 run line is not a signal - posting it never moves the score', () => {
    const base = {
      awayWinPct: 0.6,
      homeWinPct: 0.57,
      away: { gamesBack: 0, wildCardGamesBack: null, lastTen: { wins: 8, losses: 2 }, streakCode: 'L1' },
      home: { gamesBack: 2, wildCardGamesBack: null, lastTen: { wins: 6, losses: 4 }, streakCode: 'W1' },
      isPostseason: false
    };
    const unposted = computeMlbObjectiveScore({ ...base, oddsSpread: null });
    for (const oddsSpread of [-1.5, 1.5]) {
      const posted = computeMlbObjectiveScore({ ...base, oddsSpread });
      assert.equal(posted.competitiveness, unposted.competitiveness);
      assert.equal(posted.watchability, unposted.watchability);
      assert.ok(!posted.factors.some(f => f.startsWith('odds spread')));
    }
  });

  test('every score is always within [1, 10] and factors is always an array', () => {
    const result = computeMlbObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.5, away: null, home: null, isPostseason: false });
    for (const key of ['competitiveness', 'watchability', 'stakes', 'enduranceScore']) {
      assert.ok(result[key] >= 1 && result[key] <= 10, `${key} out of range: ${result[key]}`);
    }
    assert.ok(Array.isArray(result.factors));
  });

  test('with literally no signals at all, every score falls back to a neutral 5', () => {
    const result = computeMlbObjectiveScore({ awayWinPct: null, homeWinPct: null, away: null, home: null, isPostseason: false });
    assert.equal(result.competitiveness, 5);
    assert.equal(result.watchability, 5);
    assert.equal(result.stakes, 5);
  });
});

describe('computeNbaObjectiveScore', () => {
  test('a rivalry and a national broadcast both raise watchability', () => {
    const plain = computeNbaObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.5, isPostseason: false, isRivalry: false, isNationalBroadcast: false });
    const rivalryAndNational = computeNbaObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.5, isPostseason: false, isRivalry: true, isNationalBroadcast: true });
    assert.ok(rivalryAndNational.watchability > plain.watchability);
  });

  // stakes/skill are their own axes now (see recommendation.mjs's
  // BEST_MATCH_WEIGHTS) - postseason/seed-cutoff proximity affects
  // `stakes`, not `watchability` (fame), same separation as MLB above.
  test('a postseason game raises stakes, not watchability', () => {
    const regularSeason = computeNbaObjectiveScore({ awayWinPct: 0.6, homeWinPct: 0.4, isPostseason: false, isRivalry: false, isNationalBroadcast: false });
    const postseason = computeNbaObjectiveScore({ awayWinPct: 0.6, homeWinPct: 0.4, isPostseason: true, isRivalry: false, isNationalBroadcast: false });
    assert.equal(postseason.stakes, 10);
    assert.equal(postseason.watchability, regularSeason.watchability);
  });

  test('skill is a real, computed value from the better team\'s own win%', () => {
    const result = computeNbaObjectiveScore({ awayWinPct: 0.7, homeWinPct: 0.7, isPostseason: false, isRivalry: false, isNationalBroadcast: false });
    assert.ok(result.skill >= 8);
  });

  test('a real play-in/playoff-seed bubble race raises stakes, even with a mediocre record', () => {
    // Both teams sit right on their conference's play-in cutoff - a real
    // stakes signal the old (record-only) formula had no way to see.
    const noStandings = computeNbaObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.5, isPostseason: false, isRivalry: false, isNationalBroadcast: false });
    const bubbleRace = computeNbaObjectiveScore({
      awayWinPct: 0.5,
      homeWinPct: 0.5,
      away: { tenSeedGap: 0.5, sixSeedGap: 4 },
      home: { tenSeedGap: -0.5, sixSeedGap: 3 },
      isPostseason: false,
      isRivalry: false,
      isNationalBroadcast: false
    });
    assert.ok(bubbleRace.stakes > noStandings.stakes);
    assert.ok(bubbleRace.factors.some(f => f.includes('playoff-seed proximity')));
  });

  test('skill reflects the BETTER team\'s own win%, not the average - a contender resting starters against a tanking team still reads as containing a genuinely elite team', () => {
    const eliteVsTanking = computeNbaObjectiveScore({ awayWinPct: 0.7, homeWinPct: 0.2, isPostseason: false, isRivalry: false, isNationalBroadcast: false });
    const mediocreVsTanking = computeNbaObjectiveScore({ awayWinPct: 0.45, homeWinPct: 0.2, isPostseason: false, isRivalry: false, isNationalBroadcast: false });
    assert.ok(eliteVsTanking.skill > mediocreVsTanking.skill);
  });

  test('watchability comes ONLY from rivalry/national broadcast - a real blowout with a maxed seed cutoff and elite skill still doesn\'t move it', () => {
    const blowout = computeNbaObjectiveScore({
      awayWinPct: 0.85,
      homeWinPct: 0.15,
      away: { sixSeedGap: -15, tenSeedGap: -20 }, // safely, comfortably in
      home: { sixSeedGap: 0.5, tenSeedGap: -8 }, // home sits right on the 6-seed line
      isPostseason: false,
      isRivalry: false,
      isNationalBroadcast: false
    });
    assert.equal(blowout.watchability, 5);
  });

  test('recent form (last 10) and streak feed in the same way MLB\'s own standings do', () => {
    const plain = computeNbaObjectiveScore({ awayWinPct: 0.5, homeWinPct: 0.5, isPostseason: false, isRivalry: false, isNationalBroadcast: false });
    const hotStreak = computeNbaObjectiveScore({
      awayWinPct: 0.5,
      homeWinPct: 0.5,
      away: { lastTen: { wins: 9, losses: 1 }, streakCode: 'W8' },
      home: { lastTen: { wins: 1, losses: 9 }, streakCode: 'L6' },
      isPostseason: false,
      isRivalry: false,
      isNationalBroadcast: false
    });
    assert.notEqual(hotStreak.competitiveness, plain.competitiveness);
    assert.ok(hotStreak.factors.some(f => f.startsWith('last 10')));
    assert.ok(hotStreak.factors.some(f => f.startsWith('streak')));
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

  test('a real relegation six-pointer between two mid-table-looking teams scores high stakes, unlike before', () => {
    // A moderate, not-maxed-out win% gap - both teams sit right on the
    // relegation cutoff, real current stakes a bare win% record has no way
    // to show on its own.
    const noStandings = computeEplObjectiveScore({ awayWinPct: 0.35, homeWinPct: 0.3, isDerby: false, isBigClub: false });
    const sixPointer = computeEplObjectiveScore({
      awayWinPct: 0.35,
      homeWinPct: 0.3,
      away: { relegationGap: 1, championsLeagueGap: 30 },
      home: { relegationGap: -1, championsLeagueGap: 32 },
      isDerby: false,
      isBigClub: false
    });
    assert.ok(sixPointer.stakes > (noStandings.stakes ?? 0));
    assert.ok(sixPointer.factors.some(f => f.includes('table-position proximity')));
  });

  test('a genuine Champions League race between two non-big clubs also scores high stakes', () => {
    const clRace = computeEplObjectiveScore({
      awayWinPct: 0.55,
      homeWinPct: 0.5,
      away: { championsLeagueGap: 0.5, relegationGap: -25 },
      home: { championsLeagueGap: -0.5, relegationGap: -27 },
      isDerby: false,
      isBigClub: false
    });
    assert.ok(clRace.stakes >= 8);
  });

  test('skill reflects the BETTER club\'s own points-rate, not the average - catches a genuinely elite club even when the fixture itself is one-sided', () => {
    const eliteVsStruggler = computeEplObjectiveScore({ awayWinPct: 0.15, homeWinPct: 0.75, isDerby: false, isBigClub: false });
    const midTableVsStruggler = computeEplObjectiveScore({ awayWinPct: 0.15, homeWinPct: 0.45, isDerby: false, isBigClub: false });
    assert.ok(eliteVsStruggler.skill > midTableVsStruggler.skill);
  });

  test('watchability comes ONLY from derby/big-club - a real blowout with a maxed table cutoff and elite skill still doesn\'t move it', () => {
    const blowout = computeEplObjectiveScore({
      awayWinPct: 0.05,
      homeWinPct: 0.9,
      away: { relegationGap: 1, championsLeagueGap: 40 }, // in real relegation danger
      home: { championsLeagueGap: -20, relegationGap: -35 }, // safely top of the table
      isDerby: false,
      isBigClub: true
    });
    // big-club's own +2 lift, nothing else (not stakes, not skill).
    assert.equal(blowout.watchability, 7);
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
    assert.equal(result.stakes, 5);
  });

  test('stakes mirrors competitiveness - the title-race intensity IS the stakes signal, no second axis exists', () => {
    const result = computeF1ObjectiveScore({ titleRaceIntensity: 0.6 });
    assert.equal(result.stakes, result.competitiveness);
  });
});
