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
// The AI scoring itself (competitiveness/watchability/reason/venueZh/
// whereToWatchTw) already happened automatically in the background, on a
// schedule, well before this page ever loaded - see build-data.mjs.
// Nothing here ever calls Gemini; the one thing this file DOES call over
// the network besides matches.json itself is the settings-sync proxy (see
// "Cross-device settings sync" below) - a viewer's own sport-priority/
// enabled-sports/subscribed-services choices, never fixture data, and
// never Gemini.
//
// UI copy is Traditional Chinese throughout; team names, venues, and the
// AI's reasoning stay bilingual (see buildTeamRow/renderVenue) since an
// English team/venue name is often the more recognizable half for a fixture
// nobody has a settled Chinese name for yet.

const state = {
  allRawMatches: [], // every fetched, non-TBD match regardless of enabled sports - see applyEnabledSportsAndRender
  rawMatches: [], // allRawMatches filtered to enabled sports, untouched otherwise - kept so a priority/service change can re-run resolveViewingPlan without re-fetching
  tbdMatches: [], // fixtures ESPN has on the schedule but hasn't set a kickoff time for yet - see applyMatchData
  matches: [], // every fetched (non-TBD), enabled-sport match, mutated in place with .recommended/.stackAlternativeIds/.overlappingIds
  days: [], // [{key: 'YYYY-MM-DD', date: Date}, ...] - every calendar day the fetched window covers
  selectedDayKey: null,
  activeSport: 'all',
  recommendStyle: 'entertainment', // which per-match score drives "推薦賽事" - see "Recommendation style setting" below (overwritten by loadRecommendStyle() right after this object)
  priorityOrder: [], // sports ranked best-to-least - see "Sport priority settings" below
  enabledSports: [], // sports to show at all - see "Enabled sports settings" below
  myServiceIds: [], // subscribed services - see "Broadcast service registry" below
  proxyUrl: '', // from matches.json - where sync calls go (see "Cross-device settings sync")
  syncPasscode: '' // '' when not paired to a sync code - see "Cross-device settings sync"
};

// Sport labels as ESPN/build-data.mjs spell them internally (see
// TEAM_LEAGUES in that script) stay the stable data key and CSS hook
// (data-sport="Premier League" etc.) - only the on-screen label goes
// through this map, so the underlying data model never has to change
// just because the display language does. MLB/NBA/MLS/F1 stay as their
// English initialisms - that's how Taiwanese sports media normally
// writes them too, even in otherwise-Chinese text; only the Premier
// League has a standard, universally-used Chinese short name.
const SPORT_LABELS_ZH = {
  'Premier League': '英超',
  MLS: 'MLS',
  MLB: 'MLB',
  NBA: 'NBA',
  F1: 'F1'
};

// ---- Broadcast service registry -------------------------------------------
//
// `whereToWatchTw` (see the shared proxy's /match-recommend) is free-form text written
// by Gemini, not a fixed enum - this registry is what turns that text back
// into something the UI can badge/color/reason about consistently, and
// what OWNED (see DEFAULT_MY_SERVICE_IDS below) means at all. Adding a new service
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
// recognizable logo/color badge and can be picked as "a service I own" in
// Settings, scoped down to the services this site's own viewer actually
// cares about tracking.
const SERVICES = [
  // The Commons file this used to point at (ELTA_logo.svg) turned out, on
  // closer look, to be the logo of ELTA - a Lithuanian news agency that
  // just happens to share the initialism - not Taiwan's 愛爾達體育台 at
  // all, and no genuine Commons file for the Taiwan channel's own mark
  // existed to replace it with. This logo instead comes from 愛爾達電視's
  // own official Android app icon on the Google Play Store - a real,
  // confirmed-correct source, just not one with Commons' own "always
  // resolves to the file's current version" redirect guarantee (a Play
  // Store CDN link is a fixed image blob - it won't silently start
  // pointing at a different app's icon later the way a wiki-editable
  // Commons page theoretically could, but Google could still stop serving
  // it if the app listing itself ever changed substantially). logoBg
  // matches the icon's own baked-in background (it's a solid square, not
  // transparent artwork) purely so there's no visible flash of a
  // different color while the image itself is still loading.
  {
    id: 'elta',
    pattern: /愛爾達|ELTA/i,
    label: '愛爾達體育台',
    badge: '達',
    color: '#ff7a3d',
    logo: 'https://play-lh.googleusercontent.com/vE0VONaUjXyEgpUv0efGHg2_GS_Kbmx3YKyWPWzmv8oX-BlTzDReK17V9GhuJ7e7MMmFWvrVyP08vn03Q_H3',
    logoBg: '#ff7a3d'
  },
  {
    id: 'appletv',
    pattern: /Apple\s*TV/i,
    label: 'Apple TV',
    badge: 'TV',
    color: '#1d1d1f',
    logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/AppleTVLogo.svg',
    logoBg: '#1d1d1f'
  },
  {
    id: 'netflix',
    pattern: /Netflix/i,
    label: 'Netflix',
    badge: 'N',
    color: '#e50914',
    logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/Netflix_icon.svg',
    logoBg: '#ffffff'
  }
];
// Which of the above a viewer actually subscribes to - editable in
// Settings (see "Enabled sports / subscribed services settings" below),
// used only as a tie-breaking nudge in resolveViewingPlan (a match on a
// service you don't have is still shown and can still be recommended, see
// OWNED_SERVICE_SCORE_BONUS below) and as a small "已訂閱" mark in the UI.
// This default is this site's own owner's real subscriptions, used until a
// viewer (this owner on a fresh device, or anyone else) picks their own.
const DEFAULT_MY_SERVICE_IDS = ['elta', 'appletv', 'netflix'];

function resolveService(whereToWatchTw) {
  if (!whereToWatchTw) return null;
  return SERVICES.find(s => s.pattern.test(whereToWatchTw)) || null;
}

const clockEl = document.getElementById('local-clock');
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
const settingsRecommendStyle = document.getElementById('settings-recommend-style');
const settingsSportList = document.getElementById('settings-sport-list');
const settingsEnabledSports = document.getElementById('settings-enabled-sports');
const settingsMyServices = document.getElementById('settings-my-services');
const syncStatusText = document.getElementById('sync-status-text');
const syncConnectedView = document.getElementById('sync-connected-view');
const syncDisconnectedView = document.getElementById('sync-disconnected-view');
const syncCodeText = document.getElementById('sync-code-text');
const syncCopyBtn = document.getElementById('sync-copy-btn');
const syncDisconnectBtn = document.getElementById('sync-disconnect-btn');
const syncCreateBtn = document.getElementById('sync-create-btn');
const syncCodeInput = document.getElementById('sync-code-input');
const syncConnectBtn = document.getElementById('sync-connect-btn');
const syncErrorText = document.getElementById('sync-error-text');
const syncPromptBanner = document.getElementById('sync-prompt-banner');
const syncPromptOpenBtn = document.getElementById('sync-prompt-open-btn');
const syncPromptDismissBtn = document.getElementById('sync-prompt-dismiss-btn');

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
// nudge (see PRIORITY_SCORE_DELTA below), never a hard include/exclude.
// An explicit rank (1st, 2nd, 3rd, ...), rather than a per-sport "less/
// normal/more" dial, is the more direct way to ask the actual question:
// "if these two are roughly equally good, which do you want?" - a dial
// still leaves every sport at the same level ambiguous relative to each
// other, where a full order never is.
// ---- Recommendation style setting ------------------------------------------
//
// "Worth watching" isn't one fixed question - different viewers weigh it
// differently, and none of them is more "correct" than the others. Two
// selectable styles, not three - broadcast/viewing-experience quality
// (see BROADCAST_QUALITY_WEIGHT below) turned out to work better as a
// metric folded into BOTH styles than as a third thing to choose between:
// nobody actually wants to rank purely by production value on its own, it
// should just quietly tip a close call the way priority/service nudges
// already do elsewhere in this file.
// - entertainment (the DEFAULT): watchability - already exactly "what a
//   general sports fan/mainstream media would find notable regardless of
//   how close it ends up being" per that field's own definition in the
//   shared proxy's buildMatchRecommendPrompt. Defaulted to rather than
//   competitive because it needs no familiarity with a sport's standings
//   or current form to make sense of - "is this a big deal" reads fine to
//   someone new to the sport, "is this a tight game" much less so.
// - competitive: build-data.mjs's own composite of competitiveness (how
//   close the game is) and watchability (stakes/rivalry/star power),
//   averaged - the original behavior, still available for anyone who
//   wants closeness itself weighted in.
//
// Synced like priorityOrder/enabledSports/myServiceIds (see "Cross-device
// settings sync" below) since it's the same kind of "my own preference,
// same on every device" setting.
const RECOMMEND_STYLES = [
  { id: 'entertainment', label: '話題熱度', hint: '看重話題性、明星球員、對戰歷史——大眾媒體會關注的那種賽事（預設方式，不需要先熟悉這項運動）。' },
  { id: 'competitive', label: '精彩程度', hint: '看重賽事本身的緊張刺激程度，適合已經熟悉這項運動、想看勢均力敵對戰的球迷。' }
];
const DEFAULT_RECOMMEND_STYLE = RECOMMEND_STYLES[0].id;
const RECOMMEND_STYLE_STORAGE_KEY = 'matchfind-recommend-style';

function loadRecommendStyle() {
  try {
    const stored = localStorage.getItem(RECOMMEND_STYLE_STORAGE_KEY);
    return RECOMMEND_STYLES.some(s => s.id === stored) ? stored : DEFAULT_RECOMMEND_STYLE;
  } catch {
    return DEFAULT_RECOMMEND_STYLE;
  }
}
function saveRecommendStyle(style) {
  try {
    localStorage.setItem(RECOMMEND_STYLE_STORAGE_KEY, style);
  } catch {
    // Private browsing / blocked storage - see savePriorityOrder's own comment.
  }
}
state.recommendStyle = loadRecommendStyle();

// How much broadcastQuality (see build-data.mjs/the shared proxy's
// worker.js) tips the chosen style's own primary score, on the same 1-10
// scale both sides are already on. Kept a genuine, noticeably-felt nudge
// (worth swinging a real close call - a beautifully-produced blowout CAN
// beat a merely-decent, plainly-shot game) without ever letting it dominate
// - competitiveness/watchability still make up 85% of the blend, matching
// "we still prioritize competitiveness and entertainment" over broadcast
// quality becoming a deciding factor on its own.
const BROADCAST_QUALITY_WEIGHT = 0.15;

// The chosen style's own primary score, nudged by broadcastQuality when
// it's actually available - falls back to the build-time composite
// `match.score` for 'competitive' (or any unrecognized style), and skips
// the broadcastQuality blend entirely rather than producing NaN when a
// match has no real basis for it (a heuristic-scored/finished match with
// no real AI judgment behind it at all).
function recommendStyleScore(match, style) {
  const primary =
    style === 'entertainment' && Number.isFinite(match.watchability) ? match.watchability : match.score;
  if (!Number.isFinite(match.broadcastQuality)) return primary;
  return primary * (1 - BROADCAST_QUALITY_WEIGHT) + match.broadcastQuality * BROADCAST_QUALITY_WEIGHT;
}

const SETTINGS_STORAGE_KEY = 'matchfind-sport-priority-order';
// Every rank step adds/subtracts one of these - small next to the 1-10
// score scale (being ranked a couple of spots higher does NOT let a
// mediocre match beat a genuinely great one), but large enough to reliably
// swing a close call between two roughly-comparable fixtures, which is the
// only case this is meant to affect.
const PRIORITY_SCORE_DELTA = 1;
// A small nudge (see resolveViewingPlan) toward a fixture shown on a
// service in state.myServiceIds - "optimize for the services you actually
// pay for" without turning this into a hard filter: a great game on a
// service you don't have still shows up and can still be recommended
// (you might catch a replay, a friend's account, whatever), this just
// tips a genuinely close call toward the one you can actually watch live
// right now.
const OWNED_SERVICE_SCORE_BONUS = 0.5;

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
// Two more per-viewer settings, same localStorage-first, sync-if-paired
// pattern as sport priority above. Unlike priority (a tie-breaking nudge),
// a disabled sport is a hard exclude - it never appears anywhere on the
// page, not even in "所有賽事", since "enable/disable" is a plainer,
// stronger statement than "prefer less".
const ENABLED_SPORTS_STORAGE_KEY = 'matchfind-enabled-sports';
const MY_SERVICES_STORAGE_KEY = 'matchfind-my-services';

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
function loadMyServiceIds() {
  try {
    const stored = JSON.parse(localStorage.getItem(MY_SERVICES_STORAGE_KEY));
    if (!Array.isArray(stored)) return new Set(DEFAULT_MY_SERVICE_IDS);
    return new Set(stored.filter(id => SERVICES.some(s => s.id === id)));
  } catch {
    return new Set(DEFAULT_MY_SERVICE_IDS);
  }
}
function saveMyServiceIds(myServiceIds) {
  try {
    localStorage.setItem(MY_SERVICES_STORAGE_KEY, JSON.stringify([...myServiceIds]));
  } catch {
    // Private browsing / blocked storage - see savePriorityOrder's own comment.
  }
}
state.enabledSports = loadEnabledSports();
state.myServiceIds = loadMyServiceIds();

// ---- Cross-device settings sync --------------------------------------------
//
// Syncs exactly three things - priorityOrder, enabledSports, myServiceIds -
// across a viewer's own devices via a single passcode, through the shared
// Cloudflare Worker (see the jaypengx-collab/shared-proxy repo's
// /match-find-sync route, the same singleCredential design as its own
// /vocab-sync: one passcode is
// both the identifier and the only credential, no separate manager role,
// because this is always "one person's own settings on their own devices",
// never "one person's data read by many"). Never syncs fixture data or
// scores - those already come from the one shared matches.json build, not
// per-viewer state, and have nothing to do with this.
//
// state.proxyUrl comes from matches.json (see applyMatchData) - the same
// Worker base URL the build script already uses for /match-recommend,
// baked in at build time since a plain fetch target carries no credential
// worth hiding. Sync is simply unavailable (buttons show a plain status
// message, nothing throws) when it's empty - same graceful-absence
// posture as PROXY_URL being unset for AI scoring at build time.
const SYNC_PASSCODE_STORAGE_KEY = 'matchfind-sync-passcode';
const SYNC_PROMPTED_STORAGE_KEY = 'matchfind-sync-prompted';

function loadSyncPasscode() {
  try {
    return localStorage.getItem(SYNC_PASSCODE_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}
function saveSyncPasscode(passcode) {
  try {
    if (passcode) localStorage.setItem(SYNC_PASSCODE_STORAGE_KEY, passcode);
    else localStorage.removeItem(SYNC_PASSCODE_STORAGE_KEY);
  } catch {
    // Private browsing / blocked storage - sync still works for this page
    // view, it just won't remember the passcode next time.
  }
}
state.syncPasscode = loadSyncPasscode();

function buildSyncPayloadObject() {
  return {
    recommendStyle: state.recommendStyle,
    priorityOrder: state.priorityOrder,
    enabledSports: [...state.enabledSports],
    myServiceIds: [...state.myServiceIds]
  };
}

// Applies a synced payload on top of local state - the same tolerant
// filtering as the individual loadX functions above (an unknown sport/
// service id, e.g. from an older or newer version of this site syncing
// with this one, is dropped rather than trusted blindly), then persists it
// locally so a later offline visit still has it.
function applySyncPayloadObject(payload) {
  if (RECOMMEND_STYLES.some(s => s.id === payload?.recommendStyle)) {
    state.recommendStyle = payload.recommendStyle;
  }
  if (Array.isArray(payload?.priorityOrder)) {
    const known = payload.priorityOrder.filter(sport => DEFAULT_SPORT_ORDER.includes(sport));
    const missing = DEFAULT_SPORT_ORDER.filter(sport => !known.includes(sport));
    state.priorityOrder = [...known, ...missing];
  }
  if (Array.isArray(payload?.enabledSports) && payload.enabledSports.length) {
    const known = payload.enabledSports.filter(sport => DEFAULT_SPORT_ORDER.includes(sport));
    if (known.length) state.enabledSports = new Set(known);
  }
  if (Array.isArray(payload?.myServiceIds)) {
    state.myServiceIds = new Set(payload.myServiceIds.filter(id => SERVICES.some(s => s.id === id)));
  }
  saveRecommendStyle(state.recommendStyle);
  savePriorityOrder(state.priorityOrder);
  saveEnabledSports(state.enabledSports);
  saveMyServiceIds(state.myServiceIds);
}

async function syncFetch(method, { passcode = state.syncPasscode, body } = {}) {
  if (!state.proxyUrl) throw new Error('同步功能尚未設定');
  const url = new URL(`${state.proxyUrl.replace(/\/+$/, '')}/match-find-sync`);
  if (method !== 'POST') url.searchParams.set('passcode', passcode);
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data;
}

// The raw payload string this device last actually applied (from a pull
// OR its own push - see persistSettingsAndSync/syncPush) - lets the
// periodic poll below (see SYNC_POLL_INTERVAL_MS) tell "something
// actually changed on another device" apart from "the usual no-op poll",
// so it only re-renders (and, if Settings happens to be open, redraws
// that panel) when there's a real change to show, not every single tick.
let lastAppliedSyncPayloadRaw = '';

// Pulls the synced payload and applies it if it's actually different from
// what this device already has (see lastAppliedSyncPayloadRaw). Called
// once unconditionally on load (see init()) when a passcode is already
// stored, deliberately BEFORE the viewer does anything else, so a setting
// changed on another device is what actually applies here, not whatever
// this device happened to have cached from before ("if the app is updated
// it should always fetch first" applies just as much to a viewer's own
// synced settings as it does to matches.json/buildId) - and again on
// SYNC_POLL_INTERVAL_MS's own interval and on tab focus after that (see
// init()), which is the actual fix for "changing settings on one device
// doesn't show up on another" for a tab that was already open: a single
// pull on load only ever caught a change made BEFORE this tab loaded,
// never one made while it was sitting open. Silent on failure (offline,
// proxy down) - this device's own local settings are still a perfectly
// good fallback, and the next poll tries again on its own.
async function syncPull({ renderIfOpen = false } = {}) {
  try {
    const data = await syncFetch('GET');
    if (!data.exists || typeof data.payload !== 'string' || !data.payload) return;
    if (data.payload === lastAppliedSyncPayloadRaw) return; // nothing new
    lastAppliedSyncPayloadRaw = data.payload;
    applySyncPayloadObject(JSON.parse(data.payload));
    applyEnabledSportsAndRender();
    // The initial on-load pull runs before Settings could possibly be
    // open, so this only actually matters for the periodic poll/focus
    // pull - redraws the open panel's chip states/priority list so a
    // change made on another device shows up there too, not just in the
    // match list behind it.
    if (renderIfOpen && !settingsPanel.hidden) renderSettingsPanel();
  } catch (error) {
    console.warn('sync pull failed', error);
  }
}

// Fire-and-forget push after a local settings change (see
// persistSettingsAndSync) - failure here just means this one change
// didn't make it to other devices yet; it'll go out again next time
// anything changes, and doesn't block or roll back the local change
// itself.
async function syncPush() {
  try {
    const payload = JSON.stringify(buildSyncPayloadObject());
    await syncFetch('PATCH', { body: { payload } });
    // This device's own change is now the server's own latest - recorded
    // so the next periodic pull (see syncPull) recognizes it as already
    // applied instead of redundantly re-applying/re-rendering it the
    // moment it polls back.
    lastAppliedSyncPayloadRaw = payload;
  } catch (error) {
    console.warn('sync push failed', error);
  }
}

async function syncCreate() {
  syncErrorText.hidden = true;
  syncCreateBtn.disabled = true;
  try {
    const payload = JSON.stringify(buildSyncPayloadObject());
    const data = await syncFetch('POST', { body: { payload } });
    state.syncPasscode = data.passcode;
    saveSyncPasscode(state.syncPasscode);
    lastAppliedSyncPayloadRaw = payload; // see syncPush's own comment
    renderSyncPanel();
  } catch (error) {
    syncErrorText.hidden = false;
    syncErrorText.textContent = `建立同步碼失敗：${error.message}`;
  } finally {
    syncCreateBtn.disabled = false;
  }
}

async function syncConnect(passcode) {
  syncErrorText.hidden = true;
  syncConnectBtn.disabled = true;
  try {
    const data = await syncFetch('GET', { passcode });
    if (!data.exists) {
      syncErrorText.hidden = false;
      syncErrorText.textContent = '找不到這組同步碼，請確認輸入是否正確。';
      return;
    }
    state.syncPasscode = passcode;
    saveSyncPasscode(passcode);
    if (typeof data.payload === 'string' && data.payload) {
      lastAppliedSyncPayloadRaw = data.payload; // see syncPush's own comment
      applySyncPayloadObject(JSON.parse(data.payload));
      applyEnabledSportsAndRender();
    }
    // Full re-render, not just renderSyncPanel() - a synced payload can
    // change priority order/enabled sports/my services, and the settings
    // panel is open (this only runs from the connect button) showing
    // whatever chip states it rendered with before the pull landed.
    renderSettingsPanel();
  } catch (error) {
    syncErrorText.hidden = false;
    syncErrorText.textContent = `連接失敗：${error.message}`;
  } finally {
    syncConnectBtn.disabled = false;
  }
}

// Only forgets the passcode on THIS device - deliberately never calls
// DELETE, since other devices may still be using the same code and
// disconnecting one device's own local copy shouldn't wipe shared data out
// from under them.
function syncDisconnect() {
  state.syncPasscode = '';
  saveSyncPasscode('');
  // A future reconnect - possibly to a DIFFERENT passcode - should never
  // skip applying its payload just because it happens to match whatever
  // string this device last saw under the old one.
  lastAppliedSyncPayloadRaw = '';
  renderSyncPanel();
}

function renderSyncPanel() {
  const connected = !!state.syncPasscode;
  syncConnectedView.hidden = !connected;
  syncDisconnectedView.hidden = connected;
  syncErrorText.hidden = true;
  if (connected) {
    syncCodeText.textContent = state.syncPasscode;
    syncStatusText.textContent = '這個裝置已同步，變更設定會自動套用到其他同步過的裝置。';
  } else if (!state.proxyUrl) {
    syncStatusText.textContent = '同步功能尚未設定。';
  } else {
    syncStatusText.textContent = '建立一組同步碼，在其他裝置輸入同一組碼即可套用相同設定。';
  }
}

syncCreateBtn.addEventListener('click', syncCreate);
syncConnectBtn.addEventListener('click', () => {
  const passcode = syncCodeInput.value.trim().toUpperCase();
  if (passcode) syncConnect(passcode);
});
syncDisconnectBtn.addEventListener('click', syncDisconnect);
syncCopyBtn.addEventListener('click', () => {
  navigator.clipboard?.writeText(state.syncPasscode).catch(() => {});
});

// A one-time, dismissible nudge on first visit (never shown again either
// way - see SYNC_PROMPTED_STORAGE_KEY) rather than asking on every load,
// which would just be nagging. Only shown when sync is actually available
// and this device isn't already paired.
function maybeShowSyncPrompt() {
  if (state.syncPasscode || !state.proxyUrl) return;
  let prompted = false;
  try {
    prompted = localStorage.getItem(SYNC_PROMPTED_STORAGE_KEY) === '1';
  } catch {
    // Can't remember a dismissal without storage - default to not nagging.
    prompted = true;
  }
  if (!prompted) syncPromptBanner.hidden = false;
}
function dismissSyncPrompt() {
  syncPromptBanner.hidden = true;
  try {
    localStorage.setItem(SYNC_PROMPTED_STORAGE_KEY, '1');
  } catch {
    // Not fatal - worst case this asks again next visit.
  }
}
syncPromptOpenBtn.addEventListener('click', () => {
  dismissSyncPrompt();
  openSettingsPanel();
});
syncPromptDismissBtn.addEventListener('click', dismissSyncPrompt);

function recomputeAndRender() {
  if (!state.rawMatches.length) return;
  state.matches = resolveViewingPlan(state.rawMatches, state.priorityOrder, state.myServiceIds, state.recommendStyle);
  renderSections();
}

function renderRecommendStylePanel() {
  settingsRecommendStyle.replaceChildren(
    ...RECOMMEND_STYLES.map(style => {
      const active = state.recommendStyle === style.id;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = active ? 'settings-chip is-active' : 'settings-chip';
      chip.textContent = style.label;
      chip.title = style.hint;
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(active));
      chip.addEventListener('click', () => {
        if (state.recommendStyle === style.id) return;
        state.recommendStyle = style.id;
        persistSettingsAndSync();
        renderRecommendStylePanel();
        recomputeAndRender();
      });
      return chip;
    })
  );
}

function renderSettingsPanel() {
  renderRecommendStylePanel();
  settingsSportList.replaceChildren(
    ...state.priorityOrder.map((sport, index) => {
      const row = document.createElement('div');
      row.className = 'settings-sport-row';
      const rank = document.createElement('span');
      rank.className = 'settings-sport-rank';
      rank.textContent = String(index + 1);
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
        persistSettingsAndSync();
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
      row.append(rank, label, moveGroup);
      return row;
    })
  );
  renderEnabledSportsPanel();
  renderMyServicesPanel();
  renderSyncPanel();
}

// Saves every setting to localStorage and, if currently paired to a sync
// code, pushes the combined payload to the shared proxy's /match-find-sync (see
// "Cross-device settings sync" below) - one call after any settings
// mutation, rather than each individual toggle/reorder handler needing to
// remember to do both.
function persistSettingsAndSync() {
  saveRecommendStyle(state.recommendStyle);
  savePriorityOrder(state.priorityOrder);
  saveEnabledSports(state.enabledSports);
  saveMyServiceIds(state.myServiceIds);
  if (state.syncPasscode) syncPush();
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
      chip.textContent = SPORT_LABELS_ZH[sport];
      chip.setAttribute('aria-pressed', String(enabled));
      chip.disabled = enabled && state.enabledSports.size === 1;
      chip.addEventListener('click', () => {
        if (enabled) {
          if (state.enabledSports.size === 1) return; // guarded by chip.disabled too
          state.enabledSports.delete(sport);
        } else {
          state.enabledSports.add(sport);
        }
        persistSettingsAndSync();
        renderEnabledSportsPanel();
        applyEnabledSportsAndRender();
      });
      return chip;
    })
  );
}

function renderMyServicesPanel() {
  settingsMyServices.replaceChildren(
    ...SERVICES.map(service => {
      const owned = state.myServiceIds.has(service.id);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = owned ? 'settings-chip is-active' : 'settings-chip';
      chip.textContent = service.label;
      chip.setAttribute('aria-pressed', String(owned));
      chip.addEventListener('click', () => {
        if (owned) state.myServiceIds.delete(service.id);
        else state.myServiceIds.add(service.id);
        persistSettingsAndSync();
        renderMyServicesPanel();
        recomputeAndRender();
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
  persistSettingsAndSync();
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

function updateClock() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  clockEl.textContent = `你的當地時間：${localTimeFormatter().format(now)}（${tz}）`;
}
updateClock();
setInterval(updateClock, 30_000);

function relativeLabel(startMs, endMs) {
  const now = Date.now();
  if (now >= startMs && now < endMs) return '直播中';
  const diffMin = Math.round((startMs - now) / 60_000);
  if (diffMin <= 0) return '即將開始';
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
// Same algorithm this site used to run at build time (see git history) -
// moved here because both of its real inputs, "what counts as an
// unreasonable hour" and "what's the closest match right now", are
// relative to THIS viewer's own local clock, which a single build running
// once for every visitor has no way to know. The AI-assigned
// competitiveness/watchability scores it works from, on the other hand,
// aren't viewer-relative at all (a match's quality doesn't change by
// timezone) - so those still only ever get computed once, at build time.
//
// - QUIET_HOUR_START/END: a match whose LOCAL start falls in this window is
//   never eligible to be "recommended", however good its score - nobody
//   asked to be told a 4am fixture is unmissable. It still shows up in the
//   full "all matches" list further down, just never pinned as a pick.
//
// The plan is built ONE LOCAL CALENDAR DAY AT A TIME (see the `byDay`
// bucketing below and pickDayRecommendations) rather than as one pass over
// the whole 14-day window: "what's worth watching today" is inherently a
// per-day question, and computing it that way means a bug in one day's
// data or scoring can never reach into a neighboring day.
//
// ---- Why this is a single clustering pass, not a scheduling DP ----------
//
// Earlier versions of this file ran a formal weighted-interval-scheduling
// DP over the whole day first (picking a maximum-total-score, mutually-
// non-overlapping chain of matches), then bolted a "diversity floor" pass
// onto it to rescue a sport the DP's own density bias had crowded out
// (MLB alone can field ~15 games an evening, so it could win almost every
// slot on volume even when a specific MLS game was never actually beaten
// head-to-head - it just never got a turn), then a THIRD pass to clean up
// the overlaps the diversity floor could reintroduce (a diversity pick
// added without checking the DP's own picks could still collide with one).
// Each pass existed to patch a hole the previous one opened, and each of
// those patches shipped its own real bug at least once: a transitively-
// chained "cluster" that silently swallowed unrelated sports across a
// whole evening, a start-time tolerance so tight it excluded genuinely
// simultaneous MLB games, a diversity pick that could still be absorbed
// and quietly dropped by a higher-scored anchor. Three interacting passes
// tuned by trial and error kept finding new ways to misbehave.
//
// The actual, single thing every one of those bugs was ultimately about is
// "does match A genuinely belong in the same viewing slot as match B" -
// and that question has one honest answer: how much of their broadcast
// windows ACTUALLY overlap, in real minutes, not whether their start times
// happen to be close, not whether they were both independently "recommended"
// by some earlier pass. MEANINGFUL_OVERLAP_MINUTES below is that one
// number. Everything in pickDayRecommendations is now a single pass:
// group the day's matches into clusters by REAL, SUBSTANTIAL time overlap
// (using the same anchor-claiming technique - process highest-score-first,
// each unclaimed match becomes its own anchor, only matches that overlap
// THAT SPECIFIC anchor by enough join its cluster, never each other
// transitively - the one piece of the old design that was never the
// source of a bug, so it survives unchanged), then within each cluster the
// anchor is the pick and any cluster-mate that's genuinely "equally good"
// or "a good game from a different sport" (isStackQualityWorthy) becomes a
// swipeable alternative. A sport with nothing genuinely overlapping
// anything else just becomes its own one-match cluster automatically -
// there's no separate diversity floor to fall through, because there's no
// DP-driven density bias left to correct in the first place: two matches
// only ever compete for the same slot when they're ACTUALLY on at the same
// time.
const QUIET_HOUR_START = 0;
const QUIET_HOUR_END = 5;
// How much of two fixtures' broadcast windows actually have to overlap, in
// real minutes, to be considered "the same viewing slot" at all - the one
// timing gate the whole file now has, replacing both the old DP's
// compatibility tolerance and the separate stack-timing gates that used to
// disagree with each other. Deliberately a large, unambiguous chunk of
// real simultaneous airtime (most of an hour), not a start-time-closeness
// proxy: two matches starting 5 minutes apart from a durationMinutes
// rounding quirk but airing back-to-back rather than together shouldn't
// cluster, and two matches starting 45 minutes apart but both still very
// much on for the next two hours absolutely should - "does the overlap
// itself justify treating these as one slot" is the only question that
// actually matches what a viewer means by "at the same time".
const MEANINGFUL_OVERLAP_MINUTES = 45;
// The bar a cluster-mate has to clear, on top of MEANINGFUL_OVERLAP_MINUTES,
// to join the cluster's anchor as a swipeable alternative rather than just
// losing its slot outright (see isStackQualityWorthy below) - deliberately
// a real "this is genuinely worth watching" score, not just "the best of a
// bad day" for that sport.
const DIVERSITY_MIN_SCORE = 6.5;
// The same-sport half of "equally good" (see isStackQualityWorthy) - a
// same-sport cluster-mate also has to score at least this well outright,
// not merely close to the anchor, so a stack never fills up with a
// mediocre leftover just because it happened to be the anchor's own kind
// of match.
const STACK_MIN_SCORE = 6;
// The second half of "equally good" (same-sport case only) - a same-sport
// cluster-mate also has to come within this many points of the anchor's
// own score, so a great pick's stack doesn't fill up with merely-decent
// leftovers just because STACK_MIN_SCORE alone let them through.
const STACK_MAX_SCORE_GAP = 1.5;
// Caps how many alternatives one stack can hold - a "swipe to see what
// else was on" gesture stops being quick past a handful of cards. MLB
// alone can field several genuinely good, genuinely simultaneous games at
// once, so this stays generous enough that a real slate of good options
// isn't cut down arbitrarily.
const STACK_MAX_ALTERNATIVES = 3;

// The quality gate for "worth stacking" - MEANINGFUL_OVERLAP_MINUTES
// already decided a candidate genuinely shares the anchor's own viewing
// slot; this decides whether it's actually worth offering as a swipe
// option there. Two, and only two, things justify it: the fixture is
// genuinely "equally good" (a close score AND the SAME sport as the anchor
// - two comparable options for the same kind of viewing), or it's "a good
// game from a different sport" (not required to be close to the anchor's
// own score, since the point there is a different kind of match entirely,
// not a closer call on the same one).
function isStackQualityWorthy(candidate, anchor) {
  if (candidate.sport === anchor.sport) {
    return candidate.score >= STACK_MIN_SCORE && candidate.score >= anchor.score - STACK_MAX_SCORE_GAP;
  }
  return candidate.score >= DIVERSITY_MIN_SCORE;
}

function isQuietHours(match) {
  const hour = new Date(match.startTimeUtc).getHours(); // local hour, deliberately not getUTCHours
  return QUIET_HOUR_START <= QUIET_HOUR_END
    ? hour >= QUIET_HOUR_START && hour < QUIET_HOUR_END
    : hour >= QUIET_HOUR_START || hour < QUIET_HOUR_END;
}

function matchInterval(match) {
  const start = Date.parse(match.startTimeUtc);
  return { start, end: start + match.durationMinutes * 60_000 };
}

function overlapMinutes(a, b) {
  const overlapStart = Math.max(a.interval.start, b.interval.start);
  const overlapEnd = Math.min(a.interval.end, b.interval.end);
  return overlapEnd > overlapStart ? (overlapEnd - overlapStart) / 60_000 : 0;
}

function meaningfullyOverlaps(a, b) {
  return overlapMinutes(a, b) >= MEANINGFUL_OVERLAP_MINUTES;
}

// Groups ONE local calendar day's worth of eligible (non-quiet-hour)
// matches into viewing slots and decides each slot's pick - called once
// per day from resolveViewingPlan below. Mutates each match in `dayMatches`
// in place (.recommended/.stackAlternativeIds), same as the rest of this
// file's convention. See the top-of-section comment for why this is one
// clustering pass rather than a scheduling DP plus separate diversity/
// merge passes.
//
// `priorityOrder`'s nudge and quiet-hour exclusion already happened before
// this runs (see resolveViewingPlan) - everything here only ever sees one
// day's already-eligible matches, so this never needs its own day-key or
// quiet-hour re-check.
function pickDayRecommendations(dayMatches) {
  dayMatches.forEach(match => { match.recommended = false; });

  // Anchor-claiming, highest-effectiveScore-first: an unclaimed match
  // becomes a cluster's anchor, and only matches that MEANINGFULLY overlap
  // that SPECIFIC anchor (never each other transitively - see top-of-
  // section comment on why chained/connected-component grouping silently
  // swallowed whole evenings in an earlier version of this file) join its
  // cluster and get claimed. A match that meaningfully overlaps two
  // different anchors joins whichever is processed first (the higher-
  // scored one) - it never bridges them into one cluster. A match with no
  // meaningful overlap with anything else simply becomes its own
  // single-member cluster, which is exactly how a sport with nothing else
  // airing at the same time ends up recommended without needing a separate
  // diversity mechanism at all.
  const claimed = new Set();
  const clusters = [];
  dayMatches
    .slice()
    .sort((a, b) => b.effectiveScore - a.effectiveScore)
    .forEach(anchor => {
      if (claimed.has(anchor.id)) return;
      claimed.add(anchor.id);
      const members = dayMatches.filter(m => !claimed.has(m.id) && meaningfullyOverlaps(anchor, m));
      members.forEach(m => claimed.add(m.id));
      clusters.push({ anchor, members });
    });

  // Each cluster's anchor is the pick for that slot; any cluster-mate that
  // clears isStackQualityWorthy becomes a swipeable alternative, capped at
  // STACK_MAX_ALTERNATIVES and ranked by score. A cluster-mate that doesn't
  // clear it just loses its slot entirely, same as before - it still shows
  // up in "所有賽事" with the usual "time overlaps what's recommended"
  // note (see buildMatchCard), it just isn't offered as a swipe option.
  clusters.forEach(({ anchor, members }) => {
    anchor.recommended = true;
    const worthy = members
      .filter(m => isStackQualityWorthy(m, anchor))
      .sort((a, b) => b.score - a.score)
      .slice(0, STACK_MAX_ALTERNATIVES);
    if (worthy.length) anchor.stackAlternativeIds = worthy.map(m => m.id);
  });
}

// `priorityOrder` (see "Sport priority settings" above) nudges
// effectiveScore away from the AI's own score - the displayed reason/.score
// always stay the true, un-nudged values; only the scheduling DP's notion
// of "which match wins this slot" sees the adjusted number, so a viewer's
// preference can tip a close call without pretending a mediocre match is
// actually great. A sport ranked 1st gets the biggest positive nudge, the
// sport ranked in the exact middle gets none, and the last-ranked sport
// gets the biggest negative one - symmetric around the middle rank so "no
// preference at all" (the default order) really does mean zero nudge for
// everyone, not just for whichever sport happens to be first in the array.
function resolveViewingPlan(matches, priorityOrder = [], myServiceIds = new Set(), recommendStyle = 'entertainment') {
  const centerRank = (priorityOrder.length - 1) / 2;
  const withIntervals = matches.map(match => {
    const rank = priorityOrder.indexOf(match.sport);
    const priorityNudge = rank === -1 ? 0 : (centerRank - rank) * PRIORITY_SCORE_DELTA;
    const service = resolveService(match.whereToWatchTw);
    const serviceNudge = service && myServiceIds.has(service.id) ? OWNED_SERVICE_SCORE_BONUS : 0;
    // Overrides the build-time composite with whichever field the chosen
    // style actually ranks by (see recommendStyleScore) - every downstream
    // consumer of `.score`/`.effectiveScore` (isStackQualityWorthy,
    // pickDayRecommendations' cluster-anchor ranking, etc.) then just works
    // off this one number without needing to know styles exist at all.
    const styleScore = recommendStyleScore(match, recommendStyle);
    return {
      ...match,
      score: styleScore,
      interval: matchInterval(match),
      effectiveScore: styleScore + priorityNudge + serviceNudge,
      recommended: false
    };
  });

  // Computed across every fetched match regardless of day or quiet hours -
  // used purely for display (the "time overlaps what's recommended" note on
  // a non-recommended card) and as the candidate pool pickDayRecommendations
  // draws its stack alternatives from. A finished match is excluded on both
  // sides of this: it's never itself worth flagging as "overlaps something
  // else" (it's over, there's nothing left to conflict with), and it's not
  // a real alternative for anything still upcoming either.
  withIntervals.forEach(match => {
    match.overlappingIds = match.isFinished
      ? []
      : withIntervals
          .filter(other => other.id !== match.id && !other.isFinished && overlapMinutes(match, other) > 0)
          .map(other => other.id);
  });

  // "What's worth watching" is decided one local calendar day at a time
  // (see top-of-section comment) - bucket every eligible (non-quiet-hour,
  // not-already-finished) match by the local day it starts on, then run the
  // whole DP/diversity/stacking pipeline independently per day. A match
  // excluded here (quiet hours, or already over) simply keeps its default
  // `recommended: false` from above - a finished match has nothing left to
  // recommend, it's kept around purely so the day's schedule stays visible
  // and continuous instead of matches disappearing the moment they end.
  const byDay = new Map();
  withIntervals
    .filter(m => !isQuietHours(m) && !m.isFinished)
    .forEach(match => {
      const dayKey = localDateKey(new Date(match.interval.start));
      if (!byDay.has(dayKey)) byDay.set(dayKey, []);
      byDay.get(dayKey).push(match);
    });
  for (const dayMatches of byDay.values()) {
    pickDayRecommendations(dayMatches);
  }

  return withIntervals.map(({ interval, effectiveScore, ...match }) => match);
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

function buildMatchCard(match, { isStackAlternative = false } = {}) {
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
      : relativeLabel(start, end);
  }

  const badge = node.querySelector('.sport-badge');
  badge.textContent = SPORT_LABELS_ZH[match.sport] || match.sport;
  badge.dataset.sport = match.sport;

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
    // A quiet "you already have this" mark rather than hiding/muting
    // anything without it - see DEFAULT_MY_SERVICE_IDS's own comment on why
    // this stays a nudge, not a filter.
    watchEl.querySelector('.watch-owned').hidden = !(service && state.myServiceIds.has(service.id));
  }

  const recommendedTag = node.querySelector('.recommended-tag');
  if (isStackAlternative) {
    recommendedTag.hidden = false;
    recommendedTag.textContent = '同時段選擇';
    recommendedTag.classList.add('is-alternative');
  } else if (match.recommended) {
    recommendedTag.hidden = false;
  }

  const reasonEl = node.querySelector('.match-reason');
  reasonEl.textContent = match.reason || '';
  if (match.source === 'heuristic') reasonEl.classList.add('is-heuristic');

  // Two cases, deliberately not layered on top of each other:
  //   1. Rendered as a card inside another match's swipeable stack (see
  //      renderRecommendedSection/buildMatchStack) - shown at full
  //      strength, no muting, since being offered as a swipe-to option is
  //      already the point; the plain "所有賽事" listing further down
  //      still mutes this same fixture on its own, unstacked card. This
  //      now also covers what used to be a separate "recommended, but
  //      overlapping the previous recommended pick" case - two recommended
  //      matches that overlap in time get merged into one stack in
  //      resolveViewingPlan rather than shown as two adjacent cards, so
  //      that case no longer exists on its own.
  //   2. Genuinely lost its slot with nothing surfacing it as an
  //      alternative anywhere - muted, with a note pointing at what's
  //      recommended instead.
  const conflictNote = node.querySelector('.conflict-note');
  if (isStackAlternative) {
    conflictNote.hidden = false;
    conflictNote.classList.add('is-allowed-overlap');
    conflictNote.textContent = '同一時段的另一個選擇——精彩程度也不差，滑動比較看看。';
  } else if (!match.recommended && (match.overlappingIds || []).length) {
    const others = state.matches.filter(m => match.overlappingIds.includes(m.id) && m.recommended);
    if (others.length) {
      conflictNote.hidden = false;
      conflictNote.textContent = `與「${others.map(m => m.name).join('、')}」時間重疊——該時段推薦的是這一場。`;
    }
    node.classList.add('is-muted');
  }
  if (match.recommended || isStackAlternative) node.classList.add('is-recommended');

  const now = Date.now();
  // isFinished is authoritative (ESPN's own status - see build-data.mjs's
  // own comment on why it can't just be inferred from `end`, which is only
  // ever a per-sport AVERAGE duration) - checked first so a game that ran
  // long past that average never gets mislabeled 直播中/live after it's
  // actually already over.
  if (match.isFinished) {
    node.classList.add('is-finished');
  } else if (!match.timeTbd && now >= start && now < end) {
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
  const now = Date.now();
  // isFinished (ESPN's own status) is checked first, same reasoning as
  // pickInitialDay's own comment - without it, a match that ran long past
  // its per-sport AVERAGE duration estimate (the fallback below) would
  // still look "current" here even though it's already over, now that a
  // finished match stays in the list instead of disappearing.
  const pinIndex = sortedMatches.findIndex(
    m => !m.isFinished && Date.parse(m.startTimeUtc) + m.durationMinutes * 60_000 > now
  );
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
// for no visible reason. This is a real, common case for MLB/MLS
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
      btn.textContent = sport === 'all' ? '全部' : SPORT_LABELS_ZH[sport] || sport;
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

// A recommended match plus its swipeable alternatives (see
// resolveViewingPlan's stackAlternativeIds pass) - a native CSS
// scroll-snap carousel (see .match-stack in styles.css), not custom touch
// handling, so swiping works the same way it does anywhere else on this
// page. Dots track scroll position via a plain scroll listener - good
// enough at 2-4 cards, no need for an IntersectionObserver.
function buildMatchStack(primary, alternatives, isPinned) {
  const wrapper = document.createElement('div');
  wrapper.className = 'match-stack';

  const hint = document.createElement('p');
  hint.className = 'match-stack-hint';
  hint.textContent = `⟷ 這個時段還有 ${alternatives.length} 個選擇，左右滑動比較`;

  const scroller = document.createElement('div');
  scroller.className = 'match-stack-scroller';
  const cards = [primary, ...alternatives];
  cards.forEach((match, index) => {
    const card = buildMatchCard(match, { isStackAlternative: index > 0 });
    if (index === 0 && isPinned) card.classList.add('is-pinned');
    scroller.appendChild(card);
  });

  const dots = document.createElement('div');
  dots.className = 'match-stack-dots';
  const dotEls = cards.map((_, index) => {
    const dot = document.createElement('span');
    dot.className = 'match-stack-dot' + (index === 0 ? ' is-active' : '');
    dots.appendChild(dot);
    return dot;
  });
  scroller.addEventListener(
    'scroll',
    () => {
      const activeIndex = Math.round(scroller.scrollLeft / Math.max(1, scroller.clientWidth));
      dotEls.forEach((dot, index) => dot.classList.toggle('is-active', index === activeIndex));
    },
    { passive: true }
  );

  wrapper.append(hint, scroller, dots);
  return wrapper;
}

function renderRecommendedSection() {
  const dayMatches = applySportFilter(matchesForSelectedDay().filter(m => m.recommended));
  dayMatches.sort((a, b) => Date.parse(a.startTimeUtc) - Date.parse(b.startTimeUtc));
  const ordered = pinCurrentOrNext(dayMatches);

  if (!ordered.length) {
    recommendedListEl.replaceChildren();
    recommendedEmptyEl.hidden = false;
    return;
  }
  recommendedEmptyEl.hidden = true;
  // stackAlternativeIds can point at a fixture on a different (adjacent)
  // local day if the recommended match's slot straddles midnight for this
  // viewer - looked up from the full state.matches, not just today's
  // bucket, so that edge case doesn't just silently drop the alternative.
  const byId = new Map(state.matches.map(m => [m.id, m]));
  const fragment = document.createDocumentFragment();
  ordered.forEach((match, index) => {
    const alternatives = (match.stackAlternativeIds || [])
      .map(id => byId.get(id))
      .filter(alt => alt && (state.activeSport === 'all' || alt.sport === state.activeSport));

    if (!alternatives.length) {
      const card = buildMatchCard(match);
      if (index === 0) card.classList.add('is-pinned');
      fragment.appendChild(card);
      return;
    }
    fragment.appendChild(buildMatchStack(match, alternatives, index === 0));
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
  const now = Date.now();
  const todayKey = localDateKey(new Date());
  const todayHasRemaining = matches.some(m => {
    if (localDateKey(new Date(m.startTimeUtc)) !== todayKey) return false;
    // isFinished (ESPN's own status) is authoritative and checked first - a
    // finished match now stays in `matches` for schedule continuity (see
    // build-data.mjs), so without this a game that ran long past its
    // per-sport AVERAGE duration estimate (the fallback below) would still
    // read as "remaining" here even though it's actually already over.
    if (m.isFinished) return false;
    return Date.parse(m.startTimeUtc) + m.durationMinutes * 60_000 > now;
  });
  if (todayHasRemaining) return todayKey;

  const todayIndex = days.findIndex(d => d.key === todayKey);
  for (let i = todayIndex + 1; i < days.length; i++) {
    if (matches.some(m => localDateKey(new Date(m.startTimeUtc)) === days[i].key)) {
      return days[i].key;
    }
  }
  return todayKey;
}

// How often an already-open tab checks for something new. Deliberately a
// real network request each time (cache: 'no-store', same as the initial
// load) rather than relying on the browser to notice on its own - without
// this, a tab left open just keeps showing whatever was current when it
// was first loaded, for as long as the tab stays open, since nothing else
// in this page ever re-fetches matches.json (see the 60s interval further
// down, which only re-renders the data already in memory - it never asks
// the network for anything new).
const DATA_POLL_INTERVAL_MS = 5 * 60_000;

// Same "an already-open tab has to actually ask again" reasoning as
// DATA_POLL_INTERVAL_MS above, for cross-device settings sync - a plain
// GET against Firestore through the shared proxy (MATCH_FIND_SYNC_READ_RATE_LIMIT
// there is 6000/hour per IP, so a poll every 30s from one tab, or even a
// handful of tabs behind the same IP, is nowhere close to that), not the
// heavier matches.json fetch, so this can run noticeably more often
// without it costing anything real. This is the actual fix for "changing
// settings on one device doesn't show up on another" for a tab that was
// already open when the change happened elsewhere - previously sync only
// ever pulled once, on that tab's own initial load (see syncPull's own
// comment).
const SYNC_POLL_INTERVAL_MS = 30_000;

// "Gemini last used" (see build-data.mjs's AI_FETCH_MIN_INTERVAL_HOURS) -
// purely informational, so a viewer curious why a brand new fixture still
// shows an "(估計，非 AI 推薦)" heuristic reason can see this isn't stuck,
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
// the initial load and by pollForUpdates() below, so "how a payload turns
// into what's on screen" only exists in one place.
function applyMatchData(data) {
  state.proxyUrl = data.proxyUrl || '';
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
  const rawMatches = state.allRawMatches.filter(m => state.enabledSports.has(m.sport));
  state.rawMatches = rawMatches;
  state.matches = resolveViewingPlan(rawMatches, state.priorityOrder, state.myServiceIds, state.recommendStyle);
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
  // MLB/MLS-vs-Taiwan-timezone case) jumps to the nearest day that has it.
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
async function pollForUpdates() {
  try {
    const response = await fetch('./data/matches.json', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (data.generatedAt === state.generatedAt) return; // nothing new

    if (state.buildId && data.buildId && data.buildId !== state.buildId) {
      location.replace(`${location.pathname}?v=${encodeURIComponent(data.buildId)}`);
      return;
    }

    state.generatedAt = data.generatedAt;
    applyMatchData(data);
  } catch (error) {
    console.error('update check failed', error);
  }
}

async function init() {
  try {
    const response = await fetch('./data/matches.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.generatedAt = data.generatedAt;
    state.buildId = data.buildId;

    applyMatchData(data);

    // Pull first if already paired (so another device's more recent
    // settings win over whatever this one has cached), otherwise offer to
    // pair - never both, on the initial load.
    if (state.syncPasscode) syncPull();
    else maybeShowSyncPrompt();

    setInterval(() => renderSections(), 60_000);
    setInterval(pollForUpdates, DATA_POLL_INTERVAL_MS);
    // Periodic + on-focus sync pulls (see SYNC_POLL_INTERVAL_MS's own
    // comment) - both no-ops while unpaired, and both safe to fire
    // whenever: syncPull only ever actually applies/re-renders when the
    // fetched payload is genuinely different from what this device
    // already has. The focus listener is what makes switching back to an
    // already-open tab feel immediate rather than waiting out the rest of
    // the poll interval - the single most common real case ("I changed it
    // on my phone, now I'm looking at my laptop's tab again").
    setInterval(() => {
      if (state.syncPasscode) syncPull({ renderIfOpen: true });
    }, SYNC_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.syncPasscode) syncPull({ renderIfOpen: true });
    });
  } catch (error) {
    console.error(error);
    errorState.hidden = false;
  }
}

init();
