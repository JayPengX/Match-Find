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
  matches: [], // every fetched match, mutated in place with .recommended/.overlapsWithPrevious/.overlappingIds
  days: [], // [{key: 'YYYY-MM-DD', date: Date}, ...] - every calendar day the fetched window covers
  visibleDayCount: 7,
  selectedDayKey: null,
  activeSport: 'all'
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
const cardTemplate = document.getElementById('match-card-template');
const teamRowTemplate = document.getElementById('team-row-template');
const updateBanner = document.getElementById('update-banner');
const updateReloadBtn = document.getElementById('update-reload-btn');
updateReloadBtn.addEventListener('click', () => location.reload());

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
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return mins ? `${hours} 小時 ${mins} 分後` : `${hours} 小時後`;
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
    Math.max(later.competitiveness + later.watchability, earlier.competitiveness + earlier.watchability) / 2 >=
    HIGH_SCORE_THRESHOLD
      ? OVERLAP_TOLERANCE_HIGH_SCORE_MINUTES
      : OVERLAP_TOLERANCE_BASE_MINUTES;
  const gapMinutes = (later.interval.start - earlier.interval.end) / 60_000;
  return gapMinutes >= -toleranceMinutes;
}

// Runs once, across every fetched match regardless of day, right after
// matches.json loads - not per day tab, so a plan spanning a day boundary
// (e.g. an 11pm match still running past midnight) is considered as a
// whole rather than getting artificially cut at each day's edge.
function resolveViewingPlan(matches) {
  const withIntervals = matches.map(match => ({ ...match, interval: matchInterval(match) }));
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
    dp[i] = eligible[i].score + bestPredScore;
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
    target = dp[cursor] - eligible[cursor].score;
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

  const recommendedSorted = withIntervals.filter(m => m.recommended).sort((a, b) => a.interval.start - b.interval.start);
  for (let i = 1; i < recommendedSorted.length; i++) {
    const minutes = overlapMinutes(recommendedSorted[i], recommendedSorted[i - 1]);
    if (minutes > 0) {
      recommendedSorted[i].overlapsWithPrevious = { id: recommendedSorted[i - 1].id, minutes: Math.round(minutes) };
    }
  }

  return withIntervals.map(({ interval, ...match }) => match);
}

// ---- Rendering ------------------------------------------------------------

function fillMeter(el, value) {
  el.style.width = `${Math.max(0, Math.min(10, value)) * 10}%`;
}

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

  node.querySelector('.match-time-value').textContent = localTimeFormatter().format(new Date(start));
  node.querySelector('.match-time-relative').textContent = relativeLabel(start, end);

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
  }

  const recommendedTag = node.querySelector('.recommended-tag');
  if (match.recommended) recommendedTag.hidden = false;

  fillMeter(node.querySelector('.competitiveness-fill'), match.competitiveness);
  fillMeter(node.querySelector('.watchability-fill'), match.watchability);

  const reasonEl = node.querySelector('.match-reason');
  reasonEl.textContent = match.reason || '';
  if (match.source === 'heuristic') reasonEl.classList.add('is-heuristic');

  const conflictNote = node.querySelector('.conflict-note');
  if (match.recommended && match.overlapsWithPrevious) {
    const previous = state.matches.find(m => m.id === match.overlapsWithPrevious.id);
    conflictNote.hidden = false;
    conflictNote.classList.add('is-allowed-overlap');
    conflictNote.textContent = `與「${previous ? previous.name : '前一場推薦賽事'}」重疊約 ${match.overlapsWithPrevious.minutes} 分鐘——因賽事精彩仍納入推薦。`;
  } else if (!match.recommended && (match.overlappingIds || []).length) {
    const others = state.matches.filter(m => match.overlappingIds.includes(m.id) && m.recommended);
    if (others.length) {
      conflictNote.hidden = false;
      conflictNote.textContent = `與「${others.map(m => m.name).join('、')}」時間重疊——該時段推薦的是這一場。`;
    }
    node.classList.add('is-muted');
  }
  if (match.recommended) node.classList.add('is-recommended');

  const now = Date.now();
  if (now >= start && now < end) node.classList.add('is-live');

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
  const fragment = document.createDocumentFragment();
  ordered.forEach((match, index) => {
    const card = buildMatchCard(match);
    if (index === 0) card.classList.add('is-pinned');
    fragment.appendChild(card);
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

// Applies a freshly-fetched matches.json payload to the page. Used both by
// the initial load and by pollForUpdates() below, so "how a payload turns
// into what's on screen" only exists in one place.
function applyMatchData(data) {
  const rawMatches = Array.isArray(data.matches) ? data.matches : [];

  if (data.generatedAt) {
    const generated = new Date(data.generatedAt);
    generatedNote.textContent = `資料最後更新於 ${localDayFormatter().format(generated)} ${localTimeFormatter().format(generated)}（你的當地時間）`;
  }

  if (!rawMatches.length) {
    emptyState.hidden = false;
    return;
  }

  state.daysAhead = data.daysAhead;
  state.matches = resolveViewingPlan(rawMatches);
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
