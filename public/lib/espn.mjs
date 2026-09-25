// ---- public/lib/espn.mjs ----
//
// The small, pure, browser-safe half of talking to ESPN's public scoreboard
// API that app.js's own live-score/live-odds polling needs (see that file's
// pollLiveMatches) - kept separate from public/lib/match-builder.mjs's own (much
// larger) ESPN-fetching logic since the build script's job is building the
// whole matches.json from scratch (every league, every day, TBD handling,
// objective scoring, ...) while this module's only job is "given a fixture
// that's already in the page, get its CURRENT score/status again" - a much
// narrower, purely client-side concern. Nothing here computes a score or
// duration; it only extracts the same live fields ESPN already reports.
//
// Every fetch this module builds a URL for goes through the shared proxy's
// /sports-proxy route (see app.js), never straight to ESPN - browsers can't
// read a cross-origin response ESPN itself sends no CORS headers for.
//
// The win% odds bar reads Polymarket first - see ./polymarket.mjs (ESPN's
// own sportsbook feed doesn't cover every sport this app tracks, F1 in
// particular, and moves slower). The sportsbook moneyline read below is
// only its pre-game fallback (see ./sportsbook-odds.mjs). Score/status and
// the spread/over-under signal the scoring engine uses also come from here.

import { parsePlayoffInfo } from './playoff.mjs';
import { parseSportsbookWinPct } from './sportsbook-odds.mjs';

export function espnScoreboardUrl(sportKey, leagueKey, datesParam) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${sportKey}/${leagueKey}/scoreboard`;
  return datesParam ? `${base}?dates=${datesParam}` : base;
}

// Mirrors public/lib/match-builder.mjs's own TEAM_LEAGUES table (sportKey/
// leagueKey) plus the id prefix that table's own `league.id` contributes to
// every fixture's own `id` (`${league.id}-${event.id}`, see that script's
// fetchTeamLeagueMatches) - kept as a small, separate, browser-safe copy
// rather than importing the Node script directly, since that script also
// pulls in fs/duration-prediction/objective-scoring modules this client
// bundle has no reason to ship. F1 has no entry here - it has no live
// score to poll (see pollLiveMatches's own comment on why F1 is excluded).
export const TEAM_LEAGUE_ESPN = {
  'Premier League': { id: 'epl', sportKey: 'soccer', leagueKey: 'eng.1' },
  MLB: { id: 'mlb', sportKey: 'baseball', leagueKey: 'mlb' },
  NBA: { id: 'nba', sportKey: 'basketball', leagueKey: 'nba' }
};

function yyyymmddUtc(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

// The ESPN scoreboard requests needed to catch every currently-live fixture
// of one league - today AND yesterday (UTC), by the same reasoning as
// match-builder.mjs's own lookback (a live fixture can still be grouped
// under ESPN's own PREVIOUS calendar day depending on the league's home
// timezone), which is all a LIVE-only poll ever needs (a fixture that's
// actually live right now cannot be further than one ESPN calendar day off
// from "now").
//
// TWO single-date requests, never one `dates=YYYYMMDD-YYYYMMDD` range
// request - live-confirmed (2026-09-20, a real 400 from
// baseball/mlb/scoreboard?dates=20260920-20260921, caught only because this
// app's own live-poll silently swallows a failed fetch per league and
// nothing had ever surfaced it) that ESPN's TEAM-SPORT scoreboard endpoint
// rejects a multi-day range outright, unlike its racing/f1 endpoint (see
// f1LiveScoreboardUrl below, and match-builder.mjs's own fetchTeamLeagueMatches
// for the exact same fix applied to the full-window build fetch). Every
// team-sport live poll had been silently failing outright before this fix -
// not a partial/degraded result, a 400 on every single tick.
export function liveScoreboardUrls(sport, now = new Date()) {
  const league = TEAM_LEAGUE_ESPN[sport];
  if (!league) return [];
  return [new Date(now.getTime() - 86_400_000), now].map(date =>
    espnScoreboardUrl(league.sportKey, league.leagueKey, yyyymmddUtc(date))
  );
}

// Extracts {id -> {isLive, isFinished, scores: [awayScore, homeScore],
// oddsSpread, oddsOverUnder}} from one league's scoreboard response - `id` matches Match Find's own fixture id
// convention exactly
// (`${league.id}-${event.id}`) so app.js can merge this straight into
// state.allRawMatches by id with no extra lookup table. Scores are read as
// plain numbers (or null when ESPN hasn't posted one yet, e.g. a scoreless
// 'pre' fixture) - never guessed or defaulted to 0, since a real 0-0 score
// is a genuine, different fact from "not started/not reported".
//
// `situation` (baseball only - MLB's own live at-bat context: balls,
// strikes, outs, who's on base) is read straight off ESPN's own
// `competition.situation` object, live-confirmed against real in-progress
// games (2026-09-20's Tigers @ White Sox and Brewers @ Orioles) rather
// than guessed from documentation - null whenever that object is absent
// (a 'pre'/'post' fixture, or a sport ESPN doesn't report it for at all),
// never a guessed/defaulted "no runners on" for a game that just hasn't
// reported yet.
export function extractLiveUpdates(sport, scoreboardJson) {
  const league = TEAM_LEAGUE_ESPN[sport];
  const updates = new Map();
  if (!league) return updates;
  for (const event of scoreboardJson?.events || []) {
    const competition = event.competitions?.[0];
    const statusType = competition?.status?.type;
    if (!competition || !statusType) continue;
    const rawCompetitors = competition.competitors || [];
    const away = rawCompetitors.find(c => c.homeAway === 'away');
    const home = rawCompetitors.find(c => c.homeAway === 'home');
    const toScore = c => {
      const n = Number(c?.score);
      return Number.isFinite(n) ? n : null;
    };
    const odds = competition.odds?.[0];
    const spread = Number(odds?.spread);
    const overUnder = Number(odds?.overUnder);
    const rawSituation = competition.situation;
    const situation =
      rawSituation && (rawSituation.outs != null || rawSituation.balls != null)
        ? {
            balls: Number.isFinite(rawSituation.balls) ? rawSituation.balls : null,
            strikes: Number.isFinite(rawSituation.strikes) ? rawSituation.strikes : null,
            outs: Number.isFinite(rawSituation.outs) ? rawSituation.outs : null,
            onFirst: !!rawSituation.onFirst,
            onSecond: !!rawSituation.onSecond,
            onThird: !!rawSituation.onThird
          }
        : null;
    updates.set(`${league.id}-${event.id}`, {
      isLive: statusType.state === 'in',
      isFinished: statusType.state === 'post',
      scores: [toScore(away), toScore(home)],
      period: competition.status?.period ?? null,
      displayClock: typeof competition.status?.displayClock === 'string' ? competition.status.displayClock : '',
      shortDetail: statusType.shortDetail || '',
      situation,
      oddsSpread: Number.isFinite(spread) ? spread : null,
      oddsOverUnder: Number.isFinite(overUnder) ? overUnder : null,
      // Pre-game only (null once 'in'/'post' - ESPN drops the line then).
      bookOdds: statusType.state === 'pre' ? parseSportsbookWinPct(competition, { hasDraw: sport === 'Premier League' }) : null,
      // The series score moves the moment a playoff game ends - carried
      // here so the card's series line updates with the final score
      // instead of waiting for the next full rebuild.
      playoff: event.season?.type === 3 || event.season?.type === 5 ? parsePlayoffInfo(competition) : null
    });
  }
  return updates;
}

// F1's own live in-race context - same shape of problem as extractLiveUpdates
// above but a completely different ESPN response shape (see
// match-builder.mjs's own comment on fetchF1Matches: one event is a whole
// race weekend, its `competitions` are the individual sessions, and THOSE
// carry a `competitors` array of drivers - ordered by current/final
// classification via `order` - rather than two team sides). Only the
// session types this app actually tracks as matches (Race/Qual/Sprint -
// see match-builder.mjs's F1_SESSION_TYPES) are extracted; ids are built
// with the exact same `f1-${event.id}-${abbreviation.toLowerCase()}`
// convention that module uses so this merges straight into
// state.allRawMatches by id.
const F1_LIVE_SESSION_ABBREVIATIONS = ['Race', 'Qual', 'SR'];

export function f1LiveScoreboardUrl(now = new Date()) {
  const dates = `${yyyymmddUtc(new Date(now.getTime() - 86_400_000))}-${yyyymmddUtc(now)}`;
  return espnScoreboardUrl('racing', 'f1', dates);
}

// Top three by `order` (ESPN's own current-classification field - live
// running order during the race itself, final finishing order once it's
// over) as {name, position, flagUrl, flagAlt, interval} - just enough for a
// short "誰目前領先" line alongside this sport's own Polymarket
// outright-winner odds (see app.js's f1LeaderboardLine), not a full
// 20-driver standings table. flagUrl/flagAlt come from ESPN's own
// `athlete.flag` (a small nationality-flag image ESPN already serves for
// every driver) - the only per-driver "icon" this API actually has; ESPN's
// F1 competitor object has no headshot and no constructor/team field at
// all (live-checked against several real race weekends, finished and
// upcoming), so a flag is the one real, non-fabricated visual this can show
// per driver rather than a generic silhouette. `interval` is read from
// `competitor.statistics` on a best-effort basis ONLY - live-checked
// against several real race weekends (both finished and in the days
// immediately around one) and this array was empty([]) every single time,
// suggesting ESPN's public site API may never actually populate a
// live gap/interval figure here at all (that level of live timing detail
// looks like it may be exclusive to F1's own timing feed, not ESPN's) -
// this still reads it defensively (never guessed/computed locally) so it
// picks it up automatically the moment ESPN ever does report it, rather
// than requiring another code change later.
function f1DriverInterval(statistics) {
  const stat = (statistics || []).find(s =>
    ['GAP', 'INTERVAL', 'TIME'].includes(String(s?.abbreviation || s?.name || '').toUpperCase())
  );
  return typeof stat?.displayValue === 'string' && stat.displayValue ? stat.displayValue : null;
}

export function extractF1LiveUpdates(scoreboardJson) {
  const updates = new Map();
  for (const event of scoreboardJson?.events || []) {
    for (const abbreviation of F1_LIVE_SESSION_ABBREVIATIONS) {
      const session = (event.competitions || []).find(c => c.type?.abbreviation === abbreviation);
      const statusType = session?.status?.type;
      if (!session || !statusType) continue;
      const leaderboard = (session.competitors || [])
        .slice()
        .sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999))
        .slice(0, 3)
        .map(c => ({
          name: c.athlete?.shortName || c.athlete?.fullName || '',
          position: Number(c.order) || null,
          flagUrl: c.athlete?.flag?.href || '',
          flagAlt: c.athlete?.flag?.alt || '',
          interval: f1DriverInterval(c.statistics)
        }));
      const lap = Number(session.status?.period);
      updates.set(`f1-${event.id}-${abbreviation.toLowerCase()}`, {
        isLive: statusType.state === 'in',
        isFinished: statusType.state === 'post',
        lap: Number.isFinite(lap) && lap > 0 ? lap : null,
        statusDetail: statusType.shortDetail || statusType.detail || '',
        leaderboard: leaderboard.length ? leaderboard : null
      });
    }
  }
  return updates;
}

// ESPN keeps a dark-theme twin of every team crest under `500-dark/`
// (white Yankees NY, white Tigers D, ...) - the navy/black originals vanish
// into a dark card. Only team logos have one; anything else is returned
// untouched. Some teams have no twin (404) - callers fall back to the
// original (see app.js's updateTeamRow).
export function darkEspnLogoUrl(url) {
  if (!url) return url;
  return url.replace(/(a\.espncdn\.com(?:\/combiner\/i\?img=)?\/i\/teamlogos\/[^/?&]+\/500)\//, '$1-dark/');
}

// ESPN serves every team/league logo as a 500px PNG (20-45KB each, live-
// measured) while this page only ever draws them at 16-22px - so a first
// visit spent most of its image bandwidth on pixels nobody sees, and the
// crests visibly popped in seconds after the cards themselves. ESPN's own
// `combiner` resizer (the same CDN host) returns the same image at any size
// (a 64px copy is 2-5KB), so every logo is requested through it instead.
// 64px covers a 21px slot on a 3x display. A URL that isn't on
// a.espncdn.com is returned untouched.
export function sizedEspnLogoUrl(url, px = 64) {
  if (!url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.hostname !== 'a.espncdn.com') return url;
  if (parsed.pathname === '/combiner/i') {
    if (!parsed.searchParams.get('img')) return url;
    // Already sized (e.g. a deliberate crop - see app.js's LEAGUE_LOGOS):
    // leave its own dimensions alone.
    if (parsed.searchParams.get('w') && parsed.searchParams.get('h')) return url;
  } else {
    const img = parsed.pathname;
    parsed = new URL('https://a.espncdn.com/combiner/i');
    parsed.searchParams.set('img', img);
  }
  parsed.searchParams.set('w', String(px));
  parsed.searchParams.set('h', String(px));
  // `img` stays a readable path (the combiner accepts it unescaped, and
  // that's the form ESPN's own site uses).
  return parsed.toString().replace(/img=([^&]*)/, (_, v) => `img=${decodeURIComponent(v)}`);
}
