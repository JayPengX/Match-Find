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
// Nothing here ever calls Gemini or the proxy Worker; this only ever
// reorders/filters/formats numbers and text that are already sitting in
// matches.json.
//
// UI copy is Traditional Chinese throughout; team names, venues, and the
// AI's reasoning stay bilingual (see buildTeamRow/renderVenue) since an
// English team/venue name is often the more recognizable half for a fixture
// nobody has a settled Chinese name for yet.

const state = {
  rawMatches: [], // the last fetched payload's matches with a real time, untouched - kept so a priority change can re-run resolveViewingPlan without re-fetching
  tbdMatches: [], // fixtures ESPN has on the schedule but hasn't set a kickoff time for yet - see applyMatchData
  matches: [], // every fetched (non-TBD) match, mutated in place with .recommended/.overlapsWithPrevious/.overlappingIds
  days: [], // [{key: 'YYYY-MM-DD', date: Date}, ...] - every calendar day the fetched window covers
  visibleDayCount: 7,
  selectedDayKey: null,
  activeSport: 'all',
  priorityOrder: [] // sports ranked best-to-least - see "Sport priority settings" below
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
// `whereToWatchTw` (see Orbit's /match-recommend) is free-form text written
// by Gemini, not a fixed enum - this registry is what turns that text back
// into something the UI can badge/color/reason about consistently, and
// what OWNED (see MY_SERVICE_IDS below) means at all. Adding a new service
// later is just one more entry here (id, matching pattern, badge/color) -
// nothing else in this file needs to change, same reasoning as
// SPORT_LABELS_ZH above for sports.
//
// `badge` is a short plain-text mark, not a reproduction of the real
// trademarked logo (this is a static site with no image-licensing story of
// its own) - just enough to be visually recognizable and color-coded at a
// glance, same spirit as the sport badges already on every card.
// `logo` points at each service's real, official mark - hosted on
// Wikimedia Commons (Special:FilePath, its own stable hotlink-friendly
// redirect to the current file - confirmed live, not just assumed) rather
// than reproduced/copied into this repo, same posture as the team/F1 logos
// already pulled from ESPN's own CDN elsewhere in this file. `logoBg` is
// the background the mark needs to actually be visible (several of these
// are white- or dark-only artwork with no built-in backdrop). A service
// with no real logo found on Commons (緯來, myVideo, MLB.TV) falls back to
// the plain colored-initial `badge` design from before - buildMatchCard
// below tries `logo` first and only falls back to `badge` on a load
// failure (same onerror pattern as team logos) or when `logo` is absent.
const SERVICES = [
  {
    id: 'elta',
    pattern: /愛爾達|ELTA/i,
    label: '愛爾達體育台',
    badge: '達',
    color: '#ff7a3d',
    logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/ELTA_logo.svg',
    logoBg: '#ffffff'
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
  },
  { id: 'weilai', pattern: /緯來/i, label: '緯來體育台', badge: '緯', color: '#0068b7' },
  {
    id: 'eleven',
    pattern: /ELEVEN\s*SPORTS/i,
    label: 'ELEVEN SPORTS',
    badge: '11',
    color: '#f2394c',
    logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/ELEVEN_SPORTS_Logo.svg',
    logoBg: '#000000'
  },
  {
    id: 'disneyplus',
    pattern: /Disney\+?/i,
    label: 'Disney+',
    badge: 'D+',
    color: '#113ccf',
    logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/Disney%2B_logo.svg',
    logoBg: '#ffffff'
  },
  { id: 'myvideo', pattern: /myVideo/i, label: 'myVideo', badge: 'MV', color: '#ff6600' },
  { id: 'mlbtv', pattern: /MLB\.?TV/i, label: 'MLB.TV', badge: 'MLB', color: '#041e42' }
];
// Which of the above the site owner actually subscribes to right now -
// used only as a tie-breaking nudge in resolveViewingPlan (a match on a
// service you don't have is still shown and can still be recommended, see
// OWNED_SERVICE_SCORE_BONUS below) and as a small "你有訂閱" mark in the UI.
// Plain data, not a setting - unlike sport priority, this isn't something
// worth exposing per-viewer since this is a personal site with one real
// owner; change this array directly if that ever stops being true.
const MY_SERVICE_IDS = new Set(['elta', 'appletv', 'netflix']);

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
const updateBanner = document.getElementById('update-banner');
const updateReloadBtn = document.getElementById('update-reload-btn');
updateReloadBtn.addEventListener('click', () => location.reload());

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
const SETTINGS_STORAGE_KEY = 'matchfind-sport-priority-order';
// Every rank step adds/subtracts one of these - small next to the 1-10
// score scale (being ranked a couple of spots higher does NOT let a
// mediocre match beat a genuinely great one), but large enough to reliably
// swing a close call between two roughly-comparable fixtures, which is the
// only case this is meant to affect.
const PRIORITY_SCORE_DELTA = 1;
// A small nudge (see resolveViewingPlan) toward a fixture shown on a
// service in MY_SERVICE_IDS - "optimize for the services you actually
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

function recomputeAndRender() {
  if (!state.rawMatches.length) return;
  state.matches = resolveViewingPlan(state.rawMatches, state.priorityOrder);
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
        savePriorityOrder(state.priorityOrder);
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
  savePriorityOrder(state.priorityOrder);
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
//   asked to be told a 3am fixture is unmissable. It still shows up in the
//   full "all matches" list further down, just never pinned as a pick.
// - OVERLAP_TOLERANCE_BASE_MINUTES absorbs the fact that durationMinutes is
//   only ever a per-sport AVERAGE broadcast length, not this match's real
//   one - without it, a match that overruns its sport's average by even a
//   few minutes would look like a "conflict" with whatever's lined up next.
// - OVERLAP_TOLERANCE_HIGH_SCORE_MINUTES is deliberately much larger, and
//   only kicks in when either match involved scores highly: a must-watch
//   fixture is allowed to eat into the next slot a bit rather than being
//   dropped, or bumping its neighbor, over a genuinely minor overlap.
//
// This is a good, cheap heuristic for a day's viewing plan, not a
// certified globally-optimal schedule - with arbitrary (non-monotonic)
// compatibility between matches, "pick the best plan" in general is the
// maximum-weight independent set problem, which is NP-hard. At the scale
// this ever runs at (a couple hundred fixtures across the fetched window),
// checking every pair directly is both fast enough and good enough.
const QUIET_HOUR_START = 0;
const QUIET_HOUR_END = 7;
const OVERLAP_TOLERANCE_BASE_MINUTES = 10;
const OVERLAP_TOLERANCE_HIGH_SCORE_MINUTES = 40;
const HIGH_SCORE_THRESHOLD = 8;
// The bar a sport's best still-unpicked fixture has to clear to get a
// diversity-floor slot for the day (see the pass right after the DP in
// resolveViewingPlan) - deliberately a real "this is genuinely worth
// watching" score, not just "the best of a bad day" for that sport.
const DIVERSITY_MIN_SCORE = 6.5;
// How good an overlapping-but-not-picked fixture has to be to join a
// recommended match's swipeable stack (see the pass after the DP in
// resolveViewingPlan) - lower than DIVERSITY_MIN_SCORE on purpose, since
// browsing a stack is opt-in (a swipe), not something forced in front of
// everyone by default.
const STACK_MIN_SCORE = 5;
// Caps how many alternatives one stack can hold - a "swipe to see what
// else was on" gesture stops being quick past a handful of cards.
const STACK_MAX_ALTERNATIVES = 3;

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

function compatible(later, earlier) {
  const toleranceMinutes =
    Math.max(later.effectiveScore, earlier.effectiveScore) >= HIGH_SCORE_THRESHOLD
      ? OVERLAP_TOLERANCE_HIGH_SCORE_MINUTES
      : OVERLAP_TOLERANCE_BASE_MINUTES;
  const gapMinutes = (later.interval.start - earlier.interval.end) / 60_000;
  return gapMinutes >= -toleranceMinutes;
}

// Runs once, across every fetched match regardless of day, right after
// matches.json loads (and again, cheaply, whenever the viewer changes a
// sport priority in Settings - see recomputeAndRender) - not per day tab,
// so a plan spanning a day boundary (e.g. an 11pm match still running past
// midnight) is considered as a whole rather than getting artificially cut
// at each day's edge.
//
// `priorityOrder` (see "Sport priority settings" above) nudges
// effectiveScore away from the AI's own score - the displayed reason/.score
// always stay the true, un-nudged values; only the DP's notion of "which
// match wins this slot" sees the adjusted number, so a viewer's preference
// can tip a close call without pretending a mediocre match is actually
// great. A sport ranked 1st gets the biggest positive nudge, the sport
// ranked in the exact middle gets none, and the last-ranked sport gets the
// biggest negative one - symmetric around the middle rank so "no
// preference at all" (the default order) really does mean zero nudge for
// everyone, not just for whichever sport happens to be first in the array.
function resolveViewingPlan(matches, priorityOrder = []) {
  const centerRank = (priorityOrder.length - 1) / 2;
  const withIntervals = matches.map(match => {
    const rank = priorityOrder.indexOf(match.sport);
    const priorityNudge = rank === -1 ? 0 : (centerRank - rank) * PRIORITY_SCORE_DELTA;
    const service = resolveService(match.whereToWatchTw);
    const serviceNudge = service && MY_SERVICE_IDS.has(service.id) ? OWNED_SERVICE_SCORE_BONUS : 0;
    return { ...match, interval: matchInterval(match), effectiveScore: match.score + priorityNudge + serviceNudge };
  });
  const eligible = withIntervals.filter(m => !isQuietHours(m)).sort((a, b) => a.interval.end - b.interval.end);

  const dp = new Array(eligible.length).fill(0);
  const predecessor = new Array(eligible.length).fill(-1);
  const best = new Array(eligible.length).fill(0);

  for (let i = 0; i < eligible.length; i++) {
    let bestPredScore = 0;
    let bestPredIndex = -1;
    for (let j = 0; j < i; j++) {
      if (compatible(eligible[i], eligible[j]) && best[j] > bestPredScore) {
        bestPredScore = best[j];
        bestPredIndex = j;
      }
    }
    dp[i] = eligible[i].effectiveScore + bestPredScore;
    predecessor[i] = bestPredIndex;
    best[i] = Math.max(i > 0 ? best[i - 1] : 0, dp[i]);
  }

  const selected = new Set();
  let cursor = eligible.length - 1;
  let target = eligible.length ? best[eligible.length - 1] : 0;
  while (cursor >= 0) {
    if (cursor > 0 && best[cursor - 1] === target) {
      cursor -= 1;
      continue;
    }
    selected.add(eligible[cursor].id);
    target = dp[cursor] - eligible[cursor].effectiveScore;
    cursor = predecessor[cursor];
  }

  withIntervals.forEach(match => {
    match.recommended = selected.has(match.id);
  });
  withIntervals.forEach(match => {
    match.overlappingIds = withIntervals
      .filter(other => other.id !== match.id && overlapMinutes(match, other) > 0)
      .map(other => other.id);
  });

  // Diversity floor: the DP above picks the single highest-scoring option
  // per slot, which is correct on its own terms, but a high-VOLUME sport
  // (MLB fielding ~15 games most evenings) can end up winning nearly every
  // slot on pure density alone - not because it's ranked higher, but
  // because there's almost always SOME MLB game overlapping any given
  // window, where a one-game-a-day sport only gets to compete for the one
  // slot its single fixture happens to fall in. Left alone, that can mean
  // a perfectly good MLS game never gets picked on a day it never
  // genuinely lost a head-to-head comparison - it just never got a turn.
  // This doesn't touch the DP's own math or override a real priority
  // ranking - it only looks at what's LEFT OUT after the DP has run, and,
  // once per calendar day, gives a sport with zero picks that day its
  // single best-scoring eligible fixture anyway, but only if that fixture
  // clears DIVERSITY_MIN_SCORE (a real "this is a good match" bar, not
  // "the least bad option this sport had"). A sport that already won a
  // slot today - including one boosted here on an earlier iteration of
  // this same loop - is left alone.
  const diversityByDay = new Map();
  eligible.forEach(match => {
    const dayKey = localDateKey(new Date(match.interval.start));
    if (!diversityByDay.has(dayKey)) diversityByDay.set(dayKey, []);
    diversityByDay.get(dayKey).push(match);
  });
  for (const dayMatches of diversityByDay.values()) {
    const sportsToday = new Set(dayMatches.map(m => m.sport));
    for (const sport of sportsToday) {
      const sportMatches = dayMatches.filter(m => m.sport === sport);
      if (sportMatches.some(m => m.recommended)) continue;
      const best = sportMatches
        .filter(m => m.score >= DIVERSITY_MIN_SCORE)
        .sort((a, b) => b.score - a.score)[0];
      if (best) {
        best.recommended = true;
        best.isDiversityPick = true;
      }
    }
  }

  const recommendedSorted = withIntervals.filter(m => m.recommended).sort((a, b) => a.interval.start - b.interval.start);
  for (let i = 1; i < recommendedSorted.length; i++) {
    const minutes = overlapMinutes(recommendedSorted[i], recommendedSorted[i - 1]);
    if (minutes > 0) {
      recommendedSorted[i].overlapsWithPrevious = { id: recommendedSorted[i - 1].id, minutes: Math.round(minutes) };
    }
  }

  // Attaches a small set of overlapping-but-not-picked fixtures to each
  // recommended match, for the swipeable card stack (see
  // renderRecommendedSection) - unlike the always-expanded "show both at
  // once" layout this replaced, browsing alternatives here is opt-in (a
  // swipe), so this can afford to be more generous about what counts as
  // worth surfacing than a forced side-by-side display could: any
  // overlapping fixture that's still a genuinely decent watch
  // (STACK_MIN_SCORE), not only a near-exact tie. Each alternative is
  // claimed by at most one recommended match (whichever it overlaps that's
  // processed first, in chronological order) so it never appears in two
  // different stacks at once.
  const claimedStackIds = new Set();
  recommendedSorted.forEach(rec => {
    const alternativeIds = rec.overlappingIds
      .filter(id => {
        if (claimedStackIds.has(id)) return false;
        const other = withIntervals.find(m => m.id === id);
        return other && !other.recommended && other.score >= STACK_MIN_SCORE;
      })
      .sort((a, b) => {
        const scoreOf = id => withIntervals.find(m => m.id === id).score;
        return scoreOf(b) - scoreOf(a);
      })
      .slice(0, STACK_MAX_ALTERNATIVES);
    alternativeIds.forEach(id => claimedStackIds.add(id));
    if (alternativeIds.length) rec.stackAlternativeIds = alternativeIds;
  });

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
    node.querySelector('.match-time-relative').textContent = relativeLabel(start, end);
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
    // anything without it - see MY_SERVICE_IDS's own comment on why this
    // stays a nudge, not a filter.
    watchEl.querySelector('.watch-owned').hidden = !(service && MY_SERVICE_IDS.has(service.id));
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

  // Three cases, deliberately not layered on top of each other:
  //   1. Recommended, and it only made the cut by eating into the
  //      previous pick's slot a little - say so, framed as a deliberate
  //      trade-off.
  //   2. Rendered as a card inside another match's swipeable stack (see
  //      renderRecommendedSection/buildMatchStack) - shown at full
  //      strength, no muting, since being offered as a swipe-to option is
  //      already the point; the plain "所有賽事" listing further down
  //      still mutes this same fixture on its own, unstacked card.
  //   3. Genuinely lost its slot with nothing surfacing it as an
  //      alternative anywhere - muted, with a note pointing at what's
  //      recommended instead.
  const conflictNote = node.querySelector('.conflict-note');
  if (match.recommended && match.overlapsWithPrevious) {
    const previous = state.matches.find(m => m.id === match.overlapsWithPrevious.id);
    conflictNote.hidden = false;
    conflictNote.classList.add('is-allowed-overlap');
    conflictNote.textContent = `與「${previous ? previous.name : '前一場推薦賽事'}」重疊約 ${match.overlapsWithPrevious.minutes} 分鐘——因賽事精彩仍納入推薦。`;
  } else if (isStackAlternative) {
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
  if (!match.timeTbd && now >= start && now < end) node.classList.add('is-live');

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
  const pinIndex = sortedMatches.findIndex(m => Date.parse(m.startTimeUtc) + m.durationMinutes * 60_000 > now);
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

function renderDayLabels() {
  const day = state.days.find(d => d.key === state.selectedDayKey);
  const label = day ? dayLabelFor(day.date) : '';
  dayLabelEls.forEach(el => { el.textContent = label; });
}

function renderDayScroller() {
  const visibleDays = state.days.slice(0, state.visibleDayCount);
  const nodes = visibleDays.map(day => {
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

  if (state.visibleDayCount < state.days.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'day-pill day-pill-more';
    more.textContent = `還有 ${state.days.length - state.visibleDayCount} 天 ＋`;
    more.addEventListener('click', () => {
      state.visibleDayCount = state.days.length;
      renderDayScroller();
    });
    nodes.push(more);
  }

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
  state.rawMatches = rawMatches;
  state.matches = resolveViewingPlan(rawMatches, state.priorityOrder);
  state.days = buildDayList(state.matches);
  // Keep whatever day the viewer is already looking at if it still exists
  // in the refreshed window (a routine data refresh shouldn't yank someone
  // back to "today" out from under them) - only fall back to picking a
  // fresh default when their previous selection no longer has a match at
  // all (e.g. it aged out of the rolling window).
  if (!state.selectedDayKey || !state.days.some(d => d.key === state.selectedDayKey)) {
    state.selectedDayKey = pickInitialDay(state.days, state.matches);
  }

  const selectedIndex = state.days.findIndex(d => d.key === state.selectedDayKey);
  if (selectedIndex >= state.visibleDayCount) state.visibleDayCount = selectedIndex + 1;

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
//     code. Surface a small, dismissable-by-ignoring banner instead of
//     silently reloading out from under someone mid-scroll or mid-tap.
async function pollForUpdates() {
  try {
    const response = await fetch('./data/matches.json', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (data.generatedAt === state.generatedAt) return; // nothing new
    state.generatedAt = data.generatedAt;

    applyMatchData(data);

    if (state.buildId && data.buildId && data.buildId !== state.buildId) {
      updateBanner.hidden = false;
    }
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

    setInterval(() => renderSections(), 60_000);
    setInterval(pollForUpdates, DATA_POLL_INTERVAL_MS);
  } catch (error) {
    console.error(error);
    errorState.hidden = false;
  }
}

init();
