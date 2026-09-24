// ---- public/app.js ----
// Builds and renders the whole match list LIVE, in this browser - calling
// public/lib/match-builder.mjs's own buildMatches directly (through the
// shared proxy, since none of the underlying APIs sends CORS headers - see
// proxyFetchJson below), not by reading a static matches.json a scheduled
// GitHub Action rebuilt and redeployed every 15 minutes the way this used
// to work. That whole build-and-deploy cycle is gone: every viewer's own
// tab now fetches and scores fixtures itself, on load and on two
// recurring refresh tiers (see "Live match data" below) - genuinely live,
// not "as fresh as the last scheduled rebuild happened to be," and a
// manual refresh is now instant (this browser re-fetching and re-scoring
// directly) instead of waiting ~30-60 seconds for a CI build to finish and
// a new static file to deploy.
//
// This file still does everything that has to happen per viewer on top of
// that shared scoring:
//
//   - Converting every UTC kickoff to THIS viewer's own local time.
//   - Deciding which matches form "today's recommended lineup" - this has
//     to run here, not in the shared scoring, because "don't recommend a
//     match starting at 3am" and "which match is closest to right now" are
//     both relative to the viewer's own clock, and buildMatches's own
//     output is the same regardless of which timezone asked for it.
//
// The scoring itself (competitiveness/watchability/reason) is entirely
// deterministic, computed from real sports-data APIs - see
// public/lib/match-builder.mjs's own top comment. There is no AI anywhere
// in this pipeline. `whereToWatchTw` is a hardcoded rule
// (`resolveWhereToWatchTw`, in match-builder.mjs): 愛爾達體育台 for
// everything except an MLB fixture ESPN itself reports as Apple TV. All
// match data comes through the shared proxy's own read-only `/sports-proxy`
// passthrough - used both for building/refreshing the match list (see
// proxyFetchJson) and for live score/odds polling (pollLiveMatches) - plus
// one read of the prebuilt first-screen snapshot from this repo's `data`
// branch (see fetchServerSnapshot). Everything else - sport
// priority, enabled sports, and which swiped match a viewer prefers - is
// local-only, in this browser's own localStorage, with no server-side sync
// of any kind (see README's "Local-only, no accounts").
//
// UI copy goes through ./lib/i18n.mjs's t() (zh-TW by default, English
// auto-detected from the browser - see that module's own top comment); team
// names and venues stay bilingual regardless of UI language (see
// updateTeamRow/renderVenue) since an English team/venue name is often the
// more recognizable half for a fixture nobody has a settled Chinese name
// for yet - that's real sports data, not UI chrome, so it isn't part of the
// i18n layer at all.
//
// The pure scoring/viewing-plan math (overlap/slot/weighted-interval-
// scheduling helpers, computeDayPlan, resolveViewingPlan, confidence, the
// broadcast-service registry) lives in ./lib/recommendation.mjs instead of
// here - extracted so it can be unit-tested directly (see
// tests/recommendation.test.mjs) and reused by public/lib/match-builder.mjs
// (for confidence) without a DOM. The viewer's own local "Prefer" state
// (which swiped match to stick with per slot) is its own further pure
// module, ./lib/preferences.mjs - see that file's own top comment for why
// "match data -> recommendation -> user preference -> UI/card state" are
// kept as four separate layers instead of collapsing into one. This file
// keeps everything DOM/localStorage/render-related, and calls into both
// modules for the rest.
import {
  SERVICES,
  resolveService,
  resolveViewingPlan,
  slotKeyFromMembers,
  groupIntoSlots,
  isQuietHours,
  isUnderway,
  schedulingInterval,
  computeOverlapRange,
  isNearTotalOverlap,
  applyLiveExcitementBonus,
  matchLifecycleState,
  LIFECYCLE_STATES,
  estimatedDurationMinutes,
  estimateLiveDurationMinutes,
  computeDayPlan,
  planStackAlternativeIds,
  computeVarietyRotation,
  mergeVarietyForcedIds,
  clearRotationIsPreferred,
  startedPlanLockIds
} from './lib/recommendation.mjs';
import {
  serializePinnedChoices,
  deserializePinnedChoices,
  pruneStalePinnedChoices,
  applySlotSwipe,
  removePins,
  dayPlanHistoryKey,
  serializeDayPlanHistory,
  deserializeDayPlanHistory,
  recordDayPlan
} from './lib/preferences.mjs';
import {
  TEAM_LEAGUE_ESPN,
  liveScoreboardUrls,
  extractLiveUpdates,
  f1LiveScoreboardUrl,
  extractF1LiveUpdates,
  sizedEspnLogoUrl
} from './lib/espn.mjs';
import { pickReadableTeamColor } from './lib/color.mjs';
import {
  POLYMARKET_TAG_ID,
  fetchAllPolymarketEvents,
  resolveTeamOdds,
  resolveF1WinnerOdds,
  resolvePoleWinnerOdds
} from './lib/polymarket.mjs';
// The one shared fetch+score pipeline - see that module's own top comment
// for why this now runs live, in every viewer's own browser, instead of
// once at build time.
import { mlbStandingsUrl, nbaStandingsUrl, eplStandingsUrl, f1DriverStandingsUrl } from './lib/sport-signals.mjs';
import { buildMatches, enrichWithPolymarketOdds, freezeStartedMatchScoring, PREGAME_SCORING_FIELDS, DEFAULT_DAYS_AHEAD } from './lib/match-builder.mjs';
// UI copy/locale layer - see that module's own top comment. Every piece of
// genuine UI chrome (labels, hints, status text, aria-labels) goes through
// t() rather than a hardcoded literal, so this file itself never has to
// change again to add a third language, only ./lib/i18n.mjs does.
import { t, getLocale, dateFnsLocaleTag } from './lib/i18n.mjs';
import { installTapLog, tapLog } from './lib/tap-log.mjs';

// jaypengx-collab/shared-proxy's dedicated `sports-proxy` Worker - a plain,
// public value, not a secret (a static site's own client bundle can't keep
// anything truly hidden anyway - see that repo's own sports-proxy-worker.js
// comment on /sports-proxy).
//
// A DIFFERENT Worker/URL than the rest of that repo's routes
// (`orbit-workers-proxy`, still used by Orbit Class/Vocab) - not a typo.
// That Worker is region-pinned to Virginia for Gemini's sake, which added a
// transpacific round trip to every request from this app's Taiwan-based
// audience; this separate, unpinned deployment runs near the viewer instead
// (see that repo's README, "Match Find live data").
const PROXY_URL = 'https://sports-proxy.pengzjay.workers.dev';

// Every host buildMatches needs (ESPN, Polymarket, the MLB Stats API,
// Jolpica) sends no CORS headers, so a browser can't fetch any of them
// directly - this is the ONE fetchJson this page ever hands to
// buildMatches, routing every request through the shared proxy's
// /sports-proxy passthrough instead (see that Worker's own
// SPORTS_PROXY_ALLOWED_HOSTS in shared-proxy's sports-proxy-worker.js - it
// only forwards to hosts it already trusts). Same shape as scripts/build-data.mjs's own Node-side fetchJson,
// just reaching these hosts through the proxy instead of directly.
//
// Cached here, per exact upstream URL, for PROXY_FETCH_CACHE_TTL_MS - this
// is what actually made the initial page load slow, especially on a poor
// connection: refreshNearTerm() and refreshFullWindow() both call
// buildMatches() (see "Live match data" below), and full-window's own date
// range is a strict superset of near-term's - so on every single page load,
// full-window re-requested today/tomorrow's own scoreboard URLs AGAIN,
// seconds after near-term had just fetched the exact same ones, doubling
// the real round-trip count the viewer had to wait through before seeing a
// complete picture. A short TTL (comfortably inside NEAR_TERM_REFRESH_MS,
// so the next scheduled near-term tick still gets a genuinely fresh fetch)
// turns that immediate overlap into a single request, cached in-memory (not
// persisted - there's nothing worth keeping once this tab closes). Also
// coalesces truly CONCURRENT calls for the same URL into one in-flight
// request/response, rather than merely a fast-follow cache read, so two
// refresh tiers that happen to fire in the same tick never both hit the
// network for the same thing. pollLiveMatches's own faster, deliberately
// uncached direct fetches (see that function) are NOT routed through this -
// live score/odds polling needs a guaranteed fresh request every tick, not
// a cached one; the shared Worker's own short-TTL edge cache (see
// jaypengx-collab/shared-proxy's sports-proxy-worker.js) is what keeps THAT tier's real
// upstream cost down instead, across every viewer, not just this tab.
const PROXY_FETCH_CACHE_TTL_MS = 45_000;
const proxyFetchCache = new Map(); // url -> { data, expiresAt }
const proxyFetchInFlight = new Map(); // url -> Promise<data>

// Bounds how long any ONE proxied request is allowed to hang before this
// tab gives up on it - a manual "refresh now" fans out 50+ of these in
// parallel (see buildMatches), and without a bound, a single slow/stuck one
// (a cold Worker isolate, a flaky mobile connection, an upstream API having
// a bad moment) can hold up the WHOLE refresh, since most of the batches
// awaiting these are a plain `Promise.all`/`await`, not something that
// moves on the moment enough of them resolve. Live-reported as "updating
// data takes 10-20 seconds, sometimes more, sometimes less" - the
// inconsistency itself is a symptom of exactly this: which one straggler
// happens to be slow varies refresh to refresh. Set a little above the
// shared Worker's own SPORTS_PROXY_UPSTREAM_TIMEOUT_MS (8s, see that
// repo's sports-proxy-worker.js) so a normal Worker-side timeout still gets to finish
// and return its own clean error response first, rather than being raced
// and losing to this timeout on every genuinely slow (not stuck) request.
const PROXY_FETCH_TIMEOUT_MS = 12_000;

// Caps how many proxied requests this tab ever has ACTUALLY in flight to the
// network at once, regardless of how many logical callers are "awaiting" one
// right now - buildMatches' own full-window call alone fires 50+ of these
// (3 leagues x 17 dates, see fetchTeamLeagueMatches) with no concurrency
// limit of its own, all at the exact same instant. That stampede is exactly
// what PROXY_FETCH_TIMEOUT_MS's own comment above already describes: any
// ONE straggler among 50+ simultaneous requests can eat its full timeout,
// and since init() now awaits the WHOLE full-window build before first
// paint (see init()'s own comment), a straggler here no longer just delays
// a quiet background refresh - it directly delays, and can even fail, the
// very first thing the viewer sees. Live-reported directly: "sometimes it
// failed to load also the load time is significantly longer". Gating the
// underlying fetch() calls to a small, fixed number in flight at a time -
// everything past that just queues, FIFO, and gets a slot the instant one
// frees up - keeps every individual request fast and un-contended instead
// of all 50+ competing for the same connection pool/upstream rate limit at
// once; extra requests wait a few hundred ms for a slot rather than each
// one risking the full 12s timeout. Chosen to match the browser's own
// classic HTTP/1.1 per-host connection cap - conservative enough that even
// a connection that can't multiplex (no HTTP/2) never queues at the browser
// level on top of this queue too.
//
// Raised from 6 to 12: the proxy is served over HTTP/2 (workers.dev), so
// these multiplex over one connection rather than competing for the
// browser's per-host HTTP/1.1 pool - and at 6, the ~60-request full window
// ran as ~10 back-to-back waves, which is most of the initial spinner time.
// 12 halves that while still being nowhere near the unbounded 50+ burst
// described above.
const PROXY_FETCH_MAX_CONCURRENCY = 12;
let proxyFetchActiveCount = 0;
const proxyFetchWaitQueue = [];

function acquireProxyFetchSlot() {
  if (proxyFetchActiveCount < PROXY_FETCH_MAX_CONCURRENCY) {
    proxyFetchActiveCount++;
    return Promise.resolve();
  }
  return new Promise(resolve => proxyFetchWaitQueue.push(resolve));
}

function releaseProxyFetchSlot() {
  const next = proxyFetchWaitQueue.shift();
  // Handing the freed slot straight to the next waiter (rather than
  // decrementing and letting some later acquire() re-increment) keeps
  // proxyFetchActiveCount an accurate live count of in-flight requests at
  // every instant, never briefly wrong between a release and the next
  // acquire.
  if (next) next();
  else proxyFetchActiveCount--;
}

// `trim` asks the proxy for a reduced response (see
// polymarketFetchJson below) - part of the cache key, since a trimmed and
// a full body for the same upstream URL aren't interchangeable.
function sportsProxyRequestUrl(url, trim) {
  return `${state.proxyUrl}/sports-proxy?url=${encodeURIComponent(url)}${trim ? `&trim=${trim}` : ''}`;
}

async function proxyFetchJson(url, { trim = null } = {}) {
  const key = trim ? `${trim}|${url}` : url;
  const cached = proxyFetchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const pending = proxyFetchInFlight.get(key);
  if (pending) return pending;
  const request = (async () => {
    await acquireProxyFetchSlot();
    let response;
    try {
      response = await fetch(sportsProxyRequestUrl(url, trim), {
        cache: 'no-store',
        signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS)
      });
    } finally {
      releaseProxyFetchSlot();
    }
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    const data = await response.json();
    proxyFetchCache.set(key, { data, expiresAt: Date.now() + PROXY_FETCH_CACHE_TTL_MS });
    warmTeamLogos(url, data);
    return data;
  })();
  proxyFetchInFlight.set(key, request);
  try {
    return await request;
  } finally {
    proxyFetchInFlight.delete(key);
  }
}

// Starts downloading every team crest the moment the scoreboard that names
// it arrives, rather than only once its card is rendered - the rest of the
// window's requests (and the scoring) are still running at that point, so
// by first paint the logos are already in the browser's HTTP cache and
// show up together with the card instead of popping in afterwards. Same
// downsized URL updateTeamRow requests (see sizedEspnLogoUrl), so it's the
// exact same cache entry; each URL is only ever requested once per tab.
//
// The Image objects are KEPT (not dropped once started) and decoded: stacked
// cards are rebuilt from scratch on every render (see buildMatchStack), so
// their logos are brand-new <img> elements each time, and a held, decoded
// copy of the same URL is what lets the browser paint those immediately
// instead of blanking them for a moment. ~80 logos at 64px - about a
// megabyte of decoded pixels at most.
const warmedLogos = new Map(); // downsized src -> decoded Image
function warmLogo(logo) {
  const src = sizedEspnLogoUrl(logo);
  if (!src || warmedLogos.has(src)) return;
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  img.src = src;
  img.decode().catch(() => {});
  warmedLogos.set(src, img);
}
function warmTeamLogos(url, data) {
  if (!url.startsWith('https://site.api.espn.com/') || !Array.isArray(data?.events)) return;
  data.events.forEach(event => {
    (event.competitions?.[0]?.competitors || []).forEach(competitor => warmLogo(competitor.team?.logo));
  });
}

// The same proxy passthrough as proxyFetchJson above, but deliberately
// UNCACHED (see PROXY_FETCH_CACHE_TTL_MS's own comment on why
// pollLiveMatches needs a guaranteed-fresh request every tick) - used only
// for fetchAllPolymarketEvents's own pagination below, where each page
// genuinely is a different URL anyway (a different `offset`) but still
// shouldn't be served from a stale cache entry left over from an earlier
// poll tick.
async function proxyFetchJsonUncached(url, { trim = null } = {}) {
  const response = await fetch(sportsProxyRequestUrl(url, trim), {
    cache: 'no-store',
    signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

// Polymarket's /events pages are enormous - one 100-event MLB page was
// live-measured at 11.5MB (~1MB gzipped), and MLB needs 3-4 of them -
// almost all of it market metadata ./lib/polymarket.mjs never reads. The
// proxy can strip each page down to just the fields that module uses
// (~0.45MB, see shared-proxy's sports-proxy-worker.js,
// trimPolymarketEvents), which is what lets odds land with the first paint
// instead of trickling in seconds later (and keeps the 30s live-odds poll
// from re-downloading megabytes every tick). If the trimmed request fails
// for any reason (e.g. an older proxy deploy, or that Worker-side parse
// failing), this falls back to the plain full passthrough, so odds are
// never lost to it - only slower.
const POLYMARKET_TRIM = 'polymarket-events';
async function polymarketFetchJson(url) {
  try {
    return await proxyFetchJson(url, { trim: POLYMARKET_TRIM });
  } catch (error) {
    console.warn('trimmed Polymarket fetch failed, retrying untrimmed', error);
    return proxyFetchJson(url);
  }
}
async function polymarketFetchJsonUncached(url) {
  try {
    return await proxyFetchJsonUncached(url, { trim: POLYMARKET_TRIM });
  } catch (error) {
    console.warn('trimmed Polymarket fetch failed, retrying untrimmed', error);
    return proxyFetchJsonUncached(url);
  }
}

// `deploy.yml`'s own cache-busting step (see index.html's own `?v=` query
// string) rewrites this literal placeholder to that build's real commit
// sha on every real deploy - stays the literal placeholder locally/in a
// dev checkout (that sed step only ever runs in the GitHub Actions
// runner's own working copy, never committed back to git). Declared here,
// at the very top of the file, specifically so the wipe below can run
// before ANY other persisted state loads - every `state.x = loadX()`
// assignment further down in this file runs AFTER this point.
const APP_BUILD_ID = '__BUILD_ID__';

// Direct instruction: wipe every bit of this browser's own saved state
// (settings, pins, live-sticky ids, the pre-game scoring cache, the day
// plan history, the cached match snapshot - all of it) the moment a new
// deploy ships, not a hand-picked subset. Before this, only two of those
// (`matchfind-day-plan-history`/`matchfind-match-snapshot`) were tagged
// with APP_BUILD_ID and thrown away on mismatch; the rest (including
// `matchfind-pregame-scoring`, whose whole purpose is to freeze an
// already-started fixture's score so it doesn't get silently re-scored -
// see freezeStartedMatchScoring) deliberately survived an update, so a
// scoring/behavior change this app shipped could keep being overridden by
// a value computed under the OLD formula for however long that particular
// fixture stayed frozen. A single blanket wipe, keyed off this one build
// id, replaces that whole per-key "does this survive an update" judgment
// call with one answer: no persisted state ever outlives the deploy that
// wrote it. Everything a fresh load rebuilds from scratch (the live fetch
// itself, and public/lib/recommendation.mjs's own whole-window
// computeDayPlan/computeVarietyRotation, which already plan every day -
// including one already partly or fully finished - from THIS load's own
// complete, freshly-fetched data, never from a a stale local cache) is
// exactly what keeps a day's schedule from breaking after an update, so
// losing the old cross-update caches costs nothing real: the schedule is
// only ever unstable mid-day WITHIN one deploy if the underlying data
// itself changes meaning (a game finishing changes its own recorded
// score) - which pregameScoring/dayPlanHistory's own locking still guards
// against for the rest of that SAME day, same as before; only the
// cross-deploy survival is gone. Runs unconditionally at module load,
// before the `state` object below even exists, so nothing anywhere in
// this file needs its own reasoning about which deploy wrote what it just
// read back out of localStorage.
(function wipeStorageOnNewBuild() {
  try {
    if (localStorage.getItem('matchfind-app-build-id') === APP_BUILD_ID) return;
    Object.keys(localStorage)
      .filter(key => key.startsWith('matchfind-'))
      .forEach(key => localStorage.removeItem(key));
    localStorage.setItem('matchfind-app-build-id', APP_BUILD_ID);
  } catch {
    // Private browsing / blocked storage - every load below already
    // tolerates missing/unreadable storage on its own, so there's simply
    // nothing to wipe or mark here.
  }
})();

const state = {
  allRawMatches: [], // every fetched, non-TBD match regardless of enabled sports - see applyEnabledSportsAndRender
  rawMatches: [], // allRawMatches filtered to enabled sports, untouched otherwise - kept so a priority/service change can re-run resolveViewingPlan without re-fetching
  tbdMatches: [], // fixtures ESPN has on the schedule but hasn't set a kickoff time for yet - see applyFreshBuild
  matches: [], // every fetched (non-TBD), enabled-sport match, mutated in place with .recommended/.overlappingIds
  days: [], // [{key: 'YYYY-MM-DD', date: Date}, ...] - every calendar day the fetched window covers
  selectedDayKey: null,
  // False from the moment the page opens until the full DEFAULT_DAYS_AHEAD
  // window has landed at least once (see refreshFullWindow) - lets
  // visibleDays()/renderRecommendedSection tell "this far-future day
  // genuinely has nothing on" apart from "this far-future day simply
  // hasn't been fetched yet", which look IDENTICAL from state.matches'
  // own point of view (zero matches either way) without this flag. See
  // this flag's own call sites for why that distinction is the whole
  // point.
  fullWindowLoaded: false,
  // Same idea as fullWindowLoaded, one tier down - set once refreshNearTerm
  // (today/tomorrow) has resolved at least once. Covers the one case the
  // fallback in isDayPending (real data already sitting in
  // state.allRawMatches for this exact day) can't: a day that turns out
  // to be GENUINELY empty - a real off day, no games at all - looks
  // identical to "not fetched yet" from state.allRawMatches alone (zero
  // matches either way), so without this flag today would show a stuck
  // "still loading" on a quiet sports day even though near-term already
  // gave an authoritative, empty answer for it.
  nearTermLoaded: false,
  activeSport: 'all',
  priorityOrder: [], // sports ranked best-to-least - see "Sport priority settings" below
  enabledSports: [], // sports to show at all - see "Enabled sports settings" below
  myServiceIds: [], // subscribed services - see "Broadcast service registry" below
  // Map<dayKey, Set<matchId>> - the flat set of matches the viewer
  // explicitly swiped to commit to watching, per day - see
  // computeDayPlan/pinSlotChoice, and ./lib/preferences.mjs for the actual
  // set-or-clear decision and serialization shape. Keyed by the PINNED
  // MATCH'S OWN id, not by a hash of whichever multi-match "slot" (see
  // isNearTotalOverlap) it happened to belong to at pin time - a slot's own
  // shape can change (a live duration correction, a routine data refresh, a
  // sport filter narrowing which candidates exist) in a way a match's own
  // id never does, and keying storage by the former used to silently
  // orphan a real pin the moment its slot's shape shifted, which read as
  // "reloading the page wipes my preference back to 推薦" - see
  // preferences.mjs's own comment on applySlotSwipe. Local-only (see this
  // file's own top comment) - persisted to localStorage so a viewer who
  // swiped past this morning's default pick still sees that choice as
  // 偏好, not reverted back to 推薦, next time they open the page. Old
  // days' entries get pruned (see prunePinnedChoices) rather than kept
  // forever, since a day that's aged out of the fetched window can never be
  // looked up again anyway.
  //
  // Starts empty here, deliberately - the REAL load (state.pinnedChoices =
  // loadPinnedChoices()) happens as a separate statement further down,
  // same pattern as state.priorityOrder below. loadPinnedChoices() reads
  // PINNED_CHOICES_STORAGE_KEY, a `const` declared much later in this file
  // (module top-level code runs top-to-bottom) - calling it HERE, still
  // inside this very literal, hit that binding while it was still in the
  // temporal dead zone, threw a caught-and-swallowed ReferenceError, and
  // silently discarded every pin on every single page load. Live-reported
  // as "swiping to a preference doesn't survive a reload" - the pin was
  // sitting untouched in localStorage the whole time (savePinnedChoices
  // still worked fine mid-session), just never read back on the load path.
  pinnedChoices: new Map(),
  // Map<dayKey, Map<slotKey, Array<Set<matchId>>>> - which members a swipeable
  // card stack actually shows, frozen the first time each day+slot renders
  // - see renderRecommendedSection's own comment for why this exists:
  // computeDayPlan's alternativeIds is recomputed per CHOICE, and a big
  // real-world conflict cluster's members don't all have the same direct-
  // overlap neighborhood, so swiping to a new primary without this could
  // hand back a bigger/different member list than the one just shown,
  // reading as the stack growing or reshuffling under the viewer's finger
  // mid-swipe. In-memory only, never persisted - cleared in applyFreshBuild
  // whenever genuinely fresh match data arrives (a fetch/poll can add,
  // remove, or reschedule fixtures, so last render's snapshot is no longer
  // trustworthy), never by a pin's own render.
  stackMembershipByDay: new Map(),
  // Every match id shown in the selected day's 推薦賽事 section (stack
  // primaries AND their alternates) as of its last render - see
  // renderAllMatchesSection's is-muted rule.
  featuredIds: new Set()
};

// Sport labels as ESPN/match-builder.mjs spell them internally (see
// TEAM_LEAGUES in that script) stay the stable data key and CSS hook
// (data-sport="Premier League" etc.) - only the on-screen label goes
// through i18n.mjs's t(), so the underlying data model never has to change
// just because the display language does (nor does adding a display
// language ever need to touch this map - only ./lib/i18n.mjs's STRINGS).
// MLB/NBA/F1 stay as their English initialisms in zh-TW too - that's how
// Taiwanese sports media normally writes them, even in otherwise-Chinese
// text; only the Premier League has a standard, universally-used Chinese
// short name (see STRINGS['zh-TW'].sportPremierLeague).
const SPORT_LABEL_KEYS = {
  'Premier League': 'sportPremierLeague',
  MLB: 'sportMLB',
  NBA: 'sportNBA',
  F1: 'sportF1'
};

function sportLabel(sport) {
  return t(SPORT_LABEL_KEYS[sport]) || sport;
}

// Each league/sanctioning body's own real, official mark, hotlinked from
// ESPN's CDN - the same team-logos.espncdn.com-family hosting the team
// crests/F1 logo elsewhere in this file already come from, not a
// reproduction copied into this repo. Used everywhere a sport is shown -
// the match card badge, the filter chips, and both sport-related Settings
// lists (see buildSportIcon below, the one place all four read from).
const LEAGUE_LOGOS = {
  // The lion only: ESPN's one Premier League logo has the "Premier League"
  // wordmark under the crest, unreadable at icon size, so ESPN's own
  // resizer crops the top 312px of the 500px square (w/h 1.6 - just clear
  // of the lettering, live-checked) and the icon's `object-fit: cover`
  // (styles.css) trims the empty sides.
  'Premier League': 'https://a.espncdn.com/combiner/i?img=/i/leaguelogos/soccer/500/23.png&w=128&h=80&scale=crop&location=origin',
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
    img.src = sizedEspnLogoUrl(LEAGUE_LOGOS[sport]);
    img.alt = '';
    img.decoding = 'sync';
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
// `whereToWatchTw` is a fixed rule's output (see match-builder.mjs's
// `resolveWhereToWatchTw`), but this registry still matches it by plain text rather than a hardcoded enum
// value here - both service names it can now actually produce (愛爾達體育台/
// Apple TV) already match an entry below, and staying text-matched costs
// nothing while keeping this file decoupled from exactly how the rule
// spells each name. This is what turns that text into something the UI can
// badge/color/reason about consistently, and what OWNED (see
// DEFAULT_MY_SERVICE_IDS below) means at all. Adding a new service
// later is just one more entry here (id, matching pattern, badge/color) -
// nothing else in this file needs to change, same reasoning as
// SPORT_LABEL_KEYS above for sports.
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
// Deliberately just these three, even though resolveWhereToWatchTw only
// ever actually produces two of them (愛爾達體育台/Apple TV) - kept
// text-matched rather than collapsed to those two exact values so a third
// service (Netflix) already has a ready slot the day this site covers a
// league that airs on it, with nothing else in this file needing to
// change (same reasoning as SPORT_LABEL_KEYS above for sports).
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
// the score nudge above: since match-builder.mjs's `resolveWhereToWatchTw`
// hardcoded every fixture's `whereToWatchTw` to either 愛爾達體育台 or
// Apple TV (see this repo's README), no fixture can ever match Netflix
// here anymore - kept rather than removed since this constant is still
// meant to describe the owner's real subscriptions, not just which ones
// currently affect scoring.
const DEFAULT_MY_SERVICE_IDS = ['elta', 'appletv', 'netflix'];

const loadingStateEl = document.getElementById('loading-state');
const appEl = document.getElementById('app');
const dayScrollerEl = document.getElementById('day-scroller');
const filtersRow = document.getElementById('sport-filters');
const recommendedListEl = document.getElementById('recommended-list');
const recommendedEmptyEl = document.getElementById('recommended-empty');
const recommendedLoadingEl = document.getElementById('recommended-loading');
const allMatchListEl = document.getElementById('all-match-list');
const allEmptyEl = document.getElementById('all-empty');
const allLoadingEl = document.getElementById('all-loading');
const dayLabelEls = document.querySelectorAll('[data-day-label]');
const emptyState = document.getElementById('empty-state');
const errorState = document.getElementById('error-state');
const generatedNote = document.getElementById('generated-note');
// Hidden on-screen input debugger - tap this line 5 times (see lib/tap-log.mjs).
installTapLog(generatedNote);

// ============================================================================
// DO NOT REMOVE - iOS Safari "every tap needs two taps" fix.
// ============================================================================
// Empty, passive, page-wide touch/pointer listeners. They do nothing on
// purpose; their mere EXISTENCE is the fix.
//
// Symptom (iOS Safari and the Home Screen app; desktop Chrome was fine):
// after ONE swipe on a match stack, every later tap on ANY button (day
// tabs, settings, filter chips) needed two taps. It stayed that way until
// the app was swiped away to the background and reopened.
//
// Cause, as best we can tell: iOS WebKit handles a tap differently
// depending on whether the spot being touched has touch/pointer listeners.
// With listeners only on the swipeable cards, a swipe there left WebKit's
// native tap handling stuck in the wrong state, and the next tap anywhere
// without listeners was used up just clearing it. Backgrounding the app
// resets WebKit's gesture state, which is why reopening "fixed" it. With
// listeners on the whole document, every tap goes down the same path, so
// there's nothing to get stuck. Passive, so they never block scrolling.
//
// How it was actually found (after three wrong guesses - see below): the
// hidden tap log (lib/tap-log.mjs, tap "Data last updated" 5 times) made
// the bug disappear whenever it was on. The log's only iOS-relevant side
// effect is registering document-level listeners, so copying just its
// touch/pointer ones here fixed it for good (confirmed on a real iPhone).
//
// What did NOT fix it (all tried first, then removed - don't re-add them
// hoping they help; see git history for the code):
//   1. Explicit releasePointerCapture before the card is removed.
//   2. Deferring choose()'s re-render with setTimeout(0).
//   3. Switching finger swipes from Pointer Events to passive Touch Events.
// None of these could be verified here - Chromium/Playwright never
// reproduces iOS WebKit tap bugs, even with real CDP touch input.
//
// Next time something only breaks on iPhone: turn on the tap log FIRST,
// reproduce, and paste its Copy output (or note if the bug vanishes with
// the log on - that itself narrows it to a listener-registration effect,
// like this one). If this bug ever comes back, try adding the log's other
// document-level listeners here too (mouseover/mousedown/mouseup/click).
['touchstart', 'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'pointercancel'].forEach(type => {
  document.addEventListener(type, () => {}, { capture: true, passive: true });
});
const nextUpdateNote = document.getElementById('next-update-note');
const tbdSection = document.getElementById('tbd-section');
const tbdListEl = document.getElementById('tbd-list');
const cardTemplate = document.getElementById('match-card-template');
const teamRowTemplate = document.getElementById('team-row-template');

const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsBackdrop = document.getElementById('settings-backdrop');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const settingsResetBtn = document.getElementById('settings-reset-btn');
const settingsSportList = document.getElementById('settings-sport-list');
const settingsEnabledSports = document.getElementById('settings-enabled-sports');
const updateStatusText = document.getElementById('update-status-text');
const refreshDataBtn = document.getElementById('refresh-data-btn');

// ---- Static UI copy (index.html) --------------------------------------
//
// public/index.html is served as-is, with no per-request templating (see
// scripts/build-data.mjs's own top comment - it never touches this file),
// so there is no build step to bake the detected/persisted locale (see
// ./lib/i18n.mjs) into the page's markup. This runs once, up front, and
// overwrites every piece of static Traditional-Chinese copy that HTML file
// ships with - the <title>/meta tags, every Settings-panel label, every
// section heading/hint/aria-label - with the real t() output for whichever
// locale actually applies. Every element this touches inside #app/
// #settings-panel is `hidden` by default (see index.html) until this app's
// own render calls unhide it, so there's no user-visible flash of the
// wrong language for any of it; the one exception is the browser tab's own
// <title>, which can't be hidden, so a viewer whose tab was already open
// before this ran could in principle see it change - unavoidable without a
// server-side render this static site deliberately doesn't have (see
// README's own "no build step" story).
function applyStaticTranslations() {
  document.documentElement.lang = getLocale() === 'en' ? 'en' : 'zh-Hant';
  document.title = t('title');
  const setMeta = (selector, value) => {
    const el = document.querySelector(selector);
    if (el) el.setAttribute('content', value);
  };
  setMeta('meta[name="description"]', t('metaDescription'));
  setMeta('meta[property="og:title"]', t('title'));
  setMeta('meta[property="og:description"]', t('metaDescription'));
  setMeta('meta[name="twitter:title"]', t('title'));
  setMeta('meta[name="twitter:description"]', t('metaDescription'));

  const setText = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t(key);
  };
  const setAria = (el, key) => {
    if (el) el.setAttribute('aria-label', t(key));
  };

  setAria(settingsPanel, 'settingsAriaLabel');
  setText('settings-heading', 'settingsHeading');
  setAria(settingsCloseBtn, 'closeAriaLabel');
  setText('settings-priority-heading', 'sportPriorityHeading');
  setText('settings-priority-hint', 'sportPriorityHint');
  settingsResetBtn.textContent = t('resetPriorityBtn');
  setText('settings-enabled-heading', 'enabledSportsHeading');
  setText('settings-enabled-hint', 'enabledSportsHint');
  setText('settings-update-heading', 'updateHeading');
  updateStatusText.textContent = t('updateStatusDefault');
  refreshDataBtn.textContent = t('refreshNowBtn');

  setAria(loadingStateEl, 'loadingAriaLabel');
  setAria(dayScrollerEl, 'daySelectorAriaLabel');
  setAria(filtersRow, 'sportFilterAriaLabel');
  setAria(settingsBtn, 'settingsAriaLabel');
  setText('recommended-heading-text', 'recommendedHeading');
  setText('recommended-empty', 'recommendedEmpty');
  setAria(recommendedLoadingEl, 'loadingAriaLabel');
  setText('all-matches-heading-text', 'allMatchesHeading');
  setText('all-empty', 'allEmpty');
  setAria(allLoadingEl, 'loadingAriaLabel');
  setText('tbd-heading', 'tbdHeading');
  setText('empty-state', 'globalEmpty');
  setText('error-state', 'globalError');
}
applyStaticTranslations();

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
// now always uses the single "Best Matches" blend - skill/closeness
// (competitiveness), sustained competitive stakes (enduranceScore), and
// entertainment/public attention (watchability, nudged by broadcastQuality)
// combined, see BEST_MATCH_WEIGHTS there - deliberately never anchored on
// just one of those axes. The viewer's own
// preference is expressed a different way instead: swiping a card stack to
// commit to a specific alternative (see "Prefer" below) - that's the ONE
// place personal taste overrides the algorithm's own judgment, and it's
// local, explicit, and per-match rather than a blanket ranking toggle.

// Every per-viewer localStorage read/write in this file goes through these
// two. Storage can be missing, blocked (private browsing) or full, and the
// stored value can be anything a previous visit left behind - a failed
// read is just "nothing stored" (null) and a failed write just means this
// page view won't be remembered next time, never an error worth surfacing.
function readStoredJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // See readStoredJson's comment.
  }
}

const SETTINGS_STORAGE_KEY = 'matchfind-sport-priority-order';

// Default sport priority, best first - also the order the enabled-sports
// toggles are listed in. Every sport in SPORT_LABEL_KEYS must appear here.
const DEFAULT_SPORT_ORDER = ['F1', 'NBA', 'Premier League', 'MLB'];

function loadPriorityOrder() {
  const stored = readStoredJson(SETTINGS_STORAGE_KEY);
  if (!Array.isArray(stored)) return DEFAULT_SPORT_ORDER.slice();
  // Tolerates the sport list itself changing between visits: keeps
  // whatever stored order still applies, appends any brand new sport at
  // the end (never assume a new sport, or leftover an unknown value in a
  // stale write, means anything relative to today's ranking).
  const known = stored.filter(sport => DEFAULT_SPORT_ORDER.includes(sport));
  const missing = DEFAULT_SPORT_ORDER.filter(sport => !known.includes(sport));
  return [...known, ...missing];
}
function savePriorityOrder(order) {
  writeStoredJson(SETTINGS_STORAGE_KEY, order);
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
  const stored = readStoredJson(ENABLED_SPORTS_STORAGE_KEY);
  if (!Array.isArray(stored) || !stored.length) return new Set(DEFAULT_SPORT_ORDER);
  return new Set(stored.filter(sport => DEFAULT_SPORT_ORDER.includes(sport)));
}
function saveEnabledSports(enabledSports) {
  writeStoredJson(ENABLED_SPORTS_STORAGE_KEY, [...enabledSports]);
}
state.enabledSports = loadEnabledSports();
// Not a per-viewer setting (see SERVICES' own comment) - fixed to this
// site's own owner's real subscriptions.
state.myServiceIds = new Set(DEFAULT_MY_SERVICE_IDS);

// ---- Pinned-choice persistence (local-only "Prefer") -----------------------
//
// state.pinnedChoices (Map<dayKey, Set<matchId>>) - which matches the
// viewer explicitly swiped to commit to watching, per day. Local-only, like every other
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
  return deserializePinnedChoices(readStoredJson(PINNED_CHOICES_STORAGE_KEY), localDateKey(new Date()));
}
function savePinnedChoices() {
  writeStoredJson(PINNED_CHOICES_STORAGE_KEY, serializePinnedChoices(state.pinnedChoices));
}
// The REAL load - see state.pinnedChoices's own comment in the state
// literal above for why this can't happen there directly (PINNED_CHOICES_
// STORAGE_KEY's own TDZ), same pattern as state.priorityOrder's assignment
// right after loadPriorityOrder above.
state.pinnedChoices = loadPinnedChoices();

// Live picks the plan itself recommended once they were underway - see
// recommendation.mjs's applyLiveExcitementBonus/LIVE_PICK_STICKY_BONUS.
// Persisted so a reload mid-game doesn't let a close game elsewhere swap
// out what the viewer is already watching. Stored as a plain id list;
// entries for fixtures that are finished or no longer fetched are dropped
// by pruneLiveStickyIds.
const LIVE_STICKY_STORAGE_KEY = 'matchfind-live-sticky-ids';
function loadLiveStickyIds() {
  const ids = readStoredJson(LIVE_STICKY_STORAGE_KEY);
  return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []);
}
function saveLiveStickyIds() {
  writeStoredJson(LIVE_STICKY_STORAGE_KEY, [...state.liveStickyIds]);
}
state.liveStickyIds = loadLiveStickyIds();

// The last plan rendered for each day (per sport filter) - see
// ./lib/preferences.mjs's dayPlanHistoryKey and recommendation.mjs's
// startedPlanLockIds. Whatever in it has already started is locked into
// every later plan for that day, so a game ending (or an app update wiping
// the match snapshot) can't reshuffle the day around it. Kept back to
// yesterday, matching MATCH_RETENTION_PAST_DAYS' own 昨天 tab.
const DAY_PLAN_HISTORY_STORAGE_KEY = 'matchfind-day-plan-history';
function oldestPlanHistoryDayKey() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return localDateKey(date);
}
// No longer tagged with its own copy of APP_BUILD_ID - the blanket
// wipeStorageOnNewBuild() at the very top of this file already guarantees
// nothing under the `matchfind-` prefix, this key included, ever survives
// past the deploy that wrote it. A deploy that fixes a scoring/rotation
// bug can only be reached by loading the fixed code in the first place -
// trusting an old decision from BEFORE that fix shipped would lock the
// very mistake the fix was for into every later render, with no way for
// the fix to ever correct it. Live-reported directly: a viewer who saw the
// bug once, before a fix went out, kept seeing the SAME wrong pick after
// the fix deployed too, because it was already recorded as history.
function loadDayPlanHistory() {
  const stored = readStoredJson(DAY_PLAN_HISTORY_STORAGE_KEY);
  return deserializeDayPlanHistory(stored?.entries, oldestPlanHistoryDayKey());
}
function saveDayPlanHistory() {
  writeStoredJson(DAY_PLAN_HISTORY_STORAGE_KEY, { entries: serializeDayPlanHistory(state.dayPlanHistory) });
}
state.dayPlanHistory = loadDayPlanHistory();
// Every day's locks at once, for computeVarietyRotation - a series spans
// several days, and a started pick on one of them fixes that day's turn.
function lockedIdsByDay() {
  return new Map(state.days.map(day => [day.key, lockedIdsForDay(day.key)]));
}
function lockedIdsForDay(dayKey) {
  return startedPlanLockIds(state.dayPlanHistory.get(dayPlanHistoryKey(dayKey, state.activeSport)), applySportFilter(matchesForDay(dayKey)));
}
// Pins are left out: a pin is already its own hard override, and recording
// it here would keep it locked in even after the viewer swipes it away.
//
// Only once the full window has loaded: the instant-paint snapshot and the
// near-term tier render first with only a couple of days in hand, which
// cuts a multi-day variety-rotation series short (see
// computeVarietyRotation), so their plan for today can differ from the real
// one - and recording it would lock that stopgap pick in the moment it
// starts.
function recordRenderedDayPlan(dayKey, dayPlan) {
  if (!state.fullWindowLoaded) return;
  const ids = dayPlan.filter(m => !m.isPreferred).map(m => m.id);
  const next = recordDayPlan(state.dayPlanHistory, dayPlanHistoryKey(dayKey, state.activeSport), ids, oldestPlanHistoryDayKey());
  if (next === state.dayPlanHistory) return;
  state.dayPlanHistory = next;
  saveDayPlanHistory();
}
function pruneLiveStickyIds() {
  if (!state.allRawMatches.length) return;
  const byId = new Map(state.allRawMatches.map(m => [m.id, m]));
  const kept = new Set([...state.liveStickyIds].filter(id => byId.has(id) && !byId.get(id).isFinished));
  if (kept.size !== state.liveStickyIds.size) {
    state.liveStickyIds = kept;
    saveLiveStickyIds();
  }
}
// Called on every applyEnabledSportsAndRender (a fresh data load, or a
// sport toggle) - state.days moves forward with the fetched window, and a
// pin for a day that's fallen off the back of it, or simply passed, can
// never be looked up by computeDayPlan again either way.
// One-time cleanup (per browser) of pins left on an already-finished game by
// the old swipe stack, which offered finished games as swipe targets. Such a
// pin rendered as a plain, unswipeable 已結束 card and blocked every live
// game it overlapped out of the plan until the day rolled over, with no way
// to undo it from the UI. New pins can't land on a finished game anymore
// (see computeDayPlan's alternatives filter), so this only needs to run once.
const FINISHED_PIN_CLEANUP_STORAGE_KEY = 'matchfind-finished-pin-cleanup-v1';
function dropPinsOnFinishedMatchesOnce() {
  try {
    if (localStorage.getItem(FINISHED_PIN_CLEANUP_STORAGE_KEY) || !state.allRawMatches.length) return false;
    localStorage.setItem(FINISHED_PIN_CLEANUP_STORAGE_KEY, '1');
  } catch {
    return false;
  }
  const finishedIds = new Set(state.allRawMatches.filter(m => m.isFinished).map(m => m.id));
  let changed = false;
  const next = new Map();
  state.pinnedChoices.forEach((daySet, dayKey) => {
    const kept = new Set([...daySet].filter(id => !finishedIds.has(id)));
    if (kept.size !== daySet.size) changed = true;
    if (kept.size) next.set(dayKey, kept);
  });
  if (changed) state.pinnedChoices = next;
  return changed;
}

function prunePinnedChoices() {
  const { pinnedChoices, changed } = pruneStalePinnedChoices(state.pinnedChoices, localDateKey(new Date()));
  state.pinnedChoices = pinnedChoices;
  const droppedFinished = dropPinsOnFinishedMatchesOnce();
  pruneLiveStickyIds();
  if (changed || droppedFinished) savePinnedChoices();
}

function recomputeAndRender() {
  if (!state.rawMatches.length) return;
  state.matches = resolveViewingPlan(state.rawMatches, state.priorityOrder, state.myServiceIds);
  // Every caller (a live poll's new scores/durations, a priority or owned-
  // service change) just changed the scores/intervals the cached rotation
  // plan was computed from. Leaving it cached meant the RENDER kept forcing
  // a stale rotation pick while pinSlotChoice (which always recomputes
  // rotation fresh) disagreed about what the slot's natural pick was - so
  // swiping to that card was treated as "back to default", cleared nothing,
  // and the stale force put the old card right back: live-reported as
  // cards becoming unable to swipe once games go live.
  invalidateVarietyRotation();
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
      label.textContent = sportLabel(sport);
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
      upBtn.setAttribute('aria-label', t('moveSportUp', { sport: sportLabel(sport) }));
      upBtn.textContent = '↑';
      upBtn.disabled = index === 0;
      upBtn.addEventListener('click', () => move(-1));

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.setAttribute('aria-label', t('moveSportDown', { sport: sportLabel(sport) }));
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
      label.textContent = sportLabel(sport);
      chip.appendChild(label);
      chip.setAttribute('aria-pressed', String(enabled));
      chip.disabled = enabled && state.enabledSports.size === 1;
      chip.addEventListener('click', () => {
        if (enabled) {
          if (state.enabledSports.size === 1) return; // guarded by chip.disabled too
          state.enabledSports.delete(sport);
        } else {
          state.enabledSports.add(sport);
          // buildMatches skips fetching a disabled sport's league entirely
          // (see its own `enabledSports` param) - a real performance win
          // while it stays off, but it also means state.allRawMatches
          // genuinely has zero fixtures for it the moment it's re-enabled,
          // not just filtered-out ones. applyEnabledSportsAndRender below
          // would otherwise show an empty day for a sport that actually has
          // real fixtures, until whichever refresh tier happens to fire
          // next (up to FULL_REFRESH_MS later) backfills it - kicking off a
          // full-window refresh right here closes that gap immediately.
          // Fire-and-forget, same reasoning as every other unblocked
          // refresh call in this file: the toggle itself should feel
          // instant, not wait on ~50 requests before the panel closes.
          refreshFullWindow({ silent: true }).catch(error => console.error('sport re-enable refresh failed', error));
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

// Reads the CURRENT i18n locale on every call (via dateFnsLocaleTag), not a
// fixed constant - a match's clock time/weekday name has to actually read
// in English (AM/PM, "Wed" not "週三") for an English-UI viewer, not just
// the surrounding label text.
function localTimeFormatter() {
  return new Intl.DateTimeFormat(dateFnsLocaleTag(), { hour: 'numeric', minute: '2-digit' });
}
function localDayFormatter() {
  return new Intl.DateTimeFormat(dateFnsLocaleTag(), { weekday: 'long', month: 'long', day: 'numeric' });
}
function shortDayFormatter() {
  return new Intl.DateTimeFormat(dateFnsLocaleTag(), { weekday: 'short', month: 'numeric', day: 'numeric' });
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
  if (state === LIFECYCLE_STATES.LIVE || state === LIFECYCLE_STATES.ENDING_SOON) return t('liveNow');
  if (state === LIFECYCLE_STATES.STARTING_SOON) return t('startingSoon');

  const diffMin = Math.round((Date.parse(match.startTimeUtc) - now) / 60_000);
  if (diffMin < 60) return t('minutesLater', { mins: diffMin });
  if (diffMin < 1440) {
    const hours = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    return mins ? t('hoursMinutesLater', { hours, mins }) : t('hoursLater', { hours });
  }
  // Past 24 hours, count in whole days instead of letting the hour count
  // just keep climbing (nobody reads "38 小時後" faster than "1 天 14
  // 小時後") - this is also the point at which a plain hour count stops
  // being enough to place a match without checking a calendar.
  const days = Math.floor(diffMin / 1440);
  const hours = Math.floor((diffMin % 1440) / 60);
  return hours ? t('daysHoursLater', { days, hours }) : t('daysLater', { days });
}

// "已結束" plus the final score, when match-builder.mjs actually got one back
// from ESPN as a plain number for both sides - anything else (missing,
// non-numeric, only one side present) just falls back to the plain label
// rather than showing a half-built or misleading score line.
function finishedLabel(match) {
  const scores = (match.competitors || []).map(c => Number(c.score));
  if (scores.length === 2 && scores.every(Number.isFinite)) {
    return t('finishedWithScore', { away: scores[0], home: scores[1] });
  }
  return t('finished');
}

// A sport-specific live in-progress WIDGET (MLB's base-occupancy diamond/
// outs/count, EPL/NBA's pulsing live dot + clock, F1's flag-colored status +
// lap) - populated from match.live, which only ever exists once
// pollLiveMatches's own faster tier (see that function's own top comment)
// has actually polled this fixture at least once; a match that just went
// live seconds ago simply shows nothing yet, same as its odds/score
// already do, rather than a guessed placeholder. Never called for a match
// that isn't genuinely LIVE/ENDING_SOON right now - see buildMatchCard's
// own gate. These build real DOM nodes (not text) - reported directly that
// a flat text line read as easy to miss scanning a busy list of cards, so
// this uses small inline glyphs (a lit-up base diamond, a colored flag, a
// pulsing dot) a viewer can recognize at a glance, the same way a TV
// broadcast graphic would, rather than a sentence to parse. Every SVG
// below is a fixed, hardcoded shape (only numbers/booleans ever vary which
// CSS class gets applied) - never user-supplied text - so building it via
// innerHTML is the same safe, already-used pattern as SPORT_ICONS/
// buildSportIcon above, not a fresh injection risk.
const INNING_HALF_KEYS = { Top: 'inningTop', Bot: 'inningBot', Mid: 'inningMid', End: 'inningEnd' };

function formatInningHalf(detail) {
  const m = /^(Top|Bot|Mid|End)\s+(\d+)/i.exec((detail || '').trim());
  if (!m) return detail || '';
  const key = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const half = INNING_HALF_KEYS[key] ? t(INNING_HALF_KEYS[key]) : '';
  return t('inningFormat', { n: m[2], half });
}

function svgFromMarkup(markup) {
  const wrap = document.createElement('span');
  wrap.innerHTML = markup.trim();
  return wrap.firstElementChild;
}

// The classic broadcast-graphic diamond: a rotated square with a dot at
// each of 1st/2nd/3rd (never home - a batter always implicitly "is" there)
// that lights up exactly when `situation` reports a runner actually
// standing on it. Reads instantly where the old "一、二壘有人" text clause
// needed a full read to parse.
function baseballDiamondIcon(situation) {
  const on1 = !!situation?.onFirst;
  const on2 = !!situation?.onSecond;
  const on3 = !!situation?.onThird;
  return svgFromMarkup(`
    <svg class="live-diamond" viewBox="0 0 34 30" aria-hidden="true">
      <path d="M17 3 L30 16 L17 27 L4 16 Z" />
      <circle class="live-base${on2 ? ' is-on' : ''}" cx="17" cy="6.6" r="3.6" />
      <circle class="live-base${on1 ? ' is-on' : ''}" cx="26.4" cy="16" r="3.6" />
      <circle class="live-base${on3 ? ' is-on' : ''}" cx="7.6" cy="16" r="3.6" />
    </svg>
  `);
}

function outDotsNode(outs) {
  const wrap = document.createElement('span');
  wrap.className = 'live-out-dots';
  wrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('i');
    dot.className = Number.isFinite(outs) && i < outs ? 'live-out-dot is-out' : 'live-out-dot';
    wrap.appendChild(dot);
  }
  return wrap;
}

function liveDotIcon() {
  const dot = document.createElement('span');
  dot.className = 'live-pulse-dot';
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

function baseballLiveNode(match) {
  const live = match.live;
  if (!live) return null;
  const situation = live.situation;
  const inningLabel = formatInningHalf(live.detail);
  if (!inningLabel && !situation) return null;
  const wrap = document.createElement('span');
  wrap.className = 'live-chip live-chip-baseball';
  if (situation) wrap.appendChild(baseballDiamondIcon(situation));
  const textWrap = document.createElement('span');
  textWrap.className = 'live-chip-text';
  if (inningLabel) {
    const inningEl = document.createElement('span');
    inningEl.className = 'live-chip-inning';
    inningEl.textContent = inningLabel;
    textWrap.appendChild(inningEl);
  }
  // Ball/strike count deliberately NOT shown, even though ESPN's own
  // `situation` reports it - it changes on every single pitch (seconds
  // apart), so a fixed LIVE_POLL_INTERVAL_MS (30s) tick almost never
  // catches the CURRENT count, only a stale one from up to half a minute
  // ago - reported directly as "useless" for exactly that reason. Outs and
  // baserunners change on a much slower, at-bat-scale cadence this refresh
  // rate actually keeps up with, so only those still render.
  if (situation && Number.isFinite(situation.outs)) textWrap.appendChild(outDotsNode(situation.outs));
  wrap.appendChild(textWrap);
  return wrap;
}

function basketballLiveNode(match) {
  const live = match.live;
  if (!live) return null;
  const period = Number(live.period);
  const periodLabel =
    Number.isFinite(period) && period > 0
      ? period <= 4
        ? t('quarterLabel', { n: period })
        : t('overtimeLabel', { n: period - 4 })
      : '';
  const text = [periodLabel, live.displayClock].filter(Boolean).join('．');
  if (!text) return null;
  const wrap = document.createElement('span');
  wrap.className = 'live-chip';
  wrap.appendChild(liveDotIcon());
  const textEl = document.createElement('span');
  textEl.className = 'live-chip-text';
  textEl.textContent = text;
  wrap.appendChild(textEl);
  return wrap;
}

function soccerLiveNode(match) {
  const live = match.live;
  if (!live) return null;
  const half = live.period === 2 ? t('secondHalf') : live.period === 1 ? t('firstHalf') : '';
  // A numeric match clock ("76'") gets the half label prefixed; anything
  // ESPN itself already reports as a plain state word (e.g. "Halftime")
  // is shown exactly as-is rather than force-fit into "上半場 Halftime".
  const text = live.displayClock ? [half, live.displayClock].filter(Boolean).join('．') : live.detail || '';
  if (!text) return null;
  const wrap = document.createElement('span');
  wrap.className = 'live-chip';
  wrap.appendChild(liveDotIcon());
  const textEl = document.createElement('span');
  textEl.className = 'live-chip-text';
  textEl.textContent = text;
  wrap.appendChild(textEl);
  return wrap;
}

// Which flag color actually applies right now, read straight from ESPN's
// own status text (e.g. "Lap 23/53 - Safety Car") - never guessed from lap
// number/timing, since a caution can start or end on any lap.
const F1_FLAG_ICON_SVG = {
  checkered:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" fill="#fff"/><rect x="0" y="0" width="4" height="4" fill="#15181f"/><rect x="8" y="0" width="4" height="4" fill="#15181f"/><rect x="4" y="4" width="4" height="4" fill="#15181f"/><rect x="12" y="4" width="4" height="4" fill="#15181f"/><rect x="0" y="8" width="4" height="4" fill="#15181f"/><rect x="8" y="8" width="4" height="4" fill="#15181f"/><rect x="4" y="12" width="4" height="4" fill="#15181f"/><rect x="12" y="12" width="4" height="4" fill="#15181f"/></svg>',
  red: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" fill="#e2453c"/></svg>',
  safety:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" fill="#f4d13d"/><text x="8" y="11.5" font-size="7" font-weight="700" text-anchor="middle" fill="#15181f">SC</text></svg>',
  yellow: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" fill="#f4d13d"/></svg>',
  green: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" fill="#39c463"/></svg>'
};

function f1FlagKey(statusDetail) {
  const s = (statusDetail || '').toLowerCase();
  if (s.includes('checkered') || s.includes('final')) return 'checkered';
  if (s.includes('red flag')) return 'red';
  if (s.includes('safety car') || s.includes('vsc') || s.includes('virtual safety')) return 'safety';
  if (s.includes('yellow') || s.includes('caution')) return 'yellow';
  return 'green';
}

function f1FlagIcon(statusDetail) {
  const key = f1FlagKey(statusDetail);
  const wrap = document.createElement('span');
  wrap.className = `live-flag live-flag-${key}`;
  wrap.innerHTML = F1_FLAG_ICON_SVG[key];
  return wrap;
}

function f1LiveNode(match) {
  const live = match.live;
  if (!live) return null;
  const lapLabel = Number.isFinite(live.lap) ? t('lapLabel', { n: live.lap }) : '';
  const text = [lapLabel, live.statusDetail].filter(Boolean).join('．');
  if (!text) return null;
  const wrap = document.createElement('span');
  wrap.className = 'live-chip';
  wrap.appendChild(f1FlagIcon(live.statusDetail));
  const textEl = document.createElement('span');
  textEl.className = 'live-chip-text';
  textEl.textContent = text;
  wrap.appendChild(textEl);
  return wrap;
}

function buildLiveStatusNode(match) {
  switch (match.sport) {
    case 'MLB':
      return baseballLiveNode(match);
    case 'NBA':
      return basketballLiveNode(match);
    case 'Premier League':
      return soccerLiveNode(match);
    case 'F1':
      return f1LiveNode(match);
    default:
      return null;
  }
}

// F1's own current running order, as small medal-colored rank chips (gold/
// silver/bronze for the top 3) rather than a flat "1. Name 2. Name" text
// line - the same reasoning as buildLiveStatusNode's own top comment.
const LEADERBOARD_MEDAL_CLASS = ['is-gold', 'is-silver', 'is-bronze'];

function f1LeaderboardNode(match) {
  const live = match.live;
  if (!live || !Array.isArray(live.leaderboard) || !live.leaderboard.length) return null;
  const wrap = document.createElement('span');
  wrap.className = 'live-leaderboard';
  const label = document.createElement('span');
  label.className = 'live-leaderboard-label';
  label.textContent = t('currentOrder');
  wrap.appendChild(label);
  live.leaderboard.forEach((driver, i) => {
    const chip = document.createElement('span');
    chip.className = `live-leaderboard-chip ${LEADERBOARD_MEDAL_CLASS[i] || ''}`.trim();
    const rank = document.createElement('i');
    rank.className = 'live-leaderboard-rank';
    rank.textContent = String(i + 1);
    chip.appendChild(rank);
    // The nationality flag ESPN itself already serves per driver (see
    // extractF1LiveUpdates's own comment - there's no headshot or
    // constructor/team field in this API at all) - the one real per-driver
    // icon available, rather than a generic helmet silhouette that
    // wouldn't actually distinguish one driver from another.
    if (driver.flagUrl) {
      const flag = document.createElement('img');
      flag.className = 'live-leaderboard-flag';
      flag.src = driver.flagUrl;
      flag.alt = driver.flagAlt || '';
      flag.loading = 'lazy';
      flag.referrerPolicy = 'no-referrer';
      chip.appendChild(flag);
    }
    const name = document.createElement('span');
    name.textContent = driver.name;
    chip.appendChild(name);
    // Only ever shown when ESPN itself actually reported a gap - see
    // extractF1LiveUpdates's own comment on why this has come back empty
    // every time this was checked; never a locally-computed/guessed value.
    if (driver.interval) {
      const interval = document.createElement('span');
      interval.className = 'live-leaderboard-interval';
      interval.textContent = driver.interval;
      chip.appendChild(interval);
    }
    wrap.appendChild(chip);
  });
  return wrap;
}

// Local calendar date key, e.g. "2026-09-19" - deliberately NOT toISOString
// (which would give the UTC date, off by a day for plenty of viewers around
// midnight). Every date/day grouping in this file goes through this so a
// match is always bucketed onto the day it actually falls on for whoever is
// looking at the page.
function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Local-calendar day offset from today (0 = today, 1 = tomorrow, -1 =
// yesterday) - shared by dayLabelFor's own label logic below and
// MATCH_RETENTION_PAST_DAYS' pruning (see mergeFreshMatches), since both
// are really the same "how many local calendar days off is this" question.
function daysFromToday(date) {
  const today = new Date();
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(date) - startOfDay(today)) / 86_400_000);
}

function dayLabelFor(date, { short = false } = {}) {
  const diffDays = daysFromToday(date);
  if (diffDays === 0) return t('today');
  if (diffDays === 1) return t('tomorrow');
  // Yesterday is a real, explicitly reachable day now (see match-builder.mjs's
  // own one-day lookback and computeDayPlan treating a finished match as a
  // normal candidate) - it deserves the same clear "昨天" label 今天/明天
  // already get, not just falling through to a bare weekday/date.
  if (diffDays === -1) return t('yesterday');
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
// isNearTotalOverlap/effectiveDurationMinutes/
// schedulingInterval/canWatchSequentially/groupIntoSlots/
// slotKeyFromMembers/weightedIntervalSchedule/computeDayPlan/
// applyLiveExcitementBonus/matchupKey/resolveViewingPlan all now live in
// ./lib/recommendation.mjs (imported at the top of this file) - see that
// module for the "one continuous back-to-back plan, not independent
// picks" model this section used to document inline, and docs/
// recommendation-engine-audit.md for how effectiveScore's adjustments are
// now exposed for debugging (computeRecommendationScore/scoreBreakdown).
// computeOverlapRange is still used directly below, in buildMatchCard's
// own overlap note.

// ---- Back-to-back variety (bounded, elite-exempt) --------------------------
//
// See ./lib/recommendation.mjs's own "Back-to-back variety" section
// (Round 43) for the actual planning logic (computeVarietyRotation) - this
// part just supplies the WHOLE fetched window's own candidate matches that
// planning pass needs (every day in state.days, sport-filtered/scored the
// same way a real render would), and caches the resulting plan so a
// render doesn't re-derive it from scratch on every single call.
function baseDayCandidates(dayKey) {
  const dayCandidates = applySportFilter(matchesForDay(dayKey));
  applyLiveExcitementBonus(dayCandidates, state.liveStickyIds);
  return dayCandidates;
}

// Memoized until something that could change the plan happens
// (invalidateVarietyRotation, called from applyFreshBuild/pinSlotChoice/
// preferMatch/the sport-filter toggle below) - computeVarietyRotation runs
// computeDayPlan once per day across the WHOLE window, which is cheap
// (matches scripts/dump-day-plan.mjs's own real-world timing for the same
// computation) but still real work worth not repeating on every routine
// live-poll re-render in between.
let varietyRotationCache = null;
function invalidateVarietyRotation() {
  varietyRotationCache = null;
}
function getVarietyRotation() {
  if (varietyRotationCache) return varietyRotationCache;
  varietyRotationCache = computeVarietyRotation(rotationMatchesByDayKey(), state.pinnedChoices, lockedIdsByDay());
  return varietyRotationCache;
}

// Variety rotation is a cross-day plan made from PRE-GAME scores alone -
// no live-excitement bonus and no live-pick stickiness. Feeding it
// planningScore (as an earlier version did) let a sticky live pick's
// bonus make it look like a runaway winner with no close alternatives,
// which silently switched the rotation off for that day, and let a live
// scoreline flip a close call mid-game. Runs on shallow COPIES, since both
// this and computeVarietyRotation's own computeDayPlan calls write fields
// (planningScore, recommended, ...) that the render's own real candidates
// must keep.
//
// Every day in state.days, even one with zero candidates for the current
// sport filter - computeVarietyRotation's own comment explains why an empty
// day still has to be PRESENT (as an empty array) rather than simply
// missing, so a real gap day correctly breaks a run instead of silently
// stitching two separate repeats together across it.
function rotationMatchesByDayKey() {
  const matchesByDayKey = new Map();
  state.days.forEach(day => {
    const copies = applySportFilter(matchesForDay(day.key)).map(m => ({ ...m }));
    applyLiveExcitementBonus(copies, null, { live: false });
    matchesByDayKey.set(day.key, copies);
  });
  return matchesByDayKey;
}

// The exact same day-candidate preparation renderRecommendedSection needs
// to build today's plan - factored out so pinSlotChoice below can ask
// "what would the algorithm pick here on its own" (see naturalSlotChoice)
// against the IDENTICAL candidate set/scores the actual rendered plan
// uses, rather than a second, slightly different computation that could
// disagree with what's on screen. Round 44: variety rotation is no longer
// baked into these candidates' own `planningScore` - see
// pinnedForDayWithRotation below for why it's applied as a hard FORCE via
// computeDayPlan's own pinnedForDay instead.
function dayCandidatesForPlan(dayKey) {
  return baseDayCandidates(dayKey);
}

// The viewer's own real pins for `dayKey`, merged with whatever
// computeVarietyRotation decided must be forced in that day (see
// recommendation.mjs's own Round 44 comment on mergeVarietyForcedIds for
// why a hard force, not a score nudge, is what actually guarantees a
// rotation's assigned winner wins its slot). Every real computeDayPlan/
// naturalSlotChoice call site below uses this instead of reading
// state.pinnedChoices directly, so rotation and a genuine swipe-to-pin are
// always resolved together, consistently.
function pinnedForDayWithRotation(dayKey) {
  return mergeVarietyForcedIds(state.pinnedChoices.get(dayKey), rotationRespectingLivePicks(dayKey, getVarietyRotation().get(dayKey)));
}

// A rotation force is a hard pin, so without this it would still beat a
// live pick the viewer is already watching (see state.liveStickyIds) if the
// rotation's own assignment for today ever changed mid-game - e.g. a later
// day's fixtures shifting how a multi-day run gets shared out. Drops any
// rotation force whose scheduled time clashes with an underway sticky pick
// that day; the live game keeps its slot and the rotation simply skips it.
function rotationRespectingLivePicks(dayKey, forcedIds) {
  if (!forcedIds || !forcedIds.size) return forcedIds;
  const dayMatches = matchesForDay(dayKey);
  // Plan picks that already started (see lockedIdsForDay) hold their slot
  // against a rotation force the same way an underway sticky pick does.
  const startedLocks = lockedIdsForDay(dayKey);
  const locked = dayMatches.filter(m => (state.liveStickyIds.has(m.id) && isUnderway(m)) || startedLocks.has(m.id));
  if (!locked.length) return forcedIds;
  const byId = new Map(dayMatches.map(m => [m.id, m]));
  const clashes = (a, b) => {
    const ai = schedulingInterval(a);
    const bi = schedulingInterval(b);
    return ai.start < bi.end && bi.start < ai.end;
  };
  return new Set(
    [...forcedIds].filter(id => {
      const forced = byId.get(id);
      return !forced || !locked.some(live => live.id !== id && clashes(forced, live));
    })
  );
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
//
// naturalMatchId alone isn't always what actually reappears once a pin is
// cleared, though: variety rotation (computeVarietyRotation/
// mergeVarietyForcedIds) can independently force a DIFFERENT member of
// this exact cluster to win the slot, with no real pin involved at all. If
// the viewer swipes/taps back to naturalMatchId while rotation is forcing
// something else here, there is no pin to clear (rotation was never a real
// pin), applySlotSwipe correctly no-ops, and rotation just re-forces the
// same slot right back on the very next render - live-reported as "can't
// swipe to the first dot, it just reruns to a random place or refuses".
// `unpinnedResultId` is what would ACTUALLY show with no real pin present
// - the rotation-forced id when rotation is forcing this cluster, else the
// plain algorithmic natural pick - so swiping to anything else (including
// naturalMatchId, when rotation is overriding it) correctly becomes a real
// pin instead of a no-op.
//
// That "what would show with no real pin" question has to be asked against
// a version of state.pinnedChoices with THIS slot's own current real pin
// already removed, not just filtered out of the merged result afterward -
// pinnedForDayWithRotation/getVarietyRotation() run computeVarietyRotation
// over the CURRENT state.pinnedChoices, and computeVarietyRotation resolves
// every slot in a day together (Round 44's own "maximum matching", not a
// per-slot decision), so a real pin still sitting in THIS slot can itself
// change what rotation decides to force in a DIFFERENT slot that day.
// Reusing that already-computed rotation here (as an earlier version of
// this function did) meant "this slot's own natural pick" silently
// depended on whatever THIS slot happened to be pinned to a moment ago -
// so swiping out and immediately back could land on a genuinely different
// unpinnedResultId than the one that was true before either swipe, and the
// swipe-back got recorded as a new pin instead of clearing one. Live-
// reported: "swiping then swiping back make recommended label into prefer
// - not always but inconsistently and often" - it only showed up on days
// where some OTHER slot's rotation assignment actually depended on this
// one, which is exactly why it looked random rather than every time.
//
// A pin in a DIFFERENT cluster whose scheduling window still clashes with
// `matchId` (a partial overlap - not near-total, so not a stack-mate) is
// superseded by this choice too: the viewer can't watch both, and leaving
// it pinned both forced the two overlapping games into the plan together
// and kept `matchId` from ever counting as its slot's natural pick.
// Live-reported: "in the full game list, Prefer another game, then Prefer
// the recommended game back - its label goes 偏好, not back to 推薦" - the
// other game's pin was what had displaced it in the first place, so
// dropping that pin is exactly what makes it 推薦 again.
function pinSlotChoice(dayKey, slotKey, matchId) {
  const dayCandidates = dayCandidatesForPlan(dayKey);
  const clusterMemberIds = new Set(slotKey.split('|'));
  const target = dayCandidates.find(m => m.id === matchId);
  const clashes = (a, b) => {
    const ai = schedulingInterval(a);
    const bi = schedulingInterval(b);
    return ai.start < bi.end && bi.start < ai.end;
  };
  const supersededPins = target
    ? dayCandidates.filter(m => !clusterMemberIds.has(m.id) && state.pinnedChoices.get(dayKey)?.has(m.id) && clashes(m, target)).map(m => m.id)
    : [];
  const basePinnedChoices = removePins(state.pinnedChoices, dayKey, supersededPins);
  const daySet = basePinnedChoices.get(dayKey);
  const ownPinInCluster = daySet ? [...daySet].find(id => clusterMemberIds.has(id)) : undefined;
  const pinnedChoicesWithoutThisSlot = ownPinInCluster !== undefined ? removePins(basePinnedChoices, dayKey, [ownPinInCluster]) : basePinnedChoices;
  const rotationWithoutThisSlot = rotationRespectingLivePicks(
    dayKey,
    computeVarietyRotation(rotationMatchesByDayKey(), pinnedChoicesWithoutThisSlot, lockedIdsByDay()).get(dayKey)
  );
  // Asked of THIS match directly, not "which member does the slot pick" -
  // a big transitive cluster (a real MLB slate) can have several members
  // recommended at once, and picking whichever one sorted first there
  // turned tapping 設為偏好 on the game a pin had just displaced into a new
  // 偏好 pin instead of restoring its 推薦. Rotation's forced picks are
  // already in `pinnedForDay`, so this also covers the rotation case.
  const unpinnedPlan = stableDayPlan(dayKey, dayCandidates.map(m => ({ ...m })), pinnedChoicesWithoutThisSlot.get(dayKey), rotationWithoutThisSlot).plan;
  const unpinnedResultId = unpinnedPlan.some(m => m.id === matchId) ? matchId : null;
  state.pinnedChoices = applySlotSwipe(basePinnedChoices, dayKey, slotKey, matchId, unpinnedResultId);
  savePinnedChoices();
  // A pin can change which matchup naturally wins a day, which can change
  // a rotation run's own shape (see computeVarietyRotation) - the cached
  // plan has to be thrown away, not just this one day's own candidates.
  invalidateVarietyRotation();
  renderSections();
}

// The day's plan with the viewer's own pins applied as a LOCAL swap. The
// plan the day would have with none of them (`baseline`) stays as it is,
// except for whatever a pin clashes with (a lock yields to a pin), and
// nothing new is pulled in to fill the freed time - the only candidates
// are the baseline picks, the pins themselves, started-pick locks and
// rotation's forced ids. Letting the scheduler loose over the whole day
// instead pulled unrelated, previously greyed-out games into the plan the
// moment one game was preferred - reported as "I chose one match to
// prefer, a bunch of greyed-out matches also get featured... it's
// illogical". The stack a pin lands in is built from `baseline` too - see
// renderRecommendedSection's stackAlternativeIds.
//
// `viewerPins` goes in as priorityPinnedIds too - a genuine viewer swipe/
// tap must always win a slot over the variety rotation's own separately-
// forced pick for it when both land in the SAME cluster (see that option's
// own comment in computeDayPlan).
function stableDayPlan(dayKey, dayCandidates, viewerPins, rotationForced) {
  const lockedIds = lockedIdsForDay(dayKey);
  const options = { scoreField: 'planningScore', lockedIds };
  if (!viewerPins || !viewerPins.size) {
    const plan = computeDayPlan(dayKey, dayCandidates, mergeVarietyForcedIds(null, rotationForced), options);
    return { plan, baseline: plan };
  }
  const baseline = computeDayPlan(dayKey, dayCandidates.map(m => ({ ...m })), mergeVarietyForcedIds(null, rotationForced), options);
  const allowed = new Set([...baseline.map(m => m.id), ...viewerPins, ...lockedIds, ...(rotationForced || [])]);
  // computeDayPlan only resets the flags on the candidates it's handed -
  // clear the rest here so nothing keeps a stale 推薦 from a prior render.
  dayCandidates.forEach(m => {
    m.recommended = false;
    m.alternativeIds = null;
    m.isPreferred = false;
    m.slotKey = null;
  });
  const plan = computeDayPlan(
    dayKey,
    dayCandidates.filter(m => allowed.has(m.id)),
    mergeVarietyForcedIds(viewerPins, rotationForced),
    { ...options, lockedIds: new Set([...lockedIds, ...baseline.map(m => m.id)]), priorityPinnedIds: viewerPins }
  );
  return { plan, baseline };
}

// Lets a viewer promote ANY not-currently-recommended candidate straight
// from its own card into a hard pin, via the exact same forcedIds/
// excludedIds mechanism computeDayPlan already uses for an in-stack swipe
// (see pinSlotChoice above). Reported directly: a slot whose own conflict
// cluster has only ONE member renders as a plain, non-swipeable card (see
// renderRecommendedSection's own `!alternatives.length` branch) - "I can't
// swipe on the card stack that is not the first... I think it's because
// that's the only match" - so a viewer who wanted to override THAT slot
// with a completely different match (one from another time, another
// cluster, even one that time-conflicts with today's current pick) had no
// swipe target to act on at all. Computing the match's own conflict cluster
// FRESH here, the same way computeDayPlan itself will on the very next
// render, is what makes the pin correctly "kill" (exclude) whatever it
// pairwise-conflicts with - including a totally different slot's current
// pick - and, since forcing in a fixture whose own cluster has no other
// members leaves nothing to show alternatives for, it reduces to a single
// 偏好 card once forced in: "it has to be able to kill the first card and
// make them the only card."
function preferMatch(match) {
  const dayKey = localDateKey(new Date(match.startTimeUtc));
  const dayCandidates = dayCandidatesForPlan(dayKey).filter(m => !isQuietHours(m));
  const cluster = groupIntoSlots(dayCandidates).find(c => c.members.some(m => m.id === match.id));
  const slotKey = cluster ? slotKeyFromMembers(cluster.members) : match.id;
  pinSlotChoice(dayKey, slotKey, match.id);
}

// ---- Rendering ------------------------------------------------------------

function createTeamRowNode() {
  return teamRowTemplate.content.firstElementChild.cloneNode(true);
}

// Populates a team-row node - either a brand new one (right after
// createTeamRowNode above) or an EXISTING one being patched in place by a
// card render that's reusing its whole match-card node (see
// updateMatchCard's own teams-section comment) - so this never assumes it's
// starting from the template's own blank defaults the way a fresh clone
// would.
function updateTeamRow(node, { logo, name, nameZh, homeAway, score, showScore }) {
  const img = node.querySelector('.team-logo');
  // Bound exactly ONCE per DOM node, ever - not per render - so reusing this
  // same row across many renders (a routine score/odds poll patching an
  // already-on-screen card) never piles up a fresh 'error' listener on top
  // of every earlier one. Left permanently attached rather than
  // `{ once: true }`, since it has to keep working across every future
  // `src` reassignment below too, not just the first one.
  if (!img.dataset.errorBound) {
    img.dataset.errorBound = '1';
    img.addEventListener('error', () => {
      img.dataset.loadFailed = '1';
      img.hidden = true;
    });
  }
  if (logo) {
    // Downsized - see sizedEspnLogoUrl's own comment.
    const src = sizedEspnLogoUrl(logo);
    // Only touches `src` when the URL actually changed - this IS the fix
    // for the reported team-logo flash: an unconditional `img.src = logo`
    // every render (even to the exact same URL a reused node already has
    // loaded and painted) still restarts that image's decode, which
    // visibly blanks it for a frame on every routine background refresh.
    if (img.getAttribute('src') !== src) {
      img.src = src;
      // A new URL deserves a fresh chance - most relevant for a service
      // logo whose fallback state (see updateMatchCard's watch-badge
      // section) can genuinely change source over a match's lifetime, but
      // kept here too since nothing guarantees a team's own logo URL can
      // never change.
      delete img.dataset.loadFailed;
    }
    img.alt = name;
    // Never force it back visible while a real load failure is still in
    // effect for the CURRENT src - a reused row that already gave up on a
    // broken logo must stay hidden, not flash the broken-image box back in
    // on every subsequent render.
    img.hidden = img.dataset.loadFailed === '1';
  } else {
    img.hidden = true;
  }
  const sideEl = node.querySelector('.team-side');
  if (homeAway === 'home' || homeAway === 'away') {
    sideEl.hidden = false;
    sideEl.textContent = homeAway === 'home' ? t('homeShort') : t('awayShort');
    sideEl.classList.toggle('is-home', homeAway === 'home');
    sideEl.classList.toggle('is-away', homeAway === 'away');
  } else {
    sideEl.hidden = true;
    sideEl.classList.remove('is-home', 'is-away');
  }
  node.querySelector('.team-name-en').textContent = name;
  node.querySelector('.team-name-zh').textContent = nameZh || '';
  // ESPN's own `score` comes through as a numeric STRING (ints only ever
  // arrive as text over that API); ` Number()` here also means a poll's own
  // later NUMBER write (see pollLiveMatches) and a fresh rebuild's STRING
  // both render identically regardless of which type currently holds the
  // field, rather than a plain `${score}` risking a stray decimal or NaN.
  const scoreEl = node.querySelector('.team-score');
  const numericScore = Number(score);
  if (showScore && Number.isFinite(numericScore)) {
    scoreEl.hidden = false;
    scoreEl.textContent = String(numericScore);
  } else {
    scoreEl.hidden = true;
  }
  return node;
}

function renderVenue(el, match) {
  el.textContent = match.venue || '';
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// The already-tuned sport accent color this app uses everywhere else (see
// styles.css's `.sport-badge[data-sport=...]` rules) - the fallback for
// when NEITHER of a team's own two real colors reads legibly against the
// card's current background (see pickReadableTeamColor), so the bar always
// shows something readable rather than the pure-illegible team color as-is.
const SPORT_ODDS_FALLBACK_VAR = { MLB: '--sport-mlb', NBA: '--sport-nba', 'Premier League': '--sport-epl' };

function teamOddsColor(competitor, sport) {
  const backgroundHex = cssVar('--bg-elevated') || cssVar('--bg');
  const readable = pickReadableTeamColor(competitor?.color, competitor?.altColor, backgroundHex);
  if (readable) return readable;
  const fallbackVar = SPORT_ODDS_FALLBACK_VAR[sport];
  return fallbackVar ? `var(${fallbackVar})` : 'var(--accent)';
}

function createMatchCardNode() {
  return cardTemplate.content.firstElementChild.cloneNode(true);
}

// Populates a match-card node - either a brand new one (buildMatchCard
// below) or an EXISTING, already-on-screen one being patched in place (see
// getOrBuildMatchCard's own comment for why: reusing the same node across a
// routine background refresh is what actually stops its team-logo <img>
// elements from visibly flashing on every 30s/60s poll, which recreating
// them from the template fresh every time - the old, single `buildMatchCard`
// behavior - could not avoid). Every branch below that only ever SET a
// hidden/class/text state and never had a matching reset (fine for a fresh
// clone, which already starts from the template's own blank defaults) had
// to gain one, since a reused node can walk in already carrying whatever the
// PREVIOUS render for this same match id left behind.
function updateMatchCard(node, match) {
  // Lets a later render find and patch THIS exact card by id without
  // rebuilding it from scratch - see getOrBuildMatchCard's own reuse
  // mechanism, which relies on this to look an already-mounted card up
  // again next render instead of tearing it down and losing its already-
  // decoded team-logo images.
  node.dataset.matchId = match.id;
  // Computed once, up front, and reused everywhere below (team-row score
  // visibility, the live-status widget, the .is-live/.is-finished class) -
  // see matchLifecycleState's own comment for why this is the one place
  // "what point in its lifecycle is this match at" gets answered, rather
  // than each caller re-deriving it ad hoc against a plain nominal end time.
  const lifecycle = matchLifecycleState(match);
  const isCurrentlyLive = lifecycle === LIFECYCLE_STATES.LIVE || lifecycle === LIFECYCLE_STATES.ENDING_SOON;
  const start = Date.parse(match.startTimeUtc);
  // For a FINISHED match, match.durationMinutes is already the real
  // observed elapsed time (see match-builder.mjs's finishedDurationMinutes) -
  // no forward uncertainty left to hedge. For one that hasn't finished yet,
  // the displayed end time uses estimatedDurationMinutes (recommendation.mjs)
  // - the SAME real-clock-overrun-padded estimate schedulingDurationMinutes
  // already uses internally to decide when the NEXT match can safely start
  // - not the bare pre-game durationMinutes. Showing the viewer the bare
  // figure told them a low-reliability, no-clock sport (MLB - extra
  // innings, rain delays, see SPORT_TIMING's own comment) would end sooner
  // than this app's own scheduler already assumes it realistically might -
  // live-reported as "MLB almost always runs past its shown end time",
  // which this app's own internal padding had already anticipated but
  // never actually showed on the card itself.
  const end = start + (match.isFinished ? match.durationMinutes : estimatedDurationMinutes(match)) * 60_000;

  if (match.timeTbd) {
    // startTimeUtc is only a placeholder for a TBD fixture (see
    // match-builder.mjs's isTimeTbd) - showing it as a real clock time would
    // just be a confident-looking guess, so this says plainly that it
    // isn't known yet instead.
    node.querySelector('.match-time-range').textContent = t('timeTbd');
    node.querySelector('.match-time-relative').textContent = '';
  } else {
    // One line, not three stacked labels - "7:00 – 9:35 下午" reads at a
    // glance where a separate start time / end time / relative-countdown
    // column used to take real hunting to parse, especially on a phone.
    node.querySelector('.match-time-range').textContent =
      `${localTimeFormatter().format(new Date(start))} – ${localTimeFormatter().format(new Date(end))}`;
    // A finished match's real end time rarely matches `end` above (that's
    // only ever durationMinutes' per-sport AVERAGE - see match-builder.mjs's
    // isFinished comment), so this says "已結束" (plus the final score,
    // when ESPN reported both as plain numbers) instead of a relative
    // countdown/直播中 that would otherwise still be computed from that
    // same unreliable estimated end time.
    node.querySelector('.match-time-relative').textContent = match.isFinished
      ? finishedLabel(match)
      : relativeLabel(match);
  }

  const badge = node.querySelector('.sport-badge');
  // A match's own sport never changes across its lifetime, so a reused node
  // (see this function's own top comment) that already has the right icon
  // never needs it rebuilt - `badge.dataset.sport` (read BEFORE being
  // overwritten just below) is what a fresh clone never has set yet, so this
  // still runs exactly once for a brand new card too.
  if (badge.dataset.sport !== match.sport) {
    node.querySelector('.sport-icon').replaceWith(buildSportIcon(match.sport));
  }
  badge.dataset.sport = match.sport;
  node.querySelector('.sport-badge-text').textContent = sportLabel(match.sport);

  // Only shown once there's an actual score worth showing - a pre-game
  // fixture's own "0" from ESPN isn't a real score yet, it's just the
  // absence of one, and showing it would read as the match already being
  // 0-0 rather than not yet started. Reported directly: the live status
  // widget (inning/quarter/lap - see buildLiveStatusNode below) showed
  // "states" like the inning or game clock but never the actual score
  // itself, so a viewer had no way to see who was actually ahead without
  // leaving the page - team-score fixes that gap, the live widget still
  // owns the in-progress DETAIL neither team's own score line could show.
  const showScore = isCurrentlyLive || match.isFinished;

  // Reuses this card's EXISTING team-row nodes (and therefore their already-
  // decoded <img> logos - see updateTeamRow's own src-unchanged guard) when
  // the shape already matches, instead of always tearing teamsEl down and
  // rebuilding fresh rows from the template - the other half of this
  // function's own top-comment fix, since a match's own competitor shape
  // (two teams vs. a single F1-style entry) never changes across its
  // lifetime, so this only ever really takes the "rebuild" path once, the
  // very first time this match id is rendered at all.
  const teamsEl = node.querySelector('[data-teams]');
  const existingRows = Array.from(teamsEl.querySelectorAll(':scope > .team-row'));
  const existingAt = teamsEl.querySelector(':scope > .team-at');
  if (match.competitors && match.competitors.length === 2) {
    const [away, home] = match.competitors;
    let awayRow, atSpan, homeRow;
    if (existingRows.length === 2 && existingAt) {
      [awayRow, homeRow] = existingRows;
      atSpan = existingAt;
    } else {
      teamsEl.replaceChildren();
      awayRow = createTeamRowNode();
      atSpan = document.createElement('span');
      atSpan.className = 'team-at';
      atSpan.textContent = 'vs';
      homeRow = createTeamRowNode();
      teamsEl.append(awayRow, atSpan, homeRow);
    }
    updateTeamRow(awayRow, { ...away, showScore });
    updateTeamRow(homeRow, { ...home, showScore });
  } else {
    let soloRow;
    if (existingRows.length === 1 && !existingAt) {
      soloRow = existingRows[0];
    } else {
      teamsEl.replaceChildren();
      soloRow = createTeamRowNode();
      teamsEl.appendChild(soloRow);
    }
    // Marks this row as having neither a side tag nor a score (F1's own
    // case, the only sport with a single competitor) - see styles.css's
    // own `.team-row.is-solo .team-name-en` rule for why: the plain
    // `.team-name-en` rule reserves room for both regardless, which left a
    // real race name clipped far earlier than it needed to be. A match's
    // own competitor shape never changes across its lifetime (see this
    // function's own top comment), so this is safe to set unconditionally
    // on every render rather than needing a matching removal elsewhere.
    soloRow.classList.add('is-solo');
    updateTeamRow(soloRow, { logo: match.logo, name: match.name, nameZh: match.nameZh });
  }

  // Sport-specific live in-progress widget (see buildLiveStatusNode above) -
  // gated on matchLifecycleState directly rather than match.isFinished
  // alone, so this never shows for a not-yet-started fixture either, even
  // though match.live can now genuinely survive a near-term/full-window
  // rebuild (see mergeFreshMatches's own comment on why it's deliberately
  // carried forward) - this lifecycle gate is what actually decides
  // whether the widget renders, not merely whether the field exists.
  const liveStatusEl = node.querySelector('.match-live-status');
  const liveStatusNode = isCurrentlyLive ? buildLiveStatusNode(match) : null;
  liveStatusEl.replaceChildren(...(liveStatusNode ? [liveStatusNode] : []));
  liveStatusEl.hidden = !liveStatusNode;

  // A real Polymarket prediction market's own devigged trade price (see
  // ./lib/polymarket.mjs) as a live win-probability bar - only rendered
  // when a real market has actually opened for this fixture. Never a
  // guessed/defaulted 50/50 - hidden entirely rather than showing a fake
  // number when the market itself hasn't weighed in. EPL's own market is a
  // real three-outcome one (away/draw/home) rather than MLB/NBA's two, so
  // this renders a middle draw segment whenever oddsWinPctDraw is real,
  // and otherwise falls back to the plain two-segment bar.
  const oddsEl = node.querySelector('.match-odds');
  if (
    match.competitors &&
    match.competitors.length === 2 &&
    Number.isFinite(match.oddsWinPctAway) &&
    Number.isFinite(match.oddsWinPctHome)
  ) {
    const [away, home] = match.competitors;
    const hasDraw = Number.isFinite(match.oddsWinPctDraw);
    oddsEl.hidden = false;
    oddsEl.querySelector('.match-odds-away').textContent = `${Math.round(match.oddsWinPctAway)}%`;
    oddsEl.querySelector('.match-odds-home').textContent = `${Math.round(match.oddsWinPctHome)}%`;
    const awaySeg = oddsEl.querySelector('.match-odds-seg-away');
    const drawSeg = oddsEl.querySelector('.match-odds-seg-draw');
    const homeSeg = oddsEl.querySelector('.match-odds-seg-home');
    // Each segment gets ITS OWN team's real color (see ./lib/color.mjs) -
    // never one fixed color for both sides, which read as arbitrary rather
    // than "which team is this" at a glance.
    awaySeg.style.width = `${match.oddsWinPctAway}%`;
    awaySeg.style.background = teamOddsColor(away, match.sport);
    homeSeg.style.width = `${match.oddsWinPctHome}%`;
    homeSeg.style.background = teamOddsColor(home, match.sport);
    drawSeg.hidden = !hasDraw;
    if (hasDraw) {
      drawSeg.style.width = `${match.oddsWinPctDraw}%`;
      drawSeg.querySelector('.match-odds-seg-label').textContent = `${Math.round(match.oddsWinPctDraw)}%`;
    }
    oddsEl.setAttribute(
      'aria-label',
      hasDraw
        ? t('winProbAriaWithDraw', {
            away: away.name,
            awayPct: Math.round(match.oddsWinPctAway),
            drawPct: Math.round(match.oddsWinPctDraw),
            home: home.name,
            homePct: Math.round(match.oddsWinPctHome)
          })
        : t('winProbAria', {
            away: away.name,
            awayPct: Math.round(match.oddsWinPctAway),
            home: home.name,
            homePct: Math.round(match.oddsWinPctHome)
          })
    );
  } else {
    // Explicit reset, not just "leave it as the template default" - this
    // node may be a REUSED one (see this function's own top comment) that
    // already had the bar showing from an earlier render.
    oddsEl.hidden = true;
  }

  // F1's own real Polymarket odds - an outright winner market across the
  // whole grid, not a two-sided bar (see ./lib/polymarket.mjs and this
  // element's own CSS comment for why this needs an entirely different
  // shape) - just the top few favorites, each already a real devigged
  // win% for that specific driver.
  const outrightEl = node.querySelector('.match-odds-outright');
  if (Array.isArray(match.oddsFavorites) && match.oddsFavorites.length) {
    outrightEl.hidden = false;
    const items = outrightEl.querySelectorAll('.match-odds-outright-item');
    items.forEach((item, i) => {
      const favorite = match.oddsFavorites[i];
      item.hidden = !favorite;
      if (favorite) item.textContent = `${favorite.name} ${Math.round(favorite.pct)}%`;
    });
    // Qualifying's own market is "who gets pole position", not "who wins
    // the Grand Prix" - see resolvePoleWinnerOdds's own comment - so the
    // label has to say which one this actually is rather than always
    // reading as a race-winner probability.
    const outrightLabel = match.id.endsWith('-qual') ? t('poleOdds') : t('titleOdds');
    outrightEl.querySelector('.match-odds-outright-label').textContent = outrightLabel;
    outrightEl.setAttribute(
      'aria-label',
      t('outrightAria', {
        label: outrightLabel,
        items: match.oddsFavorites.map(f => `${f.name} ${Math.round(f.pct)}%`).join(t('commaSeparator'))
      })
    );
  } else {
    outrightEl.hidden = true; // see the odds bar's own reset comment just above
  }

  // The race's own current running order (see f1LeaderboardNode above) -
  // extra live context sitting right under the static outright odds above,
  // only while the race is actually LIVE (a pre-race outright market has
  // no "current leader" to show yet, and a finished one already has its
  // own final result reflected in match.oddsFavorites/winner elsewhere).
  const leaderboardEl = node.querySelector('.match-live-leaderboard');
  const leaderboardNode = isCurrentlyLive ? f1LeaderboardNode(match) : null;
  leaderboardEl.replaceChildren(...(leaderboardNode ? [leaderboardNode] : []));
  leaderboardEl.hidden = !leaderboardNode;

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
      // Same src-unchanged guard as updateTeamRow's own logo handling, and
      // for the same reason - a reused card (see this function's own top
      // comment) whose service logo hasn't actually changed shouldn't have
      // its already-decoded <img> restarted on every routine render.
      if (badgeLogo.getAttribute('src') !== service.logo) {
        badgeLogo.src = service.logo;
        delete badgeLogo.dataset.loadFailed;
      }
      badgeLogo.alt = service.label;
      // Refreshed every render (unlike the listener below) so the fallback
      // it applies always matches the CURRENT service, even in the
      // (unlikely) case this match's resolved service changes without its
      // logo URL also changing.
      badgeLogo._fallbackService = service;
      // Same defensive fallback as team logos (updateTeamRow) - an
      // external Commons hotlink can fail for reasons with nothing to do
      // with this page (rate limiting, an outage, the file being moved),
      // and the plain colored-initial badge is a fine fallback rather
      // than an empty box. Bound once per node, ever (see updateTeamRow's
      // own comment on why `{ once: true }` alone isn't enough for a node
      // that can be reused across many future `src` reassignments) - reads
      // `_fallbackService` above at FIRE time, not at bind time, so it
      // never acts on a stale service from whenever this listener happened
      // to first attach.
      if (!badgeLogo.dataset.errorBound) {
        badgeLogo.dataset.errorBound = '1';
        badgeLogo.addEventListener('error', () => {
          badgeLogo.dataset.loadFailed = '1';
          badgeLogo.hidden = true;
          const fallback = badgeLogo._fallbackService;
          if (fallback && fallback.badge) {
            badgeText.hidden = false;
            badgeText.textContent = fallback.badge;
            badge.style.background = fallback.color;
          } else {
            badge.hidden = true;
          }
        });
      }
      // Re-derives the full display state from `loadFailed` every render
      // (rather than trusting whatever the listener above last left behind)
      // so a reused node always reflects the CURRENT service correctly.
      if (badgeLogo.dataset.loadFailed === '1') {
        badgeLogo.hidden = true;
        if (service.badge) {
          badgeText.hidden = false;
          badgeText.textContent = service.badge;
          badge.style.background = service.color;
        } else {
          badge.hidden = true;
        }
      } else {
        badgeLogo.hidden = false;
        badgeText.hidden = true;
      }
    } else if (service && service.badge) {
      badge.hidden = false;
      badgeLogo.hidden = true;
      badgeText.hidden = false;
      badgeText.textContent = service.badge;
      badge.style.background = service.color;
    } else {
      badge.hidden = true;
    }
  } else {
    watchEl.hidden = true; // reset for a reused node - see this function's own top comment
  }

  // "推薦" is the SYSTEM's own judgment (computeDayPlan's scheduling
  // decision) - a card that's only in the plan because the viewer swiped
  // to it (see pinSlotChoice) isn't that, it's the viewer's own choice, so
  // it gets a visually distinct "偏好" tag instead. Using "推薦" for both
  // would misattribute a viewer's pick as the algorithm's recommendation.
  const recommendedTag = node.querySelector('.recommended-tag');
  if (match.isPreferred) {
    recommendedTag.hidden = false;
    recommendedTag.textContent = t('preferredTag');
    recommendedTag.classList.add('is-preferred');
  } else if (match.recommended) {
    recommendedTag.hidden = false;
    // Explicit "推薦"/no-is-preferred reset, not just the template's own
    // baked-in default text - a reused node (see this function's own top
    // comment) that showed "偏好" on an earlier render, before a pin got
    // released, would otherwise keep reading "偏好" forever.
    recommendedTag.textContent = t('recommendedTag');
    recommendedTag.classList.remove('is-preferred');
  } else {
    recommendedTag.hidden = true;
    recommendedTag.classList.remove('is-preferred');
  }

  // The generic factor-label reason line ("依雙方戰績、近期戰況...計算。" -
  // see match-builder.mjs's buildObjectiveReasonZh) was reported as useless:
  // it never says anything a viewer couldn't already tell from the card
  // itself (which factors happen to feed a deterministic formula, not
  // anything about the actual matchup), and reads as boilerplate repeated
  // near-identically across most cards of the same sport. The underlying
  // `match.reason`/`match.objectiveFactors` fields are kept (still useful
  // for scripts/evaluate-recommendations.mjs and debugging matches.json
  // directly) - this just stops surfacing that boilerplate line in the UI.
  const reasonEl = node.querySelector('.match-reason');
  reasonEl.hidden = true;

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
  // Only ever names a RECOMMENDED earlier match (isPreferred - a viewer's
  // own swiped-to pin - is always also .recommended, see computeDayPlan's
  // own forcedIds) - never an arbitrary non-recommended one. Reported
  // directly: this note was naming whatever overlapping match happened to
  // sort first even when it was itself just some other unrecommended
  // fixture nobody would actually be watching instead - noise, not a real
  // "you could be watching X instead" case. If no overlapping match is
  // actually recommended, this simply shows nothing, rather than a
  // meaningless overlap against a random card.
  // Excludes any match that's a NEAR-TOTAL overlap of this one (see
  // isNearTotalOverlap) - those are this match's own swipe-stack alternates
  // (see buildMatchStack/computeDayPlan's alternativeIds), not a genuine
  // "you could be watching a different, earlier game instead" conflict.
  // Reported directly: this note was comparing a card against its OWN
  // stack-mate ("of course they overlap, that's the whole reason they're
  // in the same stack together") instead of only against a real, separate
  // neighboring match - noise, not information, on every multi-member
  // stack's own alternates.
  const conflictNote = node.querySelector('.conflict-note');
  // Reset up front, not just set-when-true below - a reused node (see this
  // function's own top comment) that showed a conflict/mute/recommended
  // state on an earlier render must not keep it once the underlying
  // condition stops holding (a rotation swap, a pin, a slate reshuffle).
  conflictNote.classList.remove('is-info');
  node.classList.remove('is-muted', 'is-recommended');
  const earlierOverlaps = state.matches
    .filter(
      m =>
        (match.overlappingIds || []).includes(m.id) &&
        Date.parse(m.startTimeUtc) < Date.parse(match.startTimeUtc) &&
        !isNearTotalOverlap(match, m) &&
        m.recommended
    )
    .sort((a, b) => Date.parse(b.startTimeUtc) - Date.parse(a.startTimeUtc));
  const earlierOverlap = earlierOverlaps[0];
  if (earlierOverlap) {
    const range = computeOverlapRange(match, earlierOverlap);
    const mins = range ? Math.round((range.end - range.start) / 60_000) : null;
    const clause =
      mins === null
        ? t('overlapGeneric')
        : mins < 60
          ? t('overlapMinutes', { mins })
          : mins % 60
            ? t('overlapHoursMinutes', { hours: Math.floor(mins / 60), mins: mins % 60 })
            : t('overlapHours', { hours: Math.floor(mins / 60) });
    conflictNote.hidden = false;
    conflictNote.textContent = t('conflictNote', { name: earlierOverlap.name, clause });
    // Dimming (is-muted) is decided by renderAllMatchesSection now - see
    // its own comment; this only styles the note itself.
    if (match.recommended) conflictNote.classList.add('is-info');
  } else {
    conflictNote.hidden = true;
    conflictNote.textContent = '';
  }
  if (match.recommended) node.classList.add('is-recommended');

  // "設為偏好" - lets a viewer promote THIS card into a hard pin directly,
  // without needing it to already be a member of some other slot's swipe
  // stack - see preferMatch's own comment for why this exists (a slot with
  // only one cluster member has no swipe stack at all to act on). Never
  // shown for a match that's already the plan's own choice (nothing to
  // override) or a quiet-hours fixture (computeDayPlan excludes those from
  // every candidate set outright, so pinning one would silently do nothing).
  const preferBtn = node.querySelector('.match-prefer-btn');
  if (!match.isFinished && !match.recommended && !isQuietHours(match)) {
    preferBtn.hidden = false;
    preferBtn.textContent = t('preferMatchBtn');
    // `_match` is refreshed every render; the click listener itself is
    // bound exactly once per node, ever (see updateTeamRow's own comment on
    // why a reused node needs this) and always reads the CURRENT match off
    // it at click time, rather than a new render adding another listener
    // closed over an increasingly stale `match` on top of every earlier one.
    preferBtn._match = match;
    if (!preferBtn.dataset.bound) {
      preferBtn.dataset.bound = '1';
      preferBtn.addEventListener('click', () => preferMatch(preferBtn._match));
    }
  } else {
    preferBtn.hidden = true;
  }

  // Same single source of truth as relativeLabel/the live-status line above
  // (matchLifecycleState, computed once as `lifecycle`/`isCurrentlyLive`) -
  // isFinished (ESPN's own status) always wins, and LIVE/ENDING_SOON both
  // read as "still live" for styling purposes; a match already underway
  // that's simply run past its estimated end (see estimatedDurationMinutes)
  // stays styled live rather than falling back to plain/upcoming.
  node.classList.remove('is-finished', 'is-live');
  if (lifecycle === LIFECYCLE_STATES.ENDED) {
    node.classList.add('is-finished');
  } else if (isCurrentlyLive) {
    node.classList.add('is-live');
  }

  return node;
}

function buildMatchCard(match) {
  return updateMatchCard(createMatchCardNode(), match);
}

// Looks up an already-mounted card for this match id within `container`
// (scoped per-container - see this function's own call sites, since the
// SAME match can be showing simultaneously as its own separate card in both
// the Recommended and All-matches sections) and patches it in place instead
// of tearing it down and rebuilding a fresh one from the template - the fix
// for the team-logo flash a routine background poll (live score, near-term
// refresh, background odds enrichment) caused on every one of these cards,
// not just the ones that actually changed.
function getOrBuildMatchCard(match, existingCardsById) {
  const existing = existingCardsById && existingCardsById.get(match.id);
  if (existing) return updateMatchCard(existing, match);
  return buildMatchCard(match);
}

// Direct children of `container` already carrying a `data-match-id` - i.e.
// plain (non-stacked) cards from a PREVIOUS render of this same container,
// available for getOrBuildMatchCard above to reuse. Deliberately `:scope >`
// (direct children only): a `.match-stack`'s own inner card is nested two
// levels deep and never a direct child, so a stack's swipeable card is never
// accidentally pulled out from under its own drag handlers by this (see
// buildMatchStack's own comment on why that card is always freshly built).
function collectExistingCardsById(container) {
  const map = new Map();
  container.querySelectorAll(':scope > [data-match-id]').forEach(el => map.set(el.dataset.matchId, el));
  return map;
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

// The near-term refresh tier's own guaranteed coverage boundary (see
// NEAR_TERM_DAYS_AHEAD, declared later in this file but already fully
// initialized by the time this actually runs - module evaluation finishes
// before init() ever calls anything) - a day past this one is only
// "pending" (see isDayPending below), never "confirmed empty", until the
// full window has had its own chance to say otherwise. Computed fresh
// every call, not cached, since "today" itself advances as the tab stays
// open.
function nearTermBoundaryKey() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return localDateKey(new Date(today.getTime() + (NEAR_TERM_DAYS_AHEAD - 1) * 86_400_000));
}

// True for a day this tab genuinely has no data for yet - past what the
// near-term tier already guarantees, AND with zero matches of ANY sport
// already sitting in state.allRawMatches for it (a prior full-window
// refresh this session, or a painted snapshot from last visit, already
// answered for this specific day even if state.fullWindowLoaded itself
// hasn't gone true again yet this load) - false once state.fullWindowLoaded
// confirms the whole window is current. The whole point: state.matches
// alone can't tell "this far-future day genuinely has nothing on" apart
// from "this far-future day simply hasn't been fetched yet" - both are
// zero matches either way - and conflating them is exactly what produced
// the reported day-count "jump" (a day's own pill popping in/out of
// existence the instant real data happened to land) as well as a
// genuinely wrong "這一天沒有賽事" for a day that in fact just hadn't
// loaded - live-reported as wanting the currently-viewed day painted
// immediately, the rest loaded in the background, AND a not-yet-loaded
// day handled gracefully rather than shown as if it were confirmed empty.
function isDayPending(dayKey) {
  if (state.fullWindowLoaded) return false;
  // This day specifically falls within near-term's own coverage AND
  // near-term has actually resolved at least once - confirmed, even if it
  // turned out genuinely empty. state.nearTermLoaded is what tells that
  // apart from a genuinely quiet day (see its own comment) - the app never
  // shows anything at all until the first of snapshot/near-term/full-window
  // succeeds (see init()), so this only matters for a day whose own data
  // hasn't arrived yet even though SOME data already has (e.g. tomorrow,
  // rendered alongside an already-real today).
  if (state.nearTermLoaded && dayKey <= nearTermBoundaryKey()) return false;
  // Not yet authoritatively checked either way by a tier flag above - but
  // real data for this EXACT day (a painted snapshot, an earlier
  // successful fetch this session) is still a real answer even before
  // the relevant tier flag catches up.
  return !state.allRawMatches.some(m => localDateKey(new Date(m.startTimeUtc)) === dayKey);
}

// A day genuinely worth showing as a clickable pill at all - state.days
// itself stays the FULL fetched window (every other piece of logic that
// walks it, e.g. ensureSelectedDayHasActiveSport's "jump to the nearest day
// that actually has a match", still needs the complete list to jump
// through) - this is only the UI-facing subset: a day with nothing to show
// isn't worth a tap target, and that's just as true when a sport filter is
// active (a day empty of MLB specifically shouldn't get a pill while "MLB"
// is the active filter, even though it might have other sports going on).
// A PENDING day (see isDayPending) is the one exception - always shown,
// regardless of the active sport filter, since there's no way yet to know
// whether it'll turn out to have anything worth a tap target at all; it
// just renders dimmed (see .day-pill--pending) until it resolves one way
// or the other.
function visibleDays() {
  return state.days.filter(day => {
    if (isDayPending(day.key)) return true;
    const dayMatches = matchesForDay(day.key);
    return state.activeSport === 'all'
      ? dayMatches.length > 0
      : dayMatches.some(m => m.sport === state.activeSport);
  });
}

function renderDayScroller() {
  // Every day that actually has something to show, up front, no "load
  // more" click - the whole window is already in memory once the
  // full-window refresh tier lands (see refreshFullWindow/DEFAULT_DAYS_AHEAD),
  // so there's no cost to showing all of it right away; a click-to-reveal
  // step here would only ever hide days that were already sitting in
  // memory.
  const nodes = visibleDays().map(day => {
    const pending = isDayPending(day.key);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = pending ? 'day-pill day-pill--pending' : 'day-pill';
    if (pending) btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(day.key === state.selectedDayKey));
    btn.innerHTML = `<span class="day-pill-label">${dayLabelFor(day.date, { short: day.key !== localDateKey(new Date()) })}</span>`;
    btn.addEventListener('click', () => {
      tapLog(`[app] day tab handler ${day.key}`);
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
      label.textContent = sport === 'all' ? t('filterAll') : sportLabel(sport);
      btn.appendChild(label);
      btn.setAttribute('aria-pressed', String(sport === state.activeSport));
      btn.addEventListener('click', () => {
        state.activeSport = sport;
        // baseDayCandidates (and therefore the cached rotation plan) is
        // scoped to the active sport filter - a filter change means every
        // day's own candidate set just changed, so the cache is stale.
        invalidateVarietyRotation();
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
// groupIntoSlots) - a tap-to-switch card stack: exactly one member is shown
// at a time, plus prev/next arrows and directly-tappable dots to switch to
// another. Tapping a control PINS that match immediately (see
// pinSlotChoice/computeDayPlan) - matches before and after it reflow to
// connect with it instead of with whichever match was the plan's own
// default pick.
//
// Deliberately NOT a drag/swipe gesture - see this function's own git
// history for the two designs this replaced (native scroll-snap polling for
// momentum to settle, then a hand-rolled Touch-Events drag with a CSS
// transform) and the string of real, live-reported regressions BOTH kept
// producing on real Safari: stuck cards, a stack frozen solid after a
// single swipe, cards landing on the wrong index. Every one of those bugs
// came from the same root cause - inferring "the gesture is done, it is now
// safe to commit and reparent this DOM node" from some signal (a poll, a
// frame count, a transitionend event) that real WebKit didn't reliably
// deliver when this codebase needed it to. A tap has no such problem: a
// `click` handler fires exactly once, synchronously, with nothing further
// to wait for - there is no gesture-in-progress state this node can get
// stuck in, because there is no gesture, only a discrete press. This also
// means every render can simply show whichever member is currently primary,
// with no separate DOM-node-reuse mechanism needed to avoid a visible
// flash (see this file's own git history for the old interactedStack/
// patchStackSelectionTags machinery that existed only to work around that)
// - and no scroll position or open touch sequence than can ever survive
// (or fail to survive) a render pass, so this is also the direct fix for
// "one swipe reused an old stale visual state forever" (a `.is-muted` class
// that patchStackSelectionTags never got around to clearing being the
// concrete case reported).
// Tracks whether a card is currently mid-drag, ACROSS every rendered stack
// (a plain counter, not a single boolean, since it's shared module state
// and simplest to just never go negative rather than assume only one
// stack can ever be dragged at a time). renderSections (below) defers
// itself while this is nonzero instead of tearing the DOM out from under
// an active gesture - see that function's own comment for the two real,
// reported bugs this fixes: a team-logo flash on every background-
// triggered re-render (a routine live-data poll arriving mid-interaction)
// and a swipe silently breaking
// mid-drag (the dragged card's own DOM node, and its pointer capture, gets
// removed out from under an active pointerdown, so the browser has
// nowhere left to deliver the rest of that gesture's move/up events).
let activeSwipeCount = 0;
let rerenderPendingAfterSwipe = false;

function startTrackingSwipe() {
  activeSwipeCount += 1;
}

// Idempotent per gesture - buildMatchStack's own endDrag/pointercancel/
// lostpointercapture handlers all funnel through resetDrag, which calls
// this once per gesture regardless of which of those three actually ended
// it, guarded by `isTrackingSwipe` there so a gesture that never really
// started (e.g. a vertical drag let go early) never double-decrements.
function stopTrackingSwipe() {
  activeSwipeCount = Math.max(0, activeSwipeCount - 1);
  if (activeSwipeCount === 0 && rerenderPendingAfterSwipe) renderSections();
}

// `host` is set only for a stack a viewer pin was added to (see
// renderRecommendedSection's isViewerPinStack): the displaced pick whose
// stack it joined. The pinned card then sits right next to `host` instead
// of wherever its own start time falls, and a swipe/arrow off it in EITHER
// direction goes back to `host` - which clears the pin and restores the
// day - rather than to whichever alternative happened to be its time-order
// neighbor. Live-reported: swiping back from a preferred game "quietly
// switched" the stack to an alternative as a 偏好 the viewer never set.
// Tapping a specific dot still goes straight to that card.
function buildMatchStack(dayKey, members, primary, isTopOfDay, host = null) {
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
  wrapper.dataset.slotKey = slotKey;

  const hint = document.createElement('p');
  hint.className = 'match-stack-hint';
  hint.textContent = t('matchStackHint');

  // A FIXED order (by start time, earliest first), independent of which
  // member is currently primary - so the dots/arrows always land in the
  // same visual order across renders, rather than reshuffling around
  // whichever member just got pinned. Time, not viewerScore - a viewer
  // switching through a stack's alternates expects them laid out in the
  // order they'll actually happen, not shuffled by which one this app
  // liked best (live-reported: "stacked card is not stacking in time
  // order"). startTimeUtc ties (two members starting at literally the same
  // instant) fall back to id for a still-deterministic order.
  const ordered = members
    .filter(m => !host || m.id !== primary.id)
    .sort((a, b) => Date.parse(a.startTimeUtc) - Date.parse(b.startTimeUtc) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (host) ordered.splice(ordered.findIndex(m => m.id === host.id) + 1, 0, primary);
  const currentIndex = Math.max(0, ordered.findIndex(m => m.id === primary.id));
  const hostIndex = host ? ordered.findIndex(m => m.id === host.id) : -1;
  // Where a swipe/arrow step from the current card lands - see `host`.
  const stepIndex = delta => (hostIndex >= 0 ? hostIndex : currentIndex + delta);

  const viewport = document.createElement('div');
  viewport.className = 'match-stack-viewport';
  const card = buildMatchCard(ordered[currentIndex]);
  if (isTopOfDay) card.classList.add('is-pinned');
  viewport.appendChild(card);

  function choose(index) {
    const clamped = Math.min(ordered.length - 1, Math.max(0, index));
    const chosen = ordered[clamped];
    if (!chosen || chosen.id === primary.id) return;
    tapLog(`[app] choose index=${clamped}`);
    pinSlotChoice(dayKey, slotKey, chosen.id);
  }

  // ---- Swipe gesture ------------------------------------------------------
  //
  // A thin input layer on top of choose() - never a second state machine.
  // Rules, each learned from a live-reported Safari bug (see git history and
  // docs/recommendation-engine-audit.md Round 12):
  //   - The commit decision happens synchronously in pointerup, from the
  //     pointer's final position - never in a requestAnimationFrame or
  //     transitionend callback, which Safari can silently never fire (an
  //     earlier version got stuck after one swipe that way).
  //   - Pointer Events + setPointerCapture, so a finger or cursor drifting
  //     outside the card mid-drag doesn't lose the gesture.
  //   - `touch-action: pan-y` (styles.css) lets the browser itself decide
  //     "vertical page scroll" vs. "horizontal swipe".
  //   - On a commit, card.style is left untouched before choose() removes the
  //     card. Writing any transform to it in that same tick left a "ghost"
  //     of the swiped card stuck on screen on iPad Safari.
  //   - pointerup, pointercancel and lostpointercapture all end the drag, so
  //     the card can never be stranded mid-transform.
  //
  // The iOS "every tap needs two taps after a swipe" bug is NOT fixed here -
  // see the page-wide listeners near the top of this file ("DO NOT REMOVE -
  // iOS Safari").
  const SWIPE_COMMIT_PX = 60;
  const SWIPE_START_PX = 8;
  let activePointerId = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragDx = 0;
  let isHorizontalDrag = false;
  // Pairs each startTrackingSwipe() with exactly one stopTrackingSwipe(), so
  // the shared activeSwipeCount can never be left raised (which would make
  // renderSections defer itself forever).
  let isTrackingSwipe = false;

  function setDragTransform(dx) {
    card.style.transition = 'none';
    card.style.transform = `translateX(${dx}px) rotate(${dx / 28}deg)`;
  }

  // Bookkeeping only - deliberately doesn't touch card.style (see the
  // commit rule above). resetDrag() adds the snap-back animation for the
  // cases where the card stays in the DOM.
  function resetDragState() {
    activePointerId = null;
    isHorizontalDrag = false;
    dragDx = 0;
    if (isTrackingSwipe) {
      isTrackingSwipe = false;
      stopTrackingSwipe();
    }
  }

  function resetDrag() {
    resetDragState();
    card.style.transition = 'transform 180ms ease';
    card.style.transform = '';
  }

  // preventDefault() stops a mouse drag that starts on a team-logo <img>
  // from kicking off the browser's native image drag-and-drop (a ghost
  // image following the cursor, outside this code's control). The CSS
  // `-webkit-user-drag: none` on the images covers the same case.
  card.addEventListener('pointerdown', event => {
    if (!event.isPrimary || activePointerId != null) return;
    if (event.target.closest('button')) return; // dots/arrows keep their own click handling
    event.preventDefault();
    tapLog(`[app] swipe begin ${event.pointerType}`);
    activePointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragDx = 0;
    isHorizontalDrag = false;
    isTrackingSwipe = true;
    startTrackingSwipe();
    try { card.setPointerCapture(activePointerId); } catch { /* best-effort */ }
  });

  card.addEventListener('pointermove', event => {
    if (event.pointerId !== activePointerId) return;
    const dx = event.clientX - dragStartX;
    const dy = event.clientY - dragStartY;
    if (!isHorizontalDrag) {
      if (Math.abs(dx) < SWIPE_START_PX && Math.abs(dy) < SWIPE_START_PX) return;
      // More vertical than horizontal: it's a page scroll, not a swipe - let
      // go entirely. No transform applied yet, so no style to reset.
      if (Math.abs(dy) > Math.abs(dx)) {
        const pointerId = activePointerId;
        resetDragState();
        try { card.releasePointerCapture(pointerId); } catch { /* already released */ }
        return;
      }
      isHorizontalDrag = true;
    }
    dragDx = dx;
    setDragTransform(dx);
  });

  function endDrag(event) {
    if (event.pointerId !== activePointerId) return;
    const committedDx = isHorizontalDrag ? dragDx : 0;
    tapLog(`[app] swipe end dx=${Math.round(committedDx)}`);
    if (Math.abs(committedDx) < SWIPE_COMMIT_PX) {
      resetDrag(); // below threshold (or never horizontal) - snap back
      return;
    }
    const targetIndex = stepIndex(committedDx < 0 ? 1 : -1);
    const target = ordered[Math.min(ordered.length - 1, Math.max(0, targetIndex))];
    if (!target || target.id === primary.id) {
      resetDrag(); // already at that end of the stack - snap back
      return;
    }
    resetDragState(); // not resetDrag - see the commit rule above
    choose(targetIndex);
  }

  card.addEventListener('pointerup', endDrag);
  card.addEventListener('pointercancel', resetDrag);
  card.addEventListener('lostpointercapture', () => {
    // isTrackingSwipe too: the vertical-scroll branch already cleared
    // activePointerId but must still have released its activeSwipeCount.
    if (activePointerId != null || isTrackingSwipe) resetDrag();
  });

  const nav = document.createElement('div');
  nav.className = 'match-stack-nav';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'match-stack-arrow';
  prevBtn.setAttribute('aria-label', t('prevMatchAria'));
  prevBtn.textContent = '‹';
  prevBtn.disabled = hostIndex < 0 && currentIndex === 0;
  prevBtn.addEventListener('click', () => choose(stepIndex(-1)));

  const dots = document.createElement('div');
  dots.className = 'match-stack-dots';
  ordered.forEach((match, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'match-stack-dot' + (index === currentIndex ? ' is-active' : '');
    dot.setAttribute('aria-label', t('switchToAria', { name: match.name || index + 1 }));
    dot.addEventListener('click', () => choose(index));
    dots.appendChild(dot);
  });

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'match-stack-arrow';
  nextBtn.setAttribute('aria-label', t('nextMatchAria'));
  nextBtn.textContent = '›';
  nextBtn.disabled = hostIndex < 0 && currentIndex === ordered.length - 1;
  nextBtn.addEventListener('click', () => choose(stepIndex(1)));

  nav.append(prevBtn, dots, nextBtn);
  wrapper.append(hint, viewport, nav);
  return wrapper;
}

// Marks every underway pick the plan chose ON ITS OWN (not a viewer's
// 偏好 pin - that's already a hard pin, and making it sticky would bias
// what "the natural pick" means for pinSlotChoice's swipe-back check) as
// sticky - see state.liveStickyIds. Raising an already-chosen pick's score
// never changes the plan it was chosen in, so this render stays as it is;
// it only stops later renders from swapping that pick out.
function stickLivePicks(dayPlan) {
  // Same reason as recordRenderedDayPlan: a plan rendered before the full
  // window loaded can be a stopgap, and making its live pick sticky would
  // outlast it.
  if (!state.fullWindowLoaded) return;
  let changed = false;
  dayPlan.forEach(match => {
    if (match.isPreferred || state.liveStickyIds.has(match.id) || !isUnderway(match)) return;
    state.liveStickyIds.add(match.id);
    changed = true;
  });
  if (changed) saveLiveStickyIds();
}

function renderRecommendedSection() {
  const dayKey = state.selectedDayKey;
  // A day with no data yet at all (see isDayPending) gets an honest
  // "still loading" instead of computing (and confidently displaying) a
  // plan built from zero candidates, which would otherwise look exactly
  // like a real "nothing recommended today" - directly what was asked
  // for: handle a click onto a day that hasn't loaded yet gracefully
  // rather than showing it as if it had already been checked.
  if (isDayPending(dayKey)) {
    recommendedListEl.replaceChildren();
    state.featuredIds = new Set();
    recommendedEmptyEl.hidden = true;
    if (recommendedLoadingEl) recommendedLoadingEl.hidden = false;
    return;
  }
  if (recommendedLoadingEl) recommendedLoadingEl.hidden = true;
  // Computed fresh every render, scoped to whatever's currently active
  // (day, sport filter, pins) - see computeDayPlan's own comment. Picking
  // "只看 MLB" gets its own MLB-only continuous plan, not the cross-sport
  // plan filtered down to whichever MLB picks happened to survive it.
  const dayCandidates = dayCandidatesForPlan(dayKey);
  const viewerPins = state.pinnedChoices.get(dayKey) || new Set();
  const { plan: dayPlan, baseline } = stableDayPlan(
    dayKey,
    dayCandidates,
    viewerPins,
    rotationRespectingLivePicks(dayKey, getVarietyRotation().get(dayKey))
  );
  // computeDayPlan's own forcedIds mechanism marks every forced pick as
  // .isPreferred (indistinguishable from a real viewer pin) - correct for
  // a genuine pin, wrong for a rotation-forced one (see
  // recommendation.mjs's clearRotationIsPreferred). Put the correct 推薦
  // label back on anything ONLY rotation forced in, never touching an id
  // that's ALSO a real pin.
  clearRotationIsPreferred(dayCandidates, rotationRespectingLivePicks(dayKey, getVarietyRotation().get(dayKey)), state.pinnedChoices.get(dayKey));
  stickLivePicks(dayPlan);
  recordRenderedDayPlan(dayKey, dayPlan);
  const ordered = pinCurrentOrNext(dayPlan);

  if (!ordered.length) {
    recommendedListEl.replaceChildren();
    state.featuredIds = new Set();
    recommendedEmptyEl.hidden = false;
    return;
  }
  recommendedEmptyEl.hidden = true;
  // alternativeIds can point at a fixture on a different (adjacent) local
  // day if the slot straddles midnight for this viewer - resolved from the
  // full state.matches, not just today's bucket, so that edge case doesn't
  // just silently drop the alternative.
  const byId = new Map(state.matches.map(m => [m.id, m]));
  // Each pick's stack comes from the unpinned `baseline` (see stableDayPlan):
  // an ordinary pick keeps its original alternatives, and a viewer's pin
  // joins the stack of whatever baseline pick(s) it displaced - exactly one
  // added card, rather than its own near-total conflicts (games that were
  // greyed out and would suddenly get featured). Swiping off it clears the
  // pin, so it leaves the stack again.
  const baselineById = new Map(baseline.map(m => [m.id, m]));
  const stackAlternativeIds = planStackAlternativeIds(dayPlan, baseline, viewerPins);
  // Per-day, per-slot FROZEN membership - see state.stackMembershipByDay's
  // own comment for why. computeDayPlan's alternativeIds is genuinely
  // recomputed per CHOICE (whichever member the scheduler/a pin actually
  // picked for that slot this render), and two different members of the
  // same big transitive conflict cluster can have very different direct-
  // overlap neighborhoods (a real MLB slate stagger this codebase already
  // documents) - so swiping to a new primary can hand back a larger/
  // different alternatives list than the one the viewer was just looking
  // at, which reads as the stack growing/reshuffling mid-interaction. Once
  // a slot's member set is established on its first render for this day,
  // every later render (a pin, a live poll) keeps showing exactly those
  // same members - only which one is primary/pinned changes.
  let dayMembership = state.stackMembershipByDay.get(dayKey);
  if (!dayMembership) {
    dayMembership = new Map();
    state.stackMembershipByDay.set(dayKey, dayMembership);
  }
  // Each slotKey maps to a LIST of frozen member sets, not one, so two
  // separate stacks from the SAME transitive cluster (see computeDayPlan's
  // own comment on `slotKey`: a 3+-member cluster can produce two
  // independent picks, each its own stack) never share one frozen list.
  // Live-verified 9/23 case: one 15-match MLB cluster produced two picks,
  // 06:35 Blue Jays/Orioles and 09:40 Angels/Athletics, both carrying the
  // same `slotKey`; with a single shared entry the second stack showed the
  // first stack's members - games with no real time conflict with it.
  const claimedFreezeSets = new Set();
  const featuredIds = new Set();
  // Existing plain cards from this SAME container's previous render, up for
  // reuse below (see getOrBuildMatchCard's own comment) - captured once,
  // up front, before this render starts moving any of them into `fragment`.
  const existingCardsById = collectExistingCardsById(recommendedListEl);
  const fragment = document.createDocumentFragment();
  ordered.forEach((match, index) => {
    featuredIds.add(match.id);
    // A FINISHED match is kept in 推薦賽事 purely as viewing HISTORY (see
    // computeDayPlan's own comment on why a finished fixture is a normal,
    // still-scheduled candidate, not silently dropped once it ends) - it
    // can still come back from computeDayPlan with alternativeIds set (its
    // near-total-overlap rivals from earlier that day), but swiping between
    // "what I could have watched instead" for a game that's already over
    // isn't a real choice anymore, just noise on what's supposed to be a
    // simple record of what was on. Always a single plain card here,
    // regardless of alternatives - reported directly: a finished match
    // should never be swipeable.
    if (match.isFinished) {
      const card = getOrBuildMatchCard(match, existingCardsById);
      card.classList.toggle('is-pinned', index === 0);
      fragment.appendChild(card);
      return;
    }
    let alternatives = stackAlternativeIds
      .get(match.id)
      .map(id => byId.get(id))
      .filter(m => m && m.id !== match.id && !m.recommended && !m.isFinished);
    const isViewerPinStack = viewerPins.has(match.id) && !baselineById.has(match.id);
    if (alternatives.length && isViewerPinStack) {
      // Not frozen (see dayMembership below) - this stack exists only while
      // the pin does, and freezing it would leave the pinned game behind in
      // the original stack after the viewer swipes off it.
      // Exactly the cards the host stack was showing (its frozen
      // membership, when there is one) plus this pin - one extra dot.
      const host = alternatives[0];
      const hostKey = (baselineById.get(host.id) || host).slotKey;
      const frozen = hostKey && (dayMembership.get(hostKey) || []).find(set => set.has(host.id));
      if (frozen) {
        alternatives = [host, ...[...frozen].map(id => byId.get(id)).filter(m => m && m !== host && m.id !== match.id && !m.recommended && !m.isFinished)];
      }
      // A pin that was ALREADY one of the host stack's own cards got here by
      // an ordinary swipe/dot inside that stack, not by 設為偏好 from outside
      // it - so it keeps the stack's plain time order and swipes step to the
      // real neighbor. Host mode (pin moved next to the host, every swipe
      // goes back to it) is only for an outside pin. Live-reported on
      // 9/25 Padres @ Dodgers ([Angels, Astros, Padres]): swiping to Astros
      // rebuilt the stack as [Angels, Padres, Astros], so the active dot
      // never moved and the next swipe went straight back to Padres -
      // looping between two of the three cards.
      const joinedFromStack = frozen
        ? frozen.has(match.id)
        : (baselineById.get(host.id)?.alternativeIds || []).includes(match.id);
      const members = [match, ...alternatives];
      // The whole stack is the slot a swipe acts on - the pin's own
      // conflict cluster may not contain the host stack's other cards, and
      // a narrower slotKey would leave the pin behind when the viewer
      // swipes to one of them.
      match.slotKey = slotKeyFromMembers(members);
      members.forEach(m => featuredIds.add(m.id));
      fragment.appendChild(buildMatchStack(dayKey, members, match, index === 0, joinedFromStack ? null : host));
    } else if (alternatives.length) {
      let members = [match, ...alternatives];
      const slotKey = (baselineById.get(match.id) || match).slotKey || slotKeyFromMembers(members);
      // Which of this slotKey's frozen sets belongs to THIS stack - matched
      // by CONTENT (the frozen set that already contains this
      // stack's primary), not by render position: pinCurrentOrNext and a
      // pin can both reorder the plan, and a position-based key then handed
      // one stack's frozen members to a different stack - live-reported as
      // "all live cards disappear, leaving me swiping not-started matches"
      // (a not-started stack inheriting the live stack's frozen list).
      // `claimedFreezeSets` keeps two stacks in one render from sharing a set.
      const freezeSets = dayMembership.get(slotKey) || [];
      const knownIds = freezeSets.find(set => set.has(match.id) && !claimedFreezeSets.has(set));
      if (knownIds) {
        claimedFreezeSets.add(knownIds);
        // Never finished (see computeDayPlan's own alternatives filter), and
        // never `.recommended` (besides `match` itself) - a frozen member
        // that ended up independently recommended elsewhere this render
        // has to stay excluded here too, same invariant computeDayPlan's
        // own alternativeIds already enforces (docs/
        // recommendation-engine-audit.md's Invariant 1: never both
        // recommended and someone else's alternative).
        const stable = [...knownIds]
          .map(id => byId.get(id))
          .filter(m => m && (m.id === match.id || (!m.recommended && !m.isFinished)));
        members = stable;
        alternatives = members.filter(m => m.id !== match.id);
      } else {
        const created = new Set(members.map(m => m.id));
        freezeSets.push(created);
        dayMembership.set(slotKey, freezeSets);
        claimedFreezeSets.add(created);
      }
      if (!alternatives.length) {
        const card = getOrBuildMatchCard(match, existingCardsById);
        card.classList.toggle('is-pinned', index === 0);
        fragment.appendChild(card);
        return;
      }
      const isTopOfDay = index === 0;
      // Always a fresh build - a tap-to-switch stack (see buildMatchStack's
      // own comment) has no scroll position or in-flight gesture that a
      // rebuild could ever visibly disrupt, so there's no need for the old
      // DOM-node-reuse mechanism a drag-based stack once required here.
      members.forEach(m => featuredIds.add(m.id));
      fragment.appendChild(buildMatchStack(dayKey, members, match, isTopOfDay));
    } else {
      const card = getOrBuildMatchCard(match, existingCardsById);
      card.classList.toggle('is-pinned', index === 0);
      fragment.appendChild(card);
    }
  });
  recommendedListEl.replaceChildren(fragment);
  state.featuredIds = featuredIds;
}

function renderAllMatchesSection() {
  // Same "still loading, not actually empty" distinction as
  // renderRecommendedSection's own isDayPending check - see its comment.
  if (isDayPending(state.selectedDayKey)) {
    allMatchListEl.replaceChildren();
    allEmptyEl.hidden = true;
    if (allLoadingEl) allLoadingEl.hidden = false;
    return;
  }
  if (allLoadingEl) allLoadingEl.hidden = true;
  const dayMatches = applySportFilter(matchesForSelectedDay());
  dayMatches.sort((a, b) => Date.parse(a.startTimeUtc) - Date.parse(b.startTimeUtc));

  if (!dayMatches.length) {
    allMatchListEl.replaceChildren();
    allEmptyEl.hidden = false;
    return;
  }
  allEmptyEl.hidden = true;
  // See renderRecommendedSection's own comment on why this reuses already-
  // mounted cards by id instead of always rebuilding fresh ones - this
  // section in particular re-renders in full on every 30s live-score poll,
  // so without reuse EVERY card's team logos (not just the one match whose
  // score actually moved) would flash on every tick.
  const existingCardsById = collectExistingCardsById(allMatchListEl);
  const fragment = document.createDocumentFragment();
  // Greyed out: a finished game, a quiet-hours game, or one that isn't
  // anywhere in the day's 推薦賽事 stacks (state.featuredIds, set by
  // renderRecommendedSection, which renderSections always runs first).
  dayMatches.forEach(match => {
    const card = getOrBuildMatchCard(match, existingCardsById);
    card.classList.toggle('is-muted', match.isFinished || isQuietHours(match) || !state.featuredIds.has(match.id));
    fragment.appendChild(card);
  });
  allMatchListEl.replaceChildren(fragment);
}

function renderSections() {
  // Never tear down/rebuild the card stack while a swipe is actively
  // mid-drag - see activeSwipeCount's own comment for the two real,
  // reported bugs this fixes (a team-logo flash, and a swipe silently
  // breaking because its dragged card's own DOM node - and pointer
  // capture - gets removed out from under it). Deferred, not dropped:
  // stopTrackingSwipe runs this for real the moment the gesture ends.
  if (activeSwipeCount > 0) {
    tapLog(`[app] render DEFERRED activeSwipeCount=${activeSwipeCount}`);
    rerenderPendingAfterSwipe = true;
    return;
  }
  tapLog('[app] render');
  rerenderPendingAfterSwipe = false;
  renderRecommendedSection();
  renderAllMatchesSection();
}

// Fixtures ESPN has on the schedule but hasn't set a real kickoff time for
// yet (see match-builder.mjs's isTimeTbd - almost always a playoff game whose
// bracket slot is set before its exact date/time is) - these never carry a
// trustworthy startTimeUtc, so they're kept entirely out of the day-picker/
// DP pipeline (see applyFreshBuild) and just listed here once, independent
// of whichever day is currently selected, with a "時間未定" label instead
// of a clock time.
function renderTbdSection() {
  if (!state.tbdMatches.length) {
    tbdSection.hidden = true;
    tbdListEl.replaceChildren();
    return;
  }
  tbdSection.hidden = false;
  const existingCardsById = collectExistingCardsById(tbdListEl);
  const fragment = document.createDocumentFragment();
  state.tbdMatches.forEach(match => fragment.appendChild(getOrBuildMatchCard(match, existingCardsById)));
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

// Folds a freshly-built match list into whatever's already loaded, by id -
// an UPSERT, never a wholesale replace. Two real reasons this matters now
// that fetching happens live, repeatedly, in the browser rather than once
// at build time: (1) the near-term refresh tier (see scheduleNearTermRefresh
// below) only ever re-fetches a couple of days' worth of fixtures - a
// wholesale replace would wipe out every far-future day the last FULL
// refresh already populated; (2) buildMatches already degrades a single
// league's own fetch failure to an empty list for just that league rather
// than throwing (see that function's own comment) - replacing the whole
// match set with a result where one league came back empty would delete
// every match of that league from the page over a single transient
// network blip, not just fail to refresh it.
// How many local-calendar days BEFORE today a match is still allowed to
// linger in state.allRawMatches - 1 keeps "昨天" (Yesterday) reachable, per
// this site's own established design (see dayLabelFor's own diffDays===-1
// case), without also keeping the day before that. Enforced in
// mergeFreshMatches below, not at fetch time in match-builder.mjs: that
// file's own 2-UTC-day lookback (see fetchTeamLeagueMatches's comment) is a
// deliberately WIDER net, needed only to correctly capture this viewer's
// own local "yesterday" from a UTC-anchored query - which days actually get
// KEPT afterward is a local-calendar-day question only the browser (which
// alone knows the real viewer's own timezone) can answer correctly.
const MATCH_RETENTION_PAST_DAYS = 1;

function isWithinRetentionWindow(match) {
  return daysFromToday(new Date(match.startTimeUtc)) >= -MATCH_RETENTION_PAST_DAYS;
}

function mergeFreshMatches(freshMatches) {
  const byId = new Map(state.allRawMatches.map(m => [m.id, m]));
  const byTbdKey = new Map(state.tbdMatches.map(m => [m.id, m]));
  freshMatches.forEach(m => {
    if (m.timeTbd) {
      byTbdKey.set(m.id, m);
      return;
    }
    // Carry forward pollLiveMatches's own enrichment - `.live` (inning/
    // quarter/lap detail) and its live-corrected durationMinutes - onto the
    // fresh object replacing this id. buildMatches() itself never sets
    // `.live` at all (only pollLiveMatches does, on its own 30s tier) and
    // always recomputes durationMinutes from the sport's PRE-GAME estimate,
    // not the live-corrected one - so an unconditional overwrite here wiped
    // the live status line and snapped the duration back to its pre-game
    // guess on EVERY near-term (60s) and full-window (5min) refresh, until
    // the next live poll (up to 30s later, on its own independent timer)
    // put it back. Live-reported as "live states sometimes show then
    // disappear again" - this is that cycle.
    const previous = byId.get(m.id);
    // A fixture that's already underway keeps the pre-game score/odds/
    // duration it was planned with all day, instead of being re-scored from
    // ESPN's in-progress feed (which no longer carries the pre-game line) -
    // see freezeStartedMatchScoring's own comment.
    // Falls back to the pre-game scoring this browser saved for the fixture
    // (see state.pregameScoring) when it isn't in memory - a fresh page load
    // after an app update, or a reopen after the snapshot expired.
    freezeStartedMatchScoring(m, previous || state.pregameScoring.get(m.id));
    if (previous?.live && !m.isFinished) {
      m.live = previous.live;
      m.durationMinutes = previous.durationMinutes;
    } else if (m.isFinished && previous && (previous.isFinished || previous.live)) {
      // FREEZE a finished match's own durationMinutes at whatever it was
      // the FIRST time this browser ever saw it finished, rather than
      // trusting buildMatches()'s own fresh finishedDurationMinutes
      // (match-builder.mjs) every single refresh. That function computes
      // "now minus start time" - a fine estimate the moment a fixture
      // ends, but this app has no scheduled rebuild anymore (see that
      // function's own now-stale "15-minute cron" comment - it runs live,
      // in the browser, on every 60s/5min poll), so "now" keeps advancing
      // for as long as the viewer's tab stays open or they revisit later,
      // and the SAME finished match's duration kept growing toward its own
      // per-sport cap (MLB's own 360 minutes) purely from elapsed VIEWING
      // time, not anything about the real broadcast - live-reported as
      // "today's and yesterday's finished MLB matches" showing a
      // suspiciously long duration next to upcoming ones' flat estimate.
      // `previous.durationMinutes` already holds the best real number
      // available: either pollLiveMatches' own last live-tracked value
      // (frozen the instant it stopped correcting, right when `isFinished`
      // first flipped true - see that function's own `!update.isFinished`
      // guard) if this match was ever tracked live in this session, or
      // whatever finishedDurationMinutes's own first honest guess was on
      // the very first refresh that caught it already finished.
      m.durationMinutes = previous.durationMinutes;
    }
    // Carry forward already-resolved odds the same way - buildMatches()
    // always hands back a fresh object with every odds field reset to
    // null/undefined (both refresh tiers call it with `enrichOdds: false`;
    // see enrichOddsInBackground's own comment on why odds is fetched
    // separately), so an unconditional overwrite here blanked the odds bar
    // on EVERY near-term (60s) and full-window (5min) refresh tick, only
    // for enrichOddsInBackground to refill it a moment later once its own
    // fetch resolved - a visible hide-then-reappear flicker on a timer,
    // not an actual odds change. Keeping the previous, still-valid value
    // in place until a real replacement is ready means the bar only ever
    // updates once new numbers have actually arrived, never blanks first.
    if (previous) {
      if (m.oddsWinPctAway == null && previous.oddsWinPctAway != null) m.oddsWinPctAway = previous.oddsWinPctAway;
      if (m.oddsWinPctHome == null && previous.oddsWinPctHome != null) m.oddsWinPctHome = previous.oddsWinPctHome;
      if (m.oddsWinPctDraw == null && previous.oddsWinPctDraw != null) m.oddsWinPctDraw = previous.oddsWinPctDraw;
      if (!m.oddsFavorites && previous.oddsFavorites) m.oddsFavorites = previous.oddsFavorites;
      if (m.oddsSpread == null && previous.oddsSpread != null) m.oddsSpread = previous.oddsSpread;
      if (m.oddsOverUnder == null && previous.oddsOverUnder != null) m.oddsOverUnder = previous.oddsOverUnder;
    }
    byId.set(m.id, m);
  });
  // Without this, an id that ages out of every fetch's own window (near-term
  // and full-window both only ever query forward from "now" plus a couple
  // of lookback days - see match-builder.mjs) never gets removed either: the
  // upsert above only ever ADDS/overwrites by id, so a match fetched once,
  // days ago, would otherwise sit in state.allRawMatches (and the
  // localStorage snapshot it feeds - see saveMatchSnapshot) forever,
  // growing this array without bound over a long-lived tab and directly
  // causing a real, live-reported bug: a fixture from two-plus days ago
  // still showing up as its own day pill (buildDayList adds a pill for
  // every day any match falls on, past or future - see that function's own
  // comment) well past this site's own one-day "昨天" retention design.
  const retained = [...byId.values()].filter(isWithinRetentionWindow);
  return { rawMatches: retained, tbdMatches: [...byTbdKey.values()] };
}

// ---- Instant-paint snapshot (perceived load time) --------------------------
//
// A viewer opening this page on a slow connection used to stare at a blank
// shell until refreshNearTerm()'s own ~18 requests all came back (see "Live
// match data" below) - every single visit re-paid that same network cost
// from zero, even though this same browser had almost certainly already
// built a match list minutes ago. Caching the last successful build to
// localStorage and painting it immediately, before any network request for
// THIS load has even started, turns that into "instant, then quietly
// corrected" - init() below still kicks off the real refresh right away, so
// this is purely a perceived-latency fix, never a substitute for it.
const MATCH_SNAPSHOT_STORAGE_KEY = 'matchfind-match-snapshot';
// Beyond this, a cached snapshot is more likely to actively mislead (a
// finished-vs-still-scheduled fixture, a since-postponed one) than to help -
// past this age it's better to just show the normal loading state and wait
// for a real fetch, same as this app already did before this existed.
const MATCH_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

// A snapshot saved by a PREVIOUS deploy's own code can be built from a
// match/rawMatches shape that deploy's applyFreshBuild/buildMatchCard/etc
// no longer agree with (a renamed field, a new one a newer buildMatchCard
// assumes is always present) - painting it instantly, before this load's
// own real fetch has replaced it, risked showing broken-looking cards (or
// throwing inside applyFreshBuild, per its own try/catch below) for
// whatever the near-term refresh's first few seconds take, on every single
// load after a deploy shipped ANY shape change, not just ones a viewer
// happened to hit mid-refresh. No longer needs its own buildId tag/check -
// wipeStorageOnNewBuild() (top of this file) already guarantees a snapshot
// read back here was written by THIS exact deploy's own code, never a
// previous one; a first-ever visit with no snapshot at all degrades the
// exact same way it always did.
//
// Pre-game scoring per fixture (Map<id, {startTimeUtc, ...PREGAME_SCORING_
// FIELDS}>). mergeFreshMatches hands it to freezeStartedMatchScoring when a
// fixture's previous version isn't in memory - without it, a game that had
// already started or finished was re-scored from ESPN's post-game data on
// the very next merge, a different score than the one it was recommended
// with, which moved it in or out of a variety-rotation pool and reshuffled
// the rest of its series (see computeVarietyRotation). Wiped on every
// deploy along with everything else (see wipeStorageOnNewBuild) - a
// scoring/behavior change this app ships should apply to every fixture
// this load re-fetches, not keep being overridden by a value an OLDER
// deploy's formula already froze in.
const PREGAME_SCORING_STORAGE_KEY = 'matchfind-pregame-scoring';
function pickPregameScoring(match) {
  const entry = { startTimeUtc: match.startTimeUtc };
  PREGAME_SCORING_FIELDS.forEach(field => {
    if (field in match) entry[field] = match[field];
  });
  return entry;
}
function loadPregameScoring() {
  const raw = readStoredJson(PREGAME_SCORING_STORAGE_KEY);
  if (!raw || typeof raw !== 'object') return new Map();
  return new Map(Object.entries(raw).filter(([, entry]) => entry && Number.isFinite(entry.score) && typeof entry.startTimeUtc === 'string'));
}
function savePregameScoring() {
  writeStoredJson(PREGAME_SCORING_STORAGE_KEY, Object.fromEntries(state.pregameScoring));
}
// Called after every merge: by then a started fixture already carries its
// frozen pre-game values (freezeStartedMatchScoring), so storing whatever
// every retained fixture currently has is exactly right. Anything no longer
// retained is dropped with it.
function rememberPregameScoring(rawMatches) {
  state.pregameScoring = new Map(rawMatches.filter(m => Number.isFinite(m.score)).map(m => [m.id, pickPregameScoring(m)]));
  savePregameScoring();
}
state.pregameScoring = loadPregameScoring();

// Purely a perceived-load-time optimization - losing it (quota exceeded,
// blocked storage) just means the next load is network-first.
function saveMatchSnapshot(rawMatches, tbdMatches, generatedAt) {
  // `.live` is stripped - it's pollLiveMatches's own poll-tier detail
  // (inning/quarter/lap), already stale or flat wrong by the time a LATER
  // page load reads this snapshot back; that load's own live poll
  // repopulates it fresh within LIVE_POLL_INTERVAL_MS regardless (see
  // matchWorthPollingNow), so keeping a frozen copy here would only risk
  // briefly showing a long-over inning as if it were still happening.
  writeStoredJson(MATCH_SNAPSHOT_STORAGE_KEY, {
    generatedAt,
    rawMatches: rawMatches.map(({ live, ...rest }) => rest),
    tbdMatches
  });
}

function loadMatchSnapshot() {
  const snapshot = readStoredJson(MATCH_SNAPSHOT_STORAGE_KEY);
  if (!snapshot || !Array.isArray(snapshot.rawMatches) || !snapshot.generatedAt) return null;
  if (Date.now() - Date.parse(snapshot.generatedAt) > MATCH_SNAPSHOT_MAX_AGE_MS) return null;
  return snapshot;
}

// ---- Prebuilt server snapshot ---------------------------------------------
//
// The localStorage snapshot above only helps a browser that loaded this page
// in the last half hour - a first visit, or the home-screen app opened a few
// hours later, still had to wait on ~80 proxied API requests before showing
// anything. .github/workflows/snapshot.yml runs this app's exact build
// (scripts/build-snapshot.mjs) every ~5 minutes and publishes the result to
// this repo's `data` branch, served from GitHub's CDN - ONE ~10KB
// (compressed) request that paints the full window right away. The live
// build still runs immediately afterwards, as before, and replaces it.
//
// Only used when it was built by this exact deploy (see snapshot.yml's
// buildId stamp - same reasoning as wipeStorageOnNewBuild: never feed one
// deploy's rendering code another deploy's data shape) and is recent
// enough. Ignored entirely in a local checkout (no real build id), so
// local changes to the pipeline are never masked by the published data.
const SERVER_SNAPSHOT_URL = 'https://raw.githubusercontent.com/jaypengx-collab/Match-Find/data/matches.json';
const SERVER_SNAPSHOT_MAX_AGE_MS = 45 * 60_000;
const SERVER_SNAPSHOT_TIMEOUT_MS = 6_000;
const IS_DEPLOYED_BUILD = !APP_BUILD_ID.startsWith('__');

// ---- Snapshot-first refreshing (Cloudflare quota) --------------------------
//
// Every request through the shared proxy is one Worker request against the
// Workers Free plan's 100,000/day for the WHOLE Cloudflare account (Orbit's
// Worker draws from the same pool) - cache hits included, since the Worker
// runs to serve them. A tab doing its own live builds (a ~75-request full
// window on load, today/tomorrow every 60s, the full window every 5
// minutes) was live-measured at ~3,600 Worker requests an hour: only ~27
// viewer-hours a day for everyone combined. The prebuilt snapshot is the
// same build, redone every 5 minutes by a GitHub Action and served by
// GitHub - zero Worker requests - so whenever it's current enough
// (SERVER_SNAPSHOT_LIVE_ENOUGH_MS) it stands in for this tab's own builds:
// on load and on both refresh timers. The proxy-based builds remain as the
// fallback for when it isn't (a GitHub hiccup, the first minutes after a
// deploy before a snapshot from the new build is out, or the workflow having
// stopped), and the 30s live poll (live games only - see
// matchWorthPollingNow) is the one thing that always uses the proxy.
const SERVER_SNAPSHOT_LIVE_ENOUGH_MS = 12 * 60_000;
// How long the first paint waits for the snapshot before falling back to a
// live build through the proxy.
const SERVER_SNAPSHOT_FIRST_PAINT_WAIT_MS = 2_500;

// `bust` adds a per-minute query so the periodic refreshes see a new
// snapshot within about a minute of it being published, instead of up to
// 5 minutes later (GitHub's CDN cache time for the plain URL). The plain
// URL is still what the first load asks for, to reuse index.html's preload.
async function fetchServerSnapshot({ bust = false, maxAgeMs = SERVER_SNAPSHOT_MAX_AGE_MS } = {}) {
  if (!IS_DEPLOYED_BUILD) return null;
  try {
    // Default cache mode (not 'no-store'), so this can reuse index.html's
    // <link rel="preload"> of the same URL instead of downloading it twice.
    // GitHub's CDN already caps its own caching at 5 minutes, and the age
    // check below discards anything too old regardless.
    const url = bust ? `${SERVER_SNAPSHOT_URL}?t=${Math.floor(Date.now() / 60_000)}` : SERVER_SNAPSHOT_URL;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(SERVER_SNAPSHOT_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const snapshot = await response.json();
    if (!snapshot || snapshot.buildId !== APP_BUILD_ID || !Array.isArray(snapshot.matches)) return null;
    const generatedMs = Date.parse(snapshot.generatedAt);
    if (!Number.isFinite(generatedMs) || Date.now() - generatedMs > maxAgeMs) return null;
    return snapshot;
  } catch {
    return null;
  }
}

function isSnapshotLiveEnough(snapshot) {
  return !!snapshot && Date.now() - Date.parse(snapshot.generatedAt) <= SERVER_SNAPSHOT_LIVE_ENOUGH_MS;
}

// Paints a snapshot unless what's on screen is already as new or newer (a
// fallback live build, or the same snapshot again). It's a whole-window
// build, so every day counts as loaded, same as after the live full-window
// refresh.
function applyServerSnapshot(snapshot) {
  if (state.lastGeneratedAt && Date.parse(snapshot.generatedAt) <= Date.parse(state.lastGeneratedAt)) return;
  state.fullWindowLoaded = true;
  state.nearTermLoaded = true;
  applyFreshBuild(snapshot.matches, snapshot.generatedAt);
}

// One timer tick's worth of refreshing from the snapshot. True when the
// snapshot was current enough to use (whether or not it was newer than
// what's shown), false when the caller should fall back to a live build.
async function refreshFromSnapshot() {
  const snapshot = await fetchServerSnapshot({ bust: true, maxAgeMs: SERVER_SNAPSHOT_LIVE_ENOUGH_MS });
  if (!snapshot) return false;
  try {
    applyServerSnapshot(snapshot);
  } catch (error) {
    console.error('failed to apply server snapshot', error);
    return false;
  }
  return true;
}

// Which in-progress or finished fixtures a build should look up the pre-game line for
// (see match-builder.mjs's espnCoreOddsUrl) - only ones this browser has no
// pre-game line for yet (never seen, or first seen already underway), and
// only once per fixture per page load, so a game that genuinely never had a
// line posted doesn't cost an extra request on every 60s refresh.
const pregameOddsLookedUp = new Set();
function needsPregameOdds(id) {
  if (pregameOddsLookedUp.has(id)) return false;
  const previous = state.allRawMatches.find(m => m.id === id);
  if (previous && (previous.oddsSpread != null || previous.oddsOverUnder != null)) return false;
  pregameOddsLookedUp.add(id);
  return true;
}

// Applies a freshly-built match list to the page - called by both refresh
// tiers below (and the initial load, which is just the full-window tier's
// own first run), so "how a fresh batch of matches turns into what's on
// screen" only exists in one place.
function applyFreshBuild(matches, generatedAt) {
  // Both snapshot paints and every real refresh funnel through here (see
  // this function's own call sites), so the loading screen is lifted from
  // the paths below - immediately when there's nothing to show, or via
  // revealApp once the first real render's logos are in.
  const previousIds = new Set(state.allRawMatches.map(m => m.id));
  const { rawMatches, tbdMatches } = mergeFreshMatches(matches);
  // A genuine add/remove (a new fixture entering the window, a
  // postponement) invalidates last render's frozen stack membership (see
  // state.stackMembershipByDay's own comment) - but a routine refresh that
  // only UPDATED existing matches in place (a score, an odds move) must
  // NOT reset it, or every swipeable stack would reshuffle on every single
  // refresh tick regardless of whether anything conflict-relevant actually
  // changed.
  const freshIds = new Set(rawMatches.map(m => m.id));
  if (previousIds.size !== freshIds.size || [...previousIds].some(id => !freshIds.has(id))) {
    state.stackMembershipByDay = new Map();
  }

  state.tbdMatches = tbdMatches;
  if (generatedAt) {
    state.lastGeneratedAt = generatedAt;
    const generated = new Date(generatedAt);
    generatedNote.textContent = t('generatedNote', {
      day: localDayFormatter().format(generated),
      time: localTimeFormatter().format(generated)
    });
  }
  renderTbdSection();

  if (!rawMatches.length) {
    // Still worth showing the app shell if there's nothing but TBD
    // fixtures to show (renderTbdSection above already populated that
    // section) - #tbd-section lives inside #app, so #app itself has to be
    // unhidden for it to actually show up.
    appEl.hidden = !state.tbdMatches.length;
    emptyState.hidden = !!state.tbdMatches.length;
    // Nothing with logos to wait for here - drop the loading screen now.
    if (loadingStateEl) loadingStateEl.hidden = true;
    // A genuine build (even an empty one) means the fetch itself didn't
    // fail - clear any stale error message a PRIOR failed refresh left up,
    // same as the non-empty branch below already does. Without this, a
    // failed refresh's error state could sit on screen forever after a
    // later refresh legitimately came back empty (e.g. a real quiet
    // stretch with nothing scheduled), showing both messages together.
    errorState.hidden = true;
    return;
  }

  errorState.hidden = true;
  // The day-scroller's own pill COUNT is a UI-window concept independent
  // of which refresh tier just ran - a near-term refresh only re-fetches a
  // couple of days, but every day the last full-window refresh already
  // populated still deserves its own pill.
  state.daysAhead = DEFAULT_DAYS_AHEAD;
  state.allRawMatches = rawMatches;
  warmMatchLogos(rawMatches);
  applyEnabledSportsAndRender();
  saveMatchSnapshot(rawMatches, tbdMatches, generatedAt || new Date().toISOString());
  rememberPregameScoring(rawMatches);
}

// Filters state.allRawMatches down to the sports currently enabled in
// Settings (see "Enabled sports settings" below), then redoes everything
// downstream of that - the viewing plan, the day list (a day can gain or
// lose entries entirely depending which sports are on), and every render
// call. Shared by the initial load/poll (applyFreshBuild) and by toggling a
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
  // state.days/state.matches (and therefore every day's own candidate set
  // baseDayCandidates reads) just changed - the cached rotation plan (see
  // getVarietyRotation) is stale regardless of which of this function's
  // two real call sites (a fresh data build, an enabled-sports toggle)
  // brought us here.
  invalidateVarietyRotation();
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
  revealApp();
}

// ---- First reveal: logos in place before the loading screen lifts ---------
//
// The first render used to lift the loading screen the instant the cards
// existed, and their team/league logos then popped in a moment later -
// visibly, since they only start downloading once their <img> exists. Now
// the first render happens UNDER the loading screen (switched to a
// full-screen cover, see .loading-state.is-covering) and the screen lifts
// once every image in the page has loaded and decoded - capped at
// FIRST_REVEAL_IMAGE_WAIT_MS, so a slow or broken image can never hold the
// page back for more than a moment. Later renders never wait on anything.
const FIRST_REVEAL_IMAGE_WAIT_MS = 1500;
let appRevealStarted = false;

function imageReady(img) {
  const loaded = img.complete
    ? Promise.resolve()
    : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
  // decode() makes sure it's ready to paint, not just downloaded; it
  // rejects for a broken image, which counts as "done" here too.
  return loaded.then(() => (img.naturalWidth ? img.decode().catch(() => {}) : undefined));
}

function revealApp() {
  if (appRevealStarted || !loadingStateEl || loadingStateEl.hidden) return;
  appRevealStarted = true;
  loadingStateEl.classList.add('is-covering');
  const images = [...appEl.querySelectorAll('img')].filter(img => img.getAttribute('src'));
  Promise.race([
    Promise.all(images.map(imageReady)),
    new Promise(resolve => setTimeout(resolve, FIRST_REVEAL_IMAGE_WAIT_MS))
  ]).then(() => {
    loadingStateEl.hidden = true;
    loadingStateEl.classList.remove('is-covering');
  });
}

// Starts every team's logo downloading as soon as the match list is known -
// not just the ones on the day being shown - so switching days later
// doesn't make them pop in either. Same downsized URLs updateTeamRow uses,
// shared with warmTeamLogos (see warmLogo); a few KB each.
function warmMatchLogos(matches) {
  matches.forEach(match => {
    [match.logo, ...(Array.isArray(match.competitors) ? match.competitors.map(c => c.logo) : [])].forEach(warmLogo);
  });
  Object.values(LEAGUE_LOGOS).forEach(warmLogo);
}

// ---- Live match data: two refresh tiers, both calling buildMatches -------
//
// This replaces a scheduled GitHub Action that rebuilt a static
// matches.json every 15 minutes and redeployed it - see this file's own
// top comment for why. Two tiers, not one, because ESPN's own scoreboard
// endpoint has no multi-day range query for a team sport (confirmed live -
// only F1's own racing/f1 endpoint accepts one), so fetching the WHOLE
// multi-week window really is one request per league per day, not
// something a single cheap query could replace - doing that on every
// refresh, aggressively, isn't practical:
//   - NEAR-TERM tier (NEAR_TERM_DAYS_AHEAD days, every NEAR_TERM_REFRESH_MS):
//     cheap (a handful of requests), so this can run often - today/
//     tomorrow's scores, new fixtures, and odds are the ones actually
//     worth being "live" about.
//   - FULL-WINDOW tier (the whole DEFAULT_DAYS_AHEAD-day horizon, every
//     FULL_REFRESH_MS): expensive (~50+ requests), so this runs far less
//     often - a fixture 10 days out doesn't need up-to-the-minute
//     freshness, nothing about it is "live" in any meaningful sense.
// Both apply through the SAME mergeFreshMatches/applyFreshBuild (see
// above) - an upsert, never a wholesale replace - so neither tier can ever
// wipe out what the other one already loaded.
const NEAR_TERM_DAYS_AHEAD = 2;
const NEAR_TERM_REFRESH_MS = 60_000;
const FULL_REFRESH_MS = 5 * 60_000;

let nearTermRefreshTimer = null;
let fullRefreshTimer = null;
// The wall-clock instant each tier's OWN next tick is due - read by
// renderNextUpdateCountdown below to show "下次更新：Ns" without that
// display needing to know a single thing about which of the three timers
// it's actually reflecting. Set at the exact moment each setTimeout below
// is (re)armed, including from a manual/foreground-return refresh (see
// handleForegroundReturn) - never computed once at load and left stale.
let nextNearTermRefreshAt = null;
let nextFullRefreshAt = null;

// Polymarket odds is treated as a pure display badge HERE specifically -
// this call fills in oddsWinPctAway/Home/Draw for the odds bar, but
// deliberately does NOT feed match-builder.mjs's own objective scoring the
// way a full buildMatches({ enrichOdds: true }) call now does (see that
// function's own comment on POLYMARKET_MIN_LIQUIDITY_FOR_SCORING/
// marketWinPctAway for why a liquid market IS a real scoring input now).
// recomputeAndRender below only re-runs the day-plan/rotation logic over
// whatever competitiveness/watchability each match ALREADY has - it never
// recomputes the objective score itself - so this fast-follow is safe to
// let arrive AFTER the match has already painted, rather than making every
// refresh sit through Polymarket's own pagination first, at the cost of
// this session's live view keeping its spread-based closeness for the rest
// of the session instead of picking up the Polymarket upgrade (see
// buildMatches' own `enrichOdds` comment for the full reasoning on why
// that's an acceptable scope limit, not a bug). Both refresh tiers below
// pass `enrichOdds: false` to buildMatches and call this straight on
// state.allRawMatches instead - the SAME objects buildMatches' own
// `matches` return value already put there (mergeFreshMatches upserts by
// reference, never clones - see its own comment), so mutating them here is
// exactly as safe as pollLiveMatches already mutating those same objects
// in place. Unblocked/fire-and-forget from both call sites; a refresh that
// lands mid-flight just leaves this one targeting orphaned objects nobody
// renders from anymore, same harmless race pollLiveMatches already
// tolerates.
function enrichOddsInBackground() {
  enrichWithPolymarketOdds(state.allRawMatches, polymarketFetchJson)
    .then(() => {
      recomputeAndRender();
      // The snapshot applyFreshBuild saved went out BEFORE these odds
      // existed - re-save so the next visit's instant paint already has
      // its odds bars instead of drawing them in a moment later.
      saveMatchSnapshot(state.allRawMatches, state.tbdMatches, state.lastGeneratedAt || new Date().toISOString());
    })
    .catch(error => console.error('background odds enrichment failed', error));
}

// Kicks off every enabled sport's Polymarket download immediately, in
// parallel with (and ahead of, in the fetch queue) the ESPN requests
// buildMatches is about to fire - it used to start only AFTER the whole
// match list had been fetched, scored and painted, which is exactly the
// "odds roll in a few seconds later" delay. The results land in
// proxyFetchJson's own cache/in-flight map, so the enrichment that follows
// the build just picks them up instead of starting from zero.
function prefetchPolymarketEvents() {
  [...state.enabledSports]
    .filter(sport => POLYMARKET_TAG_ID[sport] != null)
    .forEach(sport => {
      fetchAllPolymarketEvents(POLYMARKET_TAG_ID[sport], polymarketFetchJson).catch(() => {});
    });
}

// buildMatches only asks for standings after EVERY scoreboard has come back
// (it needs them to know which leagues have games left) - a whole extra
// round trip on the critical path. The URLs themselves are fixed, though,
// so they're requested up front here, alongside the scoreboards;
// buildMatches then finds them already in (or in flight in)
// proxyFetchJson's cache. The season matches buildMatches' own
// (`now.getUTCFullYear()`). A league with nothing left to play costs one
// wasted small request - nothing else.
function prefetchStandings() {
  const urls = [];
  if (state.enabledSports.has('MLB')) urls.push(mlbStandingsUrl(new Date().getUTCFullYear()));
  if (state.enabledSports.has('NBA')) urls.push(nbaStandingsUrl());
  if (state.enabledSports.has('Premier League')) urls.push(eplStandingsUrl());
  if (state.enabledSports.has('F1')) urls.push(f1DriverStandingsUrl());
  urls.forEach(url => proxyFetchJson(url).catch(() => {}));
}

// How long the FIRST paint will wait, past the match list itself being
// ready, for odds to be applied too - normally zero in practice (the
// prefetch above started at the same time as the far larger ESPN fetch and
// is done first), but capped so a slow Polymarket can never hold the whole
// page hostage; if it misses, the background enrichment fills odds in as
// before.
const FIRST_PAINT_ODDS_GRACE_MS = 1500;

async function refreshNearTerm() {
  try {
    const { matches, generatedAt } = await buildMatches({
      daysAhead: NEAR_TERM_DAYS_AHEAD,
      fetchJson: proxyFetchJson,
      enabledSports: state.enabledSports,
      enrichOdds: false,
      needsPregameOdds
    });
    // Set BEFORE applyFreshBuild, not after - applyFreshBuild's own render
    // reads this (via isDayPending) to decide whether today/tomorrow are
    // "confirmed" yet, and that decision needs to already be right for
    // THIS render, not just the next one. See fullWindowLoaded's own
    // comment on refreshFullWindow for why this only ever goes true on a
    // real resolve - same reasoning, one tier down.
    state.nearTermLoaded = true;
    applyFreshBuild(matches, generatedAt);
    enrichOddsInBackground();
  } catch (error) {
    console.error('near-term refresh failed', error);
  }
}

// ---- New-version check (no service worker on this site - see below) ------
//
// This is a plain static site (GitHub Pages, no build step - see this
// file's own top comment) with no service worker/offline cache at all -
// `manifest.webmanifest` only makes it installable ("Add to Home Screen"),
// it doesn't give the OS/browser any way to tell this tab "a new version
// was deployed". Direct feedback: tapping "立即重新整理" only ever
// refreshed match DATA, never checked whether the PAGE ITSELF (app.js's
// own code) had been redeployed since this tab loaded - a viewer who kept
// a tab open for days could sit on stale logic indefinitely with no signal
// anything had changed.
//
// An earlier version of this compared app.js's own ETag/Last-Modified
// response header, snapshotted once at load - live-reported as "發現新
// 版本，點此重新載入 never hide despite already in the newest version",
// i.e. the comparison kept saying "different" when it genuinely wasn't.
// The live curl check that called GitHub Pages' ETag "stable" only ever
// compared two requests made seconds apart, which likely hit the same warm
// CDN edge-cache entry rather than proving real cross-request stability -
// Fastly (GitHub Pages' own CDN) can hand back a different ETag for
// byte-identical content depending on which edge node/compression variant
// actually answered a given request, which is exactly a false "new
// version" waiting to happen on every single check.
//
// Fixed by comparing something with an actually deterministic ground truth
// instead of a CDN header: APP_BUILD_ID (see its own comment above - the
// exact commit sha `deploy.yml`'s own sed step stamps into app.js on every
// real deploy). This tab already knows its OWN build id trivially (it's a
// plain constant in this very file) - no "snapshot a baseline at load"
// step is even needed anymore, just fetch the live app.js's own source and
// read the id it contains back out with a regex, then compare it directly.
// Two copies of app.js from the same deploy are byte-identical (same sha
// embedded either way), so this can never produce the false positive the
// ETag approach could.
const APP_VERSION_CHECK_PATH = './app.js';
const APP_BUILD_ID_PATTERN = /const APP_BUILD_ID = '([^']*)'/;

async function fetchLiveAppBuildId() {
  try {
    // `cache: 'no-store'` is enough here: it tells THIS BROWSER to skip its
    // own local HTTP cache and always hit the network. GitHub Pages' own CDN
    // (Fastly) does cache this same URL at the edge under its own
    // `cache-control: max-age=600` - but live-verified via curl, Fastly
    // actually IGNORES the query string entirely for its cache key on this
    // asset (three requests with three different random query strings all
    // came back `x-cache: HIT` against the SAME underlying cached object, on
    // three different edge nodes) - so a cache-busting query param here would
    // do nothing at that layer anyway, only add noise. The CDN side turned
    // out not to be the actual bug: GitHub Pages purges/repopulates its edge
    // cache on every deploy, confirmed live serving the correct just-deployed
    // build id within seconds.
    const response = await fetch(APP_VERSION_CHECK_PATH, { cache: 'no-store' });
    if (!response.ok) return null;
    const text = await response.text();
    return text.match(APP_BUILD_ID_PATTERN)?.[1] || null;
  } catch {
    // Offline, or a local dev server serving something unexpected - there's
    // simply nothing to compare against yet, not a real failure.
    return null;
  }
}

// True only when the live app.js's own build id could actually be read AND
// it genuinely differs from this tab's own - never true just because this
// ONE check happened to fail (a transient network hiccup isn't "a new
// version exists", and reloading on that basis would just interrupt the
// viewer for nothing). Locally/in a dev checkout, both sides are still the
// literal '__BUILD_ID__' placeholder (see APP_BUILD_ID's own comment), so
// this correctly never fires there either.
async function checkForNewAppVersion() {
  const liveBuildId = await fetchLiveAppBuildId();
  const isNew = !!liveBuildId && liveBuildId !== APP_BUILD_ID;
  // Start readying the service worker the moment a new deploy is seen, so
  // it's normally done by the time the reload actually happens.
  if (isNew && !serviceWorkerReadyForReload) serviceWorkerReadyForReload = prepareServiceWorkerForBuild(liveBuildId);
  return isNew;
}

// ---- Service worker vs. the version reload ---------------------------------
//
// public/sw.js serves this site's code from a per-deploy cache. Browsers
// only look for a new worker lazily (Chromium defers it; iOS home-screen
// apps can go a long time without checking), so when this page finds a new
// deploy, the reload could otherwise be answered by the OLD worker with the
// OLD code - and this page would find the new version again and reload
// again, in a loop. So before reloading: ask for the new worker explicitly
// and wait (bounded) until its cache - named after the new build id - is
// in place. If that doesn't happen in time (a failed install, a slow
// network), the worker is unregistered instead, so the reload comes
// straight from the network - still a consistent new build - and the next
// load registers the new worker from scratch. Either way the reloaded page
// is never a mix of two deploys.
const SERVICE_WORKER_UPDATE_TIMEOUT_MS = 10_000;
let serviceWorkerReadyForReload = null;

async function prepareServiceWorkerForBuild(buildId) {
  if (!('serviceWorker' in navigator)) return;
  let registration;
  try {
    registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;
    const expectedCache = `matchfind-shell-${buildId}`;
    const hasNewCache = async () => (await caches.keys()).includes(expectedCache) && registration.active && !registration.installing && !registration.waiting;
    const deadline = Date.now() + SERVICE_WORKER_UPDATE_TIMEOUT_MS;
    await registration.update().catch(() => {});
    while (Date.now() < deadline) {
      if (await hasNewCache()) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await removeServiceWorker(registration);
  } catch (error) {
    console.warn('service worker update before reload failed - unregistering', error);
    await removeServiceWorker(registration);
  }
}

async function removeServiceWorker(registration) {
  await registration?.unregister().catch(() => {});
  const names = await caches.keys().catch(() => []);
  await Promise.all(names.filter(name => name.startsWith('matchfind-shell-')).map(name => caches.delete(name).catch(() => {})));
}

// A real reload, not just re-fetching data - the whole point is to get this
// tab off whatever OLD app.js it's still running. A bare
// window.location.reload() is NOT guaranteed to do that: index.html itself
// is served with cache-control: max-age=600 (confirmed live via curl), so
// an ordinary reload made within 10 minutes of this tab's own last load can
// be satisfied entirely from THIS BROWSER's own local HTTP cache without
// ever reaching the network - reloading the exact same stale index.html
// (and the old app.js?v=<sha> it references) this tab already had.
//
// A browser's own local cache is keyed on the full URL including its query
// string (unlike GitHub Pages' CDN, which was confirmed to ignore query
// strings for ITS cache key) - so navigating to a cache-busted URL forces a
// genuine network request this browser can't shortcut from disk. Shared by
// the manual refresh button and the automatic background check below, so
// there's exactly one place this reload actually happens.
async function reloadOntoNewAppVersion() {
  // See "Service worker vs. the version reload" above.
  await (serviceWorkerReadyForReload || Promise.resolve()).catch(() => {});
  const bustedUrl = `${window.location.pathname}?_=${Date.now()}${window.location.hash}`;
  window.location.replace(bustedUrl);
}

// ---- Automatic update check ------------------------------------------------
//
// checkForNewAppVersion above used to only ever run from the manual
// "立即重新整理" button's own click handler - a viewer who never happens to
// tap that could sit on an old deploy indefinitely, since this is a live,
// frequently-iterated static site with no other update mechanism at all (no
// service worker, no app-store update prompt - see this file's own top
// comment). Live-reported directly: wanting the app to "always keep itself
// up to date" rather than relying on that manual tap.
//
// No timer of its own - wired straight into refreshFullWindow below (the
// existing full-window data grab, already running every FULL_REFRESH_MS in
// the background, on top of once at init() and once on any stale foreground
// return), so a version check just rides along with a fetch that was
// happening anyway rather than this file needing to track yet another
// independent schedule. The moment a new deploy is found, this reloads
// automatically - but only while nobody is actually looking at the tab, the
// same way every other background refresh tier here already defers
// disruptive work rather than yanking an active viewer off whatever they're
// doing (mid-swipe, mid-read). A tab that's already hidden at check time
// reloads immediately (nothing to interrupt); a tab that's visible just
// gets an unobtrusive note in Settings, applied automatically the moment
// the viewer backgrounds the tab at all (even briefly - see the
// `visibilitychange` listener below) rather than left for them to notice
// and tap the button themselves.
let newAppVersionPending = false;

async function checkForAppVersionUpdate() {
  if (newAppVersionPending) return; // already found, just waiting for a safe moment to apply
  const hasNewVersion = await checkForNewAppVersion().catch(() => false);
  if (!hasNewVersion) return;
  if (document.visibilityState === 'hidden') {
    reloadOntoNewAppVersion();
    return;
  }
  newAppVersionPending = true;
  updateStatusText.textContent = t('newVersionAvailable', { refreshBtn: t('refreshNowBtn') });
}

// `silent` keeps the background timer from fighting with a viewer who just
// tapped "立即重新整理" for status text either one might want to set.
async function refreshFullWindow({ silent = false, statusEl, button, waitForOdds = false } = {}) {
  if (!silent) {
    if (statusEl) statusEl.textContent = t('refreshing');
    if (button) button.disabled = true;
  }
  try {
    const { matches, generatedAt } = await buildMatches({
      daysAhead: DEFAULT_DAYS_AHEAD,
      fetchJson: proxyFetchJson,
      enabledSports: state.enabledSports,
      enrichOdds: false,
      needsPregameOdds
    });
    // First load only (see FIRST_PAINT_ODDS_GRACE_MS) - so the very first
    // cards already carry their odds bars.
    if (waitForOdds) {
      await Promise.race([
        enrichWithPolymarketOdds(matches, polymarketFetchJson).catch(() => {}),
        new Promise(resolve => setTimeout(resolve, FIRST_PAINT_ODDS_GRACE_MS))
      ]);
    }
    // Set BEFORE applyFreshBuild, not after - see refreshNearTerm's own
    // comment on state.nearTermLoaded for why the render this triggers
    // needs to already see the up-to-date flag. A successful resolve here
    // - even one that happens to carry zero matches for some far-future
    // day, a genuinely quiet sports day - is still an AUTHORITATIVE answer
    // for the whole window (buildMatches' own per-league try/catch already
    // degrades a single league's failure to an empty array rather than
    // throwing - see its own comment), so this only ever goes true on a
    // real resolve, never optimistically before one. See isDayPending's
    // own comment for what this unlocks.
    state.fullWindowLoaded = true;
    applyFreshBuild(matches, generatedAt);
    enrichOddsInBackground();
    if (!silent && statusEl) statusEl.textContent = t('dataUpdated');
    // Rides along with this same periodic data grab rather than keeping its
    // own separate schedule - see checkForAppVersionUpdate's own comment.
    // Runs last, after the "資料已更新" status text above, so a version
    // note this finds is the one left showing, not immediately overwritten
    // by it.
    await checkForAppVersionUpdate();
  } catch (error) {
    console.error('full refresh failed', error);
    if (!silent && statusEl) statusEl.textContent = t('refreshFailed');
  } finally {
    if (!silent && button) button.disabled = false;
  }
}

function scheduleNearTermRefresh() {
  if (nearTermRefreshTimer) clearTimeout(nearTermRefreshTimer);
  nextNearTermRefreshAt = Date.now() + NEAR_TERM_REFRESH_MS;
  nearTermRefreshTimer = setTimeout(async () => {
    // A backgrounded tab still gets rescheduled (so it picks back up the
    // moment it's visible again) but skips the actual fetch - no point
    // spending battery/quota refreshing a page nobody's looking at.
    // Snapshot first - see "Snapshot-first refreshing" above.
    if (document.visibilityState !== 'hidden' && !(await refreshFromSnapshot())) await refreshNearTerm();
    scheduleNearTermRefresh();
  }, NEAR_TERM_REFRESH_MS);
}

function scheduleFullRefresh() {
  if (fullRefreshTimer) clearTimeout(fullRefreshTimer);
  nextFullRefreshAt = Date.now() + FULL_REFRESH_MS;
  fullRefreshTimer = setTimeout(async () => {
    if (document.visibilityState !== 'hidden') {
      // refreshFullWindow also runs the new-version check, so the snapshot
      // path has to run it itself.
      if (await refreshFromSnapshot()) await checkForAppVersionUpdate();
      else await refreshFullWindow({ silent: true });
    }
    scheduleFullRefresh();
  }, FULL_REFRESH_MS);
}

// One button now does both jobs a separate "click to update" button used to
// split across two clicks (and which, even after fixing the check and the
// reload itself, kept getting live-reported as broken because a THIRD,
// unrelated CSS cascade bug was showing it unconditionally regardless of
// either fix - see this repo's own git history). Checking first means the
// common case (no new deploy) costs nothing extra: the check is a single
// small HEAD-adjacent fetch of the live app.js, done before the heavier
// buildMatches() fetch, not after it.
refreshDataBtn.addEventListener('click', async () => {
  refreshDataBtn.disabled = true;
  updateStatusText.textContent = t('checkingVersion');
  const hasNewVersion = await checkForNewAppVersion().catch(() => false);
  if (hasNewVersion) {
    reloadOntoNewAppVersion();
    return;
  }
  await refreshFullWindow({ statusEl: updateStatusText, button: refreshDataBtn });
});

// ---- Live score/odds polling (see ./lib/espn.mjs and ./lib/polymarket.mjs) -
//
// A THIRD, even faster refresh tier on top of the two buildMatches tiers
// above (near-term/full-window) - this one polls just SCORE/STATUS/ODDS
// for whatever's already loaded, on a much shorter interval than either
// buildMatches tier could reasonably run at (see this file's own top
// comment on why re-scoring a whole fetch batch isn't cheap enough to do
// every few seconds), by hitting each sport's OWN narrow live-scoreboard
// endpoint (today ± a day, not the whole window) and merging the result
// straight into the SAME match objects buildMatches already produced -
// never re-running the scoring/duration/objective-factor pipeline itself,
// only the same live facts already reported (score, finished status,
// odds), plus letting recommendation.mjs's own liveExcitementBonus react
// to a live score change so a live match that turns out to be a genuine
// nail-biter can bump the day's plan (item 6) - see
// applyLiveExcitementBonus's own comment for where that bonus is
// actually applied. Score/status comes from ESPN's own public scoreboard;
// odds comes from Polymarket instead (see ./lib/polymarket.mjs for why) -
// two separate fetches below, since not every sport this tracks has both
// (F1 has real, live Polymarket odds but no ESPN score to poll at all).
const LIVE_POLL_INTERVAL_MS = 30_000;
let livePollTimer = null;
let nextLivePollAt = null;
// Only games that are live, ending, or starting within
// STARTING_SOON_WINDOW_MINUTES are polled. An earlier version also polled
// every fixture up to 48 hours before kickoff purely for pre-game odds
// movement - which, since there's almost always a game in the next two
// days, kept this 30-second poll (up to ~8 Polymarket pages + ESPN per
// tick, all through the shared Worker) running around the clock in every
// open tab: live-measured as most of a tab's ~3,600 Worker requests an
// hour, against the Workers Free plan's 100,000/day for the whole account.
// Pre-game odds now come from the prebuilt snapshot instead, refreshed
// every 5 minutes at no Worker cost (see refreshFromSnapshot) - plenty for
// a price that moves over hours, not seconds.

function matchWorthPollingNow(m, now = Date.now()) {
  // Worth polling if EITHER a live score (ESPN, team sports only) OR live
  // odds (Polymarket, every sport this app tracks including F1 - see
  // ./lib/polymarket.mjs) could come from it - a plain F1 race has no
  // ESPN-reported score to poll at all, but it still has real, moving
  // Polymarket odds worth refreshing.
  if (m.timeTbd || m.isFinished) return false;
  if (!TEAM_LEAGUE_ESPN[m.sport] && POLYMARKET_TAG_ID[m.sport] == null) return false;
  const lifecycle = matchLifecycleState(m, now);
  if (lifecycle === LIFECYCLE_STATES.LIVE || lifecycle === LIFECYCLE_STATES.ENDING_SOON) return true;
  return lifecycle === LIFECYCLE_STATES.STARTING_SOON;
}

function anyMatchWorthPollingNow() {
  return state.allRawMatches.some(m => matchWorthPollingNow(m));
}

function sportsWorthPollingNow() {
  const sports = new Set();
  state.allRawMatches.forEach(m => {
    if (matchWorthPollingNow(m)) sports.add(m.sport);
  });
  return sports;
}

async function pollLiveMatches() {
  if (!state.proxyUrl) return;
  const sports = sportsWorthPollingNow();
  if (!sports.size) return;

  const byId = new Map(state.allRawMatches.map(m => [m.id, m]));
  let changed = false;
  // A fresh `live` object is only ever written back when it actually
  // differs from what's already on the match (a plain JSON compare - cheap
  // for these small objects) - same reasoning as the F1 oddsFavorites
  // compare further down: avoids forcing a render every quiet 30s tick
  // where the inning/quarter/lap hasn't actually moved.
  function applyLiveDetail(match, live) {
    if (JSON.stringify(live) !== JSON.stringify(match.live)) {
      match.live = live;
      changed = true;
    }
  }
  await Promise.allSettled(
    [...sports].map(async sport => {
      // F1 has no ESPN "score" to poll (see liveScoreboardUrls's own
      // comment) but DOES have a live lap count/flag status/running order
      // from the exact same racing/f1 scoreboard match-builder.mjs already
      // uses for its schedule (see extractF1LiveUpdates) - a completely
      // different response shape (drivers, not two team sides), so this
      // branches off into its own fetch/merge rather than forcing it
      // through the team-sport extractor below.
      if (sport === 'F1') {
        const target = f1LiveScoreboardUrl();
        const response = await fetch(`${state.proxyUrl}/sports-proxy?url=${encodeURIComponent(target)}`, {
          cache: 'no-store'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const scoreboard = await response.json();
        extractF1LiveUpdates(scoreboard).forEach((update, id) => {
          const match = byId.get(id);
          if (!match || match.isFinished) return;
          applyLiveDetail(match, { lap: update.lap, statusDetail: update.statusDetail, leaderboard: update.leaderboard });
          if (update.isFinished && !match.isFinished) {
            match.isFinished = true;
            changed = true;
          }
        });
        return;
      }
      // Two single-date requests, not one range request - see
      // liveScoreboardUrls's own comment for why a range param gets a flat
      // 400 from this endpoint. Later (today's) response wins on a
      // same-id collision (a doubleheader's game near midnight UTC could
      // legitimately appear in both) via plain Map overwrite - harmless,
      // since it's the same event either way.
      const targets = liveScoreboardUrls(sport);
      if (!targets.length) return;
      const updates = new Map();
      for (const target of targets) {
        const response = await fetch(`${state.proxyUrl}/sports-proxy?url=${encodeURIComponent(target)}`, {
          cache: 'no-store'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const scoreboard = await response.json();
        extractLiveUpdates(sport, scoreboard).forEach((update, id) => updates.set(id, update));
      }
      updates.forEach((update, id) => {
        const match = byId.get(id);
        if (!match || match.isFinished) return;
        const [awayScore, homeScore] = update.scores;
        if (Array.isArray(match.competitors) && match.competitors.length === 2) {
          if (awayScore != null && match.competitors[0].score !== awayScore) {
            match.competitors[0].score = awayScore;
            changed = true;
          }
          if (homeScore != null && match.competitors[1].score !== homeScore) {
            match.competitors[1].score = homeScore;
            changed = true;
          }
        }
        applyLiveDetail(match, {
          period: update.period,
          displayClock: update.displayClock,
          detail: update.shortDetail,
          situation: update.situation
        });
        // Pre-game lines only - once underway, ESPN's spread/over-under is an
        // in-game line, not the pre-game signal this fixture was scored and
        // planned with (see freezeStartedMatchScoring).
        if (Date.parse(match.startTimeUtc) > Date.now()) {
          if (update.oddsSpread != null) match.oddsSpread = update.oddsSpread;
          if (update.oddsOverUnder != null) match.oddsOverUnder = update.oddsOverUnder;
        }
        if (update.isFinished && !match.isFinished) {
          match.isFinished = true;
          changed = true;
        }
        // Live-corrects the pre-game duration estimate from ESPN's own
        // current inning/quarter/match-minute - see
        // recommendation.mjs's estimateLiveDurationMinutes for why this
        // directly improves scheduling (effectiveDurationMinutes/
        // schedulingInterval), not just what's printed on the card, and
        // this repo's own reported "MLB drops 30-60 minutes off its
        // estimate" bug this is meant to narrow.
        if (!update.isFinished) {
          const liveDuration = estimateLiveDurationMinutes(match.sport, match.startTimeUtc, match.durationMinutes, update);
          if (liveDuration !== match.durationMinutes) {
            match.durationMinutes = liveDuration;
            changed = true;
          }
        }
      });
    })
  ).catch(() => {}); // best-effort - a failed poll just tries again next tick

  // The win% odds refresh - Polymarket, not ESPN (see ./lib/polymarket.mjs
  // for why), and covering every sport this app tracks including F1 -
  // ESPN's own scoreboard fetch above never carried F1 at all. One request
  // per sport (same "one batch request, not one per fixture" shape as the
  // ESPN pass above), then the SAME event-matching/parsing this app's own
  // build already used for that sport's initial number.
  await Promise.allSettled(
    [...sports]
      .filter(sport => POLYMARKET_TAG_ID[sport] != null)
      .map(async sport => {
        const events = await fetchAllPolymarketEvents(POLYMARKET_TAG_ID[sport], polymarketFetchJsonUncached);
        state.allRawMatches.forEach(match => {
          if (match.sport !== sport || match.isFinished) return;
          if (sport === 'F1') {
            // The Race session shows race-winner odds, Qualifying shows
            // pole-position odds - see match-builder.mjs's own
            // enrichWithPolymarketOdds comment for why `-race`/`-qual` are
            // each session's own stable id suffix, and
            // resolvePoleWinnerOdds's own comment for the separate
            // Polymarket market this reads for Qualifying.
            const sessionDateUtc = match.startTimeUtc.slice(0, 10);
            const favorites = match.id.endsWith('-race')
              ? resolveF1WinnerOdds(events, sessionDateUtc)
              : match.id.endsWith('-qual')
                ? resolvePoleWinnerOdds(events, sessionDateUtc)
                : null;
            if (!favorites) return;
            const top3 = favorites.slice(0, 3);
            // A plain array-of-objects compare - cheap for a 3-entry list,
            // and avoids forcing a render every quiet poll tick where the
            // market hasn't actually moved.
            if (JSON.stringify(top3) !== JSON.stringify(match.oddsFavorites)) {
              match.oddsFavorites = top3;
              changed = true;
            }
            return;
          }
          if (!Array.isArray(match.competitors) || match.competitors.length !== 2) return;
          const [away, home] = match.competitors;
          const result = resolveTeamOdds(events, {
            awayName: away.name,
            homeName: home.name,
            startTimeUtc: match.startTimeUtc,
            hasDraw: sport === 'Premier League'
          });
          if (!result) return;
          if (match.oddsWinPctAway !== result.away) {
            match.oddsWinPctAway = result.away;
            changed = true;
          }
          if (match.oddsWinPctHome !== result.home) {
            match.oddsWinPctHome = result.home;
            changed = true;
          }
          if (match.oddsWinPctDraw !== result.draw) {
            match.oddsWinPctDraw = result.draw;
            changed = true;
          }
        });
      })
  ).catch(() => {});

  // Re-derives effectiveScore/the day's plan from the freshly-updated raw
  // matches (liveExcitementBonus reads match.competitors[].score directly,
  // see recommendation.mjs) - skipped entirely when nothing actually
  // changed, so a quiet tick (scores unchanged since last poll) doesn't
  // still force a render.
  if (changed) recomputeAndRender();
}

function scheduleLivePoll() {
  if (livePollTimer) clearTimeout(livePollTimer);
  nextLivePollAt = Date.now() + LIVE_POLL_INTERVAL_MS;
  livePollTimer = setTimeout(async () => {
    // A backgrounded tab still gets rescheduled (so it picks back up the
    // moment it's visible again) but skips the actual network request -
    // no point spending battery/quota polling scores/odds nobody's looking
    // at.
    if (document.visibilityState !== 'hidden' && anyMatchWorthPollingNow()) {
      await pollLiveMatches();
    }
    scheduleLivePoll();
  }, LIVE_POLL_INTERVAL_MS);
}

// ---- Foreground-return refresh + "next update" countdown -----------------
//
// Every timer above already reschedules itself on the SAME fixed interval
// even while the tab is hidden (it just skips the actual fetch each tick -
// see each one's own comment) - so a tab backgrounded for, say, 10 minutes
// and then brought back doesn't get anything fresher until whichever timer
// next happens to fire, which could itself be seconds OR most of a minute
// away, entirely by accident of when the tab happened to get hidden. That
// reads as "the app doesn't notice I came back" even though a real refresh
// was in fact already overdue. This listens for exactly that transition and
// forces an immediate refresh instead of waiting on the accident of timing -
// but only when the tab was actually away long enough (FOREGROUND_STALE_MS)
// that background timers alone clearly wouldn't have kept up; a quick
// app-switch-and-back well under that (checking a notification) is left
// alone rather than doubling up on a refresh that just ran moments ago.
const FOREGROUND_STALE_MS = 30_000;
let hiddenSinceAt = null;

async function handleForegroundReturn(awayMs) {
  const fromSnapshot = await refreshFromSnapshot().catch(() => false);
  if (!fromSnapshot) {
    try {
      await refreshNearTerm();
    } catch (error) {
      console.error('foreground-return near-term refresh failed', error);
    }
  }
  scheduleNearTermRefresh();
  if (document.visibilityState !== 'hidden' && anyMatchWorthPollingNow()) {
    try {
      await pollLiveMatches();
    } catch (error) {
      console.error('foreground-return live poll failed', error);
    }
  }
  scheduleLivePoll();
  // The full multi-week window is only worth re-forcing here if the tab was
  // away for at least ITS OWN normal interval - a fixture 10 days out was
  // never "live" in the sense the other two tiers are, so a 45-second
  // backgrounding doesn't need to force ~50+ requests just to be thorough.
  if (awayMs >= FULL_REFRESH_MS) {
    // Includes its own version check - see checkForAppVersionUpdate's own
    // comment on why that's wired into refreshFullWindow directly rather
    // than kept as a separate call here too.
    if (fromSnapshot) await checkForAppVersionUpdate().catch(() => {});
    else await refreshFullWindow({ silent: true }).catch(() => {});
    scheduleFullRefresh();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // A version update already found while this tab was visible (see
    // checkForAppVersionUpdate) - apply it right now, the instant nobody's
    // looking anymore, rather than waiting on whatever this tab's own next
    // foreground-return happens to be.
    if (newAppVersionPending) {
      reloadOntoNewAppVersion();
      return;
    }
    hiddenSinceAt = Date.now();
    return;
  }
  if (hiddenSinceAt == null) return;
  const awayMs = Date.now() - hiddenSinceAt;
  hiddenSinceAt = null;
  if (awayMs < FOREGROUND_STALE_MS) return;
  handleForegroundReturn(awayMs);
});

// A small, ticking "下次更新：Ns" readout - the soonest of the three
// scheduled tiers above (live poll only counted while something's actually
// worth polling; a fixture with no live poll running has no reason to
// dangle a countdown for one that's really just an idle no-op tick), so a
// viewer watching a live match can literally see when its next update is
// coming instead of only ever finding out after the fact.
function nextUpdateEtaMs() {
  const now = Date.now();
  const candidates = [nextNearTermRefreshAt, nextFullRefreshAt];
  if (anyMatchWorthPollingNow()) candidates.push(nextLivePollAt);
  const finite = candidates.filter(Number.isFinite);
  return finite.length ? Math.max(0, Math.min(...finite) - now) : null;
}

function renderNextUpdateCountdown() {
  if (!nextUpdateNote) return;
  const ms = nextUpdateEtaMs();
  if (ms == null) {
    nextUpdateNote.textContent = '';
    return;
  }
  const secs = Math.round(ms / 1000);
  nextUpdateNote.textContent = secs > 0 ? t('nextUpdateIn', { secs }) : t('updatingNow');
}

setInterval(renderNextUpdateCountdown, 1000);

async function init() {
  state.proxyUrl = PROXY_URL;
  // #loading-state (visible by default in index.html - not touched at
  // all until one of these produces something real) stays up until AT
  // LEAST one of these has real content to show - never the empty/
  // pending shell on its own. An earlier version painted a full,
  // still-empty day-pill row (every day dimmed/pending) immediately,
  // before either of these ran, specifically so the day-scroller's own
  // pill count would never visibly grow later - but showing that
  // empty shell AT ALL before real content existed was itself
  // live-reported as wrong: "force to load the first page already then
  // show the UI, don't load UI then load content, at least load one
  // page of content". buildDayList already generates the full
  // DEFAULT_DAYS_AHEAD calendar window regardless of how much real data
  // backs it (see its own comment), and visibleDays/isDayPending already
  // render a far-future day dimmed rather than hidden once real data
  // for SOME days exists - so the exact same "no pill-count jump later"
  // guarantee still holds once first paint happens here, it just no
  // longer happens before there's anything real to show at all.
  //
  // Paint from last visit's own cached build first, if one exists and
  // isn't too old (see "Instant-paint snapshot" above) - this already IS
  // real content, so it satisfies "at least one page of content" on its
  // own, faster than any network round trip could.
  const snapshot = loadMatchSnapshot();
  if (snapshot) {
    try {
      applyFreshBuild([...snapshot.rawMatches, ...snapshot.tbdMatches], snapshot.generatedAt);
    } catch (error) {
      console.error('failed to paint cached snapshot', error);
    }
  }
  // The prebuilt server snapshot (see "Prebuilt server snapshot" and
  // "Snapshot-first refreshing" above): tried first - the plain URL reuses
  // index.html's preload; if that copy is from another build or too old
  // (GitHub's CDN can hold the previous deploy's for a few minutes), once
  // more with a cache-busting query - bounded by
  // SERVER_SNAPSHOT_FIRST_PAINT_WAIT_MS in total. A current-enough one
  // replaces this load's own live build entirely: no proxy requests at all
  // until a live game needs polling. Otherwise (none, or one too old to
  // stand in for a live build - still painted as a head start) the live
  // full-window build below runs exactly as before.
  const serverSnapshot = await Promise.race([
    (async () => (await fetchServerSnapshot()) || fetchServerSnapshot({ bust: true }))(),
    new Promise(resolve => setTimeout(() => resolve(null), SERVER_SNAPSHOT_FIRST_PAINT_WAIT_MS))
  ]);
  if (serverSnapshot) {
    try {
      applyServerSnapshot(serverSnapshot);
    } catch (error) {
      console.error('failed to paint server snapshot', error);
    }
  }
  if (isSnapshotLiveEnough(serverSnapshot) && state.allRawMatches.length) {
    // refreshFullWindow would have run this; the snapshot path must too.
    checkForAppVersionUpdate().catch(() => {});
  } else {
    // See prefetchPolymarketEvents/prefetchStandings for why these start
    // before the build itself.
    prefetchPolymarketEvents();
    prefetchStandings();
    try {
      await refreshFullWindow({ silent: true, waitForOdds: true });
    } catch (error) {
      console.error(error);
    }
  }
  if (!state.allRawMatches.length && !state.tbdMatches.length) {
    // Nothing loaded at all yet (the fetch itself failed outright, e.g.
    // the proxy is unreachable, and there was no usable snapshot either)
    // - say so rather than leaving #loading-state up forever;
    // applyFreshBuild (which would otherwise hide it) never ran in this
    // branch, so it's still up - swap it for the explicit error message
    // instead of leaving both up at once. The scheduled retries below can
    // still recover this once network/the proxy comes back.
    if (loadingStateEl) loadingStateEl.hidden = true;
    // A genuinely-empty snapshot (no matches, no TBD fixtures either) can
    // have already shown #empty-state via applyFreshBuild's own empty
    // branch above, BEFORE this refresh went on to fail outright - without
    // this, both messages ("no matches right now" and "couldn't load
    // data") stayed up together, live-reported as exactly that (a real
    // screenshot showing both). The error is the more specific, more
    // actionable of the two here (it explains WHY nothing loaded, and the
    // scheduled retries below are what can actually fix it), so it wins.
    emptyState.hidden = true;
    errorState.hidden = false;
  }
  scheduleNearTermRefresh();
  // Also run the very first live poll immediately, rather than only after
  // scheduleLivePoll's own recurring setTimeout first elapses -
  // that timer waits a full LIVE_POLL_INTERVAL_MS (30s) BEFORE ever
  // calling pollLiveMatches for the first time. match.live (what
  // buildLiveStatusNode actually renders) is only ever set by
  // pollLiveMatches, so nothing else on this page could make a live
  // match's diamond/flag/pulsing-dot widget appear sooner than that -
  // reported directly as "quite a few seconds after loading" before the
  // live states show up, live-measured at up to ~30s. Unblocked (not
  // awaited) - this shouldn't delay first paint either.
  if (document.visibilityState !== 'hidden') {
    pollLiveMatches().catch(error => console.error('initial live poll failed', error));
  }
  scheduleLivePoll();
  // refreshFullWindow already ran once, awaited, above (including its own
  // version check) - just arm its own periodic timer for ongoing
  // freshness/update-checking from here, not a second redundant call.
  scheduleFullRefresh();
}

init();

// Keeps this site's own code on the device - see public/sw.js's own top
// comment. Registered after init() has already started the data fetch, so
// it never competes with it. A local checkout (no real build id) skips it,
// so local edits are never hidden behind a cached copy.
// `updateViaCache: 'none'` makes the browser check sw.js itself against the
// network on every visit, so a new deploy's worker is found right away.
if ('serviceWorker' in navigator && IS_DEPLOYED_BUILD) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(error => {
    console.warn('service worker registration failed', error);
  });
}
