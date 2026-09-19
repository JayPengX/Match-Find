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
up for a 3am fixture. The page itself only ever shows the *recommendation* -
a plain-language reason, not the raw competitiveness/watchability numbers
behind it (see "Page layout" below).

No sign-up, no app — it's a GitHub Pages site rebuilt every 15 minutes,
installable as a PWA. There's no in-page header at all (an earlier version
had a slim one; dropped entirely - an installed PWA's home-screen icon/OS
title bar already carries the app's identity, so a masthead here was just
empty space repeating it) - Settings lives behind a floating button fixed
to the corner instead.

## How it works

Scoring and picking are split across two different places, deliberately:

1. **`scripts/build-data.mjs`** (run by the scheduled GitHub Action below,
   never by a browser — see "AI runs in the background" below) fetches
   upcoming *and currently-live* fixtures for the next 14 days from
   [ESPN's public scoreboard API](https://site.api.espn.com) — no API key
   needed for this part. Only a FINISHED fixture is excluded - this script
   re-fetches ESPN's live feed on every scheduled run and every push, so a
   fixture that was still upcoming last run has very often already started
   by the next one; dropping it the moment ESPN flips it to "live" used to
   mean a match a viewer was actively watching would simply vanish from
   "today" mid-game, even though the client already has everything it
   needs (relativeLabel/`.is-live`, see "Page layout" below) to show it as
   直播中 once it's actually in the data. Each fixture comes with both
   teams' ESPN-hosted logo and a Traditional Chinese name looked up from
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
   decides **one local calendar day at a time** which fixtures are worth
   recommending. This has to run client-side, not at build time, because
   its real inputs are relative to *your* clock, and one static build
   serves every viewer in every timezone at once:
   - A fixture whose **local** start time falls between midnight and 5am
     is never eligible to be recommended, however good its score — this
     site won't tell you a 4am kickoff is unmissable. It still shows up
     further down in "all matches", just never as a recommended pick.
   - A fixture is recommended purely on its own merits
     (`RECOMMENDED_MIN_SCORE`, a flat bar its own score has to clear) -
     **not** relative to whatever else happens to be airing at the same
     time. Earlier designs (see `pickDayRecommendations`'s own top comment
     for the full history: a scheduling DP, then an overlap-clustering pass
     with one pick per slot and the rest demoted to a swipeable
     "alternative" or dropped) all shared the same real flaw: two or three
     genuinely good fixtures airing at once meant only one of them actually
     got recommended, purely because something else nearby scored slightly
     higher - not because the others weren't worth watching. Overlap is
     still surfaced - see the next bullet - it just no longer excludes a
     good match from being recommended.
   - Any card whose start overlaps an **earlier** match gets a small note
     saying so and for how long ("與「X」重疊 45 分鐘") - this is a plain
     fact about the schedule, shown regardless of whether either match is
     recommended, so two great fixtures airing at once are both still
     fully recommended, with a note letting you know they clash.
   - Whichever recommended fixture is currently live, or (failing that) the
     soonest one still to come, is pinned to the top of the day's list.

## Page layout

- A horizontally-scrolling **day picker** at the top — every day in the
  already-fetched 14-day window, all up front (no extra network request,
  no "load more" click - it's all in the one `matches.json` fetched on page
  load). Defaults to today, but jumps ahead to the next day that still has
  a fixture to come if today's are all already over.
- A row of **sport filter chips** (全部/英超/MLB/...) below the day picker,
  built only from sports actually present in the enabled set (see "Enabled
  sports settings" below) - narrows both sections below to one sport.
  Picking a sport chip that has nothing on the currently selected day (see
  `ensureSelectedDayHasActiveSport`) jumps the day picker to the nearest
  day that actually has one instead of leaving both sections empty for no
  visible reason - a real, common case for MLB/MLS specifically: Taiwan is
  far enough ahead of US time zones that a US evening fixture almost always
  lands on the viewer's *next* local calendar date (see `localDateKey`),
  so "today" can be genuinely, correctly empty for MLB while a full
  night's worth of real matches sit one tab over on "明天". Disabling a
  sport in Settings while its chip is the active filter resets the filter
  to 全部 the same way, rather than leaving the page stuck showing nothing
  for a sport that no longer exists in the enabled set at all.
- For the selected day: **推薦賽事 ("recommended fixtures")**, the curated
  back-to-back lineup described above, closest/live match first.
- Below that: **所有賽事 ("all fixtures")**, every fixture that day
  regardless of whether it made the recommended lineup, so nothing is
  actually hidden — just not pushed as a pick.
- Each fixture shows both teams with **home/away labels** (主/客), logo, and
  bilingual English/Traditional-Chinese name; the venue and (when known)
  Taiwan broadcast channel are shown the same bilingual/Chinese way, with a
  small color-coded badge per service (see "Broadcast service registry"
  below - no separate "已訂閱" mark on the card itself; which services count
  as yours only ever affects scoring, silently, see that section). MLB in
  particular is very often carried on both 緯來體育台 and 愛爾達體育台 at
  once - the prompt (see the shared proxy's `/match-recommend`) is told to always name
  愛爾達體育台 when both apply, rather than answering inconsistently.
- Each fixture shows one time range ("7:00 下午 – 9:35 下午") plus a short
  relative countdown next to it, instead of three separate stacked labels -
  the countdown switches from hours to whole days once a fixture is more
  than 24 hours out ("2 天 5 小時後", not "53 小時後"), both computed from
  the sport's average broadcast length.
- No competitiveness/watchability meters on the card - just the one-sentence
  AI reason. The number still drives whether a fixture clears
  `RECOMMENDED_MIN_SCORE` behind the scenes; the page itself only ever
  shows the recommendation, not the data behind it.
- Two or more fixtures overlapping in time are **each shown as their own
  full recommended card** if they each clear the bar on their own merits -
  there's no single "pick" per time slot and nothing to swipe through (an
  earlier version tried exactly that - one pick, the rest demoted to a
  swipeable alternative or dropped entirely - and it meant a night with
  several genuinely good, genuinely simultaneous fixtures surfaced only
  one of them). A card whose start overlaps an earlier match instead gets
  a small note naming that match and how long they overlap
  (`computeOverlapRange` in `buildMatchCard`), so the clash is visible
  without either fixture losing its recommendation over it.
- A fixture ESPN has scheduled but hasn't set a real kickoff time for yet
  (almost always a playoff game whose bracket slot is set before its exact
  date/time is - see `isTimeTbd` in `build-data.mjs`) never enters the day
  picker/recommended lineup at all, since there's no trustworthy time to
  schedule it against. It's listed once, separately, in a **時間未定**
  section at the bottom instead. A bracket slot with no real teams assigned
  yet ("TBD @ TBD") is skipped entirely rather than shown as a blank card.
- F1 weekends surface **qualifying and (on a sprint weekend) the sprint
  race** as their own fixtures, not just Saturday/Sunday's race - each a
  genuinely watchable event in its own right, keyed off ESPN's own
  per-session abbreviation (`Race`/`Qual`/`SR`, confirmed stable across both
  ordinary and sprint weekends). Session times were cross-checked against
  Formula1.com's own official timetable and matched exactly. F1's Taiwan
  broadcaster is always 愛爾達體育台 - the MLB-specific "Apple TV exclusive
  slate" override (see "Broadcast service registry" below and the shared
  proxy's `/match-recommend`) explicitly does not apply to F1, even though ESPN's
  own `broadcast` field for F1 also happens to say Apple TV (its real
  international rights holder - a genuinely different, unrelated fact from
  who carries it in Taiwan).

## Sport priority (⚙, floating bottom-right)

Since a fixture is now recommended purely on its own score against a flat
bar (`RECOMMENDED_MIN_SCORE` - see "How it works" above), there's no
per-slot "competition" left for sport priority to referee - the whole
reason an earlier design needed it (only one pick per overlapping slot, so
*something* had to decide which sport won a close one) no longer applies.
`priorityOrder` still does one real thing: it nudges a match's
`effectiveScore` up or down slightly before that threshold check, so a
viewer's preferred sports clear the bar a little more easily and their
least favorite needs to be a little better to clear it too - a small,
symmetric tilt (1st-ranked gets the biggest positive nudge, last-ranked the
biggest negative, the exact middle rank gets none), never enough on its own
to make a mediocre match recommended or keep a genuinely good one out. The
order is stored in `localStorage` (per-browser, nothing sent anywhere) and
re-ranking re-runs the whole plan and re-renders immediately, without
closing the panel or reloading.

## Broadcast service registry (logos, and "do I actually have this?")

`SERVICES` in `public/app.js` maps free-form `whereToWatchTw` text (Gemini's
own wording, not a fixed enum) to a small badge for exactly three services
this site's own viewer actually tracks: 愛爾達, Apple TV, Netflix. Any
*other* broadcaster Gemini names (緯來, DAZN, Disney+, myVideo, MLB.TV, ...)
still shows up as plain text on the card either way (see `watch-text` in
`buildMatchCard`) - it just doesn't get a logo/color badge, since this
registry only exists to badge the handful of services actually worth
tracking, not to catalog every service Gemini might ever answer with.
All three render each service's own real, official mark, hotlinked rather
than reproduced into this repo, same posture as the team/F1 logos pulled
from ESPN's CDN elsewhere in this file: Netflix and Apple TV via Wikimedia
Commons' `Special:FilePath` hotlink redirect (confirmed live, not assumed),
愛爾達 via 愛爾達電視's own official Android app icon on the Google Play
Store (see that entry's own comment for why Commons had nothing usable).
`logoBg` behind each mark is a two-stop gradient, not a flat fill, purely
so the badge reads as a designed icon rather than a plain colored sticker
sitting behind the logo. If a hotlink ever fails to load, it falls back to
a plain colored-initial badge (same `onerror` pattern as team logos) rather
than an empty box. Which services count as
"yours" (`DEFAULT_MY_SERVICE_IDS`) is fixed to this site's own owner's real
subscriptions, not a per-viewer Settings toggle - see that constant's own
comment. Adding a new tracked service later
is one more entry in that list; nothing else in the file needs to know
about it, same pattern as `SPORT_LABELS_ZH` for sports.

`DEFAULT_MY_SERVICE_IDS` names which of those the site's owner actually
subscribes to (愛爾達, Apple TV, Netflix, as of writing) - fixed, not a
per-viewer Settings toggle (an earlier version let each viewer pick their
own, which added a whole settings section for a nudge that's only ever
meaningful for this site's own owner). It only ever feeds a silent score
nudge (`OWNED_SERVICE_SCORE_BONUS`) in `resolveViewingPlan` - no visible
mark on the card either (an earlier version showed a small "已訂閱" tag;
dropped as one more thing competing for attention on every card for
information only this site's own owner ever acted on) - same tie-breaking
spirit as sport priority: a great game on a service you don't have still
shows up and can still be
recommended, this only tips a genuinely close call toward the one you can
actually watch live right now.

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

The workflow itself now runs every 15 minutes (see "Deployment" below) so
the free ESPN half of the build stays as fresh as possible - a scheduled
run that naively re-scored the same heavily-overlapping 14-day window of
fixtures on every one of THOSE runs would be a real problem. Instead,
`data/ai-cache.json` (a file *committed to the repo*, unlike the
fully-regenerated `public/data/matches.json`) records every match Gemini has
already scored, keyed by a stable match id, along with the `PROMPT_VERSION`
it was scored under. Each build only sends fixtures that either aren't in
that cache yet or were scored under an older `PROMPT_VERSION` — so a given
match is scored by Gemini exactly once *per meaningful prompt change*, not
once ever, which is what lets an already-cached match still pick up a real
fix (e.g. teaching the shared proxy's `/match-recommend` to actually search instead of
guess a broadcaster) instead of keeping a stale answer forever. Requests are
batched under the shared Worker's 80-fixtures-per-call cap (see
`AI_SCORE_BATCH_SIZE` — matters most on the very first run, and on any run
right after a `PROMPT_VERSION` bump, when a large batch of previously-cached
fixtures all need re-scoring at once). Entries older than 12 hours past
kickoff are pruned automatically so the file doesn't grow forever.

**Throttling how often Gemini gets called**: even with per-match caching, a
routine run can still find a couple of newly-in-window fixtures almost
every time, meaning several small Gemini calls a day for no real benefit -
especially now that the workflow itself fires every 15 minutes rather than
every 6 hours (see "Deployment" below). `data/ai-meta.json` (committed the
same way as `ai-cache.json`) records `lastAiFetchAt` — the last time this
build actually called the proxy — and a `schedule`-triggered run (as
opposed to a `push` or manual `workflow_dispatch` run — see
`GITHUB_EVENT_NAME` in the workflow) skips calling Gemini entirely if that
was less than `AI_FETCH_MIN_INTERVAL_HOURS` (8 — a few times a day, not
once, so a genuinely new pick still shows up same-day) ago; anything still
pending just waits for the next eligible run. A
push or a manual run always calls it, since either one means someone
specifically wants fresh data now. The footer shows this same timestamp
("AI 最後查詢於 ...") with a "重新查詢" link straight to the Actions run page,
for exactly that manual case — there's no client-safe way for a static page
to trigger a rebuild itself, so the link is as far as the page itself can
take it; actually running it needs the repo owner's GitHub sign-in.

The workflow commits both files back to the repo only when something
actually changed (see `.github/workflows/deploy.yml`'s "Commit updated AI
score cache" step).

**Contested-cluster refinement (a second, comparative pass for close
calls)**: the base scoring call above scores each fixture independently in
one big batch, which is fine for "roughly how good is this" but weak at
"which of these two SPECIFIC overlapping fixtures is actually the bigger
story" - nothing about scoring them separately lets the model weigh them
against each other. After the base pass, `findContestedClusters` groups
fixtures that overlap in time AND scored within `CONTESTED_SCORE_DELTA` of
each other (transitively, so a three-way pileup becomes one cluster, not
three overlapping pairs) and sends each cluster - never the full fixture
list - to the shared proxy's `/match-recommend-refine`, which is allowed to reach for
a Pro-tier model specifically because it only ever sees a handful of
fixtures a day this way. Only `competitiveness`/`watchability`/`reason` get
overwritten by the refined answer; `venueZh`/`whereToWatchTw` stay whatever
the base pass + grounded lookup already decided. Every fixture actually
sent gets cache-stamped `refined: true` so the same cluster isn't resent
forever, and `MAX_REFINE_CLUSTERS_PER_RUN` bounds worst-case Pro-tier spend
per run - refinement runs on the same throttle as the base pass (see
above), so it costs nothing extra on a routine scheduled run that's
already within the cooldown window.

Refine calls are spaced ~4 seconds apart rather than fired back-to-back -
confirmed live that the shared proxy's Pro-tier models aren't currently reachable on
this account (each attempt falls through to the same `gemini-3.7-flash`
the base pass already calls, near-instantly), so a burst of refine calls
right after the base pass's own calls can blow through Gemini's real
requests-*per-minute* cap even though the total count for one run is
small. A few extra seconds of build time is free; re-triggering the same
avoidable rate limit on every eligible run forever is not.

## Deployment

This repo deploys itself: `.github/workflows/deploy.yml` runs
`scripts/build-data.mjs` and publishes `public/` to GitHub Pages —

- on every push to `main`,
- on a schedule (every 15 minutes), so live status/newly-scheduled fixtures
  stay fresh even with no code changes - this only costs a free ESPN fetch
  on most runs, since `AI_FETCH_MIN_INTERVAL_HOURS` (see "AI score cache"
  above) is what actually keeps Gemini calls down to a few times a day
  regardless of how often the workflow itself fires,
- and on-demand via the Actions tab ("Run workflow"), or the "檢查更新"/
  "重新整理資料" buttons in Settings (client-side only - they just re-fetch
  whatever the last scheduled run already published, they can't trigger a
  new one - see public/app.js's checkForUpdate).

Make sure the repo's **Settings → Pages → Source** is set to **GitHub
Actions** (no branch to pick — the workflow handles publishing).

## AI recommendations (optional but recommended)

The competitiveness/watchability scoring is served by a shared Cloudflare
Worker in its own dedicated repo,
[jaypengx-collab/shared-proxy](https://github.com/jaypengx-collab/shared-proxy)
(`worker.js`, route `/match-recommend`) — this repo doesn't hold, and never
needs, a Gemini API key of its own. That Worker also backs two sibling
sites' own AI/sync features (Orbit, Orbit Vocab), so it's already deployed
and configured if either of those is already running. `whereToWatchTw` in
particular is grounded in an actual Google Search lookup on the proxy's
side (broadcast rights are often team/game-specific, not sport-wide — e.g.
some MLB teams' games air exclusively on Apple TV rather than the usual
愛爾達/緯來), rather than answered from the model's static training-time
knowledge alone.

To enable it:

1. Deploy or confirm the shared-proxy Worker is live with `GEMINI_API_KEY`
   set (see that repo's README) — the `/match-recommend` route reuses that
   same key.
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

## Icons and link previews

`public/favicon.svg` is the one master mark; `public/icons/icon-180.png`
(apple-touch-icon, e.g. "加入主畫面" on iOS Safari) and `icon-512.png`
(`manifest.webmanifest`) are rasterized from it, and `public/og-image.png`
(1200×630) is what a shared link's preview card shows (Messages, Slack,
etc. — see the `og:image`/`twitter:image` tags in `index.html`). All three
PNGs were generated once with headless Chromium screenshotting the SVG at
each size/composition — see the render script referenced in this repo's
commit history if the mark itself ever changes and they need regenerating;
there's no build step that does this automatically.

## Fixing a team's Chinese name

Edit `scripts/team-names.mjs` — it's a plain object keyed by league id and
ESPN's team abbreviation (e.g. `mlb.NYY`). A missing or wrong entry doesn't
break anything: the site just shows that team's English name only.
