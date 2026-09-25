// ---- scripts/build-snapshot.mjs ----
// Builds the prebuilt match-list snapshot the page paints from on load (see
// public/app.js's SERVER_SNAPSHOT_URL), run every few minutes by
// .github/workflows/snapshot.yml and published to this repo's `data`
// branch - one small file served straight from GitHub's CDN, instead of every
// viewer's browser first making ~80 proxied API requests before it can show
// anything. The page still runs its own live build right after painting
// this, exactly as before; the snapshot only removes the wait.
//
// Deliberately mirrors the browser's own build, not scripts/build-data.mjs's:
// app.js calls buildMatches with `enrichOdds: false` (Polymarket prices
// don't feed its scores) and then adds Polymarket odds as display-only
// fields (see enrichOddsInBackground). Scoring any differently here would
// make the first paint's recommendation disagree with the live build that
// replaces it a moment later - a visible flicker.
//
// Usage: node scripts/build-snapshot.mjs [output path]
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildMatches, enrichWithPolymarketOdds, DEFAULT_DAYS_AHEAD } from '../public/lib/match-builder.mjs';

const FETCH_USER_AGENT = 'Match-Find-Bot/1.0 (+https://github.com/JayPengX/Match-Find)';

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': FETCH_USER_AGENT },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const outputPath = path.resolve(process.argv[2] || 'snapshot/matches.json');
  const { generatedAt, daysAhead, matches } = await buildMatches({
    now: new Date(),
    daysAhead: DEFAULT_DAYS_AHEAD,
    fetchJson,
    enrichOdds: false
  });
  await enrichWithPolymarketOdds(matches, fetchJson);
  // A build that found nothing at all is far more likely an upstream outage
  // than a genuinely empty three weeks across four leagues - fail so the
  // workflow keeps the last good snapshot instead of publishing an empty one.
  if (!matches.length) throw new Error('Build produced no matches - not publishing');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify({ generatedAt, daysAhead, matches }));
  console.log(`Wrote ${matches.length} matches to ${outputPath}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
