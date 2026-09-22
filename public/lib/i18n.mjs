// ---- public/lib/i18n.mjs ----
//
// The whole of this site's UI-copy translation layer. Deliberately tiny and
// DOM-free (same "pure module, no side effects beyond its own module-level
// state" posture as ./preferences.mjs) - app.js is still the only place that
// ever touches the DOM, this module just decides WHAT TEXT to show it.
//
// Adding a third language later is meant to be exactly this: add one more
// `<locale>: { ...every key STRINGS['zh-TW'] already has... }` object to
// STRINGS below, and (if it should ever be auto-detected) one more branch in
// detectLocale. Nothing else in this file, or in app.js's own calls into
// t()/getLocale(), needs to change - every caller already goes through t(),
// never a hardcoded STRINGS['zh-TW'] lookup, so a missing key in a new
// locale silently falls back to the zh-TW text (see t() below) rather than
// throwing or rendering blank.
//
// This is a Traditional-Chinese, Taiwan-based site first (see app.js's own
// top comment: 愛爾達體育台, a real Taiwanese broadcaster, is hardcoded
// domain data, not something this file translates) - zh-TW is therefore the
// fallback locale everywhere below, never zh-CN and never en.

export const DEFAULT_LOCALE = 'zh-TW';

export const STRINGS = {
  'zh-TW': {
    // ---- Page metadata (title/meta tags - applied client-side, see
    // app.js's applyStaticTranslations, since this is a static HTML file
    // with no per-request templating step) ----
    title: 'Match Find — 今晚看什麼',
    metaDescription: '英超、MLB、NBA、F1 賽程，依精彩程度推薦，換算成你的當地時間。',

    // ---- Settings panel ----
    settingsAriaLabel: '設定',
    settingsHeading: '設定',
    closeAriaLabel: '關閉',
    sportPriorityHeading: '賽事優先順序',
    sportPriorityHint: '時間衝突時，排名較前的優先。',
    resetPriorityBtn: '重設為預設順序',
    enabledSportsHeading: '已啟用的運動',
    enabledSportsHint: '關閉的運動不會出現在網站上。',
    updateHeading: '更新',
    updateStatusDefault: '資料會持續自動更新。',
    refreshNowBtn: '立即重新整理',

    // ---- Page chrome / sections ----
    loadingAriaLabel: '載入中',
    daySelectorAriaLabel: '選擇日期',
    sportFilterAriaLabel: '依運動篩選',
    recommendedHeading: '推薦賽事',
    recommendedEmpty: '今天沒有特別推薦的賽事。',
    allMatchesHeading: '所有賽事',
    allEmpty: '這一天沒有賽事。',
    tbdHeading: '時間未定',
    globalEmpty: '近期沒有賽事，請稍後再回來看看。',
    globalError: '無法載入資料，請稍後再試一次。',

    // ---- Sport names / filters (data KEYS stay the English ESPN spelling -
    // see app.js's own SPORT_LABEL_KEYS comment - only the on-screen text
    // goes through here) ----
    sportPremierLeague: '英超',
    sportMLB: 'MLB',
    sportNBA: 'NBA',
    sportF1: 'F1',
    filterAll: '全部',
    moveSportUp: '將 {sport} 往上移',
    moveSportDown: '將 {sport} 往下移',

    // ---- Match timing / lifecycle ----
    liveNow: '直播中',
    startingSoon: '即將開始',
    minutesLater: '{mins} 分鐘後',
    hoursLater: '{hours} 小時後',
    hoursMinutesLater: '{hours} 小時 {mins} 分後',
    daysLater: '{days} 天後',
    daysHoursLater: '{days} 天 {hours} 小時後',
    finished: '已結束',
    finishedWithScore: '已結束．{away}–{home}',
    timeTbd: '時間未定',
    today: '今天',
    tomorrow: '明天',
    yesterday: '昨天',

    // ---- Live in-progress widgets (per sport) ----
    inningTop: '上',
    inningBot: '下',
    inningMid: '中',
    inningEnd: '完',
    inningFormat: '第 {n} 局{half}',
    quarterLabel: '第 {n} 節',
    overtimeLabel: '延長賽 OT{n}',
    firstHalf: '上半場',
    secondHalf: '下半場',
    lapLabel: '第 {n} 圈',
    currentOrder: '目前領先',

    // ---- Match card ----
    homeShort: '主',
    awayShort: '客',
    commaSeparator: '，',
    winProbAriaWithDraw: '獲勝機率：{away} {awayPct}%，和局 {drawPct}%，{home} {homePct}%',
    winProbAria: '獲勝機率：{away} {awayPct}%，{home} {homePct}%',
    titleOdds: '奪冠機率',
    poleOdds: '桿位機率',
    outrightAria: '{label}：{items}',
    recommendedTag: '推薦',
    preferredTag: '偏好',
    preferMatchBtn: '設為偏好',
    overlapGeneric: '時間重疊',
    overlapMinutes: '重疊 {mins} 分鐘',
    overlapHours: '重疊 {hours} 小時',
    overlapHoursMinutes: '重疊 {hours} 小時 {mins} 分',
    conflictNote: '與「{name}」{clause}',

    // ---- Swipeable match stack ----
    matchStackHint: '⟷ 這個時段只能擇一收看，點選切換要看哪一場',
    prevMatchAria: '上一場',
    nextMatchAria: '下一場',
    switchToAria: '切換到{name}',

    // ---- Footer / data-refresh status ----
    generatedNote: '資料最後更新於 {day} {time}（你的當地時間）',
    newVersionAvailable: '有新版本可用，將在你離開此頁籤時自動更新，或點擊「{refreshBtn}」立即更新。',
    refreshing: '重新整理中…',
    dataUpdated: '資料已更新。',
    refreshFailed: '重新整理失敗，請稍後再試。',
    checkingVersion: '檢查版本中…',
    nextUpdateIn: '下次更新：{secs} 秒後',
    updatingNow: '更新中…'
  },

  en: {
    title: 'Match Find — What to Watch Tonight',
    metaDescription:
      'Premier League, MLB, NBA and F1 schedules, ranked by watchability and converted to your local time.',

    settingsAriaLabel: 'Settings',
    settingsHeading: 'Settings',
    closeAriaLabel: 'Close',
    sportPriorityHeading: 'Sport Priority',
    sportPriorityHint: 'When times conflict, the higher-ranked sport wins.',
    resetPriorityBtn: 'Reset to Default Order',
    enabledSportsHeading: 'Enabled Sports',
    enabledSportsHint: 'Disabled sports will not appear on the site.',
    updateHeading: 'Updates',
    updateStatusDefault: 'Data updates automatically.',
    refreshNowBtn: 'Refresh Now',

    loadingAriaLabel: 'Loading',
    daySelectorAriaLabel: 'Select date',
    sportFilterAriaLabel: 'Filter by sport',
    recommendedHeading: 'Recommended Matches',
    recommendedEmpty: 'No standout matches recommended today.',
    allMatchesHeading: 'All Matches',
    allEmpty: 'No matches on this day.',
    tbdHeading: 'Time TBD',
    globalEmpty: 'No matches coming up — check back later.',
    globalError: 'Could not load data — please try again later.',

    sportPremierLeague: 'Premier League',
    sportMLB: 'MLB',
    sportNBA: 'NBA',
    sportF1: 'F1',
    filterAll: 'All',
    moveSportUp: 'Move {sport} up',
    moveSportDown: 'Move {sport} down',

    liveNow: 'Live',
    startingSoon: 'Starting soon',
    minutesLater: 'in {mins} min',
    hoursLater: 'in {hours}h',
    hoursMinutesLater: 'in {hours}h {mins}m',
    daysLater: 'in {days}d',
    daysHoursLater: 'in {days}d {hours}h',
    finished: 'Finished',
    finishedWithScore: 'Finished — {away}–{home}',
    timeTbd: 'Time TBD',
    today: 'Today',
    tomorrow: 'Tomorrow',
    yesterday: 'Yesterday',

    inningTop: 'Top',
    inningBot: 'Bot',
    inningMid: 'Mid',
    inningEnd: 'End',
    inningFormat: '{half} {n}',
    quarterLabel: 'Q{n}',
    overtimeLabel: 'OT{n}',
    firstHalf: '1st Half',
    secondHalf: '2nd Half',
    lapLabel: 'Lap {n}',
    currentOrder: 'Current Order',

    homeShort: 'H',
    awayShort: 'A',
    commaSeparator: ', ',
    winProbAriaWithDraw: 'Win probability: {away} {awayPct}%, Draw {drawPct}%, {home} {homePct}%',
    winProbAria: 'Win probability: {away} {awayPct}%, {home} {homePct}%',
    titleOdds: 'Title Odds',
    poleOdds: 'Pole Position Odds',
    outrightAria: '{label}: {items}',
    recommendedTag: 'Recommended',
    preferredTag: 'Preferred',
    preferMatchBtn: 'Set as Preferred',
    overlapGeneric: 'overlapping time',
    overlapMinutes: '{mins} min overlap',
    overlapHours: '{hours}h overlap',
    overlapHoursMinutes: '{hours}h {mins}m overlap',
    conflictNote: 'Overlaps with "{name}" — {clause}',

    matchStackHint: '⟷ Only one match in this time slot can be watched — tap to switch',
    prevMatchAria: 'Previous match',
    nextMatchAria: 'Next match',
    switchToAria: 'Switch to {name}',

    generatedNote: 'Data last updated {day} {time} (your local time)',
    newVersionAvailable:
      'A new version is available. It will update automatically when you leave this tab, or click "{refreshBtn}" to update now.',
    refreshing: 'Refreshing…',
    dataUpdated: 'Data updated.',
    refreshFailed: 'Refresh failed — please try again.',
    checkingVersion: 'Checking for updates…',
    nextUpdateIn: 'Next update in {secs}s',
    updatingNow: 'Updating…'
  }
};

// Same local-only localStorage pattern/key convention as app.js's own
// SETTINGS_STORAGE_KEY/ENABLED_SPORTS_STORAGE_KEY ('matchfind-*') - see that
// file's top comment on why every per-viewer preference here is local-only,
// no server sync.
const LOCALE_STORAGE_KEY = 'matchfind-locale';

// navigator.languages (an ordered preference list) is preferred over the
// single navigator.language when a browser exposes it - a viewer whose OS
// language is English but who lists Chinese as a secondary preference (or
// vice versa) is still better served by their FIRST preference than by
// whichever single value navigator.language happens to surface. Falls back
// to zh-TW for anything neither prefix matches (a third language landing
// here before STRINGS gains its own entry, or a locale this site simply
// doesn't have copy for yet) - see this module's own top comment for why
// zh-TW, not en, is the correct "we don't recognize this" default.
export function detectLocale() {
  const candidates =
    typeof navigator !== 'undefined'
      ? [...(Array.isArray(navigator.languages) ? navigator.languages : []), navigator.language].filter(Boolean)
      : [];
  for (const raw of candidates) {
    const lang = String(raw).toLowerCase();
    if (lang.startsWith('zh')) return 'zh-TW';
    if (lang.startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}

function loadStoredLocale() {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return stored && Object.prototype.hasOwnProperty.call(STRINGS, stored) ? stored : null;
  } catch {
    // Private browsing / blocked storage - just means no override survives
    // reload, same as every other localStorage read in this app.
    return null;
  }
}

// Resolved once at module load: an explicit prior choice (setLocale below)
// always wins over re-detecting from the browser every time, so a viewer
// who deliberately picked a language doesn't get overridden the next time
// their OS/browser language happens to differ from it.
let currentLocale = loadStoredLocale() || detectLocale();

export function getLocale() {
  return currentLocale;
}

export function setLocale(locale) {
  if (!Object.prototype.hasOwnProperty.call(STRINGS, locale)) return;
  currentLocale = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Same best-effort posture as every other localStorage write here - the
    // page still works for this view, it just won't remember next time.
  }
}

// `vars`, when given, fills in `{placeholder}` tokens in the resolved
// template - a small superset of the exact `t(key)` contract this module
// was specified with (STRINGS[locale]?.[key] ?? STRINGS['zh-TW'][key] ??
// key), added because so much of this app's real UI copy is a template
// ("{mins} 分鐘後", "與「{name}」{clause}") rather than a bare label. A
// placeholder with no matching entry in `vars` is left as-is rather than
// silently blanked, so a caller forgetting one is obvious in the rendered
// text rather than invisible.
export function t(key, vars) {
  const template = STRINGS[currentLocale]?.[key] ?? STRINGS[DEFAULT_LOCALE][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

// The BCP-47 tag to actually pass to Intl.DateTimeFormat/<html lang> for the
// current locale - deliberately separate from the STRINGS key itself
// ('zh-TW' happens to already be a valid BCP-47 tag, but 'en' on its own
// still needs a real region for Intl to pick sensible defaults, and this is
// the one place that mapping lives rather than every caller re-deciding it).
export function dateFnsLocaleTag() {
  return currentLocale === 'en' ? 'en-US' : 'zh-Hant-TW';
}
