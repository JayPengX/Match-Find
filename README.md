# Match Find

**Live site: https://jaypengx-collab.github.io/Match-Find/**

A tiny, Traditional-Chinese static site that answers "what's worth watching
today" across the Premier League, MLB, NBA, and F1 — shown in your own
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
empty space repeating it) - Settings (⚙) lives inline with the sport filter
chips instead.

## How it works

Scoring and picking are split across two different places, deliberately:

1. **`scripts/build-data.mjs`** (run by the scheduled GitHub Action below,
   never by a browser) fetches upcoming *and currently-live* fixtures for
   the next 14 days from
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
2. **`scripts/objective-score.mjs` + `scripts/sport-signals.mjs`** compute
   **competitiveness**, **watchability**, **enduranceScore**, and
   **broadcastQuality** for every fixture DETERMINISTICALLY, from real,
   current sports-data APIs - this is the WHOLE score, not a baseline
   something else refines (there is no AI anywhere in this pipeline - see
   "API-data-driven scoring engine" below and
   `docs/recommendation-engine-audit.md`'s Round 11 for why Gemini was
   removed entirely). MLB pulls standings/recent-form/streak data from the
   official MLB Stats API, F1 pulls championship-standings gap from the
   Ergast-compatible Jolpica API, and every sport folds in season record
   and betting odds already fetched from ESPN, plus the same rivalry/derby/
   national-broadcast detectors `scripts/sport-duration.mjs` uses for
   duration. Computed every build, for every fixture.
3. The result — every fixture, scored, nothing filtered or picked yet — is
   written to `public/data/matches.json`.
4. **`public/app.js`'s `resolveViewingPlan`**, running in *your* browser,
   converts every fixture's kickoff to your own local time and applies your
   Settings nudges (sport priority, owned services). The actual "what's
   worth watching today" decision — **one local calendar day at a time**,
   because "what counts as an unreasonable hour" and "which fixtures
   actually conflict" are both relative to *your* clock — happens in
   `computeDayPlan`, described in "The viewing plan" below.

## API-data-driven scoring engine (no AI involved)

competitiveness/watchability/enduranceScore/broadcastQuality used to be
asked from Gemini directly, essentially "from memory," then (for one
intermediate period) computed deterministically first with Gemini
validating the result. Gemini is gone entirely now (see
`docs/recommendation-engine-audit.md`'s Round 11) - every fixture's score
is exactly what `scripts/objective-score.mjs` computes from real, current
statistical signals `scripts/sport-signals.mjs` fetches, nothing more.

**Per-sport signals actually used:**

- **MLB** (the official [MLB Stats API](https://statsapi.mlb.com), free, no
  key): division/wild-card standings proximity (`gamesBack`/
  `wildCardGamesBack` - how alive each team's own playoff race is right
  now), each team's own last-10-games record and current win/loss streak,
  plus season record and betting odds already fetched from ESPN. Team pace
  offsets and the Coors Field modifier from the duration model (see below)
  aren't reused here - a fast/slow-pace team says nothing about how CLOSE a
  given matchup is.
- **F1** (the [Ergast-compatible Jolpica API](https://api.jolpi.ca), the
  community-run successor to the original Ergast API which shut down at
  the end of the 2024 season - also free, no key): the current drivers'
  championship standings gap between P1 and P2, turned into a 0
  (mathematically decided) to 1 (a dead heat) title-race intensity that
  feeds every race that season's watchability - a title fight still very
  much alive makes EVERY remaining race more consequential, independent of
  which circuit it's at.
- **NBA / Premier League**: season record and betting odds already fetched
  from ESPN, plus the same rivalry/derby and national-broadcast detectors
  `scripts/sport-duration.mjs` already computes for the duration model
  (`isNbaRivalry`/`isEplDerby`/`isNationalBroadcast`) - real facts, just
  without a dedicated standings-API integration yet (see "Known
  limitations" below).

**Why Gemini is gone entirely** (`docs/recommendation-engine-audit.md`'s
Round 11): this pipeline used to send every fixture's objective score to
Gemini (via the shared Cloudflare Worker) for a small, bounded validation
adjustment (-2 to +2 per dimension) on top of it. Two independent reasons
killed it, not one: (1) free-tier Gemini quota couldn't sustain the
workload - Google Search grounding (the one thing that could have added
real signal a formula can't see, like an injury) failed with a 429
RESOURCE_EXHAUSTED quota error on 100% of live-tested requests, a
billing-tier wall, not a bug; (2) even the plain validation call, when it
succeeded, was structurally bounded to a ±2 nudge - a live-verified case (a
0-0 preseason exhibition scoring near-maximum competitiveness) showed
Gemini correctly IDENTIFYING the problem in its own reasoning text while
being unable to fix it, because only the deterministic formula itself
could move the score that far. Every fixture's score is now exactly what
`computeMatchObjectiveScore` computes - the same real, current,
statistically-grounded number this engine always primarily relied on, not
the old crude win-rate-only `heuristicScore` from before this engine
existed (long gone). The reason text (`buildObjectiveReasonZh`) is built
from the actual factors behind the score (e.g. "依雙方戰績、近期戰況、
盤口數據計算。").

**Known limitations** (stated plainly rather than left silently
unaddressed, same posture as `docs/recommendation-engine-audit.md`):

- **NBA and Premier League have no dedicated standings-API integration
  yet.** Both score on season record + odds + the existing rivalry/derby/
  national-broadcast detectors - real signals, but shallower than MLB's
  standings-proximity/recent-form depth. A free, no-key NBA/EPL standings
  source (or ESPN's own standings endpoint, not just its scoreboard) would
  be the natural next step.
- **No injury data, and no real-time media/narrative signal at all.**
  Neither is knowable from data this build already fetches, and adding
  either back would mean either a new paid data source or a working
  real-time search/grounding integration - deliberately not attempted
  again without that being a real, separate, budgeted decision (see
  `docs/recommendation-engine-audit.md`'s Round 9/11 for why the AI-search
  route was tried and abandoned).
- **F1's per-race modifiers (safety car, weather) aren't modeled.** Neither
  is knowable before a race starts from data this build already has, and
  adding real weather data would mean taking on a new API key/dependency
  this build doesn't currently need for anything else - deliberately not
  done without that being a real, separate decision (see
  `scripts/sport-duration.mjs`'s own comment on the same trade-off for the
  duration model).

## Local-only, no accounts

Every per-viewer preference - sport priority order, which sports are
enabled, and which swiped match you Prefer for a slot - lives in this
browser's own `localStorage` and nowhere else. There is no sign-up, no
account, and no server-side sync of any kind: an earlier version of this
site had a cross-device settings-sync feature (a shared passcode through
the same shared Cloudflare Worker `/sports-proxy`/`/match-dispatch` use -
see "On-demand refresh" below); it's gone now, on purpose - one browser,
one set of local
preferences, nothing to pair or lose track of across devices. Match
data/scores are the one thing that genuinely IS shared (the same
`matches.json` build serves every viewer), which is exactly why they never
lived in `localStorage` to begin with.

There's also only ever ONE recommendation system, not a choice between
competing ones: `bestMatchScore` (`public/lib/recommendation.mjs`) is the
single blend every viewer's 推薦賽事 is built from - an earlier version let
you pick between two subtly different "recommendation styles"; that choice
added confusion without adding real value, so it's gone. `bestMatchScore`
itself is a weighted blend of five axes (`BEST_MATCH_WEIGHTS`):

- **skill** - how GOOD the two teams actually are (`scripts/objective-score.mjs`'s
  `skillFromWinPct`, from each side's own win%/points-rate) - deliberately a
  separate axis from competitiveness below: two elite teams playing a close
  game and two also-ran teams playing an equally close game score
  identically on closeness alone, but they're not the same recommendation.
  Null for F1 (no per-competitor quality signal exists for a single-driver
  race), renormalized away like any other missing signal.
- **competitiveness** - how CLOSE tonight's specific pairing is (season
  record gap, recent form, betting-market spread)
- **watchability** - entertainment value/mainstream public attention - the
  deterministic objective score's own national-broadcast/rivalry/derby
  detectors and betting-market signal (see "API-data-driven scoring engine"
  above)
- **enduranceScore** - does the contest actually stay meaningful all the
  way through, not just at kickoff
- **broadcastQuality** - production quality of watching it

deliberately never anchored on just one of those axes, so a match that's
exceptional on only one dimension while mediocre on the rest doesn't
automatically win over a well-rounded one; renormalized over whichever of
the five a fixture actually has (a finished/never-scored match, or a sport
missing one signal, still gets a real number built from what IS known). The
one place your own taste actually overrides the algorithm is
**Prefer** - swiping a card stack to commit to a specific alternative (see
"The viewing plan" below) - which is local, explicit, and per-match, not a
blanket ranking toggle.

## The viewing plan

You can only watch one thing at a time, so 推薦賽事 isn't a set of
independent "this one's good" judgments - it's **one continuous back-to-back
plan for the day**, built by `computeDayPlan` in `public/lib/recommendation.mjs`:

- A fixture whose **local** start time falls between midnight and 5am is
  never a candidate, however good its score — this site won't tell you a
  4am kickoff is unmissable. It still shows up in "所有賽事", just never in
  the plan.
- Two fixtures that overlap so much you genuinely can't sequence them - the
  overlap covers at least 75% of the SHORTER one's own length
  (`NEAR_TOTAL_OVERLAP_FRACTION`, `isNearTotalOverlap`) - render as one
  swipeable card stack, not two separate picks. Anything overlapping less
  than that isn't forced into a choice; the plan below just resolves it on
  its own. This grouping is a **presentation label only**, computed after
  the plan below is already decided - every individual fixture is always a
  real candidate for the scheduler itself, never pre-collapsed to one
  representative per overlap group ahead of time (an earlier version did
  that and could silently lose the actually-best plan - see
  `computeDayPlan`'s own comment).
- The plan itself is the maximum-total-score set of NON-overlapping
  fixtures for the day (a real weighted-interval-scheduling chain,
  `computeDayPlan`/`weightedIntervalSchedule`) - not a per-match threshold,
  and not "highest score wins its own little slot, everything else nearby
  is quality-gated or dropped" (both tried in earlier versions - see that
  function's own comment for why each one either hid good games or
  stopped being an actual PLAN). A fixture's own `enduranceScore` decides
  how much of its nominal length actually blocks the next pick from
  starting (`effectiveDurationMinutes`) - a fixture unlikely to stay
  watchable to the end frees the schedule up sooner than its full listed
  length would suggest. **Baseball (and other no-clock sports) get a real
  overrun buffer, not a discount:** a sport with no game clock (MLB - extra
  innings, rain delays) is statistically more likely to run LONG than
  short in real time, never the other way around - a standard 9-inning
  game already averages roughly 2h40m of playing time alone (per MLB's own
  officially published time-of-game figures), and extra innings/a rain
  delay routinely add 30-60+ real minutes on top with no matching
  mechanism that ever finishes a game meaningfully early. An earlier
  version of this pipeline treated that same uncertainty as a DISCOUNT -
  shrinking the reserved block for a low-reliability sport - which was
  backwards, and was the direct cause of a reported bug: the scheduler
  would offer a next pick only ~2h13m into a genuinely great MLB game,
  producing 40-80 real-minute overlaps once the broadcast actually ran
  anywhere near its own average length.
  `DURATION_OVERRUN_BUFFER_BY_RELIABILITY`/`schedulingDurationMinutes`
  (`public/lib/recommendation.mjs`) now only ever PAD a no-clock sport's
  reserved block on top of the endurance-adjusted figure, never shrink it
  below that value judgment - football/F1 (a real game clock) get no pad
  at all, MLB gets the largest. This duration is always an ESTIMATE, never
  a guaranteed end time - ESPN's own live status (`isFinished`) is what
  actually decides a match is over (see `matchLifecycleState` below), this
  only decides how much time the PLAN reserves before offering something
  else. A small fixed buffer (`TRANSITION_BUFFER_MINUTES`) also sits
  between any two back-to-back picks, so "ends at 8:00, starts at 8:00" no
  longer counts as a real gap. **The overrun buffer only ever applies
  before a match is over.** Once ESPN's own status confirms a fixture is
  finished, `durationMinutes` (see `scripts/build-data.mjs`'s
  `finishedDurationMinutes`) stops being a pre-game guess and becomes the
  REAL elapsed broadcast time as of that fetch, and
  `schedulingDurationMinutes` stops padding it any further - there's no
  forward uncertainty left to hedge once the real length is already known.
  This is the direct fix for a reported bug: a finished MLB game that
  genuinely ran 30-60 minutes SHORTER than its own pre-game prediction
  still had another 25% padded on top of that longer, now-known-wrong
  guess, which kept blocking a next match that could obviously,
  actually follow it.
- **The same matchup doesn't default to winning every day of a series.**
  `computeWindowPlan` walks the whole fetched window in date order and
  applies a small, decaying penalty (`applyRecentRepeatPenalties`) to a
  matchup that was already the pick on an EARLIER day - strong enough to
  let a close alternative win instead, never strong enough to override a
  genuinely much better repeat (see `RECENT_REPEAT_PENALTY_BY_GAP_DAYS`).
  This only affects which fixture wins the plan, never the underlying
  score shown on the card. Each day is penalized against its own correct
  history - `computeWindowPlan` exposes a `historyByDayKey` snapshot taken
  BEFORE that day's own picks are folded in, and app.js's
  `dayCandidatesForPlan`/`pinSlotChoice` (which re-derive a single day's
  candidates outside the original chronological pass) read from that, not
  from the flat whole-window `lastRecommendedDayKey`. A flat map only
  remembers one occurrence per matchup - the LAST one anywhere in the
  fetched window - which for a real short back-to-back series is often a
  day AFTER the one being re-queried, silently zeroing out the penalty for
  every earlier occurrence too (a negative or same-day gap is treated as
  "no history"). This was the direct cause of a reported bug: the same MLB
  matchup recommended three days running with no visible penalty at all.
- **Nor does one sport get to dominate the plan by default.** The same
  function ALSO tracks the last few days' own picks by sport
  (`SPORT_CONCENTRATION_LOOKBACK_DAYS`) and applies a small penalty once
  one sport has genuinely dominated that window (≥75% of recent picks,
  `SPORT_CONCENTRATION_THRESHOLD`) - MLB winning most days is normal and
  expected, MLB winning literally every day when a comparable alternative
  exists isn't. `computeWindowPlan`'s own `sportConcentration` return
  value exposes the whole window's actual sport split for anyone
  inspecting `public/data/matches.json` directly, or a copy of it fed to
  `scripts/evaluate-recommendations.mjs` (see "Evaluating a historical
  export" below) - there is no in-app export button for this anymore (see
  "No developer tools in the UI" below).
- **Swiping a stack is a real commitment, not just a peek - this IS
  "Prefer".** Settling on a different card pins that match as the slot's
  fixed choice (`pinSlotChoice`) and rebuilds the WHOLE day's plan around
  it — the matches scheduled both before and after it are freshly reasoned
  about relative to the pin, not just appended after whatever was there
  before. Picking a shorter alternative can free up enough time for a
  fixture that didn't fit before to join the plan afterward. A pin is
  saved to `localStorage` (scoped to one calendar day) and survives a
  reload, same as every other preference in this app - purely local, never
  synced anywhere. Swiping back to whatever the algorithm would already
  have picked for that slot (`naturalSlotChoice`,
  `public/lib/recommendation.mjs`) CLEARS the pin instead of recording one,
  so the card correctly reverts to 推薦 rather than staying mislabeled
  偏好. A pinned card is tagged 偏好 ("preferred") instead of 推薦
  ("recommended") precisely because it's the viewer's own choice
  overriding the algorithm, not the algorithm's own judgment.
- Any card whose start overlaps an **earlier** match — regardless of
  whether either one made the plan — gets a small note saying so and for
  how long ("與「X」重疊 45 分鐘"), a plain fact about the schedule shown
  independently of the plan itself.
- Whichever planned fixture is currently live, or (failing that) the
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
  visible reason - a real, common case for MLB specifically: Taiwan is
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
  once - `resolveWhereToWatchTw` (see "Duration and Taiwan broadcast source
  are deterministic, not AI-guessed" below) always names 愛爾達體育台 when
  both apply, as a fixed rule rather than an answer that could vary
  fixture to fixture.
- Each fixture shows one time range ("7:00 下午 – 9:35 下午") plus a short
  relative countdown next to it, instead of three separate stacked labels -
  the countdown switches from hours to whole days once a fixture is more
  than 24 hours out ("2 天 5 小時後", not "53 小時後"), both computed from
  the fixture's own predicted broadcast length (see "Duration and Taiwan
  broadcast source are deterministic, not AI-guessed" below).
- No competitiveness/watchability meters on the card - just the one-sentence
  AI reason. The numbers still drive the plan itself behind the scenes; the
  page itself only ever shows the recommendation, not the data behind it.
- A recommended fixture with a genuinely can't-watch-both alternative (see
  "The viewing plan" above) renders as a **horizontally swipeable card
  stack** - only one card is on screen by default, the other a deliberate
  swipe away with dots marking how many there are. Swiping is a real
  choice: settling on a different card pins that match as the slot's
  committed pick and rebuilds the rest of the day's plan around it
  (`pinSlotChoice`). A card whose start overlaps an earlier match - whether
  or not either one made the plan - gets a small note naming that match and
  how long they overlap (`computeOverlapRange` in `buildMatchCard`).
  **The stack is driven entirely by explicit Touch/Mouse events and a CSS
  `transform`** (`buildMatchStack` in `app.js`), not native CSS scroll-snap -
  an earlier design (scrollLeft + scroll-snap + a requestAnimationFrame poll
  waiting for native momentum to "settle") went through three separate
  rounds of reported regressions (stuck cards, flicking back, cards landing
  on the wrong index, a stack's dots jumping/shrinking mid-swipe) because
  real touch momentum and native scroll-snap timing vary enough across
  devices and browsers that no fixed poll/threshold tuned against one
  device stayed correct on every other one. A transform is just a plain CSS
  property this code sets directly (`translateX(calc(-index*100% + dragPx))`)
  and reads back exactly what it set - there's no separate physics engine
  whose output has to be inferred after the fact. `touchstart`/`touchmove`/
  `touchend`/`touchcancel` (plus a `mousedown`/`mousemove`/`mouseup` fallback
  for non-touch input) track the gesture directly: a small movement
  threshold decides horizontal-swipe vs. vertical-page-scroll before
  committing to either (so a swipe starting on a stack never fights the
  page's own scroll), a live drag renders immediately as the finger moves
  (with resistance past either end, never a hard stop), and release commits
  to the next/previous card the instant it crosses a distance-or-velocity
  threshold - no polling, no waiting for anything to "settle", since
  nothing is still moving under the hood after that. Deliberately Touch
  Events, not the newer Pointer Events API this went through first: this
  site's own audience is heavily iOS Safari/PWA (see the day-picker's own
  scroll-snap comment on pre-18.2 Safari), and Safari's Pointer Events
  support, while real, has stayed genuinely less mature than Chromium's for
  years (`touch-action` landed late, `setPointerCapture`/`pointercancel`
  timing has had known quirks) - exactly the kind of gap this repo's own
  sandbox can't catch (no WebKit browser is installed there to test
  against at all, only Chromium). Touch Events have had solid, consistent
  Safari support since iOS 2. Verified against a real headless-browser
  reproduction driving actual low-level touch input (Chrome DevTools
  Protocol's `Input.dispatchTouchEvent`, which goes through the full
  browser touch/gesture pipeline - not a `dispatchEvent(new PointerEvent(...))`
  called directly on one element, which bypasses that pipeline entirely and
  had already given a false pass once) across a 3-card chain and a
  synthetic 10-game slate shaped like a real MLB night, including
  deliberately imprecise diagonal gestures. The node-reuse mechanism this replaced (keeping the exact DOM
  node a swipe just landed on alive across the pin's own re-render, tracking
  which member is currently pinned via `wrapper.dataset.primaryId` rather
  than a value captured once at build time) is unchanged - a `transform` is
  just a plain style property, though, so the extra scroll-position
  capture/restore the old scrollLeft-based version needed around that reuse
  (to survive a detach+reattach resetting scroll position on some mobile
  WebKit builds) is gone; there's nothing left to reset.
  A stack's own member list (`alternativeIds` in `recommendation.mjs`)
  is now only the OTHER candidates that DIRECTLY (pairwise) overlap the
  recommended pick, not every member of its wider presentational cluster.
  `groupIntoSlots` groups by a TRANSITIVE chain (card 1 overlaps card 2,
  card 2 overlaps card 3 is enough to union all three, even if 1 and 3
  never overlap each other at all) - harmless for a genuine 3-card cluster,
  but a real MLB night's own games routinely chain 10-14 of them into ONE
  cluster this way (each game reserves ~3-4 hours with buffer, staggered
  only 20-30 minutes apart across the night - confirmed against real
  fetched data via the debug tool below). An earlier version handed the
  swipeable stack every OTHER member of that WHOLE transitive cluster as
  its alternatives, so a viewer could open what looked like a normal
  "pick one of these" stack and find 10+ cards in it, most of which never
  actually conflicted with each other at all - swiping through it landed
  on cards in no order a viewer would recognize, and pinning one card
  could shuffle which OTHER cards were still independently recommended
  elsewhere, since so many pairs in a chain that size are only linked
  transitively. A first attempt at fixing this instead made a pin exclude
  its ENTIRE transitive cluster - which "solved" the shuffling by instead
  silently suppressing every one of those 10+ often-unrelated games from
  being recommended at all the moment a viewer pinned just one of them,
  confirmed wrong against the same real data before it ever shipped.
  Narrowing `alternativeIds` to direct conflicts only (while a pin's own
  hard-exclusion logic, and the stable lookup key a pin is stored under,
  both stay based on the FULL cluster - see that field's own comment)
  keeps every stack small and locally coherent - a real "pick one of these
  2-3 games actually airing at the same time" choice - without suppressing
  any other game the chain happened to also transitively touch.
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
  slate" override (see `resolveWhereToWatchTw` in build-data.mjs)
  explicitly does not apply to F1, even though ESPN's own `broadcast` field
  for F1 also happens to say Apple TV (its real international rights
  holder - a genuinely different, unrelated fact from who carries it in
  Taiwan).

## Sport priority (⚙, in the sport filter row)

`priorityOrder` nudges a match's `effectiveScore` up or down slightly
before it feeds `computeDayPlan`'s scheduling weight (which fixture wins a
genuinely contested, overlapping stretch of the day) - a viewer's
preferred sports win a close scheduling call a little
more easily, their least favorite needs to be a little better to win one -
a small, symmetric tilt (1st-ranked gets the biggest positive nudge,
last-ranked the biggest negative, the exact middle rank gets none), never
enough on its own to make a mediocre match beat a genuinely great one. The
order is stored in `localStorage` (per-browser, nothing sent anywhere) and
re-ranking re-runs the whole plan and re-renders immediately, without
closing the panel or reloading.

## Duration and Taiwan broadcast source are deterministic, not AI-guessed

Two things that used to be either a flat guess or a per-fixture Gemini
judgment call are plain, auditable rules computed entirely from ESPN's own
fixture data (plus, for duration, ESPN's own betting-odds field and,
LIVE, ESPN's own in-progress status - see below) - never a Gemini call:

- **Per-fixture predicted duration** (`scripts/sport-duration.mjs`) — every
  fixture used to get one flat per-league average (every MLB game: 190
  minutes, regardless of which two teams were playing). Real per-team pace
  varies by roughly 20 minutes across MLB alone, so this is now a real
  formula per sport: MLB averages each team's own documented pace offset
  (plus a Coors Field venue modifier, a fixed 2026 Automated Ball-Strike
  challenge-review padding, and a bounded modifier from the betting
  market's own total-runs line - `mlbOddsDurationModifier`, more total runs
  means more baserunners/pitching changes and real additional broadcast
  time), NBA adds an expected-value overtime term plus a rivalry/national-
  broadcast modifier, EPL adds a derby modifier (clamped to a realistic
  min/max), and F1's race session uses a per-circuit baseline (fuzzy-matched
  from ESPN's own circuit name) capped at the sport's real regulatory
  maximum. Every input here is a fact already available PRE-GAME from
  ESPN's own scoreboard (team names, venue, national broadcaster, betting
  odds) - nothing here is a guess: an unrecognized team/circuit just
  contributes a neutral default rather than skewing the estimate or failing
  the build. This feeds every scheduling decision downstream (`public/lib/
  recommendation.mjs`'s `effectiveDurationMinutes`/
  `schedulingDurationMinutes`/overrun buffer), not just the on-card time
  range, so a more accurate per-fixture number improves the whole viewing
  plan, not just what's printed on one card.

  Once a fixture is actually LIVE, `estimateLiveDurationMinutes`
  (`public/lib/recommendation.mjs`, called from `public/app.js`'s
  `pollLiveMatches` - see "Live score/odds polling" above) further corrects
  this SAME `durationMinutes` field from ESPN's own real-time progress
  (current inning/quarter+clock/match-minute), blended with the pre-game
  estimate rather than replacing it outright. This is the direct answer to
  MLB's own reported "estimate drops out by 30-60 real minutes" gap: the
  pre-game formula above is still a genuine prediction with real
  uncertainty (extra innings and rain delays are not knowable in advance),
  but a live game's own actual pace can now correct that estimate in real
  time instead of the schedule staying pinned to a single guess for the
  whole broadcast.
- **Taiwan broadcast source** (`resolveWhereToWatchTw` in
  `scripts/build-data.mjs`) — 愛爾達體育台 is the hardcoded default for
  every sport this site covers. The one exception is MLB's Apple TV
  "Friday Night Baseball" package, a genuine global streaming exclusive
  with no regional blackout - ESPN's own `broadcast` field (already
  fetched for every fixture) already reports this reliably, so detecting
  it is a plain string check (`/apple\s*tv/i` against that field, MLB
  fixtures only), never a live search or a model guess.

**Gemini has no role here at all, or anywhere else in this pipeline** (see
`docs/recommendation-engine-audit.md`'s Round 11) - both duration and
broadcast source are, and have long been, fully deterministic from data
ESPN already provides.

## Broadcast service registry (logos, and "do I actually have this?")

`SERVICES` in `public/app.js` maps `whereToWatchTw` text (a fixed rule's
output, see `resolveWhereToWatchTw` above, not free-form AI wording) to a
small badge for exactly three services this site's own viewer actually
tracks: 愛爾達, Apple TV, Netflix - kept text-matched rather than collapsed
to an enum only so a future third service has a ready slot. Any *other*
broadcaster still shows up as plain text on the card either way (see
`watch-text` in `buildMatchCard`) - it just doesn't get a logo/color badge,
since this registry only exists to badge the handful of services actually
worth tracking.
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

## Scoring runs in the background, not on page load

Nothing in the browser ever computes a fixture's score - that stays
entirely server-side, in the scheduled build (see "Deployment" below),
unattended; by the time anyone opens the page, every fixture in the window
is already scored and sitting in a static file. The browser DOES talk to
two read-only/trigger-only endpoints on the shared proxy - `/sports-proxy`
(live score/odds polling, see "Live score/odds polling" below) and
`/match-dispatch` (the manual "重新整理資料" refresh button, see "On-demand
refresh" below) - both entirely optional (silently unavailable if
`PROXY_URL` isn't configured at build time) and neither one calls Gemini or
any other AI - see the shared proxy's own README for what else the same
Worker serves.

## One update path: on load, and exactly when a relevant match starts or ends

Fetching `public/data/matches.json` itself still follows exactly one path,
no blind polling - a tab left open re-fetches it at exactly three kinds of
moment, never on a "check again in N minutes" schedule regardless of
whether anything relevant is actually about to change:

1. **On load.**
2. **When a currently-loaded match's own start time arrives.**
3. **When a currently-loaded match's own estimated broadcast end arrives**
   (an ESTIMATE, not a guarantee - see "Baseball (and other no-clock
   sports) get a real overrun buffer" below; a no-clock sport can still run
   past it, which just means the actual "is this really over" answer comes
   from ESPN's own status the next time this fires, not from the estimate
   itself).

`scheduleNextUpdate` (`public/app.js`) computes the single soonest such
instant across every currently-loaded match (`nextRelevantTransitionMs`)
and sets exactly one `setTimeout` for it - never a second, competing timer,
and never `setInterval`. Each check reacts based on what actually changed,
using `buildId` (the git commit the build ran from — `.github/workflows/
deploy.yml` passes `github.sha`) to tell two cases apart:

- **New data, same code** (a routine scheduled rebuild of the same commit —
  `buildId` unchanged): refreshes silently, keeping whatever day/filter the
  viewer already has selected, then schedules the next check.
- **New code** (a real commit was deployed — `buildId` changed): this tab
  is still running the *old* JS/CSS/HTML no matter how fresh the data
  underneath it is, so a silent refresh can't actually pick up whatever
  changed in the code - the page navigates itself to a cache-busting URL
  (`location.replace`) instead of trying to patch itself up in place.

The two manual Settings buttons (檢查更新/重新整理資料) call the exact same
function, so "how a matches.json refresh happens" only ever exists in one
place - though 重新整理資料 now ALSO fires an on-demand rebuild (see below),
which is what actually gets fresh ESPN data into that file sooner than the
next scheduled cron tick.

## Live score/odds polling

The one update path above is deliberately event-driven, never a blind
timer - but a genuinely LIVE match's own real-time score is the one thing
that design can't provide by itself (`matches.json` is only ever as fresh as
the last build, at most every 15 minutes). `pollLiveMatches`
(`public/app.js`) is a narrowly-scoped exception: while at least one
currently-loaded match is actually live, it polls the shared proxy's
`/sports-proxy` route (a thin, host-allowlisted CORS passthrough to ESPN's
own public scoreboard - browsers can't read ESPN's response directly, it
sets no CORS headers for arbitrary origins) every 30 seconds for just that
match's own league, and merges the real score/status straight into memory.
Paused while the tab is hidden or a card stack is mid-swipe (same
`isStackBeingInteractedWith` guard the scheduled update path already uses),
and silently unavailable when `PROXY_URL`/`state.proxyUrl` isn't
configured.

This never re-runs objective scoring - it only updates the same
`competitors[].score`/`isFinished`/odds fields ESPN itself already reports,
plus two further, real-time-only refinements built from them:

- **`liveExcitementBonus`** (`public/lib/recommendation.mjs`) - a small,
  bounded bonus added to a live match's `planningScore` (never its true
  `effectiveScore`, same "adjustment, not override" posture as every other
  nudge in this file) from how close its REAL current score is, weighted by
  how far into the game it already is. A live match that turns out to be a
  genuine nail-biter can win a scheduling slot a pre-game prediction alone
  wouldn't have given it - the whole day's plan is recomputed after every
  live poll that actually changed something, so this can visibly reshuffle
  what's recommended next.
- **`estimateLiveDurationMinutes`** (`public/lib/recommendation.mjs`) -
  live-corrects the pre-game broadcast-length estimate from ESPN's own
  current inning (MLB)/quarter+clock (NBA)/match-minute (Premier League),
  extrapolating the REAL pace observed so far forward to the sport's full
  length and blending it with the original estimate. F1 has no live per-lap
  timing feed available from this build's own APIs, so it always keeps its
  pre-race estimate. This directly narrows the reported "MLB's estimate can
  drop out by 30-60 real minutes" gap - a live game's own actual pace now
  corrects its schedule-blocking length in real time instead of staying
  pinned to a single pre-game guess for its whole broadcast.

## On-demand refresh

Settings' **重新整理資料** button triggers a real rebuild now, not just a
re-read of whatever the last scheduled run already published - it fires the
shared proxy's `/match-dispatch` route (see that repo's worker.js), which
runs a `workflow_dispatch` against this repo's own `deploy.yml`: the exact
same build the 15-minute cron runs (fresh ESPN/live data, objective score
recomputed), just sooner.

Needs the shared proxy's `MATCH_FIND_DISPATCH_TOKEN` secret configured (see
that repo's README) - a GitHub PAT scoped narrowly to this repo's own
Actions. Silently unavailable (the button explains why) when `PROXY_URL`
isn't configured, or when that secret isn't set (the dispatch request
itself just fails, same as any other network error this page already
handles gracefully).

## No developer tools in the UI

An earlier version of Settings had a "開發者工具" section with a "匯出推薦
資料" button (a client-side JSON download of the current plan, for
inspecting `scripts/evaluate-recommendations.mjs` against). It's gone -
that's not a viewer-facing feature, and `scripts/evaluate-recommendations.mjs`
still works fine against a `public/data/matches.json` copy saved any other
way (a browser's own devtools, or straight from a GitHub Actions run).
Settings now shows only what an ordinary viewer would actually use.

## Deployment

This repo deploys itself: `.github/workflows/deploy.yml` runs
`scripts/build-data.mjs` and publishes `public/` to GitHub Pages —

- on every push to `main`,
- on a schedule (every 15 minutes), so live status/newly-scheduled fixtures
  stay fresh even with no code changes - a free ESPN fetch plus a free,
  local objective-score recompute, no external scoring call of any kind,
- and on-demand via the Actions tab ("Run workflow"), or the "檢查更新"/
  "重新整理資料" buttons in Settings (client-side only - they just re-fetch
  whatever the last scheduled run already published, they can't trigger a
  new one - see public/app.js's checkForUpdate).

Make sure the repo's **Settings → Pages → Source** is set to **GitHub
Actions** (no branch to pick — the workflow handles publishing).

## The shared proxy (optional - live scores and manual refresh only)

`PROXY_URL` points at a shared Cloudflare Worker in its own dedicated repo,
[jaypengx-collab/shared-proxy](https://github.com/jaypengx-collab/shared-proxy),
that also backs two sibling sites' own AI/sync features (Orbit, Orbit
Vocab) - but as of `docs/recommendation-engine-audit.md`'s Round 11, Match
Find itself no longer calls it for any AI/scoring purpose at all. The two
routes this site's browser still talks to (`/sports-proxy` for live score
polling, `/match-dispatch` for the manual "重新整理資料" refresh button - see
their own sections above) are both plain data/trigger passthroughs with no
Gemini involvement.

To enable those two optional features:

1. Deploy or confirm the shared-proxy Worker is live (see that repo's
   README) and, for `/match-dispatch`, that it has a
   `MATCH_FIND_DISPATCH_TOKEN` secret configured.
2. In **this** repo's **Settings → Secrets and variables → Actions →
   Variables**, add `PROXY_URL` set to that Worker's base URL (e.g.
   `https://orbit-workers-proxy.<you>.workers.dev`, **no path suffix**).
   This is a plain variable, not a secret: the value carries no credential.
3. Push to `main` (or run the workflow manually).

Leaving `PROXY_URL` unset is fine; the site just runs without live score
polling or the manual refresh button - scoring itself is entirely
unaffected either way, since it was never gated on this.

## Running locally

```bash
node scripts/build-data.mjs        # writes public/data/matches.json
npx serve public                   # or any static file server
```

No API key or setup needed for scoring itself - `scripts/objective-score.mjs`
and the MLB/F1 API signal fetches (`scripts/sport-signals.mjs`) run entirely
from free, public, no-key APIs. Set `PROXY_URL` in your shell first only if
you want to exercise the live-score-polling/manual-refresh features
locally too.

## Tests

`public/lib/recommendation.mjs` holds every pure scoring/viewing-plan
function (recommendation style blending, overlap/slot grouping, weighted
interval scheduling, `computeDayPlan`, `resolveViewingPlan`, confidence) -
extracted out of `public/app.js` specifically so it's testable without a
DOM and reusable from `scripts/build-data.mjs`. `npm test` (`node --test`,
no dependencies to install) runs `tests/*.test.mjs` against it, plus
`scripts/build-data.mjs`'s own pure ESPN-shape helpers (including
`resolveWhereToWatchTw`/`computeDurationMinutes`/`computeMatchObjectiveScore`),
`scripts/sport-duration.mjs`'s own per-sport duration formulas,
`scripts/objective-score.mjs`'s own deterministic scoring formulas
(`tests/objective-score.test.mjs`), `scripts/sport-signals.mjs`'s own pure
API-response parsing (`tests/sport-signals.test.mjs` - hand-built fixtures
shaped like the MLB Stats API/Jolpica F1 API's own documented formats, not
a live response - see that module's own top-of-file comment), and
`scripts/evaluate-recommendations.mjs` below. Also runs as its own step in
`.github/workflows/deploy.yml`, before the build step, on every push/
schedule/dispatch. See `docs/recommendation-engine-audit.md` for the fuller
writeup of what's covered and why.

## Evaluating a historical export

`node scripts/evaluate-recommendations.mjs <export.json> [more.json ...]`
reads one or more `public/data/matches.json`-shaped files - a copy saved
straight from the live site (or a GitHub Actions build artifact/log) works
fine; there is no in-app export button anymore (see "No developer tools in
the UI" below) - and reports recommended count/rate, sport concentration, score/confidence
distributions, and how often the same two teams (or F1 session) get
recommended across multiple distinct dates in the export - reported as a
descriptive rate, not flagged as a bug, since a real multi-game series is
supposed to do exactly that in a day-by-day plan (see `computeDayPlan`
above). Accepts multiple files so it can be pointed at a week's worth of
separately-saved exports at once instead of judging one day in isolation.

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
