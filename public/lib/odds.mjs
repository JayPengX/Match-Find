// ---- public/lib/odds.mjs ----
// Pure, deterministic conversion from a sportsbook's American moneyline
// odds (ESPN's own `competition.odds[0].moneyline` shape) to a devigged
// win-probability percentage - shared by scripts/build-data.mjs (the
// pregame build-time line) and public/lib/espn.mjs (the live-poll
// refresh), so the exact same math backs both a card's initial % and
// every later live update to it. No network, no Date.now(), no
// sport-specific branching - this only does arithmetic on whatever
// moneyline object it's handed.

// American-odds-to-implied-probability: a favorite's odds are negative
// (risk `-odds` to win 100), an underdog's are positive (risk 100 to win
// `odds`) - the two formulas below are the standard, textbook conversion,
// not something invented for this codebase. Returns null (never 0 or a
// guessed 50%) for a non-finite/zero input, which American odds can never
// legitimately be.
export function americanOddsToImpliedProbability(odds) {
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

// A real two-sided moneyline always overrounds - both sides' raw implied
// probabilities sum to MORE than 100% (the sportsbook's own vig/juice, its
// margin on the bet) - dividing each side by the total strips that margin
// back out proportionally, so what's left is "how likely is this team to
// actually win" rather than "how much of your stake the book wants for
// this side", which is the only version of this number worth showing a
// viewer. Returns null unless BOTH sides parsed to a real number - a
// one-sided implied probability with no opposing line to devig against
// isn't a real percentage, just a raw, still-vig-inflated one.
export function devigTwoWayOdds(awayOdds, homeOdds) {
  const awayRaw = americanOddsToImpliedProbability(awayOdds);
  const homeRaw = americanOddsToImpliedProbability(homeOdds);
  if (!Number.isFinite(awayRaw) || !Number.isFinite(homeRaw)) return null;
  const total = awayRaw + homeRaw;
  if (total <= 0) return null;
  return {
    away: Math.round((awayRaw / total) * 1000) / 10,
    home: Math.round((homeRaw / total) * 1000) / 10
  };
}

// Reads ESPN's own `competition.odds[0].moneyline.{away,home}.close/open.odds`
// shape (a string like "-104"/"+102") - prefers the CLOSING line (the
// market's most current number) and falls back to the opening line only
// when no close has posted yet. Returns null (never a guessed 50/50) when
// ESPN hasn't posted a moneyline for this fixture at all - the normal case
// for soccer/F1, and for a US game far enough out that no book has posted
// a line yet (see scripts/build-data.mjs's own oddsContext/parseOddsSignal
// comment on the same "missing is normal, never guessed" posture for
// spread/overUnder).
export function parseMoneylineWinPct(moneyline) {
  const awayOdds = Number(moneyline?.away?.close?.odds ?? moneyline?.away?.open?.odds);
  const homeOdds = Number(moneyline?.home?.close?.odds ?? moneyline?.home?.open?.odds);
  return devigTwoWayOdds(awayOdds, homeOdds);
}
