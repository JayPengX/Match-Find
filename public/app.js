// ---- public/app.js ----
// Reads ./data/matches.json (written at build time by scripts/build-data.mjs)
// and renders it. Every time conversion happens here, in the browser, using
// the viewer's own timezone (Intl/Date read straight from the OS) - the
// data file only ever carries UTC timestamps, so this page shows the
// correct local time for whoever is looking at it, wherever they are.

const state = { matches: [], spotlightId: null, activeSport: 'all' };

const clockEl = document.getElementById('local-clock');
const spotlightSection = document.getElementById('spotlight-section');
const spotlightCard = document.getElementById('spotlight-card');
const filtersRow = document.getElementById('sport-filters');
const listEl = document.getElementById('match-list');
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

function updateClock() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  clockEl.textContent = `Your local time: ${localTimeFormatter().format(now)} (${tz})`;
}
updateClock();
setInterval(updateClock, 30_000);

function relativeLabel(startMs) {
  const diffMin = Math.round((startMs - Date.now()) / 60_000);
  if (diffMin <= 0) return 'starting now';
  if (diffMin < 60) return `in ${diffMin} min`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return mins ? `in ${hours}h ${mins}m` : `in ${hours}h`;
}

function dayBucketLabel(date) {
  const today = new Date();
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(date) - startOfDay(today)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return localDayFormatter().format(date);
}

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

function buildMatchCard(match, { compact = false } = {}) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);
  const start = new Date(match.startTimeUtc);

  node.querySelector('.match-time-value').textContent = localTimeFormatter().format(start);
  node.querySelector('.match-time-relative').textContent = relativeLabel(start.getTime());

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

  if (compact) {
    node.querySelector('.match-time').remove();
  }
  return node;
}

function renderSpotlight() {
  const spotlight = state.matches.find(m => m.id === state.spotlightId);
  if (!spotlight) {
    spotlightSection.hidden = true;
    return;
  }
  spotlightSection.hidden = false;
  spotlightCard.replaceChildren(buildMatchCard(spotlight, { compact: true }));
  const timeLine = document.createElement('p');
  timeLine.className = 'match-time-value';
  const start = new Date(spotlight.startTimeUtc);
  timeLine.textContent = `${dayBucketLabel(start)} at ${localTimeFormatter().format(start)} — ${relativeLabel(start.getTime())}`;
  spotlightCard.querySelector('.match-heading').after(timeLine);
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
        renderList();
      });
      return btn;
    })
  );
}

function renderList() {
  const visible = state.matches.filter(m => state.activeSport === 'all' || m.sport === state.activeSport);
  if (!visible.length) {
    listEl.replaceChildren();
    emptyState.hidden = state.matches.length !== 0;
    return;
  }
  emptyState.hidden = true;

  const fragment = document.createDocumentFragment();
  let currentBucket = null;
  for (const match of visible) {
    const start = new Date(match.startTimeUtc);
    const bucket = dayBucketLabel(start);
    if (bucket !== currentBucket) {
      currentBucket = bucket;
      const heading = document.createElement('h3');
      heading.className = 'day-heading';
      heading.textContent = bucket;
      fragment.appendChild(heading);
    }
    fragment.appendChild(buildMatchCard(match));
  }
  listEl.replaceChildren(fragment);
}

async function init() {
  try {
    const response = await fetch('./data/matches.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.matches = Array.isArray(data.matches) ? data.matches : [];
    state.spotlightId = data.spotlightId || null;

    if (data.generatedAt) {
      const generated = new Date(data.generatedAt);
      generatedNote.textContent = `Data last generated ${localDayFormatter().format(generated)}, ${localTimeFormatter().format(generated)} your time.`;
    }

    if (!state.matches.length) {
      emptyState.hidden = false;
      return;
    }

    renderSpotlight();
    renderFilters();
    renderList();
    setInterval(() => {
      renderSpotlight();
      renderList();
    }, 60_000);
  } catch (error) {
    console.error(error);
    errorState.hidden = false;
  }
}

init();
