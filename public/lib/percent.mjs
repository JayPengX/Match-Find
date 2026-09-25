// ---- public/lib/percent.mjs ----
// Whole-number percentages that still add up to exactly 100 - rounding each
// side on its own showed a real "54% / 47%" bar. Largest-remainder method:
// floor every value, then hand the leftover points to the values that lost
// the most in flooring. Non-finite entries stay null and are left out.
export function roundToHundred(values) {
  const finite = values.map(v => (Number.isFinite(v) ? v : null));
  const present = finite.filter(v => v != null);
  const total = present.reduce((sum, v) => sum + v, 0);
  if (!present.length || total <= 0) return finite.map(v => (v == null ? null : Math.round(v)));
  const scaled = finite.map(v => (v == null ? null : (v / total) * 100));
  const floored = scaled.map(v => (v == null ? null : Math.floor(v)));
  let leftover = 100 - floored.reduce((sum, v) => sum + (v ?? 0), 0);
  const order = scaled
    .map((v, i) => ({ i, rem: v == null ? -1 : v - Math.floor(v) }))
    .filter(entry => entry.rem >= 0)
    .sort((a, b) => b.rem - a.rem);
  for (const { i } of order) {
    if (leftover <= 0) break;
    floored[i] += 1;
    leftover -= 1;
  }
  return floored;
}
