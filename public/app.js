// ---- public/app.js ----
// Reads ./data/matches.json (written at build time by scripts/build-data.mjs,
// which only ever fetches fixtures and asks Gemini to score them - see that
// script's own top comment) and does everything that has to happen per
// viewer instead of once at build time:
//
//   - Converting every UTC kickoff to THIS viewer's own local time.
//   - Deciding which matches form "today's recommended lineup" - this has
//     to run here, not in the build script, because "don't recommend a
//     match starting at 3am" and "which match is closest to right now" are
//     both relative to the viewer's own clock, and one static build serves
//     every viewer in every timezone at once.
//
// The AI scoring itself (competitiveness/watchability/reason/venueZh)
// already happened automatically in the background, on a schedule, well
// before this page ever loaded - see build-data.mjs. `whereToWatchTw` is
// NOT one of those AI answers anymore - it's a hardcoded rule
// (`resolveWhereToWatchTw`, also in build-data.mjs): 愛爾達體育台 for
// everything except an MLB fixture ESPN itself reports as Apple TV.
// Nothing here ever calls Gemini, and nothing here ever calls any other
// network endpoint either - the ONLY network request this page makes is
// one `fetch('./data/matches.json')` (see "One update path" below).
// Everything else - sport priority, enabled sports, and which swiped match
// a viewer prefers - is local-only, in this browser's own localStorage,
// with no server-side sync of any kind (see README's "Local-only, no
// accounts").
//
// UI copy is Traditional Chinese throughout; team names, venues, and the
// AI's reasoning stay bilingual (see buildTeamRow/renderVenue) since an
// English team/venue name is often the more recognizable half for a fixture
// nobody has a settled Chinese name for yet.
//
// The pure scoring/viewing-plan math (overlap/slot/weighted-interval-
// scheduling helpers, computeDayPlan, resolveViewingPlan, confidence, the
// broadcast-service registry) lives in ./lib/recommendation.mjs instead of
// here - extracted so it can be unit-tested directly (see
// tests/recommendation.test.mjs) and reused by scripts/build-data.mjs (for
// confidence) without a DOM. The viewer's own local "Prefer" state (which
// swiped match to stick with per slot) is its own further pure module,
// ./lib/preferences.mjs - see that file's own top comment for why "match
// data -> recommendation -> user preference -> UI/card state" are kept as
// four separate layers instead of collapsing into one. This file keeps
// everything DOM/localStorage/render-related, and calls into both modules
// for the rest.
import {
  SERVICES,
  resolveService,
  computeDayPlan,
  resolveViewingPlan,
  slotKeyFromMembers,
  computeOverlapRange,
  computeWindowPlan,
  applyRecentRepeatPenalties,
  describeEvidence,
  isEvidenceFresh,
  naturalSlotChoice,
  matchLifecycleState,
  LIFECYCLE_STATES,
  estimatedDurationMinutes
} from './lib/recommendation.mjs';
import { serializePinnedChoices, deserializePinnedChoices, pruneStalePinnedChoices, applySlotSwipe } from './lib/preferences.mjs';

const state = {
  allRawMatches: [], // every fetched, non-TBD match regardless of enabled sports - see applyEnabledSportsAndRender
  rawMatches: [], // allRawMatches filtered to enabled sports, untouched otherwise - kept so a priority/service change can re-run resolveViewingPlan without re-fetching
  tbdMatches: [], // fixtures ESPN has on the schedule but hasn't set a kickoff time for yet - see applyMatchData
  matches: [], // every fetched (non-TBD), enabled-sport match, mutated in place with .recommended/.overlappingIds
  days: [], // [{key: 'YYYY-MM-DD', date: Date}, ...] - every calendar day the fetched window covers
  selectedDayKey: null,
  activeSport: 'all',
  priorityOrder: [], // sports ranked best-to-least - see "Sport priority settings" below
  enabledSports: [], // sports to show at all - see "Enabled sports settings" below
  myServiceIds: [], // subscribed services - see "Broadcast service registry" below
  // Map<dayKey, Map<slotKey, matchId>> - which member of a multi-match
  // "slot" (see isNearTotalOverlap) the viewer explicitly swiped to commit
  // to watching, per day - see computeDayPlan/pinSlotChoice, and
  // ./lib/preferences.mjs for the actual set-or-clear decision and
  // serialization shape. Local-only (see this file's own top comment) -
  // persisted to localStorage so a viewer who swiped past this morning's
  // default pick still sees that choice as 偏好, not reverted back to
  // 推薦, next time they open the page. Old days' entries get pruned (see
  // prunePinnedChoices) rather than kept forever, since a day that's aged
  // out of the fetched window can never be looked up again anyway.
  pinnedChoices: loadPinnedChoices(),
  // Map<matchupKey, dayKey> - the most recent day, across the WHOLE fetched
  // window regardless of the current sport filter, that matchup actually
  // won its day's plan. Recomputed by renderSections (see
  // computeWindowPlan) before every render, so a soft cross-day repeat
  // penalty (applyRecentRepeatPenalties) can see "did we already
  // recommend this exact matchup on an earlier day" no matter which day
  // or sport filter the viewer currently has open - see docs/
  // recommendation-engine-audit.md's "cross-day repetition" finding.
  recommendationHistory: new Map(),
  // Map<dayKey, matches[]> - the rolling window of recently-recommended
  // matches (see computeWindowPlan's own comment) each day's soft
  // sport-concentration penalty was actually weighed against, reused as-is
  // by renderRecommendedSection's own (possibly sport-filtered) call so it
  // doesn't have to re-derive the same rolling window a second way.
  recentPicksByDayKey: new Map(),
  // Map<sport, share 0..1> over the whole fetched window's own final
  // picks - docs/recommendation-engine-audit.md section 15's "the planner
  // should expose that concentration" (team/league concentration), not
  // itself used for any scheduling decision - purely a diagnostic
  // surfaced in exportRecommendationData's own payload.
  sportConcentration: new Map()
};

// Sport labels as ESPN/build-data.mjs spell them internally (see
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
// `whereToWatchTw` is now a fixed rule's output (see build-data.mjs's
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
// Deliberately just these three: every OTHER service Gemini might name in
// whereToWatchTw (see the shared proxy's buildMatchRecommendPrompt) still
// shows up as plain text on the card either way (see buildMatchCard's
// watch-text) - this registry only controls which ones additionally get a
// recognizable logo/color badge, scoped down to the services this site's
// own viewer actually cares about tracking.
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
// the score nudge above: since build-data.mjs's `resolveWhereToWatchTw`
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
const aiStatusText = document.getElementById('ai-status-text');
const aiRefetchLink = document.getElementById('ai-refetch-link');
const tbdSection = document.getElementById('tbd-section');
const tbdListEl = document.getElementById('tbd-list');
const cardTemplate = document.getElementById('match-card-template');
const teamRowTemplate = document.getElementById('team-row-template');

// The manual "fetch again" affordance from the footer (see "Gemini usage
// status" below) - only the repo owner can actually run this (GitHub asks
// for sign-in and repo write access), but that matches who's ever going to
// click it: this is a personal site, not a public tool, and there's no
// client-safe way for a static page to trigger a GitHub Actions run
// itself without embedding a credential in it.
aiRefetchLink.href = 'https://github.com/jaypengx-collab/Match-Find/actions/workflows/deploy.yml';

const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsBackdrop = document.getElementById('settings-backdrop');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const settingsResetBtn = document.getElementById('settings-reset-btn');
const settingsSportList = document.getElementById('settings-sport-list');
const settingsEnabledSports = document.getElementById('settings-enabled-sports');
const updateStatusText = document.getElementById('update-status-text');
const checkUpdateBtn = document.getElementById('check-update-btn');
const refreshDataBtn = document.getElementById('refresh-data-btn');
const exportDataBtn = document.getElementById('export-data-btn');

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
// now always uses the single blend that used to be the "entertainment"
// default (watchability, nudged by broadcastQuality - see
// BROADCAST_QUALITY_WEIGHT there) - the one that needs no familiarity with
// a sport's standings or current form to make sense of. The viewer's own
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
// state.pinnedChoices (Map<dayKey, Map<slotKey, matchId>>) - which member
// of a multi-match slot (see isNearTotalOverlap) the viewer explicitly
// swiped to commit to watching, per day. Local-only, like every other
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

// "已結束" plus the final score, when build-data.mjs actually got one back
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
  applyRecentRepeatPenalties(dayCandidates, dayKey, state.recommendationHistory, state.recentPicksByDayKey.get(dayKey) || []);
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

// English + Chinese together, same reasoning as team names (see README) -
// an obscure US ballpark's English name is often more recognizable than a
// guessed Chinese transliteration, so neither is dropped when both exist.
function renderVenue(el, match) {
  if (!match.venue) {
    el.textContent = '';
    return;
  }
  el.textContent = match.venueZh ? `${match.venue}（${match.venueZh}）` : match.venue;
}

// Grounds the one-sentence AI "reason" in the actual structured evidence
// (see recommendation.mjs's describeEvidence/isEvidenceFresh) it was
// scored from, per docs/recommendation-engine-audit.md's "explanations
// should be grounded in evidence" - rather than trying to auto-assemble
// Chinese prose from raw findings (a real risk of reading worse than
// Gemini's own directly-generated reason), this lets a viewer see the
// actual current facts behind that sentence and judge for themselves.
// Collapsed by default (a <details> element, no JS needed to toggle it) -
// this is a "how was this decided" drill-down, not something that belongs
// competing for attention with the card's own primary content. Inserted
// directly after `reasonEl` in the DOM rather than living in the card
// template itself, since most matches (no evidence at all) render nothing
// here.
function buildEvidenceDetails(match, reasonEl) {
  const items = describeEvidence(match);
  if (!items.length) return;

  const details = document.createElement('details');
  details.className = 'match-evidence';

  const summary = document.createElement('summary');
  summary.textContent = isEvidenceFresh(match) ? '評分依據' : '評分依據（較舊）';
  details.appendChild(summary);

  const list = document.createElement('ul');
  items.forEach(item => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'match-evidence-label';
    label.textContent = item.label;
    li.appendChild(label);
    li.appendChild(document.createTextNode(` ${item.finding}`));
    if (item.source) {
      const source = document.createElement('span');
      source.className = 'match-evidence-source';
      source.textContent = `（${item.source}）`;
      li.appendChild(source);
    }
    list.appendChild(li);
  });
  details.appendChild(list);

  reasonEl.insertAdjacentElement('afterend', details);
}

function buildMatchCard(match) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);
  const start = Date.parse(match.startTimeUtc);
  const end = start + match.durationMinutes * 60_000;

  if (match.timeTbd) {
    // startTimeUtc is only a placeholder for a TBD fixture (see
    // build-data.mjs's isTimeTbd) - showing it as a real clock time would
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
    // only ever durationMinutes' per-sport AVERAGE - see build-data.mjs's
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

  const reasonEl = node.querySelector('.match-reason');
  reasonEl.textContent = match.reason || '';
  // 'api-objective' means the deterministic, real-data score (see
  // build-data.mjs's computeMatchObjectiveScore) hasn't been validated by
  // Gemini yet - still real, current data, just missing that one extra
  // layer of judgment, hence a lighter caveat than the old 'heuristic'
  // source this replaced ever showed (see styles.css's own .is-api-objective
  // rule for the actual wording).
  if (match.source === 'api-objective') reasonEl.classList.add('is-api-objective');

  buildEvidenceDetails(match, reasonEl);

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
  const conflictNote = node.querySelector('.conflict-note');
  const earlierOverlaps = state.matches
    .filter(m => (match.overlappingIds || []).includes(m.id) && Date.parse(m.startTimeUtc) < Date.parse(match.startTimeUtc))
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

function renderDayScroller() {
  // Every fetched day up front, no "load more" click - the whole window is
  // already baked into matches.json at build time (see build-data.mjs's
  // own comment on DAYS_AHEAD), so there's no cost to showing all of it
  // right away; a click-to-reveal step here only ever hid days that were
  // already sitting in memory.
  const nodes = state.days.map(day => {
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

// How recently any match-stack scroller last fired a 'scroll' event -
// checked by the periodic 60s renderSections() tick in init() so it can
// skip a run rather than blow away a swipe the viewer is mid-gesture on.
// That tick exists purely to refresh each card's own relative-time label
// ("5 分鐘後" etc.) with data already in memory; renderRecommendedSection
// fully replaces recommendedListEl's children on every call, which
// destroys and rebuilds the scroller DOM node a viewer might currently be
// touch-scrolling. The rebuilt stack reopens at whatever member is
// CURRENTLY pinned (see buildMatchStack's own requestAnimationFrame,
// primaryIndex), not wherever the viewer's finger had it mid-swipe - from
// the viewer's side that read as the card randomly snapping backward to
// the previous choice. A brief cooldown after the last scroll tick is
// enough: the interval simply retries on its next 60s tick once the
// gesture has actually settled.
let lastStackInteractionAt = 0;
const STACK_INTERACTION_COOLDOWN_MS = 1_000;
function markStackInteraction() {
  lastStackInteractionAt = Date.now();
}
function isStackBeingInteractedWith() {
  return Date.now() - lastStackInteractionAt < STACK_INTERACTION_COOLDOWN_MS;
}

// A slot with more than one near-total-overlapping member (see
// groupIntoSlots) - a horizontally swipeable card stack, native CSS
// scroll-snap, same touch mechanism the day picker already uses. Unlike an
// earlier version of this stack, swiping here is a real commitment, not
// just a peek: settling on a different card PINS that match as this
// slot's fixed choice and rebuilds the whole day's plan around it (see
// pinSlotChoice/computeDayPlan) - matches before and after it reflow to
// connect with it instead of with whichever match was the plan's own
// default pick.
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

  const hint = document.createElement('p');
  hint.className = 'match-stack-hint';
  hint.textContent = '⟷ 這個時段只能擇一收看，滑動選擇要看哪一場';

  const scroller = document.createElement('div');
  scroller.className = 'match-stack-scroller';
  // A FIXED order (by score, highest first) - independent of which member
  // is currently pinned/primary. An earlier version put the current pick
  // first and sorted the rest around it, which reshuffled the whole stack
  // on every pin; since a pin re-renders (see the settle handler below),
  // that reset the scroller back to position 0 every time. On a 3+-member
  // stack, a plain "swipe forward" from that reset position could only
  // ever reach whichever card the reshuffle happened to place second -
  // reaching a third member required an unnaturally large single swipe,
  // which read as "you can only pick between two of them." Keeping the
  // order stable means normal sequential swiping reaches every member;
  // only the SCROLL POSITION needs to reflect the current pick (see the
  // requestAnimationFrame call below), not the member order itself.
  // viewerScore, not the older effectiveScore name - see
  // recommendation.mjs's computeRecommendationScore/resolveViewingPlan for
  // why both exist (same number, viewerScore is the audit's own explicit
  // name for "this viewer's own judgment of the match", the one this
  // stack's card order should actually reflect).
  const ordered = members.slice().sort((a, b) => b.viewerScore - a.viewerScore);
  const primaryIndex = ordered.findIndex(m => m.id === primary.id);
  ordered.forEach((match, index) => {
    const card = buildMatchCard(match);
    if (index === primaryIndex && isTopOfDay) card.classList.add('is-pinned');
    scroller.appendChild(card);
  });

  const dots = document.createElement('div');
  dots.className = 'match-stack-dots';
  const dotEls = ordered.map((_, index) => {
    const dot = document.createElement('span');
    dot.className = 'match-stack-dot' + (index === primaryIndex ? ' is-active' : '');
    dots.appendChild(dot);
    return dot;
  });
  // Runs after the browser has actually laid out the scroller (it isn't
  // attached to the live document yet at the point buildMatchStack itself
  // runs, so clientWidth would read 0 here) - opens the stack already
  // scrolled to whichever member the plan currently has chosen, rather
  // than always starting at the fixed order's own first (highest-scored)
  // card regardless of what's actually pinned.
  requestAnimationFrame(() => {
    scroller.scrollLeft = primaryIndex * scroller.clientWidth;
  });
  // Reads which card is actually centered right now, clamped to a real
  // index - scroll-snap's own momentum/rubber-banding can briefly push
  // scrollLeft a little negative or past the last card's offset (an
  // overscroll bounce at either end), which without clamping rounded to an
  // out-of-bounds index and, worse, drifted the settle handler's read of
  // "which card is this" away from where the browser had actually snapped.
  function currentIndex() {
    const width = Math.max(1, scroller.clientWidth);
    return Math.min(ordered.length - 1, Math.max(0, Math.round(scroller.scrollLeft / width)));
  }
  // The actual pin+rebuild only fires once the gesture SETTLES, not on
  // every intermediate tick mid-swipe (which would otherwise re-pin, and
  // re-render the whole page, dozens of times during one swipe). Native
  // 'scrollend' (Chrome/Firefox/Edge, Safari 18.2+) fires exactly once
  // scrolling - including snap settling and any momentum/rubber-band
  // bounce - has genuinely finished, so it's used when available instead of
  // guessing a fixed debounce: reading scrollLeft before the snap has fully
  // settled is what previously made a plain forward swipe occasionally
  // resolve to a card one or two positions away from the one it actually
  // stopped on.
  const supportsScrollEnd = 'onscrollend' in window;
  let settleTimer = null;
  function settle() {
    const activeIndex = currentIndex();
    const chosen = ordered[activeIndex];
    if (chosen && chosen.id !== primary.id) pinSlotChoice(dayKey, slotKey, chosen.id);
  }
  scroller.addEventListener(
    'scroll',
    () => {
      // Marks "a stack is actively mid-swipe right now" (see
      // markStackInteraction's own comment) on every tick, not just once at
      // gesture start - the periodic 60s re-render this guards against can
      // land at any point during a swipe that takes longer than one tick.
      markStackInteraction();
      const activeIndex = currentIndex();
      dotEls.forEach((dot, index) => dot.classList.toggle('is-active', index === activeIndex));
      if (!supportsScrollEnd) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(settle, 180);
      }
    },
    { passive: true }
  );
  if (supportsScrollEnd) scroller.addEventListener('scrollend', settle, { passive: true });

  wrapper.append(hint, scroller, dots);
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
  const fragment = document.createDocumentFragment();
  ordered.forEach((match, index) => {
    const alternatives = (match.alternativeIds || []).map(id => byId.get(id)).filter(Boolean);
    if (alternatives.length) {
      fragment.appendChild(buildMatchStack(dayKey, [match, ...alternatives], match, index === 0));
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
  state.recommendationHistory = windowPlan.lastRecommendedDayKey;
  state.recentPicksByDayKey = windowPlan.recentPicksByDayKey;
  state.sportConcentration = windowPlan.sportConcentration;
  renderRecommendedSection();
  renderAllMatchesSection();
}

// Fixtures ESPN has on the schedule but hasn't set a real kickoff time for
// yet (see build-data.mjs's isTimeTbd - almost always a playoff game whose
// bracket slot is set before its exact date/time is) - these never carry a
// trustworthy startTimeUtc, so they're kept entirely out of the day-picker/
// DP pipeline (see applyMatchData) and just listed here once, independent
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

// "Gemini last used" (see build-data.mjs's AI_FETCH_MIN_INTERVAL_HOURS) -
// purely informational, so a viewer curious why a brand new fixture still
// shows an "(API 數據估計，尚未經 AI 驗證)" caveat can see this isn't stuck,
// just waiting for the next batched Gemini call. The "重新查詢" link next
// to it (see its href, set once above) only opens the GitHub Actions run
// page - actually triggering a rebuild needs repo write access, which only
// this site's own owner has, so that's as far as a static page can safely
// take it.
function renderAiStatus(lastAiFetchAt) {
  if (!lastAiFetchAt) {
    aiStatusText.textContent = 'AI 尚未查詢過，將於下次建置時查詢。';
    return;
  }
  const fetched = new Date(lastAiFetchAt);
  aiStatusText.textContent = `AI 最後查詢於 ${localDayFormatter().format(fetched)} ${localTimeFormatter().format(fetched)}。`;
}

// Applies a freshly-fetched matches.json payload to the page. Used both by
// the initial load and by checkForUpdate() below, so "how a payload turns
// into what's on screen" only exists in one place.
function applyMatchData(data) {
  const allMatches = Array.isArray(data.matches) ? data.matches : [];
  // TBD fixtures (see build-data.mjs's isTimeTbd) never carry a real
  // startTimeUtc, so they're split off here, before anything else touches
  // the list - buildDayList/resolveViewingPlan both assume every match has
  // a trustworthy clock time, and a placeholder would otherwise land them
  // on an arbitrary day or mess with the DP's overlap math.
  const rawMatches = allMatches.filter(m => !m.timeTbd);
  state.tbdMatches = allMatches.filter(m => m.timeTbd);

  if (data.generatedAt) {
    const generated = new Date(data.generatedAt);
    generatedNote.textContent = `資料最後更新於 ${localDayFormatter().format(generated)} ${localTimeFormatter().format(generated)}（你的當地時間）`;
  }
  renderAiStatus(data.lastAiFetchAt);
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

  state.daysAhead = data.daysAhead;
  state.allRawMatches = rawMatches;
  applyEnabledSportsAndRender();
}

// Filters state.allRawMatches down to the sports currently enabled in
// Settings (see "Enabled sports settings" below), then redoes everything
// downstream of that - the viewing plan, the day list (a day can gain or
// lose entries entirely depending which sports are on), and every render
// call. Shared by the initial load/poll (applyMatchData) and by toggling a
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

// Checks whether the deployed site has moved on since this tab loaded it,
// and reacts in one of two ways depending on WHAT changed:
//   - New data, same code (a routine scheduled rebuild - buildId, the git
//     commit the build ran from, is unchanged): refresh silently. This is
//     exactly as safe as the initial load, just triggered later.
//   - New code (buildId changed - a real commit was deployed, not just a
//     rebuild of the same one): this tab is still running the OLD
//     JS/CSS/HTML no matter how fresh the data underneath it is, so
//     applying new data can't actually pick up whatever changed in the
//     code. Force a real reload rather than applying the new data and
//     leaving the stale code running, or merely flagging it for someone
//     to notice and click - a fix that's live on the server but still
//     invisible to whoever's looking at the page isn't actually shipped
//     yet from their point of view. A plain location.reload() alone isn't
//     enough here: GitHub Pages serves app.js/styles.css themselves with
//     Cache-Control: max-age=600 (not configurable - no equivalent of a
//     custom _headers file), so the browser can still hand back a cached
//     copy of THOSE specific files without even asking the server, for up
//     to 10 minutes, regardless of how the reload was triggered. A
//     different query string on the page URL itself forces a genuinely
//     fresh index.html fetch, which - now that deploy.yml stamps that
//     file's own script/stylesheet tags with this build's commit sha at
//     deploy time - pulls in fresh JS/CSS too, since the browser has never
//     cached a URL with this exact query string before.
// ---- One update path: on load, and exactly when a relevant match starts
// or ends ---------------------------------------------------------------
//
// No polling, no fixed-interval timers, no hidden background refreshes -
// this is the ONLY place this page ever re-fetches matches.json on its
// own, and it only ever does so at three moments: once on load (init()),
// once at the moment a currently-loaded match's own start time arrives,
// and once at its estimated broadcast end (see nextRelevantTransitionMs
// below) - never a blind "check again in N minutes" regardless of whether
// anything relevant is actually about to change. Both of the manual
// Settings buttons (檢查更新/重新整理資料) call this same function too, so
// "how a refresh happens" only exists in one place either way.
let nextUpdateTimer = null;

// How long to wait before retrying after a genuine fetch failure (offline,
// a transient server error) - deliberately separate from the lifecycle-
// transition scheduling below: a network hiccup needs its own short
// recovery, not a wait for whatever match happens to start or end next
// (which could be hours away, or never, in an empty window).
const RETRY_AFTER_ERROR_MS = 60_000;
// A transition instant that's already effectively "now" (e.g. loading the
// page mid-match) still gets a short real delay rather than firing
// immediately/recursively; capped at 24h so an empty or far-future window
// never leaves this page with no scheduled check at all.
const MIN_NEXT_UPDATE_DELAY_MS = 5_000;
const MAX_NEXT_UPDATE_DELAY_MS = 24 * 60 * 60_000;

// The soonest future instant, across every currently-loaded (non-finished,
// non-TBD) match regardless of the viewer's own sport filter or selected
// day, that its lifecycle meaningfully changes - it starts, or its
// estimated broadcast ends (see matchLifecycleState/estimatedDurationMinutes
// in ./lib/recommendation.mjs - an ESTIMATE, not a guarantee, so this can
// occasionally fire a little before or after a no-clock sport's real end;
// that's fine, ESPN's own status is what buildMatchCard/relativeLabel
// actually trust, this timer only decides WHEN to go ask it again). A
// sport the viewer has filtered out, or a day they aren't currently
// looking at, still deserves a wake-up - switching back to it later should
// already reflect reality, not whatever was true when they last looked.
function nextRelevantTransitionMs(now = Date.now()) {
  let soonest = Infinity;
  for (const match of state.allRawMatches) {
    if (match.isFinished || match.timeTbd) continue;
    const start = Date.parse(match.startTimeUtc);
    if (start > now && start < soonest) soonest = start;
    const estimatedEnd = start + estimatedDurationMinutes(match) * 60_000;
    if (estimatedEnd > now && estimatedEnd < soonest) soonest = estimatedEnd;
  }
  return Number.isFinite(soonest) ? soonest : null;
}

// Schedules exactly the next checkForUpdate call - clears any previously
// scheduled one first, so there is only ever one live timer no matter how
// many times this runs (called fresh after every load/checkForUpdate, see
// below). A viewer mid-swipe on a card stack gets a short retry instead of
// having the whole recommended list torn down and rebuilt under their
// finger (see isStackBeingInteractedWith's own comment).
function scheduleNextUpdate() {
  if (nextUpdateTimer) clearTimeout(nextUpdateTimer);
  const now = Date.now();
  const target = nextRelevantTransitionMs(now) ?? now + MAX_NEXT_UPDATE_DELAY_MS;
  const delay = Math.min(MAX_NEXT_UPDATE_DELAY_MS, Math.max(MIN_NEXT_UPDATE_DELAY_MS, target - now));
  nextUpdateTimer = setTimeout(() => {
    if (isStackBeingInteractedWith()) {
      nextUpdateTimer = setTimeout(() => checkForUpdate({ silent: true }), STACK_INTERACTION_COOLDOWN_MS);
      return;
    }
    checkForUpdate({ silent: true });
  }, delay);
}

// `silent` is what makes this the same function for the three real
// triggers (initial load, and the two scheduled lifecycle transitions
// above) and the two manual Settings buttons: the scheduled/background
// path doesn't want status text fighting with whatever else the viewer
// might be looking at, while a viewer who just tapped "檢查更新" or
// "重新整理資料" wants to actually see the answer.
async function checkForUpdate({ silent = false } = {}) {
  if (!silent) {
    updateStatusText.textContent = '檢查中…';
    checkUpdateBtn.disabled = true;
    refreshDataBtn.disabled = true;
  }
  try {
    const response = await fetch('./data/matches.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.generatedAt === state.generatedAt) {
      // The underlying data hasn't changed, but a scheduled call here
      // almost always means a match's OWN lifecycle just crossed a
      // boundary (it started, or its estimated end passed) purely by wall
      // clock, independent of whether the build has re-fetched anything -
      // re-render so the is-live styling/relative label/pinned-to-top
      // ordering (all derived from matchLifecycleState, which reads the
      // current time) actually reflects that now, not just on the next
      // unrelated event.
      renderSections();
      if (!silent) updateStatusText.textContent = '已是最新版本。';
      scheduleNextUpdate();
      return;
    }

    if (state.buildId && data.buildId && data.buildId !== state.buildId) {
      if (!silent) updateStatusText.textContent = '發現新版本，正在套用…';
      location.replace(`${location.pathname}?v=${encodeURIComponent(data.buildId)}`);
      return; // navigating away - nothing left here to schedule
    }

    state.generatedAt = data.generatedAt;
    applyMatchData(data);
    scheduleNextUpdate();
    if (!silent) updateStatusText.textContent = '資料已更新。';
  } catch (error) {
    console.error('update check failed', error);
    if (!silent) updateStatusText.textContent = '檢查失敗，請稍後再試。';
    if (nextUpdateTimer) clearTimeout(nextUpdateTimer);
    nextUpdateTimer = setTimeout(() => checkForUpdate({ silent: true }), RETRY_AFTER_ERROR_MS);
  } finally {
    if (!silent) {
      checkUpdateBtn.disabled = false;
      refreshDataBtn.disabled = false;
    }
  }
}
checkUpdateBtn.addEventListener('click', () => checkForUpdate());
// Same underlying check either way (this is a static site - there's no
// separate "just the ESPN data" endpoint to hit) - a distinct second button
// purely because the two read as different requests to a viewer ("is the
// app itself updated" vs "get me whatever's fresh right now"), matching how
// build-data.mjs itself separates a quota-free ESPN refresh from the
// quota-throttled Gemini one (see that script's own AI_FETCH_MIN_INTERVAL_HOURS).
refreshDataBtn.addEventListener('click', () => checkForUpdate());

// A developer tool, not a viewer-facing feature (see its own Settings
// section) - downloads the CURRENT recommendation plan as JSON, entirely
// client-side. state.matches (post-resolveViewingPlan), not
// state.rawMatches, is deliberately what's exported: the whole point is to
// inspect the actual .recommended/.score decision this build made, not
// just the raw fetched fixtures behind it.
//
// .recommended/.alternativeIds are now computed on demand per day (see
// computeDayPlan's own comment) rather than for the whole window at once,
// so only the currently-viewed day's matches would otherwise carry an
// accurate flag here. Runs computeDayPlan once per fetched day first
// (unfiltered by the viewer's own current sport filter - a dev inspecting
// this wants the full picture, not whatever one filter happens to be
// showing on screen), respecting whatever's already pinned, so every
// day's matches carry a real decision by the time this serializes them.
function exportRecommendationData() {
  // computeWindowPlan (not a bare per-day computeDayPlan loop) so the
  // exported .recommended/.planningScore/.recentRepeatPenalty reflect the
  // SAME cross-day repeat-penalty-aware decision renderRecommendedSection
  // itself makes, chronologically ordered - see that function's own comment.
  const windowPlan = computeWindowPlan(new Map(state.days.map(day => [day.key, matchesForDay(day.key)])), state.pinnedChoices);
  const payload = {
    exportedAt: new Date().toISOString(),
    dataGeneratedAt: state.generatedAt || null,
    priorityOrder: state.priorityOrder,
    enabledSports: [...state.enabledSports],
    // docs/recommendation-engine-audit.md section 15's "the planner should
    // expose that concentration" (team/league concentration) - a plain
    // object since Map doesn't survive JSON.stringify on its own.
    sportConcentration: Object.fromEntries(windowPlan.sportConcentration),
    matches: state.matches
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `match-find-export-${localDateKey(new Date())}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
exportDataBtn.addEventListener('click', exportRecommendationData);

async function init() {
  try {
    const response = await fetch('./data/matches.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.generatedAt = data.generatedAt;
    state.buildId = data.buildId;

    applyMatchData(data);
    scheduleNextUpdate();
  } catch (error) {
    console.error(error);
    errorState.hidden = false;
  }
}

init();
