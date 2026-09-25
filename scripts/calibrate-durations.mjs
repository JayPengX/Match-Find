// ---- scripts/calibrate-durations.mjs ----
//
// Measures the MLB duration model (public/lib/sport-duration.mjs's
// predictMlbDurationMinutes) against REAL game lengths, and refits it.
// Not part of the build - run it by hand whenever the model should be
// re-checked (every few weeks of a season is plenty).
//
// Real length, per finished game: MLB Stats API's own `gameInfo` - the
// actual first pitch and the official game time (`gameDurationMinutes`,
// first pitch to final out) - measured from the SCHEDULED start the app
// plans with, so it's exactly "scheduled start to the end of the game", the
// span a viewer's plan has to reserve. Checked against ESPN's own play-by-
// play wallclock (the final play's timestamp): Nationals @ Tigers,
// 2026-09-23, first pitch 17:12 + 164 min = 19:56, ESPN's last play 19:56:14.
// Games with a weather delay or a first pitch more than 30 minutes late (a
// doubleheader's second game, a postponement) are left out of the fit -
// nothing pre-game can predict those.
//
// The pre-game over/under (the model's odds term) isn't in the Stats API,
// so it comes from ESPN's core odds endpoint (the same one match-builder.mjs
// backfills from - the first non-live provider line) for the last
// `--odds-days` days.
//
// The fit minimizes ABSOLUTE error (iteratively reweighted least squares),
// i.e. it predicts the typical game rather than the mean: a rare 14-inning
// game shouldn't stretch every plan's estimate. It's fitted on games up to
// `--split` and scored on the games after it, so the reported improvement
// is on games the fit never saw.
//
// Last, the LIVE estimate (recommendation.mjs's estimateLiveDurationMinutes)
// is checked the same way: for the last `--live-days` days, ESPN's play-by-
// play gives the real wallclock, inning, outs and score on every play and
// at the final play, so the estimate can be scored every few plays from the
// 3rd inning on against when the game really ended.
//
// Usage: node scripts/calibrate-durations.mjs [--season 2026] [--split 2026-09-01] [--odds-days 30] [--live-days 14]
import {
  MLB_ABS_CHALLENGE_SYSTEM_PADDING_MINUTES,
  MLB_BASE_DURATION_MINUTES,
  MLB_COORS_FIELD_VENUE_MODIFIER_MINUTES,
  MLB_LEAGUE_AVG_OVER_UNDER,
  MLB_ODDS_DURATION_MODIFIER_CAP_MINUTES,
  MLB_ODDS_DURATION_MINUTES_PER_RUN,
  MLB_TEAM_PACE_OFFSET_MINUTES,
  predictMlbDurationMinutes
} from '../public/lib/sport-duration.mjs';
import { espnCoreOddsUrl, parsePregameCoreOdds } from '../public/lib/match-builder.mjs';
import { estimateLiveDurationMinutes } from '../public/lib/recommendation.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), [])
);
const season = args.season || String(new Date().getUTCFullYear());
const today = new Date().toISOString().slice(0, 10);
const split = args.split || `${season}-09-01`;
const oddsDays = Number(args['odds-days'] ?? 30);
const liveDays = Number(args['live-days'] ?? 14);

// ESPN's Akamai front blocks Node's default User-Agent - same honest bot UA
// as scripts/build-snapshot.mjs.
const FETCH_USER_AGENT = 'Match-Find-Bot/1.0 (+https://github.com/JayPengX/Match-Find)';

async function getJson(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': FETCH_USER_AGENT }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      if (i >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * i));
    }
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]).catch(() => null);
      }
    })
  );
  return results;
}

// ---- Real game lengths (MLB Stats API) ----
const schedule = await getJson(
  `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&startDate=${season}-03-01&endDate=${today}&hydrate=gameInfo,venue`
);
const games = schedule.dates
  .flatMap(d => d.games)
  .filter(g => g.status?.abstractGameState === 'Final' && Number.isFinite(g.gameInfo?.gameDurationMinutes) && g.gameInfo.firstPitch)
  .map(g => {
    const scheduledMs = Date.parse(g.gameDate);
    const lateStartMinutes = (Date.parse(g.gameInfo.firstPitch) - scheduledMs) / 60_000;
    return {
      date: g.officialDate,
      scheduledMs,
      awayTeam: g.teams.away.team.name,
      homeTeam: g.teams.home.team.name,
      venue: g.venue?.name || '',
      lateStartMinutes,
      delayMinutes: g.gameInfo.delayDurationMinutes || 0,
      actual: lateStartMinutes + g.gameInfo.gameDurationMinutes,
      overUnder: null
    };
  })
  .filter(g => g.delayMinutes === 0 && g.lateStartMinutes >= -5 && g.lateStartMinutes <= 30);

// ---- Pre-game over/under (ESPN) for the most recent games ----
if (oddsDays > 0) {
  const recentDates = [...new Set(games.map(g => g.date))].sort().slice(-oddsDays);
  const events = (
    await mapLimit(recentDates, 6, async date => {
      const board = await getJson(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${date.replaceAll('-', '')}`);
      return (board.events || []).map(e => ({
        id: e.id,
        startMs: Date.parse(e.date),
        homeTeam: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName
      }));
    })
  ).flat().filter(Boolean);
  const odds = await mapLimit(events, 8, async e => parsePregameCoreOdds(await getJson(espnCoreOddsUrl('baseball', 'mlb', e.id))));
  events.forEach((e, i) => {
    const overUnder = odds[i]?.overUnder;
    if (!Number.isFinite(overUnder)) return;
    const game = games.find(g => g.homeTeam === e.homeTeam && Math.abs(g.scheduledMs - e.startMs) < 45 * 60_000);
    if (game) game.overUnder = overUnder;
  });
}

// ---- Current model ----
const currentPrediction = g => predictMlbDurationMinutes({ awayTeam: g.awayTeam, homeTeam: g.homeTeam, venue: g.venue, oddsOverUnder: g.overUnder });
const unknownTeams = [...new Set(games.flatMap(g => [g.awayTeam, g.homeTeam]))].filter(t => !(t in MLB_TEAM_PACE_OFFSET_MINUTES));

// ---- Refit: base + (away + home pace) / 2 + Coors + per-run over/under ----
const teams = [...new Set(games.flatMap(g => [g.awayTeam, g.homeTeam]))].sort();
const clampedOu = ou =>
  Number.isFinite(ou)
    ? Math.max(-MLB_ODDS_DURATION_MODIFIER_CAP_MINUTES / MLB_ODDS_DURATION_MINUTES_PER_RUN, Math.min(MLB_ODDS_DURATION_MODIFIER_CAP_MINUTES / MLB_ODDS_DURATION_MINUTES_PER_RUN, ou - MLB_LEAGUE_AVG_OVER_UNDER))
    : 0;
const features = g => [
  1,
  ...teams.map(t => (t === g.awayTeam ? 0.5 : 0) + (t === g.homeTeam ? 0.5 : 0)),
  g.venue === 'Coors Field' ? 1 : 0,
  clampedOu(g.overUnder)
];
const OU_INDEX = teams.length + 2;

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || !M[c][c]) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Ridge on the team terms only (they're relative to the base, and a team
// with few games shouldn't swing far on noise).
function fit(rows, ridge = 20, iterations = 25) {
  const p = features(rows[0]).length;
  let weights = rows.map(() => 1);
  let coef = new Array(p).fill(0);
  for (let it = 0; it < iterations; it++) {
    const A = Array.from({ length: p }, () => new Array(p).fill(0));
    const b = new Array(p).fill(0);
    rows.forEach((g, idx) => {
      const x = features(g);
      const w = weights[idx];
      for (let i = 0; i < p; i++) {
        b[i] += w * x[i] * g.actual;
        for (let j = 0; j < p; j++) A[i][j] += w * x[i] * x[j];
      }
    });
    const scale = rows.length / weights.reduce((s, w) => s + w, 0);
    for (let i = 1; i <= teams.length; i++) A[i][i] += ridge / scale;
    // A term no row carries (no over/under found) would make A singular.
    for (let i = 0; i < p; i++) if (!A[i][i]) A[i][i] = 1;
    coef = solve(A, b);
    weights = rows.map(g => 1 / Math.max(1, Math.abs(g.actual - predictWith(coef, g))));
  }
  return coef;
}
const predictWith = (coef, g) => features(g).reduce((s, x, i) => s + x * coef[i], 0);

function stats(rows, predict) {
  const errors = rows.map(g => predict(g) - g.actual);
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  return {
    n: rows.length,
    bias: errors.reduce((s, e) => s + e, 0) / rows.length,
    mae: abs.reduce((s, e) => s + e, 0) / rows.length,
    median: abs[abs.length >> 1],
    within10: rows.filter((g, i) => Math.abs(errors[i]) <= 10).length / rows.length
  };
}
const fmt = s => `n=${s.n}  bias ${s.bias >= 0 ? '+' : ''}${s.bias.toFixed(1)}  MAE ${s.mae.toFixed(1)}  median |err| ${s.median.toFixed(1)}  within ±10 min ${(s.within10 * 100).toFixed(0)}%`;

const withLine = games.filter(g => Number.isFinite(g.overUnder));
if (withLine.length) {
  const withoutOdds = g => predictMlbDurationMinutes({ awayTeam: g.awayTeam, homeTeam: g.homeTeam, venue: g.venue });
  console.log(`Over/under term, on the ${withLine.length} games with a line:`);
  console.log(`  current model with it:           ${fmt(stats(withLine, currentPrediction))}`);
  console.log(`  current model without it:        ${fmt(stats(withLine, withoutOdds))}`);
}

const train = games.filter(g => g.date < split);
const test = games.filter(g => g.date >= split);
const holdout = fit(train);
const full = fit(games);

console.log(`MLB ${season}: ${games.length} finished games with a clean start (no delay, first pitch within 30 min)`);
console.log(`  pre-game over/under found for ${games.filter(g => Number.isFinite(g.overUnder)).length} (last ${oddsDays} days)`);
if (unknownTeams.length) console.log(`  teams missing from MLB_TEAM_PACE_OFFSET_MINUTES (treated as 0): ${unknownTeams.join(', ')}`);
console.log(`\nError = predicted - actual (minutes, scheduled start to final out)`);
console.log(`  current model, all games:        ${fmt(stats(games, currentPrediction))}`);
console.log(`  current model, since ${split}:  ${fmt(stats(test, currentPrediction))}`);
console.log(`  refit on before ${split}, since:  ${fmt(stats(test, g => predictWith(holdout, g)))}`);

const round = n => Math.round(n);
const base = full[0];
const offsets = teams.map((t, i) => [t, full[i + 1]]);
const meanOffset = offsets.reduce((s, [, v]) => s + v, 0) / offsets.length;
console.log(`\nRefit on all ${games.length} games (paste into public/lib/sport-duration.mjs):`);
console.log(`  MLB_BASE_DURATION_MINUTES + MLB_ABS_CHALLENGE_SYSTEM_PADDING_MINUTES = ${round(base + meanOffset)} (now ${MLB_BASE_DURATION_MINUTES + MLB_ABS_CHALLENGE_SYSTEM_PADDING_MINUTES})`);
console.log(`  MLB_COORS_FIELD_VENUE_MODIFIER_MINUTES = ${round(full[teams.length + 1])} (now ${MLB_COORS_FIELD_VENUE_MODIFIER_MINUTES})`);
console.log(`  minutes per run of over/under = ${full[OU_INDEX].toFixed(1)} (now ${MLB_ODDS_DURATION_MINUTES_PER_RUN}; fitted on the ${games.filter(g => Number.isFinite(g.overUnder)).length} games with a line)`);
console.log('  MLB_TEAM_PACE_OFFSET_MINUTES:');
offsets
  .map(([t, v]) => [t, v - meanOffset])
  .sort((a, b) => a[1] - b[1])
  .forEach(([t, v]) => console.log(`    '${t}': ${round(v)}, // now ${MLB_TEAM_PACE_OFFSET_MINUTES[t] ?? 'missing'}`));

// ---- Live estimate vs real end (ESPN play-by-play wallclock) ----
if (liveDays > 0) {
  const recentDates = [...new Set(games.map(g => g.date))].sort().slice(-liveDays);
  const events = (
    await mapLimit(recentDates, 6, async date => {
      const board = await getJson(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${date.replaceAll('-', '')}`);
      return (board.events || []).filter(e => e.competitions?.[0]?.status?.type?.state === 'post');
    })
  ).flat().filter(Boolean);
  const summaries = await mapLimit(events, 8, e => getJson(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${e.id}`));
  const byInning = new Map();
  let used = 0;
  events.forEach((event, i) => {
    const plays = (summaries[i]?.plays || []).filter(p => p.wallclock);
    if (plays.length < 20) return;
    const competition = event.competitions[0];
    const startMs = Date.parse(event.date);
    const endMs = Date.parse(plays.at(-1).wallclock);
    const actual = (endMs - startMs) / 60_000;
    if (actual < 100 || actual > 330) return; // a delay or a data gap
    const team = side => competition.competitors.find(c => c.homeAway === side)?.team?.displayName;
    const pregame = predictMlbDurationMinutes({ awayTeam: team('away'), homeTeam: team('home'), venue: competition.venue?.fullName });
    used++;
    // Every 4th play from the 3rd inning on, as the live poll would see it:
    // inning, half, outs after the play, and the score.
    const halfName = { Top: 'Top', Bottom: 'Bot', Mid: 'Mid', End: 'End' };
    plays
      .filter((p, k) => k % 4 === 0 && p.period?.number >= 3 && Date.parse(p.wallclock) < endMs)
      .forEach(p => {
        const live = {
          isLive: true,
          period: p.period.number,
          shortDetail: `${halfName[p.period.type] || ''} ${p.period.number}`,
          situation: { outs: p.outs ?? null },
          scores: [p.awayScore, p.homeScore]
        };
        const predicted = estimateLiveDurationMinutes('MLB', event.date, pregame, live, Date.parse(p.wallclock));
        const key = Math.min(9, p.period.number);
        if (!byInning.has(key)) byInning.set(key, []);
        byInning.get(key).push(predicted - actual);
      });
  });
  const all = [...byInning.values()].flat();
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  console.log(`\nLive estimate vs real end, ${used} games over the last ${liveDays} days (error in minutes, checked every few plays; 9 = 9th and later):`);
  console.log(`  all checkpoints: MAE ${mean(all.map(Math.abs)).toFixed(1)}, bias ${mean(all).toFixed(1)}`);
  console.log(
    '  by inning (bias / MAE): ' +
      [...byInning.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, e]) => `${n}: ${mean(e).toFixed(0)} / ${mean(e.map(Math.abs)).toFixed(0)}`)
        .join('   ')
  );
}
