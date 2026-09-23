// ---- public/lib/locales/zh-TW.mjs ----
// Traditional Chinese UI strings - this site's original (and still primary)
// language, and i18n.mjs's fallback locale for any key missing elsewhere.
// See public/lib/i18n.mjs for how this is loaded and looked up via t().
export default {
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
  matchStackHint: '⟷ 同時段只能擇一，點選切換',
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
};
