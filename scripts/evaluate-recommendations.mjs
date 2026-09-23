// ---- scripts/evaluate-recommendations.mjs ----
//
// Offline evaluator for one or more matches.json snapshots (see
// scripts/build-data.mjs) - the {matches: [...]} shape with every match's
// .score/.confidence already decided.
//
// Deliberately NOT a pass/fail grader - this codebase has no ground-truth
// "was this actually a good recommendation" label (see docs/
// recommendation-engine-audit.md's "known limitations": there's no user
// click/watch-behavior signal anywhere in this pipeline). What this script
// reports instead is descriptive: how many matches were recommended, how
// concentrated the picks are by sport, how confident the underlying scores
// are, and how often the SAME two teams keep coming back as separate
// picks on different dates (a real pattern worth knowing about, not
// something this script decides is a bug - see summarize()'s own comment).
//
// Usage:
//   node scripts/evaluate-recommendations.mjs <export.json> [export2.json ...]
//
// Multiple files are accumulated into one combined report - the whole
// point of "don't blindly optimize against one day's output" (see
// docs/recommendation-engine-audit.md) is being able to point this at a
// week's worth of separately-exported snapshots at once.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { computeConfidence, matchupKey, schedulingInterval, isQuietHours } from '../public/lib/recommendation.mjs';

// Accepts either `{matches: [...]}` (matches.json's own
// shape) or a bare `[...]` array, so this also works against an ad hoc
// slice of matches someone hand-edited for a test case.
export function extractMatches(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.matches)) return parsed.matches;
  return [];
}

export async function loadExport(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return extractMatches(JSON.parse(raw));
}

// NOTE: this groups by UTC calendar date, not the viewer's own local date
// the live app actually bucketed by (public/app.js's localDateKey) - an
// export carries no per-viewer timezone metadata to recover that from. A
// match within a few hours of UTC midnight can therefore land in a
// different "day" here than the plan it was actually scheduled into,
// which can show up as a small, spurious gap in the planner-oracle ratio
// below - a known imprecision in a diagnostic/descriptive tool, not a
// claim of exactness (see this file's own top comment). Already true of
// the existing recurring-matchup grouping this function has always fed.
function localDateKeyFromUtc(startTimeUtc) {
  const d = new Date(startTimeUtc);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function round(n, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function distribution(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return { count: 0, min: null, max: null, avg: null };
  const sum = nums.reduce((a, b) => a + b, 0);
  return { count: nums.length, min: round(Math.min(...nums)), max: round(Math.max(...nums)), avg: round(sum / nums.length) };
}

// The one metric this script computes that build-data.mjs/app.js don't -
// everything else here just tallies fields the pipeline already produces.
// Confidence falls back to computeConfidence(match) when a match predates
// this field being baked into matches.json (see build-data.mjs), so an
// older export doesn't just show up as "unknown" across the board.
function resolveConfidence(match) {
  return Number.isFinite(match.confidence) ? match.confidence : computeConfidence(match);
}

// ---- Planner oracle (docs/recommendation-engine-audit.md section 34) ------
//
// "The evaluator cannot currently measure whether the planner actually
// produced a good schedule" - counting how many matches were recommended
// says nothing about whether that was the BEST possible schedule from the
// same candidates. This independently re-derives the mathematically
// optimal weighted-interval schedule for each day and compares its total
// value against what was actually recommended, reporting an
// actual/oracle ratio.
//
// oracleWeightedSchedule is a deliberately SEPARATE, from-scratch DP, not
// a re-import of recommendation.mjs's own weightedIntervalSchedule/
// computeDayPlan - the whole point is independent verification. Re-running
// the exact same function against its own prior output would trivially
// report 100% even if that function had a real bug, since it would be the
// same bug on both sides of the comparison. schedulingInterval/
// isQuietHours ARE reused from recommendation.mjs, but those only compute
// per-match TIMING facts (duration uncertainty, quiet hours), not
// scheduling DECISIONS - reusing them tests this oracle against the same
// ground truth the production planner sees, without re-testing the
// decision algorithm itself.
function oracleWeightedSchedule(items, getScore) {
  const sorted = items.slice().sort((a, b) => a.interval.end - b.interval.end);
  const dp = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    let prevScore = 0;
    let prevPicks = [];
    for (let j = i - 1; j >= 0; j--) {
      if (sorted[j].interval.end <= cur.interval.start) {
        prevScore = dp[j].score;
        prevPicks = dp[j].picks;
        break;
      }
    }
    const withCur = { score: prevScore + getScore(cur.match), picks: [...prevPicks, cur.match] };
    const without = i > 0 ? dp[i - 1] : { score: 0, picks: [] };
    dp[i] = withCur.score >= without.score ? withCur : without;
  }
  return sorted.length ? dp[sorted.length - 1] : { score: 0, picks: [] };
}

// A match's own scheduling weight, matching whichever score
// computeDayPlan was actually run with (planningScore once
// applyLiveExcitementBonus has set it, effectiveScore otherwise - see that
// function's own `scoreField` option) - the oracle has to compare against the SAME
// objective the production planner was optimizing, or a mismatch would
// just mean "these two used different weights", not "the scheduler is
// suboptimal".
function schedulingWeight(match) {
  if (Number.isFinite(match.planningScore)) return match.planningScore;
  if (Number.isFinite(match.effectiveScore)) return match.effectiveScore;
  return 0;
}

// Re-derives each day's optimal schedule from the same candidates
// computeDayPlan would have seen (not finished, not quiet-hours - see that
// function's own candidate filter) and compares it against what the
// export says was actually recommended. A pinned pick (isPreferred, see
// public/app.js's buildMatchCard) is honored as a hard constraint here
// too, exactly as computeDayPlan honors it - pins are a deliberate user
// override, not a scheduler decision, so the oracle isn't "more optimal"
// for ignoring one.
export function computePlannerOracle(matches) {
  const byDay = new Map();
  for (const match of matches) {
    if (match.isFinished || isQuietHours(match)) continue;
    const dayKey = localDateKeyFromUtc(match.startTimeUtc);
    if (!dayKey) continue;
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(match);
  }

  const days = [];
  for (const [dayKey, dayMatches] of byDay) {
    const items = dayMatches.map(match => ({ interval: schedulingInterval(match), match }));
    const forced = items.filter(item => item.match.isPreferred).sort((a, b) => a.interval.start - b.interval.start);
    const free = items.filter(item => !item.match.isPreferred);

    let oracleScore = 0;
    const oraclePicks = [];
    let cursor = -Infinity;
    forced.forEach(f => {
      const gap = oracleWeightedSchedule(
        free.filter(item => item.interval.start >= cursor && item.interval.end <= f.interval.start),
        schedulingWeight
      );
      oracleScore += gap.score;
      oraclePicks.push(...gap.picks);
      oracleScore += schedulingWeight(f.match);
      oraclePicks.push(f.match);
      cursor = f.interval.end;
    });
    const tail = oracleWeightedSchedule(free.filter(item => item.interval.start >= cursor), schedulingWeight);
    oracleScore += tail.score;
    oraclePicks.push(...tail.picks);

    const actualPicks = dayMatches.filter(m => m.recommended);
    const actualScore = actualPicks.reduce((sum, m) => sum + schedulingWeight(m), 0);

    days.push({
      dayKey,
      candidateCount: dayMatches.length,
      hadPin: forced.length > 0,
      actualCount: actualPicks.length,
      oracleCount: oraclePicks.length,
      actualValue: round(actualScore),
      oracleValue: round(oracleScore),
      ratio: oracleScore > 0 ? round(actualScore / oracleScore) : actualScore === 0 ? 1 : null
    });
  }
  days.sort((a, b) => a.dayKey.localeCompare(b.dayKey));

  const totalActualValue = days.reduce((sum, d) => sum + d.actualValue, 0);
  const totalOracleValue = days.reduce((sum, d) => sum + d.oracleValue, 0);
  const mismatches = days.filter(d => d.ratio !== null && d.ratio < 0.999);
  return {
    dayCount: days.length,
    totalActualValue: round(totalActualValue),
    totalOracleValue: round(totalOracleValue),
    overallRatio: totalOracleValue > 0 ? round(totalActualValue / totalOracleValue) : null,
    daysBelowOptimal: mismatches.length,
    worstDays: mismatches.sort((a, b) => a.ratio - b.ratio).slice(0, 5),
    days
  };
}

// ---- Score-dimension correlation (docs/recommendation-engine-audit.md
// section 24) ----------------------------------------------------------
//
// "There is a risk that several dimensions measure overlapping concepts
// ... If two dimensions are nearly identical, simplify." Computed PER
// SPORT (the audit's own instruction - a correlation that holds for MLB
// says nothing about F1) from whichever finished-scoring matches an
// export actually has all four dimensions for.
const SCORE_DIMENSION_PAIRS = [
  ['competitiveness', 'watchability'],
  ['competitiveness', 'enduranceScore'],
  ['watchability', 'enduranceScore'],
  ['broadcastQuality', 'watchability']
];
// Below this, a correlation coefficient is noise, not signal - two or
// three matches can trivially "correlate" perfectly by chance.
const MIN_SAMPLE_SIZE_FOR_CORRELATION = 5;
// Pearson's r at or above this is close enough to call the two dimensions
// redundant candidates for consolidation, per the audit's own framing -
// not proof on its own, but a concrete threshold worth flagging rather
// than making a human eyeball every number.
const HIGH_CORRELATION_THRESHOLD = 0.8;

function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  if (denomX === 0 || denomY === 0) return null; // one dimension had zero variance - "correlation" is undefined, not 0
  return numerator / Math.sqrt(denomX * denomY);
}

export function computeDimensionCorrelations(matches) {
  const bySport = new Map();
  for (const match of matches) {
    if (match.isFinished) continue; // a finished match's dimensions are all null (see build-data.mjs)
    const dims = [match.competitiveness, match.watchability, match.enduranceScore, match.broadcastQuality];
    if (!dims.every(Number.isFinite)) continue;
    if (!bySport.has(match.sport)) bySport.set(match.sport, []);
    bySport.get(match.sport).push(match);
  }

  const bySportResult = {};
  for (const [sport, list] of bySport) {
    if (list.length < MIN_SAMPLE_SIZE_FOR_CORRELATION) continue;
    const pairs = {};
    const highlyCorrelated = [];
    for (const [a, b] of SCORE_DIMENSION_PAIRS) {
      const r = pearsonCorrelation(
        list.map(m => m[a]),
        list.map(m => m[b])
      );
      pairs[`${a}<->${b}`] = r === null ? null : round(r);
      if (r !== null && Math.abs(r) >= HIGH_CORRELATION_THRESHOLD) highlyCorrelated.push(`${a}<->${b}`);
    }
    bySportResult[sport] = { sampleSize: list.length, pairs, highlyCorrelated };
  }
  return bySportResult;
}

// Builds the full report from a flat list of matches pulled from one or
// more exports (see loadExport). Every metric here is purely descriptive -
// see this file's own top comment for why "recurring matchup" is reported
// as a rate, not flagged as a defect: a real 4-game series SHOULD show up
// as recommended on each of its 4 dates in a day-by-day viewing plan (see
// computeDayPlan) - that's 4 distinct real events, not one duplicated.
// What this number is actually useful for is noticing when a pipeline
// change (e.g. a new diversity policy) shifts that rate, or when it's
// unexpectedly high for a sport that DOESN'T have multi-game series.
export function summarize(matches) {
  const upcoming = matches.filter(m => !m.isFinished);
  const recommended = matches.filter(m => m.recommended);

  const bySport = {};
  for (const match of recommended) {
    bySport[match.sport] = (bySport[match.sport] || 0) + 1;
  }
  const sportConcentration = Object.fromEntries(
    Object.entries(bySport)
      .sort((a, b) => b[1] - a[1])
      .map(([sport, count]) => [sport, { count, share: round(count / Math.max(1, recommended.length)) }])
  );

  // matchupKey -> Set of distinct local calendar dates it was recommended on.
  const datesByMatchup = new Map();
  for (const match of recommended) {
    const key = matchupKey(match);
    const dateKey = localDateKeyFromUtc(match.startTimeUtc);
    if (!datesByMatchup.has(key)) datesByMatchup.set(key, new Set());
    if (dateKey) datesByMatchup.get(key).add(dateKey);
  }
  const recurringMatchups = [...datesByMatchup.entries()]
    .filter(([, dates]) => dates.size > 1)
    .map(([key, dates]) => ({ matchup: key, recommendedOnDistinctDays: dates.size }))
    .sort((a, b) => b.recommendedOnDistinctDays - a.recommendedOnDistinctDays);
  const matchupsRecommendedAtAll = datesByMatchup.size;

  const confidences = recommended.map(resolveConfidence);
  const confidenceTiers = { high: 0, medium: 0, low: 0, unknown: 0 };
  for (const c of confidences) {
    if (!Number.isFinite(c)) confidenceTiers.unknown++;
    else if (c >= 0.8) confidenceTiers.high++;
    else if (c >= 0.5) confidenceTiers.medium++;
    else confidenceTiers.low++;
  }

  return {
    totalMatches: matches.length,
    upcomingOrLiveMatches: upcoming.length,
    finishedMatches: matches.length - upcoming.length,
    recommendedCount: recommended.length,
    recommendedRate: round(recommended.length / Math.max(1, upcoming.length)),
    sportConcentration,
    recurringMatchups: {
      distinctMatchupsRecommended: matchupsRecommendedAtAll,
      matchupsRecommendedOnMultipleDays: recurringMatchups.length,
      rate: round(recurringMatchups.length / Math.max(1, matchupsRecommendedAtAll)),
      topRecurring: recurringMatchups.slice(0, 10)
    },
    scoreDistribution: {
      recommended: distribution(recommended.map(m => m.score)),
      allUpcoming: distribution(upcoming.map(m => m.score))
    },
    effectiveScoreDistribution: distribution(recommended.map(m => m.effectiveScore)),
    confidenceDistribution: { ...distribution(confidences), tiers: confidenceTiers },
    plannerOracle: computePlannerOracle(matches),
    dimensionCorrelations: computeDimensionCorrelations(matches)
  };
}

export function formatReport(report) {
  const lines = [];
  lines.push(`Total matches:        ${report.totalMatches} (${report.upcomingOrLiveMatches} upcoming/live, ${report.finishedMatches} finished)`);
  lines.push(`Recommended:          ${report.recommendedCount} (${(report.recommendedRate * 100).toFixed(1)}% of upcoming/live)`);
  lines.push('');
  lines.push('Sport concentration (share of recommended slots):');
  for (const [sport, { count, share }] of Object.entries(report.sportConcentration)) {
    lines.push(`  ${sport.padEnd(16)} ${String(count).padStart(4)}  (${(share * 100).toFixed(1)}%)`);
  }
  lines.push('');
  lines.push('Recurring matchups (same two teams/session recommended on 2+ distinct dates in this export):');
  lines.push(
    `  ${report.recurringMatchups.matchupsRecommendedOnMultipleDays} of ${report.recurringMatchups.distinctMatchupsRecommended} distinct matchups (${(report.recurringMatchups.rate * 100).toFixed(1)}%) - expected for multi-game series in a day-by-day plan, see this script's own top comment`
  );
  for (const { matchup, recommendedOnDistinctDays } of report.recurringMatchups.topRecurring) {
    lines.push(`    ${String(recommendedOnDistinctDays).padStart(2)}x  ${matchup}`);
  }
  lines.push('');
  const sd = report.scoreDistribution.recommended;
  lines.push(`Score distribution (recommended):     avg ${sd.avg ?? 'n/a'}  min ${sd.min ?? 'n/a'}  max ${sd.max ?? 'n/a'}  (n=${sd.count})`);
  const esd = report.effectiveScoreDistribution;
  lines.push(`effectiveScore distribution (recommended): avg ${esd.avg ?? 'n/a'}  min ${esd.min ?? 'n/a'}  max ${esd.max ?? 'n/a'}`);
  lines.push('');
  const cd = report.confidenceDistribution;
  lines.push(`Confidence distribution (recommended): avg ${cd.avg ?? 'n/a'}  (n=${cd.count})`);
  lines.push(`  high (>=0.8): ${cd.tiers.high}   medium (0.5-0.8): ${cd.tiers.medium}   low (<0.5): ${cd.tiers.low}   unknown: ${cd.tiers.unknown}`);
  lines.push('');
  const po = report.plannerOracle;
  lines.push(`Planner oracle (independently re-derived optimal schedule vs. what was actually recommended):`);
  lines.push(
    `  ${po.dayCount} day(s) evaluated, overall value ratio: ${po.overallRatio === null ? 'n/a (no candidates)' : (po.overallRatio * 100).toFixed(1) + '%'} (actual ${po.totalActualValue} / oracle ${po.totalOracleValue})`
  );
  if (po.daysBelowOptimal) {
    lines.push(`  ${po.daysBelowOptimal} day(s) below optimal - worst:`);
    for (const d of po.worstDays) {
      lines.push(
        `    ${d.dayKey}: ${(d.ratio * 100).toFixed(1)}%  (actual ${d.actualValue} / oracle ${d.oracleValue}, ${d.candidateCount} candidates${d.hadPin ? ', pinned' : ''})`
      );
    }
  } else {
    lines.push('  Every day matched its own independently-computed optimum.');
  }
  lines.push('');
  lines.push('Score-dimension correlation by sport (|r| >= 0.8 flagged as a possible redundant dimension):');
  const dc = report.dimensionCorrelations;
  if (!Object.keys(dc).length) {
    lines.push('  Not enough same-sport data with every dimension present to compute this.');
  }
  for (const [sport, { sampleSize, pairs, highlyCorrelated }] of Object.entries(dc)) {
    lines.push(`  ${sport} (n=${sampleSize}):`);
    for (const [pair, r] of Object.entries(pairs)) {
      const flag = highlyCorrelated.includes(pair) ? '  <- highly correlated' : '';
      lines.push(`    ${pair.padEnd(32)} r=${r === null ? 'n/a' : r.toFixed(3)}${flag}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Usage: node scripts/evaluate-recommendations.mjs <export.json> [export2.json ...]');
    process.exit(1);
  }
  const allMatches = [];
  for (const file of files) {
    try {
      allMatches.push(...(await loadExport(file)));
    } catch (error) {
      console.error(`Failed to read ${file}: ${error.message}`);
      process.exit(1);
    }
  }
  const report = summarize(allMatches);
  console.log(`Evaluated ${files.length} export(s), ${allMatches.length} total match record(s).\n`);
  console.log(formatReport(report));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
