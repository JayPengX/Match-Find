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
  decided **per calendar day** by `computeDayPlan`, which already groups
  same-day, near-totally-overlapping fixtures into one slot
  (`groupIntoSlots`/`isNearTotalOverlap`, ≥75% overlap of the shorter
  match's duration) so two overlapping picks can never both be
  `recommended: true` on the same day. A 4-game series recommended on 4
  different dates is 4 distinct real events, each with its own plan — not
  one event duplicated. `scripts/evaluate-recommendations.mjs` (added,
  see below) reports this as a **recurring-matchup rate**, descriptively,
  not as an error, and `groupIntoSlots`'s own doc comment now says
  explicitly why cross-day repeats are out of scope for it.
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
computeRecommendationScore(match, { priorityOrder, myServiceIds, recommendStyle })
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
- **No cross-day diversity/series suppression**, by design — see "How
  the audit's claims line up" above. This is a deliberate product
  decision (a day-by-day plan, not a deduplicated feed), not an oversight,
  but it's a decision the repo owner should make explicitly if a future
  "top N picks across the week" view is ever added — `matchupKey` in the
  new evaluator is exactly the grouping key such a feature would need.
- **No behavioral feedback loop.** There's no click/watch/dismiss signal
  captured anywhere in this pipeline (it's a static site with no backend
  of its own beyond the shared scoring proxy), so `evaluateRecommendation`-
  style calibration against real user behavior (audit §17) isn't possible
  without adding that instrumentation first — out of scope here.
- **Explanations (`reason`) are still Gemini's own free-form text**, not
  assembled from the structured feature contributions in
  `scoreBreakdown` (audit §11). `scoreBreakdown` now exists and could
  feed a future template-based explanation, but `reason` itself is
  unchanged in this pass — rewriting the shared proxy's own prompt/schema
  is a change to a different repo (`jaypengx-collab/shared-proxy`) and
  wasn't made here.
