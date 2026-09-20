// Tests for public/lib/color.mjs - the WCAG contrast math behind the odds
// bar's per-team color (see public/app.js's teamOddsColor).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hexToRgb, relativeLuminance, contrastRatio, pickReadableTeamColor } from '../public/lib/color.mjs';

describe('hexToRgb', () => {
  test('reads ESPN\'s own bare hex (no leading #)', () => {
    assert.deepEqual(hexToRgb('d00027'), { r: 208, g: 0, b: 39 });
  });
  test('also reads a normal CSS hex with # and 3-digit shorthand', () => {
    assert.deepEqual(hexToRgb('#ffffff'), { r: 255, g: 255, b: 255 });
    assert.deepEqual(hexToRgb('#fff'), { r: 255, g: 255, b: 255 });
  });
  test('returns null for anything that is not a real hex color', () => {
    assert.equal(hexToRgb(''), null);
    assert.equal(hexToRgb(undefined), null);
    assert.equal(hexToRgb('not-a-color'), null);
  });
});

describe('relativeLuminance / contrastRatio', () => {
  test('pure black vs pure white is the textbook 21:1 maximum', () => {
    assert.equal(Math.round(contrastRatio('#000000', '#ffffff') * 100) / 100, 21);
  });
  test('a color against itself is always 1:1 (no contrast)', () => {
    assert.equal(contrastRatio('#5b8cff', '#5b8cff'), 1);
  });
  test('returns null when either input is not a real hex color', () => {
    assert.equal(contrastRatio('nope', '#fff'), null);
  });
});

describe('pickReadableTeamColor', () => {
  test('picks the primary color when it already reads fine against the background', () => {
    // A real, saturated team red against this app's real dark background.
    const result = pickReadableTeamColor('d00027', '000000', '0b0d12');
    assert.equal(result, '#d00027');
  });
  test('real bug case: Inter Miami\'s own near-black primary falls back to its alternate', () => {
    // Live-verified real ESPN data: Inter Miami CF color=231f20 (near-black,
    // almost invisible on this app's own dark background 0b0d12),
    // alternateColor=f7b5cd (a real, legible pink).
    const result = pickReadableTeamColor('231f20', 'f7b5cd', '0b0d12');
    assert.equal(result, '#f7b5cd');
  });
  test('returns null (never a barely-visible color) when neither side clears the floor', () => {
    // Both a near-black primary AND a near-black alternate against a dark
    // background - genuinely nothing usable here, caller should fall back
    // to its own fixed sport color instead.
    assert.equal(pickReadableTeamColor('0a0a0a', '111111', '0b0d12'), null);
  });
  test('missing colors entirely returns null rather than throwing', () => {
    assert.equal(pickReadableTeamColor('', '', '0b0d12'), null);
    assert.equal(pickReadableTeamColor(undefined, undefined, '0b0d12'), null);
  });
});
