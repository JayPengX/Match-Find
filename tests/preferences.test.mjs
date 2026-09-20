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
  applySlotSwipe
} from '../public/lib/preferences.mjs';

describe('serializePinnedChoices / deserializePinnedChoices (local persistence round-trip)', () => {
  test('Prefer -> save -> reload -> still Prefer', () => {
    // Simulates the exact scenario the task asks for: swiping to pin a
    // genuine alternative, persisting it (serialize, as savePinnedChoices
    // would write to localStorage), then "reloading" (deserialize, as
    // loadPinnedChoices would read back) - the pin must survive intact.
    const pinned = new Map([['2026-09-23', new Map([['slot-a', 'match-b']])]]);
    const raw = JSON.parse(JSON.stringify(serializePinnedChoices(pinned)));
    const reloaded = deserializePinnedChoices(raw, '2026-09-20');
    assert.equal(reloaded.get('2026-09-23')?.get('slot-a'), 'match-b');
  });

  test('un-Prefer -> save -> reload -> still un-Preferred', () => {
    // "Un-Prefer" is applySlotSwipe clearing a pin (see its own tests below)
    // - once cleared, serializing/reloading must never resurrect it.
    const pinned = new Map([['2026-09-23', new Map([['slot-a', 'match-b']])]]);
    const cleared = applySlotSwipe(pinned, '2026-09-23', 'slot-a', 'match-a', 'match-a');
    const raw = JSON.parse(JSON.stringify(serializePinnedChoices(cleared)));
    const reloaded = deserializePinnedChoices(raw, '2026-09-20');
    assert.equal(reloaded.has('2026-09-23'), false);
  });

  test('deserializePinnedChoices drops a day already older than todayKey', () => {
    const raw = { '2026-09-18': { 'slot-a': 'match-b' }, '2026-09-21': { 'slot-a': 'match-c' } };
    const reloaded = deserializePinnedChoices(raw, '2026-09-20');
    assert.equal(reloaded.has('2026-09-18'), false);
    assert.equal(reloaded.get('2026-09-21')?.get('slot-a'), 'match-c');
  });

  test('deserializePinnedChoices tolerates malformed/foreign input rather than throwing', () => {
    assert.deepEqual([...deserializePinnedChoices(null, '2026-09-20').entries()], []);
    assert.deepEqual([...deserializePinnedChoices('not an object', '2026-09-20').entries()], []);
    assert.deepEqual(
      [...deserializePinnedChoices({ '2026-09-21': { a: 42 } }, '2026-09-20').entries()],
      []
    ); // non-string matchId dropped, leaving an empty day dropped too
  });
});

describe('pruneStalePinnedChoices', () => {
  test('drops only days strictly before todayKey, returns a NEW map, flags changed', () => {
    const pinned = new Map([
      ['2026-09-19', new Map([['s', 'm1']])],
      ['2026-09-20', new Map([['s', 'm2']])],
      ['2026-09-21', new Map([['s', 'm3']])]
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
    const pinned = new Map([['2026-09-21', new Map([['s', 'm3']])]]);
    const { pinnedChoices, changed } = pruneStalePinnedChoices(pinned, '2026-09-20');
    assert.equal(changed, false);
    assert.equal(pinnedChoices.get('2026-09-21')?.get('s'), 'm3');
  });
});

describe('applySlotSwipe (the Recommend/Prefer swipe-semantics fix)', () => {
  test('swiping to a genuine alternative (not the natural default) sets a pin - 偏好', () => {
    const pinned = new Map();
    const next = applySlotSwipe(pinned, '2026-09-23', 'slot-a', 'match-b', 'match-a');
    assert.equal(next.get('2026-09-23')?.get('slot-a'), 'match-b');
  });

  test('swiping to the natural default clears any existing pin instead of setting one - reverts to 推薦', () => {
    // This is the direct regression test for "swiping back changes
    // Recommend into Prefer": naturalMatchId === matchId means the viewer
    // swiped straight back to whatever the algorithm would already have
    // picked - that must clear the pin, not record one.
    const pinned = new Map([['2026-09-23', new Map([['slot-a', 'match-b']])]]);
    const next = applySlotSwipe(pinned, '2026-09-23', 'slot-a', 'match-a', 'match-a');
    assert.equal(next.has('2026-09-23'), false);
  });

  test('swiping to the natural default when nothing was pinned is a true no-op (same reference back)', () => {
    const pinned = new Map();
    const next = applySlotSwipe(pinned, '2026-09-23', 'slot-a', 'match-a', 'match-a');
    assert.equal(next, pinned); // no unnecessary re-persist/re-render
  });

  test('swiping to the SAME already-pinned choice again is a true no-op (same reference back)', () => {
    const pinned = new Map([['2026-09-23', new Map([['slot-a', 'match-b']])]]);
    const next = applySlotSwipe(pinned, '2026-09-23', 'slot-a', 'match-b', 'match-a');
    assert.equal(next, pinned);
  });

  test('clearing the only pin on a day removes the whole day entry, not just the slot', () => {
    const pinned = new Map([['2026-09-23', new Map([['slot-a', 'match-b']])]]);
    const next = applySlotSwipe(pinned, '2026-09-23', 'slot-a', 'match-a', 'match-a');
    assert.equal(next.has('2026-09-23'), false);
  });

  test('clearing one slot on a day with other pinned slots keeps the other slots intact', () => {
    const pinned = new Map([
      ['2026-09-23', new Map([['slot-a', 'match-b'], ['slot-x', 'match-y']])]
    ]);
    const next = applySlotSwipe(pinned, '2026-09-23', 'slot-a', 'match-a', 'match-a');
    assert.equal(next.get('2026-09-23')?.has('slot-a'), false);
    assert.equal(next.get('2026-09-23')?.get('slot-x'), 'match-y');
  });

  test('never mutates the map passed in - pure function of its arguments', () => {
    const pinned = new Map([['2026-09-23', new Map([['slot-a', 'match-b']])]]);
    applySlotSwipe(pinned, '2026-09-23', 'slot-a', 'match-c', 'match-a');
    assert.equal(pinned.get('2026-09-23')?.get('slot-a'), 'match-b'); // untouched
  });

  test('a null naturalMatchId (no natural pick could be determined) never auto-clears - any explicit swipe still pins', () => {
    const pinned = new Map();
    const next = applySlotSwipe(pinned, '2026-09-23', 'slot-a', 'match-b', null);
    assert.equal(next.get('2026-09-23')?.get('slot-a'), 'match-b');
  });
});
