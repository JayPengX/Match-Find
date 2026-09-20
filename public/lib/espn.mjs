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
// This module no longer reads win% odds at all - see ./polymarket.mjs for
// that (ESPN's own sportsbook feed doesn't cover every sport this app
// tracks, F1 in particular). Score/status and the spread/over-under
// signal the scoring engine (not this odds display) uses still come from
// here, unaffected.

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

// The one ESPN scoreboard request needed to catch every currently-live
// fixture of one league - `dates` covers both today and yesterday (UTC) by
// the same reasoning as build-data.mjs's own lookback (a live fixture can
// still be grouped under ESPN's own PREVIOUS calendar day depending on the
// league's home timezone), which is all a LIVE-only poll ever needs (a
// fixture that's actually live right now cannot be further than one ESPN
// calendar day off from "now").
export function liveScoreboardUrl(sport, now = new Date()) {
  const league = TEAM_LEAGUE_ESPN[sport];
  if (!league) return null;
  const dates = `${yyyymmddUtc(new Date(now.getTime() - 86_400_000))}-${yyyymmddUtc(now)}`;
  return espnScoreboardUrl(league.sportKey, league.leagueKey, dates);
}

// Extracts {id -> {isLive, isFinished, scores: [awayScore, homeScore],
// oddsSpread, oddsOverUnder}} from one league's scoreboard response - `id` matches Match Find's own fixture id
// convention exactly
// (`${league.id}-${event.id}`) so app.js can merge this straight into
// state.allRawMatches by id with no extra lookup table. Scores are read as
// plain numbers (or null when ESPN hasn't posted one yet, e.g. a scoreless
// 'pre' fixture) - never guessed or defaulted to 0, since a real 0-0 score
// is a genuine, different fact from "not started/not reported".
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
    updates.set(`${league.id}-${event.id}`, {
      isLive: statusType.state === 'in',
      isFinished: statusType.state === 'post',
      scores: [toScore(away), toScore(home)],
      period: competition.status?.period ?? null,
      displayClock: typeof competition.status?.displayClock === 'string' ? competition.status.displayClock : '',
      shortDetail: statusType.shortDetail || '',
      oddsSpread: Number.isFinite(spread) ? spread : null,
      oddsOverUnder: Number.isFinite(overUnder) ? overUnder : null
    });
  }
  return updates;
}
