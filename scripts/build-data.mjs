// ---- scripts/build-data.mjs ----
// Fetches upcoming fixtures for the Premier League, MLS, MLB, NBA, and F1
// from ESPN's public scoreboard API (no key required), scores each one for
// competitiveness/watchability, builds one continuous "what to watch"
// viewing plan for the window (see resolveViewingPlan), and writes the
// result to public/data/matches.json for the static site to render.
//
// Runs at build time only (a scheduled GitHub Action, see
// .github/workflows/deploy.yml) - never per page view. The site itself just
// reads the JSON this produces and converts each match's UTC start time to
// the viewer's own local time in the browser.
//
// The "worth watching" judgment (competitiveness/watchability scores) comes
// from Orbit's shared Cloudflare Worker (see PROXY_URL below), which holds
// a Gemini API key server-side - this script never needs one of its own.
// If PROXY_URL isn't configured, or the call fails, matches fall back to a
// simple local heuristic (see heuristicScore) so the site still works, just
// with less insightful picks.
//
// Gemini is only ever asked to score a given match ONCE, the first build
// where that match appears inside the fetch window - see the AI score
// cache section below. A scheduled run every 6 hours would otherwise
// re-score the same ~30-hour-overlapping window of fixtures on every single
// run, burning quota for a judgment that doesn't change between builds.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { teamNameZh, f1RaceNameZh } from './team-names.mjs';

const PROXY_URL = (process.env.PROXY_URL || '').trim().replace(/\/+$/, '');
const OUTPUT_PATH = new URL('../public/data/matches.json', import.meta.url);
// Committed to the repo (unlike matches.json, which is fully regenerated
// every run) - this is the persistent record of which matches have already
// been scored by Gemini, so it has to survive between separate workflow
// runs. See .github/workflows/deploy.yml's "Commit updated AI score cache"
// step for how it gets pushed back.
const CACHE_PATH = new URL('../data/ai-cache.json', import.meta.url);

// How far ahead to look for fixtures. 36 hours comfortably covers "today and
// tomorrow" for every timezone without pulling in so much MLB/soccer volume
// that the page gets unwieldy.
const WINDOW_HOURS = 36;
// Cache entries for matches that started more than this long ago are
// dropped on every run - once a match has aired there's no reason to keep
// re-shipping its score in the cache file forever.
const CACHE_RETENTION_HOURS = 12;

// Team-sport leagues, all sharing the same ESPN scoreboard shape
// (site.api.espn.com/apis/site/v2/sports/<sportKey>/<leagueKey>/scoreboard).
// durationMinutes is this script's only notion of "how long a match runs" -
// ESPN's scoreboard never gives an end time, so every conflict/scheduling
// decision below (see resolveViewingPlan) works off this per-sport AVERAGE
// broadcast length, not any per-match actual duration.
const TEAM_LEAGUES = [
  { id: 'epl', sportKey: 'soccer', leagueKey: 'eng.1', label: 'Premier League', durationMinutes: 115 },
  { id: 'mls', sportKey: 'soccer', leagueKey: 'usa.1', label: 'MLS', durationMinutes: 115 },
  { id: 'mlb', sportKey: 'baseball', leagueKey: 'mlb', label: 'MLB', durationMinutes: 190 },
  { id: 'nba', sportKey: 'basketball', leagueKey: 'nba', label: 'NBA', durationMinutes: 150 }
];

const F1_LOGO = 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/leagues/500/f1.png';

function espnScoreboardUrl(sportKey, leagueKey, yyyymmdd) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${sportKey}/${leagueKey}/scoreboard`;
  return yyyymmdd ? `${base}?dates=${yyyymmdd}` : base;
}

function yyyymmddUtc(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

// One competitor's overall win-loss record as {wins, losses}, or null if
// ESPN didn't report one (a brand new season, or a sport/league whose
// records aren't shaped like "W-L", e.g. soccer's points-based standings
// aren't summarized here at all). Only used for the local heuristic
// fallback and for the short human-readable context string handed to
// Gemini - never trusted for anything more precise than "roughly how good
// is this team right now".
function parseOverallRecord(competitor) {
  const summary = (competitor.records || []).find(r => r.type === 'total' || r.name === 'overall')
    ?.summary;
  const match = /^(\d+)-(\d+)(?:-(\d+))?$/.exec(summary || '');
  if (!match) return null;
  return { wins: Number(match[1]), losses: Number(match[2]) };
}

function buildCompetitor(leagueId, c) {
  const abbreviation = c.team?.abbreviation || '';
  return {
    name: c.team?.displayName || 'Unknown',
    nameZh: teamNameZh(leagueId, abbreviation),
    abbreviation,
    logo: c.team?.logo || '',
    homeAway: c.homeAway || '',
    record: parseOverallRecord(c)
  };
}

function competitorContext(competitor) {
  const record = competitor.record;
  return record ? `${competitor.name} (${record.wins}-${record.losses})` : competitor.name;
}

async function fetchTeamLeagueMatches(league, now, windowEndMs) {
  const dates = [yyyymmddUtc(now), yyyymmddUtc(new Date(now.getTime() + 24 * 60 * 60 * 1000))];
  const results = await Promise.allSettled(
    dates.map(date => fetchJson(espnScoreboardUrl(league.sportKey, league.leagueKey, date)))
  );

  const matches = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const event of result.value.events || []) {
      const competition = event.competitions?.[0];
      const state = competition?.status?.type?.state;
      if (state !== 'pre') continue; // already live or finished - not "upcoming"
      const startMs = Date.parse(event.date);
      if (!Number.isFinite(startMs) || startMs < now.getTime() || startMs > windowEndMs) continue;

      // Always [away, home] regardless of the order ESPN happens to list
      // them in, so `name`/`nameZh` below are built consistently as
      // "AWAY @ HOME" for every sport - the same convention ESPN's own
      // shortName uses, just under this script's own control so an English
      // and a Chinese version can be built the same way.
      const rawCompetitors = (competition.competitors || []).map(c => buildCompetitor(league.id, c));
      const away = rawCompetitors.find(c => c.homeAway === 'away') || rawCompetitors[0];
      const home = rawCompetitors.find(c => c.homeAway === 'home') || rawCompetitors[1];
      const competitors = [away, home].filter(Boolean);
      if (competitors.length !== 2) continue;

      const broadcast = (competition.broadcasts || [])
        .flatMap(b => b.names || [])
        .slice(0, 1)[0];

      matches.push({
        id: `${league.id}-${event.id}`,
        sport: league.label,
        name: `${away.name} @ ${home.name}`,
        nameZh: away.nameZh && home.nameZh ? `${away.nameZh} @ ${home.nameZh}` : '',
        startTimeUtc: new Date(startMs).toISOString(),
        durationMinutes: league.durationMinutes,
        venue: competition.venue?.fullName || '',
        broadcast: broadcast || '',
        logo: '',
        competitors,
        context: competitors.map(competitorContext).join(' vs ')
      });
    }
  }
  return matches;
}

// F1 has a completely different ESPN shape: one "event" is a whole race
// weekend, and its "competitions" array is the individual sessions (FP1,
// FP2, FP3, Qualifying, Race) rather than per-team competitors - see the
// research notes in this repo's history. Only the Race session itself is
// surfaced here; practice/qualifying sessions aren't "a match to watch" in
// the sense this site recommends.
async function fetchF1Matches(now, windowEndMs) {
  let data;
  try {
    data = await fetchJson(espnScoreboardUrl('racing', 'f1'));
  } catch {
    return [];
  }
  const matches = [];
  for (const event of data.events || []) {
    const raceSession = (event.competitions || []).find(c => c.type?.abbreviation === 'Race');
    if (!raceSession) continue;
    const state = raceSession.status?.type?.state;
    if (state !== 'pre') continue;
    const startMs = Date.parse(raceSession.date || event.date);
    if (!Number.isFinite(startMs) || startMs < now.getTime() || startMs > windowEndMs) continue;

    matches.push({
      id: `f1-${event.id}`,
      sport: 'F1',
      name: event.name,
      nameZh: f1RaceNameZh(event.name),
      startTimeUtc: new Date(startMs).toISOString(),
      durationMinutes: 120,
      venue: event.circuit?.fullName || '',
      broadcast: '',
      logo: F1_LOGO,
      competitors: [],
      context: `${event.name} - Formula 1 race`
    });
  }
  return matches;
}

// Used when Gemini scoring isn't available (PROXY_URL unset, or the call
// failed) - a rough, purely local stand-in so the site still has something
// to show. Closer win-loss records score more "competitive"; two strong
// records score more "watchable". Deliberately conservative (never above 8)
// since this has no real sports knowledge behind it.
function heuristicScore(match) {
  const records = match.competitors.map(c => c.record).filter(Boolean);
  if (records.length !== 2) {
    return { competitiveness: 5, watchability: 5, reason: 'No record data available for either side yet.' };
  }
  const winRates = records.map(r => r.wins / Math.max(1, r.wins + r.losses));
  const diff = Math.abs(winRates[0] - winRates[1]);
  const avg = (winRates[0] + winRates[1]) / 2;
  return {
    competitiveness: Math.max(1, Math.min(8, Math.round(8 - diff * 16))),
    watchability: Math.max(1, Math.min(8, Math.round(avg * 10))),
    // The UI itself appends the "(estimated, no AI recommendation)" caveat
    // (see styles.css .is-heuristic) - this stays purely descriptive so the
    // two don't repeat each other.
    reason: `Estimated from each side's current win-loss record (${records[0].wins}-${records[0].losses} vs ${records[1].wins}-${records[1].losses}).`
  };
}

// ---- AI score cache ---------------------------------------------------
// Keyed by match id (stable across runs - see how ids are built above), so
// a match already scored on an earlier run is never re-sent to Gemini. Only
// startTimeUtc is kept alongside the score, purely so pruneCache can drop
// entries for matches that have already aired without needing to re-fetch
// anything.
async function loadCache() {
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function pruneCache(cache, now) {
  const cutoff = now.getTime() - CACHE_RETENTION_HOURS * 60 * 60 * 1000;
  const pruned = {};
  for (const [id, entry] of Object.entries(cache)) {
    if (Date.parse(entry.startTimeUtc) >= cutoff) pruned[id] = entry;
  }
  return pruned;
}

// Sends only the fixtures NOT already in the cache to Orbit's shared
// Cloudflare Worker, which owns the actual Gemini prompt/schema (see that
// repo's cloudflare-worker/orbit-worker.js, route /match-recommend) and
// holds the real API key - this script only ever sends {id, sport, name,
// startTimeUtc, context}, the same shape for every fixture regardless of
// sport. This is the entire reason Gemini quota use stays flat no matter
// how often the build runs: a match that was already scored on a previous
// run simply isn't included in the request body at all.
async function fetchAiScores(matchesNeedingScore) {
  if (!PROXY_URL || !matchesNeedingScore.length) return new Map();
  const payload = matchesNeedingScore.map(m => ({
    id: m.id,
    sport: m.sport,
    name: m.name,
    startTimeUtc: m.startTimeUtc,
    context: m.context
  }));
  try {
    const response = await fetch(`${PROXY_URL}/match-recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matches: payload }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) {
      console.warn(`/match-recommend -> HTTP ${response.status}: ${await response.text().catch(() => '')}`);
      return new Map();
    }
    const data = await response.json();
    const picks = Array.isArray(data.picks) ? data.picks : [];
    return new Map(picks.map(pick => [pick.id, pick]));
  } catch (error) {
    console.warn(`/match-recommend request failed: ${error.message}`);
    return new Map();
  }
}

// ---- Continuous viewing plan -------------------------------------------
//
// "Worth watching" alone isn't enough to build a day's recommendations from
// - two great matches airing at the same time still only let a viewer
// actually watch one of them. This picks the set of matches across the
// WHOLE window (every sport combined - one plan, not one per league) that
// maximizes total score while staying watchable back-to-back, using a
// classic weighted-interval-scheduling-style DP generalized with a bit of
// tolerance:
//
//   - A small base tolerance (OVERLAP_TOLERANCE_BASE_MINUTES) absorbs the
//     fact that durationMinutes is only ever a per-sport AVERAGE, not this
//     match's actual length - without it, a real match that overruns its
//     sport's average by even a few minutes would look like a "conflict"
//     with whatever the plan lined up right after it.
//   - A much larger tolerance (OVERLAP_TOLERANCE_HIGH_SCORE_MINUTES)
//     applies whenever either match involved has a high score - this is
//     the deliberate "allow overlap in certain scenarios" behavior: a
//     must-watch match is allowed to eat into the next slot rather than
//     being dropped from the plan, or dropping its neighbor, over a
//     genuinely minor overlap.
//
// This is a good, cheap heuristic for a viewing plan, not a certified
// globally-optimal schedule - with arbitrary (non-monotonic) compatibility
// between matches, "pick the best plan" in general is the maximum-weight
// independent set problem, which is NP-hard. At the scale this ever runs
// at (well under 100 fixtures per window), checking every pair directly
// (see compatible() below) is both fast enough and good enough.
const OVERLAP_TOLERANCE_BASE_MINUTES = 10;
const OVERLAP_TOLERANCE_HIGH_SCORE_MINUTES = 40;
const HIGH_SCORE_THRESHOLD = 8;

function matchInterval(match) {
  const start = Date.parse(match.startTimeUtc);
  return { start, end: start + match.durationMinutes * 60_000 };
}

function overlapMinutes(a, b) {
  const overlapStart = Math.max(a.interval.start, b.interval.start);
  const overlapEnd = Math.min(a.interval.end, b.interval.end);
  return overlapEnd > overlapStart ? (overlapEnd - overlapStart) / 60_000 : 0;
}

// `earlier` must end at or before `later` starts, within tolerance -
// tolerance is decided by whichever of the two has the higher score, per
// this function's own top-of-section comment.
function compatible(later, earlier) {
  const toleranceMinutes =
    Math.max(later.competitiveness + later.watchability, earlier.competitiveness + earlier.watchability) / 2 >=
    HIGH_SCORE_THRESHOLD
      ? OVERLAP_TOLERANCE_HIGH_SCORE_MINUTES
      : OVERLAP_TOLERANCE_BASE_MINUTES;
  const gapMinutes = (later.interval.start - earlier.interval.end) / 60_000;
  return gapMinutes >= -toleranceMinutes;
}

export function resolveViewingPlan(matches) {
  const sorted = [...matches]
    .map(match => ({ ...match, interval: matchInterval(match) }))
    .sort((a, b) => a.interval.end - b.interval.end);

  // dp[i]: best total score of a valid plan that ends by taking sorted[i].
  // best[i]: best total score achievable using only sorted[0..i] (may or
  // may not include sorted[i]) - this is what lets "skip i entirely" stay
  // on the table without a separate branch.
  const dp = new Array(sorted.length).fill(0);
  const predecessor = new Array(sorted.length).fill(-1);
  const best = new Array(sorted.length).fill(0);

  for (let i = 0; i < sorted.length; i++) {
    let bestPredScore = 0;
    let bestPredIndex = -1;
    for (let j = 0; j < i; j++) {
      if (compatible(sorted[i], sorted[j]) && best[j] > bestPredScore) {
        bestPredScore = best[j];
        bestPredIndex = j;
      }
    }
    dp[i] = sorted[i].score + bestPredScore;
    predecessor[i] = bestPredIndex;
    best[i] = Math.max(i > 0 ? best[i - 1] : 0, dp[i]);
  }

  // Backtrack from whichever index actually achieves the final best[] value.
  const selected = new Set();
  let cursor = sorted.length - 1;
  let target = sorted.length ? best[sorted.length - 1] : 0;
  while (cursor >= 0) {
    if (cursor > 0 && best[cursor - 1] === target) {
      cursor -= 1;
      continue;
    }
    selected.add(cursor);
    target = dp[cursor] - sorted[cursor].score;
    cursor = predecessor[cursor];
  }

  sorted.forEach((match, index) => {
    match.recommended = selected.has(index);
  });

  // Informational only, independent of the plan above: which OTHER matches
  // does this one's raw time window overlap, regardless of whether either
  // is actually in the recommended plan. Powers the UI's "X overlaps with
  // Y" notes for both the recommended side (an allowed high-score overlap)
  // and the non-recommended side (why this one was left out).
  sorted.forEach((match, index) => {
    match.overlappingIds = sorted
      .filter((other, otherIndex) => otherIndex !== index && overlapMinutes(match, other) > 0)
      .map(other => other.id);
  });

  // Recommended matches whose plan neighbor still overlaps them (only
  // possible via the high-score tolerance above) get a note naming the
  // overlap explicitly, so a real, deliberate overlap is never silently
  // indistinguishable from an ordinary back-to-back pick.
  const recommendedSorted = sorted.filter(m => m.recommended).sort((a, b) => a.interval.start - b.interval.start);
  for (let i = 1; i < recommendedSorted.length; i++) {
    const minutes = overlapMinutes(recommendedSorted[i], recommendedSorted[i - 1]);
    if (minutes > 0) {
      recommendedSorted[i].overlapsWithPrevious = {
        id: recommendedSorted[i - 1].id,
        minutes: Math.round(minutes)
      };
    }
  }

  return sorted
    .sort((a, b) => a.interval.start - b.interval.start)
    .map(({ interval, ...match }) => match);
}

async function main() {
  const now = new Date();
  const windowEndMs = now.getTime() + WINDOW_HOURS * 60 * 60 * 1000;

  const teamMatchLists = await Promise.all(
    TEAM_LEAGUES.map(league => fetchTeamLeagueMatches(league, now, windowEndMs).catch(error => {
      console.warn(`Failed to fetch ${league.label}: ${error.message}`);
      return [];
    }))
  );
  const f1Matches = await fetchF1Matches(now, windowEndMs).catch(error => {
    console.warn(`Failed to fetch F1: ${error.message}`);
    return [];
  });

  const matches = [...teamMatchLists.flat(), ...f1Matches];

  let cache = pruneCache(await loadCache(), now);
  const needsScoring = matches.filter(m => !cache[m.id]);
  const freshPicks = await fetchAiScores(needsScoring);

  for (const match of needsScoring) {
    const pick = freshPicks.get(match.id);
    if (pick && Number.isFinite(pick.competitiveness) && Number.isFinite(pick.watchability)) {
      cache[match.id] = {
        startTimeUtc: match.startTimeUtc,
        competitiveness: Math.max(1, Math.min(10, Math.round(pick.competitiveness))),
        watchability: Math.max(1, Math.min(10, Math.round(pick.watchability))),
        reason: String(pick.reason || '').slice(0, 300),
        source: 'ai'
      };
    } else {
      cache[match.id] = { startTimeUtc: match.startTimeUtc, ...heuristicScore(match), source: 'heuristic' };
    }
  }

  let usedAi = false;
  for (const match of matches) {
    const scored = cache[match.id];
    match.competitiveness = scored.competitiveness;
    match.watchability = scored.watchability;
    match.reason = scored.reason;
    match.source = scored.source;
    if (scored.source === 'ai') usedAi = true;
    match.score = Math.round(((match.competitiveness + match.watchability) / 2) * 10) / 10;
  }

  const plan = resolveViewingPlan(matches);
  const spotlightId = plan.length ? plan.reduce((a, b) => (b.score > a.score ? b : a)).id : null;

  const output = {
    generatedAt: now.toISOString(),
    windowHours: WINDOW_HOURS,
    source: matches.length === 0 ? 'none' : usedAi ? (matches.every(m => m.source === 'ai') ? 'ai' : 'mixed') : 'heuristic',
    spotlightId,
    matches: plan
  };

  await mkdir(new URL('.', OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  await mkdir(new URL('.', CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
  console.log(
    `Wrote ${plan.length} matches to ${OUTPUT_PATH.pathname} (source: ${output.source}, ${needsScoring.length} newly scored, ${Object.keys(cache).length} cached)`
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
