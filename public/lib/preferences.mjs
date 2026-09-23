// ---- public/lib/preferences.mjs ----
//
// The viewer's own local "Prefer" state - which member of a multi-match
// slot (see recommendation.mjs's isNearTotalOverlap/groupIntoSlots) they
// explicitly swiped to commit to watching - kept in its own pure, DOM-free
// module so "match data -> recommendation -> user preference -> UI/card
// state" stay four genuinely separate layers instead of collapsing into
// one: recommendation.mjs only ever computes what the ALGORITHM would pick
// on its own; this module only ever computes/stores what the VIEWER chose
// instead; app.js is the only place either one touches the DOM or
// localStorage's actual read/write calls.
//
// Local-only, deliberately: there is no server-side sync for this data (or
// anything else in this app) - see README's "Local-only, no accounts" -
// so every function here is a pure function of its arguments, and app.js
// is the only caller that ever touches localStorage itself (via
// loadPinnedChoices/savePinnedChoices there), same DOM/localStorage
// boundary recommendation.mjs's own top comment already draws.

// Serialized as a plain {dayKey: [matchId, ...]} object (Map/Set don't
// survive JSON.stringify on their own). Each day's value is the flat SET of
// match ids the viewer has explicitly pinned that day - see this module's
// own top comment and applySlotSwipe's comment below for why this is keyed
// by the pinned match's own id rather than by which conflict cluster it
// happened to belong to at pin time.
export function serializePinnedChoices(map) {
  const obj = {};
  map.forEach((matchIds, dayKey) => {
    obj[dayKey] = [...matchIds];
  });
  return obj;
}

// Drops any day already older than `todayKey` (a plain "YYYY-MM-DD" string
// compare works since that format sorts lexicographically the same as
// chronologically) - a pin for a day that's already passed can never be
// looked up again by computeDayPlan either way, so there's nothing to gain
// by keeping it around indefinitely in localStorage. A value saved under
// the old {slotKey: matchId} object shape (before pins were switched to a
// flat matchId set) simply fails the `Array.isArray` check and is dropped -
// a one-time loss of whatever was pinned under the old, fragile scheme,
// never a crash.
export function deserializePinnedChoices(raw, todayKey) {
  const map = new Map();
  if (!raw || typeof raw !== 'object') return map;
  Object.entries(raw).forEach(([dayKey, ids]) => {
    if (dayKey < todayKey || !Array.isArray(ids)) return;
    const set = new Set(ids.filter(id => typeof id === 'string'));
    if (set.size) map.set(dayKey, set);
  });
  return map;
}

// Same pruning deserializePinnedChoices already applies on load, reusable
// against an already-running page's own in-memory map as today's date
// rolls forward - see app.js's prunePinnedChoices. Returns a NEW map (never
// mutates the one passed in, same "pure function of its arguments"
// convention as the rest of this module) plus whether anything actually
// changed, so a caller only re-persists when there's something new to
// write.
export function pruneStalePinnedChoices(pinnedChoices, todayKey) {
  const next = new Map();
  let changed = false;
  pinnedChoices.forEach((slotMap, dayKey) => {
    if (dayKey < todayKey) {
      changed = true;
      return;
    }
    next.set(dayKey, slotMap);
  });
  return { pinnedChoices: next, changed };
}

// The one place "swiping to a card PINS it" actually decides whether that's
// a real override worth remembering as 偏好, or just the viewer swiping
// back to whatever the algorithm would already have picked on its own -
// see recommendation.mjs's naturalSlotChoice for how `naturalMatchId` (the
// algorithm's own unpinned pick for this exact slot) is computed. Swiping
// to the natural pick CLEARS any existing pin for the slot instead of
// setting one, so the card reverts to 推薦 (the algorithm's own judgment)
// rather than staying mislabeled 偏好 forever just because the slot was
// touched at all - this is the direct fix for "swiping back changes
// Recommend into Prefer": without this, every swipe (including swiping
// straight back to the default) recorded a pin, and computeDayPlan has no
// way to tell "a pin that happens to equal the default" apart from "a real
// override", so it always rendered the swiped-to card as isPreferred
// regardless of whether the viewer actually changed anything.
//
// `slotKey` is only ever used here to find which member of THIS cluster
// (if any) is currently pinned, via slotKey.split('|') - the day's own
// stored value is a flat Set<matchId> (see serializePinnedChoices' own
// comment), not a Map keyed by slotKey, specifically because a slotKey is
// only as stable as the exact cluster shape that produced it, and that
// shape can and does change (a live duration correction, a routine data
// refresh, a sport filter narrowing which candidates even exist) - keying
// storage by slotKey directly silently orphaned a real pin the instant its
// cluster's shape shifted even slightly, which read as "reloading the page
// wipes my preference back to 推薦" even though the pin was still sitting
// untouched in localStorage the whole time, just under a key nothing could
// look up again. A match's own id is the one thing about a pin that's
// actually stable across all of that.
//
// Pure - returns a NEW Map (or the SAME map by reference when nothing
// actually needs to change, so a caller can cheaply skip re-persisting),
// never mutates `pinnedChoices`.
export function applySlotSwipe(pinnedChoices, dayKey, slotKey, matchId, naturalMatchId) {
  const clusterMemberIds = new Set(slotKey.split('|'));
  const daySet = pinnedChoices.get(dayKey);
  const currentlyPinnedInCluster = daySet ? [...daySet].find(id => clusterMemberIds.has(id)) : undefined;
  const isNatural = naturalMatchId != null && matchId === naturalMatchId;

  if (isNatural) {
    if (currentlyPinnedInCluster === undefined) return pinnedChoices; // nothing pinned here anyway
    const nextDaySet = new Set(daySet);
    nextDaySet.delete(currentlyPinnedInCluster);
    const next = new Map(pinnedChoices);
    if (nextDaySet.size) next.set(dayKey, nextDaySet);
    else next.delete(dayKey);
    return next;
  }

  if (currentlyPinnedInCluster === matchId) return pinnedChoices; // already pinned to this exact choice
  const nextDaySet = new Set(daySet || []);
  if (currentlyPinnedInCluster !== undefined) nextDaySet.delete(currentlyPinnedInCluster);
  nextDaySet.add(matchId);
  const next = new Map(pinnedChoices);
  next.set(dayKey, nextDaySet);
  return next;
}

// ---- Day plan history (locks what's already started) ------------------------
//
// state.dayPlanHistory (Map<historyKey, string[]>) - the ids of the last
// plan this browser rendered for each day, per sport filter (the 只看 MLB
// plan is its own plan, see app.js's applySportFilter, so it gets its own
// entry instead of leaking its picks into the all-sports one). Read back
// through recommendation.mjs's startedPlanLockIds, which locks whichever of
// these picks have already started into every later plan for that day -
// see that function's own comment for the "a finished game reshuffled the
// whole day" bug this exists for. Kept in localStorage, NOT the match
// snapshot, so an app update (which throws the snapshot away - see
// app.js's APP_BUILD_ID) or a reopen hours later still finds it.
export function dayPlanHistoryKey(dayKey, sport) {
  return `${dayKey}|${sport}`;
}

export function serializeDayPlanHistory(map) {
  return Object.fromEntries(map);
}

// Drops any day older than `minDayKey` (same lexicographic "YYYY-MM-DD"
// compare as deserializePinnedChoices) and anything malformed.
export function deserializeDayPlanHistory(raw, minDayKey) {
  const map = new Map();
  if (!raw || typeof raw !== 'object') return map;
  Object.entries(raw).forEach(([key, ids]) => {
    if (key.split('|')[0] < minDayKey || !Array.isArray(ids)) return;
    const clean = ids.filter(id => typeof id === 'string');
    if (clean.length) map.set(key, clean);
  });
  return map;
}

// Pure - returns the SAME map by reference when nothing changed (so a
// caller can cheaply skip re-persisting on every routine re-render), else a
// new one with this key's ids replaced and anything older than `minDayKey`
// dropped.
export function recordDayPlan(history, key, ids, minDayKey) {
  const previous = history.get(key);
  const stale = [...history.keys()].some(k => k.split('|')[0] < minDayKey);
  if (!stale && previous && previous.length === ids.length && previous.every((id, i) => id === ids[i])) return history;
  const next = new Map([...history].filter(([k]) => k.split('|')[0] >= minDayKey));
  if (ids.length) next.set(key, [...ids]);
  else next.delete(key);
  return next;
}
