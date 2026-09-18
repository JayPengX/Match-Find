// ---- scripts/build-data.mjs ----
// Fetches upcoming fixtures for the Premier League, MLS, MLB, NBA, and F1
// from ESPN's public scoreboard API (no key required), scores each one for
// competitiveness/watchability, resolves same-time conflicts by picking the
// highest-scoring fixture per overlapping window, and writes the result to
// public/data/matches.json for the static site to render.
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

import { writeFile, mkdir } from 'node:fs/promises';

const PROXY_URL = (process.env.PROXY_URL || '').trim().replace(/\/+$/, '');
const OUTPUT_PATH = new URL('../public/data/matches.json', import.meta.url);

// How far ahead to look for fixtures. 36 hours comfortably covers "today and
// tomorrow" for every timezone without pulling in so much MLB/soccer volume
// that the Gemini prompt (and the page) gets unwieldy.
const WINDOW_HOURS = 36;

// Team-sport leagues, all sharing the same ESPN scoreboard shape
// (site.api.espn.com/apis/site/v2/sports/<sportKey>/<leagueKey>/scoreboard).
// durationMinutes is a rough estimate of how long a live broadcast actually
// occupies a viewer's evening - used only to detect time conflicts between
// fixtures, not shown to the user.
const TEAM_LEAGUES = [
  { id: 'epl', sportKey: 'soccer', leagueKey: 'eng.1', label: 'Premier League', durationMinutes: 115 },
  { id: 'mls', sportKey: 'soccer', leagueKey: 'usa.1', label: 'MLS', durationMinutes: 115 },
  { id: 'mlb', sportKey: 'baseball', leagueKey: 'mlb', label: 'MLB', durationMinutes: 190 },
  { id: 'nba', sportKey: 'basketball', leagueKey: 'nba', label: 'NBA', durationMinutes: 150 }
];

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

function competitorContext(competitor) {
  const record = parseOverallRecord(competitor);
  const name = competitor.team?.displayName || competitor.athlete?.displayName || 'Unknown';
  return record ? `${name} (${record.wins}-${record.losses})` : name;
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

      const competitors = (competition.competitors || []).map(c => ({
        name: c.team?.displayName || 'Unknown',
        homeAway: c.homeAway || '',
        record: parseOverallRecord(c)
      }));
      const broadcast = (competition.broadcasts || [])
        .flatMap(b => b.names || [])
        .slice(0, 1)[0];

      matches.push({
        id: `${league.id}-${event.id}`,
        sport: league.label,
        name: event.shortName || event.name,
        startTimeUtc: new Date(startMs).toISOString(),
        durationMinutes: league.durationMinutes,
        venue: competition.venue?.fullName || '',
        broadcast: broadcast || '',
        competitors,
        context: (competition.competitors || []).map(competitorContext).join(' vs ')
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
      startTimeUtc: new Date(startMs).toISOString(),
      durationMinutes: 120,
      venue: event.circuit?.fullName || '',
      broadcast: '',
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

// Sends the fixture list to Orbit's shared Cloudflare Worker, which owns
// the actual Gemini prompt/schema (see that repo's cloudflare-worker/
// orbit-worker.js, route /match-recommend) and holds the real API key -
// this script only ever sends {id, sport, name, startTimeUtc, context}, the
// same shape for every fixture regardless of sport.
async function fetchAiScores(matches) {
  if (!PROXY_URL) return new Map();
  const payload = matches.map(m => ({
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

// Groups matches whose live windows overlap (start to start+duration) into
// clusters via a simple sorted sweep, then marks the single highest-scoring
// match in each cluster as the recommended pick - this is what "if time
// conflict it will choose based on competitiveness and watchability" means
// in practice. A UTC overlap is the same overlap for every viewer
// regardless of timezone (a local-time conversion doesn't change whether
// two instants overlap), so this only ever needs to run once at build time,
// not per viewer.
function resolveConflicts(matches) {
  const sorted = [...matches].sort((a, b) => Date.parse(a.startTimeUtc) - Date.parse(b.startTimeUtc));
  let clusterEnd = -Infinity;
  let cluster = [];
  const clusters = [];
  for (const match of sorted) {
    const start = Date.parse(match.startTimeUtc);
    const end = start + match.durationMinutes * 60_000;
    if (start < clusterEnd) {
      cluster.push(match);
    } else {
      if (cluster.length) clusters.push(cluster);
      cluster = [match];
    }
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length) clusters.push(cluster);

  for (const group of clusters) {
    const best = group.reduce((a, b) => (b.score > a.score ? b : a));
    for (const match of group) {
      match.recommended = match === best;
      match.conflictsWith = group.filter(m => m !== match).map(m => m.id);
    }
  }
  return sorted;
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

  const aiPicks = await fetchAiScores(matches);
  let usedAi = false;
  for (const match of matches) {
    const pick = aiPicks.get(match.id);
    if (pick && Number.isFinite(pick.competitiveness) && Number.isFinite(pick.watchability)) {
      match.competitiveness = Math.max(1, Math.min(10, Math.round(pick.competitiveness)));
      match.watchability = Math.max(1, Math.min(10, Math.round(pick.watchability)));
      match.reason = String(pick.reason || '').slice(0, 300);
      match.source = 'ai';
      usedAi = true;
    } else {
      Object.assign(match, heuristicScore(match));
      match.source = 'heuristic';
    }
    match.score = Math.round(((match.competitiveness + match.watchability) / 2) * 10) / 10;
  }

  const sorted = resolveConflicts(matches);
  const spotlightId = sorted.length
    ? sorted.reduce((a, b) => (b.score > a.score ? b : a)).id
    : null;

  const output = {
    generatedAt: now.toISOString(),
    windowHours: WINDOW_HOURS,
    source: matches.length === 0 ? 'none' : usedAi ? (matches.every(m => m.source === 'ai') ? 'ai' : 'mixed') : 'heuristic',
    spotlightId,
    matches: sorted
  };

  await mkdir(new URL('.', OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${sorted.length} matches to ${OUTPUT_PATH.pathname} (source: ${output.source})`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
