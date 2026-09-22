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
//   sport (unfiltered), matching app.js's own dayCandidatesForPlan/
//   applySportFilter split (the scheduler always sees every enabled sport;
//   only the rendered/printed list is ever narrowed by a sport filter).
import { readFile } from 'node:fs/promises';
import {
  applyLiveExcitementBonus,
  applyVarietyPenalty,
  computeDayPlan,
  explainWhyNotRecommended,
  matchupKey,
  resolveViewingPlan,
  VARIETY_MAX_FREE_REPEATS
} from '../public/lib/recommendation.mjs';

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

// computeDayPlan mutates every match in place (.recommended/
// .alternativeIds/.isPreferred - see its own comment) - the exact same
// side-effecting contract renderSections relies on, which is also why
// explainWhyNotRecommended below can safely read .planningScore straight
// off these same objects afterward. applyLiveExcitementBonus (also
// in-place) has to run first, per day, since that's what actually sets
// .planningScore. Processed in chronological order (not Map insertion
// order) and tracking each day's own recommended matchupKeys as we go, so
// applyVarietyPenalty sees the exact same real-two-preceding-days context
// app.js's own recentMatchupKeySets does - see that function's own comment
// in recommendation.mjs (Round 41).
const allDayKeysSorted = [...matchesByDayKey.keys()].sort();
const matchupKeysByDay = new Map();
for (const dayKey of allDayKeysSorted) {
  const dayMatches = matchesByDayKey.get(dayKey);
  applyLiveExcitementBonus(dayMatches);
  const recentSets = [];
  for (let back = 1; back <= VARIETY_MAX_FREE_REPEATS; back++) {
    const priorKeys = matchupKeysByDay.get(allDayKeysSorted[allDayKeysSorted.indexOf(dayKey) - back]);
    if (!priorKeys) break;
    recentSets.push(priorKeys);
  }
  applyVarietyPenalty(dayMatches, recentSets);
  computeDayPlan(dayKey, dayMatches, null, { scoreField: 'planningScore' });
  matchupKeysByDay.set(dayKey, new Set(dayMatches.filter(m => m.recommended).map(matchupKey)));
}

const dayKeys = allDayKeysSorted.filter(key => (!fromArg || key >= fromArg) && (!toArg || key <= toArg));

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
