// ---- scripts/evaluate-recommendations.mjs ----
//
// Offline evaluator for one or more historical recommendation exports -
// either public/data/matches.json itself, or the Settings panel's own
// "匯出資料" (exportRecommendationData in public/app.js) download, which is
// the same {matches: [...]} shape with every match's .recommended/.score/
// .effectiveScore/.confidence already decided.
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
import { computeConfidence } from '../public/lib/recommendation.mjs';

// Accepts either `{matches: [...]}` (matches.json/the export button's own
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

// A team-league match's two competitors, order-independent (so "A @ B" and
// "B @ A" - a return leg, or just a different export's own [away, home]
// ordering - count as the same matchup) - an F1 session has no
// `competitors` at all (see build-data.mjs's fetchF1Matches), so it falls
// back to its own name (which already includes the session suffix -
// "...Qualifying" vs "...Sprint" - so qualifying and the race itself are
// correctly two different keys, never folded together as "the same event
// recommended twice").
export function matchupKey(match) {
  if (Array.isArray(match.competitors) && match.competitors.length === 2) {
    const names = match.competitors.map(c => c.name || c.abbreviation || '?').sort();
    return `${match.sport}: ${names.join(' vs ')}`;
  }
  return `${match.sport}: ${match.name || match.id}`;
}

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
    confidenceDistribution: { ...distribution(confidences), tiers: confidenceTiers }
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
