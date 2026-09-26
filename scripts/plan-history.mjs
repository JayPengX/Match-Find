// ---- scripts/plan-history.mjs ----
//
// The server side of the day plan history (app.js's state.dayPlanHistory):
// scripts/build-snapshot.mjs runs this every 5 minutes and publishes the
// result with the snapshot, so every device - a home-screen app with years
// of local storage, a Safari tab wiped by the last update, a new phone -
// locks the same started picks and plans the same past days. Before this,
// the history lived only in each browser, and a wiped one re-planned
// yesterday from scratch and could disagree with one that remembered.
//
// Same engine and same order as app.js: pre-game scores for the variety
// rotation, then each day's plan with the live bonus, forcing whatever
// the recorded plan already has underway (startedPlanLockIds). No viewer
// pins or settings - it's the default plan - and days are in the
// process's own time zone (the snapshot job runs under TZ=Asia/Taipei,
// this site's audience; a viewer elsewhere ignores it - see app.js's
// serverPlanHistory).
import {
  applyLiveExcitementBonus,
  clearRotationIsPreferred,
  computeDayPlan,
  computeVarietyRotation,
  mergeVarietyForcedIds,
  resolveViewingPlan,
  startedPlanLockIds
} from '../public/lib/recommendation.mjs';

// How many days before today are kept - app.js's ROTATION_CONTEXT_PAST_DAYS.
export const PLAN_HISTORY_PAST_DAYS = 5;

export function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// `rawMatches`: the snapshot's own match list. `previousDays`: the last
// published `planHistory.days` ({dayKey: [matchId]}), or null. Returns the
// new {dayKey: [matchId]}.
export function updatePlanHistory(rawMatches, previousDays, now = new Date()) {
  const minDate = new Date(now);
  minDate.setDate(minDate.getDate() - PLAN_HISTORY_PAST_DAYS);
  const minDayKey = localDateKey(minDate);
  const history = new Map(Object.entries(previousDays || {}).filter(([day, ids]) => day >= minDayKey && Array.isArray(ids)));

  const matches = resolveViewingPlan(rawMatches.filter(m => !m.timeTbd), [], new Set());
  const byDay = new Map();
  matches.forEach(match => {
    const day = localDateKey(new Date(match.startTimeUtc));
    if (day < minDayKey) return;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(match);
  });
  // Every calendar day in the range, even an empty one - a gap day has to
  // break a rotation run (see computeVarietyRotation).
  const dayKeys = [...byDay.keys()].sort();
  if (dayKeys.length) {
    for (const d = new Date(`${dayKeys[0]}T12:00:00`); localDateKey(d) <= dayKeys[dayKeys.length - 1]; d.setDate(d.getDate() + 1)) {
      if (!byDay.has(localDateKey(d))) byDay.set(localDateKey(d), []);
    }
  }
  const allDays = [...byDay.keys()].sort();
  const lockedByDay = new Map(allDays.map(day => [day, startedPlanLockIds(history.get(day), byDay.get(day), now.getTime())]));
  const rotation = computeVarietyRotation(
    new Map(
      allDays.map(day => {
        const copies = byDay.get(day).map(m => ({ ...m }));
        applyLiveExcitementBonus(copies, null, { live: false });
        return [day, copies];
      })
    ),
    new Map(),
    lockedByDay
  );

  const next = {};
  allDays.forEach(day => {
    const dayMatches = byDay.get(day);
    if (!dayMatches.length) return;
    applyLiveExcitementBonus(dayMatches);
    const forcedIds = rotation.get(day);
    const plan = computeDayPlan(day, dayMatches, mergeVarietyForcedIds(null, forcedIds), {
      scoreField: 'planningScore',
      lockedIds: lockedByDay.get(day)
    });
    clearRotationIsPreferred(dayMatches, forcedIds, null);
    const ids = plan.map(m => m.id);
    if (ids.length) next[day] = ids;
  });
  // A past day this build no longer has matches for keeps what it had.
  history.forEach((ids, day) => {
    if (!(day in next)) next[day] = ids;
  });
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1)));
}
