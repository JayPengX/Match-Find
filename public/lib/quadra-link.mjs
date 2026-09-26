// Quadra Fixtures (Match Find) and Quadra Sportsbook (Odds Study).
//
// Match Find builds its own schedule for its four sports (ESPN, MLB, F1)
// with its own scoring. Sportsbook covers many more: every one of its
// leagues is on offer here too, as fixtures to follow (Settings), with
// Sportsbook's own estimated lottery odds on every card and a one-tap link
// to bet on it there (/Odds-Study/#game=<id>).
//
// Sportsbook's board isn't copied: the two apps are one site, so this loads
// Sportsbook's own published modules (its sources and board pricing) and
// builds the same board it shows. On a Quadra Pass, matches pinned in
// Sportsbook come from the pass's wallet and join the viewing plan.

// The extra leagues: Sportsbook's key -> this app's sport name, labels,
// the sport's family (for durations) and the length of a game (minutes).
export const EXTRA_SPORTS = {
  nfl: { sport: 'NFL', zh: 'NFL 美式足球', en: 'NFL', family: 'football', minutes: 195 },
  ncaaf: { sport: 'NCAA Football', zh: '美國大學美足', en: 'College football', family: 'football', minutes: 210 },
  wnba: { sport: 'WNBA', zh: 'WNBA', en: 'WNBA', family: 'basketball', minutes: 125 },
  nhl: { sport: 'NHL', zh: 'NHL 冰球', en: 'NHL', family: 'hockey', minutes: 160 },
  laliga: { sport: 'La Liga', zh: '西甲', en: 'La Liga', family: 'soccer', minutes: 115 },
  seriea: { sport: 'Serie A', zh: '義甲', en: 'Serie A', family: 'soccer', minutes: 115 },
  bundesliga: { sport: 'Bundesliga', zh: '德甲', en: 'Bundesliga', family: 'soccer', minutes: 115 },
  ligue1: { sport: 'Ligue 1', zh: '法甲', en: 'Ligue 1', family: 'soccer', minutes: 115 },
  ucl: { sport: 'Champions League', zh: '歐冠', en: 'Champions League', family: 'soccer', minutes: 115 },
  uel: { sport: 'Europa League', zh: '歐霸', en: 'Europa League', family: 'soccer', minutes: 115 },
  eredivisie: { sport: 'Eredivisie', zh: '荷甲', en: 'Eredivisie', family: 'soccer', minutes: 115 },
  primeira: { sport: 'Primeira Liga', zh: '葡超', en: 'Primeira Liga', family: 'soccer', minutes: 115 },
  championship: { sport: 'Championship', zh: '英冠', en: 'Championship', family: 'soccer', minutes: 115 },
  mls: { sport: 'MLS', zh: '美職足', en: 'MLS', family: 'soccer', minutes: 115 },
  ligamx: { sport: 'Liga MX', zh: '墨西哥聯賽', en: 'Liga MX', family: 'soccer', minutes: 115 },
  jleague: { sport: 'J1 League', zh: '日職聯', en: 'J1 League', family: 'soccer', minutes: 115 },
  npb: { sport: 'NPB', zh: '日職棒', en: 'NPB', family: 'baseball', minutes: 195 },
  kbo: { sport: 'KBO', zh: '韓職棒', en: 'KBO', family: 'baseball', minutes: 195 },
  cpbl: { sport: 'CPBL', zh: '中職', en: 'CPBL', family: 'baseball', minutes: 195 },
  euroleague: { sport: 'EuroLeague', zh: '歐洲籃球聯賽', en: 'EuroLeague', family: 'basketball', minutes: 120 },
  bleague: { sport: 'B.League', zh: '日本 B 聯賽', en: 'B.League', family: 'basketball', minutes: 120 },
  tennis: { sport: 'Tennis ATP', zh: '網球 ATP', en: 'Tennis ATP', family: 'sets', minutes: 120 },
  wta: { sport: 'Tennis WTA', zh: '網球 WTA', en: 'Tennis WTA', family: 'sets', minutes: 110 },
  badminton: { sport: 'Badminton', zh: '羽球', en: 'Badminton', family: 'sets', minutes: 60 },
  tabletennis: { sport: 'Table tennis', zh: '桌球', en: 'Table tennis', family: 'sets', minutes: 50 },
  volleyball: { sport: 'Volleyball', zh: '排球', en: 'Volleyball', family: 'sets', minutes: 110 },
  snooker: { sport: 'Snooker', zh: '司諾克', en: 'Snooker', family: 'sets', minutes: 150 }
};
// This app's own four, and Sportsbook's key for each.
export const NATIVE_KEYS = { 'Premier League': 'epl', MLB: 'mlb', NBA: 'nba', F1: 'f1' };
export const EXTRA_SPORT_NAMES = Object.values(EXTRA_SPORTS).map(x => x.sport);
const BY_SPORT = Object.fromEntries(Object.entries(EXTRA_SPORTS).map(([key, x]) => [x.sport, { key, ...x }]));
export const extraInfo = sport => BY_SPORT[sport] || null;

// Where Sportsbook lives on this site (its published modules sit under
// lib/; a local checkout serves them under public/lib/).
const ODDS_ROOTS = ['/Odds-Study/lib/', '/Odds-Study/public/lib/'];
export const ODDS_PAGE = '/Odds-Study/';
export const betUrl = gameId => `${ODDS_PAGE}#game=${encodeURIComponent(gameId)}`;

let modules = null;
async function oddsModules() {
  if (modules) return modules;
  let lastError;
  for (const root of ODDS_ROOTS) {
    try {
      const [sources, board, teams] = await Promise.all([import(`${root}sources.mjs`), import(`${root}board.mjs`), import(`${root}teams.mjs`)]);
      modules = { sources, board, teams };
      return modules;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// Sportsbook's board: every game it prices, with its estimated lottery
// odds on each side (moneyline), and where to find each league's logo.
export async function loadOddsBoard({ extras = true } = {}) {
  const { sources, board, teams } = await oddsModules();
  const now = new Date();
  const [main, extra] = await Promise.all([sources.loadOdds(now).catch(() => ({ games: [] })), extras ? sources.loadExtraLeagues(now).catch(() => []) : []]);
  const games = [];
  const seen = new Set();
  for (const game of [...(main?.games || []), ...(extra || [])]) {
    if (seen.has(game.id)) continue;
    seen.add(game.id);
    let options = [];
    try {
      options = board.gameOptions(game).filter(o => o.kind === 'ml');
    } catch {}
    if (!options.length) continue;
    const odds = Object.fromEntries(options.map(o => [o.side, o.estOdds]));
    const chance = Object.fromEntries(options.map(o => [o.side, o.fairChance]));
    games.push({
      id: game.id,
      key: game.sport,
      startUtc: game.startUtc,
      away: { en: game.away.en, zh: game.away.zh, logo: teams.teamLogo(game.sport, game.away.en) },
      home: { en: game.home.en, zh: game.home.zh, logo: teams.teamLogo(game.sport, game.home.en) },
      odds,
      chance,
      neutral: Boolean(teams.LEAGUES[game.sport]?.neutral)
    });
  }
  const logos = Object.fromEntries(Object.keys(EXTRA_SPORTS).map(key => [EXTRA_SPORTS[key].sport, teams.leagueLogo(key)]));
  return { games, logos, normalize: teams.normalizeTeamName, at: Date.now() };
}

// The board's game for one of this app's own matches: same league, the
// same two teams, starting within three hours of each other.
export function oddsGameFor(match, boardData) {
  const key = NATIVE_KEYS[match.sport] || extraInfo(match.sport)?.key;
  if (!boardData || !key || match.sport === 'F1') return null;
  if (match.quadraGameId) return boardData.games.find(g => g.id === match.quadraGameId) || null;
  const norm = boardData.normalize;
  const away = match.competitors?.find(c => c.homeAway === 'away');
  const home = match.competitors?.find(c => c.homeAway === 'home');
  if (!away || !home) return null;
  const start = Date.parse(match.startTimeUtc);
  const same = (a, b) => {
    const x = norm(a);
    const y = norm(b);
    return x === y || x.endsWith(y) || y.endsWith(x) || x.includes(y) || y.includes(x);
  };
  return (
    boardData.games.find(g => g.key === key && Math.abs(Date.parse(g.startUtc) - start) <= 3 * 3_600_000 && same(g.away.en, away.name) && same(g.home.en, home.name)) || null
  );
}

// A 1-10 read of how close a game is from its odds: an even game 10, a
// one-sided one near 1. (The extra leagues have no other data here.)
export function closenessFromOdds(chance) {
  const sides = Object.values(chance || {}).filter(p => p > 0);
  if (sides.length < 2) return 5;
  const top = Math.max(...sides);
  const even = 1 / sides.length;
  return Math.max(1, Math.min(10, Math.round(10 - ((top - even) / (1 - even)) * 9)));
}

// One of Sportsbook's games in an extra league as one of this app's
// matches: enough for the cards, the day list and the viewing plan.
export function matchFromOddsGame(g, { isPinned = false } = {}) {
  const info = EXTRA_SPORTS[g.key];
  if (!info) return null;
  const closeness = closenessFromOdds(g.chance);
  const start = Date.parse(g.startUtc);
  const finished = Date.now() > start + info.minutes * 60_000 + 30 * 60_000;
  const team = (side, t) => ({ name: t.en, nameZh: t.zh || t.en, abbreviation: '', logo: t.logo || '', homeAway: side, color: '', altColor: '', record: null, score: null });
  return {
    id: `quadra-${g.id}`,
    quadraGameId: g.id,
    quadraExtra: true,
    sport: info.sport,
    name: `${g.away.en} @ ${g.home.en}`,
    nameZh: `${g.away.zh || g.away.en} @ ${g.home.zh || g.home.en}`,
    startTimeUtc: new Date(start).toISOString(),
    timeTbd: false,
    scheduleKey: `quadra:${g.key}`,
    isFinished: finished,
    isPostseason: false,
    playoff: null,
    oddsSpread: null,
    oddsOverUnder: null,
    oddsWinPctAway: g.chance.away ?? null,
    oddsWinPctHome: g.chance.home ?? null,
    oddsWinPctDraw: g.chance.draw ?? null,
    oddsFavorites: null,
    durationMinutes: info.minutes,
    plannedDurationMinutes: info.minutes,
    venue: '',
    broadcast: '',
    logo: '',
    competitors: [team('away', g.away), team('home', g.home)],
    competitiveness: closeness,
    watchability: isPinned ? 8 : 4,
    stakes: null,
    enduranceScore: 5,
    broadcastQuality: 3,
    skill: null,
    isNationalBroadcast: false,
    reason: '',
    whereToWatchTw: null,
    objectiveFactors: [`odds closeness ${closeness}/10 (Quadra Sportsbook)`],
    score: Math.round(((closeness + (isPinned ? 8 : 4)) / 2) * 10) / 10,
    confidence: 0.3
  };
}

// A pin from Sportsbook (in the pass's wallet) as a match, when the board
// doesn't have that game (any more).
export function matchFromPin(id, pin) {
  const key = pin.sport;
  const info = EXTRA_SPORTS[key];
  if (!info) return null;
  return matchFromOddsGame(
    { id, key, startUtc: pin.start, away: { en: pin.away, zh: pin.awayZh }, home: { en: pin.home, zh: pin.homeZh }, odds: {}, chance: {} },
    { isPinned: true }
  );
}

// Reads the Quadra Pass's wallet (for its pins).
export async function readWalletPins(ecoUrl, passcode) {
  const res = await fetch(`${ecoUrl}?passcode=${encodeURIComponent(passcode)}&app=match`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.exists ? data.wallet?.pins || {} : null;
}
