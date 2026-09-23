# Match Find

**Tell you what's actually worth watching today — Premier League, MLB, NBA, and F1 — in your own local time, scored by real data, not guesswork.**

**Live site: [https://jaypengx-collab.github.io/Match-Find/](https://jaypengx-collab.github.io/Match-Find/)**

---

## English

The site's UI is available in both English and Traditional Chinese. The
displayed language is auto-detected from your browser/device language
preference on first visit (see `public/lib/i18n.mjs`); everything below this
section is written for the project's primary Traditional-Chinese-speaking
audience and is not translated in this document.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [How It Works](#how-it-works)
- [The Deterministic Scoring Engine](#the-deterministic-scoring-engine)
- [The Viewing Plan Algorithm](#the-viewing-plan-algorithm)
- [Page Layout & UI](#page-layout--ui)
- [Sport Priority & Settings](#sport-priority--settings)
- [Duration & Broadcast-Source Resolution](#duration--broadcast-source-resolution)
- [Broadcast Service Registry](#broadcast-service-registry)
- [Local-Only Data & Privacy](#local-only-data--privacy)
- [Live Match Data & Refresh](#live-match-data--refresh)
- [Architecture / Project Structure](#architecture--project-structure)
- [Getting Started](#getting-started)
- [Known Limitations](#known-limitations)
- [Related Projects](#related-projects)

## Overview

Match Find is a small static site, with a UI available in both Traditional
Chinese and English (auto-detected from your browser - see [English](#english)
above), that answers
one question: **what's actually worth watching today**, across the Premier
League, MLB, NBA, and F1. It shows fixtures in the viewer's own local time,
with team logos, home/away labels, bilingual (English / Traditional
Chinese) team names and venues, where to watch each fixture in Taiwan
(愛爾達體育台, Apple TV, ...), a horizontally-scrolling day picker (today
through the next two weeks, auto-jumping past today once today's fixtures
are already over), and a curated daily lineup picked so a viewer can watch
back-to-back without constant channel-hopping or being told to stay up for
a 3am kickoff. The page itself only ever shows the *recommendation* — a
plain-language reason, not the raw competitiveness/watchability numbers
behind it (see [Page Layout & UI](#page-layout--ui)).

There is no sign-up and no app. It's a static GitHub Pages site, deployed
only when its own code changes, and installable as a PWA. Critically, the
match list itself is **not** produced by a periodically-rebuilt static
file — an earlier version of this site worked that way, but it does not
anymore. The list is fetched and scored **live, in the viewer's own
browser**, every time the page opens and on an ongoing refresh cycle after
that (see [How It Works](#how-it-works) and [Live Match Data &
Refresh](#live-match-data--refresh)). There is also no in-page header: an
earlier version had a slim one, but it was dropped entirely, since an
installed PWA's home-screen icon and OS title bar already carry the app's
identity, and a masthead here was just empty space repeating that. Settings
(⚙) lives inline with the sport filter chips instead.

## Key Features

- **Cross-sport daily digest** — Premier League, MLB, NBA, and F1 (including
  qualifying and sprint sessions) in one place, in the viewer's own local
  time zone.
- **A real scheduling plan, not just a ranked list** — "recommended
  fixtures" is a back-to-back-watchable plan for the day, not a set of
  independent "this one's good" judgments (see [The Viewing Plan
  Algorithm](#the-viewing-plan-algorithm)).
- **Fully deterministic scoring** — every fixture's score comes from real,
  current sports-data APIs (MLB Stats API, Jolpica F1 API, ESPN standings),
  computed by a transparent formula. No AI is involved anywhere in this
  pipeline (see [The Deterministic Scoring Engine](#the-deterministic-scoring-engine)).
- **Bilingual presentation** — English/Traditional Chinese team names and
  venues, with a best-effort translation table for teams (see [Fixing a
  Team's Chinese Name](#fixing-a-teams-chinese-name)).
- **Taiwan broadcast info** — a deterministic rule resolves where to watch
  each fixture in Taiwan, with small color-coded service badges (see
  [Broadcast Service Registry](#broadcast-service-registry)).
- **Live win% odds** — sourced from Polymarket, devigged, shown per fixture
  where a real market exists, including F1 outright and pole-position
  markets (see [Live Win% Odds](#live-win-odds)).
- **Live in-progress detail** — a sport-specific live status widget
  (baseball diamond with runners/outs, NBA/EPL clock, F1 flags and running
  order) on any card that is currently live (see [Live Score/Odds
  Polling](#live-scoreodds-polling)).
- **Touch-driven swipeable card stack** for genuinely conflicting fixtures,
  built on raw Touch Events rather than native scroll-snap for
  cross-device/cross-browser reliability (see [The Swipeable Card
  Stack](#the-swipeable-card-stack)).
- **Local-only preferences** — sport priority, enabled sports, and pinned
  ("Prefer") choices all live in this browser's own `localStorage`; there
  is no account and no cross-device sync (see [Local-Only Data &
  Privacy](#local-only-data--privacy)).
- **PWA-installable**, no service worker, no offline cache — the site
  checks for and offers a fresh deploy in place rather than silently
  serving stale JavaScript (see [Version Detection & Manual
  Refresh](#version-detection--manual-refresh)).

## How It Works

Scoring and picking are split across two different concerns, deliberately:

1. **Fetch.** `public/lib/match-builder.mjs`'s `buildMatches`, called
   directly by the viewer's own browser (through the shared proxy — see
   [The Shared Proxy Architecture](#the-shared-proxy-architecture); also
   callable from Node via `scripts/build-data.mjs`, kept only for local
   dev/debugging tooling), fetches upcoming *and currently-live* fixtures
   for the next 14 days from [ESPN's public scoreboard
   API](https://site.api.espn.com) — no API key needed for this part. Only
   a **finished** fixture is excluded; every refresh re-fetches ESPN's live
   feed, so a fixture that was still upcoming last refresh has very often
   already started by the next one. Dropping a fixture the moment ESPN
   flips it to "live" used to mean a match a viewer was actively watching
   would simply vanish from "today" mid-game, even though the client
   already had everything it needed (`relativeLabel`/`.is-live`, see [Page
   Layout & UI](#page-layout--ui)) to show it as 直播中 once it was actually
   in the data — so live fixtures stay in. Each fixture comes with both
   teams' ESPN-hosted logo and a Traditional Chinese name looked up from
   `public/lib/team-names.mjs` (a static, best-effort translation table —
   a team missing from it just shows English-only).
2. **Score.** `public/lib/objective-score.mjs` and
   `public/lib/sport-signals.mjs` compute **competitiveness**,
   **watchability**, **enduranceScore**, and **broadcastQuality** for every
   fixture deterministically, from real, current sports-data APIs — this is
   the *whole* score, not a baseline something else refines. There is no AI
   anywhere in this step (see [The Deterministic Scoring
   Engine](#the-deterministic-scoring-engine) for the full history of why
   AI was removed, and for the one small, bounded, and since-removed
   exception that briefly existed one layer up, at the recommendation-plan
   level). MLB pulls standings/recent-form/streak data from the official
   MLB Stats API; F1 pulls the championship-standings gap from the
   Ergast-compatible Jolpica API; every sport folds in season record and
   real market odds (Polymarket — see [Live Win% Odds](#live-win-odds)),
   already fetched, plus the same rivalry/derby/national-broadcast
   detectors `public/lib/sport-duration.mjs` uses for duration. This is
   computed on every refresh, for every fixture.
3. **Return.** The result — every fixture, scored, nothing filtered or
   picked yet — is what `buildMatches` returns, straight back to the
   caller. There is no intermediate file for the deployed site;
   `scripts/build-data.mjs` can still write one to
   `public/data/matches.json` for local dev tooling (see [Getting
   Started](#getting-started)).
4. **Plan.** `public/app.js`'s `resolveViewingPlan`, still running in the
   viewer's own browser, converts every fixture's kickoff to the viewer's
   own local time and applies their Settings nudges (sport priority, owned
   services). The actual "what's worth watching today" decision — **one
   local calendar day at a time**, because "what counts as an unreasonable
   hour" and "which fixtures actually conflict" are both relative to the
   viewer's own clock — happens in `computeDayPlan`, described in full in
   [The Viewing Plan Algorithm](#the-viewing-plan-algorithm).

## The Deterministic Scoring Engine

Every fixture's score is exactly what `public/lib/objective-score.mjs`
computes from real, current statistical signals
`public/lib/sport-signals.mjs` fetches. There is no AI involved anywhere in
this step, and there has not been for most of this project's history. The
one blend of scores that ever gets shown or scheduled from is
`bestMatchScore` (`public/lib/recommendation.mjs`); an earlier version let
viewers pick between two subtly different "recommendation styles," but that
choice added confusion without adding real value, so there is now only ever
one recommendation system.

### Per-sport signals

- **MLB** ([MLB Stats API](https://statsapi.mlb.com), free, no key):
  division/wild-card standings proximity (`gamesBack` /
  `wildCardGamesBack` — how alive each team's own playoff race is right
  now), each team's own last-10-games record and current win/loss streak,
  plus season record and betting odds already fetched from ESPN. Team pace
  offsets and the Coors Field modifier from the duration model (see
  [Duration & Broadcast-Source Resolution](#duration--broadcast-source-resolution))
  are deliberately *not* reused here — a fast/slow-pace team says nothing
  about how close a given matchup actually is.
- **F1** ([Ergast-compatible Jolpica API](https://api.jolpi.ca), the
  community-run successor to the original Ergast API which shut down at
  the end of the 2024 season; also free, no key): the current drivers'
  championship standings gap between P1 and P2, turned into a 0
  (mathematically decided) to 1 (a dead heat) title-race intensity that
  feeds *every* race that season's watchability — a title fight still very
  much alive makes every remaining race more consequential, independent of
  which circuit it's at.
- **NBA** (ESPN's own `/apis/v2/sports/basketball/nba/standings` — same
  host/team-naming as the scoreboard fetch, so no separate id-mapping table
  is needed): each team's own signed distance to its conference's real seed
  cutoffs (`sixSeedGap` / `tenSeedGap` — the direct-playoff line and the
  play-in line, the same "either race keeps it alive" reasoning as MLB's
  division/wild-card pair), last-10-games record, and current streak — the
  same depth MLB's own standings integration has, not a shallower stand-in.
  This is guarded against a real failure mode caught live: every team reads
  0-0 before a season actually starts (preseason exhibitions), which would
  otherwise report a maxed-out "playoff race" for every single game. See
  `parseNbaStandingsResponse`'s own `seasonStarted` check.
- **Premier League** (ESPN's own `/apis/v2/sports/soccer/eng.1/standings`):
  each team's own signed *points* gap to the real Champions League
  qualification line (top 4) and the relegation line (bottom 3 of 20) — a
  genuine stakes signal EPL never had before, on top of season record and
  betting odds already fetched from ESPN, and the same rivalry/derby and
  national-broadcast detectors `public/lib/sport-duration.mjs` already
  computes for the duration model (`isNbaRivalry` / `isEplDerby` /
  `isNationalBroadcast`). EPL specifically has no recent-form signal — see
  [Known Limitations](#known-limitations) — because ESPN's own standings
  response for this league has no per-team streak/last-5 figure at all.

### Why AI was removed from scoring

`competitiveness`/`watchability`/`enduranceScore`/`broadcastQuality` used
to be asked from Gemini directly, essentially "from memory," then, for one
intermediate period, computed deterministically first with Gemini
validating the result. Gemini is gone entirely from this step now — every
fixture's score is exactly what `computeMatchObjectiveScore` computes from
real, current, statistically-grounded signals, not the old crude
win-rate-only `heuristicScore` from before this engine existed (long
since removed).

Two independent reasons killed the Gemini-validation step, not one:

1. **Free-tier quota couldn't sustain the workload.** Google Search
   grounding — the one thing that could have added real signal a formula
   can't see, like an injury — failed with a `429 RESOURCE_EXHAUSTED` quota
   error on 100% of live-tested requests. This was a billing-tier wall, not
   a bug.
2. **Even the plain validation call, when it succeeded, was structurally
   bounded to a ±2 nudge per dimension.** A live-verified case (a 0-0
   preseason exhibition scoring near-maximum competitiveness) showed Gemini
   correctly *identifying* the problem in its own reasoning text while
   being unable to fix it, because only the deterministic formula itself
   could move the score that far.

The reason text shown on each card (`buildObjectiveReasonZh`) is built from
the actual factors behind the score (e.g. "依雙方戰績、近期戰況、盤口數據
計算。"), not an AI-generated sentence.

A second, narrower AI experiment happened later, at the recommendation-plan
level rather than in per-fixture scoring, and was also ultimately removed
in full — see [The Gemini Tie-Break: A Removed
Experiment](#the-gemini-tie-break-a-removed-experiment) under [Live Match
Data & Refresh](#live-match-data--refresh). As of today, this engine has no
AI involvement anywhere, for the second time in this project's history.

### The `bestMatchScore` blend

`bestMatchScore` is a weighted blend of five axes
(`BEST_MATCH_WEIGHTS` in `public/lib/recommendation.mjs`):

| Axis | Weight | What it measures |
|---|---|---|
| `skill` | 0.35 | How *good* the two teams actually are |
| `competitiveness` | 0.05 | How *close* tonight's specific pairing is |
| `watchability` | 0.35 | Entertainment value / mainstream public attention |
| `enduranceScore` | 0.1 | Does the contest stay meaningful all the way through |
| `broadcastQuality` | 0.15 | Production quality of watching it |

These weights reflect a direct, explicit choice: a clearly-better team
should generally beat a merely-tenser pairing. `skill`'s weight was raised
(from an original 0.2) and `competitiveness`'s lowered (from an original
0.2) specifically because a genuinely great team playing a lopsided game
was, at one point, losing recommendation slots to a mediocre-but-close
pairing purely on closeness. This was verified live rather than assumed: a
fresh EPL fetch put Sunderland @ Manchester City (skill 10, competitiveness
1 — lopsided on paper) ahead of Crystal Palace @ Leeds United (skill 3,
competitiveness 6) under these exact weights, correctly prioritizing the
star club despite the lopsided score. The behavior is not sport-specific —
`bestMatchScore`/`BEST_MATCH_WEIGHTS` is one shared blend for every sport's
`skill`/`competitiveness`/`watchability`/`enduranceScore`/`broadcastQuality`
fields; there is no per-sport gate in `computeEffectiveScore`.

The blend is deliberately never anchored on just one of those axes, so a
match that's exceptional on only one dimension while mediocre on the rest
doesn't automatically win over a well-rounded one. It's renormalized over
whichever of the five a fixture actually has — a finished/never-scored
match, or a sport missing one signal, still gets a real number built from
what *is* known. The one place a viewer's own taste actually overrides the
algorithm is **Prefer** — swiping a card stack to commit to a specific
alternative (see [Pinning: "Prefer"](#pinning-prefer)) — which is local,
explicit, and per-match, not a blanket ranking toggle.

#### `skill`

`skillFromWinPct` (`public/lib/objective-score.mjs`) is deliberately a
separate axis from `competitiveness`: two elite teams playing a close game
and two also-ran teams playing an equally close game score identically on
closeness alone, but they're not the same recommendation. NBA and EPL feed
it the two teams' *average* win%/points-rate. MLB instead feeds it the
*better* team's own win% (`Math.max(awayWinPct, homeWinPct)`) — an average
cancels out exactly the case this axis exists for: a 96-60 elite Dodgers
team against a 64-92 Giants team averages to roughly .51 (a neutral
skill≈5, indistinguishable from two genuinely mediocre .500-ish teams, as
confirmed by direct review), while the better-team's-own-win% version
correctly reads that pairing as containing a genuinely elite team. `skill`
is null for F1 (no per-competitor quality signal exists for a
single-driver race) and renormalized away like any other missing signal.

#### `watchability`

`watchability` blends the deterministic objective score's own
national-broadcast/rivalry/derby detectors and betting-market signal with
`skill` directly — a real addition, since `skill` previously sat computed
but unused in the return value. Each sport uses its own tailored blend and
its own guardrail against one bonus swamping the whole score:

- **MLB**: `stakes 0.3 / competitiveness 0.3 / skill 0.25 / momentum 0.15`.
  Guardrail: `MLB_WATCHABILITY_FULL_LIFT_ALLOWANCE` /
  `MLB_WATCHABILITY_EXCESS_DAMPING` (0.4) — the first 3 points of lift over
  tonight's own competitiveness pass through untouched, and any excess
  beyond that is *damped*, not hard-walled, so a genuinely elite team in an
  otherwise-lopsided game can still earn real (if diminishing) extra
  credit.
- **NBA**: blends `skill` at weight 0.2 (lower than MLB's 0.25, since NBA
  already has stackable rivalry *and* national-broadcast bonuses that
  partially overlap with what a continuous skill score would add), with a
  tighter damping factor, `NBA_WATCHABILITY_EXCESS_DAMPING` = 0.3 (versus
  MLB's 0.4), since NBA's two stackable bonuses can build up more excess.
- **EPL**: blends `skill` at weight 0.3 — the largest of the three, since
  EPL has no recent-form/momentum signal at all to otherwise fill that
  weight budget — with the tightest damping of the three (0.25), since EPL
  can stack a derby *and* a big-club bonus together (up to +4) on top of
  skill. Both NBA and EPL use the same "better team's own win%, not the
  average" logic as MLB, for the same reason: an elite club grinding
  through a currently-lopsided score against a weak side would otherwise
  average back to a neutral skill reading.
- For NBA and EPL specifically, neither a rivalry/derby/big-club name nor a
  division leader's own "stakes" reading can lift `watchability` more than
  `MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS` (3) points above tonight's
  own competitiveness. This guardrail exists because of a real case: a
  96-60 Dodgers team, already clinched, blowing out a 64-92 last-place
  Giants team still scored a maxed-out watchability purely from
  "Dodgers-Giants" being a historic rivalry name, outranking a genuinely
  live playoff race elsewhere that night.

**MLB's rivalry bonus and the marquee-credit cliff.** MLB's own rivalry
bonus additionally scales by `marqueeCreditFraction(competitiveness)` — MLB
only. This isn't a standings-API depth gap (NBA's own standings
integration above already matches MLB's own); it's a deliberate choice to
keep protecting NBA/EPL's name-based bonuses from early-season sampling
noise a full-season MLB-style gate would wrongly silence (see [Known
Limitations](#known-limitations)). This replaced a hard gate,
`MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS` (6): a real, live Dodgers (96-60) @
Giants (64-92) pairing scored competitiveness 5, one point under that old
threshold, so the entire rivalry bonus fell to exactly zero — full credit
one point above the line, none at all one point below. It was replaced
with a linear ramp (0 credit at competitiveness 2 or below, full credit at
6 or above, reusing that exact old threshold as the ceiling) so a fixture
just under the old line gets a proportional share instead of falling off a
cliff. This same fraction also scales the fully undiluted
`MARQUEE_FIXTURE_SCORE_BONUS` in `public/lib/recommendation.mjs` (via
`match.marqueeCredit`, set only by MLB — NBA/EPL default to full credit,
preserving their own unconditional behavior); without that additional
step, any nonzero internal credit would still trip `isMarqueeFixture`'s
boolean detection and hand out the *full* undiluted bonus regardless of how
small the internal credit was, re-creating the same cliff one layer up.

**The root cause behind the same Dodgers/Giants case was also fixed
directly, not just capped.** A division leader's own `gamesBack` reads 0
whether its lead is a nail-biter or a 20+ game runaway, so
`playoffProximityScore` now also takes a `divisionLeadMargin` (the
runner-up's own `gamesBack`, computed once per division in
`parseMlbStandingsResponse` from data already in the same standings
response) and discounts a comfortable leader's stakes the same way it
already discounts a team chasing from behind — floored at 2, never
automatically maxed at 10 just for holding first place. The same direction
was applied to NBA and EPL, each with its own tailored formula rather than
copying MLB's numbers (see the per-sport blend weights above).

**`divisionLeadMargin` alone still can't tell a comfortable-but-early lead
apart from a comfortable, imminent-clinch one.** It's a snapshot of
today's standings with no idea how many games are even left to play — "6
games up in June" and "6 games up with a week left" read identically.
`playoffProximityScore` now prefers the MLB Stats API's own `magicNumber`
whenever a division leader hasn't clinched yet (see
`sport-signals.mjs`'s `parseMagicNumber`) — a real win-or-opponent-loss
countdown that already bakes the remaining schedule in, so a small one is
verifiable imminent-clinch drama, not just a guess from the lead size
alone. Falls back to `divisionLeadMargin` once the leader has clinched
(the API stops reporting a magic number at that point) — a clinched
leader still has real, lesser stakes (seeding, a title, a milestone), same
as before. Validated against real reporting and the live MLB Stats API
response (2026-09-23): Cleveland Guardians, AL Central, division lead
margin only 1 over a Chicago White Sox team a single game back — a real,
live race per contemporary coverage — magic number 5, both reading as
genuinely tense. The slope (0.25/point, gentler than `divisionLeadMargin`'s
own 0.8/point) was chosen specifically so a magic number this small still
lands close to what the already-tuned `divisionLeadMargin` reading gives
an equally tense same-day race — a first cut (0.5/point) discounted it
enough to silently drop that exact rival more than the whole-week variety
rotation's own close-call gap behind its incumbent, excluding a genuinely
live rival from rotation consideration entirely.

**Star/team power — MLB's own version of EPL's "Big Six".** Direct
instruction: "we prioritize star/team power." A pure win%/standings-based
score has no way to see that a marquee, big-market franchise draws real,
national attention essentially independent of this particular season's
record — the same gap `MLB_RIVALRY_PAIRS`/`EPL_BIG_CLUBS` already cover for
a specific historic pairing or England's biggest clubs, but MLB had no
per-club (rather than per-pairing) equivalent. `MLB_BIG_CLUBS`
(`sport-duration.mjs`) is a short, deliberately conservative list of MLB's
biggest national brands (Yankees, Dodgers, Red Sox, Cubs, Giants,
Cardinals, Braves, Mets) — either side alone qualifies, same as
`isEplBigClub`. Stacks additively with a genuine rivalry in
`computeMlbObjectiveScore` (a Yankees @ Red Sox game is both, and gets more
lift than either fact alone) rather than competing with it, and is gated by
tonight's own `competitiveness` the same graduated way the existing rivalry
bonus already is (added to it, not overriding it — a decided blowout
between two marquee names still gets little to no credit). Since MLB can
now stack two name-based bonuses the way EPL always could,
`MLB_WATCHABILITY_EXCESS_DAMPING` was tightened to match EPL's own 0.25
(from 0.4), for the same reason EPL's was already tighter than MLB's.

### Known scoring limitations

Stated plainly rather than left silently unaddressed:

- **EPL has no recent-form signal.** ESPN's own `/standings` endpoint for
  `soccer/eng.1` (the same one NBA uses) has no per-team streak/last-5
  figure at all, confirmed against a real live response — only points,
  goal difference, and rank. It *does* have a real table-position stakes
  signal (Champions League/relegation proximity, via
  `parseEplStandingsResponse`), just not the recent-form depth MLB/NBA get
  from their own standings sources.
- **No injury data, and no real-time media/narrative signal, in the
  deterministic scoring engine itself.** Neither is knowable from data
  `objective-score.mjs`/`sport-signals.mjs` already fetch. Adding either
  back into the deterministic score for every fixture would mean a new
  paid data source, or the same per-fixture search/grounding integration
  that was tried and abandoned earlier for burning free-tier quota. A
  bounded, at-most-once-a-day, Google-Search-grounded exception was
  reintroduced later purely for one day's headline recommendation slot
  (see [The Gemini Tie-Break: A Removed
  Experiment](#the-gemini-tie-break-a-removed-experiment)) — but it was
  removed too, per direct instruction that its real billed cost outweighed
  its improvement, so there is once again no AI input anywhere in this
  engine.
- **F1's per-race modifiers (safety car, weather) aren't modeled.** Neither
  is knowable before a race starts from data this build already has, and
  adding real weather data would mean taking on a new API key/dependency
  this build doesn't currently need for anything else — deliberately not
  done without that being a real, separate decision (the same trade-off
  `public/lib/sport-duration.mjs` documents for the duration model, see
  [Duration & Broadcast-Source Resolution](#duration--broadcast-source-resolution)).

## The Viewing Plan Algorithm

A viewer can only watch one thing at a time, so 推薦賽事 ("recommended
fixtures") isn't a set of independent "this one's good" judgments — it's
**one continuous back-to-back plan for the day**, built by `computeDayPlan`
in `public/lib/recommendation.mjs`.

### Core scheduling

- A fixture whose **local** start time falls between midnight and 5am is
  never a candidate for the plan, however good its score — this site won't
  tell a viewer a 4am kickoff is unmissable. It still shows up in 所有賽事
  ("all fixtures"), just never in the plan.
- The plan itself is the maximum-total-score set of **non-overlapping**
  fixtures for the day — a real weighted-interval-scheduling chain
  (`computeDayPlan` / `weightedIntervalSchedule`), not a per-match
  threshold, and not "highest score wins its own little slot, everything
  else nearby is quality-gated or dropped" (both were tried in earlier
  versions and either hid good games or stopped producing an actual plan).
- Two fixtures that overlap so much they genuinely can't be sequenced — the
  overlap covers at least 75% of the *shorter* one's own length
  (`NEAR_TOTAL_OVERLAP_FRACTION`, checked by `isNearTotalOverlap`) — render
  as one swipeable card stack instead of two separate picks. Anything
  overlapping less than that isn't forced into a choice; the scheduler
  simply resolves it on its own. This grouping is a **presentation label
  only**, computed *after* the plan is already decided — every individual
  fixture is always a real candidate for the scheduler itself, never
  pre-collapsed to one representative per overlap group ahead of time (an
  earlier version did that and could silently lose the actually-best
  plan).
- A small fixed buffer (`TRANSITION_BUFFER_MINUTES`) sits between any two
  back-to-back picks, so "ends at 8:00, starts at 8:00" no longer counts as
  a real gap.
- Any card whose start overlaps an **earlier** match — regardless of
  whether either one made the plan — gets a small note saying so and for
  how long ("與「X」重疊 45 分鐘"), a plain fact about the schedule shown
  independently of the plan itself.
- Whichever planned fixture is currently live, or (failing that) the
  soonest one still to come, is pinned to the top of the day's list.

### Games that already started are locked into the day's plan

The plan is recomputed on every refresh, so a finished game used to be
re-scored from ESPN's post-game feed (no pre-game line any more, standings
already counting the result, the real duration instead of the estimate).
After an app update or a reopen more than 30 minutes later, the pre-game
values weren't around to carry forward at all. The rescored game could lose
its slot to a different one and reshuffle the rest of the day - reported as
"a recommended game ended and it started recommending other games, killing
the day's schedule".

`app.js` now remembers the last plan it rendered for each day (per sport
filter) in localStorage (`matchfind-day-plan-history`, kept back to
yesterday, separate from the match snapshot so an app update doesn't wipe
it). Any pick from that plan that has already started, live or finished, is
passed to `computeDayPlan` as `lockedIds` (see `startedPlanLockIds` in
`public/lib/recommendation.mjs`) and forced into its slot, still labeled
推薦. Upcoming picks aren't locked and can still change with fresher data,
but only around what already started. A real swipe-to-pin still wins over a
lock it clashes with.

**A recorded plan is tagged with the build that produced it** (`APP_BUILD_ID`,
the same tag `matchfind-match-snapshot` already carries — see "Local-Only
Data & Privacy" below), and thrown away on a mismatch rather than trusted.
Unlike `matchfind-pregame-scoring` (real, observed pre-game data that stays
true regardless of what code reads it), a recorded plan *is* a decision by
this specific build's own scoring/rotation code. Live-reported directly: a
viewer who saw a bad recommendation once, from a bug that got fixed and
deployed minutes later, kept seeing that exact same wrong pick after
reloading the fixed site — the lock designed to protect a good recommendation
from being reshuffled was just as effective at protecting a bad one from
ever being corrected. A build tag means a deploy that changes how a day
gets decided can only ever be reached by loading the code that produced
it, so the very first render under fixed code recomputes and records fresh,
rather than trusting a decision from before the fix existed.

### Duration, endurance, and the no-clock-sport overrun buffer

A fixture's own `enduranceScore` decides how much of its nominal length
actually blocks the next pick from starting
(`effectiveDurationMinutes`) — a fixture unlikely to stay watchable to the
end frees the schedule up sooner than its full listed length would
suggest.

**Baseball, and other no-clock sports, get a real overrun buffer, not a
discount.** A sport with no game clock (MLB — extra innings, rain delays)
is statistically more likely to run *long* than short in real time, never
the other way around: a standard 9-inning game already averages roughly
2h40m of playing time alone (per MLB's own officially published
time-of-game figures), and extra innings or a rain delay routinely add
30-60+ real minutes on top with no matching mechanism that ever finishes a
game meaningfully early.

An earlier version of this pipeline treated that same uncertainty as a
*discount* — shrinking the reserved block for a low-reliability sport —
which was backwards, and was the direct cause of a reported bug: the
scheduler would offer a next pick only about 2h13m into a genuinely great
MLB game, producing 40-80 real-minute overlaps once the broadcast actually
ran anywhere near its own average length.
`DURATION_OVERRUN_BUFFER_BY_RELIABILITY`/`schedulingDurationMinutes`
(`public/lib/recommendation.mjs`) now only ever *pad* a no-clock sport's
reserved block on top of the endurance-adjusted figure, never shrink it
below that value judgment — football/F1 (a real game clock) get no pad at
all; MLB gets the largest. This duration is always an *estimate*, never a
guaranteed end time — ESPN's own live status (`isFinished`) is what
actually decides a match is over; this only decides how much time the plan
reserves before offering something else.

**The overrun buffer only ever applies before a match is over.** Once
ESPN's own status confirms a fixture is finished, `durationMinutes` (see
`finishedDurationMinutes` in `public/lib/match-builder.mjs`) stops being a
pre-game guess and becomes an elapsed-time-since-kickoff estimate instead,
and `schedulingDurationMinutes` stops padding it any further — there's no
forward uncertainty left to hedge once the real length is already known.
This is the direct fix for a reported bug: a finished MLB game that
genuinely ran 30-60 minutes *shorter* than its own pre-game prediction
still had another 25% padded on top of that longer, now-known-wrong guess,
which kept blocking a next match that could obviously, actually follow it.

**A separate bug: finished-match durations that kept growing across
refreshes.** `finishedDurationMinutes` computes `now - startTimeUtc` fresh
on every refresh, and this app has no scheduled rebuild anymore (it runs
live in the browser, on both the 60-second near-term and 5-minute
full-window polls — see [Live Match Data &
Refresh](#live-match-data--refresh)). A finished match that stayed in the
fetched window (today plus one day back) had its own reported duration
keep growing toward its per-sport cap purely from how long the viewer's
tab stayed open or how late they reopened it — a real, live-confirmed case
showed a match finished roughly 7 hours earlier sitting at exactly the
360-minute MLB cap, right next to an upcoming match's flat 190-minute
estimate.

This was fixed in two stages:

1. `app.js`'s `mergeFreshMatches` now *freezes* a match's own
   `durationMinutes` the first time this browser ever sees it finished
   (preferring `pollLiveMatches`'s own last live-tracked value from the
   moment it actually ended, when one exists) and carries it forward
   unchanged on every later merge, rather than recomputing it fresh each
   time.
2. Freezing only stops the value from *growing further* — it does nothing
   for a match whose very first observation already happens long after the
   final out, which the same "no scheduled rebuild, continuous polling"
   architecture makes the common case, not the rare one. A further
   live-reported case showed a match's first-ever fetch already about
   2000+ minutes past kickoff, so `finishedDurationMinutes` clamped it at
   MLB's then-360-minute cap on that very first observation, then froze it
   there. This was fixed in `match-builder.mjs` with two further changes:
   each sport's cap in `FINISHED_DURATION_CAP_MINUTES_BY_SPORT` is now a
   genuinely realistic worst-case broadcast length (MLB lowered 360 → 280)
   rather than "high enough that a stale fetch looks obviously wrong,"
   since a late fetch is now the norm; and once elapsed-since-kickoff
   exceeds that cap, `finishedDurationMinutes` no longer trusts "elapsed
   since start" as a length signal at all — it falls back to
   `pregameEstimateMinutes`, the same real per-fixture prediction
   (`computeDurationMinutes`) an upcoming match already shows. A
   late-observed finished match now displays an honest, fixture-aware
   estimate instead of the arbitrary cap value, and every finished MLB
   match observed hours-to-a-day late now shows roughly 155-175 minutes
   (matching real per-team/venue predictions) instead of a flat cap.

**The endurance-based shrink can't claim a no-clock sport's game is
basically over just because it isn't tense.** A real slate once scheduled
a next MLB pick only about 2h25m after the first one started, with a
genuine overlap — the first game's own low `enduranceScore` had shrunk its
reserved block (`effectiveDurationMinutes`) down toward
`ENDURANCE_DURATION_FLOOR` (40% of nominal), even though a "not that tense"
MLB game still plays all 9 innings in roughly the same real clock time as a
close one (fewer mound visits/pitching changes trims a little off a
lopsided game, not 30-60%). `SCHEDULING_DURATION_FLOOR_BY_RELIABILITY`
(`public/lib/recommendation.mjs`) now floors a no-clock sport's
*scheduling* duration at 85% of its own nominal length, regardless of how
low its endurance-based value judgment goes — the shrink still fully
applies to the *score* (`enduranceScore`'s own weight in `bestMatchScore`),
this floor only stops it from also claiming the broadcast itself is nearly
half over. High/medium-reliability sports (a real game clock) get no
floor — their own real end time is already clock-bound regardless of score
margin, so the existing endurance-based shrink already applies to them in
full, unchanged. A finished match is never floored (or padded) either way —
its own `durationMinutes` is already the real observed length once ESPN
confirms the fixture over.

**Once a fixture is actually live**, `estimateLiveDurationMinutes`
(`public/lib/recommendation.mjs`, called from `pollLiveMatches` — see
[Live Score/Odds Polling](#live-scoreodds-polling)) further corrects this
same `durationMinutes` field from ESPN's own real-time progress (current
inning/quarter+clock/match-minute), blended with the pre-game estimate
rather than replacing it outright. This is the direct answer to MLB's own
reported "estimate drops out by 30-60 real minutes" gap: the pre-game
formula is still a genuine prediction with real uncertainty (extra innings
and rain delays are not knowable in advance), but a live game's own actual
pace can now correct that estimate in real time instead of the schedule
staying pinned to a single guess for the whole broadcast.

### No cross-day "variety" penalty on ordinary scoring

An earlier version of `computeWindowPlan` applied a small, decaying
cross-day repeat penalty to a matchup already picked on an earlier day,
plus a sport-concentration penalty once one sport dominated recent picks.
This was removed entirely per direct feedback: this site's own primary
viewer mostly doesn't watch on weekdays at all, so comparing today's best
game against whatever won a weekday slot he never actually watched just
buried a genuinely great weekend game for a "variety" benefit that never
applied to him. `computeDayPlan`'s `planningScore` is now exactly
`effectiveScore` plus a live-match excitement bonus (`applyLiveExcitementBonus`,
see [Live Score/Odds Polling](#live-scoreodds-polling)) — nothing else
nudges which fixture wins a slot across days.
`computeWindowPlan`'s own `sportConcentration` return value still exposes
the whole window's actual sport split as a pure diagnostic (for anyone
inspecting a `matches.json`-shaped snapshot directly, or a copy fed to
`scripts/evaluate-recommendations.mjs`, see [Getting
Started](#getting-started)) — it just no longer feeds any scoring
decision.

### Back-to-back variety: whole-window rotation among real close contenders

Direct feedback, later on, pushed back the other way: the deterministic
scheduler's own math will happily recommend the exact same matchup three
(or more) real calendar days running whenever a live series/back-to-back
naturally scores best every one of those days — "I don't like that, add
variety... but real good games get kept, like the Dodgers @ Padres
back-to-back game." This is a deliberately *narrower* reintroduction of the
cross-day repeat penalty described above: that older version compared
today's pick against *any* recent day in the whole fetched window,
including weekdays this viewer never watches, which is exactly what
silently buried a genuinely great weekend game for a "variety" benefit
nobody wanted. The new mechanism only ever looks at days that are already
part of the same natural winning streak.

**Getting the exemption criterion right took two iterations.** The first
cut exempted a matchup once its own `skill` reached 7, on the theory that a
"real good game" should always keep repeating. Direct correction: "I want
variety, because the Brewer time they got equal match ups[,] the dodger one
in it's time it's the best[,] no alternative." Milwaukee Brewers @
Philadelphia Phillies (skill 8) had several genuinely comparable
alternatives in its own time slot every day it repeated, so a skill-based
bar wrongly exempted it anyway. The criterion was switched to the real
score *margin* over the closest rival — exempt only past
`VARIETY_CLOSE_CALL_GAP` (now 0.6, originally 0.5), a threshold chosen to sit directly between
the real, live-measured ranges: Brewers @ Phillies's own margin over its
closest rival was 0.15-0.45, while San Diego Padres @ Los Angeles Dodgers's
was 0.75-1.0 — despite both technically having an `.alternativeIds` entry
under the wider, UI-facing `ALTERNATIVE_MAX_SCORE_GAP` (2.5).

**The mechanism itself was then redesigned entirely**, since the
margin-based fix still only ever penalized the current incumbent once it
had won twice, handing the very next day to whichever single alternative
happened to be closest that specific day — never giving more than one real
alternative an actual turn. Direct correction: "it should first determine
how many days, then see how many alternative[s], if there is [more than
one] alternative... three day[s] mean each winning once."
`computeVarietyRotation` (`public/lib/recommendation.mjs`) now works over
the *whole* fetched window at once — feasible only because Match Find
already has every day's match data in hand before any one day renders,
unlike the earlier cross-day penalty, which only ever looked backward:

1. Find every maximal run of consecutive real calendar days where the same
   matchup naturally wins its own slot.
2. For a run of 2+ days, build a pool: that matchup plus every *other*
   matchup that was a genuinely close rival (within `VARIETY_CLOSE_CALL_GAP`)
   on *any* day of the run.
3. Drop any *other* pool member that was only ever close on a single day
   of the run — it isn't a recurring rival to rotate into, just a
   coincidence (some unrelated game that happened to overlap the
   incumbent's slot on the one day it's actually scheduled, with a score
   that happened to land inside the generous `VARIETY_CLOSE_CALL_GAP`
   window). There's no "variety" value in a one-off: a run rotates
   *because* the same matchup keeps recurring, and a single day has
   nothing to recur into.
4. If the (now-filtered) pool has more than one member, assign each day to
   a distinct pool member via a **maximum bipartite matching** (Kuhn's
   algorithm — days on one side, pool members on the other, an edge
   wherever a member was actually close on that specific day), covering as
   many *distinct* members as the run's own days can support, rather than
   a fixed `day i → pool[i]` rotation that can't adapt when a later day's
   own assignment turns out infeasible. Members are placed strongest-first
   (best score on any day of the run; ties go to the run's own matchup,
   then to whoever was close on more days), so when a run has more
   contenders than days, the one left out is always the weakest. A
   contender close on more than one day can still need the matching's own
   augmenting step (moving a more flexible, already-placed member to
   another of *its* eligible days) to get a day of its own — restricted to
   the filtered pool, this only ever moves a day between two genuine
   multi-day rivals, never hands one to a single-day one-off.
5. Arrange the days: fewest back-to-back repeats first, then the strongest
   game on Fri/Sat/Sun, then stronger contenders on earlier days.

**Games that already happened can't reshape a series.** Four things kept
moving a rotated lineup after the fact, each from a game that had already
finished or from an unrelated one-off that happened to share its slot:

- A finished game was re-scored from post-game data, with no pre-game line
  and standings that already counted the result. Guardians @ Red Sox on
  9/23 ended up 0.6 behind the series' top, fell out of the pool at 0.5,
  and flipped Wed/Thu. The build now also looks up the pre-game line for
  finished games, not just live ones. `app.js` saves every fixture's
  pre-game scoring in localStorage (`matchfind-pregame-scoring`), separately
  from the match snapshot, so it survives an app update. On the first load
  after an update it also recovers that scoring from the old snapshot
  before throwing the snapshot away. The gap is now 0.6, still inside the
  observed dividing line, to absorb that post-game drift.
- A finished game that ran long had its whole real length reserved on the
  schedule. Brewers @ Phillies ran 210 minutes, its block ran into the
  10:10 Padres @ Dodgers start, and that day's natural plan changed.
  `schedulingDurationMinutes` now caps a finished game at its pre-game
  estimate (`plannedDurationMinutes`). A game that's over can't block
  anything that starts after it anyway.
- Picks that already started are passed to `computeVarietyRotation` as
  fixed days (see "Games that already started are locked into the day's
  plan" above). The rest of the series rotates around them, without giving
  a locked matchup a second day. Plans are only recorded, and live picks
  only made sticky, once the full window has loaded. The first
  couple-of-days render can't see a whole series, so its pick can be a
  stopgap.
- A single-day one-off bumped a genuine multi-day rival out of a run
  entirely. The matching (step 4 above) places members strongest-first and
  lets a member bump a weaker, already-placed one to another of its own
  eligible days — safe among genuine rivals, but a scarce one-off used to
  be eligible for the matching at all: live case, Miami Marlins @ Chicago
  Cubs (eligible only on the single day it plays, 6.75) bumped the
  incumbent Milwaukee Brewers @ Philadelphia Phillies (7.1, eligible every
  day of the run) off its own opening day and onto a different one, purely
  because Marlins had nowhere else to go — a strictly worse matching than
  simply leaving Marlins out, since it swapped a stronger member out for a
  weaker one instead. Reported directly: "recommending marlins vs cubs,
  which is the broken state." Step 3 above is the fix: a member only ever
  enters the matching at all once it's shown up close on at least two days
  of the run.

**Two further corrections were needed once this shipped and was tested
against live data.** First: "if Brewer win day three outright then day one
should be someone else." The first cut of the whole-window rotation still
used a fixed `pool[i % pool.length]` assignment, so a later day's own
assignee turning out not-actually-close-that-day (falling back to the
incumbent) meant the incumbent won *twice* while some other real contender
never won at all — exactly this double-booking. This was replaced with the
maximum-matching approach described above. Second, caught live-testing that
very fix: penalizing the incumbent's own `planningScore` only ever
guaranteed the incumbent *lost*, not that the intended rotation winner in
particular *won* — `computeDayPlan` re-solves the whole day's schedule
fresh once a score changes, and a candidate entirely outside the rotation's
own pool can end up winning instead, simply by fitting the day's other
constraints slightly better once the incumbent dropped. A live-observed
case: penalizing Milwaukee Brewers @ Philadelphia Phillies to hand a day to
Cleveland Guardians @ Boston Red Sox instead actually handed it to Tampa
Bay Rays @ New York Yankees — a candidate the rotation's own pool never
even considered. This was fixed by switching from a soft penalty to a hard
*force*: `mergeVarietyForcedIds` merges the rotation's own assigned winner
into the same `pinnedForDay` a real viewer pin already uses, so it wins
unconditionally — the same guarantee a real pin has, never merely "probably
wins once nudged." Since `computeDayPlan`'s own forced-pick mechanism marks
every forced id `.isPreferred` (indistinguishable from a real viewer pin —
the same underlying issue that affected the Gemini tie-break, see [The
Gemini Tie-Break: A Removed
Experiment](#the-gemini-tie-break-a-removed-experiment)),
`clearRotationIsPreferred` puts 推薦 back immediately after the real, final
`computeDayPlan` call for anything only rotation-forced in.

This was verified against a real fetch: Milwaukee Brewers @ Philadelphia
Phillies's own 3-day run had a real pool of 3 members (itself, Cleveland
Guardians @ Boston Red Sox, Tampa Bay Rays @ New York Yankees), and the
matching correctly gave each one exactly one of the three days. Tampa Bay
Rays @ Philadelphia Phillies's own 2-day run had *two* other members tied
with it at "close both days" (Baltimore Orioles @ New York Yankees, Chicago
Cubs @ Boston Red Sox) — a 3-way tie for only 2 days; the incumbent-priority
tie-break correctly still let Rays @ Phillies win one of its own two days
rather than losing both to the other two tied members. San Diego Padres @
Los Angeles Dodgers stayed untouched throughout both runs' whole span (pool
size 1, nothing ever close). A before/after diff across the whole fetched
window showed exactly 3 intended days differ, zero unintended changes
anywhere else, and zero `.isPreferred` mislabels with no real pins anywhere
in the window.

### Pinning: "Prefer"

Swiping a card stack to a different card is a real commitment, not just a
peek — this *is* "Prefer." Settling on a different card pins that match as
the slot's fixed choice (`pinSlotChoice`) and rebuilds the *whole* day's
plan around it: the matches scheduled both before and after it are freshly
reasoned about relative to the pin, not just appended after whatever was
there before. Picking a shorter alternative can free up enough time for a
fixture that didn't fit before to join the plan afterward. A pin is saved
to `localStorage` (scoped to one calendar day) and survives a reload, same
as every other preference in this app — purely local, never synced
anywhere. Swiping back to whatever the algorithm would already have picked
for that slot (`naturalSlotChoice`, `public/lib/recommendation.mjs`)
*clears* the pin instead of recording one, so the card correctly reverts to
推薦 rather than staying mislabeled 偏好. A pinned card is tagged 偏好
("preferred") instead of 推薦 ("recommended") precisely because it's the
viewer's own choice overriding the algorithm, not the algorithm's own
judgment.

## Page Layout & UI

- A horizontally-scrolling **day picker** at the top — every day in the
  fetched 14-day window, all up front once the full-window refresh lands (a
  fast near-term refresh populates today/tomorrow first, see [Live Match
  Data & Refresh](#live-match-data--refresh)), no "load more" click needed
  once it has. It defaults to today, but jumps ahead to the next day that
  still has a fixture to come if today's are all already over.
- A single horizontally-scrolling row below the day picker holds both the
  **sport filter chips** (全部/英超/MLB/...), built only from sports
  actually present in the enabled set (see [Sport Priority &
  Settings](#sport-priority--settings)), and the Settings (⚙) button —
  last in that row, not first, so a growing sport list scrolls rather than
  pushing it around. Picking a chip narrows both sections below to one
  sport. Picking a sport chip that has nothing on the currently selected
  day (`ensureSelectedDayHasActiveSport`) jumps the day picker to the
  nearest day that actually has one, rather than leaving both sections
  empty for no visible reason — a real, common case for MLB specifically:
  Taiwan is far enough ahead of US time zones that a US evening fixture
  almost always lands on the viewer's *next* local calendar date (see
  `localDateKey`), so "today" can be genuinely, correctly empty for MLB
  while a full night's worth of real matches sit one tab over on "明天".
  Disabling a sport in Settings while its chip is the active filter resets
  the filter to 全部 the same way, rather than leaving the page stuck
  showing nothing for a sport that no longer exists in the enabled set.
- For the selected day: **推薦賽事** ("recommended fixtures") — the curated
  back-to-back lineup described in [The Viewing Plan
  Algorithm](#the-viewing-plan-algorithm), closest/live match first.
- Below that: **所有賽事** ("all fixtures") — every fixture that day,
  regardless of whether it made the recommended lineup, so nothing is
  actually hidden, just not pushed as a pick.
- Each fixture shows both teams with **home/away labels** (主/客), logo,
  and bilingual English/Traditional-Chinese name; the venue and (when
  known) Taiwan broadcast channel are shown the same bilingual/Chinese way,
  with a small color-coded badge per service (see [Broadcast Service
  Registry](#broadcast-service-registry) — there is no separate "已訂閱"
  mark on the card itself; which services count as the viewer's own only
  ever affects scoring, silently). MLB in particular is very often carried
  on both 緯來體育台 and 愛爾達體育台 at once — `resolveWhereToWatchTw`
  (see [Duration & Broadcast-Source
  Resolution](#duration--broadcast-source-resolution)) always names 愛爾達
  體育台 when both apply, as a fixed rule rather than an answer that could
  vary fixture to fixture.
- Each fixture shows one time range ("7:00 下午 – 9:35 下午") plus a short
  relative countdown next to it, instead of three separate stacked labels —
  the countdown switches from hours to whole days once a fixture is more
  than 24 hours out ("2 天 5 小時後", not "53 小時後"), both computed from
  the fixture's own predicted broadcast length.
- No competitiveness/watchability meters appear on the card — just the
  one-sentence reason. The numbers still drive the plan itself behind the
  scenes; the page itself only ever shows the recommendation, not the data
  behind it.
- A fixture ESPN has scheduled but hasn't set a real kickoff time for yet
  (almost always a playoff game whose bracket slot is set before its exact
  date/time is — see `isTimeTbd` in `build-data.mjs`) never enters the day
  picker/recommended lineup at all, since there's no trustworthy time to
  schedule it against. It's listed once, separately, in a **時間未定**
  section at the bottom instead. A bracket slot with no real teams assigned
  yet ("TBD @ TBD") is skipped entirely rather than shown as a blank card.
- F1 weekends surface **qualifying and (on a sprint weekend) the sprint
  race** as their own fixtures, not just Saturday/Sunday's race — each a
  genuinely watchable event in its own right, keyed off ESPN's own
  per-session abbreviation (`Race`/`Qual`/`SR`, confirmed stable across
  both ordinary and sprint weekends). Session times were cross-checked
  against Formula1.com's own official timetable and matched exactly. F1's
  Taiwan broadcaster is always 愛爾達體育台 — the MLB-specific "Apple TV
  exclusive slate" override (see `resolveWhereToWatchTw`) explicitly does
  not apply to F1, even though ESPN's own `broadcast` field for F1 also
  happens to say Apple TV (its real international rights holder — a
  genuinely different, unrelated fact from who carries it in Taiwan).

### The swipeable card stack

A recommended fixture with a genuinely can't-watch-both alternative
(overlap ≥ 75% of the shorter fixture's length, see [The Viewing Plan
Algorithm](#the-viewing-plan-algorithm)) renders as a **horizontally
swipeable card stack** — only one card is on screen by default, the other
a deliberate swipe away, with dots marking how many there are. Swiping is a
real choice: settling on a different card pins that match as the slot's
committed pick and rebuilds the rest of the day's plan around it
(`pinSlotChoice`, see [Pinning: "Prefer"](#pinning-prefer)). A card whose
start overlaps an earlier match — whether or not either one made the plan —
gets a small note naming that match and how long they overlap
(`computeOverlapRange` in `buildMatchCard`).

**The stack is driven entirely by explicit Touch/Mouse events and a CSS
`transform`** (`buildMatchStack` in `app.js`), not native CSS scroll-snap.
An earlier design (`scrollLeft` + scroll-snap + a `requestAnimationFrame`
poll waiting for native momentum to "settle") went through three separate
rounds of reported regressions — stuck cards, flicking back, cards landing
on the wrong index, a stack's dots jumping/shrinking mid-swipe — because
real touch momentum and native scroll-snap timing vary enough across
devices and browsers that no fixed poll/threshold tuned against one device
stayed correct on every other one. A `transform` is just a plain CSS
property this code sets directly
(`translateX(calc(-index*100% + dragPx))`) and reads back exactly what it
set — there's no separate physics engine whose output has to be inferred
after the fact. `touchstart`/`touchmove`/`touchend`/`touchcancel` (plus a
`mousedown`/`mousemove`/`mouseup` fallback for non-touch input) track the
gesture directly: a small movement threshold decides horizontal-swipe vs.
vertical-page-scroll before committing to either (so a swipe starting on a
stack never fights the page's own scroll), a live drag renders immediately
as the finger moves (with resistance past either end, never a hard stop),
and release commits to the next/previous card the instant it crosses a
distance-or-velocity threshold — no polling, no waiting for anything to
"settle," since nothing is still moving under the hood after that.

This is deliberately built on Touch Events, not the newer Pointer Events
API this went through first: this site's own audience is heavily iOS
Safari/PWA, and Safari's Pointer Events support, while real, has stayed
genuinely less mature than Chromium's for years (`touch-action` landed
late, `setPointerCapture`/`pointercancel` timing has had known quirks) —
exactly the kind of gap that's hard to catch in a Linux development sandbox
with no WebKit browser installed to test against, only Chromium. Touch
Events have had solid, consistent Safari support since iOS 2. The
implementation was verified against a real headless-browser reproduction
driving actual low-level touch input (Chrome DevTools Protocol's
`Input.dispatchTouchEvent`, which goes through the full browser
touch/gesture pipeline — not `dispatchEvent(new PointerEvent(...))` called
directly on one element, which bypasses that pipeline entirely and had
already given a false pass once), across a 3-card chain and a synthetic
10-game slate shaped like a real MLB night, including deliberately
imprecise diagonal gestures.

The node-reuse mechanism this replaced (keeping the exact DOM node a swipe
just landed on alive across the pin's own re-render, tracking which member
is currently pinned via `wrapper.dataset.primaryId` rather than a value
captured once at build time) is unchanged — a `transform` is just a plain
style property, though, so the extra scroll-position capture/restore the
old `scrollLeft`-based version needed around that reuse (to survive a
detach+reattach resetting scroll position on some mobile WebKit builds) is
gone; there's nothing left to reset.

**A stack's alternatives are direct conflicts only, not a whole
transitively-linked cluster.** `groupIntoSlots` groups cards by a
*transitive* chain (card 1 overlaps card 2, card 2 overlaps card 3 is
enough to union all three, even if 1 and 3 never overlap each other at
all) — harmless for a genuine 3-card cluster, but a real MLB night's own
games routinely chain 10-14 of them into *one* cluster this way (each game
reserves roughly 3-4 hours with buffer, staggered only 20-30 minutes apart
across the night). An earlier version handed the swipeable stack every
other member of that whole transitive cluster as its alternatives, so a
viewer could open what looked like a normal "pick one of these" stack and
find 10+ cards in it, most of which never actually conflicted with each
other at all — swiping through it landed on cards in no order a viewer
would recognize, and pinning one card could shuffle which other cards were
still independently recommended elsewhere, since so many pairs in a chain
that size are only linked transitively.

A first attempt at fixing this instead made a pin exclude its *entire*
transitive cluster — which "solved" the shuffling by instead silently
suppressing every one of those 10+ often-unrelated games from being
recommended at all the moment a viewer pinned just one of them, confirmed
wrong against real data before it ever shipped. `alternativeIds` in
`recommendation.mjs` is now narrowed to only the *other* candidates that
directly (pairwise) overlap the recommended pick, not every member of its
wider presentational cluster (while a pin's own hard-exclusion logic, and
the stable lookup key a pin is stored under, both stay based on the full
cluster). This keeps every stack small and locally coherent — a real "pick
one of these 2-3 games actually airing at the same time" choice — without
suppressing any other game the chain happened to also transitively touch.

## Sport Priority & Settings

`priorityOrder` nudges a match's `effectiveScore` up or down slightly
before it feeds `computeDayPlan`'s scheduling weight (which fixture wins a
genuinely contested, overlapping stretch of the day) — a viewer's
preferred sports win a close scheduling call a little more easily, and
their least favorite needs to be a little better to win one. This is a
small, symmetric tilt (1st-ranked gets the biggest positive nudge,
last-ranked the biggest negative, the exact middle rank gets none), never
enough on its own to make a mediocre match beat a genuinely great one. The
order is stored in `localStorage` (per-browser, nothing sent anywhere), and
re-ranking re-runs the whole plan and re-renders immediately, without
closing the panel or reloading.

### Enabled sports (已啟用的運動)

A hard on/off toggle per sport, not a ranking — unlike priority order
above, a disabled sport never appears anywhere on the page at all, not even
in 所有賽事 (also `localStorage`, per-browser). At least one sport must
stay on. Turning a sport off also means `buildMatches` stops fetching it
entirely on the next refresh (see [Efficiency: Caching &
Fetch-Skipping](#efficiency-caching--fetch-skipping)) — a real performance
win while it stays off, restored immediately (a background full-window
refresh kicks off the moment it's turned back on) rather than waiting for
the next scheduled tier.

### No developer tools in the UI

An earlier version of Settings had a "開發者工具" section with a "匯出推薦
資料" button (a client-side JSON download of the current plan, for
inspecting against `scripts/evaluate-recommendations.mjs`). It's gone —
that's not a viewer-facing feature, and `scripts/evaluate-recommendations.mjs`
still works fine against a `matches.json`-shaped copy saved any other way
(a browser's own devtools, or `node scripts/build-data.mjs` locally, see
[Getting Started](#getting-started)). Settings now shows only what an
ordinary viewer would actually use — sport priority, enabled sports, and
one 立即重新整理 (refresh now) button.

## Duration & Broadcast-Source Resolution

Two things that used to be either a flat guess or a per-fixture AI
judgment call are now plain, auditable rules computed entirely from ESPN's
own fixture data (plus, for duration, ESPN's own betting-odds field and,
live, ESPN's own in-progress status) — never an AI call.

### Predicted duration

`public/lib/sport-duration.mjs` — every fixture used to get one flat
per-league average (every MLB game: 190 minutes, regardless of which two
teams were playing). Real per-team pace varies by roughly 20 minutes across
MLB alone, so this is now a real formula per sport:

- **MLB**: averages each team's own documented pace offset, plus a Coors
  Field venue modifier, a fixed 2026 Automated Ball-Strike challenge-review
  padding, and a bounded modifier from the betting market's own
  total-runs line (`mlbOddsDurationModifier` — more total runs means more
  baserunners/pitching changes and real additional broadcast time).
- **NBA**: adds an expected-value overtime term plus a rivalry/national-
  broadcast modifier.
- **EPL**: adds a derby modifier, clamped to a realistic min/max.
- **F1**: the race session uses a per-circuit baseline (fuzzy-matched from
  ESPN's own circuit name), capped at the sport's real regulatory maximum.

Every input here is a fact already available *pre-game* from ESPN's own
scoreboard (team names, venue, national broadcaster, betting odds) —
nothing here is a guess: an unrecognized team/circuit just contributes a
neutral default rather than skewing the estimate or failing the build.
This feeds every scheduling decision downstream
(`effectiveDurationMinutes` / `schedulingDurationMinutes` / the overrun
buffer, see [The Viewing Plan Algorithm](#the-viewing-plan-algorithm)), not
just the on-card time range, so a more accurate per-fixture number improves
the whole viewing plan, not just what's printed on one card.

Once a fixture is actually live, `estimateLiveDurationMinutes`
(`public/lib/recommendation.mjs`, called from `pollLiveMatches`, see [Live
Score/Odds Polling](#live-scoreodds-polling)) further corrects this same
`durationMinutes` field from ESPN's own real-time progress (current
inning/quarter+clock/match-minute), blended with the pre-game estimate
rather than replacing it outright. This is the direct answer to MLB's own
reported "estimate drops out by 30-60 real minutes" gap: the pre-game
formula above is still a genuine prediction with real uncertainty (extra
innings and rain delays are not knowable in advance), but a live game's own
actual pace can now correct that estimate in real time instead of the
schedule staying pinned to a single guess for the whole broadcast.

### Taiwan broadcast source

`resolveWhereToWatchTw` (`public/lib/match-builder.mjs`) — 愛爾達體育台 is
the hardcoded default for every sport this site covers. The one exception
is MLB's Apple TV "Friday Night Baseball" package, a genuine global
streaming exclusive with no regional blackout. ESPN's own `broadcast`
field (already fetched for every fixture) already reports this reliably,
so detecting it is a plain string check (`/apple\s*tv/i` against that
field, MLB fixtures only), never a live search or a model guess.

Neither of these has any AI role, and both are, and have long been, fully
deterministic from data ESPN already provides. A separate, bounded, and
since-removed AI experiment existed elsewhere in this pipeline (see [The
Gemini Tie-Break: A Removed
Experiment](#the-gemini-tie-break-a-removed-experiment)), but it never
played any part in either duration or broadcast-source resolution, or in
`objective-score.mjs`'s own scoring — it was a once-a-day tie-break layered
on top, at the recommendation-plan level, never a re-guess of duration,
broadcast, competitiveness, or watchability.

## Broadcast Service Registry

`SERVICES` in `public/app.js` maps `whereToWatchTw` text (a fixed rule's
output, not free-form AI wording) to a small badge for exactly three
services this site's owner actually tracks: 愛爾達, Apple TV, Netflix —
kept text-matched rather than collapsed to an enum only so a future third
service has a ready slot. Any *other* broadcaster still shows up as plain
text on the card either way (see `watch-text` in `buildMatchCard`) — it
just doesn't get a logo/color badge, since this registry only exists to
badge the handful of services actually worth tracking.

All three render each service's own real, official mark, hotlinked rather
than reproduced into this repo, the same posture as the team/F1 logos
pulled from ESPN's CDN elsewhere in this app: Netflix and Apple TV via
Wikimedia Commons' `Special:FilePath` hotlink redirect (confirmed live, not
assumed), 愛爾達 via 愛爾達電視's own official Android app icon on the
Google Play Store (Commons had nothing usable for that one). `logoBg`
behind each mark is a two-stop gradient, not a flat fill, purely so the
badge reads as a designed icon rather than a plain colored sticker sitting
behind the logo. If a hotlink ever fails to load, it falls back to a plain
colored-initial badge (the same `onerror` pattern as team logos) rather
than an empty box.

`DEFAULT_MY_SERVICE_IDS` names which of those the site's owner actually
subscribes to (愛爾達, Apple TV, Netflix, as of writing) — fixed, not a
per-viewer Settings toggle. An earlier version let each viewer pick their
own, which added a whole settings section for a nudge that's only ever
meaningful for this site's own owner. It only ever feeds a silent score
nudge (`OWNED_SERVICE_SCORE_BONUS`) in `resolveViewingPlan` — there is no
visible mark on the card either (an earlier version showed a small
"已訂閱" tag, dropped as one more thing competing for attention on every
card for information only this site's own owner ever acted on) — the same
tie-breaking spirit as sport priority: a great game on a service a viewer
doesn't have still shows up and can still be recommended; this only tips a
genuinely close call toward the one they can actually watch live right
now. Adding a new tracked service later is one more entry in `SERVICES`;
nothing else in the file needs to know about it, the same pattern as
`SPORT_LABELS_ZH` for sports.

## Local-Only Data & Privacy

Every per-viewer preference — sport priority order, which sports are
enabled, and which swiped match a viewer Prefers for a slot — lives in this
browser's own `localStorage` and nowhere else. There is no sign-up, no
account, and no server-side sync of any kind. An earlier version of this
site had a cross-device settings-sync feature (a shared passcode through
the same shared Cloudflare Worker `/sports-proxy` uses); it's gone now, on
purpose — one browser, one set of local preferences, nothing to pair or
lose track of across devices.

Match data and scores are fetched and scored independently by each
viewer's own browser (see [How It Works](#how-it-works)) — never shared or
synced between viewers, and never stored in `localStorage` either, since
they're cheap to re-derive live and would just go stale sitting there. (An
instant-paint snapshot of the *last successful build* is cached to
`localStorage` for perceived load time only — see [Instant Paint from a
Cached Snapshot](#instant-paint-from-a-cached-snapshot) — which is a
different thing from ongoing sync between viewers.)

There is also only ever one recommendation system, not a choice between
competing ones — see [The `bestMatchScore`
Blend](#the-bestmatchscore-blend).

## Live Match Data & Refresh

Every fixture's score is computed fresh, by the viewer's own browser, every
time they open this page and on an ongoing refresh after that — not once,
ahead of time, on a schedule, in a server-side build the way this site used
to work. That whole build-and-redeploy cycle is gone. The browser talks to
exactly one endpoint on the shared proxy, `/sports-proxy` — a thin,
host-allowlisted CORS passthrough to ESPN, the MLB Stats API, Jolpica, and
Polymarket's Gamma API (none of the four sets CORS headers for arbitrary
origins, so a browser can't read any of their responses directly) — never
Gemini or any other AI service.

### Two fetch-and-score refresh tiers

`buildMatches` (`public/lib/match-builder.mjs`) — the same fetch-and-score
pipeline described in [How It Works](#how-it-works) — runs on two refresh
tiers, both through `/sports-proxy`, chosen because ESPN's own scoreboard
endpoint has no multi-day range query for a team sport (confirmed live —
only F1's own `racing/f1` endpoint accepts one), so fetching the whole
14-day window really is one request per league per day, not something a
single cheap query could replace:

- **Near-term** (today + tomorrow, `NEAR_TERM_DAYS_AHEAD`) — cheap, a
  handful of requests, so this runs often (`NEAR_TERM_REFRESH_MS`, every 60
  seconds): new fixtures, scores, and odds for what's actually happening
  soon are the ones worth being genuinely live about.
- **Full window** (the whole 14-day horizon) — expensive (50+ requests),
  so this runs far less often (`FULL_REFRESH_MS`, every 5 minutes): a
  fixture 10 days out doesn't need up-to-the-minute freshness.

Both tiers merge into whatever's already loaded **by id**
(`mergeFreshMatches`) rather than replacing it wholesale — the near-term
tier only ever re-fetches a couple of days, so a wholesale replace would
wipe out every far-future day the last full refresh already populated; and
`buildMatches` itself degrades a single league's own fetch failure to an
empty list for just that league rather than throwing, so replacing the
whole match set with a result where one league came back empty would
delete every match of that league from the page over a single transient
network blip. `mergeFreshMatches` also carries forward each match's own
`.live` detail and live-corrected `durationMinutes` (see [Live Score/Odds
Polling](#live-scoreodds-polling)) rather than letting the fresh,
pre-game-only `buildMatches()` result silently wipe them — an earlier
version didn't, so the live status widget visibly disappeared and
reappeared on every single near-term/full-window tick until the next live
poll (up to 30s later) put it back.

`mergeFreshMatches` also caps how far into the *past* a match is allowed to
linger (`MATCH_RETENTION_PAST_DAYS`, 1 — i.e. 昨天/yesterday, never the day
before that): without this, a match fetched once during a lookback window
(see `fetchTeamLeagueMatches`'s own 2-UTC-day margin, needed to correctly
capture yesterday for a Taiwan viewer from a UTC-anchored query) never got
removed just because a later fetch's own window moved past it — the
upsert-by-id merge only ever adds/overwrites, never deletes — so it sat in
`state.allRawMatches`/the localStorage snapshot indefinitely: both an
unbounded memory grow over a long-lived tab and a real, live-reported bug
(a fixture from two days ago still showing its own day pill, well past this
site's own one-day "yesterday" design). The cutoff is in the viewer's own
local calendar day, the same concept `dayLabelFor`'s 今天/明天/昨天 labels
already use, not UTC.

Before either refresh tier's first result lands (a first-ever visit with no
instant-paint snapshot yet, or one just invalidated by a new deploy, see
[Instant Paint from a Cached Snapshot](#instant-paint-from-a-cached-snapshot)),
a `#loading-state` spinner is shown by default rather than leaving the page
blank while `#app`/`#empty-state`/`#error-state` all still say `hidden` —
this was live-reported as confusing before it existed. `applyFreshBuild`,
the one function both the snapshot paint and every real refresh funnel
through, hides it the instant either produces something to show; a total
failure with nothing loaded at all swaps it for `#error-state`'s own
explicit message instead.

### Version Detection & Manual Refresh

Settings' **立即重新整理** button just re-runs the full-window tier
immediately, in the viewer's own browser — there's no server-side rebuild
to dispatch and wait 30-60 seconds for anymore; a manual refresh is exactly
as fast as the automatic ones.

It also checks whether a *new version of the page itself* has been
deployed since this tab loaded, not just whether the match data changed.
This site has no service worker (`manifest.webmanifest` only makes it
installable; it doesn't add an offline cache or an update lifecycle) —
instead, every time this button is pressed, a fresh `cache: 'no-store'`
fetch of `app.js` reads back the `APP_BUILD_ID` (the commit sha
`deploy.yml`'s own sed step stamps into it on every deploy) embedded in the
live file's own source, and compares it directly against this tab's own
`APP_BUILD_ID`. An earlier version compared `app.js`'s own ETag/
Last-Modified response header instead, snapshotted once at load — this was
live-reported as never actually hiding the reload button even on the
newest version, since GitHub Pages' CDN can hand back a different ETag for
byte-identical content across separate requests (different edge
node/compression variant), which reads as "changed" when nothing really
did. Comparing the build id embedded in the file's own content instead of
a CDN header has no such false positive — two copies of the same deploy
are byte-identical. A genuine difference reveals a second "發現新版本，點
此重新載入" button — the only way to actually replace a page's own running
JavaScript, which re-fetching match data alone can never do.

That button navigates to a cache-busted URL (`location.pathname + '?_=' +
Date.now()`, via `location.replace`) rather than calling a bare
`location.reload()`. `index.html` itself is served by GitHub Pages with
`cache-control: max-age=600` — a plain reload made within that window can
be satisfied entirely from this browser's own local HTTP cache with no
network request at all. This was live-reported as the reload button still
doing nothing ("never hide") even right after the build-id check above was
already fixed: the check was telling the truth, the click just wasn't
acting on it. A never-before-fetched URL forces a genuine network request
this browser can't answer from disk (GitHub Pages' own CDN was ruled out
separately — it purges/repopulates on every deploy, confirmed live within
seconds of a push, so by the time a viewer would ever click this button
the CDN is already serving the correct content; it was only ever this
browser's own local cache in the way, not the CDN's).

### Instant Paint from a Cached Snapshot

Every successful build is cached to `localStorage`
(`matchfind-match-snapshot`) and painted immediately on the *next* page
load, before any network request for that load has even started — the
real refresh tiers still always run right behind it and quietly correct
whatever the snapshot showed, so this is purely a perceived-load-time fix
(a viewer on a slow connection sees last visit's own list instantly instead
of a blank shell), never a substitute for a real fetch. A snapshot older
than `MATCH_SNAPSHOT_MAX_AGE_MS` (30 minutes) is ignored rather than
painted, since a stale-enough copy is more likely to mislead (a
finished-vs-still-scheduled fixture) than to help. It's also tagged with
the deploy that built it (`APP_BUILD_ID`, stamped by `deploy.yml`'s own sed
step with that build's commit sha) — a snapshot from a *different* deploy
than the one currently running is wiped rather than painted, since a code
change can change the shape this app's own rendering assumes (a renamed
field, a newly-required one), and a viewer who never manually refreshes
could otherwise sit on a stale, mismatched snapshot indefinitely.

### Efficiency: Caching & Fetch-Skipping

Two layers of caching keep this from being as expensive as it sounds,
since both refresh tiers plus live polling can otherwise add up to several
times the shared proxy's own per-IP rate limit on a single open tab alone:

- **In-tab request cache** (`proxyFetchJson` in `public/app.js`) — every
  `buildMatches()` call's own fetches are cached in memory, per exact
  upstream URL, for `PROXY_FETCH_CACHE_TTL_MS` (45s), with concurrent
  identical requests coalesced into one in-flight call. Near-term and
  full-window's own date ranges overlap heavily (today/tomorrow are
  fetched by both), so without this, every single page load re-fetched
  the same handful of URLs twice, back to back, for no reason. This
  doesn't apply to `pollLiveMatches`'s own faster tier, which always makes
  a fresh request every tick since live score/odds data can't tolerate a
  45s-old cache.
- **Shared edge cache** (`SPORTS_PROXY_CACHE_TTL_SECONDS` in
  `jaypengx-collab/shared-proxy`'s `sports-proxy-worker.js`) —
  `/sports-proxy` itself caches every successful upstream response for 20
  seconds, keyed by the upstream URL alone, so concurrent viewers (and this
  tab's own live-poll tier, which isn't covered by the in-tab cache above)
  share one real upstream fetch instead of each paying for their own; a
  cache hit doesn't count against that route's own rate limit either. On a
  cache miss, that Worker also runs its own rate-limit check (a Workers KV
  read) and the actual upstream fetch *concurrently* rather than one after
  the other — removing a real KV round trip from the critical path of
  every ordinary request.
- **Skips a disabled sport's fetch entirely** — `buildMatches`' own
  `enabledSports` param (Settings' 已啟用的運動 toggles, see [Sport
  Priority & Settings](#sport-priority--settings)) means a league that's
  turned off isn't just filtered out of what's shown; its ESPN/F1 fetch,
  Polymarket odds enrichment, and standings fetch never happen at all on
  either refresh tier — a real reduction in requests-per-refresh (and in
  load on `/sports-proxy` itself) proportional to how many of the 4 sports
  are actually kept on. Turning a sport back on immediately kicks off a
  full-window refresh in the background, so it backfills right away
  instead of waiting for whichever refresh tier happens to fire next.

### The Shared Proxy Architecture

`public/app.js`'s own `PROXY_URL` constant points at a Cloudflare Worker in
its own dedicated repo,
[jaypengx-collab/shared-proxy](https://github.com/jaypengx-collab/shared-proxy) —
but it's a *different* Worker deployment from the one Orbit/Orbit Vocab's
own AI/sync features use there, not the same URL with a different path.
`/sports-proxy` used to live on that same shared Worker as those two
sites' Gemini-backed features, but that Worker's `[placement]` region pin
(see that repo's own README) is a whole-script setting that was forcing
this route through a pinned Virginia isolate too, adding real,
live-confirmed latency for this site's own Taiwan-based audience with no
benefit (nothing `/sports-proxy` calls has Gemini's region restriction).
It was pulled out into its own separately deployed, unpinned Worker to fix
that — `PROXY_URL` here points at *that* Worker, not `orbit-workers-proxy`.
`/sports-proxy` itself is a plain, host-allowlisted CORS passthrough with
no Gemini involvement. That region-pin issue was a genuine, previously
undiscovered contributor to reports of the first load going blank for 10+
seconds and refreshes taking 10-20+ seconds — confirmed live via an
`X-Worker-Colo: IAD` response header on a plain `/sports-proxy` call before
the split.

Unlike Orbit/Orbit Vocab's own `PROXY_URL` (a GitHub Actions Variable
substituted in at their own build time), Match Find has no build step left
to substitute anything into — its `PROXY_URL` is a plain constant written
directly into `public/app.js`'s own source, pointing at the real deployed
Worker. If you fork this repo and deploy your own shared-proxy Worker,
update that constant to your own Worker's base URL (**no path suffix**);
there's no environment variable to set instead.

### The Gemini Tie-Break: A Removed Experiment

Match Find tried adding a small, bounded Gemini call at the
recommendation-plan level three separate times, and removed it every time.
This is a different thing from the per-fixture scoring AI removal covered
in [Why AI Was Removed From Scoring](#why-ai-was-removed-from-scoring) —
after that removal, the deterministic engine was the sole source of truth
for every fixture's *score*; this later experiment never touched scoring
at all, only which fixture won one day's headline recommendation slot.

1. **First attempt**: a bounded Gemini call (`/match-recommend`, on the
   shared proxy's *other*, `orbit-workers-proxy` Worker) added an
   at-most-once-per-day tie-break for whichever day's headline slot the
   deterministic engine's own top pick had a real alternative for.
2. **Second attempt**: the answer was forced in via `computeDayPlan`'s own
   pin mechanism (the same one a viewer's own swipe-to-pin uses), and
   Google Search grounding was turned on.
3. A real multi-slot selection bug was then fixed, and the mechanism was
   live-tested directly against the deployed Worker — where grounding was
   found hard-blocked by a `429` free-tier quota wall (the same
   `RESOURCE_EXHAUSTED` signature already hit once before during the
   per-fixture scoring era). Grounding was reverted, a plain call was
   confirmed to work, and that live pick agreed with the deterministic
   engine's own choice rather than the human-validated expectation this
   feature existed to guarantee — proof the mechanism only ever
   guaranteed "whatever Gemini says wins," never "Gemini matches any one
   viewer's taste."
4. Grounding was turned back on after the account moved to paid billing,
   with a hard-enforced origin gate plus a daily global call cap added on
   the Shared-Proxy side specifically because live-testing had just shown
   `/match-recommend`'s URL was callable by anyone who read this repo's
   own public source.

**It was ultimately removed entirely**, per direct instruction: "the
credits it's burning is way beyond its improvement to our system." Every
Gemini-related export
(`selectGeminiTieBreakCandidates`/`buildGeminiTieBreakPayload`/
`resolveGeminiOverridePin`/`computeDayPlanWithGeminiTieBreak`/
`GEMINI_TIE_BREAK_MAX_CANDIDATES`) was deleted from
`public/lib/recommendation.mjs`, `public/app.js` no longer imports or calls
any of them (`renderRecommendedSection` calls `computeDayPlan` directly
again), and the `/match-recommend` route was deleted from Shared-Proxy's
`worker.js` outright.

This also fixed a real, separately-reported UI bug: Gemini's forced pin
reused the exact same `forcedIds`/`.isPreferred` mechanism as a genuine
viewer swipe-pin, so a day whose headline slot got a forced Gemini
override showed 偏好 ("Preferred," the viewer's-own-choice tag) instead of
推薦 ("Recommended," the system's-own-judgment tag) — reported as "every
first game recommended of the day is 'Prefer' rather than 'Recommended'."
With Gemini gone, `forcedIds` is populated only from a real viewer pin
again (`state.pinnedChoices`, written only by `pinSlotChoice`/
`preferMatch`), so this can't recur. (The same class of bug resurfaced
later in the back-to-back variety rotation's own forced picks, and was
fixed the same way — see `clearRotationIsPreferred` in [Back-to-Back
Variety](#back-to-back-variety-whole-window-rotation-among-real-close-contenders).)

Match Find's deterministic engine (`public/lib/recommendation.mjs`) is its
only recommendation logic now — no AI call anywhere, for the second time
in this project's history.

## Live Score/Odds Polling

A third, even faster tier sits on top of the two refresh tiers above —
`pollLiveMatches` (`public/app.js`) polls just score/status/odds for
whatever's already loaded, on a much shorter interval
(`LIVE_POLL_INTERVAL_MS`, 30 seconds) than re-scoring a whole fetch batch
could reasonably run at, by hitting each sport's own narrow live-scoreboard
endpoint (today ± a day, not the whole window) through the same
`/sports-proxy` route and merging the result straight into the same match
objects `buildMatches` already produced — never re-running the
scoring/duration/objective-factor pipeline itself. `init()` also runs this
once immediately on load, rather than letting the first call wait for
`LIVE_POLL_INTERVAL_MS` to elapse the way every later recurring tick does —
without that, the live status widgets couldn't appear any sooner than 30
seconds after every single page load, since `match.live` is only ever set
here. Polling is paused while the tab is hidden. Score/status comes from
ESPN's own public scoreboard; odds come from Polymarket instead (see [Live
Win% Odds](#live-win-odds)) — two separate fetches, since not every sport
this tracks has both (F1 has real, live Polymarket odds but no ESPN score
to poll at all).

This never re-runs objective scoring — it only updates the same
`competitors[].score`/`isFinished`/odds fields ESPN/Polymarket already
report, plus two further, real-time-only refinements built from them:

- **`liveExcitementBonus`** (`public/lib/recommendation.mjs`) — a small,
  bounded bonus added to a live match's `planningScore` (never its true
  `effectiveScore`, the same "adjustment, not override" posture as every
  other nudge in this app) from how close its real current score is,
  weighted by how far into the game it already is. A live match that turns
  out to be a genuine nail-biter can win a scheduling slot a pre-game
  prediction alone wouldn't have given it — the whole day's plan is
  recomputed after every live poll that actually changed something, so
  this can visibly reshuffle what's recommended next.
- **`estimateLiveDurationMinutes`** — described in full in [Duration &
  Broadcast-Source Resolution](#duration--broadcast-source-resolution).

Each team row also shows a `.team-score` (`buildTeamRow` in
`public/app.js`) whenever the match is genuinely live/ending-soon or
already finished — never pre-game, where ESPN's own "0" isn't a real score
yet, just the absence of one. This is the actual score; the widgets below
only ever show in-progress *detail* (inning, quarter, lap) around it, never
the score itself.

### Sport-specific live status widgets

Each live poll also writes a `match.live` object with whatever in-progress
detail ESPN reports for that sport, rendered as a small icon-led widget
right under the team names (`buildLiveStatusNode` in `public/app.js`, only
while the card is genuinely live/ending-soon, never pre-game or finished) —
built as real glyphs rather than a flat sentence, since a plain text line
was reported as easy to miss scanning a busy list of cards:

- **MLB**: a small broadcast-style diamond (`.live-diamond`) with a dot at
  each of 1st/2nd/3rd that lights up green exactly when a runner is
  actually on it, next to the inning + half ("第 6 局上/下/中/完") and an
  outs indicator (3 dots, filled as outs accrue) — from ESPN's own
  `competition.situation` object (`extractLiveUpdates` in
  `public/lib/espn.mjs`). The ball-strike count from that same object is
  deliberately *not* shown — it changes on every single pitch (seconds
  apart), so a fixed 30s poll interval almost never catches the current
  count, only a stale one.
- **NBA**: a pulsing live dot plus the quarter ("第 N 節", OT beyond the
  4th) and ESPN's own last-reported game clock — never locally ticked
  between polls, so it correctly holds at the exact recorded time until
  the next update lands rather than counting down on its own.
- **Premier League**: a pulsing live dot plus the half (上半場/下半場) and
  ESPN's own match clock (which already includes stoppage time in its own
  text, e.g. "45'+2'") — or ESPN's own state word (e.g. a halftime label)
  shown as-is when there's no numeric clock to attach it to. Same as NBA,
  this is ESPN's own last-reported value, never locally ticked.
- **F1**: a small colored flag icon (green/yellow/red/safety-car/checkered,
  read from ESPN's own status text, e.g. "Safety Car" or "Checkered Flag" —
  the caution flags flash to catch the eye the way a real broadcast overlay
  would) plus the current lap, from a second extractor
  (`extractF1LiveUpdates`) reading the same `racing/f1` scoreboard
  `match-builder.mjs` already uses for the schedule, this time for its
  per-session `competitors` array (drivers, ordered by ESPN's own live
  classification). The race's current top 3 also renders as its own row of
  medal-colored rank chips (gold/silver/bronze), each with that driver's
  own nationality flag (`athlete.flag` — the one real per-driver icon this
  API actually has; there's no headshot or constructor/team field at all)
  and a gap/interval figure if ESPN ever reports one (checked against
  several real race weekends — `competitor.statistics` came back empty
  every time, so this is read defensively rather than guessed/computed),
  right under the static outright win% chips (see [Live Win%
  Odds](#live-win-odds)) — live running order as context for those odds,
  not a replacement.

### Foreground-return refresh and the "next update" countdown

Every refresh timer above (near-term/full-window/live-poll) reschedules
itself on its own fixed interval even while the tab is hidden — it just
skips the actual fetch each tick. Left alone, a tab backgrounded for
several minutes and brought back gets nothing fresher until whichever
timer next happens to fire, by accident of when it was hidden — this reads
as "the app doesn't notice I came back" even though a refresh was
genuinely overdue. A `visibilitychange` listener
(`handleForegroundReturn`) tracks how long the tab was actually hidden and,
once it's visible again, forces an immediate near-term refresh plus a live
poll right away (plus the full window too, if the tab was away at least
`FULL_REFRESH_MS` itself) — but only once the tab was away longer than
`FOREGROUND_STALE_MS` (30 seconds), so a quick app-switch-and-back doesn't
double up on a refresh that just ran moments ago.

A small `#next-update-note` readout in the footer ticks down every second
to the soonest of the three tiers' own next-scheduled instant (the live
poll only counts while something's actually worth polling, see
`matchWorthPollingNow`), so a viewer watching a live match can see exactly
when its next update is coming rather than only finding out after the
fact.

## Live Win% Odds

Every card that has a real market open for it shows a devigged win%
sourced from Polymarket (`public/lib/polymarket.mjs`) — never a guessed or
defaulted 50/50, hidden entirely when no market exists yet for that
fixture. This was chosen over a sportsbook-odds feed (an earlier version of
this feature used ESPN's own) specifically because a real prediction
market's own trade price already *is* a probability (no American-odds
conversion needed), and it runs a genuine market on every sport this site
tracks, including F1 — both the Race (an outright winner market across the
whole grid) and Qualifying (a separate "Driver Pole Position" outright
market, same shape) — shown as the top 3 favorites, not a two-sided bar,
since that wouldn't make sense for a 20-driver field, something no
sportsbook feed here ever covered. MLB/NBA get a single combined
two-outcome market; EPL's own market is a genuine three-outcome one
(home/draw/away), read from three separate binary markets in the same
event and devigged together. Each side of a two-/three-way bar is colored
with that team's own real brand color (`public/lib/color.mjs`'s WCAG
contrast check — falling back to a fixed sport accent only when neither of
a team's two colors reads legibly against the card's current background).

F1's own outright markets (Race winner, Pole position) use a different
devig function than the team-sport markets above — `devigPowerMethod`
instead of `devigNWay` — because they're structurally different: MLB/
NBA/EPL each have one single combined market whose own two or three sides
already sum close to 1 on their own (real, tiny vig). F1's outright field
is roughly 23 completely separate, independently-priced Yes/No books, one
per driver, with no shared liquidity forcing them to add up correctly —
live-verified: a real Azerbaijan GP pole-position market's 23 raw "Yes"
prices summed to 4.52, not roughly 1. Naive proportional rescaling (divide
every price by that total) assumes every driver's book carries the same
proportional overround, which is false: a rarely-traded longshot's own
price is inflated far more than a heavily-traded favorite's (a
well-documented prediction-market effect, "favorite-longshot bias") —
live-reported as a leading driver showing an oddly low, flat-looking
percentage (e.g. a real ~45.5% favorite reading as "10%"), indistinguishable
from "no real favorite" even though the market disagreed.
`devigPowerMethod` solves for an exponent `k` such that `sum(p_i^k) = 1`
instead of dividing by the raw total — raising to a power above 1 shrinks a
small price much faster than a large one, so a longshot's own larger excess
gets corrected more than a favorite's smaller one. Percentages still sum to
(near) exactly 100 either way; only how that 100 gets divided up differs.

Polymarket's own Gamma API caps a single request at 100 events regardless
of the `limit` requested, and (a real, live-verified case) MLB alone can
have 170+ currently-open events for its tag at once — not just one event
per game, but a separate event for many games' own player-props/
first-five-winner/inning-9-winner sub-markets too. `fetchAllPolymarketEvents`
pages past that cap, and every request is sorted by the fixture's own real
`startTime` (not `startDate`, which is when Polymarket itself created the
listing) — sorting by listing-creation time had left 50 of 91 real
upcoming MLB fixtures with no odds shown at all, not because no market
existed, but because their event fell outside whichever 100 happened to
sort first by creation time instead of by which game was actually soonest.

## Architecture / Project Structure

```
public/
  index.html               entry point, PWA meta/manifest links
  app.js                   UI, refresh tiers, live polling, Settings, rendering
  manifest.webmanifest     PWA install manifest
  favicon.svg               master icon mark
  icons/                   rasterized PWA icons (icon-180.png, icon-512.png)
  og-image.png             1200x630 social/link-preview card
  styles.css               all styling
  lib/
    match-builder.mjs      buildMatches: fetch pipeline, resolveWhereToWatchTw,
                            finishedDurationMinutes, isTimeTbd
    objective-score.mjs    computeMatchObjectiveScore, skillFromWinPct,
                            buildObjectiveReasonZh
    sport-signals.mjs      per-sport API signal fetching/parsing
                            (MLB Stats API, Jolpica, ESPN standings)
    sport-duration.mjs     per-sport predicted-duration formulas
    recommendation.mjs     bestMatchScore, computeDayPlan,
                            weightedIntervalSchedule, computeVarietyRotation,
                            pinSlotChoice, estimateLiveDurationMinutes,
                            liveExcitementBonus
    espn.mjs                ESPN response parsing, extractLiveUpdates,
                            extractF1LiveUpdates
    polymarket.mjs          Polymarket fetch/devig (devigNWay,
                            devigPowerMethod, fetchAllPolymarketEvents)
    color.mjs                team-color contrast utilities
    team-names.mjs           Traditional Chinese team-name lookup table
    preferences.mjs          localStorage preference read/write helpers
scripts/
  build-data.mjs            Node CLI wrapper around buildMatches, for local
                            dev tooling (writes public/data/matches.json)
  evaluate-recommendations.mjs
                            offline stats over a matches.json-shaped export
  dump-day-plan.mjs         debug tool for inspecting one day's computed plan
tests/
  *.test.mjs                node --test suite covering recommendation.mjs,
                            match-builder.mjs, sport-duration.mjs,
                            objective-score.mjs, sport-signals.mjs,
                            polymarket.mjs, color.mjs, evaluate-recommendations.mjs
docs/
  recommendation-engine-audit.md
                            the full engineering history this README is
                            distilled from — every round of live-tested
                            fixes and design decisions, in chronological order
.github/workflows/deploy.yml
                            publishes public/ to GitHub Pages on every push
                            to main (or on-demand); runs the test suite first
```

## Getting Started

### Local development

```bash
node scripts/build-data.mjs        # writes a public/data/matches.json snapshot
npx serve public                   # or any static file server
```

`scripts/build-data.mjs` is a thin Node CLI wrapper around
`public/lib/match-builder.mjs`'s own `buildMatches` — the exact same
fetch-and-score pipeline the deployed site runs live in the browser, just
callable directly from Node (which can reach ESPN/Polymarket/the MLB Stats
API/Jolpica without going through the shared proxy at all). It's kept
purely for local dev/debugging tooling — the deployed site itself no
longer depends on it or its output. No API key or setup is needed —
`public/lib/objective-score.mjs` and the MLB/F1 API signal fetches
(`public/lib/sport-signals.mjs`) run entirely from free, public, no-key
APIs, and this CLI calls them directly rather than through the shared
proxy.

### Running the test suite

```bash
npm test
```

This runs `node --test` against `tests/*.test.mjs`, with no dependencies to
install. `public/lib/recommendation.mjs` holds every pure scoring/viewing-
plan function (recommendation blending, overlap/slot grouping, weighted
interval scheduling, `computeDayPlan`, `resolveViewingPlan`, confidence),
extracted out of `public/app.js` specifically so it's testable without a
DOM and reusable from `public/lib/match-builder.mjs`. Coverage also
includes `match-builder.mjs`'s own pure ESPN-shape helpers (including
`resolveWhereToWatchTw`/`computeDurationMinutes`/
`computeMatchObjectiveScore`), `sport-duration.mjs`'s own per-sport
duration formulas, `objective-score.mjs`'s own deterministic scoring
formulas, `sport-signals.mjs`'s own pure API-response parsing (hand-built
fixtures shaped like the MLB Stats API's/Jolpica F1 API's own documented
formats, not a live response), `polymarket.mjs`'s own real-market
matching/devig logic, and `color.mjs`'s own WCAG contrast math (both built
from real, live-fetched sample data). The suite also runs as its own step
in `.github/workflows/deploy.yml`, on every push/dispatch. See
`docs/recommendation-engine-audit.md` for the fuller writeup of what's
covered and why.

### Evaluating a historical export

```bash
node scripts/evaluate-recommendations.mjs <export.json> [more.json ...]
```

Reads one or more `matches.json`-shaped files — a copy saved from
`node scripts/build-data.mjs` or straight from a browser's own devtools
works fine; there is no in-app export button anymore (see [No Developer
Tools in the UI](#no-developer-tools-in-the-ui)) — and reports recommended
count/rate, sport concentration, score/confidence distributions, and how
often the same two teams (or F1 session) get recommended across multiple
distinct dates in the export. This is reported as a descriptive rate, not
flagged as a bug, since a real multi-game series is supposed to do exactly
that in a day-by-day plan (see [The Viewing Plan
Algorithm](#the-viewing-plan-algorithm)). It accepts multiple files so it
can be pointed at a week's worth of separately-saved exports at once
instead of judging one day in isolation.

### Deployment

This repo deploys itself: `.github/workflows/deploy.yml` publishes
`public/` to GitHub Pages on every push to `main` (or on-demand via the
Actions tab). There is no scheduled rebuild anymore, and nothing for it to
rebuild — the match list is fetched and scored live, in each viewer's own
browser, on load and on its own two refresh tiers (see [Live Match Data &
Refresh](#live-match-data--refresh)), not from a static file this workflow
used to regenerate every 15 minutes. This workflow's only job is shipping
code changes.

Make sure the repo's **Settings → Pages → Source** is set to **GitHub
Actions** (no branch to pick — the workflow handles publishing).

### Icons and link previews

`public/favicon.svg` is the one master mark; `public/icons/icon-180.png`
(apple-touch-icon, e.g. "加入主畫面" on iOS Safari) and `icon-512.png`
(`manifest.webmanifest`) are rasterized from it, and `public/og-image.png`
(1200×630) is what a shared link's preview card shows (Messages, Slack,
etc. — see the `og:image`/`twitter:image` tags in `index.html`). All three
PNGs were generated once with headless Chromium screenshotting the SVG at
each size/composition — see the render script referenced in this repo's
commit history if the mark itself ever changes and they need
regenerating; there's no build step that does this automatically.

### Fixing a team's Chinese name

Edit `public/lib/team-names.mjs` — it's a plain object keyed by league id
and ESPN's team abbreviation (e.g. `mlb.NYY`). A missing or wrong entry
doesn't break anything: the site just shows that team's English name only.

## Known Limitations

- **EPL has no recent-form signal** — ESPN's `soccer/eng.1` standings
  endpoint has no per-team streak/last-5 figure at all (see [Known Scoring
  Limitations](#known-scoring-limitations)).
- **No injury data and no real-time media/narrative signal** in the
  deterministic scoring engine — neither is knowable from the data sources
  this build fetches, and adding either back would mean a new paid data
  source or the per-fixture AI grounding that was tried twice and removed
  both times.
- **F1's per-race modifiers (safety car, weather) aren't modeled** — not
  knowable before a race starts from data this build already has.
- **F1 has no live per-lap timing feed**, so `estimateLiveDurationMinutes`
  always keeps F1's pre-race estimate rather than correcting it live, the
  way MLB/NBA/EPL's durations get corrected in-progress.
- **Ball-strike counts aren't shown live for MLB** — they change on every
  pitch, seconds apart, so a fixed 30-second poll interval would almost
  always show a stale count rather than the current one.
- **F1 gap/interval figures aren't always available** live — ESPN's own
  `competitor.statistics` field has come back empty on every real race
  weekend checked, so it's read defensively rather than relied on.
- **MLB's marquee-credit ramp (`marqueeCreditFraction`) is MLB-only** —
  NBA and EPL default to full rivalry-bonus credit unconditionally. This
  isn't a standings-depth gap (NBA's own standings integration now matches
  MLB's — seed-cutoff gaps, last-10 record, streak — see
  `computeNbaObjectiveScore`); it's a deliberate choice to keep protecting
  NBA/EPL's name-based bonuses (rivalry, derby, big-club, national
  broadcast) from early-season sampling noise a full-season MLB-style gate
  would wrongly silence — the real case (Liverpool @ AFC Bournemouth, an
  early-season noisy 0.2/0.6 split) that bonus was written to survive.
- **The published `checksums.txt`-style reproducibility concerns from
  this org's other repos don't apply here** — Match Find has no compiled
  build artifact; what's deployed is the same static JavaScript reviewed
  in source.

## Related Projects

Match Find is one of several sites sharing the same backend/tooling
infrastructure in the `jaypengx-collab` GitHub organization:

- **[Shared-Proxy](https://github.com/jaypengx-collab/Shared-Proxy)** — the
  Cloudflare Worker backend, including the `/sports-proxy` route this site
  depends on for all live data (see [The Shared Proxy
  Architecture](#the-shared-proxy-architecture)).
- **[Orbit](https://github.com/jaypengx-collab/Orbit)** and
  **[Orbit-Vocab](https://github.com/jaypengx-collab/Orbit-Vocab)** —
  sibling sites that share the same Worker infrastructure (a different,
  Gemini-backed deployment of it), though not Match Find's own
  `/sports-proxy` Worker specifically.

---

**Live site: [https://jaypengx-collab.github.io/Match-Find/](https://jaypengx-collab.github.io/Match-Find/)**
