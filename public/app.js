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
  matches: [], // every fetched (non-TBD), enabled-sport match, mutated in place with .recommended/.overlappingIds
  days: [], // [{key: 'YYYY-MM-DD', date: Date}, ...] - every calendar day the fetched window covers
  selectedDayKey: null,
  activeSport: 'all',
  recommendStyle: 'entertainment', // which per-match score drives "推薦賽事" - see "Recommendation style setting" below (overwritten by loadRecommendStyle() right after this object)
  priorityOrder: [], // sports ranked best-to-least - see "Sport priority settings" below
  enabledSports: [], // sports to show at all - see "Enabled sports settings" below
  myServiceIds: [], // subscribed services - see "Broadcast service registry" below
  proxyUrl: '', // from matches.json - where sync calls go (see "Cross-device settings sync")
  syncPasscode: '', // '' when not paired to a sync code - see "Cross-device settings sync"
  // Map<dayKey, Map<slotKey, matchId>> - which member of a multi-match
  // "slot" (see isNearTotalOverlap) the viewer explicitly swiped to commit
  // to watching, per day - see computeDayPlan/pinSlotChoice. Deliberately
  // session-only (never persisted to localStorage/synced): it's "what I'm
  // watching today", not a durable preference, and naturally stops
  // mattering once the day's matches are over.
  pinnedChoices: new Map()
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

// Each league/sanctioning body's own real, official mark, hotlinked from
// ESPN's CDN - the same team-logos.espncdn.com-family hosting the team
// crests/F1 logo elsewhere in this file already come from, not a
// reproduction copied into this repo. Used everywhere a sport is shown -
// the match card badge, the filter chips, and both sport-related Settings
// lists (see buildSportIcon below, the one place all four read from).
const LEAGUE_LOGOS = {
  'Premier League': 'https://a.espncdn.com/i/leaguelogos/soccer/500/23.png',
  MLS: 'https://a.espncdn.com/i/leaguelogos/soccer/500/19.png',
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
  MLS:
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
const SERVICES = [
  // The Commons file this used to point at (ELTA_logo.svg) turned out, on
  // closer look, to be the logo of ELTA - a Lithuanian news agency that
  // just happens to share the initialism - not Taiwan's 愛爾達體育台 at
  // all, and no genuine Commons file for the Taiwan channel's own mark
  // existed to replace it with. This logo instead comes from 愛爾達電視's
  // own official Android app icon on the Google Play Store - a real,
  // confirmed-correct source, just not one with Commons' own "always
  // resolves to the file's current version" redirect guarantee.
  {
    id: 'elta',
    pattern: /愛爾達|ELTA/i,
    label: '愛爾達體育台',
    badge: '達',
    color: '#ff7a3d',
    logo: 'https://play-lh.googleusercontent.com/vE0VONaUjXyEgpUv0efGHg2_GS_Kbmx3YKyWPWzmv8oX-BlTzDReK17V9GhuJ7e7MMmFWvrVyP08vn03Q_H3',
    logoBg: 'linear-gradient(155deg, #ff9457, #e8531a)'
  },
  {
    id: 'appletv',
    pattern: /Apple\s*TV/i,
    label: 'Apple TV',
    badge: 'TV',
    color: '#1d1d1f',
    logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/AppleTVLogo.svg',
    logoBg: 'linear-gradient(155deg, #3a3a3d, #0c0c0e)'
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
// Fixed rather than a per-viewer Settings toggle (see "Broadcast service
// registry" above) - this site's own owner's real subscriptions, used as a
// silent tie-breaking nudge in resolveViewingPlan only (see
// OWNED_SERVICE_SCORE_BONUS below) - a great game on a service you don't
// have still shows up and can still be recommended, this just tips a
// genuinely close call. No badge/mark in the UI for it anymore - it's a
// scoring input, not something worth a viewer's attention on every card.
const DEFAULT_MY_SERVICE_IDS = ['elta', 'appletv', 'netflix'];

function resolveService(whereToWatchTw) {
  if (!whereToWatchTw) return null;
  return SERVICES.find(s => s.pattern.test(whereToWatchTw)) || null;
}

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

// ---- Cross-device settings sync --------------------------------------------
//
// Syncs exactly two things - priorityOrder, enabledSports -
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
    enabledSports: [...state.enabledSports]
  };
}

// Applies a synced payload on top of local state - the same tolerant
// filtering as the individual loadX functions above (an unknown sport id,
// e.g. from an older or newer version of this site syncing with this one,
// is dropped rather than trusted blindly), then persists it locally so a
// later offline visit still has it.
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
  saveRecommendStyle(state.recommendStyle);
  savePriorityOrder(state.priorityOrder);
  saveEnabledSports(state.enabledSports);
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
      row.append(rank, icon, label, moveGroup);
      return row;
    })
  );
  renderEnabledSportsPanel();
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
        persistSettingsAndSync();
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
// This version is a real (if simplified vs. the earliest, bug-prone
// attempt - see groupIntoSlots' own comment) weighted-interval-scheduling
// chain: the maximum-total-effectiveScore set of non-overlapping matches
// for the day. Two matches that overlap so much you genuinely can't
// sequence them (see isNearTotalOverlap) become one "slot" - a swipeable
// choice, not two separate picks - and swiping to a different member PINS
// it: the plan rebuilds itself around that fixed choice, both before and
// after it (see computeDayPlan). enduranceScore feeds directly into how
// long a pick actually blocks the next one from starting (see
// effectiveDurationMinutes) - a fixture unlikely to stay watchable to the
// end frees up the schedule sooner than its full nominal length would
// suggest, letting the plan fit a next pick in earlier.
const QUIET_HOUR_START = 0;
const QUIET_HOUR_END = 5;

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

// This file's one and only overlap check - computed straight from a plain
// match's own startTimeUtc/durationMinutes (its REAL broadcast window, not
// the endurance-shortened one effectiveInterval below uses for scheduling)
// so every caller - the day-planner's own slot grouping, buildMatchCard's
// overlap note - agrees on what "these two overlap, and by how much"
// actually means.
function computeOverlapRange(a, b) {
  const ai = matchInterval(a);
  const bi = matchInterval(b);
  const start = Math.max(ai.start, bi.start);
  const end = Math.min(ai.end, bi.end);
  return end > start ? { start, end } : null;
}

function overlapMinutes(a, b) {
  const range = computeOverlapRange(a, b);
  return range ? (range.end - range.start) / 60_000 : 0;
}

// The bar for "these two matches genuinely can't be sequenced, you have to
// pick one" (see the section comment's own "slot" definition) - a FRACTION
// of the SHORTER match's own duration, not a flat minute count: 45 shared
// minutes is nearly all of a 55-minute F1 sprint but barely a quarter of a
// 190-minute MLB game, so a fixed number can't mean "basically total
// overlap" for both at once the way a duration-relative fraction does.
const NEAR_TOTAL_OVERLAP_FRACTION = 0.75;
function isNearTotalOverlap(a, b) {
  const overlapMins = overlapMinutes(a, b);
  if (overlapMins <= 0) return false;
  const shorter = Math.min(a.durationMinutes, b.durationMinutes);
  return shorter > 0 && overlapMins / shorter >= NEAR_TOTAL_OVERLAP_FRACTION;
}

// How much of a match's OWN nominal length actually gets reserved in the
// day's schedule - see enduranceScore's own comment (shared-proxy's
// worker.js buildMatchRecommendPrompt) for what it measures. A match
// projected to definitely stay tense to the end (enduranceScore 10) keeps
// its full nominal length; one projected to likely turn into an early
// blowout (enduranceScore 1) frees up the schedule at
// ENDURANCE_DURATION_FLOOR of it instead - never less than that floor,
// since even a lopsided match is still ostensibly airing for its whole
// listed length and the plan shouldn't assume a viewer bails absurdly
// early. `?? 5` (neutral/middling) covers a heuristic-scored match or one
// still on an older cache entry from before this field existed.
const ENDURANCE_DURATION_FLOOR = 0.4;
function effectiveDurationMinutes(match) {
  const endurance = Number.isFinite(match.enduranceScore) ? match.enduranceScore : 5;
  const factor = ENDURANCE_DURATION_FLOOR + (1 - ENDURANCE_DURATION_FLOOR) * (endurance / 10);
  return match.durationMinutes * factor;
}
function effectiveInterval(match) {
  const start = Date.parse(match.startTimeUtc);
  return { start, end: start + effectiveDurationMinutes(match) * 60_000 };
}

// Groups a day's candidate matches into "slots" - anchor-claiming,
// highest-effectiveScore-first: an unclaimed match becomes a slot's
// anchor, and only matches that are near-totally overlapping THAT SPECIFIC
// anchor (never each other transitively) join it and get claimed. This is
// the one piece of an earlier, more elaborate multi-pass design (see git
// history) that was never the source of a bug there, so it survives
// unchanged - the bugs were all in what happened AFTER grouping (a
// separate density-driven pass, then a pass to clean up what THAT could
// break); this version replaces all of that with a single, real scheduling
// DP over the resulting slots (see computeDayPlan) instead of another
// patch. A match with nothing near-totally overlapping it simply becomes
// its own one-member slot.
function groupIntoSlots(dayMatches) {
  const claimed = new Set();
  const slots = [];
  dayMatches
    .slice()
    .sort((a, b) => b.effectiveScore - a.effectiveScore)
    .forEach(anchor => {
      if (claimed.has(anchor.id)) return;
      claimed.add(anchor.id);
      const members = dayMatches.filter(m => !claimed.has(m.id) && isNearTotalOverlap(anchor, m));
      members.forEach(m => claimed.add(m.id));
      slots.push({ members: [anchor, ...members] });
    });
  return slots;
}

// A slot's own stable identity across renders/rebuilds - independent of
// object identity (state.matches is rebuilt from scratch on every data
// refresh) and independent of WHICH member is currently chosen (pinning a
// different member must still resolve back to the same slot next time).
// Grouping itself (groupIntoSlots) is deterministic for a given match set,
// so this is safe to compute fresh every time rather than needing to be
// stored anywhere.
function slotKeyFromMembers(members) {
  return members.map(m => m.id).sort().join('|');
}

function bestMember(members) {
  return members.slice().sort((a, b) => b.effectiveScore - a.effectiveScore)[0];
}

// Classic weighted interval scheduling: the maximum-total-choice.effectiveScore
// subset of `items` (each {interval, choice}) whose intervals don't
// overlap. O(n^2) in the inner "find the latest compatible previous item"
// scan - fine at the scale one day's fixture list ever reaches (even MLB's
// own ~15-a-night doesn't come close to where that would matter).
function weightedIntervalSchedule(items) {
  const sorted = items.slice().sort((a, b) => a.interval.end - b.interval.end);
  const dp = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    let prevBest = { score: 0, picks: [] };
    for (let j = i - 1; j >= 0; j--) {
      if (sorted[j].interval.end <= cur.interval.start) {
        prevBest = dp[j];
        break;
      }
    }
    const withCur = { score: prevBest.score + cur.choice.effectiveScore, picks: [...prevBest.picks, cur] };
    const without = i > 0 ? dp[i - 1] : { score: 0, picks: [] };
    dp[i] = withCur.score >= without.score ? withCur : without;
  }
  return sorted.length ? dp[sorted.length - 1].picks : [];
}

// Builds ONE local calendar day's back-to-back viewing plan from its
// already sport-filtered, non-quiet-hour-excluded candidate matches - see
// the section comment above for the model. Mutates every match in
// `dayMatches` in place (.recommended/.alternativeIds), same convention as
// the rest of this file. `alternativeIds` deliberately stores just the
// OTHER slot members' ids, same pattern as `.overlappingIds` elsewhere in
// this file, not full object references - a chosen match's own slot
// necessarily contains that same match, so storing full objects back onto
// it would self-reference and break JSON.stringify (the export tool hit
// exactly this before it was caught). Returns the plan as a plain array of
// matches, sorted by start time.
function computeDayPlan(dayKey, dayMatches) {
  dayMatches.forEach(match => {
    match.recommended = false;
    match.alternativeIds = null;
  });
  const candidates = dayMatches.filter(m => !isQuietHours(m) && !m.isFinished);
  if (!candidates.length) return [];

  const slots = groupIntoSlots(candidates);
  const pinnedForDay = state.pinnedChoices.get(dayKey);
  const resolved = slots.map(slot => {
    const pinnedId = pinnedForDay && pinnedForDay.get(slotKeyFromMembers(slot.members));
    const pinnedMember = pinnedId ? slot.members.find(m => m.id === pinnedId) : null;
    const choice = pinnedMember || bestMember(slot.members);
    return { members: slot.members, choice, interval: effectiveInterval(choice), isPinned: !!pinnedMember };
  });

  // Pinned slots split the day into independent gaps - the free (unpinned)
  // slots in each gap get their own scheduling run, bounded so nothing
  // scheduled there can creep into a pinned pick's own fixed window. This
  // is the actual "rebuild before AND after the one I just picked"
  // behavior: every other slot, on both sides, is being freshly reasoned
  // about relative to the pin, not just appended after it.
  const forced = resolved.filter(r => r.isPinned).sort((a, b) => a.interval.start - b.interval.start);
  const free = resolved.filter(r => !r.isPinned);
  const picks = [];
  let cursor = -Infinity;
  forced.forEach(f => {
    picks.push(...weightedIntervalSchedule(free.filter(r => r.interval.start >= cursor && r.interval.end <= f.interval.start)));
    picks.push(f);
    cursor = f.interval.end;
  });
  picks.push(...weightedIntervalSchedule(free.filter(r => r.interval.start >= cursor)));

  picks.sort((a, b) => a.interval.start - b.interval.start);
  picks.forEach(({ members, choice }) => {
    choice.recommended = true;
    if (members.length > 1) choice.alternativeIds = members.filter(m => m.id !== choice.id).map(m => m.id);
  });
  return picks.map(p => p.choice);
}

// The actual "I will watch this" commitment (see buildMatchStack) - records
// the pin and triggers a full re-render, which recomputes computeDayPlan
// for the current day and reflows every other slot around it.
function pinSlotChoice(dayKey, members, matchId) {
  if (!state.pinnedChoices.has(dayKey)) state.pinnedChoices.set(dayKey, new Map());
  state.pinnedChoices.get(dayKey).set(slotKeyFromMembers(members), matchId);
  renderSections();
}

// `priorityOrder` (see "Sport priority settings" above) nudges
// effectiveScore away from the AI's own score - the displayed reason/.score
// always stay the true, un-nudged values; only effectiveScore (the day
// plan's own DP weight, and groupIntoSlots' own anchor ordering) sees the
// adjusted number, so a viewer's preference can tip a close scheduling
// call without pretending a mediocre match is actually great. A sport
// ranked 1st gets the biggest positive nudge, the sport ranked in the
// exact middle gets none, and the last-ranked sport gets the biggest
// negative one - symmetric around the middle rank so "no preference at
// all" (the default order) really does mean zero nudge for everyone, not
// just for whichever sport happens to be first in the array.
function resolveViewingPlan(matches, priorityOrder = [], myServiceIds = new Set(), recommendStyle = 'entertainment') {
  const centerRank = (priorityOrder.length - 1) / 2;
  const withScores = matches.map(match => {
    const rank = priorityOrder.indexOf(match.sport);
    const priorityNudge = rank === -1 ? 0 : (centerRank - rank) * PRIORITY_SCORE_DELTA;
    const service = resolveService(match.whereToWatchTw);
    const serviceNudge = service && myServiceIds.has(service.id) ? OWNED_SERVICE_SCORE_BONUS : 0;
    // Overrides the build-time composite with whichever field the chosen
    // style actually ranks by (see recommendStyleScore) - every downstream
    // consumer of `.score`/`.effectiveScore` (computeDayPlan's scheduling
    // weight, the overlap note's own display, etc.) then just works off
    // this one number without needing to know styles exist at all.
    const styleScore = recommendStyleScore(match, recommendStyle);
    return {
      ...match,
      score: styleScore,
      effectiveScore: styleScore + priorityNudge + serviceNudge,
      recommended: false,
      alternativeIds: null
    };
  });

  // Computed across every fetched match regardless of day or quiet hours -
  // used purely for display (buildMatchCard's own overlap note, on ANY
  // card whose start overlaps an earlier match, recommended or not). A
  // finished match is excluded: it's never itself worth flagging as
  // "overlaps something else" once it's over, and it's not a meaningful
  // reference point for anything still upcoming either.
  withScores.forEach(match => {
    match.overlappingIds = match.isFinished
      ? []
      : withScores
          .filter(other => other.id !== match.id && !other.isFinished && overlapMinutes(match, other) > 0)
          .map(other => other.id);
  });

  // `.recommended`/`.alternativeIds` are deliberately NOT decided here anymore
  // - that's computeDayPlan's job, run per selected day (and per active
  // sport filter, and per pin) at render time, since which matches count
  // as "today's plan" now depends on interactive state this function has
  // no visibility into. This function's job is purely the viewer-relative
  // score adjustment and overlap bookkeeping every day's plan draws from.
  return withScores;
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
      : relativeLabel(start, end);
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

  const recommendedTag = node.querySelector('.recommended-tag');
  if (match.recommended) recommendedTag.hidden = false;

  const reasonEl = node.querySelector('.match-reason');
  reasonEl.textContent = match.reason || '';
  if (match.source === 'heuristic') reasonEl.classList.add('is-heuristic');

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
// groupIntoSlots) - a horizontally swipeable card stack, native CSS
// scroll-snap, same touch mechanism the day picker already uses. Unlike an
// earlier version of this stack, swiping here is a real commitment, not
// just a peek: settling on a different card PINS that match as this
// slot's fixed choice and rebuilds the whole day's plan around it (see
// pinSlotChoice/computeDayPlan) - matches before and after it reflow to
// connect with it instead of with whichever match was the plan's own
// default pick.
function buildMatchStack(dayKey, members, primary, isTopOfDay) {
  const wrapper = document.createElement('div');
  wrapper.className = 'match-stack';

  const hint = document.createElement('p');
  hint.className = 'match-stack-hint';
  hint.textContent = '⟷ 這個時段只能擇一收看，滑動選擇要看哪一場';

  const scroller = document.createElement('div');
  scroller.className = 'match-stack-scroller';
  // The plan's current choice (the pinned one, if any, else whichever
  // scored highest) always opens first, then the rest by score - so the
  // stack always visually agrees with what the rest of the page already
  // decided this slot's pick is.
  const ordered = [primary, ...members.filter(m => m.id !== primary.id).sort((a, b) => b.effectiveScore - a.effectiveScore)];
  ordered.forEach((match, index) => {
    const card = buildMatchCard(match);
    if (index === 0 && isTopOfDay) card.classList.add('is-pinned');
    scroller.appendChild(card);
  });

  const dots = document.createElement('div');
  dots.className = 'match-stack-dots';
  const dotEls = ordered.map((_, index) => {
    const dot = document.createElement('span');
    dot.className = 'match-stack-dot' + (index === 0 ? ' is-active' : '');
    dots.appendChild(dot);
    return dot;
  });
  // One listener does both jobs: the dots update on every scroll tick
  // (cheap, purely visual), while the actual pin+rebuild only fires once
  // the gesture SETTLES - a short debounce after scrolling stops, not on
  // every intermediate tick mid-swipe, which would otherwise re-pin (and
  // re-render the whole page) dozens of times during one swipe.
  let settleTimer = null;
  scroller.addEventListener(
    'scroll',
    () => {
      const activeIndex = Math.round(scroller.scrollLeft / Math.max(1, scroller.clientWidth));
      dotEls.forEach((dot, index) => dot.classList.toggle('is-active', index === activeIndex));
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        const chosen = ordered[activeIndex];
        if (chosen && chosen.id !== primary.id) pinSlotChoice(dayKey, members, chosen.id);
      }, 180);
    },
    { passive: true }
  );

  wrapper.append(hint, scroller, dots);
  return wrapper;
}

function renderRecommendedSection() {
  const dayKey = state.selectedDayKey;
  // Computed fresh every render, scoped to whatever's currently active
  // (day, sport filter, pins) - see computeDayPlan's own comment. Picking
  // "只看 MLB" gets its own MLB-only continuous plan, not the cross-sport
  // plan filtered down to whichever MLB picks happened to survive it.
  const dayPlan = computeDayPlan(dayKey, applySportFilter(matchesForDay(dayKey)));
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
// the initial load and by checkForUpdate() below, so "how a payload turns
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
// `silent` is what makes this the same function for both the background
// poll (setInterval, see init()) and the two manual Settings buttons: the
// background poll doesn't want status text fighting with whatever else the
// viewer might be looking at, while a viewer who just tapped "檢查更新" or
// "重新整理資料" wants to actually see the answer, not just react to
// whatever silently changes on screen behind the panel.
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
      if (!silent) updateStatusText.textContent = '已是最新版本。';
      return;
    }

    if (state.buildId && data.buildId && data.buildId !== state.buildId) {
      if (!silent) updateStatusText.textContent = '發現新版本，正在套用…';
      location.replace(`${location.pathname}?v=${encodeURIComponent(data.buildId)}`);
      return;
    }

    state.generatedAt = data.generatedAt;
    applyMatchData(data);
    if (!silent) updateStatusText.textContent = '資料已更新。';
  } catch (error) {
    console.error('update check failed', error);
    if (!silent) updateStatusText.textContent = '檢查失敗，請稍後再試。';
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
  state.days.forEach(day => computeDayPlan(day.key, matchesForDay(day.key)));
  const payload = {
    exportedAt: new Date().toISOString(),
    dataGeneratedAt: state.generatedAt || null,
    recommendStyle: state.recommendStyle,
    priorityOrder: state.priorityOrder,
    enabledSports: [...state.enabledSports],
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

    // Pull first if already paired (so another device's more recent
    // settings win over whatever this one has cached), otherwise offer to
    // pair - never both, on the initial load.
    if (state.syncPasscode) syncPull();
    else maybeShowSyncPrompt();

    setInterval(() => renderSections(), 60_000);
    setInterval(() => checkForUpdate({ silent: true }), DATA_POLL_INTERVAL_MS);
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
