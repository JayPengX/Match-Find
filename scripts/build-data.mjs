// ---- scripts/build-data.mjs ----
// A thin Node CLI wrapper around public/lib/match-builder.mjs's own
// buildMatches - kept purely for LOCAL dev/debugging tooling
// (dump-day-plan.mjs and evaluate-recommendations.mjs both read a
// matches.json snapshot from disk) and for manual `node
// scripts/build-data.mjs` runs. The deployed site itself no longer depends
// on this script or its output at all - public/app.js calls buildMatches
// directly, live, from every viewer's own browser (see that file's own
// comment for why: this used to be a static matches.json rebuilt by a
// scheduled GitHub Action and redeployed every 15 minutes, which is
// exactly the staleness/deploy-latency this replaced).
//
// The only thing genuinely Node-specific left here is the direct fetch
// (this CLI can reach ESPN/Polymarket/the MLB Stats API/Jolpica directly,
// unlike a browser) and writing the result to disk.

import { writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildMatches, DEFAULT_DAYS_AHEAD } from '../public/lib/match-builder.mjs';

// A real, live 403 hit while building the pipeline this wraps: ESPN's own
// scoreboard API sits behind Akamai's bot manager, which blocks Node's own
// default fetch User-Agent (the literal string "node") outright - and,
// more surprisingly, ALSO blocks a fabricated real-browser UA (Chrome's,
// tried live), while a plain, honest self-identifying UA and even bare
// `curl`'s own default both sail through untouched. This isn't a targeted
// block on automation as such, just a specific blocklisted token - a
// transparent, honest bot UA (contact URL included, standard practice for
// a script polling a public, no-auth, no-rate-limit-documented endpoint
// like this one) is both the more honest choice and the one confirmed
// live to work, unlike pretending to be a browser this script isn't.
const FETCH_USER_AGENT = 'Match-Find-Bot/1.0 (+https://github.com/jaypengx-collab/Match-Find)';

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': FETCH_USER_AGENT },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

const OUTPUT_PATH = new URL('../public/data/matches.json', import.meta.url);

async function main() {
  const { generatedAt, daysAhead, matches } = await buildMatches({
    now: new Date(),
    daysAhead: DEFAULT_DAYS_AHEAD,
    fetchJson
  });
  const output = { generatedAt, daysAhead, matches };
  await mkdir(new URL('.', OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${matches.length} matches to ${OUTPUT_PATH.pathname}`);
}

// Only actually runs when this file is executed directly (`node
// scripts/build-data.mjs`), not when merely imported.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
