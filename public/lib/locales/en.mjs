// ---- public/lib/locales/en.mjs ----
// English UI strings. To add another language: copy this file to
// public/lib/locales/<code>.mjs, translate every value (every key that
// exists in locales/zh-TW.mjs should exist here too - t() falls back to
// zh-TW for anything missing), then wire it into i18n.mjs's STRINGS map
// and detectLocale().
//
// WARNING: the day-picker pills (.day-pill, public/styles.css) sit in a
// horizontally-scrolling row and already handle long text fine (flex:none,
// white-space:nowrap, the row itself scrolls) - but that's not true of
// every element here (settings labels, sport filter chips). No automated
// test renders this site's actual layout, so always check a real
// screenshot after adding a language, especially for anything short and
// buttonlike that sits next to fixed-width siblings.
export default {
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
  wipeReloadBtn: 'Clear Data & Reload',
  wipeReloadHint: 'Wipes everything stored on this device (settings, swipes, cached app) and loads the latest version fresh.',
  wipeReloadConfirm: 'Clear all data stored on this device (including your settings and swipes) and reload the latest version?',

  loadingAriaLabel: 'Loading',
  daySelectorAriaLabel: 'Select date',
  sportFilterAriaLabel: 'Filter by sport',
  appTagline: 'What\'s worth watching tonight',
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
  finalOrder: 'Final Order',

  homeShort: 'H',
  awayShort: 'A',
  commaSeparator: ', ',
  winProbAriaWithDraw: 'Win probability: {away} {awayPct}%, Draw {drawPct}%, {home} {homePct}%',
  winProbAria: 'Win probability: {away} {awayPct}%, {home} {homePct}%',
  oddsSourceSportsbook: 'Sportsbook',
  oddsSourceAria: ' ({source})',
  titleOdds: 'Title Odds',
  poleOdds: 'Pole Position Odds',
  playoffsLabel: 'Playoffs',
  playInLabel: 'Play-In',
  seriesTied: 'Series tied {score}',
  seriesLeads: '{team} leads series {score}',
  seriesWon: '{team} wins series {score}',
  playoffDecider: 'Winner-take-all',
  playoffElimination: '{team} faces elimination',
  outrightAria: '{label}: {items}',
  recommendedTag: 'Recommended',
  preferredTag: 'Preferred',
  preferMatchBtn: 'Set as Preferred',
  overlapGeneric: 'overlapping time',
  overlapMinutes: '{mins} min overlap',
  overlapHours: '{hours}h overlap',
  overlapHoursMinutes: '{hours}h {mins}m overlap',
  conflictNote: 'Overlaps with "{name}" — {clause}',

  matchStackHint: '⟷ Same time slot — tap to switch',
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
  updatingNow: 'Updating…',
  quadraHeading: 'Quadra Pass',
  quadraHint: 'Enter your Quadra Pass: matches you pin in Quadra Sportsbook join your schedule and picks.',
  quadraLink: 'Link',
  quadraLinked: 'Linked: {n} matches pinned in Quadra Sportsbook.',
  quadraNotLinked: 'Not linked (a Quadra Pass made in any Quadra app works).',
  quadraBadPass: 'A Quadra Pass is 10 letters or digits.',
  quadraPassNotFound: 'No account has this Quadra Pass.',
  quadraPassFailed: 'Couldn\'t read the Quadra Pass just now; trying again later.',
  quadraOddsLabel: 'Quadra Sportsbook',
  quadraDraw: 'Draw',
  quadraNoOdds: 'No odds yet',
  quadraBet: 'Bet →'
};
