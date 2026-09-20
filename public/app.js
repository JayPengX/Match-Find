// ---- public/app.js ----
// Builds and renders the whole match list LIVE, in this browser - calling
// public/lib/match-builder.mjs's own buildMatches directly (through the
// shared proxy, since none of the underlying APIs sends CORS headers - see
// proxyFetchJson below), not by reading a static matches.json a scheduled
// GitHub Action rebuilt and redeployed every 15 minutes the way this used
// to work. That whole build-and-deploy cycle is gone: every viewer's own
// tab now fetches and scores fixtures itself, on load and on two
// recurring refresh tiers (see "Live match data" below) - genuinely live,
// not "as fresh as the last scheduled rebuild happened to be," and a
// manual refresh is now instant (this browser re-fetching and re-scoring
// directly) instead of waiting ~30-60 seconds for a CI build to finish and
// a new static file to deploy.
//
// This file still does everything that has to happen per viewer on top of
// that shared scoring:
//
//   - Converting every UTC kickoff to THIS viewer's own local time.
//   - Deciding which matches form "today's recommended lineup" - this has
//     to run here, not in the shared scoring, because "don't recommend a
//     match starting at 3am" and "which match is closest to right now" are
//     both relative to the viewer's own clock, and buildMatches's own
//     output is the same regardless of which timezone asked for it.
//
// The scoring itself (competitiveness/watchability/reason) is entirely
// deterministic, computed from real sports-data APIs - see
// public/lib/match-builder.mjs's own top comment. There is no AI anywhere
// in this pipeline as of docs/recommendation-engine-audit.md's Round 11
// (removed entirely - free-tier Gemini quota couldn't sustain the
// workload, and its own bounded ±2 validation nudge was never more than a
// small adjustment on top of this same deterministic score anyway).
// `whereToWatchTw` was never an AI answer either - it's a hardcoded rule
// (`resolveWhereToWatchTw`, in match-builder.mjs): 愛爾達體育台 for
// everything except an MLB fixture ESPN itself reports as Apple TV. The
// only network endpoint this page ever talks to is the shared proxy's own
// read-only `/sports-proxy` passthrough - used for building/refreshing the
// match list itself now (see proxyFetchJson), not just live score/odds
// polling (pollLiveMatches) the way it used to be. Everything else - sport
// priority, enabled sports, and which swiped match a viewer prefers - is
// local-only, in this browser's own localStorage, with no server-side sync
// of any kind (see README's "Local-only, no accounts").
//
// UI copy is Traditional Chinese throughout; team names and venues stay
// bilingual (see buildTeamRow/renderVenue) since an English team/venue name
// is often the more recognizable half for a fixture nobody has a settled
// Chinese name for yet.
//
// The pure scoring/viewing-plan math (overlap/slot/weighted-interval-
// scheduling helpers, computeDayPlan, resolveViewingPlan, confidence, the
// broadcast-service registry) lives in ./lib/recommendation.mjs instead of
// here - extracted so it can be unit-tested directly (see
// tests/recommendation.test.mjs) and reused by public/lib/match-builder.mjs
// (for confidence) without a DOM. The viewer's own local "Prefer" state
// (which swiped match to stick with per slot) is its own further pure
// module, ./lib/preferences.mjs - see that file's own top comment for why
// "match data -> recommendation -> user preference -> UI/card state" are
// kept as four separate layers instead of collapsing into one. This file
// keeps everything DOM/localStorage/render-related, and calls into both
// modules for the rest.
import {
  SERVICES,
  resolveService,
  computeDayPlan,
  resolveViewingPlan,
  slotKeyFromMembers,
  groupIntoSlots,
  isQuietHours,
  computeOverlapRange,
  isNearTotalOverlap,
  computeWindowPlan,
  applyRecentRepeatPenalties,
  naturalSlotChoice,
  matchLifecycleState,
  LIFECYCLE_STATES,
  estimatedDurationMinutes,
  estimateLiveDurationMinutes
} from './lib/recommendation.mjs';
import { serializePinnedChoices, deserializePinnedChoices, pruneStalePinnedChoices, applySlotSwipe } from './lib/preferences.mjs';
import { TEAM_LEAGUE_ESPN, liveScoreboardUrl, extractLiveUpdates } from './lib/espn.mjs';
import { pickReadableTeamColor } from './lib/color.mjs';
import {
  POLYMARKET_TAG_ID,
  polymarketEventsByTagUrl,
  resolveTeamOdds,
  resolveF1WinnerOdds
} from './lib/polymarket.mjs';
// The one shared fetch+score pipeline - see that module's own top comment
// for why this now runs live, in every viewer's own browser, instead of
// once at build time.
import { buildMatches, DEFAULT_DAYS_AHEAD } from './lib/match-builder.mjs';

// The shared Cloudflare Worker's base URL (jaypengx-collab/shared-proxy) -
// a plain, public value, not a secret (a static site's own client bundle
// can't keep anything truly hidden anyway - see that repo's own worker.js
// comment on /sports-proxy). Used to be injected into matches.json at
// build time from a GitHub Actions repo Variable; hardcoded directly here
// now that there's no more build step to inject it from (see this file's
// own top comment on why) - confirmed live to still be the real deployed
// Worker's own URL.
const PROXY_URL = 'https://orbit-workers-proxy.pengzjay.workers.dev';

// Every host buildMatches needs (ESPN, Polymarket, the MLB Stats API,
// Jolpica) sends no CORS headers, so a browser can't fetch any of them
// directly - this is the ONE fetchJson this page ever hands to
// buildMatches, routing every request through the shared proxy's
// /sports-proxy passthrough instead (see that Worker's own
// SPORTS_PROXY_ALLOWED_HOSTS - it only forwards to hosts it already
// trusts). Same shape as scripts/build-data.mjs's own Node-side fetchJson,
// just reaching these hosts through the proxy instead of directly.
async function proxyFetchJson(url) {
  const response = await fetch(`${state.proxyUrl}/sports-proxy?url=${encodeURIComponent(url)}`, {
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

const state = {
  allRawMatches: [], // every fetched, non-TBD match regardless of enabled sports - see applyEnabledSportsAndRender
  rawMatches: [], // allRawMatches filtered to enabled sports, untouched otherwise - kept so a priority/service change can re-run resolveViewingPlan without re-fetching
  tbdMatches: [], // fixtures ESPN has on the schedule but hasn't set a kickoff time for yet - see applyFreshBuild
  matches: [], // every fetched (non-TBD), enabled-sport match, mutated in place with .recommended/.overlappingIds
  days: [], // [{key: 'YYYY-MM-DD', date: Date}, ...] - every calendar day the fetched window covers
  selectedDayKey: null,
  activeSport: 'all',
  priorityOrder: [], // sports ranked best-to-least - see "Sport priority settings" below
  enabledSports: [], // sports to show at all - see "Enabled sports settings" below
  myServiceIds: [], // subscribed services - see "Broadcast service registry" below
  // Map<dayKey, Set<matchId>> - the flat set of matches the viewer
  // explicitly swiped to commit to watching, per day - see
  // computeDayPlan/pinSlotChoice, and ./lib/preferences.mjs for the actual
  // set-or-clear decision and serialization shape. Keyed by the PINNED
  // MATCH'S OWN id, not by a hash of whichever multi-match "slot" (see
  // isNearTotalOverlap) it happened to belong to at pin time - a slot's own
  // shape can change (a live duration correction, a routine data refresh, a
  // sport filter narrowing which candidates exist) in a way a match's own
  // id never does, and keying storage by the former used to silently
  // orphan a real pin the moment its slot's shape shifted, which read as
  // "reloading the page wipes my preference back to 推薦" - see
  // preferences.mjs's own comment on applySlotSwipe. Local-only (see this
  // file's own top comment) - persisted to localStorage so a viewer who
  // swiped past this morning's default pick still sees that choice as
  // 偏好, not reverted back to 推薦, next time they open the page. Old
  // days' entries get pruned (see prunePinnedChoices) rather than kept
  // forever, since a day that's aged out of the fetched window can never be
  // looked up again anyway.
  //
  // Starts empty here, deliberately - the REAL load (state.pinnedChoices =
  // loadPinnedChoices()) happens as a separate statement further down,
  // same pattern as state.priorityOrder below. loadPinnedChoices() reads
  // PINNED_CHOICES_STORAGE_KEY, a `const` declared much later in this file
  // (module top-level code runs top-to-bottom) - calling it HERE, still
  // inside this very literal, hit that binding while it was still in the
  // temporal dead zone, threw a caught-and-swallowed ReferenceError, and
  // silently discarded every pin on every single page load. Live-reported
  // as "swiping to a preference doesn't survive a reload" - the pin was
  // sitting untouched in localStorage the whole time (savePinnedChoices
  // still worked fine mid-session), just never read back on the load path.
  pinnedChoices: new Map(),
  // Map<dayKey, Map<matchupKey, dayKey>> - computeWindowPlan's
  // historyByDayKey: for each day, the most recent EARLIER day (across the
  // WHOLE fetched window, regardless of the current sport filter) that
  // matchup actually won its day's plan. Recomputed by renderSections (see
  // computeWindowPlan) before every render, so a soft cross-day repeat
  // penalty (applyRecentRepeatPenalties) can see "did we already
  // recommend this exact matchup on an earlier day" no matter which day
  // or sport filter the viewer currently has open - see docs/
  // recommendation-engine-audit.md's "cross-day repetition" finding.
  //
  // Keyed per-day (not one flat Map<matchupKey, dayKey>) because a flat
  // map can only remember one occurrence per matchup - the LAST one
  // processed across the whole window - which for a real short
  // back-to-back series is very often a day AFTER the one being asked
  // about, silently hiding every earlier occurrence from that day's own
  // repeat penalty (see computeWindowPlan's own comment on historyByDayKey
  // for the exact "same matchup recommended 3 days running" bug this was).
  recommendationHistory: new Map(),
  // Map<dayKey, matches[]> - the rolling window of recently-recommended
  // matches (see computeWindowPlan's own comment) each day's soft
  // sport-concentration penalty was actually weighed against, reused as-is
  // by renderRecommendedSection's own (possibly sport-filtered) call so it
  // doesn't have to re-derive the same rolling window a second way.
  recentPicksByDayKey: new Map(),
  // Map<sport, share 0..1> over the whole fetched window's own final
  // picks - docs/recommendation-engine-audit.md section 15's "the planner
  // should expose that concentration" (team/league concentration) - not
  // itself used for any scheduling decision, and (since the developer-only
  // export button that used to surface this was removed) currently only
  // ever inspected via public/data/matches.json directly or
  // scripts/evaluate-recommendations.mjs (see README).
  sportConcentration: new Map(),
  // Map<dayKey, Map<slotKey, Set<matchId>>> - which members a swipeable
  // card stack actually shows, frozen the first time each day+slot renders
  // - see renderRecommendedSection's own comment for why this exists:
  // computeDayPlan's alternativeIds is recomputed per CHOICE, and a big
  // real-world conflict cluster's members don't all have the same direct-
  // overlap neighborhood, so swiping to a new primary without this could
  // hand back a bigger/different member list than the one just shown,
  // reading as the stack growing or reshuffling under the viewer's finger
  // mid-swipe. In-memory only, never persisted - cleared in applyFreshBuild
  // whenever genuinely fresh match data arrives (a fetch/poll can add,
  // remove, or reschedule fixtures, so last render's snapshot is no longer
  // trustworthy), never by a pin's own render.
  stackMembershipByDay: new Map()
};

// Sport labels as ESPN/match-builder.mjs spell them internally (see
// TEAM_LEAGUES in that script) stay the stable data key and CSS hook
// (data-sport="Premier League" etc.) - only the on-screen label goes
// through this map, so the underlying data model never has to change
// just because the display language does. MLB/NBA/F1 stay as their
// English initialisms - that's how Taiwanese sports media normally
// writes them too, even in otherwise-Chinese text; only the Premier
// League has a standard, universally-used Chinese short name.
const SPORT_LABELS_ZH = {
  'Premier League': '英超',
  MLB: 'MLB',
  NBA: 'NBA',
  F1: 'F1'
};

// Each league/sanctioning body's own real, official mark, hotlinked from
// ESPN's CDN - the same team-logos.espncdn.com-family hosting the team
// crests/F1 logo elsewhere in this file already come from, not a
// reproduction copied into this repo. Used everywhere a sport is shown -
// the match card badge, the filter chips, and both sport-related Settings
// lists (see buildSportIcon below, the one place all four read from).
const LEAGUE_LOGOS = {
  'Premier League': 'https://a.espncdn.com/i/leaguelogos/soccer/500/23.png',
  MLB: 'https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png',
  NBA: 'https://a.espncdn.com/i/teamlogos/leagues/500/nba.png',
  F1: 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/leagues/500/f1.png'
};

// The fallback for LEAGUE_LOGOS above - one small original pictogram per
// sport, drawn inline rather than hotlinked, used only when a league logo
// actually fails to load (see buildSportIcon's own onerror handler), same
// defensive-fallback posture as team/service logos elsewhere in this file.
// A fixed dark stroke color, not `currentColor` - every .sport-icon now
// sits on its own fixed white backdrop circle regardless of context (see
// styles.css's own comment on why), so a fixed color that reads clearly on
// white is correct everywhere this appears, rather than inheriting
// whatever text color happens to surround it in one particular context.
const SPORT_ICON_STROKE = '#1f2433';
const SPORT_ICONS = {
  'Premier League':
    `<svg viewBox="0 0 24 24" fill="none" stroke="${SPORT_ICON_STROKE}" stroke-width="1.4"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.3l4.1 2.9-1.6 4.8h-5L8 10.2z" fill="${SPORT_ICON_STROKE}" stroke="none"/><path d="M12 7.3V4.2M16.1 10.2l2.9-1.8M14.5 15l1.9 2.8M9.5 15l-1.9 2.8M8 10.2l-2.9-1.8" stroke-linecap="round"/></svg>`,
  MLB:
    `<svg viewBox="0 0 24 24" fill="none" stroke="${SPORT_ICON_STROKE}" stroke-width="1.4"><circle cx="12" cy="12" r="8.4"/><path d="M6.7 6.2c2.6 2.2 2.6 9.4 0 11.6M17.3 6.2c-2.6 2.2-2.6 9.4 0 11.6" stroke-linecap="round"/></svg>`,
  NBA:
    `<svg viewBox="0 0 24 24" fill="none" stroke="${SPORT_ICON_STROKE}" stroke-width="1.4"><circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8M12 3.6v16.8M6.2 5.8c2.1 3 2.1 9.4 0 12.4M17.8 5.8c-2.1 3-2.1 9.4 0 12.4" stroke-linecap="round"/></svg>`,
  F1:
    `<svg viewBox="0 0 24 24" fill="none"><path d="M5.2 21V3" stroke="${SPORT_ICON_STROKE}" stroke-width="1.4" stroke-linecap="round"/><rect x="5.2" y="4" width="3.6" height="3.6" fill="${SPORT_ICON_STROKE}"/><rect x="12.4" y="4" width="3.6" height="3.6" fill="${SPORT_ICON_STROKE}"/><rect x="8.8" y="7.6" width="3.6" height="3.6" fill="${SPORT_ICON_STROKE}"/><rect x="16" y="7.6" width="3.6" height="3.6" fill="${SPORT_ICON_STROKE}"/></svg>`
};

// Builds one `<span class="sport-icon">` for a given sport - the one place
// every sport-labeled UI element (the match card badge, filter chips, and
// both sport-related Settings lists) gets its icon from, so "show the
// league's real logo, fall back to the drawn pictogram if it fails to
// load" only has to be implemented once. Same onerror-swap pattern as team/
// service logos elsewhere in this file.
function buildSportIcon(sport) {
  const wrap = document.createElement('span');
  wrap.className = 'sport-icon';
  if (LEAGUE_LOGOS[sport]) {
    const img = document.createElement('img');
    img.src = LEAGUE_LOGOS[sport];
    img.alt = '';
    // Deliberately no loading="lazy" - these are tiny (16-22px) icons, so
    // there's nothing meaningful to save by deferring them, and native lazy
    // loading has a real, confirmed bug inside the Settings panel
    // specifically: that panel is `position: fixed` with its own internal
    // `overflow-y: auto` scroll, and Safari's lazy-load engine can lose
    // track of an image's visibility inside a scrolled FIXED container -
    // scrolling it out and back in left the logo blank instead of
    // reloading it. Eager loading sidesteps the bug entirely.
    img.referrerPolicy = 'no-referrer';
    img.addEventListener(
      'error',
      () => {
        img.remove();
        if (SPORT_ICONS[sport]) wrap.innerHTML = SPORT_ICONS[sport];
        else wrap.hidden = true;
      },
      { once: true }
    );
    wrap.appendChild(img);
  } else if (SPORT_ICONS[sport]) {
    wrap.innerHTML = SPORT_ICONS[sport];
  } else {
    wrap.hidden = true;
  }
  return wrap;
}

// ---- Broadcast service registry -------------------------------------------
//
// `whereToWatchTw` is now a fixed rule's output (see match-builder.mjs's
// `resolveWhereToWatchTw`), not Gemini's own free-form guess, but this
// registry still matches it by plain text rather than a hardcoded enum
// value here - both service names it can now actually produce (愛爾達體育台/
// Apple TV) already match an entry below, and staying text-matched costs
// nothing while keeping this file decoupled from exactly how the rule
// spells each name. This is what turns that text into something the UI can
// badge/color/reason about consistently, and what OWNED (see
// DEFAULT_MY_SERVICE_IDS below) means at all. Adding a new service
// later is just one more entry here (id, matching pattern, badge/color) -
// nothing else in this file needs to change, same reasoning as
// SPORT_LABELS_ZH above for sports.
//
// `badge` is a short plain-text mark, not a reproduction of the real
// trademarked logo (this is a static site with no image-licensing story of
// its own) - just enough to be visually recognizable and color-coded at a
// glance, same spirit as the sport badges already on every card.
// `logo` points at each service's real, official mark, hotlinked from an
// external host rather than reproduced/copied into this repo - same
// posture as the team/F1 logos already pulled from ESPN's own CDN
// elsewhere in this file: most are Wikimedia Commons (Special:FilePath,
// its own stable hotlink-friendly redirect to the current file - confirmed
// live, not just assumed), 愛爾達's own is Google Play's app-icon CDN (see
// that entry's own comment for why Commons had nothing usable). `logoBg`
// is the background the mark needs to actually be visible (several of
// these are white- or dark-only artwork with no built-in backdrop) -
// buildMatchCard below tries `logo` first and only falls back to `badge`
// on a load failure (same onerror pattern as team logos) or when `logo`
// is absent.
//
// Deliberately just these three, even though resolveWhereToWatchTw only
// ever actually produces two of them (愛爾達體育台/Apple TV) - kept
// text-matched rather than collapsed to those two exact values so a third
// service (Netflix) already has a ready slot the day this site covers a
// league that airs on it, with nothing else in this file needing to
// change (same reasoning as SPORT_LABELS_ZH above for sports).
// `logoBg` is a two-stop gradient, not a flat fill (an earlier version used
// a flat fill, which read as a plain colored sticker sitting behind the
// logo rather than a designed icon) - the logo itself stays each service's
// own real, official mark though, hotlinked rather than reproduced into
// this repo, same posture as the team/F1 logos already pulled from ESPN's
// own CDN elsewhere in this file: most are Wikimedia Commons
// (Special:FilePath, its own stable hotlink-friendly redirect to the
// current file - confirmed live, not just assumed), 愛爾達's own is Google
// Play's app-icon CDN (see that entry's own comment for why Commons had
// nothing usable). buildMatchCard tries `logo` first and only falls back
// to the plain colored-initial `badge` on a load failure (same onerror
// pattern as team logos) or when `logo` is absent.
// Fixed rather than a per-viewer Settings toggle (see "Broadcast service
// registry" above) - this site's own owner's real subscriptions, used as a
// silent tie-breaking nudge in resolveViewingPlan only (see
// OWNED_SERVICE_SCORE_BONUS in ./lib/recommendation.mjs) - a great game on a
// service you don't have still shows up and can still be recommended, this
// just tips a genuinely close call. No badge/mark in the UI for it anymore -
// it's a scoring input, not something worth a viewer's attention on every
// card. SERVICES/resolveService themselves now live in ./lib/recommendation.mjs
// (imported above) - this file only still owns which of them are "mine".
// 'netflix' staying in this list is harmless but now permanently inert for
// the score nudge above: since match-builder.mjs's `resolveWhereToWatchTw`
// hardcoded every fixture's `whereToWatchTw` to either 愛爾達體育台 or
// Apple TV (see this repo's README), no fixture can ever match Netflix
// here anymore - kept rather than removed since this constant is still
// meant to describe the owner's real subscriptions, not just which ones
// currently affect scoring.
const DEFAULT_MY_SERVICE_IDS = ['elta', 'appletv', 'netflix'];

const appEl = document.getElementById('app');
const dayScrollerEl = document.getElementById('day-scroller');
const filtersRow = document.getElementById('sport-filters');
const recommendedListEl = document.getElementById('recommended-list');
const recommendedEmptyEl = document.getElementById('recommended-empty');
const allMatchListEl = document.getElementById('all-match-list');
const allEmptyEl = document.getElementById('all-empty');
const dayLabelEls = document.querySelectorAll('[data-day-label]');
const emptyState = document.getElementById('empty-state');
const errorState = document.getElementById('error-state');
const generatedNote = document.getElementById('generated-note');
const tbdSection = document.getElementById('tbd-section');
const tbdListEl = document.getElementById('tbd-list');
const cardTemplate = document.getElementById('match-card-template');
const teamRowTemplate = document.getElementById('team-row-template');

const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsBackdrop = document.getElementById('settings-backdrop');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const settingsResetBtn = document.getElementById('settings-reset-btn');
const settingsSportList = document.getElementById('settings-sport-list');
const settingsEnabledSports = document.getElementById('settings-enabled-sports');
const updateStatusText = document.getElementById('update-status-text');
const refreshDataBtn = document.getElementById('refresh-data-btn');

// ---- Sport priority settings ---------------------------------------------
//
// The DP in resolveViewingPlan picks whichever match scores highest in each
// overlapping time slot - with MLB's own volume (~15 games most evenings,
// many sharing near-identical start times) split across many similarly-
// scored candidates, and other sports each only fielding one or two
// fixtures at a time, a single MLB game rarely has the single highest score
// in its own crowded slot even when it's a perfectly good one, while a
// less-crowded sport's ordinary fixture more easily comes out on top of
// ITS slot. That's a real structural effect, not a bug to "fix" outright -
// there's no one correct answer for which sport SHOULD win a close call -
// so instead of guessing, this lets each viewer rank the sports in the
// order they'd rather see win a close call, applied only as a tie-breaking
// nudge (see PRIORITY_SCORE_DELTA in ./lib/recommendation.mjs), never a
// hard include/exclude.
// An explicit rank (1st, 2nd, 3rd, ...), rather than a per-sport "less/
// normal/more" dial, is the more direct way to ask the actual question:
// "if these two are roughly equally good, which do you want?" - a dial
// still leaves every sport at the same level ambiguous relative to each
// other, where a full order never is.
// ---- One unified recommendation system: "Best Matches" ---------------------
//
// There used to be a viewer-selectable "recommendation style" (話題熱度 vs
// 精彩程度) toggling which per-match score drove 推薦賽事. In practice this
// just split feedback and testing across two subtly different rankings for
// no real benefit - "worth watching" doesn't need two competing answers,
// just one well-reasoned one. resolveViewingPlan (./lib/recommendation.mjs)
// now always uses the single "Best Matches" blend - skill/closeness
// (competitiveness), sustained competitive stakes (enduranceScore), and
// entertainment/public attention (watchability, nudged by broadcastQuality)
// combined, see BEST_MATCH_WEIGHTS there - deliberately never anchored on
// just one of those axes. The viewer's own
// preference is expressed a different way instead: swiping a card stack to
// commit to a specific alternative (see "Prefer" below) - that's the ONE
// place personal taste overrides the algorithm's own judgment, and it's
// local, explicit, and per-match rather than a blanket ranking toggle.

const SETTINGS_STORAGE_KEY = 'matchfind-sport-priority-order';
// PRIORITY_SCORE_DELTA/OWNED_SERVICE_SCORE_BONUS now live in
// ./lib/recommendation.mjs alongside resolveViewingPlan, which is the only
// place they're actually used.

const DEFAULT_SPORT_ORDER = Object.keys(SPORT_LABELS_ZH);

function loadPriorityOrder() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY));
    if (!Array.isArray(stored)) return DEFAULT_SPORT_ORDER.slice();
    // Tolerates the sport list itself changing between visits: keeps
    // whatever stored order still applies, appends any brand new sport at
    // the end (never assume a new sport, or leftover an unknown value in a
    // stale write, means anything relative to today's ranking).
    const known = stored.filter(sport => DEFAULT_SPORT_ORDER.includes(sport));
    const missing = DEFAULT_SPORT_ORDER.filter(sport => !known.includes(sport));
    return [...known, ...missing];
  } catch {
    return DEFAULT_SPORT_ORDER.slice();
  }
}
function savePriorityOrder(order) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Private browsing / blocked storage - the panel still works for this
    // page view, it just won't remember next time. Not worth surfacing.
  }
}
state.priorityOrder = loadPriorityOrder();

// ---- Enabled sports / subscribed services settings ------------------------
//
// Two more per-viewer settings, same local-only localStorage pattern as
// sport priority above. Unlike priority (a tie-breaking nudge),
// a disabled sport is a hard exclude - it never appears anywhere on the
// page, not even in "所有賽事", since "enable/disable" is a plainer,
// stronger statement than "prefer less".
const ENABLED_SPORTS_STORAGE_KEY = 'matchfind-enabled-sports';

function loadEnabledSports() {
  try {
    const stored = JSON.parse(localStorage.getItem(ENABLED_SPORTS_STORAGE_KEY));
    if (!Array.isArray(stored) || !stored.length) return new Set(DEFAULT_SPORT_ORDER);
    return new Set(stored.filter(sport => DEFAULT_SPORT_ORDER.includes(sport)));
  } catch {
    return new Set(DEFAULT_SPORT_ORDER);
  }
}
function saveEnabledSports(enabledSports) {
  try {
    localStorage.setItem(ENABLED_SPORTS_STORAGE_KEY, JSON.stringify([...enabledSports]));
  } catch {
    // Private browsing / blocked storage - see savePriorityOrder's own comment.
  }
}
state.enabledSports = loadEnabledSports();
// Not a per-viewer setting (see SERVICES' own comment) - fixed to this
// site's own owner's real subscriptions.
state.myServiceIds = new Set(DEFAULT_MY_SERVICE_IDS);

// ---- Pinned-choice persistence (local-only "Prefer") -----------------------
//
// state.pinnedChoices (Map<dayKey, Set<matchId>>) - which matches the
// viewer explicitly swiped to commit to watching, per day. Local-only, like every other
// preference in this file (see this file's own top comment) - the
// serialization shape, staleness pruning, and the actual "is this a real
// override or does it just match the algorithm's own default" decision
// (see pinSlotChoice below) all live in ./lib/preferences.mjs, pure and
// DOM-free (see tests/preferences.test.mjs) - this file only ever does the
// localStorage read/write itself. `localDateKey`/`new Date` aren't defined
// yet this early in the file, but both are plain function declarations
// (hoisted) reading only the current wall clock, so calling them from here
// at module-load time is safe.
const PINNED_CHOICES_STORAGE_KEY = 'matchfind-pinned-choices';

function loadPinnedChoices() {
  try {
    return deserializePinnedChoices(JSON.parse(localStorage.getItem(PINNED_CHOICES_STORAGE_KEY)), localDateKey(new Date()));
  } catch {
    return new Map();
  }
}
function savePinnedChoices() {
  try {
    localStorage.setItem(PINNED_CHOICES_STORAGE_KEY, JSON.stringify(serializePinnedChoices(state.pinnedChoices)));
  } catch {
    // Private browsing / blocked storage - see savePriorityOrder's own comment.
  }
}
// The REAL load - see state.pinnedChoices's own comment in the state
// literal above for why this can't happen there directly (PINNED_CHOICES_
// STORAGE_KEY's own TDZ), same pattern as state.priorityOrder's assignment
// right after loadPriorityOrder above.
state.pinnedChoices = loadPinnedChoices();
// Called on every applyEnabledSportsAndRender (a fresh data load, or a
// sport toggle) - state.days moves forward with the fetched window, and a
// pin for a day that's fallen off the back of it, or simply passed, can
// never be looked up by computeDayPlan again either way.
function prunePinnedChoices() {
  const { pinnedChoices, changed } = pruneStalePinnedChoices(state.pinnedChoices, localDateKey(new Date()));
  state.pinnedChoices = pinnedChoices;
  if (changed) savePinnedChoices();
}

function recomputeAndRender() {
  if (!state.rawMatches.length) return;
  state.matches = resolveViewingPlan(state.rawMatches, state.priorityOrder, state.myServiceIds);
  renderSections();
}

function renderSettingsPanel() {
  settingsSportList.replaceChildren(
    ...state.priorityOrder.map((sport, index) => {
      const row = document.createElement('div');
      row.className = 'settings-sport-row';
      const rank = document.createElement('span');
      rank.className = 'settings-sport-rank';
      rank.textContent = String(index + 1);
      const icon = buildSportIcon(sport);
      icon.classList.add('settings-sport-icon');
      const label = document.createElement('span');
      label.className = 'settings-sport-label';
      label.textContent = SPORT_LABELS_ZH[sport];
      const moveGroup = document.createElement('div');
      moveGroup.className = 'settings-move-group';

      function move(delta) {
        const from = state.priorityOrder.indexOf(sport);
        const to = from + delta;
        if (to < 0 || to >= state.priorityOrder.length) return;
        [state.priorityOrder[from], state.priorityOrder[to]] = [state.priorityOrder[to], state.priorityOrder[from]];
        persistSettings();
        renderSettingsPanel();
        recomputeAndRender();
      }

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.setAttribute('aria-label', `將 ${SPORT_LABELS_ZH[sport]} 往上移`);
      upBtn.textContent = '↑';
      upBtn.disabled = index === 0;
      upBtn.addEventListener('click', () => move(-1));

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.setAttribute('aria-label', `將 ${SPORT_LABELS_ZH[sport]} 往下移`);
      downBtn.textContent = '↓';
      downBtn.disabled = index === state.priorityOrder.length - 1;
      downBtn.addEventListener('click', () => move(1));

      moveGroup.append(upBtn, downBtn);
      row.append(rank, icon, label, moveGroup);
      return row;
    })
  );
  renderEnabledSportsPanel();
}

// Saves every setting to localStorage - local-only, no server call (see
// this file's own top comment) - one place after any settings mutation,
// rather than each individual toggle/reorder handler needing to remember
// to save both.
function persistSettings() {
  savePriorityOrder(state.priorityOrder);
  saveEnabledSports(state.enabledSports);
}

// Toggle chips, not a full multi-select list - a disabled sport is a hard
// exclude (see ENABLED_SPORTS_STORAGE_KEY's own comment), so this needs to
// read as "on/off per sport", not "pick your favorites". The last enabled
// sport can't be turned off - an empty site isn't a valid state.
function renderEnabledSportsPanel() {
  settingsEnabledSports.replaceChildren(
    ...DEFAULT_SPORT_ORDER.map(sport => {
      const enabled = state.enabledSports.has(sport);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = enabled ? 'settings-chip is-active' : 'settings-chip';
      chip.appendChild(buildSportIcon(sport));
      const label = document.createElement('span');
      label.textContent = SPORT_LABELS_ZH[sport];
      chip.appendChild(label);
      chip.setAttribute('aria-pressed', String(enabled));
      chip.disabled = enabled && state.enabledSports.size === 1;
      chip.addEventListener('click', () => {
        if (enabled) {
          if (state.enabledSports.size === 1) return; // guarded by chip.disabled too
          state.enabledSports.delete(sport);
        } else {
          state.enabledSports.add(sport);
        }
        persistSettings();
        renderEnabledSportsPanel();
        applyEnabledSportsAndRender();
      });
      return chip;
    })
  );
}

function openSettingsPanel() {
  renderSettingsPanel();
  settingsPanel.hidden = false;
  settingsBackdrop.hidden = false;
}
function closeSettingsPanel() {
  settingsPanel.hidden = true;
  settingsBackdrop.hidden = true;
}
settingsBtn.addEventListener('click', openSettingsPanel);
settingsCloseBtn.addEventListener('click', closeSettingsPanel);
settingsBackdrop.addEventListener('click', closeSettingsPanel);
settingsResetBtn.addEventListener('click', () => {
  state.priorityOrder = DEFAULT_SPORT_ORDER.slice();
  persistSettings();
  renderSettingsPanel();
  recomputeAndRender();
});

const LOCALE = 'zh-Hant';

function localTimeFormatter() {
  return new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' });
}
function localDayFormatter() {
  return new Intl.DateTimeFormat(LOCALE, { weekday: 'long', month: 'long', day: 'numeric' });
}
function shortDayFormatter() {
  return new Intl.DateTimeFormat(LOCALE, { weekday: 'short', month: 'numeric', day: 'numeric' });
}

// Reads matchLifecycleState (./lib/recommendation.mjs) rather than
// re-deriving "is this live/about to start" from raw start/end times
// itself - that used to be duplicated ad hoc right here: the old version
// computed `diffMin = start - now` and returned "即將開始" (starting soon)
// for ANY diffMin <= 0, which is only reachable once `now` is already past
// the match's own nominal end (the live window was handled by an earlier
// branch) - so a match that had simply run long, without ESPN having
// reported it finished yet, was mislabeled as "about to start" instead of
// "still live". A match already underway can never be "about to start"
// again, however long it runs - matchLifecycleState is the one place that
// invariant is enforced, so this function (and buildMatchCard's is-live
// styling below) can't independently drift from it.
function relativeLabel(match, now = Date.now()) {
  const state = matchLifecycleState(match, now);
  if (state === LIFECYCLE_STATES.LIVE || state === LIFECYCLE_STATES.ENDING_SOON) return '直播中';
  if (state === LIFECYCLE_STATES.STARTING_SOON) return '即將開始';

  const diffMin = Math.round((Date.parse(match.startTimeUtc) - now) / 60_000);
  if (diffMin < 60) return `${diffMin} 分鐘後`;
  if (diffMin < 1440) {
    const hours = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    return mins ? `${hours} 小時 ${mins} 分後` : `${hours} 小時後`;
  }
  // Past 24 hours, count in whole days instead of letting the hour count
  // just keep climbing (nobody reads "38 小時後" faster than "1 天 14
  // 小時後") - this is also the point at which a plain hour count stops
  // being enough to place a match without checking a calendar.
  const days = Math.floor(diffMin / 1440);
  const hours = Math.floor((diffMin % 1440) / 60);
  return hours ? `${days} 天 ${hours} 小時後` : `${days} 天後`;
}

// "已結束" plus the final score, when match-builder.mjs actually got one back
// from ESPN as a plain number for both sides - anything else (missing,
// non-numeric, only one side present) just falls back to the plain label
// rather than showing a half-built or misleading score line.
function finishedLabel(match) {
  const scores = (match.competitors || []).map(c => Number(c.score));
  if (scores.length === 2 && scores.every(Number.isFinite)) {
    return `已結束．${scores[0]}–${scores[1]}`;
  }
  return '已結束';
}

// Local calendar date key, e.g. "2026-09-19" - deliberately NOT toISOString
// (which would give the UTC date, off by a day for plenty of viewers around
// midnight). Every date/day grouping in this file goes through this so a
// match is always bucketed onto the day it actually falls on for whoever is
// looking at the page.
function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayLabelFor(date, { short = false } = {}) {
  const today = new Date();
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(date) - startOfDay(today)) / 86_400_000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '明天';
  // Yesterday is a real, explicitly reachable day now (see match-builder.mjs's
  // own one-day lookback and computeDayPlan treating a finished match as a
  // normal candidate) - it deserves the same clear "昨天" label 今天/明天
  // already get, not just falling through to a bare weekday/date.
  if (diffDays === -1) return '昨天';
  return (short ? shortDayFormatter() : localDayFormatter()).format(date);
}

// ---- Client-side viewing plan -------------------------------------------
//
// Same real-world judgment this site used to run at build time (see git
// history) - moved here because both of its real inputs, "what counts as
// an unreasonable hour" and "what's the closest match right now", are
// relative to THIS viewer's own local clock, which a single build running
// once for every visitor has no way to know. The AI-assigned
// competitiveness/watchability/enduranceScore it works from, on the other
// hand, aren't viewer-relative at all - so those still only ever get
// computed once, at build time.
//
// - QUIET_HOUR_START/END: a match whose LOCAL start falls in this window is
//   never eligible to be recommended, however good its score - nobody
//   asked to be told a 4am fixture is unmissable. It still shows up in the
//   full "all matches" list further down, just never pinned as a pick.
//
// The plan is built ONE LOCAL CALENDAR DAY AT A TIME (computeDayPlan,
// called per selected day from renderRecommendedSection) rather than as
// one pass over the whole 14-day window: "what's worth watching today" is
// inherently a per-day question.
//
// ---- The model: one back-to-back viewing plan, not independent picks ----
//
// You can only actually watch one thing at a time. So 推薦賽事 isn't a set
// of independent "this is good" judgments - it's ONE continuous plan for
// the day: a maximum-total-score chain of matches, none of them truly
// overlapping, that flows from one into the next. Two flawed designs came
// before this: a per-slot "only the best of whatever overlaps wins, chosen
// mostly for AI review, others quality-gated to any interested" - and a
// flat per-match threshold, "clear a fixed score bar and you're
// recommended, independent of everything else" - added right after that
// one to fix the first, then immediately dropping the "one continuous
// plan" idea entirely by not requiring the picks to actually not overlap
// each other at all, so two heavily-overlapping great matches could BOTH
// be "recommended" despite genuinely being impossible to watch both of.
// Direct user feedback on both: the first one silently hid good games,
// the second stopped being an actual PLAN.
//
// This version is a real weighted-interval-scheduling chain: the
// maximum-total-score set of non-overlapping matches for the day, where
// EVERY individual candidate is a scheduling input, never just one
// representative chosen per conflict window ahead of time (see
// computeDayPlan's own comment in recommendation.mjs for why an earlier,
// pre-grouped version of this could silently throw away the globally best
// plan). Two matches that overlap so much you genuinely can't sequence
// them (see isNearTotalOverlap) still only ever end up as one "slot" in
// the final result - a swipeable choice, not two separate picks - but
// that grouping is now a PRESENTATION label computed after scheduling, not
// something that gates what the scheduler itself gets to consider.
// Swiping to a different member PINS it: the plan rebuilds itself around
// that fixed choice, both before and after it (see computeDayPlan).
// enduranceScore feeds directly into how long a pick actually blocks the
// next one from starting (see effectiveDurationMinutes) - a fixture
// unlikely to stay watchable to the end frees up the schedule sooner than
// its full nominal length would suggest. A sport's own duration
// UNCERTAINTY (see SPORT_TIMING/schedulingInterval - MLB has no clock, so
// its 190-minute nominal length is trusted far less than football's or
// F1's) shrinks that block further before it's allowed to hold up
// anything scheduled after it, plus a small fixed transition buffer
// between any two back-to-back picks.
//
// isQuietHours/matchInterval/computeOverlapRange/overlapMinutes/
// isNearTotalOverlap/effectiveDurationMinutes/effectiveInterval/
// schedulingInterval/canWatchSequentially/groupIntoSlots/
// slotKeyFromMembers/weightedIntervalSchedule/computeDayPlan/
// computeWindowPlan/applyRecentRepeatPenalties/matchupKey/
// resolveViewingPlan all now live in ./lib/recommendation.mjs (imported at
// the top of this file) - see that module for the "one continuous
// back-to-back plan, not independent picks" model this section used to
// document inline, and docs/recommendation-engine-audit.md for how
// effectiveScore's adjustments are now exposed for debugging
// (computeRecommendationScore/scoreBreakdown), and for the soft cross-day
// repeat penalty (planningScore) computeWindowPlan/renderSections apply so
// the same matchup doesn't default to winning every day of a series.
// computeOverlapRange is still used directly below, in buildMatchCard's
// own overlap note.

// The exact same day-candidate + cross-day-repeat-penalty preparation
// renderRecommendedSection needs to build today's plan - factored out so
// pinSlotChoice below can ask "what would the algorithm pick here on its
// own" (see naturalSlotChoice) against the IDENTICAL candidate set/scores
// the actual rendered plan uses, rather than a second, slightly different
// computation that could disagree with what's on screen.
function dayCandidatesForPlan(dayKey) {
  const dayCandidates = applySportFilter(matchesForDay(dayKey));
  // state.recommendationHistory.get(dayKey) - NOT the whole-window flat
  // map - see that field's own comment for why: it has to be "what was
  // recommended before THIS day", not "each matchup's last occurrence
  // anywhere in the fetched window".
  const history = state.recommendationHistory.get(dayKey) || new Map();
  applyRecentRepeatPenalties(dayCandidates, dayKey, history, state.recentPicksByDayKey.get(dayKey) || []);
  return dayCandidates;
}

// The actual "I will watch this" commitment (see buildMatchStack) - records
// the pin and triggers a full re-render, which recomputes computeDayPlan
// for the current day and reflows every other slot around it.
//
// `slotKey` must be the CONFLICT CLUSTER's own key (computeDayPlan's
// choice.slotKey - every member of the cluster, not just whichever subset
// happens to be visible in the stack the viewer swiped), or this pin
// silently never matches computeDayPlan's own lookup on the next render
// and gets thrown away - see recommendation.mjs's own comment on
// choice.slotKey for the exact 3+-match scenario this bit the user on.
//
// Swiping to whatever the algorithm would ALREADY have picked for this
// slot (naturalSlotChoice, computed with this slot's own pin - if any -
// set aside so it reflects the true unpinned default) clears any existing
// pin instead of setting one, via applySlotSwipe (./lib/preferences.mjs) -
// this is the direct fix for "swiping back changes Recommend into
// Prefer": without it, EVERY swipe recorded a pin, so a card the viewer
// swiped straight back to the algorithm's own default stayed mislabeled
// 偏好 forever instead of reverting to 推薦.
function pinSlotChoice(dayKey, slotKey, matchId) {
  const dayCandidates = dayCandidatesForPlan(dayKey);
  const naturalMatchId = naturalSlotChoice(dayKey, dayCandidates, slotKey, state.pinnedChoices.get(dayKey), {
    scoreField: 'planningScore'
  });
  state.pinnedChoices = applySlotSwipe(state.pinnedChoices, dayKey, slotKey, matchId, naturalMatchId);
  savePinnedChoices();
  renderSections();
}

// Lets a viewer promote ANY not-currently-recommended candidate straight
// from its own card into a hard pin, via the exact same forcedIds/
// excludedIds mechanism computeDayPlan already uses for an in-stack swipe
// (see pinSlotChoice above). Reported directly: a slot whose own conflict
// cluster has only ONE member renders as a plain, non-swipeable card (see
// renderRecommendedSection's own `!alternatives.length` branch) - "I can't
// swipe on the card stack that is not the first... I think it's because
// that's the only match" - so a viewer who wanted to override THAT slot
// with a completely different match (one from another time, another
// cluster, even one that time-conflicts with today's current pick) had no
// swipe target to act on at all. Computing the match's own conflict cluster
// FRESH here, the same way computeDayPlan itself will on the very next
// render, is what makes the pin correctly "kill" (exclude) whatever it
// pairwise-conflicts with - including a totally different slot's current
// pick - and, since forcing in a fixture whose own cluster has no other
// members leaves nothing to show alternatives for, it reduces to a single
// 偏好 card once forced in: "it has to be able to kill the first card and
// make them the only card."
function preferMatch(match) {
  const dayKey = localDateKey(new Date(match.startTimeUtc));
  const dayCandidates = dayCandidatesForPlan(dayKey).filter(m => !isQuietHours(m));
  const cluster = groupIntoSlots(dayCandidates).find(c => c.members.some(m => m.id === match.id));
  const slotKey = cluster ? slotKeyFromMembers(cluster.members) : match.id;
  pinSlotChoice(dayKey, slotKey, match.id);
}

// ---- Rendering ------------------------------------------------------------

function buildTeamRow({ logo, name, nameZh, homeAway }) {
  const node = teamRowTemplate.content.firstElementChild.cloneNode(true);
  const img = node.querySelector('.team-logo');
  if (logo) {
    img.src = logo;
    img.alt = name;
    img.addEventListener('error', () => { img.hidden = true; }, { once: true });
  } else {
    img.hidden = true;
  }
  const sideEl = node.querySelector('.team-side');
  if (homeAway === 'home' || homeAway === 'away') {
    sideEl.textContent = homeAway === 'home' ? '主' : '客';
    sideEl.classList.add(homeAway === 'home' ? 'is-home' : 'is-away');
  } else {
    sideEl.hidden = true;
  }
  node.querySelector('.team-name-en').textContent = name;
  node.querySelector('.team-name-zh').textContent = nameZh || '';
  return node;
}

function renderVenue(el, match) {
  el.textContent = match.venue || '';
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// The already-tuned sport accent color this app uses everywhere else (see
// styles.css's `.sport-badge[data-sport=...]` rules) - the fallback for
// when NEITHER of a team's own two real colors reads legibly against the
// card's current background (see pickReadableTeamColor), so the bar always
// shows something readable rather than the pure-illegible team color as-is.
const SPORT_ODDS_FALLBACK_VAR = { MLB: '--sport-mlb', NBA: '--sport-nba', 'Premier League': '--sport-epl' };

function teamOddsColor(competitor, sport) {
  const backgroundHex = cssVar('--bg-elevated') || cssVar('--bg');
  const readable = pickReadableTeamColor(competitor?.color, competitor?.altColor, backgroundHex);
  if (readable) return readable;
  const fallbackVar = SPORT_ODDS_FALLBACK_VAR[sport];
  return fallbackVar ? `var(${fallbackVar})` : 'var(--accent)';
}

function buildMatchCard(match) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);
  // Lets a later render find and patch THIS exact card by id without
  // rebuilding it from scratch - see buildMatchStack's own reuse mechanism,
  // which relies on this to update just the recommended-tag/is-pinned state
  // on an already-correctly-scrolled stack instead of tearing it down.
  node.dataset.matchId = match.id;
  const start = Date.parse(match.startTimeUtc);
  // For a FINISHED match, match.durationMinutes is already the real
  // observed elapsed time (see match-builder.mjs's finishedDurationMinutes) -
  // no forward uncertainty left to hedge. For one that hasn't finished yet,
  // the displayed end time uses estimatedDurationMinutes (recommendation.mjs)
  // - the SAME real-clock-overrun-padded estimate schedulingDurationMinutes
  // already uses internally to decide when the NEXT match can safely start
  // - not the bare pre-game durationMinutes. Showing the viewer the bare
  // figure told them a low-reliability, no-clock sport (MLB - extra
  // innings, rain delays, see SPORT_TIMING's own comment) would end sooner
  // than this app's own scheduler already assumes it realistically might -
  // live-reported as "MLB almost always runs past its shown end time",
  // which this app's own internal padding had already anticipated but
  // never actually showed on the card itself.
  const end = start + (match.isFinished ? match.durationMinutes : estimatedDurationMinutes(match)) * 60_000;

  if (match.timeTbd) {
    // startTimeUtc is only a placeholder for a TBD fixture (see
    // match-builder.mjs's isTimeTbd) - showing it as a real clock time would
    // just be a confident-looking guess, so this says plainly that it
    // isn't known yet instead.
    node.querySelector('.match-time-range').textContent = '時間未定';
    node.querySelector('.match-time-relative').textContent = '';
  } else {
    // One line, not three stacked labels - "7:00 – 9:35 下午" reads at a
    // glance where a separate start time / end time / relative-countdown
    // column used to take real hunting to parse, especially on a phone.
    node.querySelector('.match-time-range').textContent =
      `${localTimeFormatter().format(new Date(start))} – ${localTimeFormatter().format(new Date(end))}`;
    // A finished match's real end time rarely matches `end` above (that's
    // only ever durationMinutes' per-sport AVERAGE - see match-builder.mjs's
    // isFinished comment), so this says "已結束" (plus the final score,
    // when ESPN reported both as plain numbers) instead of a relative
    // countdown/直播中 that would otherwise still be computed from that
    // same unreliable estimated end time.
    node.querySelector('.match-time-relative').textContent = match.isFinished
      ? finishedLabel(match)
      : relativeLabel(match);
  }

  const badge = node.querySelector('.sport-badge');
  badge.dataset.sport = match.sport;
  node.querySelector('.sport-icon').replaceWith(buildSportIcon(match.sport));
  node.querySelector('.sport-badge-text').textContent = SPORT_LABELS_ZH[match.sport] || match.sport;

  const teamsEl = node.querySelector('[data-teams]');
  if (match.competitors && match.competitors.length === 2) {
    const [away, home] = match.competitors;
    teamsEl.appendChild(buildTeamRow(away));
    const at = document.createElement('span');
    at.className = 'team-at';
    at.textContent = 'vs';
    teamsEl.appendChild(at);
    teamsEl.appendChild(buildTeamRow(home));
  } else {
    teamsEl.appendChild(buildTeamRow({ logo: match.logo, name: match.name, nameZh: match.nameZh }));
  }

  // A real Polymarket prediction market's own devigged trade price (see
  // ./lib/polymarket.mjs) as a live win-probability bar - only rendered
  // when a real market has actually opened for this fixture. Never a
  // guessed/defaulted 50/50 - hidden entirely rather than showing a fake
  // number when the market itself hasn't weighed in. EPL's own market is a
  // real three-outcome one (away/draw/home) rather than MLB/NBA's two, so
  // this renders a middle draw segment whenever oddsWinPctDraw is real,
  // and otherwise falls back to the plain two-segment bar.
  const oddsEl = node.querySelector('.match-odds');
  if (
    match.competitors &&
    match.competitors.length === 2 &&
    Number.isFinite(match.oddsWinPctAway) &&
    Number.isFinite(match.oddsWinPctHome)
  ) {
    const [away, home] = match.competitors;
    const hasDraw = Number.isFinite(match.oddsWinPctDraw);
    oddsEl.hidden = false;
    oddsEl.querySelector('.match-odds-away').textContent = `${Math.round(match.oddsWinPctAway)}%`;
    oddsEl.querySelector('.match-odds-home').textContent = `${Math.round(match.oddsWinPctHome)}%`;
    const awaySeg = oddsEl.querySelector('.match-odds-seg-away');
    const drawSeg = oddsEl.querySelector('.match-odds-seg-draw');
    const homeSeg = oddsEl.querySelector('.match-odds-seg-home');
    // Each segment gets ITS OWN team's real color (see ./lib/color.mjs) -
    // never one fixed color for both sides, which read as arbitrary rather
    // than "which team is this" at a glance.
    awaySeg.style.width = `${match.oddsWinPctAway}%`;
    awaySeg.style.background = teamOddsColor(away, match.sport);
    homeSeg.style.width = `${match.oddsWinPctHome}%`;
    homeSeg.style.background = teamOddsColor(home, match.sport);
    drawSeg.hidden = !hasDraw;
    if (hasDraw) {
      drawSeg.style.width = `${match.oddsWinPctDraw}%`;
      drawSeg.querySelector('.match-odds-seg-label').textContent = `${Math.round(match.oddsWinPctDraw)}%`;
    }
    oddsEl.setAttribute(
      'aria-label',
      hasDraw
        ? `獲勝機率：${away.name} ${Math.round(match.oddsWinPctAway)}%，和局 ${Math.round(match.oddsWinPctDraw)}%，${home.name} ${Math.round(match.oddsWinPctHome)}%`
        : `獲勝機率：${away.name} ${Math.round(match.oddsWinPctAway)}%，${home.name} ${Math.round(match.oddsWinPctHome)}%`
    );
  }

  // F1's own real Polymarket odds - an outright winner market across the
  // whole grid, not a two-sided bar (see ./lib/polymarket.mjs and this
  // element's own CSS comment for why this needs an entirely different
  // shape) - just the top few favorites, each already a real devigged
  // win% for that specific driver.
  const outrightEl = node.querySelector('.match-odds-outright');
  if (Array.isArray(match.oddsFavorites) && match.oddsFavorites.length) {
    outrightEl.hidden = false;
    const items = outrightEl.querySelectorAll('.match-odds-outright-item');
    items.forEach((item, i) => {
      const favorite = match.oddsFavorites[i];
      item.hidden = !favorite;
      if (favorite) item.textContent = `${favorite.name} ${Math.round(favorite.pct)}%`;
    });
    outrightEl.setAttribute(
      'aria-label',
      `奪冠機率：${match.oddsFavorites.map(f => `${f.name} ${Math.round(f.pct)}%`).join('，')}`
    );
  }

  renderVenue(node.querySelector('.match-venue'), match);

  const watchEl = node.querySelector('.match-watch');
  if (match.whereToWatchTw && match.whereToWatchTw !== '無已知台灣轉播') {
    watchEl.hidden = false;
    watchEl.querySelector('.watch-text').textContent = match.whereToWatchTw;
    const badge = watchEl.querySelector('.watch-badge');
    const badgeLogo = watchEl.querySelector('.watch-logo');
    const badgeText = watchEl.querySelector('.watch-badge-text');
    const service = resolveService(match.whereToWatchTw);
    if (service && service.logo) {
      badge.hidden = false;
      badge.style.background = service.logoBg || '#fff';
      badgeLogo.src = service.logo;
      badgeLogo.alt = service.label;
      badgeLogo.hidden = false;
      badgeText.hidden = true;
      // Same defensive fallback as team logos (buildTeamRow) - an
      // external Commons hotlink can fail for reasons with nothing to do
      // with this page (rate limiting, an outage, the file being moved),
      // and the plain colored-initial badge is a fine fallback rather
      // than an empty box.
      badgeLogo.addEventListener(
        'error',
        () => {
          badgeLogo.hidden = true;
          if (service.badge) {
            badgeText.hidden = false;
            badgeText.textContent = service.badge;
            badge.style.background = service.color;
          } else {
            badge.hidden = true;
          }
        },
        { once: true }
      );
    } else if (service && service.badge) {
      badge.hidden = false;
      badgeLogo.hidden = true;
      badgeText.hidden = false;
      badgeText.textContent = service.badge;
      badge.style.background = service.color;
    } else {
      badge.hidden = true;
    }
  }

  // "推薦" is the SYSTEM's own judgment (computeDayPlan's scheduling
  // decision) - a card that's only in the plan because the viewer swiped
  // to it (see pinSlotChoice) isn't that, it's the viewer's own choice, so
  // it gets a visually distinct "偏好" tag instead. Using "推薦" for both
  // would misattribute a viewer's pick as the algorithm's recommendation.
  const recommendedTag = node.querySelector('.recommended-tag');
  if (match.isPreferred) {
    recommendedTag.hidden = false;
    recommendedTag.textContent = '偏好';
    recommendedTag.classList.add('is-preferred');
  } else if (match.recommended) {
    recommendedTag.hidden = false;
  }

  // The generic factor-label reason line ("依雙方戰績、近期戰況...計算。" -
  // see match-builder.mjs's buildObjectiveReasonZh) was reported as useless:
  // it never says anything a viewer couldn't already tell from the card
  // itself (which factors happen to feed a deterministic formula, not
  // anything about the actual matchup), and reads as boilerplate repeated
  // near-identically across most cards of the same sport. The underlying
  // `match.reason`/`match.objectiveFactors` fields are kept (still useful
  // for scripts/evaluate-recommendations.mjs and debugging matches.json
  // directly) - this just stops surfacing that boilerplate line in the UI.
  const reasonEl = node.querySelector('.match-reason');
  reasonEl.hidden = true;

  // A plain fact, independent of recommendation state entirely (see
  // resolveViewingPlan's own top comment on why overlap no longer decides
  // who gets recommended): if this match's start overlaps an EARLIER match
  // (one that started before it - "a previous game", not just any match
  // that happens to share time with it), say so and say how long, via
  // computeOverlapRange - a plain duration ("重疊 45 分鐘"), not a repeated
  // time range, since the card already shows its own start/end above.
  // Sorted CLOSEST-start-first, not just "any earlier match" - "與 X 重疊"
  // should name the game most likely airing right before this one started,
  // not whichever happened to be earliest in the day's own list order.
  // Among those, still prefers a recommended one when one exists (the more
  // useful "you could also be watching X" case) over an arbitrary one.
  // Excludes any match that's a NEAR-TOTAL overlap of this one (see
  // isNearTotalOverlap) - those are this match's own swipe-stack alternates
  // (see buildMatchStack/computeDayPlan's alternativeIds), not a genuine
  // "you could be watching a different, earlier game instead" conflict.
  // Reported directly: this note was comparing a card against its OWN
  // stack-mate ("of course they overlap, that's the whole reason they're
  // in the same stack together") instead of only against a real, separate
  // neighboring match - noise, not information, on every multi-member
  // stack's own alternates.
  const conflictNote = node.querySelector('.conflict-note');
  const earlierOverlaps = state.matches
    .filter(
      m =>
        (match.overlappingIds || []).includes(m.id) &&
        Date.parse(m.startTimeUtc) < Date.parse(match.startTimeUtc) &&
        !isNearTotalOverlap(match, m)
    )
    .sort((a, b) => Date.parse(b.startTimeUtc) - Date.parse(a.startTimeUtc));
  const earlierOverlap = earlierOverlaps.find(m => m.recommended) || earlierOverlaps[0];
  if (earlierOverlap) {
    const range = computeOverlapRange(match, earlierOverlap);
    const mins = range ? Math.round((range.end - range.start) / 60_000) : null;
    const clause =
      mins === null
        ? '時間重疊'
        : mins < 60
          ? `重疊 ${mins} 分鐘`
          : `重疊 ${Math.floor(mins / 60)} 小時${mins % 60 ? ` ${mins % 60} 分` : ''}`;
    conflictNote.hidden = false;
    conflictNote.textContent = `與「${earlierOverlap.name}」${clause}`;
    // Only dims the card when it's the weaker of the two AND the earlier
    // one is itself recommended - "you could be watching a better game
    // right now instead" is worth de-emphasizing for; two matches that are
    // BOTH recommended and simply overlap are both worth full attention,
    // so neither gets muted just for that.
    if (!match.recommended && earlierOverlap.recommended) node.classList.add('is-muted');
    else conflictNote.classList.add('is-info');
  }
  if (match.recommended) node.classList.add('is-recommended');

  // "設為偏好" - lets a viewer promote THIS card into a hard pin directly,
  // without needing it to already be a member of some other slot's swipe
  // stack - see preferMatch's own comment for why this exists (a slot with
  // only one cluster member has no swipe stack at all to act on). Never
  // shown for a match that's already the plan's own choice (nothing to
  // override) or a quiet-hours fixture (computeDayPlan excludes those from
  // every candidate set outright, so pinning one would silently do nothing).
  const preferBtn = node.querySelector('.match-prefer-btn');
  if (!match.isFinished && !match.recommended && !isQuietHours(match)) {
    preferBtn.hidden = false;
    preferBtn.addEventListener('click', () => preferMatch(match));
  }

  // Same single source of truth as relativeLabel above (matchLifecycleState)
  // - isFinished (ESPN's own status) always wins, and LIVE/ENDING_SOON both
  // read as "still live" for styling purposes; a match already underway
  // that's simply run past its estimated end (see estimatedDurationMinutes)
  // stays styled live rather than falling back to plain/upcoming.
  const lifecycle = matchLifecycleState(match);
  if (lifecycle === LIFECYCLE_STATES.ENDED) {
    node.classList.add('is-finished');
  } else if (lifecycle === LIFECYCLE_STATES.LIVE || lifecycle === LIFECYCLE_STATES.ENDING_SOON) {
    node.classList.add('is-live');
  }

  return node;
}

// Whichever match is currently live, or (failing that) the soonest one yet
// to start, moves to the front - this is the "show current/closest match
// on top" behavior, layered on top of the plain chronological order the
// rest of the list keeps. On a fully future day this just happens to be
// the day's first match anyway, so it's a no-op there; it only visibly
// reorders anything on the day containing "now".
function pinCurrentOrNext(sortedMatches) {
  // isFinished (ESPN's own status, via matchLifecycleState) is authoritative
  // and checked first, same reasoning as pickInitialDay's own comment -
  // without it, a match that simply ran long past its estimated duration
  // would look "not current anymore" here even though it's probably still
  // live, now that a finished match stays in the list instead of
  // disappearing. The first not-yet-ended match in start-time order is
  // exactly "whichever is live right now, or failing that, the soonest
  // still to come" - matchLifecycleState never calls a match ENDED on
  // elapsed time alone (see that function's own comment), so this can't be
  // fooled by a no-clock sport simply running long.
  const pinIndex = sortedMatches.findIndex(m => matchLifecycleState(m) !== LIFECYCLE_STATES.ENDED);
  if (pinIndex <= 0) return sortedMatches;
  const pinned = sortedMatches[pinIndex];
  return [pinned, ...sortedMatches.slice(0, pinIndex), ...sortedMatches.slice(pinIndex + 1)];
}

function matchesForDay(dayKey) {
  return state.matches.filter(m => localDateKey(new Date(m.startTimeUtc)) === dayKey);
}

function matchesForSelectedDay() {
  return matchesForDay(state.selectedDayKey);
}

function applySportFilter(matches) {
  return state.activeSport === 'all' ? matches : matches.filter(m => m.sport === state.activeSport);
}

// When a sport filter is active and the currently selected day turns out to
// have zero matches for it, jump the day picker to the nearest day that
// actually has one instead of leaving the viewer staring at an empty state
// for no visible reason. This is a real, common case for MLB
// specifically, not an edge case: Taiwan is far enough ahead of US time
// zones that a US evening fixture almost always lands on the viewer's NEXT
// local calendar date, not the same one (see localDateKey) - so "今天"
// can be completely empty for MLB even though a full night's worth of
// real MLB matches exist one tab over on "明天". Prefers the nearest day
// FORWARD (soonest upcoming), falling back to the nearest day backward
// only if every later day is also empty for this sport - either way,
// nearest, so this never jumps further than it has to. A no-op for `all`
// (nothing to be empty of), when the current day already has a match for
// it, or when this sport genuinely has nothing anywhere in the fetched
// window (nothing sensible to jump to).
function ensureSelectedDayHasActiveSport() {
  if (state.activeSport === 'all') return;
  if (matchesForDay(state.selectedDayKey).some(m => m.sport === state.activeSport)) return;
  const currentIndex = state.days.findIndex(d => d.key === state.selectedDayKey);
  const hasSport = day => matchesForDay(day.key).some(m => m.sport === state.activeSport);
  let candidate = null;
  for (let i = currentIndex + 1; i < state.days.length; i++) {
    if (hasSport(state.days[i])) { candidate = state.days[i]; break; }
  }
  if (!candidate) {
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (hasSport(state.days[i])) { candidate = state.days[i]; break; }
    }
  }
  if (!candidate) return;
  state.selectedDayKey = candidate.key;
}

function renderDayLabels() {
  const day = state.days.find(d => d.key === state.selectedDayKey);
  const label = day ? dayLabelFor(day.date) : '';
  dayLabelEls.forEach(el => { el.textContent = label; });
}

// A day genuinely worth showing as a clickable pill at all - state.days
// itself stays the FULL fetched window (every other piece of logic that
// walks it, e.g. ensureSelectedDayHasActiveSport's "jump to the nearest day
// that actually has a match", still needs the complete list to jump
// through) - this is only the UI-facing subset: a day with nothing to show
// isn't worth a tap target, and that's just as true when a sport filter is
// active (a day empty of MLB specifically shouldn't get a pill while "MLB"
// is the active filter, even though it might have other sports going on).
function visibleDays() {
  return state.days.filter(day => {
    const dayMatches = matchesForDay(day.key);
    return state.activeSport === 'all'
      ? dayMatches.length > 0
      : dayMatches.some(m => m.sport === state.activeSport);
  });
}

function renderDayScroller() {
  // Every day that actually has something to show, up front, no "load
  // more" click - the whole window is already in memory once the
  // full-window refresh tier lands (see refreshFullWindow/DEFAULT_DAYS_AHEAD),
  // so there's no cost to showing all of it right away; a click-to-reveal
  // step here would only ever hide days that were already sitting in
  // memory.
  const nodes = visibleDays().map(day => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-pill';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(day.key === state.selectedDayKey));
    btn.innerHTML = `<span class="day-pill-label">${dayLabelFor(day.date, { short: day.key !== localDateKey(new Date()) })}</span>`;
    btn.addEventListener('click', () => {
      state.selectedDayKey = day.key;
      renderDayScroller();
      renderDayLabels();
      renderSections();
    });
    return btn;
  });

  dayScrollerEl.replaceChildren(...nodes);
  const activePill = dayScrollerEl.querySelector('[aria-selected="true"]');
  if (activePill) activePill.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function renderFilters() {
  const sports = ['all', ...new Set(state.matches.map(m => m.sport))];
  filtersRow.replaceChildren(
    ...sports.map(sport => {
      const btn = document.createElement('button');
      btn.className = 'filter-chip';
      btn.type = 'button';
      if (sport !== 'all') btn.appendChild(buildSportIcon(sport));
      const label = document.createElement('span');
      label.textContent = sport === 'all' ? '全部' : SPORT_LABELS_ZH[sport] || sport;
      btn.appendChild(label);
      btn.setAttribute('aria-pressed', String(sport === state.activeSport));
      btn.addEventListener('click', () => {
        state.activeSport = sport;
        ensureSelectedDayHasActiveSport();
        renderDayScroller();
        renderDayLabels();
        renderFilters();
        renderSections();
      });
      return btn;
    })
  );
}

// A slot with more than one near-total-overlapping member (see
// groupIntoSlots) - a tap-to-switch card stack: exactly one member is shown
// at a time, plus prev/next arrows and directly-tappable dots to switch to
// another. Tapping a control PINS that match immediately (see
// pinSlotChoice/computeDayPlan) - matches before and after it reflow to
// connect with it instead of with whichever match was the plan's own
// default pick.
//
// Deliberately NOT a drag/swipe gesture - see this function's own git
// history for the two designs this replaced (native scroll-snap polling for
// momentum to settle, then a hand-rolled Touch-Events drag with a CSS
// transform) and the string of real, live-reported regressions BOTH kept
// producing on real Safari: stuck cards, a stack frozen solid after a
// single swipe, cards landing on the wrong index. Every one of those bugs
// came from the same root cause - inferring "the gesture is done, it is now
// safe to commit and reparent this DOM node" from some signal (a poll, a
// frame count, a transitionend event) that real WebKit didn't reliably
// deliver when this codebase needed it to. A tap has no such problem: a
// `click` handler fires exactly once, synchronously, with nothing further
// to wait for - there is no gesture-in-progress state this node can get
// stuck in, because there is no gesture, only a discrete press. This also
// means every render can simply show whichever member is currently primary,
// with no separate DOM-node-reuse mechanism needed to avoid a visible
// flash (see this file's own git history for the old interactedStack/
// patchStackSelectionTags machinery that existed only to work around that)
// - and no scroll position or open touch sequence than can ever survive
// (or fail to survive) a render pass, so this is also the direct fix for
// "one swipe reused an old stale visual state forever" (a `.is-muted` class
// that patchStackSelectionTags never got around to clearing being the
// concrete case reported).
function buildMatchStack(dayKey, members, primary, isTopOfDay) {
  // The CLUSTER's own key (every near-total-overlapping member, set by
  // computeDayPlan on the recommended pick - see that field's own comment
  // in recommendation.mjs), not slotKeyFromMembers(members) - `members`
  // here can be just this one stack's own [primary, ...alternatives]
  // subset, which for a 3+-member cluster where more than one member got
  // independently recommended is NOT the same set computeDayPlan itself
  // groups under. Falling back to the members-based key only for a
  // hand-built primary that never went through computeDayPlan (shouldn't
  // happen from renderRecommendedSection, but keeps this function honest
  // as a pure function of its arguments either way).
  const slotKey = primary.slotKey || slotKeyFromMembers(members);
  const wrapper = document.createElement('div');
  wrapper.className = 'match-stack';
  wrapper.dataset.slotKey = slotKey;

  const hint = document.createElement('p');
  hint.className = 'match-stack-hint';
  hint.textContent = '⟷ 這個時段只能擇一收看，點選切換要看哪一場';

  // A FIXED order (by score, highest first), independent of which member is
  // currently primary - so the dots/arrows always land in the same visual
  // order across renders, rather than reshuffling around whichever member
  // just got pinned. viewerScore, not the older effectiveScore name - see
  // recommendation.mjs's computeRecommendationScore/resolveViewingPlan.
  const ordered = members.slice().sort((a, b) => b.viewerScore - a.viewerScore);
  const currentIndex = Math.max(0, ordered.findIndex(m => m.id === primary.id));

  const viewport = document.createElement('div');
  viewport.className = 'match-stack-viewport';
  const card = buildMatchCard(ordered[currentIndex]);
  if (isTopOfDay) card.classList.add('is-pinned');
  viewport.appendChild(card);

  function choose(index) {
    const clamped = Math.min(ordered.length - 1, Math.max(0, index));
    const chosen = ordered[clamped];
    if (chosen && chosen.id !== primary.id) pinSlotChoice(dayKey, slotKey, chosen.id);
  }

  // ---- Swipe gesture (layered on top of choose(), never a second state
  // machine) -----------------------------------------------------------
  //
  // The prior swipe implementation was ripped out entirely (see this
  // function's own git history / docs/recommendation-engine-audit.md Round
  // 12) after three straight live-reported "stuck after one swipe on
  // Safari" bugs, each one a variant of the same root cause: the gesture's
  // COMPLETION was decided by something that can silently never fire on
  // real Safari - a requestAnimationFrame count, then a `transitionend`
  // listener (Safari drops transitionend outright when a transition is
  // interrupted, backgrounded, or its element is removed mid-transition -
  // exactly what happens here on every successful swipe, since choose()
  // replaces this whole card). That rewrite went all the way to tap-only
  // controls to eliminate the bug class structurally.
  //
  // This restores dragging as a real INPUT method without reintroducing
  // that risk, by keeping the actual commit point synchronous and
  // untangled from any animation:
  //   - Pointer Events (not separate touch/mouse listeners) + explicit
  //     setPointerCapture, so a fast or wandering finger can't "lose" the
  //     gesture the way a plain touchmove/touchend pair can on iOS Safari
  //     when the finger drifts outside the element's box mid-drag.
  //   - `touch-action: pan-y` on the card (see styles.css) instead of a
  //     manual preventDefault() dance, so Safari's own native gesture
  //     engine (not our JS) arbitrates "this is a page scroll" vs. "this
  //     is a horizontal swipe" - one less place for our own logic to get
  //     that disambiguation wrong.
  //   - The decision to advance is made directly in the pointerup handler,
  //     synchronously, from the pointer's own final position - never from
  //     a transition/animation callback. Any fly-off animation on commit
  //     is purely decorative: it's started and then immediately abandoned
  //     as choose() tears down this exact card node, so nothing downstream
  //     ever waits on it to finish.
  //   - pointerup, pointercancel AND lostpointercapture all route through
  //     the same resetDrag(), so however the gesture ends (a normal
  //     release, the OS taking the gesture back for its own use, a second
  //     finger landing), the card is guaranteed to leave the drag state -
  //     never left stranded mid-transform waiting for an event that might
  //     not come.
  const SWIPE_COMMIT_PX = 60;
  const SWIPE_START_PX = 8;
  let activePointerId = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragDx = 0;
  let isHorizontalDrag = false;

  function setDragTransform(dx) {
    card.style.transition = 'none';
    card.style.transform = `translateX(${dx}px) rotate(${dx / 28}deg)`;
  }

  function resetDrag() {
    activePointerId = null;
    isHorizontalDrag = false;
    dragDx = 0;
    card.style.transition = 'transform 180ms ease';
    card.style.transform = '';
  }

  // A card contains real <img> team-logo elements, and starting a mouse
  // drag ON TOP of an <img> is the browser's own built-in trigger for
  // native HTML5 drag-and-drop (a "ghost" copy of the image that follows
  // the cursor, entirely outside this code's event handling) - reported
  // live as the swipe visibly getting "stuck in the background" when
  // dragging with a mouse on a screen bigger than a phone, i.e. exactly
  // the desktop/mouse case real touch never hits (a touch drag doesn't
  // start the native image drag the way a mousedown-on-an-<img> does).
  // preventDefault() here is what stops that native drag from ever
  // starting, on top of the CSS `-webkit-user-drag: none` on the card's
  // own images (styles.css) for the browsers that honor it.
  card.addEventListener('pointerdown', event => {
    if (!event.isPrimary || activePointerId != null) return;
    if (event.target.closest('button')) return; // dots/arrows keep their own click handling
    event.preventDefault();
    activePointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragDx = 0;
    isHorizontalDrag = false;
    // setPointerCapture is what keeps this whole gesture pinned to `card`
    // even if the finger wanders outside its box mid-drag - a plain
    // touchmove/touchend pair has no equivalent, and losing that tracking
    // mid-gesture (finger drifts, a neighboring element intercepts it) is
    // exactly the kind of thing that left the old drag implementation
    // stuck. Best-effort: a capture failure just means this drag behaves
    // like a live-tracked gesture without the safety net, never a thrown
    // error that breaks rendering.
    try { card.setPointerCapture(activePointerId); } catch { /* see above */ }
  });

  card.addEventListener('pointermove', event => {
    if (event.pointerId !== activePointerId) return;
    const dx = event.clientX - dragStartX;
    const dy = event.clientY - dragStartY;
    if (!isHorizontalDrag) {
      if (Math.abs(dx) < SWIPE_START_PX && Math.abs(dy) < SWIPE_START_PX) return;
      // A drag that turns out to be more vertical than horizontal is a
      // page scroll, not a swipe - let go of it entirely (touch-action:
      // pan-y already told Safari the same thing) rather than fighting it.
      if (Math.abs(dy) > Math.abs(dx)) {
        activePointerId = null;
        return;
      }
      isHorizontalDrag = true;
    }
    dragDx = dx;
    setDragTransform(dx);
  });

  function endDrag(event) {
    if (event.pointerId !== activePointerId) return;
    const committedDx = isHorizontalDrag ? dragDx : 0;
    const wasHorizontalDrag = isHorizontalDrag;
    resetDrag();
    if (!wasHorizontalDrag || Math.abs(committedDx) < SWIPE_COMMIT_PX) return;
    // Already at that end of the stack (e.g. swiping right on the very
    // first card) - nothing to advance to, so this must snap back like any
    // other below-threshold drag rather than fly off into an empty
    // replacement that never comes (choose() below is a no-op when the
    // target index is already the current one - see its own clamp).
    const targetIndex = committedDx < 0 ? currentIndex + 1 : currentIndex - 1;
    const target = ordered[Math.min(ordered.length - 1, Math.max(0, targetIndex))];
    if (!target || target.id === primary.id) return;
    // Purely decorative fly-off - choose() below replaces this card
    // outright, so nothing ever waits on this transition to complete.
    card.style.transition = 'transform 150ms ease, opacity 150ms ease';
    card.style.transform = `translateX(${committedDx > 0 ? 100 : -100}%) rotate(${committedDx / 12}deg)`;
    card.style.opacity = '0';
    choose(targetIndex);
  }

  card.addEventListener('pointerup', endDrag);
  card.addEventListener('pointercancel', () => {
    activePointerId = null;
    resetDrag();
  });
  card.addEventListener('lostpointercapture', () => {
    if (activePointerId != null) resetDrag();
    activePointerId = null;
  });

  const nav = document.createElement('div');
  nav.className = 'match-stack-nav';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'match-stack-arrow';
  prevBtn.setAttribute('aria-label', '上一場');
  prevBtn.textContent = '‹';
  prevBtn.disabled = currentIndex === 0;
  prevBtn.addEventListener('click', () => choose(currentIndex - 1));

  const dots = document.createElement('div');
  dots.className = 'match-stack-dots';
  ordered.forEach((match, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'match-stack-dot' + (index === currentIndex ? ' is-active' : '');
    dot.setAttribute('aria-label', `切換到${match.name || index + 1}`);
    dot.addEventListener('click', () => choose(index));
    dots.appendChild(dot);
  });

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'match-stack-arrow';
  nextBtn.setAttribute('aria-label', '下一場');
  nextBtn.textContent = '›';
  nextBtn.disabled = currentIndex === ordered.length - 1;
  nextBtn.addEventListener('click', () => choose(currentIndex + 1));

  nav.append(prevBtn, dots, nextBtn);
  wrapper.append(hint, viewport, nav);
  return wrapper;
}

function renderRecommendedSection() {
  const dayKey = state.selectedDayKey;
  // Computed fresh every render, scoped to whatever's currently active
  // (day, sport filter, pins) - see computeDayPlan's own comment. Picking
  // "只看 MLB" gets its own MLB-only continuous plan, not the cross-sport
  // plan filtered down to whichever MLB picks happened to survive it.
  //
  // state.recommendationHistory (see renderSections) is built from the
  // FULL, unfiltered window regardless of today's sport filter - a soft
  // repeat penalty on "did we recommend this matchup yesterday" has to be
  // asking about what was ACTUALLY recommended, not what a differently
  // filtered view would have picked.
  const dayCandidates = dayCandidatesForPlan(dayKey);
  const dayPlan = computeDayPlan(dayKey, dayCandidates, state.pinnedChoices.get(dayKey), { scoreField: 'planningScore' });
  const ordered = pinCurrentOrNext(dayPlan);

  if (!ordered.length) {
    recommendedListEl.replaceChildren();
    recommendedEmptyEl.hidden = false;
    return;
  }
  recommendedEmptyEl.hidden = true;
  // alternativeIds can point at a fixture on a different (adjacent) local
  // day if the slot straddles midnight for this viewer - resolved from the
  // full state.matches, not just today's bucket, so that edge case doesn't
  // just silently drop the alternative.
  const byId = new Map(state.matches.map(m => [m.id, m]));
  // Per-day, per-slot FROZEN membership - see state.stackMembershipByDay's
  // own comment for why. computeDayPlan's alternativeIds is genuinely
  // recomputed per CHOICE (whichever member the scheduler/a pin actually
  // picked for that slot this render), and two different members of the
  // same big transitive conflict cluster can have very different direct-
  // overlap neighborhoods (a real MLB slate stagger this codebase already
  // documents) - so swiping to a new primary can hand back a larger/
  // different alternatives list than the one the viewer was just looking
  // at, which reads as the stack growing/reshuffling mid-interaction. Once
  // a slot's member set is established on its first render for this day,
  // every later render (a pin, a live poll) keeps showing exactly those
  // same members - only which one is primary/pinned changes.
  let dayMembership = state.stackMembershipByDay.get(dayKey);
  if (!dayMembership) {
    dayMembership = new Map();
    state.stackMembershipByDay.set(dayKey, dayMembership);
  }
  // How many recommended picks sharing this render's `slotKey` we've
  // already turned into a stack, so two separate stacks from the SAME
  // transitive cluster (see computeDayPlan's own comment on `slotKey`: "a
  // cluster of 3+ near-total-overlapping matches where the scheduler
  // independently recommends more than one of them... renders as TWO
  // separate swipeable stacks... both part of the same underlying conflict
  // cluster") get their OWN frozen membership entry below instead of
  // colliding on one shared `dayMembership` key. Live-verified 9/23 case:
  // a single 15-match MLB cluster (every game between 06:35-10:10 chained
  // together by transitive near-overlap) produced two independent picks,
  // 06:35 Blue Jays/Orioles and 09:40 Angels/Athletics - both carry the
  // exact same `slotKey` (the whole cluster). Without this counter, the
  // second stack's `dayMembership.get(slotKey)` found the FIRST stack's
  // already-frozen members (Brewers/Phillies, Cardinals/Pirates, etc. -
  // none of which overlap the 09:40 game at all) and showed those as its
  // own "alternatives", exactly the "bunch of nonexistent cards" reported:
  // swiping the second stack flipped between games with zero real time
  // conflict with what was actually in that slot.
  const stackOccurrenceBySlotKey = new Map();
  const fragment = document.createDocumentFragment();
  ordered.forEach((match, index) => {
    // A FINISHED match is kept in 推薦賽事 purely as viewing HISTORY (see
    // computeDayPlan's own comment on why a finished fixture is a normal,
    // still-scheduled candidate, not silently dropped once it ends) - it
    // can still come back from computeDayPlan with alternativeIds set (its
    // near-total-overlap rivals from earlier that day), but swiping between
    // "what I could have watched instead" for a game that's already over
    // isn't a real choice anymore, just noise on what's supposed to be a
    // simple record of what was on. Always a single plain card here,
    // regardless of alternatives - reported directly: a finished match
    // should never be swipeable.
    if (match.isFinished) {
      const card = buildMatchCard(match);
      if (index === 0) card.classList.add('is-pinned');
      fragment.appendChild(card);
      return;
    }
    let alternatives = (match.alternativeIds || []).map(id => byId.get(id)).filter(Boolean);
    if (alternatives.length) {
      let members = [match, ...alternatives];
      const slotKey = match.slotKey || slotKeyFromMembers(members);
      // Composite key: which OCCURRENCE of this shared cluster slotKey this
      // is within THIS render's chronological pass, not the bare slotKey -
      // see the comment on stackOccurrenceBySlotKey above for why a bare
      // slotKey collides across a cluster's separate stacks.
      const occurrence = stackOccurrenceBySlotKey.get(slotKey) || 0;
      stackOccurrenceBySlotKey.set(slotKey, occurrence + 1);
      const freezeKey = `${slotKey}::${occurrence}`;
      const knownIds = dayMembership.get(freezeKey);
      if (knownIds) {
        // Never `.recommended` (besides `match` itself) - a frozen member
        // that ended up independently recommended elsewhere this render
        // has to stay excluded here too, same invariant computeDayPlan's
        // own alternativeIds already enforces (docs/
        // recommendation-engine-audit.md's Invariant 1: never both
        // recommended and someone else's alternative).
        const stable = [...knownIds]
          .map(id => byId.get(id))
          .filter(m => m && (m.id === match.id || !m.recommended));
        if (!knownIds.has(match.id)) stable.push(match);
        members = stable;
        alternatives = members.filter(m => m.id !== match.id);
      } else {
        dayMembership.set(freezeKey, new Set(members.map(m => m.id)));
      }
      if (!alternatives.length) {
        const card = buildMatchCard(match);
        if (index === 0) card.classList.add('is-pinned');
        fragment.appendChild(card);
        return;
      }
      const isTopOfDay = index === 0;
      // Always a fresh build - a tap-to-switch stack (see buildMatchStack's
      // own comment) has no scroll position or in-flight gesture that a
      // rebuild could ever visibly disrupt, so there's no need for the old
      // DOM-node-reuse mechanism a drag-based stack once required here.
      fragment.appendChild(buildMatchStack(dayKey, members, match, isTopOfDay));
    } else {
      const card = buildMatchCard(match);
      if (index === 0) card.classList.add('is-pinned');
      fragment.appendChild(card);
    }
  });
  recommendedListEl.replaceChildren(fragment);
}

function renderAllMatchesSection() {
  const dayMatches = applySportFilter(matchesForSelectedDay());
  dayMatches.sort((a, b) => Date.parse(a.startTimeUtc) - Date.parse(b.startTimeUtc));

  if (!dayMatches.length) {
    allMatchListEl.replaceChildren();
    allEmptyEl.hidden = false;
    return;
  }
  allEmptyEl.hidden = true;
  const fragment = document.createDocumentFragment();
  dayMatches.forEach(match => fragment.appendChild(buildMatchCard(match)));
  allMatchListEl.replaceChildren(fragment);
}

function renderSections() {
  // Rebuilds state.recommendationHistory from a fresh, UNFILTERED (every
  // enabled sport, every fetched day) computeWindowPlan pass, in
  // chronological order, before either section below reads it - see
  // renderRecommendedSection's own comment on why this has to stay
  // independent of the viewer's current sport filter. Cheap enough to
  // redo on every render (a 14-day window's own DP, not a network call);
  // its `plan` half is intentionally discarded here since it's this
  // unfiltered plan, not necessarily what actually renders below.
  const matchesByDayKey = new Map(state.days.map(day => [day.key, matchesForDay(day.key)]));
  const windowPlan = computeWindowPlan(matchesByDayKey, state.pinnedChoices);
  state.recommendationHistory = windowPlan.historyByDayKey;
  state.recentPicksByDayKey = windowPlan.recentPicksByDayKey;
  state.sportConcentration = windowPlan.sportConcentration;
  renderRecommendedSection();
  renderAllMatchesSection();
}

// Fixtures ESPN has on the schedule but hasn't set a real kickoff time for
// yet (see match-builder.mjs's isTimeTbd - almost always a playoff game whose
// bracket slot is set before its exact date/time is) - these never carry a
// trustworthy startTimeUtc, so they're kept entirely out of the day-picker/
// DP pipeline (see applyFreshBuild) and just listed here once, independent
// of whichever day is currently selected, with a "時間未定" label instead
// of a clock time.
function renderTbdSection() {
  if (!state.tbdMatches.length) {
    tbdSection.hidden = true;
    tbdListEl.replaceChildren();
    return;
  }
  tbdSection.hidden = false;
  const fragment = document.createDocumentFragment();
  state.tbdMatches.forEach(match => fragment.appendChild(buildMatchCard(match)));
  tbdListEl.replaceChildren(fragment);
}

function buildDayList(matches) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysAhead = state.daysAhead || 14;
  const days = Array.from({ length: daysAhead }, (_, i) => {
    const date = new Date(today.getTime() + i * 86_400_000);
    return { key: localDateKey(date), date };
  });
  // Always include every fetched match's own day too, in case the viewer's
  // timezone shifts a match onto a day just past the nominal daysAhead
  // window (e.g. a match at 23:00 UTC on the last fetched day is already
  // "tomorrow" west of the date line).
  const seen = new Set(days.map(d => d.key));
  matches.forEach(match => {
    const key = localDateKey(new Date(match.startTimeUtc));
    if (!seen.has(key)) {
      seen.add(key);
      days.push({ key, date: new Date(match.startTimeUtc) });
    }
  });
  days.sort((a, b) => a.date - b.date);
  return days;
}

// "Today" is the natural default, but if every one of today's fixtures has
// already ended (or there simply are none), staying on "today" would just
// show an empty state for no reason - jump ahead to the next day that
// actually has a fixture still to come instead.
function pickInitialDay(days, matches) {
  const todayKey = localDateKey(new Date());
  // matchLifecycleState (via isFinished, ESPN's own status) is what decides
  // "remaining" here, never elapsed time alone - see that function's own
  // comment on why a no-clock sport running long is never inferred as over.
  const todayHasRemaining = matches.some(
    m => localDateKey(new Date(m.startTimeUtc)) === todayKey && matchLifecycleState(m) !== LIFECYCLE_STATES.ENDED
  );
  if (todayHasRemaining) return todayKey;

  const todayIndex = days.findIndex(d => d.key === todayKey);
  for (let i = todayIndex + 1; i < days.length; i++) {
    if (matches.some(m => localDateKey(new Date(m.startTimeUtc)) === days[i].key)) {
      return days[i].key;
    }
  }
  return todayKey;
}

// Folds a freshly-built match list into whatever's already loaded, by id -
// an UPSERT, never a wholesale replace. Two real reasons this matters now
// that fetching happens live, repeatedly, in the browser rather than once
// at build time: (1) the near-term refresh tier (see scheduleNearTermRefresh
// below) only ever re-fetches a couple of days' worth of fixtures - a
// wholesale replace would wipe out every far-future day the last FULL
// refresh already populated; (2) buildMatches already degrades a single
// league's own fetch failure to an empty list for just that league rather
// than throwing (see that function's own comment) - replacing the whole
// match set with a result where one league came back empty would delete
// every match of that league from the page over a single transient
// network blip, not just fail to refresh it.
function mergeFreshMatches(freshMatches) {
  const byId = new Map(state.allRawMatches.map(m => [m.id, m]));
  const byTbdKey = new Map(state.tbdMatches.map(m => [m.id, m]));
  freshMatches.forEach(m => {
    if (m.timeTbd) byTbdKey.set(m.id, m);
    else byId.set(m.id, m);
  });
  return { rawMatches: [...byId.values()], tbdMatches: [...byTbdKey.values()] };
}

// Applies a freshly-built match list to the page - called by both refresh
// tiers below (and the initial load, which is just the full-window tier's
// own first run), so "how a fresh batch of matches turns into what's on
// screen" only exists in one place.
function applyFreshBuild(matches, generatedAt) {
  const previousIds = new Set(state.allRawMatches.map(m => m.id));
  const { rawMatches, tbdMatches } = mergeFreshMatches(matches);
  // A genuine add/remove (a new fixture entering the window, a
  // postponement) invalidates last render's frozen stack membership (see
  // state.stackMembershipByDay's own comment) - but a routine refresh that
  // only UPDATED existing matches in place (a score, an odds move) must
  // NOT reset it, or every swipeable stack would reshuffle on every single
  // refresh tick regardless of whether anything conflict-relevant actually
  // changed.
  const freshIds = new Set(rawMatches.map(m => m.id));
  if (previousIds.size !== freshIds.size || [...previousIds].some(id => !freshIds.has(id))) {
    state.stackMembershipByDay = new Map();
  }

  state.tbdMatches = tbdMatches;
  if (generatedAt) {
    const generated = new Date(generatedAt);
    generatedNote.textContent = `資料最後更新於 ${localDayFormatter().format(generated)} ${localTimeFormatter().format(generated)}（你的當地時間）`;
  }
  renderTbdSection();

  if (!rawMatches.length) {
    // Still worth showing the app shell if there's nothing but TBD
    // fixtures to show (renderTbdSection above already populated that
    // section) - #tbd-section lives inside #app, so #app itself has to be
    // unhidden for it to actually show up.
    appEl.hidden = !state.tbdMatches.length;
    emptyState.hidden = !!state.tbdMatches.length;
    return;
  }

  errorState.hidden = true;
  // The day-scroller's own pill COUNT is a UI-window concept independent
  // of which refresh tier just ran - a near-term refresh only re-fetches a
  // couple of days, but every day the last full-window refresh already
  // populated still deserves its own pill.
  state.daysAhead = DEFAULT_DAYS_AHEAD;
  state.allRawMatches = rawMatches;
  applyEnabledSportsAndRender();
}

// Filters state.allRawMatches down to the sports currently enabled in
// Settings (see "Enabled sports settings" below), then redoes everything
// downstream of that - the viewing plan, the day list (a day can gain or
// lose entries entirely depending which sports are on), and every render
// call. Shared by the initial load/poll (applyFreshBuild) and by toggling a
// sport in Settings, so "what's actually on screen" only ever has one path
// from "which sports are enabled" to the DOM.
function applyEnabledSportsAndRender() {
  // A day that's already past can never be pinned against again either way
  // - see prunePinnedChoices' own comment - so this is as good a place as
  // any recurring one (initial load, every data poll, every sport toggle)
  // to keep localStorage/the synced payload from growing forever.
  prunePinnedChoices();
  const rawMatches = state.allRawMatches.filter(m => state.enabledSports.has(m.sport));
  state.rawMatches = rawMatches;
  state.matches = resolveViewingPlan(rawMatches, state.priorityOrder, state.myServiceIds);
  state.days = buildDayList(state.matches);
  // A sport filter that no longer exists at all (its sport just got
  // disabled in Settings) would otherwise leave the filter chips all
  // showing unselected (none of them is this stale sport anymore) while
  // every section quietly renders empty, with nothing on screen to explain
  // why - reset to "all" so disabling a sport always shows what's left
  // instead of silently going blank. A sport that's merely empty on the
  // CURRENT day but still enabled/exists elsewhere is handled below
  // instead (ensureSelectedDayHasActiveSport), not here.
  if (state.activeSport !== 'all' && !state.matches.some(m => m.sport === state.activeSport)) {
    state.activeSport = 'all';
  }
  // Keep whatever day the viewer is already looking at if it still exists
  // in the refreshed window (a routine data refresh shouldn't yank someone
  // back to "today" out from under them) - only fall back to picking a
  // fresh default when their previous selection no longer has a match at
  // all (e.g. it aged out of the rolling window, or its only sport just
  // got disabled).
  if (!state.selectedDayKey || !state.days.some(d => d.key === state.selectedDayKey)) {
    state.selectedDayKey = pickInitialDay(state.days, state.matches);
  }

  // A sport that's still enabled but simply has nothing on the day the
  // viewer happens to be on (see that function's own comment - the common
  // MLB-vs-Taiwan-timezone case) jumps to the nearest day that has it.
  ensureSelectedDayHasActiveSport();

  appEl.hidden = false;
  emptyState.hidden = true;
  renderDayScroller();
  renderDayLabels();
  renderFilters();
  renderSections();
}

// ---- Live match data: two refresh tiers, both calling buildMatches -------
//
// This replaces a scheduled GitHub Action that rebuilt a static
// matches.json every 15 minutes and redeployed it - see this file's own
// top comment for why. Two tiers, not one, because ESPN's own scoreboard
// endpoint has no multi-day range query for a team sport (confirmed live -
// only F1's own racing/f1 endpoint accepts one), so fetching the WHOLE
// multi-week window really is one request per league per day, not
// something a single cheap query could replace - doing that on every
// refresh, aggressively, isn't practical:
//   - NEAR-TERM tier (NEAR_TERM_DAYS_AHEAD days, every NEAR_TERM_REFRESH_MS):
//     cheap (a handful of requests), so this can run often - today/
//     tomorrow's scores, new fixtures, and odds are the ones actually
//     worth being "live" about.
//   - FULL-WINDOW tier (the whole DEFAULT_DAYS_AHEAD-day horizon, every
//     FULL_REFRESH_MS): expensive (~50+ requests), so this runs far less
//     often - a fixture 10 days out doesn't need up-to-the-minute
//     freshness, nothing about it is "live" in any meaningful sense.
// Both apply through the SAME mergeFreshMatches/applyFreshBuild (see
// above) - an upsert, never a wholesale replace - so neither tier can ever
// wipe out what the other one already loaded.
const NEAR_TERM_DAYS_AHEAD = 2;
const NEAR_TERM_REFRESH_MS = 60_000;
const FULL_REFRESH_MS = 5 * 60_000;

let nearTermRefreshTimer = null;
let fullRefreshTimer = null;

async function refreshNearTerm() {
  try {
    const { matches, generatedAt } = await buildMatches({ daysAhead: NEAR_TERM_DAYS_AHEAD, fetchJson: proxyFetchJson });
    applyFreshBuild(matches, generatedAt);
  } catch (error) {
    console.error('near-term refresh failed', error);
  }
}

// `silent` keeps the background timer from fighting with a viewer who just
// tapped "立即重新整理" for status text either one might want to set.
async function refreshFullWindow({ silent = false, statusEl, button } = {}) {
  if (!silent) {
    if (statusEl) statusEl.textContent = '重新整理中…';
    if (button) button.disabled = true;
  }
  try {
    const { matches, generatedAt } = await buildMatches({ daysAhead: DEFAULT_DAYS_AHEAD, fetchJson: proxyFetchJson });
    applyFreshBuild(matches, generatedAt);
    if (!silent && statusEl) statusEl.textContent = '資料已更新。';
  } catch (error) {
    console.error('full refresh failed', error);
    if (!silent && statusEl) statusEl.textContent = '重新整理失敗，請稍後再試。';
  } finally {
    if (!silent && button) button.disabled = false;
  }
}

function scheduleNearTermRefresh() {
  if (nearTermRefreshTimer) clearTimeout(nearTermRefreshTimer);
  nearTermRefreshTimer = setTimeout(async () => {
    // A backgrounded tab still gets rescheduled (so it picks back up the
    // moment it's visible again) but skips the actual fetch - no point
    // spending battery/quota refreshing a page nobody's looking at.
    if (document.visibilityState !== 'hidden') await refreshNearTerm();
    scheduleNearTermRefresh();
  }, NEAR_TERM_REFRESH_MS);
}

function scheduleFullRefresh() {
  if (fullRefreshTimer) clearTimeout(fullRefreshTimer);
  fullRefreshTimer = setTimeout(async () => {
    if (document.visibilityState !== 'hidden') await refreshFullWindow({ silent: true });
    scheduleFullRefresh();
  }, FULL_REFRESH_MS);
}

refreshDataBtn.addEventListener('click', () => {
  refreshFullWindow({ statusEl: updateStatusText, button: refreshDataBtn });
});

// ---- Live score/odds polling (see ./lib/espn.mjs and ./lib/polymarket.mjs) -
//
// A THIRD, even faster refresh tier on top of the two buildMatches tiers
// above (near-term/full-window) - this one polls just SCORE/STATUS/ODDS
// for whatever's already loaded, on a much shorter interval than either
// buildMatches tier could reasonably run at (see this file's own top
// comment on why re-scoring a whole fetch batch isn't cheap enough to do
// every few seconds), by hitting each sport's OWN narrow live-scoreboard
// endpoint (today ± a day, not the whole window) and merging the result
// straight into the SAME match objects buildMatches already produced -
// never re-running the scoring/duration/objective-factor pipeline itself,
// only the same live facts already reported (score, finished status,
// odds), plus letting recommendation.mjs's own liveExcitementBonus react
// to a live score change so a live match that turns out to be a genuine
// nail-biter can bump the day's plan (item 6) - see
// applyRecentRepeatPenalties's own comment for where that bonus is
// actually applied. Score/status comes from ESPN's own public scoreboard;
// odds comes from Polymarket instead (see ./lib/polymarket.mjs for why) -
// two separate fetches below, since not every sport this tracks has both
// (F1 has real, live Polymarket odds but no ESPN score to poll at all).
const LIVE_POLL_INTERVAL_MS = 30_000;
let livePollTimer = null;
// How far before kickoff this starts polling a still-PRE fixture purely for
// odds movement (never score, which doesn't exist yet) - live-verified a
// real MLS moneyline already posted ~3.3 hours before kickoff, so this errs
// wide: polling a match that in fact has no market open yet is a harmless
// no-op (resolveTeamOdds/resolveF1WinnerOdds just report null again), not a
// wasted or incorrect request.
const PREGAME_ODDS_POLL_WINDOW_MS = 48 * 60 * 60 * 1000;

function matchWorthPollingNow(m, now = Date.now()) {
  // Worth polling if EITHER a live score (ESPN, team sports only) OR live
  // odds (Polymarket, every sport this app tracks including F1 - see
  // ./lib/polymarket.mjs) could come from it - a plain F1 race has no
  // ESPN-reported score to poll at all, but it still has real, moving
  // Polymarket odds worth refreshing.
  if (m.timeTbd || m.isFinished) return false;
  if (!TEAM_LEAGUE_ESPN[m.sport] && POLYMARKET_TAG_ID[m.sport] == null) return false;
  const lifecycle = matchLifecycleState(m, now);
  if (lifecycle === LIFECYCLE_STATES.LIVE || lifecycle === LIFECYCLE_STATES.ENDING_SOON) return true;
  if (lifecycle === LIFECYCLE_STATES.STARTING_SOON) return true;
  const msToStart = Date.parse(m.startTimeUtc) - now;
  return msToStart > 0 && msToStart <= PREGAME_ODDS_POLL_WINDOW_MS;
}

function anyMatchWorthPollingNow() {
  return state.allRawMatches.some(m => matchWorthPollingNow(m));
}

function sportsWorthPollingNow() {
  const sports = new Set();
  state.allRawMatches.forEach(m => {
    if (matchWorthPollingNow(m)) sports.add(m.sport);
  });
  return sports;
}

async function pollLiveMatches() {
  if (!state.proxyUrl) return;
  const sports = sportsWorthPollingNow();
  if (!sports.size) return;

  const byId = new Map(state.allRawMatches.map(m => [m.id, m]));
  let changed = false;
  await Promise.allSettled(
    [...sports].map(async sport => {
      const target = liveScoreboardUrl(sport);
      if (!target) return;
      const response = await fetch(`${state.proxyUrl}/sports-proxy?url=${encodeURIComponent(target)}`, {
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const scoreboard = await response.json();
      extractLiveUpdates(sport, scoreboard).forEach((update, id) => {
        const match = byId.get(id);
        if (!match || match.isFinished) return;
        const [awayScore, homeScore] = update.scores;
        if (Array.isArray(match.competitors) && match.competitors.length === 2) {
          if (awayScore != null && match.competitors[0].score !== awayScore) {
            match.competitors[0].score = awayScore;
            changed = true;
          }
          if (homeScore != null && match.competitors[1].score !== homeScore) {
            match.competitors[1].score = homeScore;
            changed = true;
          }
        }
        if (update.oddsSpread != null) match.oddsSpread = update.oddsSpread;
        if (update.oddsOverUnder != null) match.oddsOverUnder = update.oddsOverUnder;
        if (update.isFinished && !match.isFinished) {
          match.isFinished = true;
          changed = true;
        }
        // Live-corrects the pre-game duration estimate from ESPN's own
        // current inning/quarter/match-minute - see
        // recommendation.mjs's estimateLiveDurationMinutes for why this
        // directly improves scheduling (effectiveDurationMinutes/
        // schedulingInterval), not just what's printed on the card, and
        // this repo's own reported "MLB drops 30-60 minutes off its
        // estimate" bug this is meant to narrow.
        if (!update.isFinished) {
          const liveDuration = estimateLiveDurationMinutes(match.sport, match.startTimeUtc, match.durationMinutes, update);
          if (liveDuration !== match.durationMinutes) {
            match.durationMinutes = liveDuration;
            changed = true;
          }
        }
      });
    })
  ).catch(() => {}); // best-effort - a failed poll just tries again next tick

  // The win% odds refresh - Polymarket, not ESPN (see ./lib/polymarket.mjs
  // for why), and covering every sport this app tracks including F1 -
  // ESPN's own scoreboard fetch above never carried F1 at all. One request
  // per sport (same "one batch request, not one per fixture" shape as the
  // ESPN pass above), then the SAME event-matching/parsing this app's own
  // build already used for that sport's initial number.
  await Promise.allSettled(
    [...sports]
      .filter(sport => POLYMARKET_TAG_ID[sport] != null)
      .map(async sport => {
        const target = polymarketEventsByTagUrl(POLYMARKET_TAG_ID[sport]);
        const response = await fetch(`${state.proxyUrl}/sports-proxy?url=${encodeURIComponent(target)}`, {
          cache: 'no-store'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const events = await response.json();
        state.allRawMatches.forEach(match => {
          if (match.sport !== sport || match.isFinished) return;
          if (sport === 'F1') {
            // Only the Race session shows odds - see match-builder.mjs's own
            // enrichWithPolymarketOdds comment for why `-race` is this
            // session's own stable id suffix.
            if (!match.id.endsWith('-race')) return;
            const favorites = resolveF1WinnerOdds(events, match.startTimeUtc.slice(0, 10));
            if (!favorites) return;
            const top3 = favorites.slice(0, 3);
            // A plain array-of-objects compare - cheap for a 3-entry list,
            // and avoids forcing a render every quiet poll tick where the
            // market hasn't actually moved.
            if (JSON.stringify(top3) !== JSON.stringify(match.oddsFavorites)) {
              match.oddsFavorites = top3;
              changed = true;
            }
            return;
          }
          if (!Array.isArray(match.competitors) || match.competitors.length !== 2) return;
          const [away, home] = match.competitors;
          const result = resolveTeamOdds(events, {
            awayName: away.name,
            homeName: home.name,
            startTimeUtc: match.startTimeUtc,
            hasDraw: sport === 'Premier League'
          });
          if (!result) return;
          if (match.oddsWinPctAway !== result.away) {
            match.oddsWinPctAway = result.away;
            changed = true;
          }
          if (match.oddsWinPctHome !== result.home) {
            match.oddsWinPctHome = result.home;
            changed = true;
          }
          if (match.oddsWinPctDraw !== result.draw) {
            match.oddsWinPctDraw = result.draw;
            changed = true;
          }
        });
      })
  ).catch(() => {});

  // Re-derives effectiveScore/the day's plan from the freshly-updated raw
  // matches (liveExcitementBonus reads match.competitors[].score directly,
  // see recommendation.mjs) - skipped entirely when nothing actually
  // changed, so a quiet tick (scores unchanged since last poll) doesn't
  // still force a render.
  if (changed) recomputeAndRender();
}

function scheduleLivePoll() {
  if (livePollTimer) clearTimeout(livePollTimer);
  livePollTimer = setTimeout(async () => {
    // A backgrounded tab still gets rescheduled (so it picks back up the
    // moment it's visible again) but skips the actual network request -
    // no point spending battery/quota polling scores/odds nobody's looking
    // at.
    if (document.visibilityState !== 'hidden' && anyMatchWorthPollingNow()) {
      await pollLiveMatches();
    }
    scheduleLivePoll();
  }, LIVE_POLL_INTERVAL_MS);
}

async function init() {
  state.proxyUrl = PROXY_URL;
  // Near-term first, for a fast initial paint (a handful of requests -
  // today/tomorrow's own fixtures) - the full window follows right behind
  // it, unblocked, so the day-scroller's far-future pills fill in shortly
  // after rather than the viewer waiting on all ~50+ requests before
  // seeing anything at all.
  try {
    await refreshNearTerm();
  } catch (error) {
    console.error(error);
  }
  if (!state.allRawMatches.length && !state.tbdMatches.length) {
    // Nothing loaded at all yet (the near-term fetch itself failed
    // outright, e.g. the proxy is unreachable) - say so rather than
    // leaving a silently empty page; refreshFullWindow below and the
    // scheduled retries can still recover this once network/the proxy
    // comes back.
    errorState.hidden = false;
  }
  scheduleNearTermRefresh();
  scheduleLivePoll();
  refreshFullWindow({ silent: true });
  scheduleFullRefresh();
}

init();
