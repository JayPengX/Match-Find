// ---- public/lib/color.mjs ----
// Pure color-contrast math for picking a real team's own brand color for
// the odds bar (see public/app.js's buildMatchCard) instead of one fixed
// color for every match - while still refusing to use a team color that
// would actually be unreadable against the card's current background (a
// near-black primary color on this app's dark theme, for real example, see
// tests/color.test.mjs's Inter Miami case: color "231f20" is almost
// invisible on background "0b0d12"). No DOM access, no theme detection -
// callers hand this the actual computed background color themselves (see
// app.js reading getComputedStyle's own `--bg-elevated`), so this module
// doesn't need to know whether dark or light mode is active, just compare
// two colors.

// Accepts ESPN's own bare hex strings ("d00027", no leading #) as well as
// a normal "#d00027"/"#fff" CSS hex - returns null for anything that isn't
// a real 3- or 6-digit hex color, never a guessed default RGB.
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const clean = hex.trim().replace(/^#/, '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map(ch => ch + ch)
          .join('')
      : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}

// WCAG's own relative luminance formula (sRGB -> linear light -> the
// standard 0.2126/0.7152/0.0722 weighting) - the textbook definition, not
// anything invented for this codebase.
export function relativeLuminance({ r, g, b }) {
  const linear = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

// WCAG's own contrast-ratio formula ((L1+0.05)/(L2+0.05), lighter color
// first) - returns null when either color string isn't a real hex color.
export function contrastRatio(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return null;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// A team's primary color is the honest, real identifying choice (their
// actual brand color) - this uses it whenever it clears `minContrast`
// against the given background, full stop, even when the alternate color
// would technically score EVEN higher (a real live bug this fixes: the
// Baltimore Orioles' own primary is a legible orange "df4601", contrast
// ~4.3 against this app's own dark background - plenty readable - but
// their alternate is pure black "000000", which scores an even higher
// ~21:1 against a WHITE background; ranking by "whichever wins outright"
// picked black there, a real color but not the one that actually reads as
// "Orioles" to a viewer). The alternate is a fallback for when the
// primary genuinely fails to read at all (near-black on this app's dark
// background, near-white on light), not a competitor for "which is more
// contrasty". minContrast defaults to 1.6 - deliberately below WCAG's own
// 3:1 "non-text contrast" bar, since a thin decorative fill bar (not text,
// and always paired with a plain-text percentage right next to it) only
// needs to be distinguishable from its background, not read on its own -
// a real team's own saturated brand color already clears 3:1 against both
// this app's dark and light background easily, so this floor only exists
// to catch genuinely invisible cases (true black-on-black, white-on-white),
// not to reject legitimate but moderate team colors.
export function pickReadableTeamColor(primaryHex, alternateHex, backgroundHex, { minContrast = 1.6 } = {}) {
  for (const candidate of [primaryHex, alternateHex]) {
    if (!candidate) continue;
    const ratio = contrastRatio(candidate, backgroundHex);
    if (ratio != null && ratio >= minContrast) {
      return candidate.startsWith('#') ? candidate : `#${candidate}`;
    }
  }
  return null;
}

// "Redmean" weighted RGB distance - a cheap approximation of how different
// two colors look to a person (0 = identical, ~765 = black vs white),
// close enough for "can a viewer tell these two bar segments apart" without
// pulling in a full Lab conversion. Returns null for a non-hex input.
export function colorDistance(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return null;
  const rMean = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}

// Both sides of one odds bar, each still its own team's real color, but
// never two colors a viewer can't tell apart - a live-reported case: the
// Cubs' blue "0e3386" next to the Red Sox's navy "0c2340" read as one solid
// bar, so the split (the whole point of the bar) vanished. Each side's
// readable candidates (primary first, then alternate - same rules as
// pickReadableTeamColor) are tried in order of how much of each team's
// real identity they keep: both primaries, then the home side's alternate,
// then the away side's alternate, then both alternates. If no pair is far
// enough apart, the away side keeps its color and home comes back null -
// the caller draws that side in a neutral color instead.
export function pickDistinctTeamColors(away, home, backgroundHex, { minContrast = 1.6, minDistance = 150 } = {}) {
  const readable = team =>
    [team?.color, team?.altColor]
      .map(c => pickReadableTeamColor(c, null, backgroundHex, { minContrast }))
      .filter(Boolean);
  const awayOptions = readable(away);
  const homeOptions = readable(home);
  const pairs = [
    [awayOptions[0], homeOptions[0]],
    [awayOptions[0], homeOptions[1]],
    [awayOptions[1], homeOptions[0]],
    [awayOptions[1], homeOptions[1]]
  ];
  for (const [a, h] of pairs) {
    if (a && h && colorDistance(a, h) >= minDistance) return { away: a, home: h };
  }
  return { away: awayOptions[0] ?? null, home: awayOptions[0] ? null : homeOptions[0] ?? null };
}
