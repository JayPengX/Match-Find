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

// Serialized as a plain {dayKey: {slotKey: matchId}} object (Map doesn't
// survive JSON.stringify on its own).
export function serializePinnedChoices(map) {
  const obj = {};
  map.forEach((slotMap, dayKey) => {
    obj[dayKey] = Object.fromEntries(slotMap);
  });
  return obj;
}

// Drops any day already older than `todayKey` (a plain "YYYY-MM-DD" string
// compare works since that format sorts lexicographically the same as
// chronologically) - a pin for a day that's already passed can never be
// looked up again by computeDayPlan either way, so there's nothing to gain
// by keeping it around indefinitely in localStorage.
export function deserializePinnedChoices(raw, todayKey) {
  const map = new Map();
  if (!raw || typeof raw !== 'object') return map;
  Object.entries(raw).forEach(([dayKey, bySlot]) => {
    if (dayKey < todayKey || !bySlot || typeof bySlot !== 'object') return;
    const slotMap = new Map(Object.entries(bySlot).filter(([, matchId]) => typeof matchId === 'string'));
    if (slotMap.size) map.set(dayKey, slotMap);
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
// Pure - returns a NEW Map (or the SAME map by reference when nothing
// actually needs to change, so a caller can cheaply skip re-persisting),
// never mutates `pinnedChoices`.
export function applySlotSwipe(pinnedChoices, dayKey, slotKey, matchId, naturalMatchId) {
  const daySlots = pinnedChoices.get(dayKey);
  const isNatural = naturalMatchId != null && matchId === naturalMatchId;

  if (isNatural) {
    if (!daySlots || !daySlots.has(slotKey)) return pinnedChoices; // nothing pinned here anyway
    const nextDaySlots = new Map(daySlots);
    nextDaySlots.delete(slotKey);
    const next = new Map(pinnedChoices);
    if (nextDaySlots.size) next.set(dayKey, nextDaySlots);
    else next.delete(dayKey);
    return next;
  }

  if (daySlots && daySlots.get(slotKey) === matchId) return pinnedChoices; // already pinned to this exact choice
  const nextDaySlots = new Map(daySlots || []);
  nextDaySlots.set(slotKey, matchId);
  const next = new Map(pinnedChoices);
  next.set(dayKey, nextDaySlots);
  return next;
}
