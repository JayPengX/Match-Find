// ---- scripts/build-data.mjs ----
// Fetches upcoming fixtures for the Premier League, MLS, MLB, NBA, and F1
// from ESPN's public scoreboard API (no key required) across the next
// DAYS_AHEAD days, scores each one for competitiveness/watchability, and
// writes the flat result to public/data/matches.json for the static site
// to render.
//
// Runs at build time only (a scheduled GitHub Action, see
// .github/workflows/deploy.yml) - never per page view, and never triggered
// by a visitor's browser. This is the "AI recommendation runs automatically
// in the background" half of the site: Gemini scoring happens here, on a
// schedule, independent of anyone looking at the page.
//
// This script deliberately does NOT decide which matches get recommended,
// or exclude any time of day - see public/app.js's resolveViewingPlan for
// why that part has to run in the browser instead: "don't recommend a
// midnight fixture" and "what's the closest match right now" are both
// relative to a viewer's own local clock, which this script has no way to
// know at build time (one build serves every viewer, in every timezone).
// What this script DOES own is the one thing that isn't viewer-relative:
// how competitive/watchable a fixture is, which is why that scoring still
// happens once here and gets cached rather than recomputed per viewer.
//
// The "worth watching" judgment (competitiveness/watchability scores) comes
// from Orbit's shared Cloudflare Worker (see PROXY_URL below), which holds
// a Gemini API key server-side - this script never needs one of its own.
// If PROXY_URL isn't configured, or a call to it fails, matches fall back
// to a simple local heuristic (see heuristicScore) so the site still works,
// just with less insightful picks.
//
// Gemini is only ever asked to score a given match ONCE, the first build
// where that match appears inside the fetch window - see the AI score
// cache section below. A scheduled run every 6 hours would otherwise
// re-score the same heavily-overlapping window of fixtures on every single
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

// How many calendar days ahead (from today, UTC) to fetch. The site's day
// scroller shows the first 7 of these up front and reveals the rest on a
// "load more" click - all client-side, no extra network request, since
// everything through DAYS_AHEAD is already baked into matches.json by the
// time anyone opens the page. 14 gives that click something real to reveal.
const DAYS_AHEAD = 14;
// Cache entries for matches that started more than this long ago are
// dropped on every run - once a match has aired there's no reason to keep
// re-shipping its score in the cache file forever.
const CACHE_RETENTION_HOURS = 12;
// Orbit's /match-recommend route caps a single request at 80 fixtures (see
// that repo's cloudflare-worker/orbit-worker.js) - a 14-day window's first
// ever build can easily find several hundred NEW fixtures at once (nothing
// is cached yet), so those get sent in sequential batches under that cap
// rather than in one oversized request. Once the cache is warm, a normal
// 6-hourly run only has a handful of newly-in-window fixtures per batch.
const AI_SCORE_BATCH_SIZE = 75;

// Team-sport leagues, all sharing the same ESPN scoreboard shape
// (site.api.espn.com/apis/site/v2/sports/<sportKey>/<leagueKey>/scoreboard).
// durationMinutes is this script's only notion of "how long a match runs" -
// ESPN's scoreboard never gives an end time, so every conflict/scheduling
// decision (see app.js's resolveViewingPlan) works off this per-sport
// AVERAGE broadcast length, not any per-match actual duration.
const TEAM_LEAGUES = [
  { id: 'epl', sportKey: 'soccer', leagueKey: 'eng.1', label: 'Premier League', durationMinutes: 115 },
  { id: 'mls', sportKey: 'soccer', leagueKey: 'usa.1', label: 'MLS', durationMinutes: 115 },
  { id: 'mlb', sportKey: 'baseball', leagueKey: 'mlb', label: 'MLB', durationMinutes: 190 },
  { id: 'nba', sportKey: 'basketball', leagueKey: 'nba', label: 'NBA', durationMinutes: 150 }
];

const F1_LOGO = 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/leagues/500/f1.png';

function espnScoreboardUrl(sportKey, leagueKey, datesParam) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${sportKey}/${leagueKey}/scoreboard`;
  return datesParam ? `${base}?dates=${datesParam}` : base;
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

async function fetchTeamLeagueMatches(league, now, windowEndMs, daysAhead) {
  const dates = Array.from({ length: daysAhead }, (_, i) => yyyymmddUtc(new Date(now.getTime() + i * 86_400_000)));
  const results = await Promise.allSettled(
    dates.map(date => fetchJson(espnScoreboardUrl(league.sportKey, league.leagueKey, date)))
  );

  const matches = [];
  const seenIds = new Set();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const event of result.value.events || []) {
      if (seenIds.has(event.id)) continue; // a doubleheader's 2nd game can appear under both query dates near midnight UTC
      const competition = event.competitions?.[0];
      const state = competition?.status?.type?.state;
      if (state !== 'pre') continue; // already live or finished - not "upcoming"
      const startMs = Date.parse(event.date);
      if (!Number.isFinite(startMs) || startMs < now.getTime() || startMs > windowEndMs) continue;
      seenIds.add(event.id);

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
// the sense this site recommends. Unlike the team leagues, this needs an
// actual date-RANGE query (confirmed against the live API) to return more
// than just the single nearest race weekend.
async function fetchF1Matches(now, windowEndMs, daysAhead) {
  const rangeParam = `${yyyymmddUtc(now)}-${yyyymmddUtc(new Date(now.getTime() + daysAhead * 86_400_000))}`;
  let data;
  try {
    data = await fetchJson(espnScoreboardUrl('racing', 'f1', rangeParam));
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
// a match already scored BY GEMINI on an earlier run is never re-sent.
// Only startTimeUtc is kept alongside the score, purely so pruneCache can
// drop entries for matches that have already aired without needing to
// re-fetch anything.
//
// A cached entry with source:'heuristic' is deliberately NOT treated as
// done (see needsScoring in main()) - it means an earlier run couldn't
// reach the proxy (PROXY_URL unset, or the call failed) and fell back
// locally, not that Gemini actually judged this match. Caching that as
// final would permanently lock a match onto the heuristic the moment the
// proxy happened to be unavailable for even one run, with no way to ever
// pick up a real score later even after the proxy starts working - so
// every build keeps retrying any match that hasn't been scored by Gemini
// yet, for as long as it's still in the fetch window.
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

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

// Sends only the fixtures NOT already in the cache to Orbit's shared
// Cloudflare Worker, which owns the actual Gemini prompt/schema (see that
// repo's cloudflare-worker/orbit-worker.js, route /match-recommend) and
// holds the real API key - this script only ever sends {id, sport, name,
// startTimeUtc, context}, the same shape for every fixture regardless of
// sport. This is the entire reason Gemini quota use stays flat no matter
// how often the build runs: a match that was already scored on a previous
// run simply isn't included in the request body at all. Batched under
// AI_SCORE_BATCH_SIZE (see that constant's own comment) so a cold cache
// across a 14-day window never exceeds the proxy's per-request cap.
async function fetchAiScores(matchesNeedingScore) {
  if (!PROXY_URL || !matchesNeedingScore.length) return new Map();
  const picks = new Map();
  for (const batch of chunk(matchesNeedingScore, AI_SCORE_BATCH_SIZE)) {
    const payload = batch.map(m => ({
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
        continue;
      }
      const data = await response.json();
      for (const pick of Array.isArray(data.picks) ? data.picks : []) {
        picks.set(pick.id, pick);
      }
    } catch (error) {
      console.warn(`/match-recommend request failed: ${error.message}`);
    }
  }
  return picks;
}

async function main() {
  const now = new Date();
  const windowEndMs = now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000;

  const teamMatchLists = await Promise.all(
    TEAM_LEAGUES.map(league => fetchTeamLeagueMatches(league, now, windowEndMs, DAYS_AHEAD).catch(error => {
      console.warn(`Failed to fetch ${league.label}: ${error.message}`);
      return [];
    }))
  );
  const f1Matches = await fetchF1Matches(now, windowEndMs, DAYS_AHEAD).catch(error => {
    console.warn(`Failed to fetch F1: ${error.message}`);
    return [];
  });

  const matches = [...teamMatchLists.flat(), ...f1Matches];

  let cache = pruneCache(await loadCache(), now);
  const needsScoring = matches.filter(m => !cache[m.id] || cache[m.id].source !== 'ai');
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

  matches.sort((a, b) => Date.parse(a.startTimeUtc) - Date.parse(b.startTimeUtc));

  const output = {
    generatedAt: now.toISOString(),
    daysAhead: DAYS_AHEAD,
    source: matches.length === 0 ? 'none' : usedAi ? (matches.every(m => m.source === 'ai') ? 'ai' : 'mixed') : 'heuristic',
    matches
  };

  await mkdir(new URL('.', OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  await mkdir(new URL('.', CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
  console.log(
    `Wrote ${matches.length} matches to ${OUTPUT_PATH.pathname} (source: ${output.source}, ${needsScoring.length} newly scored, ${Object.keys(cache).length} cached)`
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
