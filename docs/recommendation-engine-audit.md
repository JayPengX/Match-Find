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

## Round 24 (2026-09-21): NBA and EPL get the same standings-integration depth MLB already had

Direct follow-up to Round 22/23's own MLB fix - user's own words: "we
currently only optimized it for MLB... optimize for EPL and NBA also, it'd
equally important." MLB's `computeMlbObjectiveScore` had real division/
wild-card proximity, last-10 form, and streak momentum from the MLB Stats
API; NBA and EPL had none of that at all - just season record + odds +
the rivalry/derby/national-broadcast flags. Built the same depth for both,
from ESPN's own `/standings` endpoint (a host this build already fetches
from for the scoreboard, so no new dependency or proxy-allowlist change):

- **NBA** (`public/lib/sport-signals.mjs`'s `parseNbaStandingsResponse`):
  ESPN's own `/apis/v2/sports/basketball/nba/standings` gives, per team,
  `wins`/`losses`, a `streak` in the SAME "W3"/"L2" notation the MLB Stats
  API already uses (directly reusable by the existing `streakMomentum`),
  and a `Last Ten Games` split record (directly reusable by
  `closenessFromLastTen`) - confirmed against a real historical (2024-25)
  response, since the CURRENT 2026-27 season is still in preseason.
  Computed a NEW signal ESPN doesn't hand over directly: each team's own
  signed distance to its conference's 6-seed (direct playoff berth) and
  10-seed (last play-in spot) cutoffs, from wins/losses already in the
  same response - the standard sports "games back between two records"
  formula, applied to a specific CUTOFF rather than MLB's own
  division-leader/wild-card shape.
- **EPL** (`parseEplStandingsResponse`): ESPN's own
  `/apis/v2/sports/soccer/eng.1/standings` gives real league POINTS (not
  derivable from `parseOverallRecord`'s coarser win/loss/draw split) and
  rank. No streak/last-5 field exists in this response at all (checked
  against a real live response) - a genuine, stated gap, not silently
  worked around. Computed the same kind of new cutoff-distance signal as
  NBA, in POINTS instead of games: each team's own signed points gap to
  the Champions League line (top 4) and the relegation line (bottom 3 of
  20) - EPL's first real stakes signal ever, verified against a real live
  response (a genuine early-season relegation six-pointer, Fulham/Coventry
  City, scored a real, high watchability=10 once wired through
  `computeEplObjectiveScore`, something the old win%-only formula had no
  way to see).

**New shared building block**: `cutoffProximityScore` (`public/lib/objective-score.mjs`)
generalizes `playoffProximityScore`'s own discount logic (see Round 23) to
a SIGNED gap against any specific cutoff, symmetric around 0 - a team
comfortably clear of a cutoff is discounted the same way a team hopelessly
short of one already was, rather than every "ahead of the line" reading as
an undifferentiated maximum. NBA's seed gaps and EPL's points gaps (divided
by `EPL_STAKES_UNIT_POINTS = 3`, a win's worth, to approximate an
equivalent game count) both feed through this same function.

**A real bug caught before shipping, same failure class as Round 23's
own**: NBA's 2026-27 season is still in preseason - every team reads 0-0.
Before adding a guard, this scored a maxed-out `playoff-seed proximity
10/10` for literally every preseason exhibition on the schedule (every
team's own win-loss differential is 0, which read as "tied exactly on the
cutoff" - the same "0 games played is a real no-signal case, not a genuine
0.000-average tie" mistake Round 22's own MLB fix targeted, just for a new
signal). Fixed with a `seasonStarted` guard in both
`parseNbaStandingsResponse` and `parseEplStandingsResponse` - if NO team in
the whole conference/league has played a game yet, every gap is left
`null` rather than a false 0; a team that individually hasn't played (even
once the rest of the league has) also gets `null`, never a guessed value.
Re-verified against a fresh real rebuild: all 3 current (preseason) NBA
fixtures correctly show `competitiveness: 5, watchability: 5, factors: []`
- neutral, no fabricated signal - instead of the false 10/10 reading.

**Live-verified, end to end**: rebuilt real `matches.json` and confirmed
the picked lineup for 2026-09-22 through 2026-10-05 is BYTE-FOR-BYTE
IDENTICAL to before this round - expected, since the only currently-active
NBA fixtures are preseason (correctly near-signal now, same as before) and
the only EPL fixtures in the fetched window are already-finished (an
international break has no upcoming EPL games at all right now - see
Round 22). The new code is real, tested, and wired end-to-end, but has
nothing to change YET; it activates automatically once the real NBA season
starts and EPL fixtures resume, without needing another deploy. Directly
exercised the new scoring paths with realistic hand-built and real-
historical-data cases (a real 2024-25 NBA play-in bubble race, a real
current-EPL relegation six-pointer, a real current-EPL top-4 race, and a
blowout in each sport still correctly capped by
`MAX_WATCHABILITY_LIFT_OVER_COMPETITIVENESS`) - see this round's own
session log. 18 new tests added across `objective-score.test.mjs`/
`sport-signals.test.mjs`, full suite 351/351.

## Round 25 (2026-09-21): a batch of 7 direct reports - variety removed, a real Polymarket coverage bug fixed, NBA preseason dropped, and a live-time investigation of "10-20 second" refreshes

Seven items reported together in one message; each is its own real fix, not
a single theme, so this round covers all seven distinctly.

**1. Polymarket coverage: 50 of 91 real upcoming MLB fixtures had no odds
at all, and F1 Qualifying never had any.** Root cause, confirmed live: the
Gamma API's own `/events` endpoint caps a single request at 100 regardless
of the `limit` param (silently truncated), and MLB alone had 170 currently-
open events for its tag - not one event per game, but a SEPARATE event for
many games' own `-player-props`/`-first-five-winner`/`-inning-9-winner`
sub-markets too. The existing code sorted by `order=startDate` (when
Polymarket itself CREATED the listing, confirmed to differ from the real
game time) rather than `order=startTime` (the fixture's own real kickoff),
so which 100 of 170 events actually got fetched was essentially arbitrary
relative to which games were happening soonest. Fixed by switching to
`order=startTime` and adding `fetchAllPolymarketEvents` (paginates via
`offset` past the 100-cap, capped at 5 pages as a runaway-loop guard) in
both `match-builder.mjs` (build-time) and `app.js` (the live poll tier).
Re-verified live: MLB's own missing-odds count dropped from 50/91 to 15/91
- confirmed those remaining 15 (all 2026-09-27 games, 6 days out) have
genuinely NO Polymarket market open yet at all, not a fetch bug. Separately,
F1 Qualifying never got odds because `enrichWithPolymarketOdds` only ever
looked for a race-winner market - Polymarket actually runs a SEPARATE
"Driver Pole Position" outright market for Qualifying (same per-driver
Yes/No shape, confirmed live), keyed to the Qualifying session's own real
UTC date, not the race's. Added `findPoleWinnerEvent`/`resolvePoleWinnerOdds`
and wired both session types (`-race`/`-qual` id suffixes) into both the
build-time and live-poll paths; the outright-odds aria-label now also says
"桿位機率" instead of always "奪冠機率" for a Qualifying card. 12 new tests.

**2. "Variety" removed entirely from the recommendation scheduler.** Direct
feedback: this viewer mostly doesn't watch on weekdays at all, so the old
cross-day matchup-repeat penalty and same-sport-concentration penalty
(`applyRecentRepeatPenalties`, Rounds 2/14) were comparing today's best
game against whatever won a weekday slot he never actually watched, and
burying a genuinely great weekend game for a "variety" benefit that never
applied to him. Removed `RECENT_REPEAT_PENALTY_BY_GAP_DAYS`/
`recentRepeatPenalty`/`SPORT_CONCENTRATION_*`/`sportConcentrationPenalty`/
`VARIETY_TIEBREAK_FACTOR`/`daysBetweenDayKeys` entirely; `planningScore` is
now exactly `effectiveScore` plus the (unrelated, kept) live-match
excitement bonus, via the renamed `applyLiveExcitementBonus`. This also let
`computeWindowPlan` drop its whole chronological-history bookkeeping
(`historyByDayKey`/`recentPicksByDayKey`/`lastRecommendedDayKey`) - each day
is scored independently now, since there's no more cross-day penalty to
feed. `computeSportConcentration`/`matchupKey` stay as pure diagnostics
(still used by `scripts/evaluate-recommendations.mjs`'s own report), just
no longer wired into any scoring decision. Live-verified: San Diego Padres
@ Los Angeles Dodgers now correctly stays recommended 3 days running
(2026-09-23 through 09-25) on its own merits, no longer needing the old
tie-break-toward-variety logic to lose the coin-flip it used to.

**3. NBA preseason games removed entirely, not just excluded from 推薦賽
事.** Direct feedback: 愛爾達體育台 (this app's real Taiwan broadcast
source) doesn't air NBA preseason exhibitions at all, so a fixture no
viewer can actually watch through this site's own `whereToWatchTw` answer
has no business appearing anywhere on it. ESPN's own `event.season.type`
is `1` for the preseason (confirmed live against a real 2026-27 preseason
fixture: `season.type: 1, season.slug: 'preseason'`), `2` for the regular
season, `3` for the postseason (already used for `isPostseason`) - added a
skip for `season.type === 1` right alongside the existing TBD-competitor
skip in `fetchTeamLeagueMatches`, general to all three team leagues (not
NBA-special-cased) since the same "not actually broadcast" reasoning holds
for a hypothetical MLB spring-training fixture too. Live-verified: all 3
real 2026-27 NBA preseason fixtures that used to appear disappeared
entirely from a fresh rebuild.

**4. Overlap note no longer names an arbitrary non-recommended match.**
`buildMatchCard`'s "與「X」重疊 N 分鐘" note used to fall back to whichever
earlier-overlapping match happened to sort first when none of them were
actually recommended - direct feedback: this should only ever compare
against a match actually worth watching (推薦 or a viewer's own 偏好 pin,
which is always a subset of 推薦 - see `computeDayPlan`'s `forcedIds`),
never a random unrecommended neighbor. Simplified `earlierOverlaps`'
filter to require `m.recommended`, with no fallback - a card whose only
overlaps are unrecommended fixtures now shows nothing at all, rather than
a comparison nobody asked for.

**5/6. Investigated a live-reported "updating data takes 10-20 seconds,
sometimes more, sometimes less" as one combined issue** (both reports
describe the same symptom - how long/how consistently a refresh takes, not
a separate fixed schedule). Direct timing of `buildMatches` against the
REAL deployed Shared-Proxy Worker from this sandbox came back fast and
consistent (~1.3-2.4s, 57 requests) - not reproducible here, since this
environment's own network path to the Worker has neither the per-request
latency nor the packet loss a real mobile connection would. Found and
fixed two real, provable structural issues anyway, both of which directly
predict exactly the reported symptom (a variable worst case bounded by
"whichever one of 50+ concurrent requests happened to be slow this
cycle"):
  - `buildMatches` had two pairs of independent work awaited in fully
    SEPARATE serial stages for no reason: the 3 team leagues' own fetch was
    awaited to completion before F1's fetch even started, and
    `enrichWithPolymarketOdds` was awaited to completion before the
    standings/F1-title-race fetch even started - 4 serial round-trip
    stages where 2 would do, since within each pair neither result depends
    on the other. Merged each pair into one `Promise.all`.
  - The Shared-Proxy Worker's own `/sports-proxy` route (jaypengx-collab/
    shared-proxy) let a single cache-miss upstream request hang for up to
    15 seconds (`AbortSignal.timeout(15_000)`) before giving up - since
    every caller already treats a failed/slow sports-proxy request as "no
    data for this one" (a `.catch`/`Promise.allSettled`, never a fatal
    error), this 15s ceiling was pure unbounded worst-case latency with no
    correctness benefit. Cut to `SPORTS_PROXY_UPSTREAM_TIMEOUT_MS = 8_000`
    (ESPN's own scoreboard responds in well under 1s normally, confirmed
    live) - directly caps the worst any single one of 50+ concurrent
    requests can cost a refresh. Also added a matching client-side
    `PROXY_FETCH_TIMEOUT_MS = 12_000` in `app.js`'s own `proxyFetchJson`/
    `proxyFetchJsonUncached`, bounding the client→Worker leg the Worker's
    own timeout can't cover. **Caveat, stated plainly**: the exact reported
    10-20s figure could not be reproduced or independently confirmed from
    this sandboxed environment - these are real, verified structural fixes
    (fewer serial stages, a bounded worst-case latency) rather than a
    measurement showing the reported number specifically improved.

**7. Manual "立即重新整理" now also checks for a newer deployed version of
the page itself**, not just fresh match data - direct feedback framed as
"the PWA... has new push [update]". This site has no service worker at all
(`manifest.webmanifest` only makes it installable) and no build step to
stamp a version number into anything, so there's no service-worker update
lifecycle to hook into. Used GitHub Pages' own real, reliable per-file
ETag/Last-Modified (confirmed live) instead: `app.js`'s own marker is
snapshotted once at load (`captureAppVersionBaseline`, fire-and-forget,
never blocking startup) and re-checked with a fresh `cache: 'no-store'`
HEAD request every time the refresh button is pressed
(`checkForNewAppVersion`) - a genuine difference reveals a second "發現新
版本，點此重新載入" button that does a real `location.reload()`, the only
way to actually replace a page's own running JavaScript.

Full suite 350/350 (the net change from 351 reflects Round 24's variety-
mechanism tests being replaced by simpler ones that assert the SAME
scenarios are no longer penalized, per item 2 above, plus 12 new Polymarket
tests). Committed and pushed to both branches of Match-Find; the Shared-
Proxy timeout change was also committed and pushed to both its branches -
that repo has no deploy automation (see its own README), so it needs a
manual redeploy (paste `worker.js` into the Cloudflare dashboard) before
the shorter timeout actually takes effect in production.

**Correction, made in Round 26 below**: that last sentence was wrong.
Shared-Proxy *does* have real deploy automation
(`.github/workflows/deploy.yml`, Wrangler via CI on every push touching
`worker.js`/`wrangler.toml`) - confirmed after the fact by checking that
workflow's own run history, which showed the Round 25 timeout commit had
already deployed successfully on push, no manual dashboard step needed.
Round 26 also found the actual dominant cause behind this same "10-20s,
inconsistent" complaint, which the serial-fetch-stage and timeout fixes
here were real but insufficient explanations for.

## Round 26 (2026-09-21)

Two more direct reports, given together: (1) "New push should wipe local
cache so new data can build properly", and (2) the first-load blank period
(reported as 10+ seconds) was called out again as still bad, with a
specific hypothesis attached this time - "Could be proxy set in North
America previously to prevent Gemini API being blocked, but I doubt this is
the only reason."

**1. New-deploy cache invalidation.** `public/app.js`'s own instant-paint
snapshot (`matchfind-match-snapshot` in `localStorage` - see Round 22/23's
own notes, or the README's "Live match data and manual refresh" section)
gets painted to the screen BEFORE this load's own real fetch has run at
all. That's fine as long as the snapshot's own shape still matches what the
CURRENTLY RUNNING code expects - but a snapshot saved by a previous deploy
could, in principle, predate a field rename or a newly-required field this
deploy's own rendering code now assumes is always there, painting something
broken (or throwing inside `applyFreshBuild`'s own try/catch) for however
long the near-term refresh takes to quietly correct it. Fixed by stamping
every saved snapshot with `APP_BUILD_ID`, a literal `'__BUILD_ID__'`
placeholder in the committed source that `deploy.yml`'s own new sed step
rewrites to that build's real commit sha in the GitHub Actions runner's own
working copy only (never committed back to git - same never-committed
pattern as the existing `?v=<sha>` cache-busting step for `app.js`/
`styles.css` in `index.html`). `loadMatchSnapshot` now discards (removes
from `localStorage`, not just ignores) any snapshot whose `buildId` doesn't
match the currently-running code's own `APP_BUILD_ID` - so the very first
load after any deploy always falls back to the normal from-scratch fetch,
same as a first-ever visit, rather than risking an incompatible instant
paint.

**2. The user's own hypothesis was right, and was the dominant cause.**
Re-read `jaypengx-collab/shared-proxy`'s `wrangler.toml` end to end rather
than re-measuring `buildMatches` again (Round 25's own sandboxed
measurements had already been unable to reproduce the reported magnitude,
which in hindsight was itself a clue rather than a dead end - see below).
That file pins `[placement] region = "gcp:us-east4"` (Virginia) - added,
per its own comment, specifically so `/gemini`'s outbound call to Google's
Gemini API wouldn't get run from Cloudflare's Hong Kong colo, which Gemini
refuses outright. **`[placement]` is a whole-Worker-*script* setting, not a
per-route one** - Cloudflare has no way to pin only some routes of a
multi-route Worker to a region while leaving others on the default
"run near whichever colo the request itself arrived at." Since
`/sports-proxy` (Match Find's own route) lived on that SAME shared Worker
as `/gemini`, it was being forced through that same Virginia isolate too,
for every single request, regardless of where the actual caller was.
Confirmed live with a plain curl against the deployed Worker:

```
$ curl -sI "https://orbit-workers-proxy.pengzjay.workers.dev/sports-proxy?url=..."
x-worker-colo: IAD
```

`IAD` (Washington Dulles / Ashburn, Virginia) on an ordinary `/sports-proxy`
call - not a Gemini call, not anything with a region restriction at all.
For a viewer in Taiwan, every one of Match Find's dozens of near-term/
full-window/live-poll requests per refresh was paying a full Taiwan↔
Virginia round trip on top of whatever the upstream API itself took,
regardless of Round 25's own fixes (fewer serial fetch stages, a shorter
upstream timeout) - both real, both still worth having, but neither one
touches a cost that exists on every request before either fix's own logic
even runs. This also explains Round 25's own stated caveat: a sandboxed
test of this same route from what is very likely a US-based environment
would already land near Virginia with nothing to gain from Smart
Placement-style rerouting, so the region pin's real cost was structurally
invisible from there - only a caller on the other side of the world would
ever see it, which is exactly what the live reports kept describing.

Fixed by splitting `/sports-proxy` out of the shared Worker entirely: a new
`sports-proxy-worker.js` (a copy of the route handler plus its own small
copy of the CORS/rate-limiting helpers - see that file's own top comment)
deployed as its own separate Cloudflare Worker via a second Wrangler config
(`wrangler.sports-proxy.toml`), deliberately with **no** `[placement]`
override at all, so Cloudflare's own default applies: run the isolate near
whichever colo actually received the request. `worker.js` keeps `/gemini`,
`/nl-edit`, `/sync`, `/vocab-sync`, `/vocab-ai` (all still correctly pinned
to `us-east4`) - none of Orbit Class/Orbit Vocab's own code needed to
change, since neither of those apps ever called `/sports-proxy`. Match
Find's own `PROXY_URL` constant in `public/app.js` now points at this new
Worker's own separate `*.workers.dev` URL rather than
`orbit-workers-proxy`'s. `.github/workflows/deploy.yml` (Shared-Proxy's own)
now runs two Wrangler deploy steps in the same job, one per config, so a
single push redeploys both Workers; confirmed live after pushing that both
steps succeeded and the new Worker actually serves real data
(`sports-proxy.pengzjay.workers.dev/sports-proxy?url=...` returned a real
15-event MLB scoreboard, `X-RateLimit-Backend: kv` confirming its own KV
binding - shared with `orbit-workers-proxy`'s own namespace, safe since
this route's rate-limit keys carry no `feature` prefix to collide with the
other Worker's `gemini:`/`sync:`/etc keys - deployed and working
correctly).

**Caveat, stated plainly, same as Round 25's own**: this sandboxed
environment cannot directly confirm the actual latency improvement a real
Taiwan-based viewer will see, for the same underlying reason Round 25
couldn't reproduce the original 10-20s figure - a request from here still
shows `X-Worker-Colo: IAD` against the NEW Worker too, most likely because
this environment's own network path already resolves near Virginia by
default even with no pin forcing it there, so there's nothing for removing
the pin to change from this vantage point. What's confirmed live is that
the pin itself is gone (no `[placement]` block in
`wrangler.sports-proxy.toml`, and the new Worker deploys/serves correctly)
- the real proof of the latency fix will be a real device in Taiwan seeing
a colo other than `IAD` and a materially faster refresh, which only the
site's actual user can confirm.

Full suite still 350/350 (no scoring/data-shape logic touched). Committed
and pushed to both branches of Match-Find and both branches of Shared-Proxy;
confirmed via the GitHub Actions API that Shared-Proxy's own CI run for
this change completed successfully (both Wrangler deploy steps green)
before Match Find's own `PROXY_URL` was pointed at the new Worker, so the
switch never risked a dead URL going live.

## Round 27 (2026-09-21)

Direct confirmation the Round 26 fix worked ("A lot faster now"), plus three
new reports in the same message: (1) add a loading indicator so the blank
period before first paint doesn't read as broken, (2) a fixture from 9/19
was still showing when today is 9/21 - only one day prior (Yesterday)
should ever be kept, and (3) a general ask for more performance work, both
client- and proxy-side.

**1. Loading indicator.** Before this, `#app`, `#empty-state`, and
`#error-state` in `index.html` all started `hidden` - so the gap before the
first real content landed (a first-ever visit with no instant-paint
snapshot yet, or one just wiped by `APP_BUILD_ID` right after Round 26's
own deploy - which, in hindsight, is almost certainly why this got noticed
right now) rendered as a totally blank page with zero indication anything
was happening. Added `#loading-state` (a spinner + "載入中…"), visible by
default (no `hidden` in the markup, unlike the other three), hidden inside
`applyFreshBuild` - the one function both the instant-paint snapshot and
every real refresh tier funnel through - so it disappears the instant
either has something to show; `init()`'s own total-failure branch (nothing
loaded at all, near-term fetch failed outright) hides it too, swapping in
`#error-state`'s explicit message instead of leaving a spinner spinning
forever over a page that's actually stuck.

**2. Retention cap: root-caused, not just re-worded.** The site's own
design already treats "昨天" (Yesterday, 1 day prior) as a real, intended
day - `dayLabelFor`'s own `diffDays === -1` case, and
`fetchTeamLeagueMatches`'s 2-UTC-day lookback margin exists specifically so
a US-evening MLB fixture that lands on the Taiwan viewer's own "yesterday"
actually gets fetched (see Round 11's own "Yesterday only shows Premier
League, no MLB" fix). The bug: nothing ever enforced the OTHER end of that
window. `mergeFreshMatches`'s own upsert-by-id (`byId` seeded from
`state.allRawMatches`, only ever added to or overwritten, never pruned)
meant a match fetched once - during that same 2-day lookback margin, or
just because "today" was closer to it on an earlier visit - stayed in
`state.allRawMatches`/the `localStorage` snapshot forever, regardless of
whether any CURRENT fetch's own window still includes it. `buildDayList`
then dutifully gives ANY day present in `matches` its own pill, past or
future, with no age check at all - so a two-plus-day-old finished fixture
could sit there indefinitely, showing up as its own day pill well past the
site's intended one-day design. Fixed with `MATCH_RETENTION_PAST_DAYS = 1`
and `isWithinRetentionWindow`, applied inside `mergeFreshMatches` itself
(the one choke point every merge - snapshot or real fetch - goes through):
a match whose LOCAL calendar day (via the new shared `daysFromToday`
helper, factored out of `dayLabelFor`'s own inline version) is more than 1
day before today is dropped from the retained set outright, not merely
hidden at render time. Verified: `daysFromToday` gives 9/19 vs. a 9/21
"today" as `-2` (dropped) and 9/20 as `-1` (kept) - exactly the Yesterday-
only boundary the site was always supposed to have.

**3. Performance, both sides.**

- **Client: skip fetching a disabled sport entirely.** `buildMatches`
  never had any concept of "which sports the viewer actually wants" - it
  always fetched all 3 team leagues plus F1, every single refresh tier,
  regardless of Settings' 已啟用的運動 toggles; only the RENDER step
  (`applyEnabledSportsAndRender`'s own `.filter`) ever excluded a disabled
  sport. A viewer who's turned 3 of 4 sports off was still paying for all
  four's ESPN/F1 fetches (and, transitively, their own Polymarket odds
  enrichment and standings fetches) on every tier, for data that could
  never appear on screen. Added an `enabledSports` param to `buildMatches`
  (a `Set` of `match.sport` labels; `null`/omitted still fetches
  everything, so `scripts/build-data.mjs`/`dump-day-plan.mjs`, which have
  no such concept, are unaffected) - `TEAM_LEAGUES` is filtered down to it
  before the fetch `Promise.all`, and the F1 fetch is skipped outright when
  `'F1'` isn't in the set. `enrichWithPolymarketOdds`'s and the standings
  fetches' own existing `hasActiveX`/`sportsNeeded` checks (both keyed off
  `matches`, which now simply won't contain a disabled sport) already skip
  those for free once the team-league fetch itself is skipped - no separate
  change needed there. `pollLiveMatches`'s own `sportsWorthPollingNow` reads
  `state.allRawMatches` too, so the live-poll tier benefits the same way.
  Wired into both `refreshNearTerm` and `refreshFullWindow` via
  `state.enabledSports`. One real trade-off this creates: re-enabling a
  sport means `state.allRawMatches` genuinely has zero fixtures for it
  until a fetch actually happens - handled by kicking off a fire-and-forget
  `refreshFullWindow({ silent: true })` right in the enable-toggle's own
  click handler, so it backfills immediately rather than waiting up to
  `FULL_REFRESH_MS` (5 minutes) for the next scheduled tier.
- **Proxy: stop serializing the KV rate-limit check ahead of the upstream
  fetch.** `sports-proxy-worker.js`'s `handleSportsProxyRequest`, on a cache
  MISS, used to `await isRateLimited(...)` (a Workers KV read) and only
  THEN start the actual upstream `fetch()` - a real round trip added to the
  front of every single non-cached request, previously invisible next to
  the [placement]-pin latency Round 26 removed, now proportionally a much
  bigger slice of what's left. Restructured to run the KV check and the
  upstream fetch concurrently via `Promise.all`, deciding what to do with
  each only once both resolve - a rate-limited request still never receives
  the fetched data (correctness unchanged), it just also costs one upstream
  call it wouldn't have before, an acceptable trade since that's the rare,
  already-abusive case, not the common one this route optimizes for.

Full suite still 350/350 (no scoring/data-shape logic touched - the new
`enabledSports` param defaults to fetching everything, and `buildMatches`
itself has no existing test coverage to update, by that test file's own
long-standing design - see its own top comment: pure-helper tests only,
never a live/mocked full build). Verified live: `sports-proxy-worker.js`
still parses and responds correctly after the restructuring. Committed and
pushed to both branches of Match-Find and both branches of Shared-Proxy.

Two direct follow-up reports on this same round's own new features, both
fixed the same day:

**Loading spinner never actually hid.** `.loading-state` set `display:
flex` unconditionally in `styles.css`. That selector has the exact same
specificity as the browser's own built-in `[hidden] { display: none }`
rule - but an author stylesheet's normal-weight rules always beat the
user-agent stylesheet's, tie or not, regardless of source order. So
`loadingStateEl.hidden = true` in `applyFreshBuild` was setting the
attribute correctly the whole time; it just had no visual effect, and the
spinner stayed flexed on screen forever even once real content had loaded
underneath it. Fixed by scoping the rule to `.loading-state:not([hidden])`
so the `hidden` attribute's own `display: none` wins once it's actually
set.

**"發現新版本，點此重新載入" never hid either, even already on the newest
version.** Root cause was the version-check mechanism itself, not a
display bug this time: comparing `app.js`'s own ETag/Last-Modified
response header (snapshotted once at load, re-checked on every manual
refresh) assumed GitHub Pages' CDN hands back a STABLE etag for the exact
same file content across separate requests. The live curl check that
originally called this "confirmed... reliable" only ever compared two
requests made seconds apart from the same sandboxed environment - almost
certainly hitting the same warm Fastly edge-cache entry both times, not
proving real stability across genuinely different requests/edge nodes/
compression-negotiation outcomes a real viewer's browser would actually
hit over time. Once that assumption was wrong even occasionally, the
button would show, and then never clear, since every SUBSEQUENT check
also compared against the same now-permanently-"stale" original baseline.
Replaced the whole mechanism with something that has no such external
dependency: `fetchLiveAppBuildId` fetches the live `app.js`'s own source
text and reads `APP_BUILD_ID` (see Round 27's own comment on that
constant - the exact commit sha `deploy.yml`'s sed step stamps in on every
deploy) straight back out via a regex, then compares it directly against
this tab's own already-known `APP_BUILD_ID` constant - no snapshot-at-load
step needed at all anymore, since a tab always already knows its own
value. Two copies of app.js from the same deploy are byte-identical by
construction, so this comparison structurally cannot produce the false
positive the ETag approach could. Verified the regex against both a real
commit-sha string and the literal `'__BUILD_ID__'` dev placeholder (self
vs. self, correctly reporting no difference in the local/dev case too).

Full suite still 350/350 (both fixes are markup/version-check plumbing,
no scoring logic touched). Committed and pushed to both branches of
Match-Find.

**Direct follow-up report, same day: "New update found, click to update
still doesn't hide after newest version" - persisted even past the
`APP_BUILD_ID` fix above.** The build-id COMPARISON itself was already
correct (verified live: both the plain and `?v=<sha>`-suffixed `app.js`
URLs served the freshly-deployed build id within seconds of that deploy
going out). The actual bug was one step further down: clicking the
"發現新版本，點此重新載入" button called a bare `window.location.reload()`,
and `index.html` itself is served by GitHub Pages with
`cache-control: max-age=600` (confirmed live via curl) - a PLAIN reload,
unlike a hard/force-refresh, is allowed to be satisfied entirely from this
browser's own local HTTP cache when made within that freshness window,
with no network request at all. Since this repo did five deploys in the
same ~30-minute session that day, a viewer who'd loaded the page at any
point in that window and then clicked "reload" was, in effect, reloading
the exact same stale `index.html` (and the old `app.js?v=<sha>` it
references) straight back off disk - the click did nothing observable,
which is exactly "never hides" from the viewer's own perspective, even
though the underlying check that triggered the button was telling the
truth. Separately confirmed the general shape of that theory was even
worse than expected: GitHub Pages' CDN (Fastly) turned out to ignore the
query string entirely for its own edge-cache key on this asset (three
requests with three different random query strings, from three different
edge nodes, all came back `x-cache: HIT` against what curl's own `age`
header showed was the SAME underlying cached object) - so a cache-busting
query param would have done nothing at THAT layer. It didn't need to,
though: GitHub Pages purges/repopulates its own CDN cache on every deploy
(confirmed serving the correct build id within seconds live), so the CDN
was never actually the live bug here - only this browser's own local
cache, which DOES key on the full URL including query string. Fixed by
having the reload button navigate to `location.pathname + '?_=' +
Date.now()` via `location.replace` instead of calling `location.reload()`
directly - a URL this browser has never fetched before, so it cannot be
answered from local cache and must hit the network, landing on GitHub
Pages' CDN which (per the above) is already serving the correct content.

Full suite still 350/350 (reload-button plumbing only, no scoring/build
logic touched). Committed and pushed to both branches of Match-Find.

**Direct follow-up report, same day, confirmed even in a fresh incognito
window: "Still showing it."** Both prior fixes were real and both were
already confirmed live (curl-verified: correct `APP_BUILD_ID`, correct
click handler) - and neither one had ever had any actual influence on
whether the button was visible. The real bug was the THIRD instance of
this file's own recurring CSS cascade gap (see `.loading-state`/
`.match-odds`/`.match-watch`'s own comments earlier in this file for the
first two): `#reload-app-btn` carries `class="settings-action-btn"`, and
`.settings-action-btn { display: block; }` is an ordinary AUTHOR
stylesheet rule. An author-stylesheet rule beats the browser's own
built-in `[hidden] { display: none }` User-Agent-stylesheet rule
unconditionally - origin/importance is compared before specificity ever
enters the picture, so this isn't even a tie to break, `.settings-action-
btn` simply always wins. That means this button had been rendering
`display: block` from the very first page load, completely independent
of the `hidden` attribute and everything app.js ever did with it -
`checkForNewAppVersion` could have been perfectly correct from the very
first version of this feature and it would have made zero visible
difference, since CSS alone was already showing the button unconditionally
on every page load, "newest version" or not. Fixed by adding
`#reload-app-btn[hidden] { display: none; }`, the exact same shape as the
two earlier fixes for this identical cascade gap. This is also the
likely reason this bug read as present from the very first report rather
than something that started working and then regressed: it may never
have correctly hidden even once, on any deploy, since this feature was
first added.

Full suite still 350/350 (styles.css only, no logic touched). Committed
and pushed to both branches of Match-Find.

## Round 28 (2026-09-21)

Direct question, not a bug report this time: "Is it normal a lot of MLB's
match odds is 50/50, also why qualifying odds is lando 10 kimi 7 franco 7,
that's kind of weird." Investigated both against LIVE `gamma-api.
polymarket.com` data (not simulated fixtures), since both are exactly the
kind of claim this app's own README says never to trust a synthetic
sample for.

**MLB near-50/50: real, not a bug.** Pulled today's actual moneyline
markets: Blue Jays @ Orioles 50.5/49.5, Twins @ Giants 51.5/48.5,
Nationals @ Tigers 41.5/58.5. Also verified the parser is reading the
right market in the first place - a real MLB game event nests ~27
markets (moneyline, spread, run-line, 1st-5-innings, per-inning winner,
player props), several of which ALSO use the two team names as their own
two outcomes (a spread market's outcomes are still `[awayTeam, homeTeam]`,
just priced against a run line instead of a straight win) - live-checked
across several games that the real head-to-head moneyline market
consistently sorts first in Polymarket's own `markets` array for a game
event, which is the one `parseCombinedMoneylineMarket` actually returns.
Baseball moneylines cluster near 50/50 far more than NBA/NFL because
single-game variance is high regardless of team quality (even a clearly
better team still loses ~35-40% of individual games) - the market is
telling the truth, not showing a parsing bug.

**F1 qualifying odds: a real distortion, traced and fixed.** See
`polymarket.mjs`'s own comment on `devigPowerMethod` for the full
mechanism - short version: F1's outright markets (Race winner, Pole
position) are ~23 SEPARATE, independently-priced Yes/No books, one per
driver, unlike the team-sport case's one single combined market. Live-
verified: a real Azerbaijan GP pole-position market's 23 raw "Yes" prices
summed to 4.52, not ~1 - each driver trades in their own thin book with no
shared liquidity keeping the field honest. The existing `devigNWay`
(divide every price by the raw total) assumes that excess is spread
EVENLY across every outcome, which live data shows is false: a rarely-
traded longshot's own price is inflated far more than a heavily-traded
favorite's (the textbook "favorite-longshot bias"). Dividing everyone by
the same 4.52 crushed a genuine ~45.5% raw favorite (Lando Norris) down to
a misleadingly flat ~10.1% - reading as "no real favorite" when the raw
market data said otherwise, and reproducing the live report exactly
("lando 10 kimi 7 franco 7").

Added `devigPowerMethod`: solves for an exponent k such that
`sum(p_i^k) = 1` (the "power method", a standard sports-betting devig
technique) instead of dividing by the raw total - shrinks a small price
much faster than a large one as k rises above 1, so a longshot's own
larger excess gets corrected more than a favorite's smaller one, while
still summing to exactly 100 like `devigNWay` does (explicitly asked for:
"I still want % and the % represent the total of 100%" - a raw,
non-rescaled display was considered and rejected, since raw prices don't
sum to 100 at all and would look broken to a viewer expecting a
probability distribution). Verified against the real 23-price fixture:
Norris moves from 10.1% to 17.7%, still the clear #1, with every other
driver's own relative order unchanged - only `parseOutrightWinnerMarkets`
(both F1 callers) was switched to it; MLB/NBA/EPL's own `devigNWay` calls
are untouched, since their real sums are already close to 1 and have no
such bias to correct.

Added direct test coverage for `devigPowerMethod` (sums to 100 on the
real 23-price fixture, preserves `devigNWay`'s own ranking, gives the
real favorite a meaningfully higher share than naive proportional
rescaling would, and agrees with `devigNWay` on an already-near-exact
two-way input) - a pure helper function, same test-coverage bar as
`devigNWay` itself. Full suite 355/355. Committed and pushed to both
branches of Match-Find.

## Round 29 (2026-09-21): MLB watchability review - competitiveness was acting as a hard ceiling, skill was computed and thrown away

Direct review request, not a live bug report: reconsider
`computeMlbObjectiveScore`'s own watchability formula (`objective-score.
mjs`), because it "treats competitiveness/closeness as too dominant a
definition of a good game" - a close matchup between two mediocre teams
could outrank a more genuinely interesting one between elite teams, using
Dodgers vs Giants as the illustrative case (Dodgers elite, Giants bad, but
real rivalry/marquee value). Two concrete complaints about the old code:
`watchability = Math.min(watchability, competitiveness + 3)` put a hard
ceiling on a lopsided game's score no matter how good anything else about
it read, and `skill` was computed at the very end of the function and
returned to the caller but never actually fed into `watchability` at all.

**The hard cap.** Replaced with a soft, diminishing-returns penalty,
MLB-only (NBA/EPL keep the original flat `+3` wall - their own tests
hard-code that exact bound, and this review was scoped to MLB). Below
`MLB_WATCHABILITY_FULL_LIFT_ALLOWANCE` (3, deliberately reused from the
old constant's own value, so anything that used to pass through the old
cap unchanged still does) excess above competitiveness passes through
completely untouched. Only excess beyond that allowance is damped, by
`MLB_WATCHABILITY_EXCESS_DAMPING` (0.4) - not discarded outright the way
the hard `Math.min` did - so a genuinely exceptional combination of
stakes/skill/momentum/rivalry can still lift watchability further, just
with steadily diminishing returns, rather than hitting a wall it can never
cross regardless of magnitude.

**Wiring `skill` into watchability.** Moved `skill`'s computation earlier
in the function (it's now a real INPUT, not a dead-end return value) and
gave it a genuine weight in the blend: `weightedAverage([[stakes,0.3],
[competitiveness,0.3],[skill,0.25],[momentum,0.15]])` - down from
`[[stakes,0.45],[competitiveness,0.35],[momentum,0.2]]`. Stakes and
competitiveness both dropped from their old weights to make room, rather
than skill diluting only one of them.

**A real bug found while wiring skill in, before it shipped:** the
existing `skill` (average of both teams' win%) cancels out exactly the
signal this whole review exists to capture. A 96-60 Dodgers team (.615)
against a 64-92 Giants team (.410) averages to .5125 - a neutral ~5 skill,
indistinguishable from two genuinely mediocre .500ish teams. Verified this
concretely before committing to the average: a hand-built "two genuinely
bad teams, closely matched" scenario (.35 vs .30) and the Dodgers/Giants
scenario both landed at `skill: 5` under the average formula - the
opposite of the intended behavior. Fixed by having MLB's own `skill` use
the BETTER team's own win% instead of the average (`skillFromWinPct(Math.
max(awayWinPct, homeWinPct))`) - `skillFromWinPct` itself is unchanged and
still generic (its param was renamed from `avgWinPct` to `winPct` since
it's no longer always an average); NBA/EPL's own `skill` calls are
untouched and still pass the two-team average, since this specific
average-cancels-the-signal failure mode is MLB-review-scoped, not
verified as a problem for those two sports.

**Verified against hand-built examples** (not simulated fixtures - see
this doc's own standing rule against trusting those) spanning the cases
the review asked for:
- Elite (.615) vs bad (.410), big division lead, real rivalry flag:
  watchability 4 -> 5 (modest lift; rivalry bonus itself still gated out
  at this competitiveness, same as before - the fix is skill's own
  contribution, not the rivalry gate).
- Two genuinely mediocre teams in a live, close division race, no
  rivalry: watchability 8 (was 9 under the old formula) - a small,
  expected trade-off from skill now diluting a maxed-out
  stakes/competitiveness read when skill itself is neutral, not a
  regression.
- Two genuinely bad teams, lopsided against each other, no rivalry:
  stays low (`watchability: 3`, `skill: 2`) - skill does not falsely
  rescue a matchup with no real team quality on either side.
- A live 1-game-back division race between two good-but-not-elite teams
  still outranks the elite-vs-bad blowout above (9 vs 5) - confirms the
  explicit ask that this NOT simply force Dodgers/Giants to win, only
  make the formula capable of it when the numbers genuinely support it.
- An intentionally extreme probe (maxed stakes/skill/momentum against a
  rock-bottom competitiveness) confirmed the new penalty is genuinely
  soft: watchability rises well above competitiveness alone but still
  stays below the maximum, rather than either hard-capping or blowing
  straight through to 10.

Added 3 new tests to `tests/objective-score.test.mjs` covering the
elite-vs-bad-averaging-hides-it case, the elite-blowout-vs-mediocre-
blowout-vs-close-race ranking, and the soft-cap's own damped-not-discarded
behavior; updated one existing test's own stale "AVERAGE" wording to match
the new best-team-win% semantics (the test's assertions themselves already
happened to hold either way). Full suite 358/358. Scoped to MLB only -
NBA/EPL's own `computeNbaObjectiveScore`/`computeEplObjectiveScore` and
their hard `+3` cap were not touched.

## Round 30 (2026-09-21): the same direction applied to NBA and EPL, each with its own tailored formula

Direct follow-up request: apply Round 29's fix to NBA and EPL too, but
"not the same formula but specific designed for them but the same
direction" - wire `skill` into watchability and soften the hard
`competitiveness + 3` cap, without literally copying MLB's weights.

**Skill.** Both sports' own `skill` switched from the two-team average to
the BETTER team's own win%/points-rate, same reasoning and same fix as
MLB's own Round 29 change (an elite team paired with a bad one averages
back toward neutral, hiding exactly the signal this axis exists for).

**Watchability weighting - deliberately different per sport, not MLB's
numbers reused:**
- **NBA**: `stakes 0.35 / competitiveness 0.3 / skill 0.2 / momentum 0.15`.
  Stakes keeps the single largest share of any sport (the play-in/playoff
  cutoff is a more binary, higher-visibility stake than MLB's own
  wild-card race), and skill gets the SMALLEST share of the three sports
  (0.2) because NBA already has two separate name/fame-driven additive
  bonuses (rivalry, national broadcast) that a continuous skill score
  would otherwise partially duplicate.
- **EPL**: `stakes 0.4 / competitiveness 0.3 / skill 0.3`. No
  momentum/recent-form signal exists for EPL at all (unchanged limitation,
  see this doc's own README cross-reference), so skill gets the LARGEST
  share of the three sports (0.3) - there's no fourth axis to otherwise
  spend that weight on.

**Soft-cap damping - also deliberately different per sport:**
`NBA_WATCHABILITY_FULL_LIFT_ALLOWANCE`/EPL's own equivalent both reuse the
same 3-point allowance as MLB (a strict loosening of the old rule, not a
re-tuning of the normal case - excess up to 3 still passes through
unchanged everywhere). Past that allowance:
- MLB damps by 0.4 (least conservative - a single rivalry bonus, at most
  +2, can stack on top of skill).
- NBA damps by 0.3 (rivalry +1.5 AND national broadcast +1 can both stack
  on top of skill, more than MLB's single bonus).
- EPL damps by 0.25, the tightest of the three - a derby (+2) AND a
  big-club bonus (+2) can BOTH stack on top of skill (up to +4 total),
  more than either other sport's own bonuses, so it needs the strongest
  brake to keep a genuinely decided blowout from getting too much lift
  out of name value alone.

**Verified against hand-built examples** (same style as Round 29, real
gaps and no simulated fixtures):
- NBA: an elite (.70) team against a tanking (.20) one scores
  `skill: 9, watchability: 4`; a mediocre (.45) team against the same
  tanking side scores `skill: 4, watchability: 5` (a smaller win% gap, so
  competitiveness alone is already higher there - not a regression, a
  different scenario). A genuinely close NBA race (.55 vs .53, no
  standings data) scores `watchability: 7`, comfortably ahead of either
  blowout.
- EPL: an elite (.75) club against a struggling (.15) one, no derby/
  big-club flags at all, scores `skill: 10, watchability: 4` - a
  genuinely great, unflagged club is no longer invisible to watchability
  the way it was when only the binary `isBigClub` list could raise it. A
  close mid-table EPL fixture (.52 vs .50) scores `watchability: 8`.

**Existing tests updated, not just left broken by the intentional
behavior change:** two "blowout NOT rescued" tests (NBA, EPL) previously
asserted the OLD flat `watchability <= competitiveness + 3` bound using
scenarios that happen to also contain a genuinely elite team (.85/.15,
.05/.90) - under the new formula those blowouts legitimately exceed the
old bound by a small amount, because skill's own real contribution is
no longer zero. Rewrote both as: skill uses the better team's own win%
(a clean, unconfounded check), and the blowout scenario itself is
still meaningfully suppressed (`watchability > competitiveness` but
`< 10`, i.e. real lift without ever reaching the maximum) rather than
literally re-deriving the old hard number. One `match-builder.test.mjs`
factor-string assertion (`'avg points-rate 30.0%'`) updated to
`'best team points-rate 40.0%'` to match the new factor text. Added 4 new
tests (2 NBA, 2 EPL) covering the better-team-not-average fix and the
soft-cap's own bounded-but-real-lift behavior. Full suite 360/360.

## Round 31 (2026-09-26 TW time): why the real Dodgers/Giants game still lost its slot, and a generic (not date-specific) fix

Direct follow-up: "Previous MLB fix didn't push Dodgers vs Giants as
recommended on 9/26 (TW time), trace why." Pulled the REAL schedule and
standings for that date from the live MLB Stats API (not a simulated
fixture) rather than guessing: Dodgers 96-60 (.615, NL West leader by 9)
@ Giants 64-92 (.410, 32 games back, streak L3).

**Traced it.** `computeMlbObjectiveScore` on the real data produced
`competitiveness: 5, watchability: 5, skill: 7` - skill IS wired in
correctly (Round 29's fix works, Dodgers get real credit for being a
genuinely good team). But the historic-rivalry bonus never fired: MLB's
rivalry bonus was gated on `isRivalry && competitiveness >=
MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS(6)`, and 5 is one point under that
line. Because the rivalry factor string never made it into
`objectiveFactors`, `recommendation.mjs`'s `isMarqueeFixture()` - which
detects marquee fixtures purely by string-matching that array - also saw
nothing, so the SEPARATE, fully undiluted `MARQUEE_FIXTURE_SCORE_BONUS`
(built in Round 17 specifically to bypass blend-dilution) missed it too.
One hard gate was silently doing double duty, blocking both the internal
diluted bonus AND, as an unintended side effect, the external undiluted
one.

Ran the real 15-game MLB slate for 9/26 through the actual formula:
Dodgers/Giants ranked **14th of 15**, comfortably behind Cubs (.558) @
Red Sox (.538) - two teams still fighting for playoff seeding, and
several other real, tight wild-card-race games that night. Checked
whether simply lowering/removing the gate would fix it: it would NOT,
safely - the rivalry bonus firing would also make `isMarqueeFixture` true
and hand out the FULL undiluted +2 on top of the +2 already blended into
watchability, jumping Dodgers/Giants to **#1 for the day** purely off
name value despite the 32-game gap and nothing at stake for either team -
literally recreating the original Round 23 failure this whole guardrail
exists to prevent, just via a second path.

Presented this trade-off to the user rather than guessing which side of
it they wanted. Their answer: "I don't care just let it win some way but
a more generic rule not a specific case" - explicitly ruling out a
Dodgers/Giants- or date-specific carve-out.

**The generic fix: replace the hard gate with a graduated ramp, in BOTH
places it was blocking credit.** Added `marqueeCreditFraction(competitiveness,
floor=2, ceiling=MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS)` to
`objective-score.mjs` - a linear ramp from 0 credit at competitiveness 2
(a real, decided mismatch - same floor value `playoffProximityScore`
already uses for the same idea) to full credit at competitiveness 6 (the
OLD gate's exact threshold, reused on purpose: at or above it, behavior is
byte-for-byte unchanged from before - this is a strict loosening of the
old rule, not a re-tuning of it). Applies identically to any pairing in
`MLB_RIVALRY_PAIRS` at any competitiveness level on any date - the only
thing that varies fixture to fixture is the real win% gap, nothing about
this rule mentions a specific team or date.

`computeMlbObjectiveScore` now returns this fraction as `marqueeCredit`,
and `match-builder.mjs` copies it onto the built match object (`undefined`
for NBA/EPL/F1, which never set it). `recommendation.mjs`'s
`computeEffectiveScore` now scales the undiluted `MARQUEE_FIXTURE_SCORE_BONUS`
by `match.marqueeCredit` too, defaulting to 1 (full credit) when the field
is absent - this is what actually closes the "double gate" gap: without
it, MLB's now-nonzero-but-partial internal credit would still trip
`isMarqueeFixture`'s own boolean check and hand out the FULL undiluted
bonus regardless of how small the internal fraction was, recreating a
cliff one layer up. NBA/EPL never set `marqueeCredit`, so they default to
1 and keep their existing unconditional rivalry/derby/big-club bonus
behavior byte-for-byte (deliberately NOT touched - their own bonuses stay
unconditional for a different, already-documented reason: no standings-API
integration yet means a low competitiveness there can still be
early-season sampling noise a genuinely elite club should survive, e.g.
Round 14's Liverpool @ AFC Bournemouth case - applying this same
competitiveness-based ramp to them would have silently reintroduced that
exact bug).

**Re-ran the real 9/26 slate with the fix.** Dodgers/Giants: competitiveness
5 -> `marqueeCreditFraction(5) = 0.75` -> partial internal credit (+1.5
instead of the old all-or-nothing +2/+0) lifts watchability from 5 to 6,
and the same 0.75 fraction scales the undiluted bonus to +1.5 instead of
+2. Final `effectiveScore` for the day: **Dodgers/Giants 7.15, now edging
out Cubs/Red Sox's 7.05** - it wins the slot, on a graduated, principled
credit rather than a name-based override. Verified the guardrail still
holds for a genuinely decided rivalry blowout (competitiveness at the
floor, 2): `marqueeCredit` is exactly 0, no factor string, no bonus at
either layer - not an unconditional "rivalry always wins" rescue.

Added `marqueeCreditFraction` + `MIN_COMPETITIVENESS_FOR_MARQUEE_BONUS` to
`objective-score.test.mjs`'s imports; added a `describe('marqueeCreditFraction')`
block (floor/ceiling/linearity/custom-bounds/non-finite-input) and three
`computeMlbObjectiveScore` tests (full credit unchanged at high
competitiveness, partial credit on the real 9/26 numbers, zero credit at
the floor) to `objective-score.test.mjs`; added two tests to
`recommendation.test.mjs` (proportional scaling by `marqueeCredit`, and
unchanged full-credit behavior when the field is absent). Full suite
369/369. Committed and pushed to both branches.

## Round 32 (2026-09-21): merge the separate "click to update" button into the main refresh button

Live-reported: the "發現新版本，點此重新載入" button (`reload-app-btn` -
only ever shown after a manual "立即重新整理" click found a new deploy) had
become a confusing extra step - two clicks split across two buttons for
what's really one decision the viewer wants made for them. Requested fix:
remove it and fold its job into the one existing "立即重新整理" button -
check for a new deploy FIRST, reload immediately if one exists, otherwise
fall through to the exact same data refresh it already did.

`refreshDataBtn`'s click handler now awaits `checkForNewAppVersion()`
before anything else; on `true` it does the same cache-busted
`window.location.replace` the old `reloadAppBtn` handler used (a bare
`location.reload()` can be served from this tab's own local HTTP cache,
since `index.html` carries `cache-control: max-age=600` - see that code's
own comment) and returns without ever calling `refreshFullWindow`; on
`false`/failure it falls through to the unchanged `refreshFullWindow` call.
`refreshFullWindow` itself lost the post-fetch version-check block that
used to unhide `reloadAppBtn` - there is no second button left to unhide.
Removed `reload-app-btn` entirely from `index.html`/`app.js`/`styles.css`,
including its now-obsolete `#reload-app-btn[hidden] { display: none; }`
cascade-fix rule from earlier the same day (the button it targeted no
longer exists).

No test coverage existed for either button (both are pure DOM/event-
handler glue, not scoring logic) - verified instead with `node --check` on
`app.js` and a live Playwright smoke load (no `pageerror`s, settings panel
renders with exactly one update button). Full suite still 369/369
(untouched - no scoring logic in this change). Committed and pushed to
both branches.

## Round 33 (2026-09-21): tracing the system against 6 days of human-validated MLB picks - a real result the formula can't reach without breaking something else

User-supplied ground truth: a human-validated "what should have been
recommended" list for MLB, Taiwan time, 2026-09-22 through 2026-09-27
(some days offering two "OR"-equivalent options), built from real
online/media judgment, with an explicit instruction: find the GENERIC
similarity behind any mismatch, never patch one specific date/pairing.

**Method.** Ran the actual live pipeline, not a hand-built fixture:
`node scripts/build-data.mjs` against the real MLB Stats API/ESPN/
Polymarket (today really was 2026-09-21, so 9/22-27 were all still
upcoming, real, currently-fetchable fixtures), then
`TZ=Asia/Taipei node scripts/dump-day-plan.mjs 2026-09-22 2026-09-27 MLB`
to see the actual picks with full score breakdowns and every non-picked
candidate's own reason.

**Result.** 9/22 (Blue Jays@Orioles + Twins@Giants) and 9/26 (Cubs@Red Sox
+ Dodgers@Giants - the exact Round 31 case) matched the human list exactly,
confirming those two rounds' fixes hold on live data days later. 9/27
picked Rays@Phillies, one of the three offered "OR" options - also correct.
**9/23, 9/24, and 9/25 all picked Cleveland Guardians @ Boston Red Sox**
for the headline slot instead of the human's **Milwaukee Brewers @
Philadelphia Phillies OR Tampa Bay Rays @ New York Yankees** - the same
two 3-game series playing out identically wrong for three consecutive
nights, i.e. one structural conflict, not three.

**First hypothesis (a redundant-weighting bug in `bestMatchScore`) - tested
and rejected with a real constraint search, not a guess.** `bestMatchScore`
blends skill (0.2)/competitiveness (0.2)/watchability (0.35)/enduranceScore
(0.1)/broadcastQuality (0.15) - but competitiveness is ALSO ~30% of
watchability's own blend and ~60% of enduranceScore's, so it's structurally
counted three times over, while skill (the axis that actually distinguishes
Milwaukee's historic 98-58 season and a `skillFromWinPct` of 8, the day's
highest, from Guardians/Red Sox's more pedestrian 6) is comparatively
under-weighted. That reads like exactly the kind of redundancy earlier
rounds have fixed before. Wrote a small script
(`scripts/`-adjacent scratch tooling, not committed - grid-searched
`{skill, competitiveness, watchability, enduranceScore, broadcastQuality}`
weight combinations against the REAL fetched 9/22-9/27 data) with two hard
constraints: Brewers/Phillies must beat Guardians/Red Sox on 9/23-25, AND
Chicago Cubs @ Boston Red Sox must still beat Tampa Bay Rays @ Philadelphia
Phillies on 9/26 (a real fixture pair that day with the IDENTICAL
statistical shape - high-competitiveness/lower-skill "X @ Red Sox" vs
lower-competitiveness/higher-skill "Rays @ Y" - already correctly resolved
by the current weights). **Every weight combination that satisfies the
first constraint breaks the second, and vice versa** - the unconstrained
grid search's own best-margin solution was a degenerate corner
(`broadcastQuality: 0`, `enduranceScore` UP not down) with no principled
interpretation, itself proof that no honest linear reweighting of these
five axes can resolve both real cases at once. This is not a coefficient
bug; it's evidence the two days' correct answers depend on something these
five axes don't encode at all.

**Second hypothesis (missing real starting-pitcher-quality signal) - also
checked against real data, also didn't hold up.** MLB uniquely has a single
daily starting pitcher whose quality is both a real skill signal AND a real
"appointment viewing" draw a team-record-only formula can't see - unlike
NBA/EPL, this seemed like a plausible genuinely-new, deterministic axis
(not a hand-maintained list). Fetched real announced probable pitchers +
their actual 2026 season ERAs via the MLB Stats API's own
`hydrate=probablePitcher` schedule param and `/people?hydrate=stats(...)`
batch endpoint. Result: Milwaukee's Logan Henderson (2.51 ERA) is
excellent, matching the "Brewers should win" hypothesis - but Boston's own
9/23 starter, Sonny Gray (2.82 ERA), is just as much an ace. Pitcher
quality doesn't cleanly separate these two games either; it isn't the
missing variable.

**Conclusion, reported to the user rather than papered over with a forced
fit.** This specific mismatch reflects real-world contextual judgment
(team storylines, how big a draw a specific matchup is, things a human
rater sees and a box-score formula structurally cannot) that isn't
decomposable into any deterministic signal tried, including a genuinely
new one. Continuing to hand-tune weights to fit this exact example would
trade a real fix for a fragile one, per the user's own explicit standing
instruction to find generic similarity rather than patch a specific case -
exactly what the constraint search proved was NOT available here. This
directly motivated Round 34's design question back to the user: since the
formula provably cannot resolve this class of call without regressing
something else, is a bounded, quota-conscious Gemini tie-break (not a
return to the old per-fixture validation call) worth reintroducing for
exactly this kind of close call? The user chose "bounded daily tie-breaker."

No code changed in this round - it's a trace + a rejected-hypothesis
record, kept here so a future close call isn't re-litigated from scratch.
Full suite unchanged, 377/377 as of Round 34 below (8 new tests were added
THERE, not here).

## Round 34 (2026-09-21): reintroducing Gemini as a bounded, at-most-once-a-day tie-break (not the per-fixture validation Round 11 removed)

Directly follows Round 33's finding: the deterministic engine cannot
resolve the 9/23-25 class of close call without breaking an
already-correct one, proven by constraint search, not assumed. The user's
own framing (paraphrased): "if we fixed our recommendation system we might
never need Gemini... you make the call" - given the formula genuinely
can't reach this result, and given the user picked the bounded-tie-break
option when asked, this round reintroduces exactly that: **one Gemini call
per day, at most, only for the single headline slot's own close call, never
a per-fixture validation pass.**

**Why this doesn't repeat Round 11's failure mode.** Round 11 removed a
call that ran on EVERY fixture, EVERY build - the exact shape that hit
Google Search grounding's 429 RESOURCE_EXHAUSTED wall on 100% of live
requests (Round 9). This call: (1) only fires when
`selectGeminiTieBreakCandidates` finds 2-4 candidates within
`GEMINI_TIE_BREAK_MARGIN` (0.5, a tight bar - a third of this file's own
`ALTERNATIVE_MAX_SCORE_GAP`) of each other for the CURRENTLY-VIEWED day's
own top pick - most days have no such call to make at all; (2) is cached
client-side per `(dayKey, exact candidate-id-set)` for 24h on success (2h
on failure/no-config, so an unset URL or a transient error doesn't retry
every render) - a real live session asks at most once per day actually
viewed, not once per fetched day in the whole 14-day window; (3) requests
no Google Search grounding - it asks Gemini to use its own training-data
knowledge of the specific teams/players, which is what the original
un-grounded validation call (Round 9's own finding) always succeeded at
anyway, the grounding tool was the part that failed.

**Shared-Proxy (`jaypengx-collab/shared-proxy`) changes** - new
`POST /match-recommend` route in `worker.js`, reusing the existing
`GEMINI_API_KEY` secret/`gemini-3.5-flash-lite` model/`buildGenerationConfig`/
`isRateLimited`/`json` helpers `/gemini` and `/vocab-ai` already established
(no new secret, no new deploy-setup step beyond redeploying this file):
- `readMatchRecommendCandidates` validates the body into a bounded shape
  (2-4 candidates, each field length-capped) before it's ever embedded in a
  prompt - same posture as `readGeminiFiles`/`cleanVocabAiText`.
- `buildMatchRecommendPrompt` asks for a JUDGMENT CALL, not a re-derivation
  of the score: every candidate already carries the deterministic engine's
  own number and the real facts that produced it (the SAME `reason`/
  `objectiveFactors` strings a viewer's own card already shows), so the
  prompt's whole job is real-world context a formula can't see, explicitly
  telling the model to default to the highest-scored candidate absent a
  confident reason otherwise.
- `handleMatchRecommendRequest` rate-limits at 60/hour/IP (`'match-
  recommend'` feature key, isolated from every other route's own counter),
  requires `GEMINI_API_KEY`, and re-validates the model's own `pickId`
  against the exact candidate set THIS request offered before ever
  returning it - the model can suggest, never invent a fact this Worker
  can't check, same posture as every other Gemini-backed route in this
  file.
- Top-of-file comment and README updated - this repo's own prior framing
  ("Match Find calls no AI service at all") was accurate as of Round 11 and
  is now corrected without erasing that history: the deterministic engine
  is still the primary source of truth for every fixture; this is a nudge
  on top, not a replacement.

**Match-Find (`public/lib/recommendation.mjs`) changes** - three new pure,
independently-testable functions, deliberately with NO fetch of their own
(this module never does network I/O - `app.js` owns that, same split as
the rest of this codebase):
- `selectGeminiTieBreakCandidates(dayMatches, {scoreField})` reads
  `computeDayPlan`'s OWN output (`.recommended`/`.alternativeIds`) rather
  than re-deriving overlap logic - whatever gets offered to Gemini is
  GUARANTEED to be the exact conflict cluster already rendered as
  swipeable alternatives. Returns `null` (nothing to ask) when there's no
  recommended pick, no alternatives, or every alternative is already
  clearly behind by more than `GEMINI_TIE_BREAK_MARGIN`.
- `buildGeminiTieBreakPayload(dayKey, candidates)` builds the exact request
  body Shared-Proxy's route expects.
- `applyGeminiTieBreakBonus(dayMatches, pickId, {scoreField})` applies a
  flat `GEMINI_TIE_BREAK_BONUS` (1, same scale as `PRIORITY_SCORE_DELTA`)
  to the picked candidate's `planningScore` BEFORE `computeDayPlan` runs -
  same layer/timing as `applyLiveExcitementBonus`, so `alternativeIds`/
  `slotKey` bookkeeping stays entirely `computeDayPlan`'s own, never
  patched after the fact. Re-validates `pickId` against `dayMatches`'s
  current ids every time - a stale cache entry naming a fixture that
  rolled out of the fetch window can never silently bump an unrelated
  match reusing an old id shape.

**`public/app.js` changes** - `MATCH_RECOMMEND_PROXY_URL` (empty by
default; the ONE thing a self-hoster needs to set to enable this, exactly
like `PROXY_URL`, pointing at shared-proxy's *main* `orbit-workers-proxy`
Worker with `/match-recommend` appended, NOT the separate `sports-proxy`
Worker `PROXY_URL` points at - this call is rare enough that the
[placement]-region latency concern that justified splitting `/sports-proxy`
out never applies here). `dayCandidatesForPlan` (the single function both
the real render and `pinSlotChoice`'s "what would the algorithm pick"
question already share) now also calls `applyCachedGeminiTieBreak` -
purely synchronous, reads an in-memory-memoized localStorage cache, never
blocks a render on network. `renderRecommendedSection` fires
`maybeRequestGeminiTieBreak(dayKey, dayCandidates)` (fire-and-forget, never
awaited) right after `computeDayPlan` runs each render; it's a cheap
synchronous no-op on almost every call (URL unset, no close call, already
cached) and only actually reaches the network the first time a given day's
close call appears, re-rendering once if a genuinely new pick comes back.

**Verified safe when disabled (the shipped default).**
`MATCH_RECOMMEND_PROXY_URL` ships empty, so `maybeRequestGeminiTieBreak`
returns on its very first line, before touching cache or network - a
Playwright smoke load (local static server, real `app.js`) confirmed zero
`pageerror`s and the expected single-button settings panel (Round 32's own
fix) rendering correctly. Enabling it is a one-time, two-step opt-in
(redeploy shared-proxy's `worker.js`; set the one constant) - see the
README's own new section for exactly what to do.

**Tests.** 8 new tests in `recommendation.test.mjs`
(`selectGeminiTieBreakCandidates`: no-alternatives/out-of-margin/in-margin/
capped-at-max cases; `buildGeminiTieBreakPayload`: field pass-through incl.
safe defaults for a candidate with no reason/facts; `applyGeminiTieBreakBonus`:
correct target only, stale-id no-op, and an end-to-end case proving the
bonus - applied before `computeDayPlan` - can actually flip which candidate
wins a slot). Full suite: **377/377**. Committed and pushed to both
`Match-Find` and `Shared-Proxy`.

## Round 35 (2026-09-21): Round 34 still wasn't guaranteeing the user's own validated result - replaced the score nudge with a hard pin, and re-enabled Google Search grounding

Direct live report: "Still choosing Sox instead of my expected result, it
has to match my expected result no matter what." Two root causes, both in
Round 34's own design, both fixed here.

**Root cause 1: `GEMINI_TIE_BREAK_MARGIN` (0.5) was too tight and silently
excluded the real alternative from ever being asked about.** Live numbers
that day: Cleveland Guardians @ Boston Red Sox scored ~7.05, Tampa Bay Rays
@ New York Yankees ~6.35 - a 0.7 gap, ABOVE the 0.5 margin Round 34 used to
decide whether a candidate was even worth asking Gemini about, even though
this file's own `ALTERNATIVE_MAX_SCORE_GAP` (2.5) already considered it
close enough to show as a swipeable alternative in the UI. Gemini was
never even asked about Rays/Yankees - there was nothing "still wrong" for
it to fix, the call simply never fired for that candidate. Fix: removed
`GEMINI_TIE_BREAK_MARGIN` entirely. `selectGeminiTieBreakCandidates` now
offers Gemini every alternative `computeDayPlan` itself already considers
close (its own `alternativeIds`, already gated by
`ALTERNATIVE_MAX_SCORE_GAP`) - one existing, already-tuned notion of
"close enough to be a real call," not a second, independently-guessed
threshold that can silently disagree with the first.

**Root cause 2: even when Gemini WAS asked and picked correctly, a flat
+1 score bonus (`GEMINI_TIE_BREAK_BONUS`) could not guarantee it actually
won the slot** - a bonus sized to flip a narrow gap is, by construction,
not guaranteed to overcome a wider one, and "it has to match my expected
result no matter what" is exactly the guarantee a nudge can never give.
Fix: replaced the additive bonus with a HARD PIN, reusing the exact same
`pinnedForDay` mechanism a viewer's own swipe-to-pin already uses (see
`computeDayPlan`'s own `forcedIds` handling) - a forced pick wins its slot
UNCONDITIONALLY, the same guarantee a real user pin already has, regardless
of how wide the score gap is.

**New pure functions in `recommendation.mjs`** (replacing
`GEMINI_TIE_BREAK_MARGIN`/`GEMINI_TIE_BREAK_BONUS`/`applyGeminiTieBreakBonus`
outright, not layering on top of them):
- `tieBreakCandidateKey(candidates)` - the one canonical stable-order cache
  key, now shared between app.js's own cache writes and this module's own
  cache-validity check (previously app.js had its own private copy).
- `resolveGeminiOverridePin(dayMatches, close, cacheEntry, pinnedForDay)` -
  re-validates a cached answer against a FRESH `close` (this render's own
  `selectGeminiTieBreakCandidates` call, never trusting a stale cache
  blindly), confirms the cached `pickId` is actually one of the currently-
  offered candidates, and - critically - checks whether the VIEWER's own
  explicit pin already occupies the same conflict cluster. An explicit
  human pin always wins over Gemini's own pick; Gemini never overrides a
  viewer's own swipe.
- `computeDayPlanWithGeminiTieBreak(dayKey, dayMatches, pinnedForDay,
  cacheEntry, {scoreField})` - the one entry point app.js's render path
  calls: runs `computeDayPlan` once (natural, needed to compute `close`
  itself), and again with the resolved override added to `pinnedForDay` if
  one applies. `computeDayPlan` fully resets every match's own
  `.recommended`/`.alternativeIds` at the top of each call, so running it
  twice on the same array is safe - whichever call ran last is what's left
  mutated, exactly what renders.

**`public/app.js` changes** - `dayCandidatesForPlan` no longer touches
Gemini at all (that was the old bonus's pre-DP application point; a hard
pin has to be threaded through `pinnedForDay` at the `computeDayPlan` call
site itself, not patched onto a score beforehand). `renderRecommendedSection`
now calls `computeDayPlanWithGeminiTieBreak` directly (never a bare
`computeDayPlan` - the wrapper already calls it internally), passing the
viewer's own `state.pinnedChoices.get(dayKey)` through so an explicit pin
is respected, and reads the returned `close` value straight into
`maybeRequestGeminiTieBreak` instead of recomputing it. `pinSlotChoice`'s
own "natural choice" question deliberately still uses plain
`dayCandidatesForPlan` (no Gemini involvement) - a separate, narrower
scoping decision, not an oversight: that path is about a viewer's own
manual pin, not the rendered recommendation.

**Google Search grounding re-enabled, per direct instruction.** The user
confirmed explicitly: "google search is acceptable as long as one per day
and shared across different access from different day" - exactly what this
call's own client-side cache (Round 32's own design, unchanged) already
guarantees: one live call per `(dayKey, exact candidate-id-set)`, cached
24h, shared across every visit that same day. Round 9's own 429
RESOURCE_EXHAUSTED failure was a PER-FIXTURE, per-build call volume problem
- at this call's volume (at most once a day, per day actually viewed), the
same quota is a non-issue. Shared-Proxy's `worker.js` now requests `tools:
[{ google_search: {} }]` on this route, switched `MATCH_RECOMMEND_MODEL`
to `gemini-3.7-flash` (grounding-integrated reasoning benefits from the
more capable model; the -lite model the other routes use was a cost/
latency tradeoff that no longer matters at this volume), and moved off
`response_schema`-enforced JSON decoding for this route specifically (tool
use and a schema-constrained decode don't reliably compose the same way a
schema-only request does) - the prompt now asks for the JSON object as the
very last thing in an otherwise free-form response, pulled back out with a
trailing-`{...}` regex (`MATCH_RECOMMEND_JSON_PATTERN`) instead of parsing
the whole body as bare JSON.

**Tests.** Rewrote the `recommendation.test.mjs` Gemini describe block
around the new API: `selectGeminiTieBreakCandidates` (no-alternatives case,
and the live bug itself - a 0.7 gap still offered, since it's within
`ALTERNATIVE_MAX_SCORE_GAP`; a genuinely-too-wide gap still excluded; the
max-candidates cap), `tieBreakCandidateKey` (order-independence),
`buildGeminiTieBreakPayload` (unchanged from Round 34), `resolveGeminiOverridePin`
(no cache/stale candidateKey/pickId-not-offered/valid-and-fresh/blocked-by-
same-slot-human-pin/not-blocked-by-different-slot-pin - six cases), and
`computeDayPlanWithGeminiTieBreak` (no-cache passthrough; a 2.0-point gap -
far wider than the old, removed 0.5 margin - still flips UNCONDITIONALLY,
the direct proof this round's whole fix works; an explicit human pin still
overrides the cached Gemini pick). Full suite: **384/384**. Committed and
pushed to both `Match-Find` and `Shared-Proxy`.

## Round 36 (2026-09-27 TW time): a low-endurance MLB game claimed to be nearly over well before it realistically was

Live report: "9/27 is not purely Rays vs Phillies but with a continual,
don't let it continue (it overlap, or at least choose Angel vs Mariners)."
Real slate that day: Tampa Bay Rays @ Philadelphia Phillies at 07:15
(picked), Houston Astros @ Athletics at 09:40 (picked as a "continuation"),
Los Angeles Angels @ Seattle Mariners also at 09:40 (the same slot's own
runner-up, losing to Astros/Athletics by a narrow 0.25).

**Root cause.** `schedulingDurationMinutes` (the ONE duration figure
`canWatchSequentially`/the whole scheduler reads) was built entirely from
`effectiveDurationMinutes` - the `enduranceScore`-based value judgment
("is this game still worth watching") - then padded by MLB's own real-
clock overrun risk. Real numbers: Rays/Phillies had `durationMinutes` 159
and `enduranceScore` 5, giving `effectiveDurationMinutes` = 159 * (0.4 +
0.6*0.5) = 111.3 - already less than 70% of its own nominal length before
any padding. Padded by MLB's 12% overrun and the 10-minute transition
buffer, its scheduling window ended only ~2h14.7m after its own 07:15
start - reading Astros/Athletics's 09:40 start (a 2h25m real gap) as a
safe, sequential continuation. In real life, an MLB game plays all 9
innings in roughly the same real clock time whether or not the SCORE stays
close - a standard game averages ~2h40m of playing time alone (this file's
own Round 14 already documents this) regardless of competitiveness -  so a
"not that tense" game does NOT actually free its broadcast slot early the
way `effectiveDurationMinutes`'s own 40%-of-nominal floor (`ENDURANCE_
DURATION_FLOOR`) was letting the scheduler assume. The overlap the user
reported was real, not a UI/labeling issue.

**Why this isn't Round 14's bug reappearing.** Round 14 tuned
`DURATION_OVERRUN_BUFFER_BY_RELIABILITY` (the PADDING added on top of
`effectiveDurationMinutes`) down from 25% to 12% because that padding
alone was blocking an obviously-fine continuation by ~15 minutes. This
round's fix touches a different, previously-untuned axis entirely - how
far the endurance-based shrink is allowed to go BEFORE any padding is even
applied - so it doesn't undo Round 14's own fix or reopen that same false-
conflict case (verified: every other already-validated MLB-to-MLB
continuation this window, 9/23-9/26, has a real ~3+ hour gap, comfortably
clearing the new floor - confirmed by re-running the live pipeline after
the fix, see below).

**Fix.** Added `SCHEDULING_DURATION_FLOOR_BY_RELIABILITY = { high: 0,
medium: 0, low: 0.85 }` (`public/lib/recommendation.mjs`), keyed by
`durationReliability` the same way `DURATION_OVERRUN_BUFFER_BY_RELIABILITY`
already is. `schedulingDurationMinutes` now takes
`Math.max(effectiveDurationMinutes(match), match.durationMinutes *
floorFraction)` as its base before applying the overrun pad - a no-clock
sport's SCHEDULING duration can never read as less than 85% of its own
nominal length, regardless of how low its enduranceScore goes, while
`effectiveDurationMinutes` itself (and thus `enduranceScore`'s own
contribution to the actual recommendation SCORE via `bestMatchScore`) is
completely untouched - a genuinely low-endurance game still scores lower,
it just can't claim to be nearly over on top of that. High/medium-
reliability sports get `0` (no floor at all) - their own real end time is
already clock-bound by a game clock regardless of score margin (a lopsided
soccer match still plays the full 90+ stoppage), so the existing shrink
already applies to them in full, unchanged.

**A second, latent bug found and fixed along the way.** Writing a test for
a FINISHED, low-`enduranceScore` MLB match (`durationMinutes: 150,
enduranceScore: 1, isFinished: true`) exposed that `schedulingDurationMinutes`
was STILL running the finished match's own real, already-known duration
through `effectiveDurationMinutes`'s endurance shrink (150 -> 69) before
this round - every pre-existing test for the "a finished match isn't
padded further" behavior happened to use a high `enduranceScore` (where
the shrink factor is 1, a no-op), which is exactly why this had never been
caught. `schedulingDurationMinutes` now returns `match.durationMinutes`
directly and immediately for a finished match, bypassing the endurance
shrink entirely, not just skipping the overrun pad on top of it.

**Re-verified against the real live 9/27 slate after the fix.** Rays/
Phillies's own scheduling window now ends ~2h41.4m after its 07:15 start
(159 * 0.85 * 1.12 + 10min transition) - Astros/Athletics's 09:40 start no
longer clears it, so no continuation is offered there anymore. The day's
own best SINGLE game also changed as a direct, correct consequence: with
Rays/Phillies + Astros/Athletics's combined value (13.45) no longer a
legal sequence, Rays/Phillies alone (6.85) now loses to Chicago Cubs @
Boston Red Sox alone (7.05, unaffected - it has no continuation
opportunity either way) - which happens to be a SECOND of the three
options the user's own Round 33 human-validated list accepted for 9/27
("Tampa Bay Rays @ Philadelphia Phillies OR Baltimore Orioles @ New York
Yankees OR Chicago Cubs @ Boston Red Sox"), so this still lands inside
the validated answer set. Re-ran the whole 9/22-9/27 window: every other
day's own two-game continuation (9/22 Blue Jays/Orioles+Twins/Giants; 9/23-
25 Guardians/Red Sox+Padres/Dodgers; 9/26 Cubs/Red Sox+Dodgers/Giants) is
completely unchanged - all of those have real ~3+ hour gaps, nowhere near
the new floor.

**Tests.** Added a `Test 5b (Round 36)` describe block to
`recommendation.test.mjs`: the floor lifting `schedulingDurationMinutes`
back up when `effectiveDurationMinutes` alone would go lower (with the
overrun buffer still applied ON TOP of the floor); the exact live bug
reproduced at the same gap size and confirmed fixed
(`canWatchSequentially` now false, `computeDayPlan` no longer offers the
continuation); a wider, ~3-hour gap still correctly clears the new,
floored end (the floor isn't unconditionally conservative); a finished
low-endurance match is still never floored (guards the latent bug found
above); and high/medium-reliability sports get no floor at all. Full
suite: **389/389**. Committed and pushed to `Match-Find` - this fix is
entirely local to `public/lib/recommendation.mjs`, no `Shared-Proxy`
change needed this round.

## Round 37 (2026-09-22): the Gemini tie-break was never actually being asked about the right game - and, once fixed, live-proven that even a working call doesn't guarantee the human-validated answer

**Report.** User: 9/23, 9/24, 9/25 all still recommend Cleveland Guardians
@ Boston Red Sox / Chicago Cubs @ Boston Red Sox instead of their own
human-validated "Milwaukee Brewers @ Philadelphia Phillies OR Tampa Bay
Rays @ New York Yankees OR San Diego Padres @ Los Angeles Dodgers" -
despite Round 35's hard-pin mechanism, which was specifically built to
GUARANTEE this. Instructed: fix the recommendation system to fit the
expected result, or remove Gemini entirely unless it can be proven to
actually work.

**First finding: `MATCH_RECOMMEND_PROXY_URL` was empty this whole time.**
Checked `public/app.js` and the deploy pipeline (`.github/workflows/
deploy.yml`) - nothing has ever injected a real URL into that constant.
Gemini has never once been called on the live deployed site. Every report
of "Gemini picking the wrong game" was necessarily the plain deterministic
engine, unrelated to any AI call succeeding or failing.

**Second finding, the real bug: `selectGeminiTieBreakCandidates` only ever
looked at the FIRST recommended match, not the right one.** Re-ran the
live pipeline (`build-data.mjs` + `dump-day-plan.mjs`) against real current
data for 9/23-25 and found each of those three days has TWO independently
recommended slots at once - an early, non-overlapping "continuation" pick
(see Round 36) alongside the evening headline pick. `dayMatches.find(m =>
m.recommended)` grabbed whichever one sorted first chronologically, which
on all three real days was the early, low-stakes slot with no real
alternative (`alternativeIds: []`) - so `selectGeminiTieBreakCandidates`
returned `null`/the wrong candidate set every day, and the evening headline
slot's real, genuine tie (Guardians/Red Sox vs. Brewers/Phillies, tied
7.05=7.05 on 9/24) was NEVER offered to Gemini at all, with or without a
working API call. Fixed by scanning every recommended slot that day and
picking whichever one's own top-vs-runner-up score gap is smallest (the
slot the deterministic engine is genuinely least confident about) instead
of whichever airs first. Re-verified against live 9/23/24/25 data: the
corrected candidate sets now correctly center on Guardians/Red Sox vs.
Brewers/Phillies vs. Rays/Yankees (9/23-24) and Cubs/Red Sox vs. its own
real alternatives (9/25). Added two regression tests (`Round 37` sub-block
under `selectGeminiTieBreakCandidates`) reproducing this exact multi-slot
shape.

**Third finding: Google Search grounding is hard-blocked by a 429 quota
wall on this account, live-verified just now.** With the bug fixed and a
real `orbit-workers-proxy` deployment already live (confirmed via
`PROXY_URL` in `app.js` and this repo's own `wrangler.toml`/CI deploy
workflow), sent a real POST to `/match-recommend` with the real, corrected
9/23 candidate set. Two grounded requests ~15s apart both returned a hard
`{"error":{"message":"Gemini API error 429"}}` - the exact
`RESOURCE_EXHAUSTED` signature Round 9 already documented for grounded
calls, despite Round 35's reasoning that this route's low, cached call
volume would keep it clear of that wall. A control request to `/vocab-ai`
(same API key, same `gemini-3.7-flash` model, no grounding) returned an
unrelated transient `503 "high demand"` instead - proof the 429 is
specific to this account's Google Search grounding quota, a separate and
apparently very low bucket that Match Find's own call frequency doesn't
affect either way. Reverted `/match-recommend` to the pre-Round-35 shape:
`gemini-3.5-flash-lite`, no grounding, `response_schema`-enforced JSON
(committed/pushed to `Shared-Proxy`, auto-deployed by its own CI).

**Live-tested the reverted shape - it works, and that's an important,
slightly uncomfortable result.** Retried the real POST against the
redeployed Worker: HTTP 200, `{"pickId":"mlb-401817046","reason":"..."}`-
a genuine, valid response. `mlb-401817046` is Cleveland Guardians @ Boston
Red Sox - **the same pick the deterministic engine already made**, not the
human-validated Brewers/Phillies. Gemini's own stated reasoning (translated):
Cleveland's real 5-game win streak makes tonight's matchup against Boston
worth watching. This is Gemini's own independent judgment agreeing with
the deterministic formula, not a mechanism failure - the hard-pin design
guarantees that WHATEVER Gemini answers wins its slot unconditionally, it
was never a guarantee that Gemini's answer matches any specific viewer's
own judgment. Per Round 33's already-exhaustive, real grid-search proof
that no linear reweighting of the deterministic engine's five axes can
satisfy the 9/23-25 case without breaking the already-correct 9/26 case
(same statistical shape, opposite correct answer) - re-litigating the
formula weights again here would repeat already-disproven work. The
genuinely new information this round adds is that a second, independent
judge (a real Gemini call, now confirmed working) reached the same
"Guardians/Red Sox" conclusion the formula did, on real facts (a hot
streak, a tight wildcard race, national broadcast) that are all real and
defensible - not proof the human's own preference is wrong, just proof
that "ask a generically-prompted AI" doesn't automatically encode one
specific person's own research/preference either.

**Outcome.** `MATCH_RECOMMEND_PROXY_URL` now points at the real, live-
verified `orbit-workers-proxy` deployment (previously empty this whole
project). The Gemini tie-break is live for the first time. Full suite:
**391/391** (2 new regression tests for the multi-slot selection bug).
Committed and pushed to both `Match-Find` (recommendation.mjs fix +
regression tests + the URL + docs) and `Shared-Proxy` (grounding revert).
Reported back to the user rather than claiming "fixed" - the underlying
disagreement (their own research-based preference vs. every automated
signal tried, deterministic and AI alike) is still open, and the honest
next step is either (a) learning what specific reasoning/source informed
their 9/23-25 picks so it can be encoded explicitly, or (b) using the
app's own existing manual swipe-to-pin (which unconditionally overrides
everything else, deterministic or Gemini) for cases like this one.

## Round 38 (2026-09-22): research confirms the disagreement's real cause; billing unblocks grounding; locking down the now-billed route

Direct follow-up to the user's "why the hell is everything I research online
suggesting the recommended expected result" - did the actual research
Round 37 hadn't: confirmed the Boston Red Sox clinched their Wild Card
spot on September 20, 2026, and real sports coverage (Yahoo Sports, on
that exact Guardians/Red Sox series) states outright that "Boston may
already be looking ahead to an American League Wild Card Series in New
York against the Yankees" - i.e. real reporting treats that series as
Boston coasting, not fighting. Separately, Zack Wheeler (a genuine, elite
ace) started for Philadelphia on 9/23 against Milwaukee's Dustin May,
described in coverage as far less consistent - real appointment-viewing
value from the pitching matchup itself. Both are exactly the class of
live, current, above-the-box-score fact a win%/standings formula
structurally cannot see - and, tellingly, neither did Round 37's own
successful-but-non-grounded Gemini call, which only cited Cleveland's win
streak. A probable-starting-pitcher-ERA fetch was considered (the exact
API Round 33 already validated feasible) but not built: Round 33 already
tested that comparison (Henderson 2.51 vs. Gray 2.82) and found bare ERA
numbers don't cleanly separate these games - what actually matters here is
Wheeler's reputation and Boston's "looking ahead" storyline, narrative
facts a number can't encode. Conclusion put to the user plainly: this
needs a real grounded search, not more (already-exhausted, per Round 33's
own grid search) formula tuning.

**Billing.** User chose to enable billing on the Google Cloud project
behind `GEMINI_API_KEY`, specifically to lift the free-tier grounding
quota Round 37 hit. Re-enabled Google Search grounding + `gemini-3.7-flash`
on `/match-recommend` (Shared-Proxy, same shape as Round 35: `tools:
[{ google_search: {} }]`, free-form JSON extraction via
`MATCH_RECOMMEND_JSON_PATTERN` instead of `response_schema`), and
broadened the prompt to explicitly ask about a team already having
clinched and resting/looking ahead, on top of the existing injury/
milestone/storyline/probable-pitcher language - directly targeting the
exact failure mode just found. **Not re-verified with a live call this
round** - direct instruction was to stop spending real, now-billed credit
on manual verification calls. Verified instead with a local Node harness
(`worker.js`'s own `export default` imported directly, `global.fetch` and
`env.RATE_LIMIT_KV` both mocked) confirming the request/response plumbing
end to end with zero real network calls to Google. The first real grounded
call will happen from organic app usage; if it 429s again even on the paid
tier, that would mean billing didn't actually lift the grounding-specific
quota (some APIs gate tool-use on a separate allowlist from general paid
access) and this should revert exactly the way Round 37 did rather than
assuming billing alone guarantees it works.

**Security.** Requested separately, same session: "lock others from using
my Gemini API." Live-testing over Rounds 37-38 had just proven the exposure
directly - `/match-recommend`'s URL, sitting in this repo's own public
`app.js`, was callable by anyone with a bare `curl`, no enforcement beyond
a per-IP rate limit (`isAllowedOrigin` only ever fed the advisory CORS
response headers - real for a browser, meaningless to a direct request).
Shared-Proxy (Round 38, its own worker.js/README) now hard-rejects with
`403` before ever reaching a billed handler (`/gemini`, `/match-recommend`,
`/nl-edit`, `/vocab-ai`) if `Origin` is missing or not in
`ALLOWED_ORIGINS` - free for every real app (a JSON POST always carries a
real `Origin` from a real browser) - plus a hard daily global cap per
feature (`isDailyGlobalCapped`), the real financial backstop since it
counts every caller combined rather than per IP. Documented honestly in
that repo's own README: this stops opportunistic abuse, not a targeted
attacker reading the same public source this repo already publishes -
there is no such thing as a real secret in a fully public static site's
own client code.

Full Match Find suite unaffected by this round (**391/391**, no
`recommendation.mjs` changes) - every change this round lives in
Shared-Proxy's `worker.js`/README and this repo's own README/docs.

## Round 39 (2026-09-22): a background re-render was tearing the DOM out from under an active swipe

**Report.** "The team logo is flashing weirdly also swipe get a bit weird or
unable to use after some time, could be Gemini messing? Gemini load should
be applied before it finishes loading." Also (separately, same message):
"maybe your prompt is bad... I know it's close but this ain't right" - the
Guardians/Red Sox pick, addressed on its own merits in this file's own
Round 37/38 entries; this section is the UI bug half of that message.

**Root cause, confirmed by direct code inspection then live-verified with
Playwright.** `maybeRequestGeminiTieBreak`'s async fetch can resolve
anywhere from milliseconds to `AbortSignal.timeout(30_000)` later -
completely asynchronous to whatever the viewer is doing right now - and,
until this round, unconditionally called `renderSections()` the instant a
`pickId` came back, which rebuilds `recommendedListEl`'s entire child list
from scratch (every `<img>` team-logo element recreated, not reused).
`buildMatchStack`'s own swipe-drag state (`activePointerId`,
`setPointerCapture`) lives in a closure bound to ONE specific card DOM
node - if that exact node gets removed mid-drag (a `renderSections()`
firing while `pointerdown` has already fired but `pointerup` hasn't), the
browser has nowhere left to deliver the rest of that gesture's move/up
events, exactly matching "swipe get a bit weird or unable to use" (the
finger is still down, but the gesture it started can no longer complete).
The team-logo flash is the same mechanism's more visible half: a fresh
`<img>` element forces a repaint even when the underlying data is
unchanged.

**Live-tested twice this session already, unknowingly - Gemini's answer
agreed with the deterministic pick BOTH times** (Round 37, Round 38 with
grounding) - meaning both of Round 38's own real, billed API calls forced
a full section rebuild for **zero visible change**, the worst case of this
bug: paying the flash/gesture-breaking cost with no benefit at all.

**Fix, two parts:**
1. `renderSections()` itself now defers while any card is mid-drag
   (`activeSwipeCount`, incremented in `buildMatchStack`'s own pointerdown,
   decremented via `resetDrag` - which every one of `endDrag`/
   `pointercancel`/`lostpointercapture` already funnels through) - the
   moment the gesture ends, the deferred render flushes for real via
   `stopTrackingSwipe`. Deferred, never dropped.
2. `maybeRequestGeminiTieBreak` now skips the render call entirely when
   Gemini's pick doesn't actually change anything on screen
   (`pickId !== close[0].id` - `close[0]` is already the natural top pick,
   see `selectGeminiTieBreakCandidates`), and when the viewer has since
   navigated off that day. This directly fixes the "zero-benefit rebuild"
   case both of this session's real Gemini calls hit.

**Important scope finding:** this bug was NOT exclusive to Gemini. The
app's own pre-existing live-score/odds poll (`pollLiveMatches` →
`recomputeAndRender` → `renderSections()`, running independently of
Gemini since well before Round 32) goes through the exact same
`renderSections()` function and was equally capable of interrupting a
swipe - confirmed directly with an isolated Playwright test (blocking
every network call except a mocked Gemini response still lost a DOM
marker on an unrelated poll tick; blocking EVERY network call including
that poll, with only the Gemini mock live, correctly preserved it). Fixing
the guard inside `renderSections()` itself, rather than only at the
Gemini call site, covers both sources with one change.

**Verification.** No unit-test coverage exists for `app.js` (browser-only
UI code, verified via Playwright per this repo's established convention -
see README). Three real, end-to-end Playwright scenarios, each seeding a
real `matchfind-match-snapshot` from live-fetched data so real swipeable
stacks render without needing network access in this sandbox:
1. A real `pointerdown`→`pointermove` drag held open while a mocked (zero-
   cost, `page.route`-intercepted) `/match-recommend` response - forcing a
   DIFFERENT pick than the natural default - resolves mid-drag: the
   dragged card stays in the DOM, untouched, for the whole gesture; ending
   the drag completes normally with no exception.
2. Same setup, but the drag is released BELOW the commit threshold (a
   snap-back, no user-driven pin) - the forced Gemini pick still correctly
   applies afterward (the stack's active dot moves to the new pick),
   proving the deferred render is flushed, never silently lost.
3. Isolated the "skip when unchanged" optimization specifically: with every
   non-Gemini network call blocked, a Gemini response that agrees with the
   natural pick causes NO re-render at all (a test marker set on the
   live-DOM `<img>` node survives); with the pre-existing live-poll left
   unblocked, the same marker is lost on its own separate tick - confirming
   both the fix's correctness and the pre-existing poll's own equal
   exposure to this bug before this round's `renderSections()`-level guard.

Full suite: **391/391** (no `recommendation.mjs`/scoring changes this
round - this is purely `public/app.js`'s render/gesture plumbing).

## Round 40 (2026-09-22): raising skill's weight, deliberately - a direct instruction, verified with real numbers before shipping, not overfit to one date

Direct follow-up to the same message that reported Round 39's UI bug:
"maybe your prompt is bad cause I honestly think it ain't right, I know
it's close but this ain't right" - continued disagreement with the
Guardians/Red Sox pick even after Round 38's grounded Gemini call
independently reached the same conclusion. Asked directly what the real
criterion was, rather than guessing again: "I want quality/star teams
prioritized, period."

**This is exactly Round 33's own already-explored axis, tested with fresh
data instead of assumed settled.** Round 33's grid search (2026-09-21
data) found that no reweighting of the five `BEST_MATCH_WEIGHTS` axes could
flip Guardians/Red Sox → Brewers/Phillies without also flipping the
already-correct 9/26 Chicago Cubs @ Boston Red Sox → Tampa Bay Rays @
Philadelphia Phillies - same shape, a lower-skill-but-tenser team vs. a
higher-skill-but-more-comfortable one. Re-derived this algebraically
against TODAY's live data (not assumed from a week-old search): letting
`d` be how much weight moves from `competitiveness` into `skill` (every
other weight held fixed), 2026-09-24 needs `d > 0.10` to flip
(Guardians/Red Sox 7.35−2d vs. Brewers/Phillies 7.05+d), while 2026-09-26
sits at an EXACT tie at `d = 0.10` (Cubs/Red Sox 7.05−2d vs. Rays/Phillies
a constant 6.85, since skill and competitiveness are equal there) - any
`d` large enough to fix one day necessarily flips the other too. Same
structural conflict, independently reproduced on fresh data a week later -
strong evidence this is real and structural, not a one-week coincidence.

**Put the real trade-off to the user directly, with the actual numbers,
before touching any code** - "yes, Rays/Phillies would be correct on
9/26/27 too" was the explicit answer, accepting the consequence rather
than a blind implementation.

**Implementation.** `BEST_MATCH_WEIGHTS.skill` 0.2 → 0.35,
`competitiveness` 0.2 → 0.05 (both other axes unchanged; still sums to 1).
Verified two ways before shipping:
1. A live scan across EVERY currently-fetched MLB/NBA/EPL/F1 fixture
   comparing old-weight vs. new-weight top-score-per-day-per-sport:
   **exactly six flips, all MLB**, all the intended class of case
   (2026-09-23/24/25 → Brewers/Phillies-shaped picks, 2026-09-26/27/28 →
   Rays/Phillies) - zero unintended reordering in any other sport or day.
2. `scripts/dump-day-plan.mjs` end to end (the real scheduler, not just the
   raw score): 9/23-25 now correctly recommend Milwaukee Brewers @
   Philadelphia Phillies (still alongside San Diego Padres @ Los Angeles
   Dodgers, unaffected), and 9/26/27 now correctly recommend Tampa Bay Rays
   @ Philadelphia Phillies, exactly as confirmed.

Added a dedicated regression test using the real 9/24 numbers (deliberately
real, not synthetic, so it would have failed against the OLD weights) -
full suite **392/392**. No `Shared-Proxy`/Gemini changes this round - this
is entirely the deterministic engine's own weighting, `public/lib/
recommendation.mjs` only.

## Round 41 (2026-09-22): Gemini removed entirely (again), skill-priority reweight extended cross-sport, and a bounded back-to-back variety pass with an elite exemption

Four items reported together in one message.

**1. Gemini removed from Match Find entirely, again.** Direct instruction:
"the credits it's burning is way beyond its improvement to our system."
This is the third time this project has added and then removed a Gemini
call (Round 11's per-fixture validation, then Round 32-38's much narrower
bounded daily tie-break) - see README.md's own "The Gemini tie-break"
section for the condensed history. Deleted outright, not just disabled,
per this codebase's own "don't keep unused code around" convention:
`selectGeminiTieBreakCandidates`/`buildGeminiTieBreakPayload`/
`tieBreakCandidateKey`/`resolveGeminiOverridePin`/
`computeDayPlanWithGeminiTieBreak`/`GEMINI_TIE_BREAK_MAX_CANDIDATES` from
`public/lib/recommendation.mjs`; `MATCH_RECOMMEND_PROXY_URL`/
`maybeRequestGeminiTieBreak`/`loadGeminiTieBreakCache`/
`saveGeminiTieBreakCache`/the whole Gemini cache section from `public/
app.js` (`renderRecommendedSection` now calls `computeDayPlan` directly
again); and the entire `/match-recommend` route (`handleMatchRecommendRequest`
and its dozen `MATCH_RECOMMEND_*` constants) from `jaypengx-collab/
shared-proxy`'s `worker.js`, along with `/match-recommend`'s entry in
`GEMINI_BILLED_PATHS` and every stale doc cross-reference in both repos'
README.md.

This also fixed a real, separately-reported bug: **"every first game
recommended of the day is 偏好 ('Prefer') rather than 推薦
('Recommended')."** Root cause: `computeDayPlanWithGeminiTieBreak` forced
a valid Gemini answer in via `computeDayPlan`'s `pinnedForDay`/`forcedIds`
mechanism (Round 35's own design - "the exact same mechanism a viewer's
own swipe-to-pin already uses"), and `computeDayPlan` marks
`.isPreferred = forcedIds.has(choice.id)` with NO distinction between "the
viewer pinned this" and "Gemini's override forced this in" - both paths
set the exact same flag. `buildMatchCard` renders 偏好 whenever
`.isPreferred` is true, so a day whose headline slot got a live-cached
Gemini override showed the viewer's-own-choice tag on a pick the viewer
never touched. Since Gemini's tie-break specifically targets each day's
own closest-margin slot (`selectGeminiTieBreakCandidates`), and that's
disproportionately likely to BE the day's first/headline card, this read
exactly as reported. With Gemini's code path deleted, `forcedIds` can only
ever come from a genuine `state.pinnedChoices` entry again (written only by
`pinSlotChoice`/`preferMatch`, both real user swipes) - structurally
impossible to recur, verified with a real Playwright load (seeded from a
real fetched-data localStorage snapshot, `matchfind-match-snapshot`, per
this doc's own established zero-cost verification pattern): zero
`pageerror`s, four visible recommended-tags, all four read 推薦, zero
`.is-preferred` elements, with no pins set.

**2. "Prioritize quality/star teams" (Round 39's `BEST_MATCH_WEIGHTS`
reweight) confirmed to already apply to NBA/EPL, not just MLB.**
`bestMatchScore`/`computeEffectiveScore` blend all five axes
(`skill`/`competitiveness`/`watchability`/`enduranceScore`/
`broadcastQuality`) identically for every sport - there is no MLB-only
gate anywhere in that path, and `computeNbaObjectiveScore`/
`computeEplObjectiveScore` both already set `.skill` from `skillFromWinPct`
the same way `computeMlbObjectiveScore` does. Verified live rather than
assumed: a fresh EPL fetch (2026-09-22) already ranks Sunderland @
Manchester City (skill 10, competitiveness 1) above Crystal Palace @ Leeds
United (skill 3, competitiveness 6) under the current weights - correctly
prioritizing the star club over a closer-on-paper mismatch. NBA had zero
fetchable fixtures at verification time (the real 2026-27 season hadn't
started yet; Round 25 already excludes preseason entirely), so it
couldn't be checked against real data this round, but runs through the
identical code path with no special-casing. No code change was needed for
this item - it was already correct by construction; this is a
verification-only entry.

**3. Bounded back-to-back variety, with a real elite exemption.** Direct
feedback: "if a lot of back to back games happen it will result in three
straight days recommending the same match, I don't like that... but real
good games get kept, like the Dodgers @ Padres back-to-back game." Round
25 removed an earlier, much broader cross-day repeat penalty
(`RECENT_REPEAT_PENALTY_BY_GAP_DAYS`/`recentRepeatPenalty`/
`SPORT_CONCENTRATION_*`) entirely, because it compared today's pick
against ANY recent day in the whole fetched window (including weekdays
this viewer doesn't watch), which silently buried a genuinely great
weekend game for a "variety" benefit that never applied to him. This
round's version is deliberately narrower in exactly the way that matters:

- `VARIETY_MAX_FREE_REPEATS = 2` - only ever looks at the real two
  immediately PRECEDING calendar days, never anywhere else in the window.
- `VARIETY_ELITE_SKILL_THRESHOLD = 7` - a matchup whose `skill` (the same
  field Round 39 now weighs most heavily) reaches 7 (the better team
  having at least a .600-equivalent winning percentage) is EXEMPT no
  matter how many days straight it's recommended. Deliberately an
  ABSOLUTE bar on `skill` itself, not on `bestMatchScore`/`planningScore` -
  those are relative to whatever else is on that specific day, so a
  genuinely great matchup on an otherwise-quiet day could read as
  "marginal" for reasons that have nothing to do with how good it
  actually is, which is exactly the wrong signal for "is this a real good
  game."
- `VARIETY_REPEAT_PENALTY = 1` - a `planningScore` nudge (same
  insertion point `applyLiveExcitementBonus` already uses), sized well
  under `ALTERNATIVE_MAX_SCORE_GAP` (2.5) so a genuinely close call gets
  flipped once repeated but a decisively-better repeat still wins on
  merit even penalized.

New exports in `public/lib/recommendation.mjs`: `isVarietyExempt`,
`recommendedMatchupKeys` (runs `computeDayPlan` on a day purely to read
back which matchup(s) won, reusing the existing `matchupKey` diagnostic),
and `applyVarietyPenalty`. Wired into `app.js`'s `dayCandidatesForPlan`
(the single function both `renderRecommendedSection` and `pinSlotChoice`'s
own "natural pick" question already share) via a new
`recentMatchupKeySets(dayKey)` that walks `state.days` backward up to
`VARIETY_MAX_FREE_REPEATS` days and scores each one's own NATURAL
(pre-variety) plan - deliberately NOT recursive into those prior days' own
variety adjustment, a conscious simplification to keep this a bounded,
O(1)-extra-work lookup rather than a chain that could walk arbitrarily far
back through the whole fetched window chasing an already-varied answer.
`scripts/dump-day-plan.mjs` was updated to mirror this exact behavior
(tracking each processed day's own recommended matchup keys as it goes,
chronologically) so it stays useful as a live cross-check against
`app.js`'s real behavior.

Live-verified against the real 2026-09-22 fetch two ways:
1. `dump-day-plan.mjs` for 2026-09-22 → 2026-09-27, MLB: Milwaukee Brewers
   @ Philadelphia Phillies (skill 8) and San Diego Padres @ Los Angeles
   Dodgers (skill 7) both naturally repeat as top picks for all 3 real
   consecutive days they play (09-23 through 09-25) - both elite-exempt
   (`skill` ≥ 7), so variety makes no difference to either, exactly the
   "keep real good games" case the user pointed at by name.
2. A dedicated before/after diff script comparing the whole fetched
   window's own recommended-matches list with and without
   `applyVarietyPenalty` applied: **zero days differ, 0/11**. This is the
   correct, intended result given today's real data - not evidence the
   feature does nothing, since the two real repeats happening right now
   are genuinely elite-caliber and were never going to be varied away.

Since no real "mediocre matchup repeats 3 days" case currently exists in
the live data to observe the penalty actually firing, this was verified
with a dedicated unit test using clearly-labeled synthetic numbers: a
skill-5 matchup that already won two straight days loses its 3rd to a
fresh, only-slightly-worse (but non-repeating) alternative once penalized;
an identically-shaped skill-8 "elite" repeat (modeled directly on the real
live Brewers/Phillies case) keeps winning its 3rd straight day unchanged.
Six more tests cover `isVarietyExempt`/`recommendedMatchupKeys`/
`applyVarietyPenalty` individually (multi-slot days, missing-skill
handling, matching-a-different-matchup-than-the-one-repeating, and the
"fewer than 2 prior days on record" no-op case).

Full suite **385/385** (the 17-test Gemini describe block was deleted
along with the feature; 10 new variety tests added, net -7 from Round 40's
392).

**4. No formula/prompt "tie-break disagreement" work this round** - moot,
since item 1 removed the only mechanism that could disagree with the
deterministic engine's own pick in the first place. The deterministic
engine (`public/lib/recommendation.mjs`) is Match Find's sole
recommendation logic now, for the second time in this project's history.

## Round 42 (2026-09-22): fixed the back-to-back variety exemption criterion - a real margin, not an absolute skill bar

Direct correction to Round 41's variety feature, same day: "I want
variety, because the Brewer time they got equal match ups[,] the dodger
one in it's time it's the best[,] no alternative."

**What was wrong.** Round 41's `isVarietyExempt` exempted any matchup once
its own `skill` reached 7 (the same field `BEST_MATCH_WEIGHTS` weighs
heavily). That reasoning conflated two different questions: "is this
matchup good in isolation" and "does the viewer actually have something
comparable to rotate to instead." Milwaukee Brewers @ Philadelphia
Phillies (skill 8) got wrongly exempted under the old rule even though its
own real time slot has several genuinely close alternatives every day it
repeats (Cleveland Guardians @ Boston Red Sox, Tampa Bay Rays @ New York
Yankees, etc.) - exactly the "equal match ups" case the user says should
get varied. San Diego Padres @ Los Angeles Dodgers (skill 7) happened to
ALSO get exempted under the old rule, which looked right, but for the
wrong reason - it's actually exempt because nothing else that late in the
day comes remotely close, not because of its skill number.

**A second, intermediate attempt** (exempt whenever `.alternativeIds` is
merely non-empty, dropping skill entirely) was checked against real
numbers before shipping and also found wanting: `ALTERNATIVE_MAX_SCORE_GAP`
(2.5, this file's own "worth a swipe" bar for the UI) is deliberately
generous, so Padres @ Dodgers technically HAS an `.alternativeIds` entry
every single day too (Houston Astros @ Seattle Mariners etc.) - a
boolean "has an alternative at all" doesn't distinguish it from Brewers @
Phillies.

**The real signal, confirmed against live data**, is the MARGIN over the
closest real alternative, not merely whether one exists:

| Date | Matchup | Margin over closest same-slot rival |
| --- | --- | --- |
| 09-22 | Toronto Blue Jays @ Baltimore Orioles | 0.55 |
| 09-23 | Milwaukee Brewers @ Philadelphia Phillies | 0.40 |
| 09-23 | San Diego Padres @ Los Angeles Dodgers | 1.00 |
| 09-24 | Milwaukee Brewers @ Philadelphia Phillies | 0.15 |
| 09-24 | San Diego Padres @ Los Angeles Dodgers | 0.75 |
| 09-25 | Milwaukee Brewers @ Philadelphia Phillies | 0.45 |
| 09-25 | San Diego Padres @ Los Angeles Dodgers | 0.95 |
| 09-26 | Tampa Bay Rays @ Philadelphia Phillies | 0.10 |
| 09-27 | Tampa Bay Rays @ Philadelphia Phillies | 0.10 |

Brewers/Phillies never exceeds 0.45; Padres/Dodgers never drops below
0.75 - a genuine, real dividing line, not a coincidence of one date.

**Implementation.** `computeDayPlan` (`public/lib/recommendation.mjs`) now
sets `choice.closestAlternativeGap` alongside `choice.alternativeIds` -
`Math.min(...alternatives.map(m => pickedScore - getScore(m)))`, `null`
when there's no alternative at all (reset at the top of every call, same
as `.alternativeIds`). `isVarietyExempt` is now:

```js
export const VARIETY_CLOSE_CALL_GAP = 0.5;
export function isVarietyExempt(match) {
  return !Number.isFinite(match.closestAlternativeGap) || match.closestAlternativeGap > VARIETY_CLOSE_CALL_GAP;
}
```

0.5 sits directly between the two live ranges above (Brewers tops out at
0.45, Dodgers bottoms out at 0.75) - chosen because a real dividing line
exists there, not picked first and hoped for.

This changes `dayCandidatesForPlan`'s own contract in `app.js`:
`.closestAlternativeGap` only exists once `computeDayPlan` has actually
run once, so `applyVarietyPenalty` can no longer be called on a bare,
never-scheduled candidate list. `dayCandidatesForPlan` now runs
`computeDayPlan` TWICE - a natural pass (today's real pins respected, no
variety penalty yet) purely to populate `.closestAlternativeGap`, then
`applyVarietyPenalty`, then the caller's own final `computeDayPlan` call
with the now-penalized `planningScore`. Safe by the same reasoning
`computeDayPlanWithGeminiTieBreak` (now-removed) already established:
`computeDayPlan` resets every match's own scheduling fields at the top of
each call, so calling it twice on the same array is idempotent except for
which call's result is left mutated on afterward. `scripts/
dump-day-plan.mjs` was updated the same way (natural pass, then
`applyVarietyPenalty`, then the real pass).

**Live-verified end to end**: `dump-day-plan.mjs` for 2026-09-22 through
09-27, MLB - 09-23/09-24 still show both Brewers/Phillies and
Padres/Dodgers (within the 2-free-repeats allowance). 09-25 (the would-be
3rd straight day for both): Brewers/Phillies is correctly varied away to
Tampa Bay Rays @ New York Yankees (its own close rival, matching the
"equal match ups" description), while Padres/Dodgers correctly keeps
winning unchanged (its own wide margin, matching "the best, no
alternative"). A before/after diff across the whole fetched window shows
**exactly 1 day differs (2026-09-25)** - precisely the intended, and only
the intended, change; every other day (including every non-MLB sport) is
byte-identical to the no-variety baseline.

Rewrote the Round 41 unit tests to use `closestAlternativeGap` directly
(the real live numbers above, not synthetic skill values) rather than
`alternativeIds` presence or skill. Full suite **386/386**.

## Round 43 (2026-09-22): back-to-back variety redesigned as a whole-window rotation

Direct correction, same day as Round 42: "No it should first determine how
many days, then see how many alternative, if there is alternative more
than one, then three day mean each winning once."

**What was wrong.** Rounds 41/42 only ever penalized the CURRENT
incumbent once it had already won its slot twice in a row, handing the
very next day to whichever single alternative happened to be closest that
specific day. On a real 3-day run with two or more genuinely close
alternatives, this never gave more than one of them an actual turn - the
incumbent still won 2 of the 3 days, an alternative got the 3rd, and any
OTHER real alternative never appeared at all.

**Two clarifying questions asked before implementing** (a real design
fork, not something inferable from the request alone): (1) whether
rotation should look at the whole known span at once (since every day's
match data is already fetched, unlike a live system that only ever learns
about "tomorrow" when it arrives) or decide day-by-day looking only
backward; the user chose the whole-span option. (2) which alternatives
count as real rotation contenders - only genuinely close ones (within
`VARIETY_CLOSE_CALL_GAP`) or any swipeable one (the wider
`ALTERNATIVE_MAX_SCORE_GAP`); the user chose the tighter, close-only pool.

**Implementation** (`public/lib/recommendation.mjs`):

- `computeVarietyRotation(matchesByDayKey, pinnedChoices)` - the one new
  entry point. Runs a natural `computeDayPlan` pass over EVERY day in the
  window first (respecting real pins), then detects maximal consecutive
  runs per `matchupKey` (walking chronologically; a day genuinely absent
  from the window, or present with zero matches, correctly closes any
  active run rather than letting it silently bridge across a real gap -
  a viewer's own pin to a DIFFERENT matchup has exactly the same
  run-breaking effect, so a pin can never be overridden by rotation:
  it just never becomes part of a run in the first place).
- For each run of 2+ days, builds the POOL: the run's own matchupKey plus
  every OTHER matchupKey that was a real close alternative (per
  `closeAlternativeMatches`, gated by `VARIETY_CLOSE_CALL_GAP`) on ANY
  day of the run - not just the specific day being decided.
- If the pool has more than one member, cycles a deterministic rotation
  order (`[runMatchupKey, ...otherPoolKeysSortedAlphabetically]`) across
  the run's own days, `pool[i % pool.length]` for day index `i`. If the
  day `i`'s assigned pool member ISN'T actually a close alternative on
  that SPECIFIC day (it only earned its pool seat on a different day of
  the run), forcing is skipped entirely for that day rather than
  manufacturing a close call that isn't real - the natural pick stands.
- To force a non-incumbent day, EVERY other pool member close that day
  (not just the incumbent) gets penalized enough to lose to the assigned
  winner - a real bug caught before shipping: an early version only
  penalized the incumbent, which correctly stopped the incumbent from
  winning but then let a THIRD pool member (present but unpenalized) win
  by accident instead of the intended assignee, confirmed with a debug
  script against exactly this 3-contender shape before it ever reached
  the real dataset.
- `applyVarietyRotationPenalties(dayMatches, penaltyByMatchId)` applies
  one day's own slice of the whole-window plan.

`app.js`'s `dayCandidatesForPlan` no longer does its own two-pass dance -
`getVarietyRotation()` memoizes the whole-window plan (invalidated by
`invalidateVarietyRotation()`, called from `applyEnabledSportsAndRender`
- covering both a fresh data build and an enabled-sports toggle -
`pinSlotChoice`, and the sport-filter chip's own click handler, every real
place the underlying candidate set can change) so a routine render just
looks up its own day's slice rather than recomputing the whole window
every time. `scripts/dump-day-plan.mjs` was updated to mirror the same
two-step shape (one whole-window `computeVarietyRotation` call, then each
day's own final `computeDayPlan`).

**Live-verified against the real 2026-09-22 fetch**: Milwaukee Brewers @
Philadelphia Phillies's own 3-day run (09-23/24/25) has a REAL pool of 4
members (itself plus Cleveland Guardians @ Boston Red Sox, Miami Marlins @
Chicago Cubs, and Tampa Bay Rays @ New York Yankees, each close on at
least one of the 3 days) - more contenders than days, so a perfect
one-each rotation isn't mathematically achievable regardless of algorithm.
Actual result: 09-23 Brewers (day 1, its own natural turn), 09-24 rotates
correctly to Guardians @ Red Sox (close that day), 09-25 the rotation's
own next assignee (Marlins @ Cubs) wasn't actually close that specific
day, so forcing was correctly skipped and Brewers naturally won again -
the algorithm's own honest, non-fabricating behavior rather than a bug.
San Diego Padres @ Los Angeles Dodgers stayed untouched across all 3 days
(pool size 1 - nothing ever genuinely close). Separately, Tampa Bay Rays @
Philadelphia Phillies's own 2-day run (09-26/27) has exactly one real
alternative (Baltimore Orioles @ New York Yankees) and rotates cleanly:
Rays keeps day 1, Orioles/Yankees gets day 2. A before/after diff across
the whole fetched window confirms exactly these 2 days differ
(2026-09-24, 2026-09-27) - zero unintended changes anywhere else,
including every non-MLB sport.

Rewrote the Round 41/42 unit tests entirely around `computeVarietyRotation`/
`applyVarietyRotationPenalties` - a single-day "run" (never touched), the
real wide-margin Padres @ Dodgers shape (never touched regardless of
repeat count), a 2-day run with one real alternative (alternates), an
end-to-end 3-day/3-contender case (each of the three wins exactly once,
the literal case reported), a real gap day correctly breaking what would
otherwise look like a continuous run, and a viewer's own pin never being
overridden. Full suite **383/383** (net -3 from Round 42's 386: the
9-test Round 41/42 describe block was replaced with a smaller, more
end-to-end-focused set).

Also verified end-to-end in a real browser (Playwright, seeded from a
real fetched-data localStorage snapshot per this doc's own established
zero-cost pattern): zero `pageerror`s loading the page and navigating
across multiple day tabs, confirming `getVarietyRotation`'s memoization/
invalidation wiring doesn't crash or throw across real render cycles.

## Round 44 (2026-09-22): two more corrections to the whole-window rotation, both caught before shipping via live-data debugging

Two separate issues found while verifying Round 43 against the real
2026-09-22 fetch, same day.

**1. "if Brewer win day three outright then day one should be someone
else."** Direct correction to Round 43's own first cut, which used a
fixed `pool[i % pool.length]` assignment: day `i` of a run always got
`pool[i]` regardless of what happened on other days. Live-tested against
the real Milwaukee Brewers @ Philadelphia Phillies 3-day run
(09-23/24/25): its real pool has 3 members (itself, Cleveland Guardians @
Boston Red Sox - close all 3 days, Tampa Bay Rays @ New York Yankees -
close only on 09-24). The fixed rotation assigned day 3 (09-25) to a pool
position that, on investigation, mapped to whichever member the day index
landed on - and because that assignment sometimes wasn't actually close on
that SPECIFIC day, forcing was skipped and the incumbent won BOTH day 1
and day 3, while Tampa Bay Rays @ New York Yankees (only close on day 2)
never won at all. Replaced the fixed rotation with a proper maximum
bipartite matching (Kuhn's algorithm): days on one side, pool members on
the other, an edge wherever `eligibleDaysByMember` says a member was
actually close on that specific day. Members are tried scarcest-first (a
rarely-close alternative, eligible on only one day, has to claim it before
the incumbent - eligible every day of the run - greedily takes it
instead). Verified: Brewers @ Phillies's real 3-member/3-day case now
gives each member exactly one win (09-23 Brewers, 09-24 Rays @ Yankees,
09-25 Guardians @ Red Sox in one live run, or an equally-valid permutation
depending on the exact tie-break state - the invariant checked is "each of
the three wins exactly once", not a specific day assignment).

**2. A real bug caught mid-verification, before it ever reached the live
site**: forcing a rotation assignment by PENALIZING the incumbent's own
`planningScore` (Round 43's own mechanism) only ever guaranteed the
incumbent LOST - not that the intended rotation winner in particular WON.
Debugging the real Brewers run's day 3 (09-25) revealed exactly why:
`computeDayPlan` re-solves the WHOLE day's schedule fresh once a score
changes (via `weightedIntervalSchedule`), and penalizing Brewers by 0.46 to
hand its slot to Cleveland Guardians @ Boston Red Sox instead actually
handed it to Tampa Bay Rays @ New York Yankees - a match NOT in Brewers'
own near-total-overlap cluster (so absent from its `.alternativeIds`,
hence never considered part of the rotation's own pool for that day) that
still genuinely conflicted with Brewers/Guardians' time slot in the DP's
own real-interval sense and simply scored higher than Guardians once
Brewers dropped. A soft nudge has no way to account for a competitor
outside its own pool; only an outright FORCE does. Replaced the
score-penalty mechanism entirely:

- `computeVarietyRotation` now returns `Map<dayKey, Set<matchId>>` (which
  id(s) must be forced to win that day) instead of `Map<dayKey,
  Map<matchId, penalty>>`.
- `mergeVarietyForcedIds(pinnedForDay, forcedIds)` merges the rotation's
  own forced id(s) into the SAME `pinnedForDay` a real viewer's own
  swipe-to-pin already uses - `computeDayPlan`'s own `forcedIds`/
  `excludedIds` mechanism then guarantees the assignment wins its slot
  unconditionally, the identical guarantee a real pin has, with the same
  correct exclusion of any other near-total-overlap conflict.
  `applyVarietyRotationPenalties` (the old penalty-applier) is deleted.
- Since `computeDayPlan`'s forced-pick mechanism marks every forced id
  `.isPreferred = true` (no distinction between "the viewer pinned this"
  and "a system process forced this in" - the EXACT Round 41 bug that got
  Gemini's own forced override removed for mislabeling 推薦 as 偏好),
  `clearRotationIsPreferred(dayMatches, forcedIds, pinnedForDay)` puts the
  correct `.isPreferred = false` back immediately after the real, final
  `computeDayPlan` call, for every id ONLY rotation forced in (never
  touching an id that's ALSO a genuine pin).

**3. A related tie-break refinement, found live-testing the SAME Rays @
Phillies 2-day run (09-26/27)**: its real pool has TWO other matchups tied
with it at "close every day" (Baltimore Orioles @ New York Yankees, Chicago
Cubs @ Boston Red Sox) - a genuine 3-way tie for only 2 days, so one member
necessarily can't be placed regardless of tie-break order. The first
version's pure-alphabetical tie-break among equal-scarcity members
happened to rank the incumbent (Rays @ Phillies) last, so the actual best
natural pick won NEITHER of its own two days - overcorrecting well past
"add variety" into "the best team never wins". Fixed by giving the run's
own matchupKey first claim specifically among members tied at the SAME
scarcity (a genuinely scarcer alternative - fewer eligible days - still
outranks the incumbent, as intended; only an EQUAL-scarcity tie now favors
it). Verified: the real Rays @ Phillies run now correctly keeps one of its
two days.

**Full live re-verification after both fixes**: `dump-day-plan.mjs` for
2026-09-22 through 09-27, MLB - Brewers @ Phillies's 3-day run splits
09-23/24/25 across all three real contenders, one win each. Rays @
Phillies's 2-day run gives the incumbent one of its two days (09-27) and
Baltimore Orioles @ New York Yankees the other (09-26). Padres @ Dodgers
stays untouched throughout both runs' whole span. A before/after diff
across the whole fetched window shows exactly 3 intended days differ, zero
unintended changes anywhere else (including every non-MLB sport), and a
direct check confirms zero `.isPreferred` mislabels anywhere in the window
with no real pins set (matching Round 41's own original bug report).
Re-verified once more in a real browser via Playwright (seeded from a real
fetched-data localStorage snapshot): zero `pageerror`s, all visible
recommended-tags correctly read 推薦.

Rewrote the variety test suite around the new forced-id contract:
`mergeVarietyForcedIds`/`clearRotationIsPreferred` tested directly, a
dedicated regression test reproducing the exact "outside-the-pool
candidate steals the slot" live bug (proving the hard-force fix), the
3-day/3-contender end-to-end case (now also asserting `isPreferred` stays
false throughout), and a new dedicated test for the 3-way-tie-over-2-days
shape confirming the incumbent still wins at least one of its own days.
Full suite **389/389**.

## Round 45 (2026-09-22): finished match durations stop growing across refreshes

Direct question: "Why today's finished MLB match and yesterday finished
MLB match's duration weirdly long compared to upcoming matches."

**Root cause.** `finishedDurationMinutes` (`public/lib/match-builder.mjs`)
computes a finished fixture's own duration as `now - startTimeUtc`,
clamped to a per-sport cap (`FINISHED_DURATION_CAP_MINUTES_BY_SPORT`,
MLB = 360 minutes). Its own doc comment explicitly assumed this ran ONCE,
shortly after the match ended, on the app's old 15-minute GitHub Actions
cron - a stale assumption: `scripts/build-data.mjs`'s own top comment
confirms there is no scheduled rebuild anymore. `buildMatches()` runs
live, in the browser, on BOTH `refreshNearTerm` (60s) and
`refreshFullWindow` (5min) - meaning `finishedDurationMinutes` recomputes
`now - start` fresh on every single one of those polls, for as long as the
match stays in the fetched window (today + 1 day back). "Now" keeps
advancing for as long as a tab stays open or a viewer revisits later, so
the SAME finished match's own reported duration kept growing toward its
360-minute cap purely from elapsed VIEWING time, nothing about the real
broadcast.

`app.js`'s `mergeFreshMatches` already had a carry-forward mechanism for
exactly this class of problem (Round 29's own live-duration-flicker fix),
but its condition (`previous?.live && !m.isFinished`) only protected a
match WHILE it was still live - the instant `isFinished` flips true, that
protection stops and every subsequent refresh's fresh
`finishedDurationMinutes` call overwrites it again, unprotected, forever.

**Live-confirmed against the real fetch** (rebuilt live, 2026-09-22
~13:47 Taiwan time): "Toronto Blue Jays @ Baltimore Orioles" and
"Washington Nationals @ Detroit Tigers" (both finished the day before,
2026-09-21) sat at exactly `durationMinutes: 360` - the MLB cap, hit
because both finished roughly 7+ hours before this exact fetch. "Minnesota
Twins @ San Francisco Giants" (finished earlier the SAME day) sat at 243 -
already inflated, just not yet capped. An upcoming MLB fixture's own flat
pre-game estimate is 190 minutes (`LEAGUES.mlb.durationMinutes`,
match-builder.mjs) - both numbers read as "weirdly long" right next to it,
exactly as reported, and `buildMatchCard`'s own displayed end time
(`start + durationMinutes`, app.js) shows this directly on the card, not
just internally.

**Fix**: extended `mergeFreshMatches`'s own carry-forward condition
(`public/app.js`) - once a match was EITHER already finished OR being
live-tracked on the previous merge, and the fresh build ALSO reports it
finished, `durationMinutes` is now carried forward (frozen) from
`previous` instead of accepting the fresh, wall-clock-inflated
recomputation:

```js
if (previous?.live && !m.isFinished) {
  m.live = previous.live;
  m.durationMinutes = previous.durationMinutes;
} else if (m.isFinished && previous && (previous.isFinished || previous.live)) {
  m.durationMinutes = previous.durationMinutes;
}
```

This freezes a finished match's duration at the BEST available real
number the first time this browser ever saw it finished: if it was
tracked live right up to the final whistle, that's `pollLiveMatches`'s own
last live-corrected `estimateLiveDurationMinutes` value (frozen the
instant that function's own `!update.isFinished` guard stops updating it,
right when `isFinished` first flips true) - a real, progress-based
estimate, not a wall-clock guess. Otherwise (a fixture first ever seen
already finished, e.g. after a browser restart past the live window) it
freezes at `finishedDurationMinutes`'s own first honest `now - start`
guess, which then never grows further no matter how much later the
viewer keeps looking at it. `finishedDurationMinutes` itself is
unchanged - the freeze lives one layer up, at the merge point, exactly
where the previous live-duration-flicker fix already lived.

**Verified end-to-end in a real browser** (Playwright, real network - no
mocking): seeded the exact real finished match above
(`durationMinutes: 243`, displayed end time `上午5:48`), let the real
initial fetch complete (unchanged), then advanced the page's own fake
clock by 3 hours and forced a real manual refresh (`refreshFullWindow` via
the "立即重新整理" button) - the SAME match's displayed end time stayed
`上午5:48`, byte-identical, instead of growing toward the 360-minute cap
as the old code would have. Zero page errors.

Also updated `MIN_FINISHED_DURATION_MINUTES`'s and
`FINISHED_DURATION_CAP_MINUTES_BY_SPORT`'s own comments in
match-builder.mjs, which still described the now-nonexistent 15-minute
cron, to point at this fix and explain the real, current polling
architecture instead.

Full suite **389/389** (no library-level test changes - the fix is
entirely in app.js's DOM/state glue layer, verified via the real-browser
Playwright check above rather than a node:test unit, matching this
codebase's own established split between public/lib/'s unit-tested pure
functions and app.js's Playwright-verified integration behavior).

## Round 45 follow-up (2026-09-22): freezing wasn't enough - first observation was already stale

Direct follow-up after the fix above shipped: "Still broke, spanning
across 6 hours so ridiculous."

**Root cause.** The freeze fix above only stops a finished match's
`durationMinutes` from GROWING after this browser's first sighting of it
finished. It does nothing for the much more common case this app's own
architecture now creates: the FIRST-ever observation of a match already
happens long after the real final out (no scheduled rebuild, continuous
in-browser polling, 1-day retention - see the root cause above). On that
first observation, `finishedDurationMinutes` still computed
`now - startTimeUtc`, found it far past MLB's then-360-minute cap, clamped
at exactly 360, and the freeze then locked that clamped-but-wrong number in
forever. Live-confirmed by rebuilding `matches.json` live: every MLB match
finished the day before (2026-09-21) or earlier sat at flat `360`, right
next to same-day matches finished a few hours ago sitting anywhere from
150-260 depending on real elapsed time - "spanning across 6 hours," exactly
as reported, because 360 minutes = 6 hours was itself the number on
screen.

**The deeper problem**: once a fetch happens this late, "elapsed time since
kickoff" simply isn't a duration signal anymore - it's dominated by how
long ago the tab was opened, not by how long the game ran. Clamping that
number at a cap and displaying the cap doesn't fix this - it just replaces
one wrong number (a huge elapsed-time reading) with a different wrong
number (an arbitrary ceiling), and freezes THAT in instead.

**Fix** (`public/lib/match-builder.mjs`):

1. Lowered each sport's own cap in `FINISHED_DURATION_CAP_MINUTES_BY_SPORT`
   to a genuinely realistic worst-case broadcast length rather than "high
   enough that a stale fetch looks obviously wrong" (MLB: 360 → 280, i.e.
   4h40m - still comfortably covers a real extra-innings marathon; MLB's
   actual all-time longest games run 6-8 hours, but those are rare enough,
   league-wide, across a whole decade, that this cap exists to bound the
   COMMON case of a normal game viewed hours or a day late, not the record
   book).
2. Gave `finishedDurationMinutes` a new 4th parameter,
   `pregameEstimateMinutes` - the SAME real per-fixture prediction
   (`computeDurationMinutes`, team/venue/broadcast/odds-informed) an
   upcoming match already shows. Every call site now computes this value
   unconditionally (regardless of `isFinished`) and passes it through. Once
   `elapsed minutes > cap`, the function no longer trusts "elapsed since
   start" as a length signal AT ALL - it returns the pre-game estimate
   instead of the cap itself:

   ```js
   export function finishedDurationMinutes(startTimeUtc, now, sport, pregameEstimateMinutes) {
     const elapsedMinutes = Math.round((now.getTime() - Date.parse(startTimeUtc)) / 60_000);
     const cap = FINISHED_DURATION_CAP_MINUTES_BY_SPORT[sport] ?? DEFAULT_FINISHED_DURATION_CAP_MINUTES;
     if (elapsedMinutes > cap) {
       return Number.isFinite(pregameEstimateMinutes)
         ? Math.max(MIN_FINISHED_DURATION_MINUTES, pregameEstimateMinutes)
         : cap;
     }
     return Math.max(MIN_FINISHED_DURATION_MINUTES, elapsedMinutes);
   }
   ```

   Both real call sites (`fetchTeamLeagueMatches`'s MLB/NBA/EPL branch and
   the F1 session loop) were restructured to compute their own pre-game
   estimate (`computeDurationMinutes(...)` / `predictF1RaceDurationMinutes`
   or `sessionType.durationMinutes`) once, unconditionally, and pass it as
   this 4th argument.

This composes with the Round 45 freeze fix rather than replacing it: the
freeze still stops the number from drifting further on later refreshes:
now it freezes onto an honest, fixture-aware estimate on the FIRST
observation too, instead of onto a clamped cap value.

**Live-verified** (rebuilt `matches.json` live, 2026-09-22): every finished
MLB match in the fetched window, including ones finished a full day and
~35 hours earlier, now shows 158-173 minutes - matching real per-team/venue
pre-game predictions - instead of a flat 280/360-minute cap. Finished EPL
matches (some ~41 hours old) now show a flat 113 minutes, EPL's own
realistic pre-game estimate, instead of the old 140-minute cap.

Added 3 new unit tests to `tests/match-builder.test.mjs`'s existing
`finishedDurationMinutes` suite: falls back to the real pre-game estimate
once elapsed time exceeds the cap; still falls back to the cap itself when
no pre-game estimate is available (defensive - every real call site always
provides one); a pre-game estimate below `MIN_FINISHED_DURATION_MINUTES` is
still floored. Full suite **392/392**.
