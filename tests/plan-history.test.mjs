import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updatePlanHistory, localDateKey } from '../scripts/plan-history.mjs';

function makeMatch(overrides) {
  return {
    sport: 'MLB',
    durationMinutes: 180,
    isFinished: false,
    competitiveness: 6,
    watchability: 6,
    stakes: 6,
    enduranceScore: 6,
    broadcastQuality: 5,
    score: 6,
    confidence: 1,
    competitors: [],
    ...overrides
  };
}

// Local noon/evening times, so the test holds in any TZ it runs under.
function localIso(dayOffset, hour, now) {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

test('a started pick in the previous history stays locked even when another game now scores higher', () => {
  const now = new Date();
  now.setHours(21, 0, 0, 0);
  const today = localDateKey(now);
  const started = makeMatch({ id: 'started', name: 'A @ B', startTimeUtc: localIso(0, 19, now), score: 6 });
  const rival = makeMatch({ id: 'rival', name: 'C @ D', startTimeUtc: localIso(0, 19, now), score: 9 });

  const fresh = updatePlanHistory([started, rival].map(m => ({ ...m })), null, now);
  assert.deepEqual(fresh[today], ['rival']);

  const kept = updatePlanHistory([started, rival].map(m => ({ ...m })), { [today]: ['started'] }, now);
  assert.deepEqual(kept[today], ['started']);
});

test('drops days older than five days back and keeps past days it no longer has matches for', () => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const key = offset => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    return localDateKey(d);
  };
  const result = updatePlanHistory([], { [key(-6)]: ['old'], [key(-3)]: ['kept'] }, now);
  assert.deepEqual(result, { [key(-3)]: ['kept'] });
});

test('a recorded pick missing from this build (its league failed to fetch) is kept', () => {
  const now = new Date();
  now.setHours(21, 0, 0, 0);
  const today = localDateKey(now);
  const other = makeMatch({ id: 'other', name: 'C @ D', startTimeUtc: localIso(0, 19, now) });
  const result = updatePlanHistory([other], { [today]: ['gone'] }, now);
  assert.ok(result[today].includes('gone'));
  assert.ok(result[today].includes('other'));
});
