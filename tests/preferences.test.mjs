// Tests for public/lib/preferences.mjs - the viewer's own local "Prefer"
// state (see that module's own top comment for why it's kept separate from
// both recommendation.mjs and app.js). Run with `npm test` (node --test
// tests/).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializePinnedChoices,
  deserializePinnedChoices,
  pruneStalePinnedChoices,
  applySlotSwipe,
  dayPlanHistoryKey,
  serializeDayPlanHistory,
  deserializeDayPlanHistory,
  recordDayPlan
} from '../public/lib/preferences.mjs';

// Pins are stored as a flat Set<matchId> per day, keyed by the PINNED
// MATCH'S OWN id - never by a hash of whichever conflict cluster it
// happened to belong to at pin time (see applySlotSwipe's own comment for
// why: a cluster's shape can drift between renders in a way a match's own
// id never does). `slotKey` is always `slotKeyFromMembers(cluster.members)`
// - every member's own id, sorted and joined with '|' - so a two-member
// slot's key looks like 'match-a|match-b' in these tests, matching exactly
// what recommendation.mjs's computeDayPlan/naturalSlotChoice would produce.

describe('serializePinnedChoices / deserializePinnedChoices (local persistence round-trip)', () => {
  test('Prefer -> save -> reload -> still Prefer', () => {
    // Simulates the exact scenario the task asks for: swiping to pin a
    // genuine alternative, persisting it (serialize, as savePinnedChoices
    // would write to localStorage), then "reloading" (deserialize, as
    // loadPinnedChoices would read back) - the pin must survive intact.
    const pinned = new Map([['2026-09-23', new Set(['match-b'])]]);
    const raw = JSON.parse(JSON.stringify(serializePinnedChoices(pinned)));
    const reloaded = deserializePinnedChoices(raw, '2026-09-20');
    assert.equal(reloaded.get('2026-09-23')?.has('match-b'), true);
  });

  test('un-Prefer -> save -> reload -> still un-Preferred', () => {
    // "Un-Prefer" is applySlotSwipe clearing a pin (see its own tests below)
    // - once cleared, serializing/reloading must never resurrect it.
    const pinned = new Map([['2026-09-23', new Set(['match-b'])]]);
    const cleared = applySlotSwipe(pinned, '2026-09-23', 'match-a|match-b', 'match-a', 'match-a');
    const raw = JSON.parse(JSON.stringify(serializePinnedChoices(cleared)));
    const reloaded = deserializePinnedChoices(raw, '2026-09-20');
    assert.equal(reloaded.has('2026-09-23'), false);
  });

  test('deserializePinnedChoices drops a day already older than todayKey', () => {
    const raw = { '2026-09-18': ['match-b'], '2026-09-21': ['match-c'] };
    const reloaded = deserializePinnedChoices(raw, '2026-09-20');
    assert.equal(reloaded.has('2026-09-18'), false);
    assert.equal(reloaded.get('2026-09-21')?.has('match-c'), true);
  });

  test('deserializePinnedChoices tolerates malformed/foreign input rather than throwing', () => {
    assert.deepEqual([...deserializePinnedChoices(null, '2026-09-20').entries()], []);
    assert.deepEqual([...deserializePinnedChoices('not an object', '2026-09-20').entries()], []);
    // A day's value has to be an array (the new flat matchId-set shape) -
    // the OLD {slotKey: matchId} object shape (before this fix) is simply
    // dropped, never crashes.
    assert.deepEqual(
      [...deserializePinnedChoices({ '2026-09-21': { a: 42 } }, '2026-09-20').entries()],
      []
    );
    // Non-string entries inside the array are dropped, leaving an empty day dropped too.
    assert.deepEqual(
      [...deserializePinnedChoices({ '2026-09-21': [42, null] }, '2026-09-20').entries()],
      []
    );
  });
});

describe('pruneStalePinnedChoices', () => {
  test('drops only days strictly before todayKey, returns a NEW map, flags changed', () => {
    const pinned = new Map([
      ['2026-09-19', new Set(['m1'])],
      ['2026-09-20', new Set(['m2'])],
      ['2026-09-21', new Set(['m3'])]
    ]);
    const { pinnedChoices, changed } = pruneStalePinnedChoices(pinned, '2026-09-20');
    assert.equal(changed, true);
    assert.equal(pinnedChoices.has('2026-09-19'), false);
    assert.equal(pinnedChoices.has('2026-09-20'), true);
    assert.equal(pinnedChoices.has('2026-09-21'), true);
    // Original map never mutated - pure function of its arguments.
    assert.equal(pinned.has('2026-09-19'), true);
  });

  test('reports changed: false and returns an equivalent map when nothing is stale', () => {
    const pinned = new Map([['2026-09-21', new Set(['m3'])]]);
    const { pinnedChoices, changed } = pruneStalePinnedChoices(pinned, '2026-09-20');
    assert.equal(changed, false);
    assert.equal(pinnedChoices.get('2026-09-21')?.has('m3'), true);
  });
});

describe('applySlotSwipe (the Recommend/Prefer swipe-semantics fix)', () => {
  test('swiping to a genuine alternative (not the natural default) sets a pin - 偏好', () => {
    const pinned = new Map();
    const next = applySlotSwipe(pinned, '2026-09-23', 'match-a|match-b', 'match-b', 'match-a');
    assert.equal(next.get('2026-09-23')?.has('match-b'), true);
  });

  test('swiping to the natural default clears any existing pin instead of setting one - reverts to 推薦', () => {
    // This is the direct regression test for "swiping back changes
    // Recommend into Prefer": naturalMatchId === matchId means the viewer
    // swiped straight back to whatever the algorithm would already have
    // picked - that must clear the pin, not record one.
    const pinned = new Map([['2026-09-23', new Set(['match-b'])]]);
    const next = applySlotSwipe(pinned, '2026-09-23', 'match-a|match-b', 'match-a', 'match-a');
    assert.equal(next.has('2026-09-23'), false);
  });

  test('swiping to the natural default when nothing was pinned is a true no-op (same reference back)', () => {
    const pinned = new Map();
    const next = applySlotSwipe(pinned, '2026-09-23', 'match-a|match-b', 'match-a', 'match-a');
    assert.equal(next, pinned); // no unnecessary re-persist/re-render
  });

  test('swiping to the SAME already-pinned choice again is a true no-op (same reference back)', () => {
    const pinned = new Map([['2026-09-23', new Set(['match-b'])]]);
    const next = applySlotSwipe(pinned, '2026-09-23', 'match-a|match-b', 'match-b', 'match-a');
    assert.equal(next, pinned);
  });

  test('clearing the only pin on a day removes the whole day entry, not just the match', () => {
    const pinned = new Map([['2026-09-23', new Set(['match-b'])]]);
    const next = applySlotSwipe(pinned, '2026-09-23', 'match-a|match-b', 'match-a', 'match-a');
    assert.equal(next.has('2026-09-23'), false);
  });

  test('clearing one slot on a day with other pinned slots keeps the other pins intact', () => {
    const pinned = new Map([['2026-09-23', new Set(['match-b', 'match-y'])]]);
    const next = applySlotSwipe(pinned, '2026-09-23', 'match-a|match-b', 'match-a', 'match-a');
    assert.equal(next.get('2026-09-23')?.has('match-b'), false);
    assert.equal(next.get('2026-09-23')?.has('match-y'), true);
  });

  test('never mutates the map passed in - pure function of its arguments', () => {
    const pinned = new Map([['2026-09-23', new Set(['match-b'])]]);
    applySlotSwipe(pinned, '2026-09-23', 'match-a|match-b|match-c', 'match-c', 'match-a');
    assert.equal(pinned.get('2026-09-23')?.has('match-b'), true); // untouched
    assert.equal(pinned.get('2026-09-23')?.has('match-c'), false);
  });

  test('a null naturalMatchId (no natural pick could be determined) never auto-clears - any explicit swipe still pins', () => {
    const pinned = new Map();
    const next = applySlotSwipe(pinned, '2026-09-23', 'match-a|match-b', 'match-b', null);
    assert.equal(next.get('2026-09-23')?.has('match-b'), true);
  });

  test('a pin survives even if the slotKey looked up later names a DIFFERENT (shifted) cluster, as long as the match id is still a member', () => {
    // The direct regression test for "reloading the page wipes my
    // preference back to 推薦": the cluster a match belongs to can change
    // shape between renders (a live duration correction, a data refresh, a
    // sport filter), but the pinned match's own id never does - so looking
    // it up under a DIFFERENT, larger slotKey that still contains it must
    // still find it.
    const pinned = new Map([['2026-09-23', new Set(['match-b'])]]);
    const next = applySlotSwipe(pinned, '2026-09-23', 'match-a|match-b|match-d', 'match-a', 'match-a');
    // Swiping back to the natural default (match-a) should clear the
    // existing pin (match-b) even though it was originally set under a
    // smaller two-member slotKey - it's still found via the match id itself.
    assert.equal(next.has('2026-09-23'), false);
  });
});

describe('day plan history', () => {
  test('round-trips through JSON, dropping days before the oldest kept day and malformed entries', () => {
    const history = new Map([
      [dayPlanHistoryKey('2026-09-18', 'all'), ['old']],
      [dayPlanHistoryKey('2026-09-19', 'all'), ['a', 'b']],
      [dayPlanHistoryKey('2026-09-19', 'MLB'), ['m']]
    ]);
    const raw = JSON.parse(JSON.stringify(serializeDayPlanHistory(history)));
    raw['2026-09-20|all'] = 'not-an-array';
    const loaded = deserializeDayPlanHistory(raw, '2026-09-19');
    assert.deepEqual([...loaded.keys()].sort(), ['2026-09-19|MLB', '2026-09-19|all']);
    assert.deepEqual(loaded.get('2026-09-19|all'), ['a', 'b']);
    assert.equal(deserializeDayPlanHistory(null, '2026-09-19').size, 0);
  });

  test('recordDayPlan returns the same map when nothing changed, a new one otherwise', () => {
    const history = new Map([['2026-09-19|all', ['a', 'b']]]);
    assert.equal(recordDayPlan(history, '2026-09-19|all', ['a', 'b'], '2026-09-19'), history);
    const next = recordDayPlan(history, '2026-09-19|all', ['a', 'c'], '2026-09-19');
    assert.notEqual(next, history);
    assert.deepEqual(next.get('2026-09-19|all'), ['a', 'c']);
    assert.deepEqual(history.get('2026-09-19|all'), ['a', 'b']); // never mutated
  });

  test('recordDayPlan prunes days that have aged out', () => {
    const history = new Map([['2026-09-17|all', ['x']], ['2026-09-19|all', ['a']]]);
    const next = recordDayPlan(history, '2026-09-19|all', ['a'], '2026-09-18');
    assert.deepEqual([...next.keys()], ['2026-09-19|all']);
  });
});
