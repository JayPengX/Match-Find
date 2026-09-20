// ---- scripts/dump-day-plan.mjs ----
//
// A debugging tool, not part of the build pipeline: runs the EXACT SAME
// recommendation engine (public/lib/recommendation.mjs) a viewer's browser
// runs, against the just-built public/data/matches.json, and prints which
// matches got recommended for a given date range plus WHY every candidate
// that didn't make it was excluded (explainWhyNotRecommended). Exists
// because this repo's own build/deploy pipeline runs on GitHub Actions,
// where the job log is retrievable through the GitHub API even when direct
// network access to the deployed site/ESPN/the build artifact itself is
// blocked - see .github/workflows/deploy.yml's "Debug: dump day plan" step,
// wired to an opt-in workflow_dispatch input specifically so this can be
// triggered on demand to investigate a reported scheduling bug against
// REAL, CURRENT fetched data instead of guessing from code alone.
//
// Respects TZ - the actual recommendation engine's day-bucketing/quiet-hours
// logic (localDateKey in app.js, isQuietHours in recommendation.mjs) is
// deliberately based on the VIEWER's own local wall clock, not UTC, so this
// has to run under the same timezone a real viewer would see to reproduce
// their exact day boundaries and quiet-hours window (see .github/workflows/
// deploy.yml's TZ=Asia/Taipei on this step - this repo's own audience).
//
// Usage: node scripts/dump-day-plan.mjs <fromDateKey> <toDateKey> [sport]
//   fromDateKey/toDateKey: inclusive "YYYY-MM-DD", in whatever TZ this runs
//   under - both optional, defaulting to the whole fetched window.
//   sport: optional exact match.sport value (e.g. "MLB") to narrow the
//   printed listing - the plan itself is still always computed over EVERY
//   sport (unfiltered), matching renderSections' own comment on why the
//   cross-day history/scheduling has to stay independent of a viewer's
//   sport filter.
import { readFile } from 'node:fs/promises';
import { computeWindowPlan, explainWhyNotRecommended, resolveViewingPlan } from '../public/lib/recommendation.mjs';

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const [, , fromArg, toArg, sportArg] = process.argv;

const raw = JSON.parse(await readFile(new URL('../public/data/matches.json', import.meta.url), 'utf8'));
const rawMatches = Array.isArray(raw) ? raw : raw.matches;
// .effectiveScore/.score (bestMatchScore) only exist after resolveViewingPlan
// - the same first step app.js's own applyMatchData runs on every fetch,
// before ANY day-plan scheduling. No sport-priority/owned-service nudges
// (a default, un-customized viewer) since this tool has no way to know a
// real viewer's own local-only preferences.
const matches = resolveViewingPlan(rawMatches, [], new Set());

const matchesByDayKey = new Map();
for (const match of matches) {
  const dayKey = localDateKey(new Date(match.startTimeUtc));
  if (!matchesByDayKey.has(dayKey)) matchesByDayKey.set(dayKey, []);
  matchesByDayKey.get(dayKey).push(match);
}

// computeWindowPlan mutates every match in place (.recommended/
// .alternativeIds/.isPreferred/.planningScore/.recentRepeatPenalty/
// .sportConcentrationPenalty - see its own comment) - the exact same
// side-effecting contract renderSections relies on, which is also why
// explainWhyNotRecommended below can safely read .planningScore straight
// off these same objects afterward.
const windowPlan = computeWindowPlan(matchesByDayKey, new Map());

const dayKeys = [...matchesByDayKey.keys()]
  .sort()
  .filter(key => (!fromArg || key >= fromArg) && (!toArg || key <= toArg));

console.log(`TZ=${process.env.TZ || '(system default)'} now=${new Date().toString()}`);

for (const dayKey of dayKeys) {
  const allDayMatches = matchesByDayKey.get(dayKey) || [];
  const dayMatches = sportArg ? allDayMatches.filter(m => m.sport === sportArg) : allDayMatches;
  if (!dayMatches.length) continue;
  console.log(`\n==== ${dayKey} ====`);
  dayMatches
    .slice()
    .sort((a, b) => Date.parse(a.startTimeUtc) - Date.parse(b.startTimeUtc))
    .forEach(match => {
      const localStart = new Date(match.startTimeUtc).toString();
      console.log(
        `${match.recommended ? '[PICKED]' : '[      ]'} id=${match.id} sport=${match.sport} name="${match.name}" ` +
          `start="${localStart}" durationMinutes=${match.durationMinutes} isFinished=${match.isFinished} ` +
          `skill=${match.skill} competitiveness=${match.competitiveness} watchability=${match.watchability} ` +
          `enduranceScore=${match.enduranceScore} broadcastQuality=${match.broadcastQuality} score=${match.score} planningScore=${round(match.planningScore)} ` +
          `recentRepeatPenalty=${match.recentRepeatPenalty ?? 0} sportConcentrationPenalty=${match.sportConcentrationPenalty ?? 0} ` +
          `alternativeIds=${JSON.stringify(match.alternativeIds || [])} reason="${match.reason || ''}"`
      );
      if (!match.recommended) {
        const explanation = explainWhyNotRecommended(match.id, dayKey, allDayMatches, null, { scoreField: 'planningScore' });
        console.log(`         WHY NOT: ${JSON.stringify(explanation)}`);
      }
    });
}

function round(n) {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n;
}
