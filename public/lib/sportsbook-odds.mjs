// ---- public/lib/sportsbook-odds.mjs ----
//
// ESPN's own sportsbook moneyline (`competition.odds[0]`, DraftKings in
// practice) turned into the same devigged win% shape the on-card odds bar
// already reads from Polymarket - the bar's FALLBACK source, never its
// primary one. Polymarket stays first (see ./polymarket.mjs's top comment):
// its price moves with every trade and app.js's live poll picks that up
// within ~30s, while a sportsbook line is repriced by the book, carries
// its margin, and disappears from ESPN's scoreboard the moment a game goes
// in-progress. This only fills the gap when Polymarket has nothing usable
// for a fixture that hasn't started - no market found, or one that hasn't
// traded enough to trust (see resolveDisplayOdds below).
//
// Live-checked 2026-09-25: ESPN posts the MLB moneyline on game day only
// (the next day's scoreboard carries `odds: null`), in the shape
// `moneyline: {away: {close: {odds: "-122"}, open: {...}}, home: {...}}`,
// plus soccer's `draw` side. The older flat `awayTeamOdds.moneyLine` /
// `drawOdds.moneyLine` numbers are read too, as a fallback.
//
// No fetch here - the scoreboard responses this reads are the ones
// match-builder.mjs and espn.mjs's extractLiveUpdates already fetch, so
// this costs no extra request.

import { devigNWay, POLYMARKET_MIN_LIQUIDITY_FOR_SCORING } from './polymarket.mjs';

// American odds ("-122", "+101", 150, "EVEN") -> the book's raw implied
// probability (0..1, vig included). null for anything unparseable.
export function americanOddsToProbability(value) {
  if (value == null) return null;
  const text = String(value).trim().toUpperCase();
  if (text === 'EVEN' || text === 'EV') return 0.5;
  const n = Number(text);
  if (!Number.isFinite(n) || Math.abs(n) < 100) return null;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
}

function sideProbability(odds, side, flatField) {
  const line = odds.moneyline?.[side];
  return (
    americanOddsToProbability(line?.close?.odds) ??
    americanOddsToProbability(line?.open?.odds) ??
    americanOddsToProbability(flatField?.moneyLine)
  );
}

// {away, home, draw, provider} as devigged percentages (same 0..100,
// one-decimal convention as ./polymarket.mjs's resolveTeamOdds), or null
// when no moneyline is posted. `draw` is null unless `hasDraw` (soccer) -
// and a soccer line without a real draw price is rejected outright rather
// than shown as a misleading two-way split.
export function parseSportsbookWinPct(competition, { hasDraw = false } = {}) {
  const odds = competition?.odds?.[0];
  if (!odds) return null;
  const away = sideProbability(odds, 'away', odds.awayTeamOdds);
  const home = sideProbability(odds, 'home', odds.homeTeamOdds);
  if (away == null || home == null) return null;
  const provider = odds.provider?.displayName || odds.provider?.name || '';
  if (hasDraw) {
    const draw = sideProbability(odds, 'draw', odds.drawOdds);
    if (draw == null) return null;
    const devigged = devigNWay([away, draw, home]);
    return devigged ? { away: devigged[0], draw: devigged[1], home: devigged[2], provider } : null;
  }
  const devigged = devigNWay([away, home]);
  return devigged ? { away: devigged[0], home: devigged[1], draw: null, provider } : null;
}

// What the odds bar shows: {away, home, draw, source, provider} or null.
// Polymarket whenever its market is liquid (or its liquidity is unknown,
// e.g. an older cached match), and always once the game has started - the
// sportsbook line is pre-game only. The sportsbook line only takes over,
// before kickoff, when Polymarket has no price at all or a thin one.
export function resolveDisplayOdds(match, now = Date.now()) {
  if (!match) return null;
  const market =
    Number.isFinite(match.oddsWinPctAway) && Number.isFinite(match.oddsWinPctHome)
      ? {
          away: match.oddsWinPctAway,
          home: match.oddsWinPctHome,
          draw: Number.isFinite(match.oddsWinPctDraw) ? match.oddsWinPctDraw : null,
          source: 'polymarket',
          provider: 'Polymarket'
        }
      : null;
  const book =
    Number.isFinite(match.oddsBookWinPctAway) && Number.isFinite(match.oddsBookWinPctHome)
      ? {
          away: match.oddsBookWinPctAway,
          home: match.oddsBookWinPctHome,
          draw: Number.isFinite(match.oddsBookWinPctDraw) ? match.oddsBookWinPctDraw : null,
          source: 'sportsbook',
          provider: match.oddsBookProvider || ''
        }
      : null;
  const started = Date.parse(match.startTimeUtc) <= now;
  if (!book || started) return market;
  if (!market) return book;
  const thin = Number.isFinite(match.oddsMarketLiquidity) && match.oddsMarketLiquidity < POLYMARKET_MIN_LIQUIDITY_FOR_SCORING;
  return thin ? book : market;
}
