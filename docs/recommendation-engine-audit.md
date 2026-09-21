# Recommendation engine audit — response and changes

**This is a historical, point-in-time record, not current documentation.**
Several things it describes as "already enforced"/"unchanged" have since
changed deliberately - most notably, a finished match is no longer excluded
from `computeDayPlan`'s candidates (§20/P0 #2 below): the recommendation
model moved to running one whole calendar day as a single unit, so a
finished fixture stays in its own rightful slot in 推薦賽事 rather than
being dropped the moment it ends (see README's "The viewing plan" and
`recommendation.mjs`'s own comment on `computeDayPlan`'s candidate filter
for the current, correct behavior). The "匯出資料" Settings button this
document's own dataset came from is also gone (see README's "No developer
tools in the UI"). Left as-is below rather than rewritten, since this
document's value is as a record of what the audit claimed and how it was
evaluated at the time - always trust the current source/README over this
file for present-day behavior.

This documents what changed in response to a recommendation-engine audit
report (dataset: a `match-find-export-*.json` produced by this repo's own,
since-removed "匯出資料" Settings button), and — just as importantly —
which of the audit's claims don't actually apply to this codebase, and why.

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

## Round 6 - API-data-driven scoring engine (Gemini demoted to validation)

A direct request to make the recommendation engine more accurate by using
real sports-data APIs more heavily, and to rewrite scoring so it's
API-data-based first with AI validation/refinement second, rather than the
other way around. This is the largest single architectural change this
document has recorded: competitiveness/watchability/enduranceScore/
broadcastQuality used to be asked from Gemini directly (grounded in
context strings/odds, but ultimately Gemini's own training-data judgment
call); they're now computed FIRST, deterministically, and Gemini only
validates the result.

### 1. The objective scoring engine

Two new modules in Match Find:

- `scripts/objective-score.mjs` - pure, fully unit-tested (no network)
  per-sport formulas: `computeMlbObjectiveScore`/`computeNbaObjectiveScore`/
  `computeEplObjectiveScore`/`computeF1ObjectiveScore`, plus shared building
  blocks (`weightedAverage`, `closenessFromWinPctGap`,
  `closenessFromSpread`, `playoffProximityScore`, `streakMomentum`,
  `estimateBroadcastQualityBaseline`). Each returns
  `{competitiveness, watchability, enduranceScore, factors}` -
  `factors` is a plain-English list of the actual real data points that
  produced the numbers (e.g. `"last 10: 7-3 vs 5-5"`, `"postseason game"`),
  carried all the way through to the shared proxy's own validation prompt
  and to a local Traditional Chinese reason
  (`buildObjectiveReasonZh`/`describeFactorsZh` in `build-data.mjs`) for
  when no AI validation has happened yet.
- `scripts/sport-signals.mjs` - fetches the real, current API signals those
  formulas consume: MLB standings/recent-form/streak from the official
  [MLB Stats API](https://statsapi.mlb.com) (free, no key), and F1
  championship-standings gap from the
  [Ergast-compatible Jolpica API](https://api.jolpi.ca) (free, no key,
  the community-run successor to Ergast, which shut down at the end of the
  2024 season). Both are dedicated sports-data APIs, not ESPN - directly
  answering the "explore opportunities to use sport APIs more" half of the
  request that started this round. Every fetch is deliberately as
  defensive as this codebase's own ESPN calls (try/catch, a hard timeout) -
  see point 4 below for why that defensiveness specifically matters here.

`scripts/build-data.mjs`'s `computeMatchObjectiveScore` dispatches each
fixture to its own sport's formula, called once for every non-finished
fixture on every build, whether or not the shared proxy is even
configured - this is the PRIMARY score now, not a fallback.

### 2. Gemini's role: validation and refinement, not scoring

The shared proxy's (`jaypengx-collab/shared-proxy`) `/match-recommend` and
`/match-recommend-refine` used to score each fixture from scratch. They now
receive each fixture's own already-computed `objective` score and its
`factors`, and are asked ONLY for a small, bounded adjustment
(`competitivenessAdjustment`/`watchabilityAdjustment`/
`broadcastQualityAdjustment`/`enduranceScoreAdjustment`, each -2 to +2) -
added to, never replacing, the objective score. The prompt (see that
repo's `buildMatchRecommendPrompt`) explicitly tells Gemini that returning
all zeros is the expected, common answer, and that a non-zero adjustment
needs a SPECIFIC real-world reason the formula's own factors don't already
cover (a fresh injury, a rivalry's real history, current form) - not a
vaguer "I'd have scored this slightly differently" impression. Both routes
clamp every adjustment server-side (`MATCH_RECOMMEND_ADJUSTMENT_BOUND`,
`sanitizeAdjustment`) regardless of what Gemini's own schema-constrained
output claims, and Match Find's own `build-data.mjs` (`AI_ADJUSTMENT_BOUND`,
`clampAdjustment`) clamps again independently - the same "never fully trust
upstream" defense-in-depth this codebase already applied to absolute
scores, now applied to adjustments.

The evidence-gathering grounded search pass (`fetchGroundedMatchInfo`,
Round 3's own structured evidence work) is unchanged in role - it still
feeds current, searched facts into the validation prompt's context and is
still returned to the caller as structured `evidence` - this round only
changed how the SCORE itself is produced, not the evidence layer feeding
it.

### 3. Cache schema: adjustments, not absolute scores

`data/ai-cache.json` used to store an absolute competitiveness/watchability/
enduranceScore/broadcastQuality per match. Since the objective score is
now recomputed fresh every single build (standings/form genuinely change
day to day - caching yesterday's objective number would silently go
stale), the cache only stores the ADJUSTMENT plus `reason`/`venueZh`/
`evidence`. `PROMPT_VERSION` bumped to 11, which - per this document's own
established convention - discards every existing cache entry's old
absolute-score shape and re-validates the whole window once under the new
schema on the next real build. A defensive `?? 0` guard was added on both
read paths (`build-data.mjs`'s main assembly loop and its post-refine
loop) specifically for the transition window: an older cache entry that
hasn't been re-validated yet (a throttled run right after this deploys)
has no `*Adjustment` fields at all, and reading `undefined` into an
arithmetic expression would otherwise silently produce `NaN` instead of
gracefully defaulting to a zero adjustment.

### 4. `source`/`confidence`: a new middle tier, `heuristicScore` retired

`heuristicScore` (the old win-rate-only, capped-at-8, no-real-sports-
knowledge fallback for when the proxy was unreachable) is gone entirely -
superseded by the objective score's own graceful handling of a missing
signal (a neutral 5, still real per-sport modeling around it, not a crude
guess). `source` on a match is now `'finished'` / `'api-objective'`
(objective score, zero adjustment - PROXY_URL unset, the call failed, or
still pending) / `'ai'` (validated, optionally `refined`).
`CONFIDENCE_BY_SOURCE` (`public/lib/recommendation.mjs`) gained an
`apiObjective: 0.55` tier between the old `heuristic: 0.35` (kept only so
an OLDER cached/exported match still maps to a sensible value - no build
produces it anymore) and `ai` (bumped slightly, 0.7 → 0.75, since even a
base validation pass now sits on top of real API data, not just Gemini's
own training knowledge). The UI's own caveat (`public/styles.css`'s
`.is-heuristic` → `.is-api-objective`) changed from "（估計，非 AI 推薦）"
("estimated, not an AI recommendation" - dismissive of what was, honestly,
a weak fallback) to "（API 數據估計，尚未經 AI 驗證）" ("API data estimate,
not yet AI-validated" - accurate to what's actually true now: real,
current data, just missing one extra layer of judgment).

### 5. Known limitations (stated in the README, not just here)

- **No live verification of either new external API.** The development
  session this was built in had no outbound network access to the MLB
  Stats API, the Jolpica F1 API, OR ESPN's own API (a sandboxed
  environment's own egress policy, not a statement about these APIs'
  actual public availability) - every response shape assumed in
  `scripts/sport-signals.mjs` comes from these APIs' own long-stable,
  widely-documented public formats, not a confirmed live response. Both
  fetch functions degrade to "no signal for this fixture" on any shape
  mismatch rather than breaking the build, but the real live test is the
  first scheduled run after this ships.
- **NBA and Premier League have no dedicated standings-API integration.**
  Both still score on season record + odds + the existing rivalry/derby/
  national-broadcast detectors - real, but shallower than MLB's standings-
  proximity/recent-form depth. The natural next round.
- **No injury data anywhere** - left, deliberately, as exactly the kind of
  thing Gemini's validation pass exists to catch, not something a
  deterministic formula should try to approximate from data this build
  doesn't have.
- **F1's per-race modifiers (safety car, weather) aren't modeled** - ADDING
  a weather API would mean taking on a new external dependency for a
  modifier this build can't verify pre-race anyway; deliberately deferred
  as a separate decision rather than folded in silently.

## Round 7 - swipeable card-stack fixes, removing the per-match AI cache

Two independent reported problems: the swipeable match-stack cards
(`buildMatchStack` in `public/app.js`, see Round 5's "1" for why it's a
scroll-snap stack rather than custom drag handling) sometimes landed on
the wrong card after a swipe, and the shared proxy's AI validation was
being masked by a per-match cache that had to be manually cleared to
actually see fresh results.

### 1. Card-stack swipe fixes

Three concrete bugs, all in `public/app.js`/`public/styles.css`, none in
the recommendation math itself:

- **A fast flick could skip past the intended card.** Native scroll-snap
  without `scroll-snap-stop: always` lets momentum carry a fast swipe past
  the very next snap point straight to one two or three cards away -
  exactly the reported "swiping forward brings me one or even two cards
  before [further than intended]." Added to `.match-stack-scroller >
  .match-card` in `public/styles.css`, forcing the browser to stop at
  every card in sequence regardless of swipe speed.
- **No boundary containment.** Swiping past the first or last card in a
  stack had nowhere configured to absorb the gesture, so it could chain
  into whatever scrolled next - a sibling stack elsewhere on the page, or
  the page's own vertical scroll - which is what the report described as
  landing on "some random card." Added `overscroll-behavior-x: contain` to
  `.match-stack-scroller`.
- **The settle handler could read `scrollLeft` before scroll-snap had
  actually finished settling.** The previous code used a flat 180ms
  debounce after the last `scroll` event to decide which card the gesture
  landed on, computed as `Math.round(scrollLeft / clientWidth)` with no
  clamping - a momentum/rubber-band bounce at either end could briefly
  push `scrollLeft` negative or past the last card's offset, and reading
  it 180ms after the last tick is a guess, not a guarantee the browser was
  actually done settling. `buildMatchStack` now uses the native
  `scrollend` event (Chrome/Firefox/Edge, Safari 18.2+) when available,
  which fires exactly once scrolling - including any snap/bounce
  correction - has genuinely finished, falling back to the old debounce
  only where `scrollend` isn't supported; the index read is now clamped to
  `[0, ordered.length - 1]` either way.

### 2. Removing the per-match AI cache

A direct request to stop caching AI validation results per match and
instead run the full objective-score + Gemini-validation pipeline against
**every** currently non-finished fixture on every unthrottled build, so a
push to `main` actually exercises the whole live pipeline rather than
mostly replaying whatever `data/ai-cache.json` already had recorded from
an earlier run.

`data/ai-cache.json` is gone entirely - deleted from the repo, and
`scripts/build-data.mjs` no longer reads or writes a persistent per-match
record at all. `loadCache`/`pruneCache`/`isEvidenceStale`/`PROMPT_VERSION`
are gone with it: there's nothing to prune, nothing to go stale relative
to a previous run, and no schema version to compare against, since nothing
survives between runs to compare. In their place, `main()` builds a plain
in-memory `Map` (`adjustments`) fresh every run, populated only for
fixtures the shared proxy actually returned a pick for THIS run;
`refineContestedClusters` mutates that same map instead of a persisted
cache object. `needsScoring` is now simply "every non-finished fixture,"
not "every fixture not already validated."

`data/ai-meta.json` (just the one `lastAiFetchAt` timestamp) is kept - it
is not a cache of match data, only a rate-limit control, and
`AI_FETCH_MIN_INTERVAL_HOURS` still throttles routine *scheduled* reruns
so a 15-minute cron doesn't call Gemini for the whole window every time.
A `push` or manual `workflow_dispatch` run - including the push that
shipped this change - always bypasses that throttle, which is what makes
"push to main" the actual live test of this round's change: the very next
build sends every current fixture to Gemini fresh rather than short-
circuiting on cached answers. `.github/workflows/deploy.yml`'s "Commit
updated AI score cache" step was renamed "Commit AI fetch timestamp" and
now only tracks `data/ai-meta.json`.

The tradeoff, stated plainly: an unthrottled run (a push, a manual
dispatch, or the first eligible scheduled run after 8 hours) now makes one
Gemini call per batch of up to 80 fixtures for the ENTIRE window every
time, rather than only for newly-appeared ones - meaningfully more Gemini
quota use per unthrottled run than before. `AI_FETCH_MIN_INTERVAL_HOURS`
is what keeps this bounded to a few times a day rather than every 15
minutes; if quota pressure shows up in practice, the next round's fix
would be to raise that interval or reintroduce a lighter-weight cache, not
to silently reduce which fixtures get validated.

## Round 8 - the actual root cause of "swipe stack is stuck and buggy," found live

A direct report ("the stack UI is stuck and buggy, the recommendation
system is broken, redo it") prompted checking the DEPLOYED site directly -
`node --test` was already green (279 assertions) and the live
`/match-recommend` proxy was confirmed responding correctly with a real
request, so neither "the tests are lying" nor "Gemini is down" explained
the report. What did: driving the live site with a real headless browser
(Chrome DevTools Protocol's `Input.dispatchTouchEvent`, same verification
method Round 5's swipe work already used) and swiping an actual multi-game
MLB stack found a genuine, reproducible bug that no unit test could have
caught, because it isn't a pure-function bug at all.

**The bug**: `computeDayPlan`'s `alternativeIds` (recommendation.mjs) is
computed per PICK - every OTHER cluster member that directly
(pairwise) overlaps whichever match is actually recommended for that slot.
That's correct and well-tested for the unpinned/natural case. But a real
MLB night's transitive conflict cluster can chain together 8-10+ games
(see this document's own Round 2/6 comments on that exact shape), and two
different members of the SAME cluster can have very different direct-
overlap neighborhoods depending on where in the chain they sit - a game
near the middle of a staggered slate directly overlaps more neighbors than
one near either end. Since a swipe pins a NEW member and reruns
`computeDayPlan`, `alternativeIds` gets recomputed from THAT new member's
own (possibly much wider) neighborhood, not the one the viewer was
actually looking at. Live-reproduced on the deployed site: swiping once,
from the default pick to its very next card, took a 5-member stack (5
dots) to an 8-member stack (8 dots) with three brand-new match cards the
viewer had never seen appear mid-swipe - exactly the "stuck and buggy"
feeling reported, and exactly the failure mode Round 2's and Round 6's own
commit messages ("swipe-stack chaos," "swipe stack fracturing when pinning
a non-adjacent chain member") were chasing, still present because both of
those rounds fixed `alternativeIds`' CONTENT (direct vs. transitive
conflicts) without fixing its STABILITY across a re-render of the same
slot.

**The fix**: `public/app.js`'s `renderRecommendedSection` now freezes each
day+slot's presentational stack membership the first time it renders
(`state.stackMembershipByDay`, `Map<dayKey, Map<slotKey, Set<matchId>>>`,
keyed by the same full-cluster `slotKey` a pin is already looked up
under). Every later render for that slot - a pin, a live score poll - looks
up and reuses that same frozen member set instead of recomputing it from
whichever match is now primary; only WHICH member is marked primary/pinned
changes, never WHICH members are in the stack. A member that becomes
independently `.recommended` elsewhere is still excluded from the frozen
set on read (the same "never both recommended and someone else's
alternative" invariant `computeDayPlan` already enforces), and the freeze
is cleared in `applyMatchData` - the one place genuinely fresh match data
(a fetch, a poll, a manual refresh) arrives, since a stale snapshot could
otherwise hide a fixture that's newly relevant or keep a removed one
around forever. `computeDayPlan`/`alternativeIds` itself is UNCHANGED -
this is deliberately a presentation-layer fix, not a scheduling-math one,
so the 279 existing pure-function tests (which exercise
`alternativeIds`'s per-choice computation directly, including the exact
A/B/C two-stack scenario this fix has to keep working) needed no changes
and still pass unmodified.

**Verified live, not just by inspection**: re-ran the same
`Input.dispatchTouchEvent` reproduction against a local static server
(this repo's own `public/` mounted against a real snapshot of the
deployed `matches.json`) before and after the fix. Before: one forward
swipe on the MLB stack grew it from 5 to 8 members. After: three
consecutive forward swipes keep the member count at exactly 5 throughout,
with the primary card correctly advancing through that fixed list each
time. `node --test` (279/279) and `node --check public/app.js` both still
pass.

**What this round did NOT find broken**: the live `/match-recommend`
proxy (`jaypengx-collab/shared-proxy`) was hit directly during this
investigation and returned a valid, fast, correctly-shaped response;
the deployed `matches.json` carries real, current AI-validated reasons
(not stale/fallback objective-only scores); and `scripts/
evaluate-recommendations.mjs` run against that same live export reports a
sound planner (its independently-recomputed oracle matches the actual
schedule wherever it has real recommended-flagged candidates to compare -
see that script's own comment on why a raw `matches.json` export always
reads 0 recommended by itself, `recommended`/`alternativeIds` are only
ever set by the CLIENT's own `resolveViewingPlan`, never written to the
server-side file). Nothing here pointed to Gemini or the scoring engine
being the actual source of the reported "everything is broken" feeling -
the swipe-stack bug above was.

**Known limitation, unchanged from earlier rounds**: there's still no
DOM/browser test harness in this repo's own `node --test` suite, so this
fix (like the swipe/card-stack work in Round 5 and Round 7) is verified by
a live/local headless-browser reproduction recorded here, not by an
assertion `npm test` runs on every commit. A regression here would only
resurface the same way this one was found - swiping an actual deployed
stack, not a failing CI test.

## Round 9 - live-verifying the objective-score formula against real data, and a genuine scoring bug it found

A direct request to optimize the recommendation engine by comparing its
actual output against real online/media data. This is also the first time
this repo's own long-standing "Known limitations" caveat - every previous
round's own "no live verification of either new external API" disclaimer,
present since Round 6 - could actually be tested: this session's
environment has real outbound network access to the MLB Stats API, the
Jolpica F1 API, and general web search, none of which any earlier session
had.

### 1. The MLB Stats API integration is confirmed accurate against live data

Fetched the real, current NL standings directly and hand-verified one
live-scored fixture end to end: `mlb-401817017` (Philadelphia Phillies @
New York Mets, 2026-09-20) computed `competitiveness: 8`,
`playoff proximity 10/0`. The live MLB Stats API's own standings for that
exact date show the Phillies holding a wild-card spot outright (WCGB "-")
while 6 GB in their division, and the Mets 14 games back in the wild
card with only a handful of games left (mathematically all but
eliminated) - feeding those real numbers through `playoffProximityScore`/
`closenessFromWinPctGap`/`closenessFromSpread` by hand reproduces the
exact `8`/`10`/`0` the live build computed. Independently, a web search
for real published MLB coverage of that same date flagged this exact
fixture as the day's wild-card-race must-watch game, for the same
reason the deterministic formula's own `factors` already state ("9.0pp
win% gap, playoff-race atmosphere"). `scripts/sport-signals.mjs`'s MLB
integration - unverified against a live response in every prior round -
is doing exactly what it was designed to do. This closes that
long-standing limitation for MLB; F1 (Jolpica) is reachable the same way
but wasn't independently checked against a real race this round.

### 2. Found instead: a real, live, high-impact scoring bug - 0 games played read as a perfectly even matchup

Comparing top-scored fixtures across the whole window against real
public attention surfaced a fixture that had no business being anywhere
near the top: an NBA "Miami Heat @ Toronto Raptors" fixture on 2026-10-03
- both teams 0-0, no betting line posted (a real market signal that this
isn't a real game to price), venue "Videotron Centre" (a Quebec City arena
NBA teams only play in for preseason exhibitions) - scored a maxed-out
`competitiveness: 10`, `enduranceScore: 10`, and an overall `9.0`, ranking
ABOVE genuine September MLB pennant-race games with real stakes. Even
Gemini's own validation reason correctly identified it as preseason
("熱身賽階段評分符合預期") and still left the score untouched, because its
adjustment is bounded to ±2 per dimension - it can't fix a baseline that's
wrong by that much, only the deterministic formula itself can.

**Root cause**: `scripts/build-data.mjs`'s `computeMatchObjectiveScore`
computed `awayWinPct`/`homeWinPct` as `wins / Math.max(1, wins + losses)`
- a divide-by-zero guard that silently turns "this team has played 0
games" into a real, finite `0`, indistinguishable from "this team has
played games and gone 0-for-everything". Every per-sport formula already
guards `Number.isFinite(awayWinPct) && Number.isFinite(homeWinPct)`
specifically so a genuinely missing signal renormalizes away via
`weightedAverage` instead of counting as a real value - that guard simply
never worked, because two 0-0 teams' win% wasn't missing, it was a real
(wrong) `0`, and `closenessFromWinPctGap(0 - 0)` reads a `0.0pp` gap as
the most even matchup possible: a `10`.

**Fix**: `awayWinPct`/`homeWinPct` are `null` (not `0`) whenever a side has
played zero games - the exact case the existing `Number.isFinite` guards
in every per-sport formula were already written to handle correctly, once
they actually receive a real `null` instead of a fake `0`. The same bug,
same fix, applied to `objective-score.mjs`'s `closenessFromLastTen` (a
team with 0 of its own last-10 games played, a lower-probability but
identical-shape edge case for a brand-new season/roster). Both are
covered by new regression tests built directly from the live-observed
case (`tests/build-data.test.mjs`, `tests/objective-score.test.mjs`) -
281/281 assertions pass.

### 3. The AI-validation "evidence" layer is confirmed completely non-functional - a quota wall, not a scoring problem

While investigating whether the scoring gap above was masked by missing
AI validation, checked the live `matches.json` directly: 0 of 135
fixtures carry any grounded evidence at all, despite 115 of them
otherwise going through successful AI validation. Root-caused via a
purpose-built diagnostic added to the shared proxy
(`jaypengx-collab/shared-proxy`'s `debugGrounding` request flag): every
model in `MATCH_RECOMMEND_MODELS` returns an immediate `429
RESOURCE_EXHAUSTED` for the grounded (Google Search tool) request
specifically, while the exact same models succeed instantly for the
plain scoring call in the same `/match-recommend` invocation. Google
Search grounding sits on its own, much stricter quota than plain Gemini
generation on this account/API key - a billing-tier limit, not a bug this
codebase's own code can fix. A KV-backed cooldown was added on the proxy
side so a confirmed all-429 batch stops retrying 3 known-doomed models on
every subsequent build until the cooldown expires - a latency/cost fix,
not a capability fix. Getting real grounded evidence back requires either
enabling billing for Search grounding on that Gemini API key, or a
genuinely different real-time-search source - both real decisions this
round didn't make unilaterally.

### Known limitations after Round 9

- Only MLB's live data was independently hand-verified this round; F1
  (Jolpica) and NBA/EPL's odds-only signals were not, though the network
  access to check them now exists where it didn't in any earlier round.
- The 0-0/no-games-played bug was found by comparing scores against real
  public data, not by a systematic audit of every `Math.max(1, ...)`
  divide-by-zero guard in the codebase - `scripts/evaluate-recommendations.mjs`
  has a few of the same shape but computing plain descriptive rates
  (recommended-rate, sport-share), where a 0-vs-null distinction has no
  real behavioral consequence the way a scoring input does, so those were
  left alone rather than changed on spec.
- Evidence/grounding remains non-functional pending the billing/vendor
  decision above - every fixture still scores on the deterministic
  formula plus AI validation alone, same as before this round, just with
  the specific 0-0 scoring bug now fixed underneath it.

## Round 10 - alternativeIds gets a quality gate: variety isn't "show every conflict"

A direct product-level complaint about the swipe stack itself: every
direct scheduling conflict was being surfaced as a swipeable alternative
regardless of how good it actually was, so a slot with one clearly
outstanding pick and one throwaway conflicting fixture rendered exactly
the same "pick one of these" stack as a slot with two genuinely
comparable games. That's not variety, it's noise - and it actively erodes
trust in the stack once a viewer swipes a few times and finds most
"alternatives" aren't real options at all.

**Change**: `computeDayPlan`'s `alternativeIds` computation (`public/lib/
recommendation.mjs`) now gates each direct conflict on
`ALTERNATIVE_MAX_SCORE_GAP` (2.5, matching this file's own existing
`RECENT_REPEAT_PENALTY_BY_GAP_DAYS` notion of "close enough to be a real
call" rather than inventing a second scale) against whichever score field
the plan was actually built with. A conflict that's more than 2.5 worse
than the pick on that score is dropped from `alternativeIds` - the slot
renders as a single card, no swipe UI at all, since there's no genuine
choice to offer. It stays fully visible in `renderAllMatchesSection`
either way; this only decides whether the RECOMMENDED slot pretends
there's a decision to make. The gate is one-directional: an alternative
that's BETTER than the pick (a negative gap) is never hidden, however
large the gap - covers the case where the pick only won because it's a
hard viewer pin against a much stronger natural candidate (see "a pinned
choice only excludes matches it directly conflicts with" in
`tests/recommendation.test.mjs`), where hiding the stronger option would
be actively harmful, not a variety tradeoff.

This directly answers "not every day is equally good" - a day/slot where
the top pick has no real rival now shows exactly that (one confident
card), while a day/slot with two-plus fixtures worth actually weighing
against each other still gets the full stack. Four new tests cover: a
clearly-worse conflict being dropped, a conflict right at the threshold
still counting, a better-than-pick conflict never being hidden even
behind a pin, and a 3-way slot where only the close conflict survives the
gate. All pre-existing `alternativeIds` assertions in the test suite
already had gaps ≤ 2.5 and needed no changes - 285/285 assertions pass.

### Known limitations after Round 10

- The 2.5 threshold is a reasoned constant tied to this file's own
  existing "close call" scale, not independently tuned against real
  viewer swipe behavior (no analytics pipeline exists to measure that) -
  it may need adjusting once real usage data on stack engagement exists.

## Round 11 - Gemini removed entirely, and a live-discovered ESPN blocking bug

A direct instruction: remove Gemini from this pipeline completely, on the
grounds that free-tier quota has proven unable to sustain the workload
(confirmed in Round 9 - Google Search grounding failing 429
RESOURCE_EXHAUSTED on 100% of requests, a billing-tier wall), with the
explicit condition that the engine still has to perform well without it.

### 1. Gemini scoring/validation removed from both repos

**Match-Find** (`scripts/build-data.mjs`): deleted the entire AI-validation
section - `fetchAiScores`, `refineContestedClusters`/
`findContestedClusters`, `applyCachedAdjustments`, `sanitizeCachedEvidenceItem`,
the `data/ai-meta.json` cache/throttle mechanism, and every constant
governing them (`AI_ADJUSTMENT_BOUND`, `AI_FETCH_MIN_INTERVAL_HOURS`,
`CONTESTED_*`, etc.). `main()` now sets every fixture's
competitiveness/watchability/enduranceScore/broadcastQuality/skill/reason
directly from `computeMatchObjectiveScore`'s own output - no adjustment
layer on top at all. `data/ai-meta.json` itself is deleted from the repo
(nothing reads or writes it anymore), and the deploy workflow's "Commit AI
fetch timestamp" step is gone along with the `contents: write` permission
it was the only user of.

**Shared-Proxy** (`worker.js`): removed the entire `/match-recommend` +
`/match-recommend-refine` section (~885 lines - `fetchGroundedMatchInfo`,
`buildMatchRecommendPrompt`/`buildMatchRefinePrompt`, the grounding
cooldown KV mechanism added in Round 9, both route handlers) and their two
router entries. `/sports-proxy` and `/match-dispatch` (Match Find's other
two routes - live score polling and the manual refresh trigger, neither
ever Gemini-related) are untouched, and so is every route serving Orbit/
Orbit Vocab (`/gemini`, `/nl-edit`, `/vocab-ai`, `/sync`, `/vocab-sync`) -
this repo is shared infrastructure for three sites, and only Match Find's
own Gemini usage was in scope here.

**Client (`public/app.js`)**: removed the "AI 重新評估" Settings button/
status text and the silent page-load re-evaluation ping (both meaningless
with no Gemini to re-evaluate anything), the footer's "AI 最後查詢於..."
status line and its GitHub Actions "重新查詢" link, and the permanent
"（API 數據估計，尚未經 AI 驗證）" caveat that would otherwise now render
on literally every single card (since every fixture is "not yet
AI-validated" forever) - a caveat implying a validation that will never
come is worse than no caveat at all. `renderVenue`'s `venueZh` branch
(always empty now - venueZh was only ever AI-sourced) simplified to just
show `match.venue`. "重新整理資料" (plain data refresh) is unaffected -
it never depended on Gemini either.

**`computeConfidence`** (`public/lib/recommendation.mjs`): collapsed from
a 5-tier scheme keyed on `match.source`/`match.refined` (`ai`/`aiRefined`/
`api-objective`/`heuristic`/`finished`) to two states -
`CONFIDENCE_OBJECTIVE` (0.7) for any match with a real computed score,
`null` for one without. There is no longer a per-fixture "how was THIS one
scored" question to answer - every fixture goes through the exact same
deterministic path now, so a 5-tier distinction that used to reflect real
variance (did Gemini see this one, did it survive the refine pass) would
now just be theater. The dead "structured evidence" subsystem
(`describeEvidence`/`isEvidenceFresh`/`EVIDENCE_CATEGORY_LABELS`) is also
gone - confirmed via grep that `public/app.js` never actually rendered it
anywhere, even before this round (Round 9's grounding-quota-wall finding
meant it had been silently producing empty arrays this whole time anyway).

### 2. A real, live bug found by running the build without a proxy: ESPN blocks Node's default User-Agent

Running `scripts/build-data.mjs` for real (this session's own environment
has live network access) initially wrote **0 matches** with no error -
every league's fetch silently returned an empty list. Root-caused by
hand: `fetch('https://site.api.espn.com/...')` with no headers returns a
403 from Akamai (`server: AkamaiGHost`), specifically when the request's
`User-Agent` is Node's own unmodified default (the literal string
`"node"`). Confirmed by direct comparison, holding the proxy/IP/every
other header constant and varying only `User-Agent`:

- No UA / `"node"` (Node's fetch default) → **403**
- A fabricated real-Chrome UA string → **403** (this isn't "block anything
  that isn't a browser" - a convincing browser impersonation is blocked
  too)
- `curl`'s own unmodified default (`curl/8.5.0`) → **200**
- `python-requests/2.31.0`, `okhttp/4.9.0` → **200**
- `PostmanRuntime/...`, `Wget/...` → **403**

This reads as an Akamai Bot Manager rule blocklisting a specific set of
known automation-tool UA tokens (which happens to include Node's own
default and a couple of others) rather than anything resembling real bot
behavior - genuinely surprising that node's DEFAULT is on that list, but
directly, repeatably confirmed. **Fix**: every ESPN fetch in
`scripts/build-data.mjs` (`fetchJson`, the one shared helper every league
fetch goes through) and, for defense in depth, every fetch in
`scripts/sport-signals.mjs` (MLB Stats API, Jolpica F1 - not currently
affected, but free to fix preemptively) now sends an honest,
self-identifying `User-Agent: Match-Find-Bot/1.0 (+https://github.com/
jaypengx-collab/Match-Find)` - confirmed live to return a normal 200 with
real fixture data. Verified end to end after the fix: a real run wrote
**135 matches** with a real score spread (min 1, max 10, avg 7.24) and
legible, factor-grounded reason text for every one, entirely without
Gemini.

Whether this exact block is active in GitHub Actions' own runner pool at
any given moment is unknown from here - this fixes it either way, at zero
cost, rather than leaving a silently-empty `matches.json` (this pipeline's
worst possible failure mode - not a bad recommendation, no recommendations
at all) as a real, undetected possible outcome of nothing more than which
default string a fetch call happens to send.

### Known limitations after Round 11

- The `Match-Find-Bot/1.0` UA fix was verified against a live 403 in THIS
  session's own environment - it is not confirmed whether GitHub Actions'
  own runners were ever actually hitting this block in production (the
  site's own history of real recommended fixtures suggests they likely
  weren't, at least not consistently), so the practical impact of this fix
  going forward is unconfirmed, even though the bug itself and the fix
  are both directly, repeatably verified.
- The one variety Gemini's validation pass added - occasionally writing a
  fixture's `reason` in its own prose instead of the deterministic
  template - is gone; every reason is now built from the same
  `buildObjectiveReasonZh` template. This is a presentation-only loss, not
  a scoring one (Round 9 already established the validation pass's own
  adjustment was bounded to ±2 and quota-starved besides).

## Round 12 - Eleven live-reported bugs: swipe UI rewrite, scoring/duration/window fixes, pin-persistence root cause

A single, large user report bundling 11 distinct issues, several already
diagnosed live against real, freshly-fetched matches.json data rather than
just reasoned about abstractly. In order:

**1. Swipe stack "stuck on every single stack after one swipe" on real
Safari.** The Round-11-era fix (defer the pin commit until `transitionend`)
was live-reported to still freeze. Rather than guess a fourth timing fix
against a browser this sandbox has never been able to run, `buildMatchStack`
was rewritten to remove the drag gesture entirely: it now shows exactly one
card, with prev/next arrow buttons and directly-tappable dots that commit a
pin immediately on click. A `click` handler has no "is the native gesture
actually done yet" question for a fixed frame count/transitionend/timeout to
answer wrong - there is no gesture, only a discrete, synchronous press. This
also let two other pieces of machinery be deleted outright: the whole
`interactedStack`/`patchStackSelectionTags` DOM-node-reuse mechanism (it
existed only to avoid a visible flash from resetting a drag-based stack's
scroll position on rebuild - a tap-based stack has no scroll position to
lose) and the `isStackBeingInteractedWith` mid-gesture cooldown gating the
periodic re-render/live-poll timers (nothing is ever "mid-gesture" anymore).
Verified via Playwright/Chromium against live-fetched data: repeated dot and
arrow clicks across an 8-member real MLB stack all landed on the correct
match every time, zero console errors. Still unverified on real
Safari/WebKit (no such browser in this sandbox) - but the fix removes the
entire *class* of bug (gesture-completion timing) rather than retuning it a
fourth time, which is the qualitatively different kind of fix repeated
failures on that class called for.

**4. Swiped/preferred card sometimes rendered greyed out.** Root cause
found directly in the old code: `patchStackSelectionTags` (the DOM-reuse
patch path above) updated the recommended-tag and `.is-recommended`/
`.is-pinned` classes on a reused card, but never touched `.is-muted`
(`opacity: 0.55` - see styles.css) - so a card built once while muted (it
lost an earlier overlap comparison) stayed visually muted forever after,
even once a swipe made it the slot's own preferred pick. Fixed as a direct
consequence of Bug 1's rewrite: every render now calls `buildMatchCard`
fresh (no more patch-only reuse path), so every visual class is always
recomputed from that render's real state.

**2. The generic "依雙方戰績...計算" reason line called out as useless.**
It restated, in a vague category label, that a deterministic formula used
team records - true but uninformative on nearly every card, since season
win% is almost always the only signal, feeding the same phrase over and
over. Fixed by no longer rendering `.match-reason` in the UI at all
(`reasonEl.hidden = true` in `buildMatchCard`) - the underlying
`match.reason`/`match.objectiveFactors` fields are kept for
`scripts/evaluate-recommendations.mjs` and direct matches.json debugging.

**5. "與...衝疊...分鐘" comparing a card against its own stack-mate.**
`match.overlappingIds` includes every match a fixture overlaps at all,
which for a member of a swipeable stack necessarily includes its own
alternates (that's the whole reason they're grouped together) - so the
overlap note could name a card's own alternate as if it were a genuinely
separate scheduling conflict. Fixed by excluding any `isNearTotalOverlap`
match from the overlap-note candidates in `buildMatchCard`, leaving only
genuine, separately-scheduled neighbors.

**3 & 7. Liverpool @ AFC Bournemouth (2026-09-20, 21:00 TW time) not
recommended despite being "the best of three" at that hour - checked against
live, freshly-fetched real data, not assumed.** Confirmed directly:
`computeEplObjectiveScore` gave it `competitiveness=3, watchability=3,
skill=1` - the WORST possible skill score - purely because both teams'
early-season win% (a small, noisy sample this early in a new season) happen
to average out low, even though Liverpool is one of the most-watched clubs
in world football regardless of any one season's start. EPL had no
mechanism analogous to MLB's/NBA's rivalry bonus for "this club is a major
draw independent of the current record" - only a derby bonus (a fact about
a specific pairing, not about star power). Fixed with a new,
precedent-matching `EPL_BIG_CLUBS`/`isEplBigClub` (the real, widely-used
"Big Six" term) additive watchability bonus in `scripts/sport-duration.mjs`
+ `scripts/objective-score.mjs`, stacking with the derby bonus rather than
competing with it. Verified: Liverpool's watchability rose 3→5, score 3→4
on a real rebuild. **Honest limitation**: this did NOT flip the actual
recommendation in this specific instance - Crystal Palace @ Leeds United
scored 8 in the same slot on genuine season-record closeness, and closing
a 4-point gap with a bounded, precedented nudge would have meant either an
oversized bonus or bending the "close competitiveness matters, not just
brand fame" design principle this engine has held since Round 9's "Best
Matches" unification. Whether Crystal Palace-Leeds or Liverpool-Bournemouth
was really the better recommendation that day is a genuine judgment call
this session can't independently settle without real match-day narrative
context (injuries, table stakes, actual viewership data) this build has no
API for - the fix closes a real, verified gap in the scoring model without
overcorrecting into "the famous team always wins."

**6. MLB's shown end time "almost always" exceeded.** The per-fixture MLB
duration formula (`predictMlbDurationMinutes`, ~164min average) was never
inaccurate as computed - the bug was that the CARD'S displayed end time
(`buildMatchCard`) used the bare pre-game `durationMinutes` directly, while
this codebase's own scheduler (`schedulingDurationMinutes`) already knows to
pad a no-clock sport's estimate for real overrun risk
(`DURATION_OVERRUN_BUFFER_BY_RELIABILITY`) before trusting it. The viewer
was shown a number the app's own internal logic didn't actually believe.
Fixed by having the displayed end time use `estimatedDurationMinutes`
(recommendation.mjs, the same overrun-padded figure already used for
lifecycle/live-window purposes) for any non-finished match, not the bare
figure - a finished match still shows its own real, observed elapsed time.

**8. Today's finished matches were still swipeable.** A finished fixture
correctly stays in 推薦賽事 as history (Round 9's own "the whole day is one
plan" design), but could still inherit `alternativeIds` from
`computeDayPlan` and render as a live swipe stack - nonsensical once the
outcome is already fixed. Fixed in `renderRecommendedSection`: any
`match.isFinished` always renders as a single plain card, regardless of
alternatives.

**9. Variety could override a clearly-better game, not just a close one.**
`applyRecentRepeatPenalties` could stack the matchup-repeat penalty (up to
2.5) and the sport-concentration penalty (1.5) to 4.0 total - well past this
same file's own settled "close enough to be a real call" line
(`ALTERNATIVE_MAX_SCORE_GAP = 2.5`), so a match ahead by 3+ points could
still lose to a worse alternative purely from stacked diversity nudges -
backwards from "serve the best game, THEN prioritize variety." Fixed by
capping the combined penalty at `ALTERNATIVE_MAX_SCORE_GAP` before it's
subtracted into `planningScore` - variety can now only ever tip a genuine
toss-up, never bury a decisive lead.

**10. Preferred/swiped match "not saved properly" - wiped back to 推薦 on
reload.** Root cause: pins were keyed by `slotKeyFromMembers(cluster.members)`
- a hash of the exact set of matches computeDayPlan happened to group
together at pin time. That grouping is NOT stable: it can shift from a live
duration correction, a routine 15-minute data refresh, or simply the
viewer having the sport filter narrowed to one sport when they swiped
(which excludes cross-sport near-overlaps from the cluster entirely, then
resets to "全部" on the very next reload). Any shift silently orphaned the
pin under a key nothing would ever look up again - it was still sitting in
localStorage the whole time, just unreachable. Fixed by re-keying pins to a
flat `Set<matchId>` per day (`public/lib/preferences.mjs`), looked up by the
PINNED MATCH'S OWN id (`cluster.members.find(m => pinnedForDay.has(m.id))`
in `computeDayPlan`) - stable regardless of how the cluster around it
reshapes. `explainWhyNotRecommended`'s own forced-pin comparison had the
exact same old-shape bug (missed in the initial pass, caught by the existing
test suite going red) and was fixed the same way.

**11. "Yesterday" showing only Premier League, no MLB.** `build-data.mjs`'s
fetch window looked back only 1 UTC calendar day from build time - enough to
cover ESPN's own US-Eastern-vs-UTC date-grouping quirk, but NOT enough to
cover this site's actual audience: Taiwan is far enough ahead of US game
times that the viewer's own "yesterday" (Taiwan local calendar) can
correspond to an ESPN/US game date a full 2 UTC-calendar-days behind build
time, not 1 - a gap EPL's earlier UK kickoffs rarely fall into but US-evening
MLB games routinely do. Fixed by extending the lookback to 2 days (both the
per-day team-league query and the F1 date-range query). Verified against a
live rebuild: Taiwan's "yesterday" bucket went from 5 EPL/0 MLB to 5 EPL/15
MLB.

All 276 tests pass (up from 270 - new coverage added for the penalty cap,
the big-club bonus, and the pin-persistence-across-cluster-drift fix).

## Round 13

Follow-up live report after Round 12 shipped, covering the tap-only swipe
rewrite specifically plus two live-data questions.

**Swipe gesture removed entirely in Round 12 was the wrong amount of fix.**
Round 12 went all the way to tap/click-only controls to structurally kill
the "stuck after one swipe on Safari" bug class, reasoning that a real drag
gesture has an inherent "is this gesture done yet" timing question and a
tap does not. Live feedback: taps work, but the swipe itself is genuinely
better UX and is achievable on Safari - the reporter has other real
projects with working Safari swipe. That's consistent with the Round 12
diagnosis: the three prior FAILED swipe attempts weren't proof swiping
itself is unsafe on Safari, they were proof that deciding a drag's
completion via a frame-count guess or a `transitionend` listener is unsafe
(Safari can skip `transitionend` outright when a transition is interrupted,
backgrounded, or its element is removed mid-transition - which is exactly
what happens on every successful swipe once the card gets replaced).

Restored dragging in `buildMatchStack` (`public/app.js`) as an INPUT method
layered on top of the exact same tap-safe `choose(index)` function the
arrows/dots already call, never as a second, parallel state machine:
- Pointer Events (`pointerdown`/`pointermove`/`pointerup`/`pointercancel`/
  `lostpointercapture`) with `setPointerCapture`, not separate touch/mouse
  listeners - capture is what keeps the whole gesture pinned to the card
  even if the finger wanders off it mid-drag, which a bare
  `touchmove`/`touchend` pair has no equivalent for.
- `touch-action: pan-y` on the card (`styles.css`) instead of manual
  `preventDefault()` gesture math, so Safari's own native engine - not this
  file's own JS - arbitrates "page scroll" vs. "horizontal swipe".
- The commit decision happens synchronously inside the `pointerup` handler,
  read directly off the pointer's own final position - never inside an
  animation/transition callback. The fly-off animation on a successful
  swipe is purely decorative: it's started and then immediately abandoned
  as `choose()` tears down that exact card node on the same tick, so
  nothing downstream ever waits on it to finish (a plain `setTimeout` was
  considered and rejected for the same reason `transitionend` was - no need
  to wait on ANYTHING async when the synchronous path is available).
- `pointerup`, `pointercancel`, AND `lostpointercapture` all funnel into one
  `resetDrag()`, so however the gesture ends - a normal release, the OS
  reclaiming the gesture, a second finger landing - the card is guaranteed
  out of the drag state, never stranded mid-transform waiting on an event
  that might not arrive.
- Swiping past either end of the stack snaps back rather than flying off
  into a replacement that never comes - `choose()` clamps and is a no-op at
  the boundary, so the fly-off animation is only started once the target
  index is confirmed to actually differ from the current one.
Verified with Playwright/Chromium: a real mouse-drag sequence (multi-step
`mousemove`, matching the intermediate-position stream a touch drag
produces) advances the stack correctly across 5 repeated swipes, a
below-threshold drag snaps back with the card unchanged, 10 rapid swipes
past the last card never gets stuck, and a synthetic `pointerType: 'touch'`
event sequence dispatched directly (bypassing Playwright's mouse-only
`page.mouse` API) also advances the stack with zero console/page errors.
Real Safari itself still isn't available in this sandbox, so device
confirmation is still the one thing only the reporter can give - but this
is a structurally different bet than the three prior failed attempts: the
actual moment of state change no longer depends on any animation event
firing at all.

**Swipe-stack dots were "kind of invisible".** They used
`background-color: var(--border)` for the inactive state - `--border` is
deliberately a near-invisible hairline color against `--bg-raised` (that's
the whole point of a border color), which made an inactive dot nearly
impossible to see against the card behind it. Switched to `--text-muted`
(built to be legible body-adjacent text, not a subtle hairline) and bumped
the visible dot from 6px to 8px.

**Live-data spot checks against two further reports, both traced to real
causes rather than left as unexplained "it's wrong":**

- *Padres @ Dodgers appearing to repeat across 9/23 and 9/25.* Reran the
  exact `computeWindowPlan` pipeline against the currently deployed
  `matches.json` (same live ESPN data the reporter would have seen). It
  does NOT currently pick Padres/Dodgers on either date - both slots go to
  Tampa Bay Rays @ New York Yankees, including a genuine day/night
  doubleheader on 9/22 (two separate real games, `mlb-401873648` at 17:05
  UTC and `mlb-401817034` at 23:05 UTC, both TW-day-keyed to 9/23 - NOT a
  duplicate-data bug). Padres/Dodgers's own night window (02:10-05:13 UTC)
  is pushed into a real, if narrow, ~27-minute overlap with the Yankees/Rays
  night game's OWN scheduling window once that game's pre-existing 25% MLB
  overrun buffer (`DURATION_OVERRUN_BUFFER_BY_RELIABILITY.low`, predating
  this session) is applied - so the scheduler correctly treats them as
  competing for one slot and picks the higher-scoring Yankees/Rays game
  instead. Since ESPN's live standings/schedule refresh continuously, this
  specific comparison can only be verified against data as of THIS build,
  not whatever the reporter's browser had cached when they tested - if it
  really did show Padres/Dodgers on both dates, that was very likely EITHER
  an earlier data snapshot (before either game's score/overrun math looked
  like it does now) OR the pre-Round-12 pin-persistence bug (#10) forcing
  in a stale pinned choice. Nothing here points to an actual defect in the
  current pipeline; no change made.
- *"Yesterday" now recommending a Man City game instead of Liverpool vs
  Bournemouth.* Verified `buildDayList`/`localDateKey` (`public/app.js`):
  "yesterday" is computed fresh from the VIEWER'S OWN clock on every page
  load, with no fixed anchor - it is always "whatever real calendar date is
  one day before now", not a specific frozen fixture list. Real time has
  moved on since the original report; the Liverpool/Bournemouth match has
  since aged out of `build-data.mjs`'s 2-day lookback window entirely (it's
  further in the past now than the window reaches), so of course "yesterday"
  now shows an entirely different day's real EPL results - and the current
  crop of currently-deployed "yesterday" fixtures contains no Man City game
  at all (a Sunderland vs Man City fixture exists, but it's on TODAY, not
  yesterday). This isn't a bug to chase with more scoring adjustments -
  "yesterday" is a moving target on a live-refreshing site by design, and a
  specific fixture that already aged out of the window cannot be forced
  back into first place without breaking the window's own definition. No
  change made; flagged back to the reporter rather than silently
  no-op'd.

Tests unaffected by this round (the UI-side changes have no dedicated
Node test harness) - the existing 276 lib/data tests still pass unchanged.

## Round 13, continued: the EPL push-back was wrong

The reporter pushed back on both "no change made" conclusions above,
insisting the Man City/Crystal Palace case was reproducing right now on
TODAY's date (9/20), not some aged-out "yesterday". That correction was
right, and re-checking it under that framing (today's own date tab, not
the "昨天" relative label) surfaced a real, previously-undiscovered bug -
the actual root cause behind essentially the entire Liverpool/Bournemouth
saga (#3/#7/Round 13's own EPL section above).

**A long-finished match's `durationMinutes` blew up to hours, silently
crowding a genuinely better fixture out of the schedule.** Crystal Palace
vs Leeds United (13:00 UTC kickoff, `enduranceScore: 8`, by far 9/20's
highest-scoring EPL fixture) was recorded with `durationMinutes: 290` -
four hours fifty minutes, for a normal finished Premier League league
match. `finishedDurationMinutes` (`scripts/build-data.mjs`) computes a
finished fixture's duration as "how long ago did this start" - a fix from
an earlier round for the OPPOSITE problem (a blowout that genuinely ended
EARLY still reserving its full pre-game estimate). That's only a good
proxy for the real game length when the fetch happens shortly after the
match actually ends. This workflow's cron reads the WHOLE day's schedule
every 15 minutes regardless of when each individual fixture kicked off or
finished - so a 13:00 UTC kickoff re-checked at 17:41 UTC (a perfectly
ordinary cron cycle, nothing anomalous about it) got "elapsed minutes
since kickoff" (281) recorded as its actual game length, when the real
match was over in ~115 minutes like any other EPL fixture. `datePlan`'s
scheduler (`public/lib/recommendation.mjs`) trusts `durationMinutes`
completely - a 290-minute reserved block for a 13:00 kickoff extends to
17:25 UTC, which fully swallows Man Utd vs Fulham's 15:30 kickoff, forcing
the scheduler to choose between them. Since Crystal Palace/Leeds's own
(correct) score handily beat Man Utd/Fulham, and BOTH slots the day
actually needed were worth filling, the scheduler picked the two matches
that didn't conflict (Sunderland vs Man City + Man Utd vs Fulham) over the
one match that scored higher but appeared to block a whole second fixture
that, in reality, it was already over well before.

This has nothing to do with any particular team - it silently penalizes
whichever finished match this round's cron happens to catch furthest after
its own final whistle, which skews toward exactly the kind of high-profile,
long-stoppage-time, still-being-talked-about match a viewer is most likely
to ask "why wasn't this recommended" about.

Fixed with `FINISHED_DURATION_CAP_MINUTES_BY_SPORT`
(`scripts/build-data.mjs`): `finishedDurationMinutes` now clamps the naive
elapsed-since-kickoff number to a per-sport realistic ceiling (Premier
League 140 - chosen so two league fixtures on the real-world-standard
2h30m broadcast gap never cross the scheduler's own transition-buffer
boundary purely from this effect; NBA 180; MLB 360, kept generous since
it's this codebase's own declared no-clock/low-reliability sport; F1 180),
floored at the existing `MIN_FINISHED_DURATION_MINUTES`. A fetch that DOES
land soon after the real final whistle is completely unaffected - this
only clips the implausible case. Verified against a live rebuild: Crystal
Palace vs Leeds United's `durationMinutes` dropped from 290 to 140, and it
is now correctly the day's top EPL pick instead of Sunderland vs Man City.
Liverpool vs Bournemouth still doesn't win (competitiveness 3/10 - a
genuinely one-sided match), which is correct; Crystal Palace vs Leeds
(competitiveness 8/10) legitimately deserves the slot more, and now gets
it. Added regression coverage in `tests/build-data.test.mjs`.

The Padres/Dodgers repeat question was re-checked against a second, later
live snapshot and still didn't reproduce (Tampa Bay Rays/Yankees still won
both slots) - unlike the EPL case, this one hasn't turned up a concrete
bug yet. Flagged back to the reporter with a request for the exact card
label (推薦 vs 偏好) next time it's visible, since a stale pin from before
the pin-persistence fix (#10) landed is the next most likely explanation
and that distinction would confirm or rule it out directly.

**Two further live-reported UI issues, both root-caused past their
surface symptom:**

- *"Single blue dot, not all dots present and filled in"* - NOT a color
  bug (the --border → --text-muted change earlier in this round didn't
  actually fix it, because it wasn't the real cause). This project's
  global reset puts everything in `box-sizing: border-box`. The dot
  markup relied on a tiny declared `width`/`height` (6-8px) plus large
  `padding` (10-11px) and `background-clip: content-box` to paint only a
  small inner circle while keeping a big tap target. Under border-box, a
  width smaller than its own padding can't yield a negative content area -
  the browser clamps the CONTENT box to 0x0, so every inactive dot's
  content-clipped background painted nothing. The one dot that WAS
  visible (`.is-active`) only worked by accident: `background: var(
  --accent)` is shorthand, which resets `background-clip` back to its
  default (border-box), so only the active dot ever painted its full
  padded box. This bug predates this session's work entirely - it was
  never actually about the color. Fixed by decoupling the tap target from
  the visible dot: the button is a plain 22px transparent target with no
  padding to fight box-sizing over, and the visible 7px circle is a
  `::after` pseudo-element positioned independently. Verified with a
  Playwright screenshot: all N dots now render, the active one filled
  `--accent` at 1.3x scale, the rest a visible `--text-muted` gray.
- *"Dots and swipe button are big"* / *"swipe gesture gets stuck in the
  background on a screen bigger than a phone"* - the arrow buttons were
  sized to this app's own `--tap` (44px, its standard touch-target
  constant elsewhere), oversized for this tight inline control; shrunk to
  30px, dots' tap target to 22px. The "stuck in background" report is a
  real, distinct bug from the original Safari freeze: a card contains real
  `<img>` team-logo elements, and starting a MOUSE drag on top of an
  `<img>` triggers the browser's own native HTML5 image drag-and-drop (a
  "ghost" copy of the image trailing the cursor under the browser's own
  drag session) - something a real touch drag never triggers, which is
  exactly why this only showed up "on a screen bigger than a phone" (i.e.
  mouse input, not touch). Fixed from both sides: `-webkit-user-drag: none`
  on every image inside the stack, plus `event.preventDefault()` in the
  pointerdown handler itself (for browsers that don't honor the CSS
  property). Re-verified the full swipe test suite (Playwright, both
  simulated mouse-drag and synthetic `pointerType: 'touch'` events) still
  advances/snaps-back/never-gets-stuck correctly with this added.

279/279 tests pass (up from 276, three new cases for the finished-duration
cap).

## Round 14: EPL draws bug, undiluted marquee bonus, MLB overrun tuning, exact-tie variety, and a real persistence bug found along the way

Triggered by a further live report insisting on the EXACT same three
threads Round 13 pushed back on (one wrongly) plus a genuinely new one:

- *"9/20 TW time should recommend Liverpool vs Bournemouth (currently
  Palace vs Leeds)"* - traced to a REAL, previously-unnoticed data bug:
  `parseOverallRecord` (build-data.mjs) captured a soccer record's third
  regex group (draws) but discarded it, keeping only `{wins, losses}`.
  ESPN's real 2026-09-20 summary for Crystal Palace was `"1-1-3"` (1 win,
  1 loss, 3 draws - 5 games), but this function read it as `{wins:1,
  losses:1}` - a fake 2-game, .500 record instead of the real 5-game,
  .200 one. That inflated Crystal Palace's win% enough to make Crystal
  Palace @ Leeds United's season-closeness score (8) beat Liverpool @ AFC
  Bournemouth (3) outright. Fixed by keeping the third group as `ties` and
  including it in games-played (never in the win numerator). Even after
  the fix, though, Liverpool/Bournemouth's raw bestMatchScore STILL didn't
  clear Palace/Leeds - isBigClub's own +2 watchability bump (added in an
  earlier round for this exact matchup) only reaches the final blend
  diluted through watchability's 0.35 weight (+0.7 net), nowhere near
  enough. Added `isMarqueeFixture`/`MARQUEE_FIXTURE_SCORE_BONUS` (+2) to
  recommendation.mjs, applied UNDILUTED directly on top of bestMatchScore
  (same treatment as the existing priority/service nudges), reading
  straight off `objectiveFactors`' already-shipped derby/big-club/rivalry
  strings rather than a new build-time field.
- *"9/23, 9/25 10:10 both Padres vs Dodgers... it should only show once"*
  plus a new, precise complaint: *"I can't swipe on the card stack that is
  not the first... any other match will kill the first card stack, we
  should allow that... it has to be able to kill the first card and make
  them the only card"* and *"the ~10-15 minute overlap [blocking Rays vs
  Yankees] is acceptable... optimize the engine further." A from-scratch
  live simulation (fetching matches.json fresh, replicating
  computeWindowPlan exactly as app.js does) fully reproduced all of it
  this time:
  - Tampa Bay Rays @ New York Yankees (9/24 23:05 UTC, enduranceScore 9)
    missed San Diego Padres @ Los Angeles Dodgers' 02:10 UTC start by
    exactly ~15 minutes, purely from `DURATION_OVERRUN_BUFFER_BY_
    RELIABILITY.low`'s 25% MLB padding (152.28min effective duration *
    1.25 + 10min transition = 200.35min reserved, 15.35min past the
    185min actually available) - losing the whole slot to a lower-scoring
    Reds/Braves + Padres/Dodgers combination even though Rays/Yankees
    outscored both on every axis. Brought the low-reliability buffer down
    from 0.25 to 0.12 (still real padding - ~19min on a 162min game - just
    no longer manufacturing a false conflict out of padding alone for a
    typical MLB back-to-back gap).
  - Separately, once that was fixed, Padres/Dodgers (already recommended
    2 days earlier) and Houston Astros @ Athletics (a fresh matchup) came
    out to the EXACT SAME total whole-day plan value (16.725) for 9/25's
    late slot, once both candidates' variety penalties were capped to the
    same 2.5 - a genuine coin-flip the DP happened to resolve by original
    array order, not any real quality difference, so the same matchup kept
    winning back-to-back recommended days by implementation accident.
    Added `VARIETY_TIEBREAK_FACTOR` (0.001, scaled by each candidate's own
    UNCAPPED penalty total, so the more-penalized/already-repeated
    candidate loses an otherwise-exact tie) - far below this system's real
    score granularity (every input is an integer 1-10 through weights that
    are themselves multiples of 0.05), so it can only ever decide an
    actual tie, never override a real gap ALTERNATIVE_MAX_SCORE_GAP's own
    cap protects.
  - The "can't swipe on a later stack" report was the user's own correct
    diagnosis: a slot whose conflict cluster has only one member renders
    as a plain, non-swipeable card (renderRecommendedSection's own
    `!alternatives.length` branch) - there's nothing to swipe TO within
    that cluster. The actual ask was a new capability: let a viewer
    override ANY slot with a match from anywhere else that day, killing
    (excluding) whatever it conflicts with. computeDayPlan's forcedIds/
    excludedIds pinning mechanism already does exactly this generically
    for any matchId - the missing piece was purely a UI entry point.
    Added a "設為偏好" button to buildMatchCard (shown on any not-yet-
    recommended, non-quiet-hours card) wired to a new `preferMatch`
    function that computes the target's own conflict cluster fresh and
    calls the existing `pinSlotChoice` - no core scheduling changes
    needed. Verified live in a browser: preferring a buried Padres/Dodgers
    card correctly forced it in as a lone 偏好 card and reshuffled the
    rest of the day's plan around it.
  - Together, all three fixes (marquee bonus doesn't touch MLB; overrun
    buffer + tie-break together) produced a fully re-verified live window
    with genuine day-to-day MLB variety and no repeated matchup within a
    2-day gap - confirmed via a fresh whole-window simulation.
- **A real, independent, previously-undetected bug found while manually
  testing the new "設為偏好" button in a browser**: pinning a match, then
  doing a FULL PAGE RELOAD, silently lost the pin every time - even though
  `localStorage` still had it. Root cause: `state`'s object literal
  (app.js) called `pinnedChoices: loadPinnedChoices()` directly, but
  `loadPinnedChoices` reads `PINNED_CHOICES_STORAGE_KEY`, a `const`
  declared ~350 lines later in the same file. Module top-level code runs
  top-to-bottom, so referencing that binding from inside the state literal
  hit it while still in the temporal dead zone, threw a `ReferenceError`
  caught by `loadPinnedChoices`'s own try/catch, and silently returned an
  empty Map - on EVERY page load, for EVERY pin, ever since (this is a
  general, longstanding bug, not specific to the new button).
  `savePinnedChoices` mid-session always worked fine, which is exactly why
  this went unnoticed: a pin looked like it was working right up until the
  next real reload. Fixed the same way `state.priorityOrder` already
  avoids this trap: `pinnedChoices: new Map()` in the literal, with the
  real `state.pinnedChoices = loadPinnedChoices()` moved to a separate
  statement placed after the storage key is actually declared. Verified
  with a Playwright test that pins a match, reloads the page, and confirms
  the pin (and its 偏好 tag) survives.

283/283 tests pass (up from 279).

## Round 15 (2026-09-20)

- **Live-reported**: "9/23 second card stack still broke with a bunch of
  nonexistent cards and when you swipe it mess with it, only happen 9/23."
  Reproduced against the real live-fetched 9/23 data (via Playwright, real
  browser, `timezoneId: 'Asia/Taipei'`): a single MLB night with 15 games
  starting between 06:35 and 10:10 all chain together into ONE transitive
  conflict cluster (each pair of neighboring start times overlaps by
  >75% of the shorter game's duration - see `isNearTotalOverlap`/
  `groupIntoSlots`), even though the first (06:35) and last (10:10) games
  in the chain don't overlap each other at all. `computeDayPlan` correctly
  produces TWO independent recommended picks from this one cluster
  (documented behavior - see recommendation.mjs's own comment on
  `choice.slotKey`: "a cluster of 3+ ... renders as TWO separate swipeable
  stacks ... both part of the same underlying conflict cluster"), and both
  picks correctly carry the SAME `slotKey` (the whole cluster, by design -
  needed so a pin found anywhere in the cluster resolves consistently).
  The bug was entirely in app.js's `renderRecommendedSection`: its
  `dayMembership` freeze-cache (which exists so a stack's shown
  alternatives don't reshuffle/grow across re-renders) was keyed by that
  bare `slotKey`. Since both stacks share the same `slotKey`, the SECOND
  stack's cache lookup found the FIRST stack's already-frozen members
  (Cleveland/Boston, Chicago White Sox/Royals, Miami/Cubs, Brewers/
  Phillies, Reds/Braves, Nationals/Tigers, Cardinals/Pirates - none of
  which have any real time overlap with the second stack's actual 09:40-
  10:10 games) and displayed THOSE as its "alternatives" - exactly the
  reported "bunch of nonexistent cards," and clicking through them
  reshuffled unpredictably because each click re-triggered the same
  cross-stack cache collision from a different starting point (the "mess
  with it" symptom). Confirmed causally by reverting the fix and
  re-running the identical Playwright script: the broken 8-unrelated-
  alternatives list reappeared exactly as reported, then disappeared again
  once the fix was restored.

  Fix: track how many stacks sharing a given `slotKey` have already been
  built THIS render (`stackOccurrenceBySlotKey`, local to
  `renderRecommendedSection`) and key `dayMembership` by `` `${slotKey}::${occurrence}` ``
  instead of the bare `slotKey`. Since `ordered` is always visited in the
  same chronological order every render, the Nth stack sharing a cluster
  keeps mapping to the same frozen entry across renders (swipes, live
  polls) while no longer colliding with any OTHER stack from the same
  cluster. `slotKey` itself (used for the actual pin lookup in
  `pinSlotChoice`/`buildMatchStack`) is untouched - only the UI-local
  freeze cache's key changed. Verified live: the second 9/23 stack now
  shows exactly its real alternatives (San Diego Padres/Los Angeles
  Dodgers, Houston Astros/Seattle Mariners, Los Angeles Angels/Athletics -
  the actual 09:40-10:10 games), and swiping through all three is stable
  and consistent across re-renders.

  This is only reproducible on a night where one transitive cluster is
  large enough (spans more real time than any single game's duration)
  that the scheduler independently recommends 2+ picks from it - a normal
  MLB slate condition (many games start within the same ~2-hour window),
  not a 9/23-specific data quirk; 9/23 is simply the night the user
  happened to look at while it was showing.

No new automated test added for this one - it's a DOM-rendering bug in
app.js, which (like the rest of app.js) has no unit-test harness in this
repo (see tests/ - only the pure lib/scripts modules are covered by
`node --test`); verified instead via a real-browser Playwright
reproduction against live-fetched data, both before (bug confirmed
present) and after (bug confirmed gone) the fix, as documented above.
283/283 existing tests still pass.

- **Live-requested feature**: "time to add a odds display on the card,
  and odds should adjust live, odds should display in %, make sure the
  API you port in is good data." Checked what ESPN's own scoreboard API
  (already the sole data source this build uses - see this doc's own
  top-of-file architecture notes) actually returns before wiring
  anything: `competition.odds[0]` carries a real per-provider (DraftKings,
  via ESPN's own betting integration) `moneyline` object with plain
  American odds strings (`"-115"`/`"+102"`) for MLB/NBA once a book has
  posted a line (in practice: from roughly a day out until kickoff -
  confirmed live against 9/20 vs. 9/22/9/23 scoreboard responses: 5/15
  MLB games had a posted moneyline on the 9/20 slate that's close to
  kickoff, 0/16 did two days out on 9/22). Soccer/F1 essentially never
  carry one via this API, matching this build's existing spread/overUnder
  posture (see build-data.mjs's own oddsContext comment).

  A raw American moneyline isn't a probability - two-sided book odds
  always overround (both sides' naive implied probabilities sum to MORE
  than 100%, the book's own vig) - so a new shared pure module,
  public/lib/odds.mjs, does the actual textbook American-odds-to-implied-
  probability conversion and then DEVIGS the pair (divides each side by
  their own sum) so the number shown is "how likely is this team to win"
  rather than "how much of your money the book wants on this side".
  Shared by BOTH scripts/build-data.mjs's own pregame build (the card's
  initial %) and public/lib/espn.mjs's `extractLiveUpdates` (the existing
  30-second live-poll mechanism `pollLiveMatches` already runs for
  score/status - see that function's own top-of-file comment), so the
  exact same math backs a card's number at every point in its lifecycle,
  not two independently-written copies that could quietly drift apart.
  `pollLiveMatches` previously read a live poll's updated oddsSpread/
  oddsOverUnder but never actually flagged `changed` for them (those two
  only ever fed the SCORING engine, invisibly, on the next full render) -
  the new win% fields DO flag `changed` themselves, since they're now a
  real, directly-visible on-card number a market moving mid-poll should
  actually update, not just an internal scoring input.

  UI: a compact bar under the two team names (away% - colored track split
  - home%), shown ONLY when a real two-sided line exists for that
  fixture (never a guessed/defaulted 50/50 - most fixtures still show
  nothing here, exactly matching how rarely ESPN actually has one this
  far out). Verified end to end with real ESPN odds data (patched into a
  local matches.json via the exact same parseMoneylineWinPct function the
  build itself calls, not hand-typed numbers) and a live-browser
  screenshot: Milwaukee Brewers 64% – Baltimore Orioles 36%, San
  Francisco Giants 29% – Los Angeles Dodgers 71%, etc., each summing to
  100% and rendering with a proportionally-filled bar.

  9 new tests added (public/lib/odds.mjs's own conversion/devig/parse
  logic, plus updated + one new build-data.mjs parseOddsSignal case for
  the added moneyline parsing) - 295/295 tests pass (up from 283).

## Round 16 (2026-09-20): odds moved to Polymarket entirely, EPL/F1 coverage, real team colors, continuous polling

- **Live-requested, four items in one message**: "Make sure data is
  updated live and constantly", "Add EPL and F1 odds as well", "odds color
  on UI should reflect team color rather than fixed color", then (after
  the EPL/F1/color work below was already built on ESPN's own odds feed)
  "Drop ESPN odds completely, let's use polymarket for odds completely...
  make sure it not only support team game but also F1."

- **Continuous polling**: the live-poll (see app.js's pollLiveMatches) used
  to only run while a match was LIVE/ENDING_SOON. Widened to also poll any
  STARTING_SOON match and any still-PRE fixture within 48 hours of its own
  kickoff (`PREGAME_ODDS_POLL_WINDOW_MS`) - live-verified a real MLS
  moneyline was already posted ~3.3 hours before its own kickoff, so lines
  can move well before a match is anywhere near "starting soon". Polling a
  fixture that in fact has no market open yet is a harmless no-op, not a
  wasted or incorrect request.

- **EPL (3-way) and F1, investigated against real ESPN data first**: ESPN's
  own scoreboard `competition.odds[0].moneyline` shape turned out to
  generalize cleanly to soccer's real three-outcome market - confirmed
  live against a real pregame MLS fixture (San Diego FC @ Inter Miami CF):
  the exact same `{away,home}.{close,open}.odds` shape, just with an added
  `draw` leg. F1 was confirmed to have ZERO `odds` field anywhere on any
  session (practice/qualifying/race) via ESPN - a multi-driver race has no
  head-to-head market for that API to carry at all.

- **Team colors**: added `color`/`altColor` (ESPN's own bare-hex brand
  colors) to each competitor, plus a new pure module
  (public/lib/color.mjs) implementing WCAG relative luminance/contrast and
  `pickReadableTeamColor` - each odds-bar segment uses that TEAM's own
  color instead of one fixed color for both sides. Found and fixed a real
  design bug before shipping: an early version ranked primary vs alternate
  color purely by "whichever wins outright" on contrast, which picked the
  Baltimore Orioles' own alternate (pure black, ~21:1 on a white
  background) over their clearly-legible primary orange (~4.3:1) just
  because black scored higher - fixed by using the primary whenever it
  clears a minimum floor at all, falling back to the alternate only when
  the primary genuinely fails to read.

- **Then, per the user's own explicit follow-up correction, ESPN was
  dropped as the odds source ENTIRELY**, replaced by Polymarket
  (gamma-api.polymarket.com) - investigated live before writing any code:
  - MLB/NBA: one combined two-outcome market per game
    (`outcomes: ["Away Team","Home Team"], outcomePrices: ["0.015","0.985"]`)
    - already a real market-implied probability, no American-odds
    conversion needed at all (unlike the ESPN version this replaced).
  - EPL: THREE separate binary Yes/No markets per fixture ("Will {home}
    win on {date}?", "Will {home} vs. {away} end in a draw?", "Will
    {away} win on {date}?") - matched by question text + team name, then
    devigged together (N-way, not just two).
  - F1: an outright-winner event per Grand Prix (`*-winner-YYYY-MM-DD`),
    ~20-30 separate per-driver binary markets sharing one question
    template - something ESPN never had at all for F1. Matched by the
    Race session's own UTC date (confirmed live: a real Azerbaijan GP
    Race's ESPN start time lands on the exact same UTC calendar date as
    Polymarket's own winner-market slug/eventDate for that race), devigged
    across every named driver found, shown as the top 3 favorites
    ("奪冠機率 Verstappen 34% · Norris 28% · Piastri 19%") rather than a
    two-sided bar, which makes no sense for a 20-entrant field.
  - Event-to-fixture matching uses Polymarket's own structured
    `event.teams[]` (name + ordering) and `event.startTime` (the real
    kickoff, confirmed live to differ from `event.startDate`, which is
    just when Polymarket created the listing) within a 6-hour tolerance -
    robust against a doubleheader day without needing to guess
    Polymarket's own slug/abbreviation conventions.
  - `public/lib/odds.mjs` (the ESPN-American-odds-devig module) and its
    tests were deleted outright as dead code, not left disabled -
    `public/lib/polymarket.mjs` is now the only odds source, used
    identically by both scripts/build-data.mjs (via a new
    `enrichWithPolymarketOdds` pass, one Polymarket fetch per sport, run
    once after all matches are built) and the browser's own live poll (a
    second, separate Polymarket fetch alongside the existing ESPN
    score/status fetch - not every sport has both, F1 has real live odds
    but no ESPN score to poll at all).
  - The scoring engine's own spread/over-under signal
    (scripts/build-data.mjs's parseOddsSignal, feeding
    objective-score.mjs's closenessFromSpread) still comes from ESPN,
    unchanged - "drop ESPN odds" was read as scoped to the win% DISPLAY
    feature this whole session's been building, not that unrelated
    long-standing scoring signal.

- **A real regression caught before shipping**: an earlier edit widening
  the poll trigger (the "continuous polling" item above) accidentally
  deleted the `let livePollTimer = null;` declaration entirely, which
  would have thrown `ReferenceError: livePollTimer is not defined` and
  silently killed the ENTIRE live-poll loop on every single page load -
  caught via a real Playwright browser console-error check before
  pushing, not left for a viewer to discover.

- Verified end to end with a real `node scripts/build-data.mjs` run
  against live ESPN + Polymarket data (real MLB odds flowed through
  correctly for ~37 unfinished fixtures; EPL showed correctly-empty odds
  because every fixture in the fetched window had already finished - the
  real 2026-27 EPL calendar has a September international break, confirmed
  live, so there was no genuinely upcoming EPL fixture to test against
  this round; F1's Azerbaijan GP Race session showed real top-3 favorites)
  and a live-browser screenshot (Brewers/Orioles bar in each team's own
  real color, Tigers/White Sox bar, the Azerbaijan GP's outright-favorites
  chips - the last two confirmed by temporarily moving a copy of the
  race's own start time into today's window, then reverting it, since
  matches.json is never committed anyway).

  32 new tests added between public/lib/polymarket.mjs's own
  matching/parsing/devig logic and public/lib/color.mjs's contrast math -
  the ESPN-odds-specific tests from Round 15 were deleted along with the
  module they tested - 315/315 tests pass overall.

## Round 17 (2026-09-20/21): the scheduled build-and-deploy cycle is gone entirely

- **Live-requested, three items in one message**: "Make the sport league
  label filter button one row horizontal scroll and move settings to the
  end instead of the start"; "Proper import polymarket live data... keep in
  mind of F1 odds... showing the odds of winning for the top three
  drivers" (largely already true from Round 16 - re-verified rather than
  re-built); "Remove merge and check for update feature and replace it
  with live constant updating data flow, we need to get rid of the
  deployment flow and adapt a user based proxy request... if you think
  there is better approach do it your way."

- **Filter row**: `.filter-row` was `flex-wrap: wrap` with the settings
  button FIRST in the DOM - changed to a single non-wrapping row
  (`overflow-x: auto`, the same scrollbar-hiding pattern `.day-scroller`
  already used) with the settings button moved LAST in index.html's own
  markup, not just visually reordered with CSS `order` - so a future
  screen-reader/keyboard tab order matches the visual one.

- **The big one**: this site used to work like every previous round
  described - `scripts/build-data.mjs` ran on a 15-minute GitHub Actions
  cron, wrote a static `matches.json`, and redeployed; the browser only
  ever read that file plus a narrow 30-second live-score/odds poll
  (`pollLiveMatches`) on top of it. "Get rid of the deployment flow" meant
  removing that whole cycle, not just tuning its interval: the match list
  is now fetched and scored **live, in each viewer's own browser**, via a
  new exported `buildMatches` (moved from `scripts/build-data.mjs` into
  `public/lib/match-builder.mjs`, alongside `team-names.mjs`/
  `objective-score.mjs`/`sport-duration.mjs`/`sport-signals.mjs`, all
  relocated from `scripts/` to `public/lib/` since none of them had any
  actual Node-specific code - confirmed by grepping for `node:`/`process.`
  imports before moving a single one). `scripts/build-data.mjs` survives
  as a thin ~50-line Node CLI wrapper, kept only for local dev tooling
  (`dump-day-plan.mjs`/`evaluate-recommendations.mjs` still read a
  `matches.json` snapshot from disk) - the deployed site depends on
  neither it nor its output anymore.

  Investigated the real request-volume constraint before designing the
  refresh cadence, not just picking a number: live-tested whether ESPN's
  own team-sport scoreboard endpoint accepts a multi-day `dates` range
  (the way F1's own `racing/f1` endpoint does) to cut the ~50+ requests a
  full 14-day window needs down to a handful - it does not (confirmed
  live, HTTP 400 for both MLB and EPL). That constraint shaped a genuine
  two-tier design rather than one "refresh everything, aggressively" loop:
  a cheap **near-term** tier (today+tomorrow, a handful of requests, every
  60 seconds) for what's actually live-worthy, and an expensive
  **full-window** tier (the whole 14-day horizon, every 5 minutes) for the
  day-scroller's far-future pills, which don't need per-minute freshness.
  Both merge into `state.allRawMatches` BY ID (`mergeFreshMatches`), never
  a wholesale replace - `buildMatches` already degrades one league's own
  fetch failure to an empty list rather than throwing, so a wholesale
  replace on a transient network blip would have deleted every match of
  that league from the page. The existing 30-second `pollLiveMatches`
  stays as a THIRD, even faster tier on top of both, unchanged in spirit.
  The manual "重新整理資料"/"檢查更新" buttons (and the whole `buildId`-based
  new-code-vs-new-data detection, and the shared proxy's own
  `/match-dispatch` GitHub Actions trigger route) were deleted outright as
  dead code, replaced by one "立即重新整理" button that just re-runs the
  full-window tier immediately - no more 30-60 second wait for a CI
  redeploy.

- **`PROXY_URL` used to be a GitHub Actions Variable substituted into
  `matches.json` at build time** - with no build step left to substitute
  it, it's now a plain hardcoded constant in `public/app.js`, its real
  value confirmed by reading it straight off the currently-deployed site's
  own (about-to-be-retired) `matches.json` rather than guessed.

- **A real, previously-undetected production bug found and fixed while
  verifying this live**: the shared proxy's own `/sports-proxy` route sent
  NO User-Agent at all on its outbound fetch to ESPN, which got rejected
  outright by ESPN's Akamai bot manager ("Access Denied",
  errors.edgesuite.net) - live-confirmed via a direct curl to the real
  deployed Worker. This is the exact same live-confirmed Akamai block
  `scripts/build-data.mjs`'s own Node-side fetch already works around with
  an honest, self-identifying UA - the Worker's own outbound fetch just
  never got the same treatment. This means the EXISTING live-score/odds
  poll feature (shipped in earlier rounds) had likely never actually
  succeeded in production either, silently - `pollLiveMatches`'s own
  try/catch swallows a failed fetch with no visible symptom, since the
  card's initial (Node-fetched, build-time) numbers already looked
  correct. Fixed in `jaypengx-collab/Shared-Proxy` by adding the same
  `Match-Find-Bot/1.0` UA to the Worker's own outbound fetch, deployed,
  and re-verified live (HTTP 403 → HTTP 200, real MLB scoreboard JSON back)
  before relying on it for this round's own architecture.

- **A second, sandbox-only obstacle, correctly diagnosed rather than
  worked around blindly**: a Playwright-launched Chromium in this
  environment doesn't trust the sandbox's own TLS-interception CA, so
  every real HTTPS request from that browser fails
  `ERR_CERT_AUTHORITY_INVALID` regardless of target - confirmed this was
  sandbox-only (not the Akamai bug above, already separately fixed and
  verified via curl) by using Playwright's own `page.route()` to relay
  every `/sports-proxy` request through Node's own working `fetch`
  instead, hitting the exact same real, live, now-fixed Worker - this
  verifies the actual `app.js` code path (URL construction, request
  sequencing, merging, rendering) end to end with genuine live data,
  without needing the sandbox's own browser to complete a raw HTTPS
  connection at all. Confirmed live: 75 real proxy requests relayed, 13
  day pills, 16 real match cards rendered with real team-colored
  odds bars, zero console errors, "立即重新整理" button correctly
  re-triggers the full-window tier.

- `.github/workflows/deploy.yml` renamed ("Deploy to Pages") and stripped
  of its `schedule: cron` trigger and its "Fetch fixtures and build match
  recommendations" step entirely - the opt-in `debug_day_plan` manual dump
  now runs `node scripts/build-data.mjs` itself first (only when actually
  invoked) rather than relying on a build step that no longer exists.
  `jaypengx-collab/Shared-Proxy`'s own `/match-dispatch` route, its
  `MATCH_FIND_DISPATCH_TOKEN` secret setup docs, and Match-Find's own
  README sections describing the old build/deploy/update-check cycle were
  all removed/rewritten to match, rather than left stale.

  No test count regression - the four relocated modules' own tests moved
  with them (import paths updated, logic untouched); 315/315 tests pass,
  same as Round 16's own final count.

## Round 18 (2026-09-21): sport-specific live detail, plus two real bugs found live-testing it

- **Live in-progress detail per sport**, requested directly ("baseball
  showing the inning, bases, out and scores, football showing time
  (stoppages), score, NBA you name it, F1 the lap and possible status and
  current top three leader (safety cars...)"). A new `.match-live-status`
  line renders under the team rows, only while `matchLifecycleState` is
  genuinely LIVE/ENDING_SOON (never for a pre-game or finished card):
  - MLB: `formatInningHalf` turns ESPN's own `status.type.detail` ("Top
    6th"/"Bot 9th"/"Mid 3rd"/"End 7th") into "第 N 局上/下/中/完", plus
    outs/baserunners/ball-strike count from ESPN's own `competition.
    situation` object (balls/strikes/outs/onFirst/onSecond/onThird) -
    genuinely NEW data this app never read before, live-verified against
    two real simultaneous games (2026-09-20/21's Tigers @ White Sox and
    Brewers @ Orioles).
  - NBA: period ("第 N 節", OT beyond period 4) + displayClock - both
    fields `extractLiveUpdates` already captured every poll, just never
    stored on the match or rendered until now.
  - EPL: half (上半場/下半場) + displayClock when it's a real numeric
    clock, or ESPN's own state word (e.g. a halftime label) verbatim
    otherwise, rather than force-fitting it after a half label.
  - F1: a new `extractF1LiveUpdates` (public/lib/espn.mjs) reads the
    racing/f1 scoreboard's own per-session `competitors` array (drivers,
    sorted by ESPN's own live/final `order` field) for the current lap
    (`status.period`) and flag/status text, plus a NEW `.match-
    live-leaderboard` line under the existing static outright-odds chips
    showing the current top 3 - live running order as CONTEXT for those
    odds, not a replacement (a viewer watching an in-progress race can see
    who those odds are currently tracking). Scoped to Race/Qual/Sprint
    (F1_LIVE_SESSION_ABBREVIATIONS), matching match-builder.mjs's own
    F1_SESSION_TYPES id convention exactly (`f1-<eventId>-<abbrev>`).

  `match.live` is written by pollLiveMatches (the fast ~30s tier), not
  match-builder.mjs's own build - same reasoning as odds/score already
  follow: this is squarely "STATUS", the thing that tier exists for. A
  `JSON.stringify` diff (`applyLiveDetail`) skips a re-render on a quiet
  tick where nothing actually moved.

- **Real, previously-unreported bug found and fixed along the way**: every
  team-sport live poll (`liveScoreboardUrl`, the function this whole
  feature depends on for MLB/NBA/EPL) had been silently failing outright
  in production. It built a single `dates=YYYYMMDD-YYYYMMDD` RANGE
  request for "yesterday through today" - live-confirmed via direct curl
  that ESPN's TEAM-SPORT scoreboard endpoint returns a flat HTTP 400 for
  any multi-day range (`{"code":400,"message":"Failed to get events
  endpoint."}`), unlike its racing/f1 endpoint, which tolerates a wide
  range fine (confirmed the same way). `pollLiveMatches`'s own
  `Promise.allSettled(...).catch(() => {})` swallows a failed fetch with
  zero visible symptom, so this had never surfaced - not a Round 18
  regression, a bug that predates this round entirely and was only caught
  because this round's own new feature depended on that fetch actually
  succeeding. Fixed by splitting it into `liveScoreboardUrls` (plural) -
  two single-date requests, merged - matching the exact same one-date-at-
  a-time convention match-builder.mjs's own `fetchTeamLeagueMatches`
  already uses for its full-window build fetch, for the identical reason.
  This means MLB/NBA/EPL score/odds-spread refresh and the live-duration
  correction (`estimateLiveDurationMinutes`) had likely never actually
  updated mid-game in production before this fix either, on top of never
  supplying `.live` detail - re-verified live post-fix: real score/inning
  updates now land correctly for both real live games above.

- **A second, smaller real bug, exactly the reported symptom**: "match
  without odds yet should not leave the blank space with 「奪冠機率」".
  `.match-odds-outright`'s own `display: flex` rule has the SAME cascade
  specificity as the UA stylesheet's `[hidden] { display: none }` and wins
  by cascade order (author beats user-agent at equal specificity), so
  `outrightEl.hidden = true` (buildMatchCard's own default, no market open
  yet) rendered as a visible empty flex row with just the "奪冠機率" label
  and nothing after it - confirmed via `getComputedStyle(...).display`
  before (`flex`) and after (`none`) the fix. `.match-odds` had the exact
  same latent bug (not separately reported, but the identical shape) and
  got the identical fix. This project had already hit and fixed this once
  before, for `.match-watch` (see that rule's own comment) - both new
  fixes cite it directly rather than re-deriving the explanation.

  9 new tests (public/lib/espn.mjs's own `extractLiveUpdates`'s baseball
  `situation` handling, `extractF1LiveUpdates`, and `liveScoreboardUrls`'s
  own two-single-dates-not-a-range shape) - 324/324... then 326/326 once
  `liveScoreboardUrls` itself got a direct test too.

## Round 19 (2026-09-21): fetch efficiency, perceived load time, a real live-status flicker bug, and icon-based live widgets

Direct follow-up feedback on Round 18's own live-detail feature: "improve
efficiency... fetch only necessary data and other stay in cache... the live
states is slow, sometimes showing then disappear again, also show live
states using images instead of flat line of text". Four real, separate
findings, not one:

- **A genuine flicker bug, exactly the reported symptom**: `mergeFreshMatches`
  (`public/app.js`) unconditionally overwrote an existing match object with
  the fresh one `buildMatches()` just returned, on every single near-term
  (60s) AND full-window (5min) tick. `buildMatches()` itself never sets
  `.live` at all (only `pollLiveMatches`'s own independent 30s tier does) and
  always recomputes `durationMinutes` from the sport's PRE-GAME estimate, not
  the live-corrected one - so every 60 seconds, the live status widget was
  wiped back to nothing and the schedule-blocking duration snapped back to
  its pre-game guess, until the next live poll (on its own unrelated 30s
  timer, so up to 30s of visible gap) put both back. Confirmed live via
  Playwright, watching a real live MLB game (Brewers @ Orioles) across a
  near-term refresh boundary before the fix: the widget genuinely blinked
  off and back on every ~60s. Fixed by having `mergeFreshMatches` carry
  `previous.live` and `previous.durationMinutes` forward onto the fresh
  object whenever the fresh one isn't already reporting the match finished -
  re-verified live post-fix: the same widget stayed continuously visible
  across the same refresh boundary with no gap.

- **Real, measured over-fetching, not just a hunch**: instrumenting a
  counting `fetchJson` showed the near-term tier (`daysAhead=2`) making 18
  real upstream requests per 60s tick and the full-window tier
  (`daysAhead=14`) making 57 per 5min tick - roughly 1,080 + 684 = ~1,764
  requests/hour from these two tiers ALONE on a single open tab, before
  live-poll's own load is even added - about 3x `jaypengx-collab/shared-
  proxy`'s own `SPORTS_PROXY_RATE_LIMIT` (600/hr per IP), with zero caching
  anywhere to absorb any of it. The single biggest source of waste: on
  every page load, `refreshNearTerm()` runs, then `refreshFullWindow()`
  runs immediately after - and full-window's own date range is a strict
  superset of near-term's, so it re-requested the exact same today/tomorrow
  scoreboard URLs near-term had just fetched seconds earlier. Fixed with two
  independent caching layers rather than one, since they solve different
  halves of the problem:
  - An in-tab cache (`proxyFetchJson` in `public/app.js`) - same-URL
    responses cached in memory for `PROXY_FETCH_CACHE_TTL_MS` (45s), with
    concurrent identical calls coalesced into one in-flight request. This
    alone eliminates the near-term/full-window overlap on every load.
    Deliberately NOT applied to `pollLiveMatches`'s own direct fetches -
    that tier needs a genuinely fresh request every 30s.
  - A shared edge cache (`SPORTS_PROXY_CACHE_TTL_SECONDS`, 20s, in
    `jaypengx-collab/shared-proxy`'s `worker.js`) - caches every successful
    upstream response keyed by the upstream URL alone (never by viewer/IP),
    so concurrent viewers - and this tab's own live-poll tier, which the
    in-tab cache above doesn't touch - share one real upstream fetch. A
    cache hit skips the rate-limit check entirely, since it costs the
    upstream API nothing.

- **Perceived load time on a slow connection**: nothing painted at all
  until `refreshNearTerm()`'s own ~18 requests all resolved, every single
  visit, even though this same browser had almost certainly already built a
  match list minutes ago. Added an instant-paint snapshot: the last
  successful build is cached to `localStorage`
  (`matchfind-match-snapshot`, `.live` stripped since it would already be
  stale/wrong by the next load) and painted immediately in `init()`, before
  the real refresh even starts, discarded if older than
  `MATCH_SNAPSHOT_MAX_AGE_MS` (30 minutes). Measured live via Playwright on
  the same machine: 1,911ms to first `.match-card` cold vs. 297ms warm
  (snapshot) on a page reload - real APIs, real network, not a synthetic
  benchmark.

- **Live status as icons, not a flat text line**: `buildLiveStatusNode`
  (`public/app.js`) replaces the old plain-text
  `baseballLiveLine`/`basketballLiveLine`/`soccerLiveLine`/`f1LiveLine`
  functions with real DOM widgets - a small SVG diamond for MLB (a dot at
  each of 1st/2nd/3rd that lights up green exactly when `situation` reports
  a runner there, same shape a TV broadcast graphic already uses) plus an
  outs indicator and ball-strike count; a pulsing live dot for NBA/EPL; a
  colored flag icon for F1 (green/yellow/red/safety-car/checkered, read
  from ESPN's own status text, with the two caution flags animated to flash)
  next to the lap count. F1's own top-3 running order
  (`f1LeaderboardNode`) became a row of medal-colored rank chips
  (gold/silver/bronze) instead of a flat "1. Name 2. Name" sentence. Every
  SVG is a fixed, hardcoded shape (only booleans/which-CSS-class ever vary)
  built via the same `innerHTML`-from-template-literal pattern
  `SPORT_ICONS`/`buildSportIcon` already used elsewhere in this file - never
  user-supplied text, so this isn't a fresh injection surface.

Verified live via the same Playwright network-relay harness Round 18
established (`page.route('**/sports-proxy*', ...)` relayed through Node's
own real `fetch()`): the diamond/outs/count widget rendered correctly
against a real live MLB game (confirmed visually - runner on 2nd lit green,
1st/3rd unlit, "第 6 局上", 0 outs, "3–2" count), the flicker was gone
across a real near-term refresh boundary, and the instant-paint snapshot's
297ms-vs-1,911ms improvement was measured directly, not estimated. No
regressions - full suite still 326/326.

## Round 20 (2026-09-21): live status widgets still lagged the rest of the card by up to 30s

Direct follow-up: "why it take quite a few seconds after loading in to show
the live states". Traced to `scheduleLivePoll` (`public/app.js`): it
`setTimeout`s for `LIVE_POLL_INTERVAL_MS` (30s) BEFORE ever calling
`pollLiveMatches` for the first time - a "wait, then run, then reschedule"
shape, not "run, then wait, then run again". Since `match.live` (everything
`buildLiveStatusNode` renders - the diamond/flag/pulsing-dot widgets Round
19 added) is only ever set by `pollLiveMatches`, nothing else on the page
could make it appear any sooner than 30 seconds after load, no matter how
fast the rest of the card (teams, score, odds) painted. Fixed by also
calling `pollLiveMatches()` once, unblocked, immediately in `init()` -
right before entering the recurring `scheduleLivePoll` timer loop - so the
FIRST poll happens as soon as the initial match list is loaded instead of
30 seconds later. Measured live via Playwright: first `.live-chip` now
appears ~2s after the first `.match-card` (5.4s from navigation) instead of
the ~25-30s gap measured in Round 19's own flicker test. Full suite still
326/326.

## Round 21 (2026-09-21): the actual score was never shown while a match was live

Direct follow-up: "I think the live state is not being updated consistently
after shown and it's not showing current scores but only states". Checked
both halves separately:

- **Real bug, exactly as reported**: `team-row-template`
  (`public/index.html`) had no element for a score at all - `.team-side`,
  `.team-logo`, `.team-name-en`, `.team-name-zh`, nothing else.
  `match.competitors[].score` was fetched, live-polled, and updated in
  memory correctly the whole time; it just had nowhere on the page to
  render. Round 19's own live-status widget (the diamond/flag/pulsing-dot)
  only ever showed in-progress DETAIL (inning, quarter, lap) - genuinely
  never the score itself, which is exactly the "only states" the report
  named. Fixed by adding a `.team-score` element per team row, shown only
  while `isCurrentlyLive || match.isFinished` (never pre-game, where
  ESPN's own "0" isn't a real score yet) - `buildMatchCard` now computes
  `lifecycle`/`isCurrentlyLive` once, up front, and reuses it for this,
  the live-status widget, and the `.is-live`/`.is-finished` class toggle,
  rather than three separate call sites each re-deriving it.
- **"Not updated consistently"**: watched a real live MLB card for a full 4
  minutes (24 samples, one every 10s) via the Playwright network-relay
  harness. The inning progressed correctly and in real time (第 7 局上 →
  中 → 下) and the score held steady at the correct 3-0 the whole time (no
  runs scored in that span, confirmed against the same real ESPN data) -
  no dropped ticks, no regressions, nothing reverting backward. Found no
  actual update-delivery bug in this run; the likely explanation is that
  this perception was simply downstream of the score bug above - with no
  number to check against and only an inning/quarter changing every couple
  of minutes, there was nothing to visibly confirm the page was still
  live-updating at all.

Live-verified post-fix (Playwright, same real Brewers @ Orioles game): the
score rendered correctly (3-0) on the live card, correctly on two separate
already-finished cards (7-2, 3-4), and stayed hidden on every pre-game
card. Full suite still 326/326.

## Round 22 (2026-09-21): foreground-return refresh, an update countdown, dropping the ball/strike count, F1 driver flags, and per-sport live coverage for real

Six requests in one batch, since no game was actually live at request time
(MLB is in-season but nothing in progress at the moment this was worked) -
every claim below was verified with fabricated-but-real ESPN payloads (a
real event, cloned and mutated only in `status`/`score`/`date`, never
hand-typed from scratch) through the same Playwright network-relay harness
prior rounds used, plus screenshots, rather than left unverified because
"nothing's live right now".

1. **Foreground-return refresh**: every refresh timer (`scheduleNearTermRefresh`/
   `scheduleFullRefresh`/`scheduleLivePoll`, `public/app.js`) already
   reschedules itself on its own fixed interval even while the tab is
   hidden - it just skips the fetch each tick. A tab backgrounded for
   several minutes and brought back got nothing fresher until whichever
   timer next happened to fire, by accident of when it was hidden - reads
   as "doesn't notice I came back". Added a `visibilitychange` listener
   that tracks how long the tab was actually hidden and, once it's visible
   again, forces an immediate near-term refresh + live poll (and the full
   window too, if the tab was away at least as long as `FULL_REFRESH_MS`
   itself) - but only past `FOREGROUND_STALE_MS` (30s) away, so a quick
   app-switch-and-back doesn't double up on a refresh that just ran.
   Live-verified via Playwright (`document.visibilityState` + a dispatched
   `visibilitychange` event): 0 proxy calls while hidden, 0 calls within 2s
   of a return from a SHORT (5s, under threshold) backgrounding, and 3
   calls within 44ms-364ms of a return from a 35s backgrounding.
2. **"Next update" countdown**: added `#next-update-note` (footer,
   `public/index.html`) ticking down every second to the soonest of the
   three refresh tiers' own next-scheduled instant (live poll only counted
   while something's actually worth polling - no reason to dangle a
   countdown for an idle no-op tick). Each `scheduleX` function now stamps
   its own `nextXAt` the moment it (re)arms its timer, including from
   `handleForegroundReturn` above, so this can never drift from what's
   actually scheduled.
3. **Dropped the ball/strike count**: `baseballLiveNode` used to show
   ESPN's own `situation.balls`/`.strikes` (e.g. "2–1") next to the
   diamond. Reported directly as useless: the count changes on every
   single pitch (seconds apart), so a fixed 30s `LIVE_POLL_INTERVAL_MS`
   tick almost never catches the CURRENT count, only a stale one from up to
   half a minute ago. Removed; outs/baserunners/inning stay, since those
   change on an at-bat-scale cadence this refresh rate actually keeps up
   with. Live odds were already refreshed on every poll tick regardless of
   lifecycle state (`matchWorthPollingNow` already returns true for
   LIVE/ENDING_SOON) - re-verified, no change needed there.
4. **F1 driver flag icons**: `extractF1LiveUpdates` (`public/lib/espn.mjs`)
   now also reads each leaderboard driver's `athlete.flag` (a small
   nationality-flag image ESPN already serves) - there is no headshot and
   no constructor/team field anywhere in this API (checked against several
   real race weekends, finished and upcoming), so a flag is the one real,
   non-fabricated per-driver visual available, rather than a generic
   silhouette that wouldn't actually distinguish drivers. Rendered as a
   small `<img>` in each `live-leaderboard-chip` (`f1LeaderboardNode`,
   `public/app.js`).
5. **F1 interval/gap**: investigated whether ESPN's F1 scoreboard ever
   reports a live gap-to-leader. `competitor.statistics` came back an empty
   array `[]` on every real event checked - multiple different race
   weekends, both finished races and ones several days out - suggesting
   this level of live-timing detail may not be something ESPN's public
   site API exposes at all (likely exclusive to F1's own timing feed).
   Added best-effort, defensive extraction (`f1DriverInterval` reads
   `competitor.statistics` for a GAP/INTERVAL/TIME-abbreviated stat if one
   ever shows up) so this picks it up automatically the moment ESPN does
   report it, without guessing or fabricating a number now. F1's own
   flag-status detection (safety car/red flag/yellow, `f1FlagKey`) was
   already in place from Round 19 - unchanged, re-verified with a
   fabricated "Lap 23/53 - Safety Car" status.
6. **Per-sport live coverage, confirmed with fixtures**: since nothing was
   actually live, built `build_fixtures.mjs` (scratch, not committed) that
   clones one real event per sport from ESPN's real scoreboard and mutates
   only status/score/date to look live right now, then served those
   through the same Playwright route-relay harness. Confirmed against real
   rendered screenshots: MLB shows score + diamond/bases + outs (no
   ball/strike count, see above); NBA shows score + quarter + `displayClock`
   (already just ESPN's own last-reported clock text, never locally
   ticked, so it already "stops at the exact recorded time until update" as
   requested); EPL shows score + `displayClock` including ESPN's own
   stoppage-time notation ("45'+2'" rendered correctly, unchanged code -
   ESPN already includes stoppage minutes in this field); F1 shows lap,
   flag-colored status, and a top-3 leaderboard with flags. Full suite
   still 327/327 (2 existing F1 leaderboard-shape assertions updated for
   the new flagUrl/flagAlt/interval fields, 1 new test added covering that
   extraction).

## Round 23 (2026-09-21): a historic-rivalry bonus and an already-decided division race both overriding a real blowout

Direct follow-up to a live validation pass: rebuilt real `matches.json`
(`node scripts/build-data.mjs`) and ran the actual engine
(`scripts/dump-day-plan.mjs`, TZ=Asia/Taipei) against it for 2026-09-22
through 2026-10-05, then cross-checked the picks against REAL, live 2026
MLB standings (fetched directly from the MLB Stats API) and two web
searches for F1's own calendar. Every pick held up except one, caught live:
2026-09-26 recommended **Dodgers @ Giants** (watchability=10, the max) over
a genuinely live AL West race elsewhere that night. Real standings at the
time: Dodgers 96-60, already clinched the NL West; Giants 64-92, 32 games
back - a decided, lopsided blowout by any real measure.

Root cause was two SEPARATE signals compounding, not one:
1. `isRivalry` (Dodgers-Giants sits on `MLB_RIVALRY_PAIRS`) added its flat
   +2 watchability bonus purely from the two teams' NAMES, with no check
   on whether tonight's specific pairing was still actually close.
2. `playoffProximityScore` reads a division LEADER's own `gamesBack` as 0 -
   a perfect 10 "stakes" reading - identically whether that lead is a
   nail-biter or (as here) a 30+ game runaway, since it only ever sees this
   ONE team's own distance to a spot it already has, never the size of its
   actual cushion.

Fixed in `public/lib/objective-score.mjs` with two guardrails, deliberately
NOT identical across sports:
- **`MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS` (= 3), applied in ALL
  THREE of MLB/NBA/EPL**: whatever stakes/a marquee bonus independently
  read, neither can lift final watchability more than 3 points above
  tonight's own `competitiveness` - the one signal that actually looks at
  the CURRENT pairing rather than a name or a standing that may already be
  a foregone conclusion.
- **`MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS` (= 6), MLB'S RIVALRY BONUS
  ONLY**: the rivalry bonus itself doesn't fire at all below this
  competitiveness floor. Deliberately NOT applied to NBA's rivalry/
  national-broadcast bonus or EPL's derby/big-club bonus - both of those
  sports have no standings-API integration yet (see this doc's own "Known
  limitations"), so a low competitiveness there can still be early-season
  sampling noise a genuinely elite/big club should survive (the exact
  Liverpool @ AFC Bournemouth case Round 17 added the big-club bonus for -
  confirmed this doesn't regress via the existing test suite). MLB alone
  has a long enough season and real standings signal to trust that a wide
  win% gap this late really does mean decided, not noisy.

Live-verified after the fix (same rebuild + dump-day-plan run):
Dodgers/Giants' watchability dropped 10 → 8, its `match.score` dropped
6.65 → 5.95, and it NO LONGER gets recommended for 2026-09-26 - Angels @
Mariners (a team still mathematically alive in the AL West/wildcard race)
takes the slot instead. Every other pick across the full 2026-09-22 to
2026-10-05 window (Rays/Yankees, Padres/Dodgers, both Astros picks, both
Phillies picks, both F1 sessions, both NBA preseason picks) is byte-for-
byte unchanged - this narrowly targets the one real failure, nothing else.
Full suite 327/327 (one existing EPL big-club test conflicted with an
overly-broad first draft of this fix that gated ALL THREE sports the same
way - narrowed to MLB-only per the reasoning above, test passes unchanged).

**Follow-up same day**: a requested final validation pass re-scanned the
whole rebuilt window for any OTHER "low competitiveness, high watchability"
case the cap above only softened rather than actually fixed, and found one:
Brewers @ Cardinals (Brewers 98-58, MLB's best record, already clinched;
Cardinals 76-80, 22 games back) - not a rivalry pair at all, so the
MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS gate never touched it, and the cap
alone still let it reach watchability=8 purely from `playoffProximityScore`
reading the Brewers' own gamesBack=0 as a perfect stakes=10, same root
cause as the Dodgers/Giants case - a cap that only limits the SYMPTOM
(how far watchability can be pushed) rather than the actual miscalibrated
signal (stakes) leaves every other division-leader-vs-non-contender
blowout still inflated up to that same ceiling.

Fixed at the root instead: `parseMlbStandingsResponse`
(`public/lib/sport-signals.mjs`) now computes each division's real
`divisionLeadMargin` for its leader specifically - the runner-up's own
`gamesBack` (already present in the same standings response, no second
fetch needed), which IS the number a leader's own `gamesBack: 0` can never
show on its own. `playoffProximityScore` (`public/lib/objective-score.mjs`)
now discounts a leader's stakes by that real margin using the same
0.8-point-per-game slope it already uses for a team chasing from behind
(floored at 2, never all the way to 0 - a leader always keeps SOME real
stakes: a magic number, a division title/seeding to protect), instead of
reading gamesBack=0 as an automatic, undifferentiated 10.

Live-verified against the same real rebuild: Dodgers/Giants' watchability
dropped further to 5 (proximity 3/0, from a real 9-game Dodgers division
cushion); Brewers/Cardinals dropped to 4 (proximity 2/2, floored - a
20+ game laugher). A follow-up scan of the full rebuilt window found ZERO
remaining MLB matches with competitiveness ≤5 and watchability ≥7 (down
from 6 before this fix, including the two above). Every other pick across
the full 2026-09-22 to 2026-10-05 window is either unchanged or reshuffled
only among already-legitimate playoff-race candidates (e.g. 9/23 shifted
from Rays/Yankees to Guardians/Red Sox - both real, both fine). Added
5 new tests (`playoffProximityScore`'s margin discount/floor,
`parseMlbStandingsResponse`'s new `divisionLeadMargin` field) - full suite
333/333.

**Known, accepted limitation, not fixed**: 2026-09-28 (Taiwan calendar day)
still recommends nothing at all - every real MLB game bucketed there is a
Sunday US day-game (a real "getaway day" scheduling pattern), landing
03:05-03:20 Taiwan time, squarely inside the 00:00-05:00 quiet-hours
window. This is the system telling the truth (there is genuinely no MLB
game worth a reasonable Taiwan viewing hour that calendar day), not a bug
to route around - loosening quiet hours to fill the gap would violate the
Taiwan-time rule specifically to avoid an empty day, which is backwards.
