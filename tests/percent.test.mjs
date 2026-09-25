import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { roundToHundred } from '../public/lib/percent.mjs';

describe('roundToHundred', () => {
  test('never shows a two-way split that adds up to 101', () => {
    // Rounded on their own these read 54% / 47%.
    assert.deepEqual(roundToHundred([54.4, null, 46.6]), [54, null, 46]);
  });

  test('three-way splits still sum to 100', () => {
    const out = roundToHundred([33.4, 33.3, 33.3]);
    assert.equal(out.reduce((a, b) => a + b, 0), 100);
  });

  test('already-whole values pass through unchanged', () => {
    assert.deepEqual(roundToHundred([40, 20, 40]), [40, 20, 40]);
  });
});
