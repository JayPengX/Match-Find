# Match Find

A tiny static site that answers one question: **which match, out of everything
on today across the Premier League, MLS, MLB, NBA, and F1, is actually worth
watching** — shown in your own local time, with the pick resolved
automatically whenever two good matches happen to overlap.

No sign-up, no app — it's a GitHub Pages site rebuilt every few hours.

## How it works

1. **`scripts/build-data.mjs`** (run by the GitHub Action below, not by a
   browser) fetches upcoming fixtures for the next ~36 hours from
   [ESPN's public scoreboard API](https://site.api.espn.com) — no API key
   needed for this part.
2. It sends the fixture list to a `/match-recommend` endpoint on a shared
   Cloudflare Worker (see "AI recommendations" below), which asks Gemini to
   score each fixture's **competitiveness** (how close it's likely to be)
   and **watchability** (how entertaining/notable it is regardless of
   closeness) using real-world knowledge of the teams/drivers involved.
3. Fixtures whose broadcast windows overlap are grouped, and the
   highest-scoring one in each group is marked as the recommended pick —
   this is the "time conflict" resolution: it's computed once in UTC at
   build time (an overlap in UTC is the same overlap for every viewer,
   regardless of timezone), not per visitor.
4. The result is written to `public/data/matches.json`, which the static
   page (`public/index.html` + `public/app.js`) reads and renders, converting
   every kickoff time to *your* browser's local timezone client-side.

If the Gemini proxy isn't configured, or a call to it fails, affected
fixtures fall back to a simple local heuristic based on each team's
win-loss record — the site still works, just with less insightful picks
(shown as "estimated" in the UI).

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
node scripts/build-data.mjs        # writes public/data/matches.json
npx serve public                   # or any static file server
```

Set `PROXY_URL` in your shell first if you want AI-scored results locally
instead of the heuristic fallback.
