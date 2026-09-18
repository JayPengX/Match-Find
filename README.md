# Match Find

**Live site: https://jaypengx-collab.github.io/Match-Find/**

A tiny, Traditional-Chinese static site that answers "what's worth watching
today" across the Premier League, MLS, MLB, NBA, and F1 — shown in your own
local time, with team logos, home/away labels, bilingual (English /
Traditional Chinese) team names and venues, where to watch each fixture in
Taiwan (愛爾達體育台, Apple TV, ...), a horizontally-scrolling day picker
(today through the next two weeks, auto-jumping past today if today's
fixtures are already over), and a curated daily lineup picked so you can
watch back-to-back without constant channel-hopping or being told to stay
up for a 3am fixture.

No sign-up, no app — it's a GitHub Pages site rebuilt every few hours.

## How it works

Scoring and picking are split across two different places, deliberately:

1. **`scripts/build-data.mjs`** (run by the scheduled GitHub Action below,
   never by a browser — see "AI runs in the background" below) fetches
   upcoming fixtures for the next 14 days from
   [ESPN's public scoreboard API](https://site.api.espn.com) — no API key
   needed for this part. Each fixture comes with both teams' ESPN-hosted
   logo and a Traditional Chinese name looked up from
   `scripts/team-names.mjs` (a static, best-effort translation table — see
   that file's own comment; a team missing from it just shows English-only).
2. It sends only fixtures it hasn't already scored (see "AI score cache"
   below) to a `/match-recommend` endpoint on a shared Cloudflare Worker
   (see "AI recommendations" below), which asks Gemini for four things per
   fixture: **competitiveness** (how close it's likely to be),
   **watchability** (how entertaining/notable it is regardless of
   closeness), the venue's **Traditional Chinese name**, and **where to
   watch it in Taiwan** (a TV channel or streaming service, e.g. 愛爾達體育台
   or Apple TV — ESPN's API has no concept of Taiwan broadcast rights at
   all, so this can only come from the model's own knowledge, same as the
   scoring). None of this depends on who's looking at the page or when, so
   it's all computed once, at build time, and cached.
3. The result — every fixture, scored, nothing filtered or picked yet — is
   written to `public/data/matches.json`.
4. **`public/app.js`'s `resolveViewingPlan`**, running in *your* browser,
   picks the set of fixtures across the whole fetched window that
   maximizes total score while staying watchable back-to-back — a
   weighted-interval-scheduling-style pass over each sport's *average*
   broadcast length (ESPN never gives an actual end time). This has to run
   client-side, not at build time, because its two real inputs are both
   relative to *your* clock, and one static build serves every viewer in
   every timezone at once:
   - A fixture whose **local** start time falls between midnight and 7am
     is never eligible to be picked, however good its score — this site
     won't tell you a 3am kickoff is unmissable. It still shows up further
     down in "all matches", just never as a recommended pick.
   - A small tolerance absorbs the fact that a duration is only ever a
     per-sport average, not this match's real length.
   - A much larger tolerance kicks in whenever either match involved has a
     high score — this is the deliberate "allow overlap in certain
     scenarios" behavior: a must-watch fixture is allowed to eat into the
     next slot a bit rather than being dropped, or bumping its neighbor,
     over a minor overlap. The UI calls this out explicitly ("Overlaps by
     about N min with X — kept in the lineup anyway for its quality").
   - Whichever pick is currently live, or (failing that) the soonest one
     still to come, is pinned to the top of the day's list.

## Page layout

- A horizontally-scrolling **day picker** at the top — today plus the next
  6 days up front, with a "+N more" pill that reveals the rest of the
  already-fetched 14-day window on tap (no extra network request — see
  above, it's all in the one `matches.json` fetched on page load). Defaults
  to today, but jumps ahead to the next day that still has a fixture to
  come if today's are all already over.
- For the selected day: **推薦賽事 ("recommended fixtures")**, the curated
  back-to-back lineup described above, closest/live match first.
- Below that: **所有賽事 ("all fixtures")**, every fixture that day
  regardless of whether it made the recommended lineup, so nothing is
  actually hidden — just not pushed as a pick.
- Each fixture shows both teams with **home/away labels** (主/客), logo, and
  bilingual English/Traditional-Chinese name; the venue and (when known)
  Taiwan broadcast channel are shown the same bilingual/Chinese way. MLB in
  particular is very often carried on both 緯來體育台 and 愛爾達體育台 at
  once - the prompt (see Orbit's `/match-recommend`) is told to always name
  愛爾達體育台 when both apply, rather than answering inconsistently.
- Each fixture also shows its **expected end time** ("至 9:30 下午") next to
  the start time, and a countdown that switches from hours to whole days
  once a fixture is more than 24 hours out ("2 天 5 小時後", not "53 小時
  後") - both computed from the sport's average broadcast length, same as
  the scheduling logic above.

## Sport priority (⚙ in the header)

MLB alone can field ~15 games a night, almost all landing in the same few
overlapping evening windows - so even when every one of them is a
perfectly good match, only one can win a given slot, and a less-crowded
sport's ordinary fixture can end up looking like it's "always" the pick
for that slot purely because it had less competition, not because this
site favors it. There's no universally correct answer for which sport
*should* win a close call, so instead of guessing, a small settings panel
(the ⚙ button in the header) lets each viewer say which way they'd rather
it lean: 較少/一般/較多 ("less/normal/more") per sport, stored in
`localStorage` (per-browser, nothing sent anywhere). It only ever nudges
`resolveViewingPlan`'s own scoring when picks are close - the
competitiveness/watchability meters shown on every card always stay the
true, un-nudged AI scores.

## AI runs in the background, not on page load

Nothing in the browser ever calls Gemini or the proxy Worker. The only
network request the page itself makes is one `fetch('./data/matches.json')`
on load. All AI scoring happened earlier, unattended, in the scheduled
build (see "Deployment" below) — by the time anyone opens the page, every
fixture in the window is already scored and sitting in a static file.

## Staying up to date in a tab left open

A tab left open doesn't just freeze on whatever it first loaded: every 5
minutes it re-fetches `matches.json` (`cache: 'no-store'`, same as the
initial load) and reacts based on what actually changed, using `buildId`
(the git commit the build ran from — `.github/workflows/deploy.yml` passes
`github.sha`) to tell the two cases apart:

- **New data, same code** (a routine scheduled rebuild of the same commit —
  `buildId` unchanged): refreshes silently, keeping whatever day/filter the
  viewer already has selected.
- **New code** (a real commit was deployed — `buildId` changed): this tab
  is still running the *old* JS/CSS/HTML no matter how fresh the data
  underneath it is, so a silent refresh can't actually pick up whatever
  changed in the code. A small banner appears instead ("網站已推出新版本")
  with a button that reloads the page — deliberately not an automatic
  reload, so nobody gets yanked away mid-scroll or mid-tap.

## AI score cache (keeping Gemini usage flat)

A scheduled run every 6 hours would, naively, re-score the same
heavily-overlapping 14-day window of fixtures on every single run. Instead,
`data/ai-cache.json` (a file *committed to the repo*, unlike the
fully-regenerated `public/data/matches.json`) records every match Gemini has
already scored, keyed by a stable match id. Each build only sends fixtures
**not** already in that cache — so a given match is scored by Gemini exactly
once, on whichever run first sees it inside the fetch window, no matter how
many times the build runs afterward. Requests are batched under the shared
Worker's 80-fixtures-per-call cap (see `AI_SCORE_BATCH_SIZE` — matters most
on the very first run, when nothing is cached yet and a 14-day window can
easily find several hundred new fixtures at once). The workflow commits the
cache back to the repo only when it actually changed (see
`.github/workflows/deploy.yml`'s "Commit updated AI score cache" step), and
entries older than 12 hours past kickoff are pruned automatically so the
file doesn't grow forever.

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
