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

No sign-up, no app — it's a static GitHub Pages site, deployed only when
its own code changes, installable as a PWA. The match list itself is
fetched and scored LIVE, in your own browser, every time you open it and
on an ongoing refresh after that (see "How it works" below) - not from a
periodically-rebuilt static file the way this site used to work. There's
no in-page header at all (an earlier version had a slim one; dropped
entirely - an installed PWA's home-screen icon/OS title bar already
carries the app's identity, so a masthead here was just empty space
repeating it) - Settings (⚙) lives inline with the sport filter chips
instead.

## How it works

Scoring and picking are split across two different places, deliberately:

1. **`public/lib/match-builder.mjs`'s `buildMatches`**, called directly by
   *your own browser* (through the shared proxy - see "Live match data and
   manual refresh" below; also callable from Node via
   `scripts/build-data.mjs`, kept only for local dev/debugging tooling),
   fetches upcoming *and currently-live* fixtures for the next 14 days from
   [ESPN's public scoreboard API](https://site.api.espn.com) — no API key
   needed for this part. Only a FINISHED fixture is excluded - every
   refresh re-fetches ESPN's live feed, so a fixture that was still
   upcoming last refresh has very often already started by the next one;
   dropping it the moment ESPN flips it to "live" used to mean a match a
   viewer was actively watching would simply vanish from "today" mid-game,
   even though the client already has everything it needs
   (relativeLabel/`.is-live`, see "Page layout" below) to show it as 直播中
   once it's actually in the data. Each fixture comes with both teams'
   ESPN-hosted logo and a Traditional Chinese name looked up from
   `public/lib/team-names.mjs` (a static, best-effort translation table —
   see that file's own comment; a team missing from it just shows
   English-only).
2. **`public/lib/objective-score.mjs` + `public/lib/sport-signals.mjs`**
   compute **competitiveness**, **watchability**, **enduranceScore**, and
   **broadcastQuality** for every fixture DETERMINISTICALLY, from real,
   current sports-data APIs - this is the WHOLE score, not a baseline
   something else refines (there is no AI anywhere in this pipeline - see
   "API-data-driven scoring engine" below and
   `docs/recommendation-engine-audit.md`'s Round 11 for why Gemini was
   removed entirely). MLB pulls standings/recent-form/streak data from the
   official MLB Stats API, F1 pulls championship-standings gap from the
   Ergast-compatible Jolpica API, every sport folds in season record and
   real market odds (Polymarket - see "Live win% odds" below) already
   fetched, plus the same rivalry/derby/national-broadcast detectors
   `public/lib/sport-duration.mjs` uses for duration. Computed on every
   refresh, for every fixture.
3. The result — every fixture, scored, nothing filtered or picked yet — is
   what `buildMatches` returns, straight back to the caller (no
   intermediate file for the deployed site - `scripts/build-data.mjs` can
   still write one to `public/data/matches.json` for local dev tooling,
   see "Local dev tooling" below).
4. **`public/app.js`'s `resolveViewingPlan`**, still running in *your*
   browser, converts every fixture's kickoff to your own local time and
   applies your Settings nudges (sport priority, owned services). The
   actual "what's worth watching today" decision — **one local calendar
   day at a time**, because "what counts as an unreasonable hour" and
   "which fixtures actually conflict" are both relative to *your* clock —
   happens in `computeDayPlan`, described in "The viewing plan" below.

## API-data-driven scoring engine (no AI involved)

competitiveness/watchability/enduranceScore/broadcastQuality used to be
asked from Gemini directly, essentially "from memory," then (for one
intermediate period) computed deterministically first with Gemini
validating the result. Gemini is gone entirely now (see
`docs/recommendation-engine-audit.md`'s Round 11) - every fixture's score
is exactly what `public/lib/objective-score.mjs` computes from real, current
statistical signals `public/lib/sport-signals.mjs` fetches, nothing more.

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
  `public/lib/sport-duration.mjs` already computes for the duration model
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
  `public/lib/sport-duration.mjs`'s own comment on the same trade-off for the
  duration model).

## Local-only, no accounts

Every per-viewer preference - sport priority order, which sports are
enabled, and which swiped match you Prefer for a slot - lives in this
browser's own `localStorage` and nowhere else. There is no sign-up, no
account, and no server-side sync of any kind: an earlier version of this
site had a cross-device settings-sync feature (a shared passcode through
the same shared Cloudflare Worker `/sports-proxy` uses - see "Live match
data and manual refresh" below); it's gone now, on purpose - one browser,
one set of local preferences, nothing to pair or lose track of across
devices. Match data/scores are fetched and scored independently by each
viewer's own browser now (see "How it works" above) - never shared or
synced between viewers, and never stored in `localStorage` either, since
they're cheap to re-derive live and would just go stale sitting there.

There's also only ever ONE recommendation system, not a choice between
competing ones: `bestMatchScore` (`public/lib/recommendation.mjs`) is the
single blend every viewer's 推薦賽事 is built from - an earlier version let
you pick between two subtly different "recommendation styles"; that choice
added confusion without adding real value, so it's gone. `bestMatchScore`
itself is a weighted blend of five axes (`BEST_MATCH_WEIGHTS`):

- **skill** - how GOOD the two teams actually are (`public/lib/objective-score.mjs`'s
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
  above). Neither a rivalry/derby/big-club name nor a division leader's own
  "stakes" reading can lift this more than `MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS`
  (3) points above tonight's own competitiveness - added after a live case
  (`docs/recommendation-engine-audit.md`'s Round 23) where a 96-60 Dodgers
  team, already clinched, blowing out a 64-92 last-place Giants team still
  scored a maxed-out watchability purely from "Dodgers-Giants" being a
  historic rivalry name, outranking a genuinely live playoff race
  elsewhere that night. MLB's own rivalry bonus additionally doesn't fire
  at all below a competitiveness floor (`MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS`,
  MLB only - NBA/EPL have no standings-API integration yet, so a low
  competitiveness there can still be early-season sampling noise a
  genuinely elite club should survive, see "Known limitations" below).
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
  finished, `durationMinutes` (see `public/lib/match-builder.mjs`'s
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
  inspecting a `matches.json`-shaped snapshot directly (see "Local dev
  tooling" below for how to get one), or a copy of it fed to
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
  fetched 14-day window, all up front once the full-window refresh lands
  (a fast near-term refresh populates today/tomorrow first - see "Live
  match data and manual refresh" below), no "load more" click needed once
  it has. Defaults to today, but jumps ahead to the next day that still has
  a fixture to come if today's are all already over.
- A single horizontally-scrolling row below the day picker holding both the
  **sport filter chips** (全部/英超/MLB/...), built only from sports
  actually present in the enabled set (see "Enabled sports settings"
  below), and the Settings (⚙) button - last in that row, not first, so a
  growing sport list scrolls rather than pushing it around. Picking a chip
  narrows both sections below to one sport.
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

- **Per-fixture predicted duration** (`public/lib/sport-duration.mjs`) — every
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
  `public/lib/match-builder.mjs`) — 愛爾達體育台 is the hardcoded default for
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

## Scoring runs live, in your own browser

Every fixture's score is computed fresh, by *your own browser*, every time
you open this page and on an ongoing refresh after that - not once, ahead
of time, on a schedule, in a server-side build the way this site used to
work (that whole build-and-redeploy cycle is gone; see
`docs/recommendation-engine-audit.md`'s own note on why). The browser talks
to exactly one endpoint on the shared proxy, `/sports-proxy` - a thin,
host-allowlisted CORS passthrough to ESPN/the MLB Stats API/Jolpica/
Polymarket's Gamma API (none of the four sets CORS headers for arbitrary
origins, so a browser can't read any of their responses directly) - never
Gemini or any other AI. See the shared proxy's own README for what else
the same Worker serves.

## Live match data and manual refresh

`buildMatches` (`public/lib/match-builder.mjs`) - the same fetch-and-score
pipeline described in "How it works" above - runs on TWO refresh tiers,
both through `/sports-proxy`, chosen because ESPN's own scoreboard endpoint
has no multi-day range query for a team sport (confirmed live - only F1's
own `racing/f1` endpoint accepts one), so fetching the WHOLE 14-day window
really is one request per league per day, not something a single cheap
query could replace:

- **Near-term** (today + tomorrow, `NEAR_TERM_DAYS_AHEAD`) - cheap, a
  handful of requests, so this runs often (`NEAR_TERM_REFRESH_MS`, every
  60 seconds): new fixtures, scores, and odds for what's actually happening
  soon are the ones worth being genuinely live about.
- **Full window** (the whole 14-day horizon) - expensive (~50+ requests),
  so this runs far less often (`FULL_REFRESH_MS`, every 5 minutes): a
  fixture 10 days out doesn't need up-to-the-minute freshness.

Both tiers merge into whatever's already loaded BY ID (`mergeFreshMatches`)
rather than replacing it wholesale - the near-term tier only ever re-fetches
a couple of days, so a wholesale replace would wipe out every far-future
day the last full refresh already populated; and `buildMatches` itself
degrades a single league's own fetch failure to an empty list for just that
league rather than throwing, so replacing the whole match set with a result
where one league came back empty would delete every match of that league
from the page over a single transient network blip. `mergeFreshMatches` also
carries forward each match's own `.live` detail and live-corrected
`durationMinutes` (see "Live score/odds polling" below) rather than letting
the fresh, pre-game-only `buildMatches()` result silently wipe them - an
earlier version didn't, so the live status widget visibly disappeared and
reappeared on every single near-term/full-window tick until the next live
poll (up to 30s later) put it back.

Settings' **立即重新整理** button just re-runs the full-window tier
immediately, in your own browser - there's no server-side rebuild to
dispatch and wait 30-60 seconds for anymore; a manual refresh is exactly as
fast as the automatic ones.

### Efficiency: caching and instant paint

Two layers of caching keep this from being as expensive as it sounds, since
both refresh tiers plus live polling can otherwise add up to several times
the shared proxy's own per-IP rate limit on a single open tab alone:

- **In-tab request cache** (`proxyFetchJson` in `public/app.js`) - every
  `buildMatches()` call's own fetches are cached in memory, per exact
  upstream URL, for `PROXY_FETCH_CACHE_TTL_MS` (45s), with concurrent
  identical requests coalesced into one in-flight call. Near-term and
  full-window's own date ranges overlap heavily (today/tomorrow are fetched
  by both), so without this, every single page load re-fetched the same
  handful of URLs twice, back to back, for no reason - this doesn't apply
  to `pollLiveMatches`'s own faster tier, which always makes a fresh request
  every tick since live score/odds data can't tolerate a 45s-old cache.
- **Shared edge cache** (`SPORTS_PROXY_CACHE_TTL_SECONDS` in
  `jaypengx-collab/shared-proxy`'s `worker.js`) - `/sports-proxy` itself
  caches every successful upstream response for 20 seconds, keyed by the
  upstream URL alone, so concurrent viewers (and this tab's own live-poll
  tier, which isn't covered by the in-tab cache above) share one real
  upstream fetch instead of each paying for their own; a cache hit doesn't
  count against that route's own rate limit either.

Every successful build is also cached to `localStorage`
(`matchfind-match-snapshot`) and painted immediately on the NEXT page load,
before any network request for that load has even started - the real
refresh tiers still always run right behind it and quietly correct whatever
the snapshot showed, so this is purely a perceived-load-time fix (a viewer
on a slow connection sees last visit's own list instantly instead of a blank
shell), never a substitute for a real fetch. A snapshot older than
`MATCH_SNAPSHOT_MAX_AGE_MS` (30 minutes) is ignored rather than painted,
since a stale-enough copy is more likely to mislead (a finished-vs-still-
scheduled fixture) than to help.

## Live score/odds polling

A THIRD, even faster tier on top of the two above - `pollLiveMatches`
(`public/app.js`) polls just SCORE/STATUS/ODDS for whatever's already
loaded, on a much shorter interval (`LIVE_POLL_INTERVAL_MS`, 30 seconds)
than re-scoring a whole fetch batch could reasonably run at, by hitting
each sport's own narrow live-scoreboard endpoint (today ± a day, not the
whole window) through the same `/sports-proxy` route and merging the
result straight into the same match objects `buildMatches` already
produced - never re-running the scoring/duration/objective-factor pipeline
itself. `init()` also runs this once immediately on load, rather than
letting the FIRST call wait for `LIVE_POLL_INTERVAL_MS` to elapse the way
every later recurring tick does - without that, the live status widgets
(see "sport-specific live in-progress widget" below) couldn't appear any
sooner than 30 seconds after every single page load, since `match.live` is
only ever set here. Paused while the tab is hidden. Score/status comes from
ESPN's own public scoreboard; odds comes from Polymarket instead (see "Live
win% odds" below) - two separate fetches, since not every sport this tracks
has
both (F1 has real, live Polymarket odds but no ESPN score to poll at all).

This never re-runs objective scoring - it only updates the same
`competitors[].score`/`isFinished`/odds fields ESPN/Polymarket already
report, plus two further, real-time-only refinements built from them:

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

Each team row also shows a `.team-score` (`buildTeamRow` in `public/app.js`)
whenever the match is genuinely LIVE/ENDING_SOON or already finished - never
pre-game, where ESPN's own "0" isn't a real score yet, just the absence of
one. This is the actual score; the widgets below only ever show in-progress
DETAIL (inning, quarter, lap) around it, never the score itself.

Each live poll also writes a `match.live` object with whatever in-progress
detail ESPN reports for that sport, rendered as a small icon-led widget
right under the team names (`buildLiveStatusNode` in `public/app.js`, only
while the card is genuinely LIVE/ENDING_SOON, never pre-game or finished) -
built as real glyphs rather than a flat sentence, since a plain text line
was reported as easy to miss scanning a busy list of cards:

- **MLB**: a small broadcast-style diamond (`.live-diamond`) with a dot at
  each of 1st/2nd/3rd that lights up green exactly when a runner is
  actually on it, next to the inning + half ("第 6 局上/下/中/完") and an
  outs indicator (3 dots, filled as outs accrue) - from ESPN's own
  `competition.situation` object (`public/lib/espn.mjs`'s
  `extractLiveUpdates`). The ball-strike count from that same object is
  deliberately NOT shown - it changes on every single pitch (seconds
  apart), so a fixed 30s poll interval almost never catches the current
  count, only a stale one.
- **NBA**: a pulsing live dot plus the quarter ("第 N 節", OT beyond the
  4th) and ESPN's own last-reported game clock - never locally ticked
  between polls, so it correctly holds at the exact recorded time until
  the next update lands rather than counting down on its own.
- **Premier League**: a pulsing live dot plus the half (上半場/下半場) and
  ESPN's own match clock (which already includes stoppage time in its own
  text, e.g. "45'+2'") - or ESPN's own state word (e.g. a halftime label)
  shown as-is when there's no numeric clock to attach it to. Same as NBA,
  this is ESPN's own last-reported value, never locally ticked.
- **F1**: a small colored flag icon (green/yellow/red/safety-car/checkered,
  read from ESPN's own status text, e.g. "Safety Car" or "Checkered Flag" -
  the caution flags flash to catch the eye the way a real broadcast overlay
  would) plus the current lap - from a second extractor
  (`extractF1LiveUpdates`) reading the same racing/f1 scoreboard
  match-builder.mjs already uses for the schedule, this time for its
  per-session `competitors` array (drivers, ordered by ESPN's own live
  classification). The race's current top 3 also renders as its own row of
  medal-colored rank chips (gold/silver/bronze), each with that driver's
  own nationality flag (`athlete.flag` - the one real per-driver icon this
  API actually has; there's no headshot or constructor/team field at all)
  and a gap/interval figure IF ESPN ever reports one (checked against
  several real race weekends - `competitor.statistics` came back empty
  every time, so this is read defensively rather than guessed/computed),
  right under the static outright win% chips (see "Live win% odds" below) -
  live running order as context for those odds, not a replacement.

## Foreground-return refresh and the "next update" countdown

Every refresh timer above (near-term/full-window/live-poll) reschedules
itself on its own fixed interval even while the tab is hidden - it just
skips the actual fetch each tick (see each one's own comment in
`public/app.js`). Left alone, a tab backgrounded for several minutes and
brought back gets nothing fresher until whichever timer next happens to
fire, by accident of when it was hidden - reads as "the app doesn't notice
I came back" even though a refresh was genuinely overdue. A
`visibilitychange` listener (`handleForegroundReturn`) tracks how long the
tab was actually hidden and, once it's visible again, forces an immediate
near-term refresh + live poll right away (plus the full window too, if the
tab was away at least `FULL_REFRESH_MS` itself) - but only once the tab was
away longer than `FOREGROUND_STALE_MS` (30 seconds), so a quick app-switch-
and-back doesn't double up on a refresh that just ran moments ago.

A small `#next-update-note` readout in the footer ticks down every second
to the soonest of the three tiers' own next-scheduled instant (the live
poll only counts while something's actually worth polling - see
`matchWorthPollingNow`), so a viewer watching a live match can see exactly
when its next update is coming rather than only finding out after the
fact.

## Live win% odds

Every card that has a real market open for it shows a devigged win%
sourced from Polymarket (`public/lib/polymarket.mjs`) - never a guessed or
defaulted 50/50, hidden entirely when no market exists yet for that
fixture. Chosen over a sportsbook-odds feed (an earlier version of this
feature used ESPN's own) specifically because a real prediction market's
own trade price already IS a probability (no American-odds conversion
needed), and it runs a genuine market on every sport this site tracks,
including F1 (an outright race-winner market across the whole grid - shown
as the top 3 favorites, not a two-sided bar, since that wouldn't make
sense for a 20-driver field) - something no sportsbook feed here ever
covered. MLB/NBA get a single combined two-outcome market; EPL's own
market is a genuine three-outcome one (home/draw/away), read from three
separate binary markets in the same event and devigged together. Each
side of a two-/three-way bar is colored with that TEAM's own real brand
color (`public/lib/color.mjs`'s WCAG contrast check - falling back to a
fixed sport accent only when neither of a team's two colors reads legibly
against the card's current background).

## No developer tools in the UI

An earlier version of Settings had a "開發者工具" section with a "匯出推薦
資料" button (a client-side JSON download of the current plan, for
inspecting `scripts/evaluate-recommendations.mjs` against). It's gone -
that's not a viewer-facing feature, and `scripts/evaluate-recommendations.mjs`
still works fine against a `matches.json`-shaped copy saved any other way
(a browser's own devtools, or `node scripts/build-data.mjs` locally - see
"Local dev tooling" below). Settings now shows only what an ordinary
viewer would actually use - one "立即重新整理" button (see "Live match data
and manual refresh" above).

## Deployment

This repo deploys itself: `.github/workflows/deploy.yml` publishes
`public/` to GitHub Pages on every push to `main` (or on-demand via the
Actions tab). There is no scheduled rebuild anymore, and nothing for it to
rebuild - the match list is fetched and scored live, in each viewer's own
browser, on load and on its own two refresh tiers (see "Live match data
and manual refresh" above), not from a static file this workflow used to
regenerate every 15 minutes. This workflow's only job is shipping CODE
changes.

Make sure the repo's **Settings → Pages → Source** is set to **GitHub
Actions** (no branch to pick — the workflow handles publishing).

## The shared proxy (required - this is how live data actually reaches the page)

`public/app.js`'s own `PROXY_URL` constant points at a shared Cloudflare
Worker in its own dedicated repo,
[jaypengx-collab/shared-proxy](https://github.com/jaypengx-collab/shared-proxy),
that also backs two sibling sites' own AI/sync features (Orbit, Orbit
Vocab) - but as of `docs/recommendation-engine-audit.md`'s Round 11, Match
Find itself no longer calls it for any AI/scoring purpose at all. The one
route this site's browser talks to, `/sports-proxy`, is a plain,
host-allowlisted CORS passthrough with no Gemini involvement - see "Live
match data and manual refresh" above for why this page needs it at all
(ESPN/the MLB Stats API/Jolpica/Polymarket send no CORS headers, so a
browser can't read any of their responses directly).

Unlike Orbit/Orbit Vocab's own `PROXY_URL` (a GitHub Actions Variable
substituted in at their own build time), Match Find has no build step left
to substitute anything into - its `PROXY_URL` is a plain constant written
directly into `public/app.js`'s own source, pointing at the real deployed
Worker. If you fork this repo and deploy your own shared-proxy Worker,
update that constant to your own Worker's base URL (**no path suffix**);
there's no environment variable to set instead.

## Local dev tooling

`scripts/build-data.mjs` is a thin Node CLI wrapper around
`public/lib/match-builder.mjs`'s own `buildMatches` - the exact same
fetch-and-score pipeline the deployed site runs live in the browser, just
callable directly from Node (which can reach ESPN/Polymarket/the MLB Stats
API/Jolpica without going through the shared proxy at all). Kept purely
for local dev/debugging tooling - the deployed site itself no longer
depends on it or its output.

```bash
node scripts/build-data.mjs        # writes a public/data/matches.json snapshot
npx serve public                   # or any static file server
```

No API key or setup needed - `public/lib/objective-score.mjs` and the
MLB/F1 API signal fetches (`public/lib/sport-signals.mjs`) run entirely
from free, public, no-key APIs, and this CLI calls them directly rather
than through the shared proxy.

## Tests

`public/lib/recommendation.mjs` holds every pure scoring/viewing-plan
function (recommendation style blending, overlap/slot grouping, weighted
interval scheduling, `computeDayPlan`, `resolveViewingPlan`, confidence) -
extracted out of `public/app.js` specifically so it's testable without a
DOM and reusable from `public/lib/match-builder.mjs`. `npm test` (`node
--test`, no dependencies to install) runs `tests/*.test.mjs` against it,
plus `public/lib/match-builder.mjs`'s own pure ESPN-shape helpers
(including
`resolveWhereToWatchTw`/`computeDurationMinutes`/`computeMatchObjectiveScore`),
`public/lib/sport-duration.mjs`'s own per-sport duration formulas,
`public/lib/objective-score.mjs`'s own deterministic scoring formulas
(`tests/objective-score.test.mjs`), `public/lib/sport-signals.mjs`'s own
pure API-response parsing (`tests/sport-signals.test.mjs` - hand-built
fixtures shaped like the MLB Stats API/Jolpica F1 API's own documented
formats, not a live response - see that module's own top-of-file comment),
`public/lib/polymarket.mjs`'s own real-market matching/devig logic and
`public/lib/color.mjs`'s own WCAG contrast math (both built from real,
live-fetched sample data - see each test file's own comments), and
`scripts/evaluate-recommendations.mjs` below. Also runs as its own step in
`.github/workflows/deploy.yml`, on every push/dispatch. See
`docs/recommendation-engine-audit.md` for the fuller writeup of what's
covered and why.

## Evaluating a historical export

`node scripts/evaluate-recommendations.mjs <export.json> [more.json ...]`
reads one or more `matches.json`-shaped files - a copy saved from
`node scripts/build-data.mjs` (see "Local dev tooling" above) or straight
from a browser's own devtools works fine; there is no in-app export button
anymore (see "No developer tools in the UI" above) - and reports
recommended count/rate, sport concentration, score/confidence
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

Edit `public/lib/team-names.mjs` — it's a plain object keyed by league id and
ESPN's team abbreviation (e.g. `mlb.NYY`). A missing or wrong entry doesn't
break anything: the site just shows that team's English name only.
