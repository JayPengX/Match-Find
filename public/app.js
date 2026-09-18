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
// The AI scoring itself (competitiveness/watchability/reason) already
// happened automatically in the background, on a schedule, well before
// this page ever loaded - see build-data.mjs. Nothing here ever calls
// Gemini or the proxy Worker; this only ever reorders/filters numbers that
// are already sitting in matches.json.

const state = {
  matches: [], // every fetched match, mutated in place with .recommended/.overlapsWithPrevious/.overlappingIds
  days: [], // [{key: 'YYYY-MM-DD', date: Date}, ...] - every calendar day the fetched window covers
  visibleDayCount: 7,
  selectedDayKey: null,
  activeSport: 'all'
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

function localTimeFormatter() {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
}
function localDayFormatter() {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
function shortDayFormatter() {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });
}

function updateClock() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  clockEl.textContent = `Your local time: ${localTimeFormatter().format(now)} (${tz})`;
}
updateClock();
setInterval(updateClock, 30_000);

function relativeLabel(startMs, endMs) {
  const now = Date.now();
  if (now >= startMs && now < endMs) return 'live now';
  const diffMin = Math.round((startMs - now) / 60_000);
  if (diffMin <= 0) return 'starting now';
  if (diffMin < 60) return `in ${diffMin} min`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return mins ? `in ${hours}h ${mins}m` : `in ${hours}h`;
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
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
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

  const byId = new Map(withIntervals.map(m => [m.id, m]));
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

function buildTeamRow({ logo, name, nameZh }) {
  const node = teamRowTemplate.content.firstElementChild.cloneNode(true);
  const img = node.querySelector('.team-logo');
  if (logo) {
    img.src = logo;
    img.alt = name;
    img.addEventListener('error', () => { img.hidden = true; }, { once: true });
  } else {
    img.hidden = true;
  }
  node.querySelector('.team-name-en').textContent = name;
  node.querySelector('.team-name-zh').textContent = nameZh || '';
  return node;
}

function buildMatchCard(match) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);
  const start = Date.parse(match.startTimeUtc);
  const end = start + match.durationMinutes * 60_000;

  node.querySelector('.match-time-value').textContent = localTimeFormatter().format(new Date(start));
  node.querySelector('.match-time-relative').textContent = relativeLabel(start, end);

  const badge = node.querySelector('.sport-badge');
  badge.textContent = match.sport;
  badge.dataset.sport = match.sport;

  const teamsEl = node.querySelector('[data-teams]');
  if (match.competitors && match.competitors.length === 2) {
    const [away, home] = match.competitors;
    teamsEl.appendChild(buildTeamRow(away));
    const at = document.createElement('span');
    at.className = 'team-at';
    at.textContent = '@';
    teamsEl.appendChild(at);
    teamsEl.appendChild(buildTeamRow(home));
  } else {
    teamsEl.appendChild(buildTeamRow({ logo: match.logo, name: match.name, nameZh: match.nameZh }));
  }

  node.querySelector('.match-venue').textContent = match.venue || '';

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
    conflictNote.textContent = `Overlaps by about ${match.overlapsWithPrevious.minutes} min with ${previous ? previous.name : 'the previous pick'} — kept in the lineup anyway for its quality.`;
  } else if (!match.recommended && (match.overlappingIds || []).length) {
    const others = state.matches.filter(m => match.overlappingIds.includes(m.id) && m.recommended);
    if (others.length) {
      conflictNote.hidden = false;
      conflictNote.textContent = `Overlaps with ${others.map(m => m.name).join(', ')} — that's the recommended pick for this time slot.`;
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

function matchesForSelectedDay() {
  return state.matches.filter(m => localDateKey(new Date(m.startTimeUtc)) === state.selectedDayKey);
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
    more.textContent = `+${state.days.length - state.visibleDayCount} more`;
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
      btn.textContent = sport === 'all' ? 'All sports' : sport;
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

async function init() {
  try {
    const response = await fetch('./data/matches.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const rawMatches = Array.isArray(data.matches) ? data.matches : [];
    state.daysAhead = data.daysAhead;

    if (data.generatedAt) {
      const generated = new Date(data.generatedAt);
      generatedNote.textContent = `Data last generated ${localDayFormatter().format(generated)}, ${localTimeFormatter().format(generated)} your time.`;
    }

    if (!rawMatches.length) {
      emptyState.hidden = false;
      return;
    }

    state.matches = resolveViewingPlan(rawMatches);
    state.days = buildDayList(state.matches);
    state.selectedDayKey = localDateKey(new Date());
    if (!state.days.some(d => d.key === state.selectedDayKey)) {
      state.selectedDayKey = state.days[0]?.key;
    }

    appEl.hidden = false;
    renderDayScroller();
    renderDayLabels();
    renderFilters();
    renderSections();

    setInterval(() => {
      renderSections();
    }, 60_000);
  } catch (error) {
    console.error(error);
    errorState.hidden = false;
  }
}

init();
