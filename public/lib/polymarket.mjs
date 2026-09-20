// ---- public/lib/polymarket.mjs ----
// Pure parsing/URL-building for Polymarket's own public Gamma API
// (gamma-api.polymarket.com) - this app's ONLY source for the on-card win%
// odds display. Replaces an earlier ESPN-sportsbook-odds version of this
// feature entirely: a real prediction market's own trade price already IS
// a probability (0..1), so there's no American-odds-to-probability
// conversion step at all, and - critically - Polymarket runs a genuine
// market on EVERY sport this app tracks, including F1 (an outright
// race-winner market across every driver), which ESPN's own odds feed
// never carried at all (confirmed live in an earlier version of this
// feature: zero `odds` field anywhere on any F1 session).
//
// No fetch here - see scripts/build-data.mjs (Node/build-time) and
// public/app.js (browser live-poll, via the shared proxy's /sports-proxy
// passthrough - gamma-api.polymarket.com sends no CORS headers, confirmed
// live) for the actual network calls, so the exact same matching/parsing
// logic backs both a card's initial build-time number and every later
// live update to it.

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

// Polymarket's own tag ids per league - NOT guessable from the league name,
// just whatever id Polymarket happened to create each tag under (confirmed
// live via gamma-api.polymarket.com/tags/slug/<slug>).
export const POLYMARKET_TAG_ID = {
  MLB: 100381,
  NBA: 745,
  'Premier League': 306,
  F1: 100389
};

// One request per sport gets every open event for that league AND each
// event's own full `markets` array already nested inside it (confirmed
// live - no separate per-game request needed, same "one batch request,
// not one per fixture" shape as ESPN's own scoreboard endpoint). `limit`
// is generous: even MLB's own ~15-game daily slate plus its many season-
// long futures markets stays well under 100.
export function polymarketEventsByTagUrl(tagId, { limit = 150 } = {}) {
  return `${GAMMA_BASE}/events?tag_id=${tagId}&closed=false&limit=${limit}&order=startDate&ascending=true`;
}

// Strips the generic, non-identifying club-suffix tokens that make an
// otherwise-identical team name fail a plain string match between this
// app's own ESPN-sourced names (e.g. "Liverpool", "AFC Bournemouth") and
// Polymarket's own (e.g. "Liverpool FC", "AFC Bournemouth" - confirmed
// live both ways) - never anything that changes WHICH team this is (a
// real city/nickname token), only genuinely interchangeable club-suffix
// boilerplate.
export function normalizeTeamName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(fc|afc|cf|sc)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function teamNamesMatch(a, b) {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  return !!na && !!nb && na === nb;
}

// Gamma's own JSON fields come back as JSON-ENCODED STRINGS
// (`outcomes: '["Yes","No"]'`, confirmed live), not real arrays - this
// reads either shape without throwing on a malformed one.
function parseJsonArrayField(field) {
  if (Array.isArray(field)) return field;
  if (typeof field !== 'string') return null;
  try {
    const parsed = JSON.parse(field);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Normalizes N raw market-implied probabilities (each already 0..1 - a
// prediction market's own trade price, not American odds) so they sum to
// (near) exactly 100. A liquid Polymarket binary market's own two sides
// already sum very close to 1 on their own - confirmed live, a real
// SF Giants @ LA Dodgers moneyline priced at exactly 0.015/0.985 - nothing
// like a sportsbook's real vig - but this still corrects whatever small
// residual spread exists rather than assuming it's already exact. Returns
// null unless every probability is a real, finite, non-negative number and
// they don't all sum to zero.
export function devigNWay(rawProbabilities) {
  if (!Array.isArray(rawProbabilities) || rawProbabilities.length === 0) return null;
  if (rawProbabilities.some(p => !Number.isFinite(p) || p < 0)) return null;
  const total = rawProbabilities.reduce((sum, p) => sum + p, 0);
  if (total <= 0) return null;
  return rawProbabilities.map(p => Math.round((p / total) * 1000) / 10);
}

// Finds the one event (out of a whole league's worth) that's really this
// fixture - matched by BOTH team names (via Polymarket's own structured
// `event.teams[]`, confirmed live to carry {name, ordering: 'away'|'home'}
// for every MLB/NBA/EPL game event) AND kickoff time (`event.startTime` -
// the real scheduled time, confirmed live to differ from `event.startDate`,
// which is when Polymarket itself CREATED the listing) within
// `toleranceMs` of this app's own startTimeUtc - team names alone aren't
// enough on a doubleheader day, where the same two teams can have two
// separate events hours apart.
export function findTeamEvent(events, awayName, homeName, startTimeUtc, { toleranceMs = 6 * 60 * 60 * 1000 } = {}) {
  const targetMs = Date.parse(startTimeUtc);
  if (!Number.isFinite(targetMs)) return null;
  for (const event of events || []) {
    const teams = event.teams;
    if (!Array.isArray(teams) || teams.length !== 2) continue;
    const eventMs = Date.parse(event.startTime || event.startDate);
    if (!Number.isFinite(eventMs) || Math.abs(eventMs - targetMs) > toleranceMs) continue;
    const awayMatch = teams.some(t => teamNamesMatch(t.name, awayName));
    const homeMatch = teams.some(t => teamNamesMatch(t.name, homeName));
    if (awayMatch && homeMatch) return event;
  }
  return null;
}

// The MLB/NBA shape: ONE market per game whose own two outcomes ARE the
// two teams (e.g. outcomes: ["San Francisco Giants","Los Angeles
// Dodgers"], outcomePrices: ["0.015","0.985"], confirmed live) - found by
// scanning for a market with exactly two outcomes that are real team
// names, not a "Yes"/"No" prop (a real game event carries many of those
// too, for spread/total/prop markets alongside the moneyline - confirmed
// live, ~30 markets on one real fixture). Matches which price is "away"
// vs "home" by name rather than assuming outcome order.
export function parseCombinedMoneylineMarket(markets, awayName, homeName) {
  for (const market of markets || []) {
    const outcomes = parseJsonArrayField(market.outcomes);
    const prices = parseJsonArrayField(market.outcomePrices);
    if (!outcomes || !prices || outcomes.length !== 2 || prices.length !== 2) continue;
    if (outcomes.some(o => /^(yes|no)$/i.test(o))) continue;
    const awayIdx = outcomes.findIndex(o => teamNamesMatch(o, awayName));
    const homeIdx = outcomes.findIndex(o => teamNamesMatch(o, homeName));
    if (awayIdx === -1 || homeIdx === -1 || awayIdx === homeIdx) continue;
    const devigged = devigNWay([Number(prices[awayIdx]), Number(prices[homeIdx])]);
    if (!devigged) continue;
    return { away: devigged[0], home: devigged[1] };
  }
  return null;
}

// The EPL shape: no single combined market at all - three SEPARATE binary
// Yes/No markets in the same event ("Will {home} win on {date}?", "Will
// {home} vs. {away} end in a draw?", "Will {away} win on {date}?"),
// confirmed live against a real fixture (AFC Bournemouth vs. Liverpool
// FC). Matched by question text + team name rather than position, since
// nothing guarantees these three sit adjacent to each other or in a fixed
// order among that event's other (corners/cards/etc) markets.
export function parseSoccerThreeWayMarkets(markets, awayName, homeName) {
  let awayProb = null;
  let homeProb = null;
  let drawProb = null;
  for (const market of markets || []) {
    const outcomes = parseJsonArrayField(market.outcomes);
    const prices = parseJsonArrayField(market.outcomePrices);
    if (!outcomes || !prices || outcomes.length !== 2) continue;
    const yesIdx = outcomes.findIndex(o => /^yes$/i.test(o));
    if (yesIdx === -1) continue;
    const yesPrice = Number(prices[yesIdx]);
    if (!Number.isFinite(yesPrice)) continue;
    const question = market.question || '';
    if (/end in a draw/i.test(question)) {
      drawProb = yesPrice;
      continue;
    }
    const willWinMatch = /^will (.+?) win\b/i.exec(question);
    if (!willWinMatch) continue;
    if (teamNamesMatch(willWinMatch[1], awayName)) awayProb = yesPrice;
    else if (teamNamesMatch(willWinMatch[1], homeName)) homeProb = yesPrice;
  }
  const devigged = devigNWay([awayProb, drawProb, homeProb]);
  if (!devigged) return null;
  return { away: devigged[0], draw: devigged[1], home: devigged[2] };
}

// One shared entry point for every team-vs-team sport this app tracks -
// finds the right event, then parses it the right way for that league
// (soccer's real three-outcome market vs. MLB/NBA's two). `draw` is always
// present on the result (null for a two-way sport), matching this app's
// own oddsWinPctDraw field convention. Returns null (never a guessed/
// partial number) when no matching event or market was found - the normal
// case for a fixture far enough out that no market has opened yet, or a
// league Polymarket doesn't cover this season.
export function resolveTeamOdds(events, { awayName, homeName, startTimeUtc, hasDraw }) {
  const event = findTeamEvent(events, awayName, homeName, startTimeUtc);
  if (!event) return null;
  if (hasDraw) return parseSoccerThreeWayMarkets(event.markets, awayName, homeName);
  const result = parseCombinedMoneylineMarket(event.markets, awayName, homeName);
  return result ? { ...result, draw: null } : null;
}

// The F1/"outright winner" shape: many separate binary Yes/No markets, one
// per candidate, sharing a common question template (e.g. "Will {driver}
// win the 2026 F1 Azerbaijan Grand Prix?", confirmed live across ~29
// drivers on one real race event). `questionRegex` must have exactly one
// capture group (the candidate's own name); any 'g'/'y' flags are stripped
// internally so reusing the same regex object across many markets in a
// loop can't leave it stuck mid-string via a stale `lastIndex`. Extracts
// EVERY named candidate found, devigs them all together (N-way, the same
// math as the two/three-way team-sport case generalized), and returns them
// sorted favorite-first - callers show only the top few.
export function parseOutrightWinnerMarkets(markets, questionRegex) {
  const regex = new RegExp(questionRegex.source, questionRegex.flags.replace(/[gy]/g, ''));
  const candidates = [];
  for (const market of markets || []) {
    const outcomes = parseJsonArrayField(market.outcomes);
    const prices = parseJsonArrayField(market.outcomePrices);
    if (!outcomes || !prices || outcomes.length !== 2) continue;
    const yesIdx = outcomes.findIndex(o => /^yes$/i.test(o));
    if (yesIdx === -1) continue;
    const match = regex.exec(market.question || '');
    if (!match) continue;
    const prob = Number(prices[yesIdx]);
    if (!Number.isFinite(prob)) continue;
    candidates.push({ name: match[1].trim(), prob });
  }
  if (!candidates.length) return null;
  const devigged = devigNWay(candidates.map(c => c.prob));
  if (!devigged) return null;
  return candidates.map((c, i) => ({ name: c.name, pct: devigged[i] })).sort((a, b) => b.pct - a.pct);
}

// Finds the specific "who wins the race" event for one Grand Prix out of
// the whole F1 tag's events (which also mixes in pole-position/fastest-lap/
// safety-car/practice/constructor markets for every race on the calendar,
// confirmed live) - by its own slug convention (ends in
// `-winner-YYYY-MM-DD`, confirmed live) AND its own `eventDate` matching
// the race's real UTC calendar date (confirmed live: a real Azerbaijan GP
// Race session's own ESPN start time, 2026-09-26T11:00Z, lands on the
// exact same UTC date as Polymarket's own winner-market slug/eventDate for
// that race).
export function findRaceWinnerEvent(events, raceDateUtc) {
  return (events || []).find(event => event.slug?.endsWith(`-winner-${raceDateUtc}`) && event.eventDate === raceDateUtc) || null;
}

export function resolveF1WinnerOdds(events, raceDateUtc) {
  const event = findRaceWinnerEvent(events, raceDateUtc);
  if (!event) return null;
  return parseOutrightWinnerMarkets(event.markets, /^Will (.+?) win the \d{4} F1 .+ Grand Prix\?$/i);
}
