# Match Find

A tiny static site that builds one continuous viewing plan out of everything
on today across the Premier League, MLS, MLB, NBA, and F1 — which fixture is
actually worth watching, shown in your own local time, with team logos and
bilingual (English / Traditional Chinese) team names, and picks chosen so a
viewer can watch them back-to-back without constant channel-hopping.

No sign-up, no app — it's a GitHub Pages site rebuilt every few hours.

## How it works

1. **`scripts/build-data.mjs`** (run by the GitHub Action below, not by a
   browser) fetches upcoming fixtures for the next ~36 hours from
   [ESPN's public scoreboard API](https://site.api.espn.com) — no API key
   needed for this part. Each fixture comes with both teams' ESPN-hosted
   logo and a Traditional Chinese name looked up from
   `scripts/team-names.mjs` (a static, best-effort translation table — see
   that file's own comment; a team missing from it just shows English-only).
2. It sends only fixtures it hasn't already scored (see "AI score cache"
   below) to a `/match-recommend` endpoint on a shared Cloudflare Worker
   (see "AI recommendations" below), which asks Gemini to score each one's
   **competitiveness** (how close it's likely to be) and **watchability**
   (how entertaining/notable it is regardless of closeness) using real-world
   knowledge of the teams/drivers involved.
3. **`resolveViewingPlan`** picks the set of fixtures across the *whole*
   window (every sport combined, one plan, not one per league) that
   maximizes total score while staying watchable back-to-back — a
   weighted-interval-scheduling-style pass over each sport's *average*
   broadcast length (ESPN never gives an actual end time):
   - A small tolerance absorbs the fact that a duration is only ever a
     per-sport average, not this match's real length.
   - A much larger tolerance kicks in whenever either match involved has a
     high score — this is the deliberate "allow overlap in certain
     scenarios" behavior: a must-watch fixture is allowed to eat into the
     next slot a bit rather than being dropped, or bumping its neighbor,
     over a minor overlap. The UI calls this out explicitly ("Overlaps by
     about N min with X — kept in the lineup anyway for its quality").
   - This all happens once in UTC at build time (an overlap in UTC is the
     same overlap for every viewer, regardless of timezone), not per
     visitor.
4. The result is written to `public/data/matches.json`, which the static
   page (`public/index.html` + `public/app.js`) reads and renders, converting
   every kickoff time to *your* browser's local timezone client-side.

If the Gemini proxy isn't configured, or a call to it fails, affected
fixtures fall back to a simple local heuristic based on each team's
win-loss record — the site still works, just with less insightful picks
(shown as "estimated" in the UI).

## AI score cache (keeping Gemini usage flat)

A scheduled run every 6 hours would, naively, re-score the same ~30-hour
overlap of fixtures on every single run. Instead, `data/ai-cache.json` (a
file *committed to the repo*, unlike the fully-regenerated
`public/data/matches.json`) records every match Gemini has already scored,
keyed by a stable match id. Each build only sends fixtures **not** already
in that cache — so a given match is scored by Gemini exactly once, on
whichever run first sees it inside the fetch window, no matter how many
times the build runs afterward. The workflow commits the cache back to the
repo only when it actually changed (see `.github/workflows/deploy.yml`'s
"Commit updated AI score cache" step), and entries older than 12 hours past
kickoff are pruned automatically so the file doesn't grow forever.

## Deployment

This repo deploys itself: `.github/workflows/deploy.yml` runs
`scripts/build-data.mjs` and publishes `public/` to GitHub Pages —

- on every push to `main`,
- on a schedule (every 6 hours), so the data stays fresh even with no
  code changes,
- and on-demand via the Actions tab ("Run workflow").

Make sure the repo's **Settings → Pages → Source** is set to **GitHub
Actions** (no branch to pick — the workflow handles publishing).

## AI recommendations (optional but recommended)

The competitiveness/watchability scoring is served by the same shared
Cloudflare Worker that the sibling repo [Orbit](https://github.com/jaypengx-collab/Orbit)
already deploys for its own AI features (`cloudflare-worker/orbit-worker.js`,
route `/match-recommend`) — this repo doesn't hold, and never needs, a
Gemini API key of its own.

To enable it:

1. Deploy or confirm Orbit's Worker is live with `GEMINI_API_KEY` set (see
   that repo's README, "AI 辨識課表照片" section) — the `/match-recommend`
   route reuses that same key.
2. In **this** repo's **Settings → Secrets and variables → Actions →
   Variables**, add `PROXY_URL` set to that Worker's base URL (e.g.
   `https://orbit-workers-proxy.<you>.workers.dev`, **no path suffix** — the
   build script appends `/match-recommend` itself). This is a plain
   variable, not a secret: the value carries no credential.
3. Push to `main` (or run the workflow manually) — the next build will call
   the proxy.

Leaving `PROXY_URL` unset is fine; the site just falls back to the local
heuristic described above for every fixture.

## Running locally

```bash
node scripts/build-data.mjs        # writes public/data/matches.json, updates data/ai-cache.json
npx serve public                   # or any static file server
```

Set `PROXY_URL` in your shell first if you want AI-scored results locally
instead of the heuristic fallback. Delete `data/ai-cache.json` (or an entry
in it) if you want a match re-scored.

## Fixing a team's Chinese name

Edit `scripts/team-names.mjs` — it's a plain object keyed by league id and
ESPN's team abbreviation (e.g. `mlb.NYY`). A missing or wrong entry doesn't
break anything: the site just shows that team's English name only.
