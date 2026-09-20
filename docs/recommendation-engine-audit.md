# Recommendation engine audit — response and changes

This documents what changed in response to a recommendation-engine audit
report (dataset: a `match-find-export-*.json` produced by this repo's own
"匯出資料" Settings button, i.e. `exportRecommendationData` in
`public/app.js`), and — just as importantly — which of the audit's claims
don't actually apply to this codebase, and why.

## How the audit's claims line up with the real code

The audit was written against an exported snapshot without seeing the
implementation behind it, and reads as if describing a large,
multi-service recommendation platform (sport-specific model adapters,
per-feature freshness timestamps, a five-stage normalize/enrich/score/
diversify/explain pipeline, an A/B-testable weight config). The actual
system is a small static site: `scripts/build-data.mjs` fetches ESPN
fixtures and asks a shared Gemini-backed proxy for four numbers
(competitiveness/watchability/broadcastQuality/enduranceScore) once per
match, and `public/app.js` turns that into one viewer's own day-by-day
back-to-back viewing plan. Several of the audit's "bugs" turned out to be
this existing design working as intended:

- **"Duplicate recommendations"** (§5) — the export shows the same two
  teams (e.g. Rays–Yankees, Padres–Dodgers) recommended on several
  consecutive dates. This is not deduplication failure: `recommended` is
  decided **per calendar day** by `computeDayPlan`, which ensures two
  same-day, near-totally-overlapping fixtures (`isNearTotalOverlap`, ≥75%
  overlap of the shorter match's duration) can never both be
  `recommended: true` on the same day. A 4-game series recommended on 4
  different dates is 4 distinct real events, each with its own plan — not
  one event duplicated. `scripts/evaluate-recommendations.mjs` (added,
  see below) reports this as a **recurring-matchup rate**, descriptively,
  not as an error. (`groupIntoSlots` is what computes that same-day
  grouping - see "Round 2" below for how its role changed from gating the
  scheduler to a presentation-only label computed after scheduling, and
  for the cross-day repeat penalty added since this paragraph was
  originally written.)
- **"effectiveScore isn't explainable"** (§6) — the arithmetic
  (`styleScore + priorityNudge + serviceNudge`) was already simple and
  additive (matching the audit's own §15 recommendation that priority
  stay an additive tie-breaker, not a multiplier — it already was). What
  was missing was a structured, testable form of that same arithmetic.
  Added below.
- **"broadcastQuality is being treated as entertainment quality"** (§8) —
  already a separate field, already blended in at a fixed, deliberately
  small 15% weight (`BROADCAST_QUALITY_WEIGHT`), never the primary score.
  Unchanged.
- **"Priority order dominates instead of tie-breaking"** (§15) — already
  additive (`PRIORITY_SCORE_DELTA`, symmetric around the middle rank),
  already small relative to the 1–10 score scale. Unchanged.
- **Finished/upcoming/live separation** (§20, P0 #2) — already enforced:
  a finished match gets `score: 0`, `source: 'finished'`, no AI call, and
  `computeDayPlan` filters `!m.isFinished` before it can ever become a
  candidate.

What the audit got right, and what this change addresses: there was no
pure, independently testable scoring function; no confidence signal
anywhere; no automated tests at all; and no offline evaluator for a
historical export. Those are real gaps and are what changed.

## What changed

### 1. Extracted pure scoring/viewing-plan logic

All of `public/app.js`'s scoring and viewing-plan math — recommendation
style blending, overlap/slot grouping, weighted interval scheduling,
`computeDayPlan`, `resolveViewingPlan`, the broadcast-service registry —
moved to a new `public/lib/recommendation.mjs`. It has zero DOM/
localStorage dependencies, so it's directly unit-testable and directly
importable from `scripts/build-data.mjs` (for confidence — see below)
without duplicating logic across the two files. `public/index.html` now
loads `app.js` as `type="module"` so it can `import` from it.

**Behavior is unchanged** — this is a mechanical extraction, not a
rewrite. `computeDayPlan` picked up one new parameter
(`pinnedForDay`, previously read from `public/app.js`'s own module-level
`state` global) purely so it stays a pure function of its arguments; the
one call site that needs it now passes `state.pinnedChoices.get(dayKey)`
explicitly.

### 2. Explicit score breakdown (old §6)

```js
computeRecommendationScore(match, { priorityOrder, myServiceIds })
// -> { baseScore, adjustments: { broadcastQuality, priority, service }, finalScore, confidence }
```

`resolveViewingPlan` now attaches this as `match.scoreBreakdown` and
`match.confidence` on every match it returns (additive fields — nothing
existing was renamed or removed), so the exported JSON now shows exactly
how `effectiveScore` was arrived at instead of a bare number.

**No weights changed.** `BROADCAST_QUALITY_WEIGHT` (0.15),
`PRIORITY_SCORE_DELTA` (1), `OWNED_SERVICE_SCORE_BONUS` (0.5) are exactly
what they were — this only makes the existing arithmetic legible.

### 3. Confidence (old §9)

`computeConfidence(match)`, grounded in exactly what the AI score cache
already tracks (`source`, and now `refined`, newly surfaced from the
cache onto the match object itself in `build-data.mjs`):

| source                       | confidence |
|-------------------------------|-----------|
| `finished` (never scored)     | `null`    |
| `ai`, comparative-refined     | `0.9`     |
| `ai`, base pass only          | `0.7`     |
| `heuristic` (no Gemini call)  | `0.35`    |

This is deliberately coarse — see "Known limitations" below for why it
isn't the fuller freshness-decay model the audit describes. It's computed
once at build time (`build-data.mjs`, so it's in `matches.json` and every
export) and recomputed identically client-side (`resolveViewingPlan`, so
an older cached `matches.json` without the field still gets one).

### 4. Automated tests (old §13, §17)

`tests/` (Node's built-in test runner, `npm test` / `node --test`, no new
dependencies): `recommendation.test.mjs` (score math, confidence tiers,
overlap/near-total-overlap boundary cases, slot grouping, weighted
interval scheduling optimality, quiet-hours, finished-match exclusion,
pinned-choice override, `overlappingIds` bookkeeping),
`build-data.test.mjs` (the pure ESPN-shape helpers: `isTimeTbd`,
`parseOverallRecord`, `oddsContext`, `heuristicScore`), and
`evaluate-recommendations.test.mjs` (the new evaluator itself). 59
assertions total. Wired into `.github/workflows/deploy.yml` as a
`Run tests` step before the build step, so a regression fails CI before
it ever reaches a live deploy.

`scripts/build-data.mjs` gained an entry-module guard
(`if (isMain) { main()... }`) so its pure helpers can be imported by tests
without triggering a live ESPN/Gemini build as a side effect of import.

### 5. Offline evaluator (old §7, P2 #10)

`scripts/evaluate-recommendations.mjs <export.json> [more.json ...]` —
reads one or more `matches.json`/export-shaped files and reports:
recommended count and rate, sport concentration, the recurring-matchup
rate (see above), score/effectiveScore/confidence distributions. Accepts
multiple files so it can be pointed at several days' worth of separately
saved exports at once, per the audit's own "don't blindly optimize
against one day's output."

## Known limitations

- **Confidence is coarse.** It's a 4-value lookup on `source`/`refined`,
  not the freshness-decay-per-feature model the audit describes
  (`featureMeta.standings.fetchedAt`, etc.) — this pipeline has no
  per-feature fetch timestamps anywhere to decay against (ESPN's
  scoreboard response is fetched fresh every ~15 minutes as a whole, not
  per-field), so building that model now would produce a more
  precise-looking number without more actual evidence behind it. Adding
  it would mean funding real per-feature freshness tracking in
  `build-data.mjs` first.
- **No sport-specific scoring adapters.** Every sport still goes through
  one Gemini prompt and one composite formula. The audit's argument for
  per-sport models (an MLB game and a soccer match aren't the same shape
  of "watchable") is reasonable, but building five real per-sport models
  is a substantially larger project than this pass, and this codebase's
  own `durationMinutes`/`enduranceScore` mechanism already absorbs most
  of the practical difference (a 190-minute MLB game and a 115-minute
  soccer match already schedule differently).
- ~~No cross-day diversity/series suppression, by design~~ — **superseded,
  see "Round 2" below.** A second, deeper audit made the case that "a
  day-by-day plan, not a deduplicated feed" was too absolute: nothing
  stopped the SAME matchup from defaulting to winning every single day of
  a series even when a comparably good alternative existed. A soft,
  decaying cross-day repeat penalty now exists (`applyRecentRepeatPenalties`/
  `computeWindowPlan`) - it nudges, never hard-bans, so a genuinely
  dominant matchup can still win on consecutive days.
- **No behavioral feedback loop.** There's no click/watch/dismiss signal
  captured anywhere in this pipeline (it's a static site with no backend
  of its own beyond the shared scoring proxy), so `evaluateRecommendation`-
  style calibration against real user behavior (audit §17) isn't possible
  without adding that instrumentation first — out of scope here.
- ~~Explanations (`reason`) are still Gemini's own free-form text, not
  assembled from the structured feature contributions in
  `scoreBreakdown`~~ — **partially superseded, see "Round 4" below.**
  `reason` is still AI-generated prose, not template-assembled (the
  original audit itself said the prose could stay AI-generated -
  section 23: "The exact prose can remain AI-generated, but its claims
  should be derived from structured evidence") - but the shared proxy's
  prompt now explicitly instructs grounding that sentence in the same
  evidence the score itself was based on, and Round 3's structured
  evidence is shown directly alongside the reason so a viewer can verify
  it independently either way.

## Round 2: deep engine audit response (scheduler correctness + variety)

A second, deeper audit reviewed the actual scheduling implementation (not
just an exported snapshot) and found five real, user-reported bugs plus
several structural causes behind them: destructive pre-grouping that could
throw away the globally best plan, one flat overlap model applied to every
sport regardless of how predictable its length actually is, anchor-order-
dependent grouping, no transition buffer between picks, and no cross-day
memory. This pass fixes the scheduler itself (Phase 1/2 of that audit's own
"implementation order" - Phases 3-5, the AI-scoring/evidence-layer work,
are explicitly deferred, see below); it does not touch `scripts/
build-data.mjs`'s Gemini prompt or scoring.

### 1. Removed destructive pre-grouping - the scheduler now sees every candidate

The single biggest structural bug: `computeDayPlan` used to group
near-totally-overlapping matches into "slots" and hand the weighted-
interval-scheduling DP only each slot's single highest-`effectiveScore`
representative. That threw away information the DP never got a chance to
use - a slightly lower-scoring match that would have allowed a genuinely
great continuation right after it could lose to a higher-scoring match
that blocked the continuation entirely, because the DP was never shown
"pick A alone" vs. "pick B, then C" as a real choice; it only ever saw
"A" vs. "[C's own slot]".

`computeDayPlan` now feeds every individual candidate straight into
`weightedIntervalSchedule` and lets the DP itself find the actual
maximum-value sequence. `groupIntoSlots`'s near-total-overlap clusters
still exist, but purely as a PRESENTATION label (the swipeable card
stack's members, and a pinned choice's stable lookup key) computed AFTER
the scheduler has already decided what's actually recommended - never
before it, and never as an input that limits what the scheduler can
choose from.

### 2. Anchor-independent grouping

`groupIntoSlots`'s old algorithm claimed matches around a highest-score
"anchor" greedily, which meant the resulting groups could differ depending
on which match happened to become the anchor first. It's now a plain
union-find over the same pairwise `isNearTotalOverlap` relation -
deterministic, and independent of input order (see the new "groupIntoSlots
is anchor-independent" test).

### 3. One canonical duration model, with real uncertainty for sports that deserve it

`durationMinutes` (ESPN's per-sport nominal average) was previously read
two different ways in two different places - `isNearTotalOverlap`'s
grouping check used the raw nominal duration, while the DP's own
compatibility check used `effectiveDurationMinutes` (endurance-shortened).
MLB's 190-minute nominal length, in particular, was trusted as exactly as
precise as football's 115 or F1's own scheduled session windows, even
though MLB has no clock at all (extra innings, rain delays) - the direct
cause of the reported "missed obvious continuation" bug whenever a great
match was scheduled to start soon after a baseball game's nominal, but
likely inaccurate, end time.

New in `recommendation.mjs`:

- `SPORT_TIMING` / `resolveSportTiming(sport)` - a per-sport
  `durationReliability` tier (`high` for football/MLS/F1, `medium` for
  NBA, `low` for MLB), a flat data table rather than scattered
  `if (sport === 'MLB')` special cases.
- `DURATION_UNCERTAINTY_BY_RELIABILITY` - how much of a low/medium-
  reliability sport's own effective viewing window gets shrunk before it's
  allowed to block a later pick (0% / 10% / 30%). Not a claim about how
  early these games usually end - just an acknowledgment that they
  plausibly could have, which is reason enough to still offer a strong
  later match as a continuation.
- `TRANSITION_BUFFER_MINUTES` (10, flat) - two picks that are technically
  non-overlapping down to the minute still aren't something a real viewer
  can switch between instantly.
- `schedulingInterval(match)` / `schedulingDurationMinutes(match)` - the
  ONE interval the scheduler ever reads (baking in both of the above);
  `canWatchSequentially(a, b)` - the explicit pairwise "can these actually
  be sequenced" relation the earlier audit specifically asked for in place
  of anchor-dependent grouping.

Football/F1/MLS keep exactly their old strictness (0% uncertainty); only
MLB (and NBA, more mildly) got more permissive, and only by the shrink
factor above - not by loosening the near-total-overlap threshold itself.

### 4. Soft cross-day repeat penalty (variety)

`computeWindowPlan(matchesByDayKey, pinnedChoices)` runs `computeDayPlan`
once per day, in chronological order, and tracks the most recent day each
distinct matchup (`matchupKey` - moved here from
`evaluate-recommendations.mjs`, which now imports it instead of keeping a
second copy) actually won its own day's plan. `applyRecentRepeatPenalties`
uses that history to set a new `planningScore` field
(`effectiveScore - recentRepeatPenalty`, decaying from 1.5 at a 1-day gap
to 0 at 4+ days) - `effectiveScore` itself is never mutated, only read.
`computeDayPlan` takes an optional `{ scoreField }` (`weightedIntervalSchedule`
an optional `getScore`) so the DP can be weighted by `planningScore`
without a second copy of the scheduling function.

`public/app.js` wires this in `renderSections` (which recomputes
`state.recommendationHistory` from a fresh, always-UNFILTERED-by-sport
`computeWindowPlan` pass before every render) and
`renderRecommendedSection` (which applies the penalty to the current,
possibly sport-filtered, day's candidates before calling `computeDayPlan`)
- kept as two separate passes specifically so "只看 MLB" still gets its own
MLB-only plan (existing, deliberate behavior), while the repeat penalty
itself still reflects what was actually recommended across every sport.

### 5. Score naming (`eventScore` / `viewerScore`)

`computeRecommendationScore` and `resolveViewingPlan`'s per-match output
now also carry `eventScore` (alias of `baseScore` - the AI's objective
judgment, untouched by any viewer preference) and `viewerScore` (alias of
`effectiveScore` - after priority/service/style). These are additive
aliases, not a rename: `score`/`effectiveScore`/`baseScore` are unchanged
so nothing in `public/app.js`'s existing rendering broke. `planningScore`
(viewerScore + the repeat penalty above) is the third tier the earlier
audit asked for, set separately by `applyRecentRepeatPenalties` since it
needs cross-day context a single match/day can't provide on its own.

### What Round 2 deferred, and why

The earlier audit's own "implementation order" put these later on
purpose, and they stayed deferred at the end of that round for the same
reasons - see "Round 3" immediately below for which of these have since
been done:

- **A structured evidence layer for online/public context** (Phase 4) -
  requires changing the shared proxy's (`jaypengx-collab/shared-proxy`)
  Gemini prompt/response schema, a different repo, and is a materially
  larger change than a scheduling fix. **Done - see Round 3.**
- **A full score-architecture rename** - surveyed properly in Round 3 (see
  its own section 5 below); the original "`public/app.js`'s rendering code
  reads `match.score`/`.effectiveScore` in many places" turned out to be
  wrong (app.js barely reads either field directly at all - the numbers
  drive the plan inside recommendation.mjs, the card itself only ever
  shows the AI's reason, see README's "Page layout"), but the REAL scope
  is bigger than that guess: `score`/`effectiveScore` are the wire format
  `scripts/build-data.mjs` writes to `matches.json` and every historical
  export already committed to disk, not just in-memory field names -
  **partially done, see Round 3 section 5 for exactly what changed and
  why a wire-format-breaking rename specifically did not.**
- **A planner "oracle" in the evaluator** (independently computing the
  mathematically optimal schedule from raw candidates and reporting
  actual/oracle as a ratio). **Done - see Round 3.**
- **Dimension-redundancy analysis** (competitiveness vs. watchability vs.
  endurance correlation). **Done - see Round 3.**
- **Contested-cluster refinement removal** - reviewed, not removed; see
  Round 3's own explanation of why it's still worth keeping.

## Round 3: structured evidence, planner oracle, dimension correlation

Implements the evidence layer and evaluator work Round 2 deferred, plus a
review of contested-cluster refinement's continued relevance now that the
scheduler no longer needs it for correctness.

### 1. Structured evidence (Phase 4)

The shared proxy's (`jaypengx-collab/shared-proxy`) `/match-recommend` used
to fold ONE free-text "note" from its grounded Google-Search pass straight
into the scoring prompt's `context` and then discard it - real, current
information, but never durable, never structured, never shown to a viewer.
`buildGroundedMatchInfoPrompt`/`fetchGroundedMatchInfo` now ask for and
return a small array of evidence items per fixture, each `{category,
finding, source, retrievedAt}` - `category` is one of `competitiveness` /
`mediaAttention` / `eventImportance` / `recentContext`, this report's own
section 19 vocabulary. `retrievedAt` is stamped server-side, at the moment
the grounded search pass actually resolved, never something the model
itself reports (see that repo's `sanitizeEvidence`). The plain-text digest
still gets folded into `context` for the scoring pass to read (unchanged
in effect), but `pick.evidence` is now ALSO returned to the caller
directly - Match Find's own `scripts/build-data.mjs` caches it
(re-validating it again independently, never trusting even this repo's own
proxy blindly - see `sanitizeCachedEvidenceItem`), surfaces
`match.evidence`/`match.evidenceRetrievedAt`, and `public/app.js` shows it
in a collapsed "評分依據" drill-down under the AI's one-sentence reason so
a viewer can verify/cross-check that sentence against the actual current
facts it was scored from, instead of just trusting it.

Evidence also gets its own, shorter refresh cadence
(`EVIDENCE_MAX_AGE_HOURS`, 24h) independent of the next unrelated
`PROMPT_VERSION` bump - the earlier audit's section 22 point that public/
media attention can change within hours in a way team quality never does.
`PROMPT_VERSION` bumped to 9 to backfill every already-cached match once.

Confidence (`computeConfidence`, source/refined-based - "how much should
the SCORE be trusted") and evidence freshness (`isEvidenceFresh`,
retrievedAt-based - "how CURRENT is the evidence behind it") are now two
explicitly separate signals, per section 20's "refined does not mean
current."

### 2. Planner oracle

`scripts/evaluate-recommendations.mjs`'s `computePlannerOracle`
independently re-derives each day's mathematically optimal weighted-
interval schedule from the same candidates an export already decided a
plan for, and reports an actual/oracle value ratio. Deliberately a
SEPARATE, from-scratch DP (`oracleWeightedSchedule`), not a re-import of
`computeDayPlan`/`weightedIntervalSchedule` - re-running the exact same
function against its own prior output would trivially report 100% even if
that function had a real bug, since it'd be the same bug on both sides of
the comparison. A pinned (`isPreferred`) pick is honored as the same hard
constraint `computeDayPlan` treats it as, so a deliberate user override
never reads as "the scheduler failed to find the optimum."

Verified against three hand-built cases before trusting it: a genuinely
optimal plan (ratio == 100%), a deliberately broken "pick the numerically
higher single match instead of the better sequence" plan (ratio correctly
drops to 55.6%), and a pinned pick that isn't the numerically best
candidate (still 100%, since the pin is a constraint, not a flaw).

### 3. Score-dimension correlation

`computeDimensionCorrelations` computes Pearson's r between
competitiveness/watchability/enduranceScore/broadcastQuality, **per
sport** (section 24's own instruction - a correlation that holds for MLB
says nothing about F1), flagging `|r| >= 0.8` as a possible redundant
dimension worth consolidating. Informational only - this pass doesn't
remove or merge any dimension itself; that's a real product decision
(does watchability still earn its keep as a separate axis from
competitiveness for a given sport?) that deserves a human looking at real
accumulated data, not an automatic action taken the first time a
correlation crosses a threshold.

### 4. Contested-cluster refinement: reviewed, kept (re-scoped)

The audit asked whether `scripts/build-data.mjs`'s contested-cluster
refinement (`refineContestedClusters`, the shared proxy's Pro-tier
`/match-recommend-refine`) was "solving a problem that should partly be
solved by the planner itself" (section 25) now that the planner no longer
needs a single pre-chosen winner per conflict cluster. The answer: its
ROLE changed, but it's still worth having. Before the scheduler rewrite
(Round 2), a cluster's base-pass ranking was load-bearing - the client
collapsed each cluster to its single highest-scoring member BEFORE
scheduling, so a wrong ranking there silently discarded a better plan with
no way to recover. That's no longer true: `computeDayPlan` hands the DP
every individual candidate now, so it finds the actual best-value sequence
regardless of which cluster member the base pass happened to rank
marginally higher. Refinement is therefore no longer correctness-critical
- but comparing two genuinely close fixtures head-to-head (does a 7 vs. a
7 actually mean a coin flip, or would closer reasoning break the tie) is
still a real accuracy improvement over two independent, unrelated
judgments, which is what refinement was always actually FOR underneath the
"prevents a silently-worse plan" framing. `CONTESTED_SCORE_DELTA`/
`CONTESTED_MIN_SCORE`/`MAX_REFINE_CLUSTERS_PER_RUN`/
`REFINE_CLUSTER_MAX_ITEMS` are unchanged - they were already conservative,
and there's no specific evidence any of them is mistuned, so retuning
without a real reason would just be a guess dressed up as a fix. Only the
code comment explaining WHY this pass exists was rewritten, so a future
reader doesn't reason about it against an architecture that no longer
exists.

### 5. Score-architecture rename: surveyed, done where it's safe

Round 2 already added `eventScore`/`viewerScore` as additive aliases
(`computeRecommendationScore`/`resolveViewingPlan` in
`public/lib/recommendation.mjs`) and deferred a "full rename" as
out-of-scope, guessing the remaining work was mostly `public/app.js` call
sites. That guess was checked properly this round, and was wrong on both
ends:

- **Smaller than expected in `public/app.js`**: a full grep found exactly
  ONE live read of either field in that whole file
  (`buildMatchStack`'s own member-ordering sort) - not "many places". The
  README's own "Page layout" section explains why: this site deliberately
  never shows a competitiveness/watchability number on a card at all, only
  the AI's one-sentence reason, so app.js mostly just passes match objects
  through to render, it doesn't itself compute with their scores. That one
  call site now reads `viewerScore`.
- **Bigger than expected everywhere else**: `score` isn't just an
  in-memory field name, it's the WIRE FORMAT - `scripts/build-data.mjs`
  computes and writes it straight into `public/data/matches.json`
  (`match.score = Math.round(...)`), which every historical export
  (`match-find-export-*.json` downloads, this repo's own committed
  `matches.json`) already carries under that literal key. A genuine "full
  rename, remove the old name" would mean changing what `build-data.mjs`
  actually writes (a breaking change to a data format real files on disk
  already use), updating every read of it across `build-data.mjs` itself
  (the contested-cluster sort/filter logic), `recommendation.mjs`
  (`recommendStyleScore`/`computeEffectiveScore`), and
  `evaluate-recommendations.mjs`, AND every one of this repo's ~110 tests
  that construct a match fixture with `score`/`effectiveScore` as a
  literal property name (most of them) or assert against those names
  directly.

Given the actual scope - a breaking wire-format change plus a large,
purely mechanical edit across the test suite - for **zero behavior
change** (every alias is already the exact same number as the field it
aliases) and a clarity goal the additive aliases already satisfy, this
round made the one real, safe app.js improvement (using `viewerScore` in
the one place that reads it) and `computeDayPlan`'s own `scoreField`
option now DEFAULTS to `'viewerScore'` instead of `'effectiveScore'`
(falling back to `effectiveScore` when a match has no `viewerScore` at
all, e.g. a hand-built test fixture or an older cached object - see that
function's own comment) - so the scheduler's own default behavior is
described in the audit's own terms without breaking anything that reads
the older name. The wire-format rename itself stays not done: the
audit's own ask was for explicit names to exist and be usable, which they
already are; actually deleting `score`/`effectiveScore` from the data
format would cost real risk (a live production JSON schema change) for no
additional clarity beyond what `eventScore`/`viewerScore` already provide
today.

## Round 4: closing the gaps Round 3 missed

A direct question ("is recommendation-engine-audit.md all done?") prompted
a re-check against the FULL original report rather than just this
document's own "Deferred"/"Known limitations" lists - which turned up
three real, unimplemented items neither Round 2 nor Round 3 had actually
flagged as open. This round closes all three.

### 1. Sport-level variety (§15)

The cross-day repeat penalty (Round 2) only ever tracked ONE level of
variety - the same two teams. Section 15 explicitly asks for more:
"Avoid accidentally producing: MLB MLB MLB MLB MLB when equally
compelling alternatives exist" (sport variety) and "If the entire viewing
plan repeatedly revolves around one league despite strong alternatives,
the planner should expose that concentration" (team/league concentration).

`public/lib/recommendation.mjs` now has `computeSportConcentration(picks)`
(a plain `Map<sport, share>`) and a second soft penalty
(`SPORT_CONCENTRATION_THRESHOLD` = 0.75 over a
`SPORT_CONCENTRATION_LOOKBACK_DAYS` = 3-day rolling window) - same
design as the matchup penalty: small, decaying-by-construction (it only
ever looks at the last 3 days), and never strong enough to override a
sport that's genuinely and repeatedly the best choice, only to nudge a
close call. `computeWindowPlan` now also returns `sportConcentration`
(the WHOLE window's own final sport split, not just the short lookback
used for the penalty) as the literal "expose that concentration"
diagnostic the audit asked for - `public/app.js`'s Settings "匯出資料"
export now includes it.

`applyRecentRepeatPenalties` gained a `recentPicks` parameter (defaults
to `[]`, so every existing 3-argument call site - and every existing
test - keeps working with zero sport penalty applied, same as before).

### 2. "Why not" explanations (§27)

Nothing in this codebase could previously answer "why wasn't THIS
candidate recommended" except by a developer manually tracing through
`computeDayPlan`. `explainWhyNotRecommended(candidateId, dayKey,
dayMatches, pinnedForDay)` answers it for real, not by guessing from
static rules: it clones the input (never touches the caller's own match
objects/flags), re-runs the actual plan as it happened, then re-runs it a
SECOND time with this one candidate forced in via the exact same pinning
mechanism a real viewer swipe uses, and compares the two plans' total
value. That distinguishes three genuinely different answers:

- `blockedByPin` - forcing the candidate in would have raised the plan's
  value, so a DIFFERENT pinned choice (not a scoring judgment) is what's
  actually excluding it.
- `lostToBetterSequence` - it conflicts with match(es) that formed a
  higher- or equal-value plan without it; names exactly which ones.
- `lowValue` - the rare case where it doesn't conflict with anything
  chosen at all, but its own score genuinely wasn't worth including.

Deliberately NOT wired into every card on every render (the report's own
framing is a developer-debugging tool - "prevents the developer from
having to inspect five functions to understand one decision" - not a
live UI feature) - it's exported and tested, ready for a future
"why not?" button without forcing every non-recommended card to pay for
a scheduling re-run nobody asked for.

### 3. Evidence-grounded reason (§23)

Round 3's evidence layer stored and displayed structured evidence
alongside the AI's one-sentence `reason`, but never actually told the
model writing that sentence to USE it - a fixture with real, current
evidence behind its score could still get a generic "雙方戰績接近" (the
two teams are evenly matched) that said nothing case-specific. The
shared proxy's (`jaypengx-collab/shared-proxy`) `buildMatchRecommendPrompt`/
`buildMatchRefinePrompt` now explicitly instruct grounding `reason` in
the `[Recent: ...]`/`[Odds: ...]` clause when one is present, falling
back to general knowledge exactly as before when neither exists - a
small, low-risk prompt-only change (no schema/response shape change,
unlike Round 3's evidence-array change). This satisfies the original
audit's own framing directly: "The exact prose can remain AI-generated,
but its claims should be derived from structured evidence" (§23) - not a
template-assembled sentence, a model explicitly told to cite what it was
actually given.

### Status after Round 4

Every item from the original 43-section report is now either implemented
or explicitly deferred with reasoning recorded in this document (see
"Known limitations" and "What Round 2 deferred, and why" above) - nothing
should remain silently unaddressed. The genuinely open items are the ones
already named as such: a fuller per-feature freshness-decay confidence
model, real sport-specific scoring adapters, a behavioral feedback loop
(needs instrumentation this static site doesn't have), and the
wire-format score rename - each with its own stated reason for staying
that way, not an oversight.

## Round 5 - architecture cleanup from a fresh list of reported problems

A new batch of reported problems (MLS still present, cross-device sync,
a confusing dual recommendation-style toggle, background polling causing
card-state bugs, a lifecycle mislabel, unrealistic baseball overlaps, a
Recommend/Prefer swipe mix-up, and near-identical Sep 23-25 recommendations)
turned out to share a small number of real architectural causes, not ten
unrelated bugs - consistent with this document's own recurring finding
that most reported "bugs" trace back to a handful of representation
mismatches rather than needing one-off patches each.

### 1. Investigation first: Sep 23-25 was checked against real data, and mostly ISN'T a bug

Live ESPN/Gemini network access wasn't available to investigate this
directly, so this used the repo's own real, already-committed
`data/ai-cache.json` (genuine Gemini-scored fixtures for 2026-09-19
through 2026-10-03 - the exact window containing Sep 23-25) reconstructed
through the actual `resolveViewingPlan`/`computeWindowPlan` pipeline.
Finding: the candidate pool for those three days is genuinely,
overwhelmingly MLB (13-16 MLB fixtures per day vs. at most one MLS game
scoring well below MLB's top picks, and zero Premier League fixtures that
week at all) - not a variety-filter failure. `computeSportConcentration`'s
soft penalty (§15) was confirmed firing correctly (`sportConcentrationPenalty`
= 1 once MLB's recent share crossed the 75% threshold) but is deliberately
soft, exactly as designed: it can't and shouldn't override a night where
MLB is legitimately the only real option. Recommending several MLB games
back-to-back most nights, including a marquee ~8.5-scored game at the same
nightly slot several nights running, is consistent with a real MLB pennant-
race week with no meaningful cross-sport competition, not a broken plan.
(This offline reconstruction couldn't validate the matchup-level repeat
penalty specifically, since it lacked real team names to build a
`matchupKey` from - see "Known limitations" below.) The genuine bugs found
during this same investigation are the ones actually fixed below.

### 2. MLS removed entirely

Every MLS reference - `TEAM_LEAGUES`'s `mls` entry (`scripts/build-data.mjs`),
`team-names.mjs`'s MLS name table, `SPORT_LABELS_ZH`/`LEAGUE_LOGOS`/
`SPORT_ICONS` (`public/app.js`), the `SPORT_TIMING` entry
(`recommendation.mjs`), the `--sport-mls` CSS variable/badge rule, cached
`mls-*` entries in `data/ai-cache.json`, and the one-word mention in the
shared proxy's `buildMatchRecommendPrompt` - is gone. No replacement
concept: the site now covers Premier League, MLB, NBA, and F1 only.

### 3. Cross-device sync removed entirely - local-only

`public/app.js` no longer has ANY network call besides fetching its own
`matches.json` - the entire `/match-find-sync` client (syncPull/syncPush/
syncCreate/syncConnect/syncDisconnect, the sync Settings UI, the one-time
pairing prompt banner) is gone, along with `MATCH_FIND_SYNC_APP` and its
route registration in the shared proxy's `worker.js` (the *generic*
`handleSyncRequest`/Firestore/JWT machinery stayed untouched - it's shared
with Orbit's `/sync` and Orbit Vocab's `/vocab-sync`, neither of which this
change touches). Every per-viewer preference (sport priority, enabled
sports, and the swiped-to "Prefer" pick) is `localStorage`-only now, same
as it always claimed to be for a viewer who never paired a sync code -
that's simply the only mode left.

### 4. One unified recommendation system - "Best Matches"

The `entertainment`/`competitive` `recommendStyle` toggle (§ "Recommendation
style setting" in the old `public/app.js`) is gone, along with its Settings
UI. `recommendStyleScore` is now `bestMatchScore` (`recommendation.mjs`) -
one fixed blend (watchability nudged by `broadcastQuality`, exactly what
`entertainment` already was) with no style parameter left to pass. The
viewer's own taste still has exactly one place to override the algorithm:
swiping a card stack to Prefer a specific alternative (unchanged mechanism,
see #6 below) - a per-match choice, not a blanket ranking toggle.

### 5. Polling replaced with three real triggers: load, match start, match end

The old client ran THREE independent timers at once: a 60s `setInterval`
that fully tore down and rebuilt `#recommended-list`'s DOM purely to
refresh relative-time text, a 5-minute `setInterval` re-fetching
`matches.json`, and a 30s `setInterval` polling the (now-removed) sync
endpoint. All three are gone. `scheduleNextUpdate` (`public/app.js`) now
sets exactly ONE `setTimeout`, targeting the single soonest instant, across
every currently-loaded match, that its lifecycle actually changes - it
starts, or its estimated broadcast ends (see #7) - computed by
`nextRelevantTransitionMs`. Firing it re-fetches `matches.json` (reacting
to whatever ESPN/the build has changed by then) AND re-renders even when
the data itself hasn't changed, since the transition is a pure wall-clock
event independent of the server (a match starting doesn't need new JSON to
be true). This is very likely the single largest shared cause behind the
reported card-state bugs (#6): a full DOM rebuild racing against an
in-progress swipe gesture every 60 seconds, forever, is exactly the kind of
thing that produces "swiping forward jumps backward," stale scroll
positions, and cards that look duplicated mid-gesture. Removing the blind
timer removes the race entirely; the existing swipe-interaction cooldown
(`isStackBeingInteractedWith`) still guards the three real triggers the
same way. Trade-off, accepted deliberately per this round's own brief ("no
polling, no intervals"): the on-screen relative countdown text no longer
ticks smoothly between renders - it's accurate as of the last render/
transition, not updated every minute. `tests/preferences.test.mjs` and the
`matchLifecycleState` tests below don't cover this DOM-timing behavior
directly (there's no DOM test harness in this repo - see "Known
limitations"), but the removal of `setInterval` from `public/app.js`
entirely is directly inspectable in the source.

### 6. Recommend/Prefer swipe semantics fixed - and preference logic extracted

Root cause of "swiping back changes Recommend into Prefer": `pinSlotChoice`
recorded a pin for WHATEVER the viewer swiped to, with no way to tell
"a genuine alternative" apart from "the algorithm's own default, just
touched." Once any pin existed for a slot, every render tagged that
member `isPreferred` (偏好) - including the algorithm's own original top
pick, the moment a viewer swiped away and back. Fix: `naturalSlotChoice`
(`recommendation.mjs`) computes what `computeDayPlan` would pick for a
slot with THAT slot's own pin set aside (every other pin still respected),
and `applySlotSwipe` (new `public/lib/preferences.mjs`) clears the pin
instead of setting one when the swiped-to match equals that natural
default - reverting the card to 推薦 instead of leaving it stuck at 偏好.
This is also where the pin serialization/pruning logic that used to live
inline in `public/app.js` moved to, pulled out as its own pure, DOM-free
module (`serializePinnedChoices`/`deserializePinnedChoices`/
`pruneStalePinnedChoices`/`applySlotSwipe`) - per this round's own explicit
architecture goal of keeping "match data -> recommendation -> user
preference -> UI/card state" as four genuinely separate layers instead of
letting DOM code and preference logic interleave. `tests/preferences.test.mjs`
covers the exact two round-trip scenarios asked for (Prefer -> save ->
reload -> still Prefer; un-Prefer -> save -> reload -> still un-Preferred),
plus the swipe-semantics fix itself and every pruning/serialization edge
case, all as pure functions with no DOM/localStorage involved.

### 7. Lifecycle states corrected, and baseball's real overrun risk fixed

Two related bugs, one shared root cause: this pipeline had no single,
named notion of a match's lifecycle - `relativeLabel`/the `is-live` CSS
class/`pinCurrentOrNext`/`pickInitialDay` each re-derived "is this live/
about to start/over" ad hoc, against the plain NOMINAL end time
(`start + durationMinutes`), with no upper bound once a match had already
started.

- **The STARTING_SOON bug**: `relativeLabel`'s old logic returned "即將
  開始" (starting soon) for ANY case where `now >= start` - which, since
  the live window (`now < nominalEnd`) was handled by an earlier branch,
  was ONLY EVER reachable once `now` was already past the nominal end. A
  match that simply ran long, with ESPN not yet reporting it finished, was
  therefore mislabeled "about to start" instead of "still live" - the
  literal bug reported ("a match whose expected time has passed
  incorrectly appears about to start"). Fixed by `matchLifecycleState`
  (`recommendation.mjs`), a single UPCOMING -> STARTING_SOON -> LIVE ->
  ENDING_SOON -> ENDED state machine every caller now reads instead of
  re-deriving its own version: `isFinished` (ESPN's own status) is the
  ONLY thing that ever produces ENDED, never elapsed time, so a match
  already underway can never fall back to STARTING_SOON/UPCOMING again.
- **The baseball overrun bug**: `DURATION_UNCERTAINTY_BY_RELIABILITY`
  (Round 2, §9) shrank a low-reliability sport's reserved scheduling block
  by a flat discount (30% for MLB), reasoning that "we're not sure how
  long this runs, so don't over-block." That was backwards for a no-clock
  sport: MLB is statistically more likely to run LONG than short (extra
  innings, rain delays - a standard 9-inning game already averages
  roughly 2h40m of playing time alone per MLB's own officially published
  time-of-game figures, with real, meaningful tail risk of 30-60+ extra
  real minutes and no matching mechanism that ever finishes a game
  meaningfully early). The discount meant the scheduler would offer a next
  pick only ~2h13m into a genuinely great, full-endurance MLB game (133min
  = 190min endurance-adjusted figure minus 30%) - the exact reported "40-80
  minute unrealistic overlap," and worse for the games most likely to
  genuinely go long (close, high-endurance ones). Fixed by replacing the
  discount with `DURATION_OVERRUN_BUFFER_BY_RELIABILITY`, an overrun PAD
  applied on top of the endurance-adjusted figure (`schedulingDurationMinutes`
  can now only ever equal or exceed `effectiveDurationMinutes`, never fall
  below it) - MLB now reserves ~4 hours for a genuine toss-up instead of
  ~2h13m. The endurance-based early-release for a genuine blowout is
  unchanged and unaffected - that's a different, legitimate axis (is this
  still worth watching) from the one that was actually broken (how long
  does the broadcast realistically run). `estimatedDurationMinutes` (nominal
  length + the same overrun pad, without the endurance blend) is the
  separate, honest "how long is this probably still on the air" figure
  `matchLifecycleState` uses for LIVE/ENDING_SOON/ENDED display - explicitly
  never a guaranteed end time, exactly per this round's own framing.
  `tests/recommendation.test.mjs` covers both fixes directly: a full
  UPCOMING/STARTING_SOON/LIVE/ENDING_SOON/ENDED matrix for
  `matchLifecycleState` (including the exact "past the estimated end but
  not `isFinished`: stays LIVE, never STARTING_SOON" regression case), and
  a before/after pair of `schedulingInterval` assertions proving the same
  gap that used to be schedulable after an MLB game (`Test 5`) no longer is.

### 8. Gemini asked to compare, not just judge each fixture alone

The shared proxy's `buildMatchRecommendPrompt` already received a whole
day's (or more) fixture batch in one call, but its instructions said "For
EACH fixture ... return" with no comparison framing at all - genuine
side-by-side comparison only ever happened in the much smaller, rarer
`/match-recommend-refine` follow-up (a handful of contested clusters a
day, at most `MAX_REFINE_CLUSTERS_PER_RUN`). The base prompt now
explicitly instructs grouping fixtures by day and near-in-time overlap
before scoring, and scoring with that comparison in mind - a clearly
bigger story should score clearly higher than a comparatively routine
same-day alternative, not get flattened toward it the way scoring each
fixture in isolation tends to produce. `PROMPT_VERSION` bumped to 10 in
`scripts/build-data.mjs` so every cached score gets re-evaluated under the
improved prompt. Gemini's judgment is unchanged in its actual ROLE here -
still one signal feeding `computeDayPlan`'s deterministic scheduler, never
the sole decision-maker; the refine follow-up stays in place too, as
defense in depth for the rare case the base pass's new comparison still
leaves two overlapping fixtures suspiciously close.

### Known limitations after Round 5

- The Sep 23-25 investigation (#1) used the repo's own real, committed AI
  score cache rather than a live fetch (outbound network access to ESPN/the
  deployed site was not available in the environment this round's work was
  done in) - real team names/venues weren't reconstructable from the cache
  alone, so the cross-day matchup-repeat penalty specifically (§14,
  `matchupKey`) could not be independently verified against real Sep 23-25
  data this round, only re-confirmed correct by code inspection (unchanged
  from Round 2).
- There's no DOM/browser test harness in this repo (Node's built-in test
  runner, used for everything under `tests/`, has no DOM) - the polling-
  removal fix (#5) and the swipe/card-stack behavior it targets are
  verified by source inspection and the pure-function tests around
  `naturalSlotChoice`/`applySlotSwipe`, not by a simulated browser
  interaction test. A real device/browser check remains the way to confirm
  the on-screen swipe behavior end-to-end.
- The Gemini prompt change (#8) is a live production prompt with no test
  harness on the shared-proxy side (confirmed zero tests in that repo) -
  its effect can only be observed in real scored output after the next
  build, not asserted in CI.
