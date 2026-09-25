// ---- public/lib/playoff.mjs ----
// Pure helpers for a postseason fixture's own series context - which round
// it is, the series score, and what's at stake tonight. parsePlayoffInfo
// reads it off ESPN's scoreboard for both match-builder.mjs's full builds
// and espn.mjs's live polling; the rest is used by the card (public/
// app.js's renderPlayoffLine), which turns it into text. No DOM, no t().

// A postseason fixture's own round and series score, straight from ESPN's
// scoreboard (confirmed live against the 2025 MLB and NBA postseasons):
// competition.notes[0].headline is the round ("ALDS - Game 4"), and
// competition.series carries totalCompetitions (the best-of length) plus
// each team's series wins keyed by ESPN team id - which is the SAME id as
// that team's entry in competition.competitors, so wins are matched to
// away/home by id rather than by array order. A play-in game has a round
// but no series. ESPN's win counts already include a finished game's own
// result - see playoffSeriesState below for how that's handled.
export function parsePlayoffInfo(competition) {
  const round = competition?.notes?.find(note => note?.headline)?.headline || null;
  const series = competition?.series;
  const winsFor = homeAway => {
    const id = (competition?.competitors || []).find(c => c.homeAway === homeAway)?.id;
    const wins = (series?.competitors || []).find(c => id != null && String(c.id) === String(id))?.wins;
    return Number.isInteger(wins) ? wins : null;
  };
  const bestOf = Number.isInteger(series?.totalCompetitions) ? series.totalCompetitions : null;
  const hasSeries = series?.type === 'playoff' && bestOf != null;
  if (!round && !hasSeries) return null;
  return {
    round,
    bestOf: hasSeries ? bestOf : null,
    awayWins: hasSeries ? winsFor('away') : null,
    homeWins: hasSeries ? winsFor('home') : null
  };
}

// ESPN's own round headlines, confirmed live against the 2025 MLB and NBA
// postseasons: "ALWC - Game 1", "NLDS - Game 3", "ALCS - Game 2",
// "World Series - Game 1", "East 1st Round - Game 6", "West Semifinals -
// Game 1", "East Finals - Game 1", "NBA Finals - Game 1", "NBA Play-In -
// East - 9th Place vs 10th Place", "NBA Play-In - West - 8th Seed Game",
// and before a series is decided, "ALWC - Game 3 If Necessary".
const ROUND_NAMES_ZH = [
  [/^AL\s?WC$/, '美聯外卡系列賽'],
  [/^NL\s?WC$/, '國聯外卡系列賽'],
  [/^ALDS$/, '美聯分區系列賽'],
  [/^NLDS$/, '國聯分區系列賽'],
  [/^ALCS$/, '美聯冠軍賽'],
  [/^NLCS$/, '國聯冠軍賽'],
  [/^World Series$/, '世界大賽'],
  [/^East 1st Round$/, '東區首輪'],
  [/^West 1st Round$/, '西區首輪'],
  [/^East Semifinals$/, '東區準決賽'],
  [/^West Semifinals$/, '西區準決賽'],
  [/^East Finals$/, '東區決賽'],
  [/^West Finals$/, '西區決賽'],
  [/^NBA Finals$/, 'NBA 總冠軍賽']
];

export function isPlayInRound(round) {
  return /^NBA Play-In\b/i.test(round || '');
}

function localizePlayInZh(round) {
  const [, conference = '', detail = ''] = round.split(/\s+-\s+/);
  const conferenceZh = conference === 'East' ? '東區' : conference === 'West' ? '西區' : '';
  const places = detail.match(/^(\d+)(?:st|nd|rd|th) Place vs (\d+)(?:st|nd|rd|th) Place$/);
  const seed = detail.match(/^(\d+)(?:st|nd|rd|th) Seed Game$/);
  const detailZh = places ? `第${places[1]}、${places[2]}名之戰` : seed ? `第${seed[1]}種子爭奪戰` : '';
  return [`${conferenceZh}附加賽`, detailZh].filter(Boolean).join(' ');
}

// The round headline in the viewer's language - zh-TW translates every
// known ESPN round name (anything unrecognized falls back to ESPN's own
// English text rather than guessing); en keeps ESPN's text as-is.
export function localizePlayoffRound(round, locale) {
  if (!round) return '';
  if (locale !== 'zh-TW') return round;
  if (isPlayInRound(round)) return localizePlayInZh(round);
  const parts = round.match(/^(.*?)(?:\s+-\s+Game\s+(\d+))?(\s+If Necessary)?$/i);
  const name = parts?.[1]?.trim() || '';
  const nameZh = ROUND_NAMES_ZH.find(([pattern]) => pattern.test(name))?.[1];
  if (!nameZh) return round;
  return `${nameZh}${parts[2] ? ` 第${parts[2]}戰` : ''}${parts[3] ? '（如有需要）' : ''}`;
}

// The series' own state from `playoff` ({bestOf, awayWins, homeWins}):
//   leader       'away' | 'home' | null (tied)
//   leaderWins/trailerWins
//   decided      one side has already won the series
//   stakes       'decider' - both sides one win from the series (Game 7,
//                            or a best-of-5's Game 5)
//                'elimination' - one side is one loss from going out;
//                            `eliminationSide` says which
//                null - nothing on the line beyond the game itself
// Stakes are only computed for a game that hasn't finished: ESPN's series
// counts already include a finished game's own result, so the same counts
// describe tomorrow's stakes, not tonight's. Null when there's no real
// series (a single-game play-in, or ESPN simply didn't send one).
export function playoffSeriesState(playoff, isFinished) {
  const { bestOf, awayWins, homeWins } = playoff || {};
  if (!Number.isInteger(bestOf) || bestOf < 2 || !Number.isInteger(awayWins) || !Number.isInteger(homeWins)) return null;
  const winsNeeded = Math.floor(bestOf / 2) + 1;
  const leader = awayWins === homeWins ? null : awayWins > homeWins ? 'away' : 'home';
  const leaderWins = Math.max(awayWins, homeWins);
  const trailerWins = Math.min(awayWins, homeWins);
  const decided = leaderWins >= winsNeeded;
  let stakes = null;
  let eliminationSide = null;
  if (!isFinished && !decided) {
    const awayCanClinch = awayWins === winsNeeded - 1;
    const homeCanClinch = homeWins === winsNeeded - 1;
    if (awayCanClinch && homeCanClinch) {
      stakes = 'decider';
    } else if (awayCanClinch || homeCanClinch) {
      stakes = 'elimination';
      eliminationSide = awayCanClinch ? 'home' : 'away';
    }
  }
  return { leader, leaderWins, trailerWins, decided, stakes, eliminationSide };
}
