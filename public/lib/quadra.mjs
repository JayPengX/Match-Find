// Quadra 四方: what the four Quadra apps share. The same file sits in each of
// them (Stock-Study, Odds-Study and Match-Find under public/lib/, Orbit-Vocab
// at its root); change one, copy it to the other three.
//
//   Quadra Securities 四方證券  (Stock Study)   the base: a brokerage
//   Quadra Sportsbook 四方運彩  (Odds Study)    a side play: betting
//   Quadra Fixtures   四方賽程  (Match Find)    a schedule tool
//   Quadra Words      四方單字  (Orbit Vocab)   a big mini game that pays
//
// One account works in all four: the Quadra Pass 四方通行碼, a 10-character
// code for Shared-Proxy's /eco route. Behind it a shared NT$ money pool (the
// wallet): Securities' NT$ cash and Sportsbook's balance are the same money.
// Play money only.

export const ECO_URL = 'https://orbit-workers-proxy.pengzjay.workers.dev/eco';
export const SITE = 'https://jaypengx.github.io';

export const BRAND = { zh: '四方', en: 'Quadra', passZh: '四方通行碼', passEn: 'Quadra Pass' };

export const APPS = {
  stock: { zh: '四方證券', en: 'Quadra Securities', short: { zh: '證券', en: 'Securities' }, path: '/Stock-Study/', color: '#0d9488', icon: '📈' },
  odds: { zh: '四方運彩', en: 'Quadra Sportsbook', short: { zh: '運彩', en: 'Sportsbook' }, path: '/Odds-Study/', color: '#2563eb', icon: '🎟️' },
  match: { zh: '四方賽程', en: 'Quadra Fixtures', short: { zh: '賽程', en: 'Fixtures' }, path: '/Match-Find/', color: '#d97706', icon: '📅' },
  vocab: { zh: '四方單字', en: 'Quadra Words', short: { zh: '單字', en: 'Words' }, path: '/Orbit-Vocab/', color: '#5655e8', icon: '🔤' }
};
export const appName = (app, lang = 'zh') => APPS[app]?.[lang === 'en' ? 'en' : 'zh'] || app;

// The economy, in one place so the four apps stay in balance: Securities is
// where money lives and grows, Sportsbook a small side play, Words the one
// that pays for real effort.
export const ECONOMY = {
  stockStart: 100_000,
  // On the 1st of every month, when Securities is opened.
  stockMonthly: 3_000,
  oddsStart: 10_000,
  // Every Monday (Taiwan time), when Sportsbook is opened.
  oddsWeekly: 1_000,
  // Quadra Words: per right answer, per word newly mastered, at most a day.
  vocab: { perCorrect: 2, perMastered: 20, dailyCap: 800 },
  // Each app's mini games, at most a Taiwan day.
  gamesDailyCap: { odds: 1_500, stock: 1_000 }
};

// ---- Codes ---------------------------------------------------------------------

export const PASS_PATTERN = /^[2-9A-HJ-NP-Z]{10}$/;
// The old, one-app codes: Stock Study and Odds Study 8 characters, Orbit Vocab 16.
export const LEGACY_PATTERNS = { stock: /^[2-9A-HJ-NP-Z]{8}$/, odds: /^[2-9A-HJ-NP-Z]{8}$/, vocab: /^[2-9A-HJ-NP-Z]{16}$/ };

// What people type: lower case, spaces and dashes are fine (codes never use
// 0, 1, O or I, so they can't be misread).
export function cleanCode(text) {
  return String(text || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}
export const isPass = code => PASS_PATTERN.test(cleanCode(code));
export const formatPass = code => (code && code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code || '');

// ---- This browser's pass ---------------------------------------------------------
//
// The four apps are one site (jaypengx.github.io), so in a browser they share
// storage: the pass entered in one app is there in the others. (Apps added
// to an iPhone's home screen each keep their own storage, so there it's
// entered once per app.)

const PASS_KEY = 'quadra.pass';
const WALLET_KEY = 'quadra.wallet';

function readStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

export function storedPass() {
  const code = readStore(PASS_KEY) || '';
  return PASS_PATTERN.test(code) ? code : '';
}
export function storePass(code) {
  writeStore(PASS_KEY, code && PASS_PATTERN.test(code) ? code : null);
  if (!code) writeStore(WALLET_KEY, null);
}

// The last wallet seen, so the pool shows at once (and offline).
export function cachedWallet(code) {
  try {
    const saved = JSON.parse(readStore(WALLET_KEY) || 'null');
    return saved && saved.code === code ? saved.wallet : null;
  } catch {
    return null;
  }
}
export function cacheWallet(code, wallet) {
  if (code && wallet) writeStore(WALLET_KEY, JSON.stringify({ code, wallet }));
}

// ---- The Worker ------------------------------------------------------------------

async function request(method, query, body) {
  const res = await fetch(`${ECO_URL}${query}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data?.error?.message || `HTTP ${res.status}`);
    error.code = data?.error?.code || `HTTP_${res.status}`;
    if (data?.error?.index != null) error.index = data.error.index;
    throw error;
  }
  return data;
}
const q = params => `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString()}`;

// { exists, wallet, pool, payload (this app's data, '' if none yet), updateTime, inbox? }
export const ecoRead = (passcode, app, { inbox = false } = {}) => request('GET', q({ passcode, app, inbox: inbox ? '1' : '' }));
// Writes this app's data and/or a wallet change; returns the merged wallet.
export const ecoWrite = (passcode, app, { payload, wallet } = {}) => request('PATCH', q({ passcode, app }), { payload, wallet });
// A new Quadra Pass: { passcode, wallet, pool }.
export const ecoCreate = ({ app, payload, wallet } = {}) => request('POST', app ? q({ app }) : '', { op: 'create', payload, wallet });
export const ecoTransfer = (passcode, to, amount, note, id = randomId()) => request('POST', '', { op: 'transfer', passcode, to: cleanCode(to), amount, note, id });
// sources: [{ app: 'stock' | 'odds' | 'vocab' | 'eco', passcode }]; into `passcode` if given, else a new pass.
export const ecoMerge = (sources, passcode) => request('POST', '', { op: 'merge', passcode, sources });
export const ecoDropInbox = (passcode, app, id) => request('DELETE', q({ passcode, app, inbox: id }));
export const ecoDelete = (passcode, app) => request('DELETE', q({ passcode, app }));

export function randomId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ---- The pool ----------------------------------------------------------------------

const cash = s => (typeof s?.cash === 'number' && Number.isFinite(s.cash) ? s.cash : 0);

export function poolBalance(wallet) {
  if (!wallet) return 0;
  const entries = (wallet.entries || []).reduce((sum, e) => sum + e.amount, 0);
  return Math.round((entries + Object.values(wallet.snap || {}).reduce((sum, s) => sum + cash(s), 0)) * 100) / 100;
}

// The pool less `app`'s own part: what the other apps (and transfers,
// rewards, merges) put in or took out. An app shows its own money plus this.
export function othersBalance(wallet, app) {
  if (!wallet) return 0;
  const entries = (wallet.entries || []).filter(e => e.app !== app).reduce((sum, e) => sum + e.amount, 0);
  const snaps = Object.entries(wallet.snap || {})
    .filter(([name]) => name !== app)
    .reduce((sum, [, s]) => sum + cash(s), 0);
  return Math.round((entries + snaps) * 100) / 100;
}

// Entries that came from elsewhere than `app` (newest first).
export const entriesNotFrom = (wallet, app) => (wallet?.entries || []).filter(e => e.app !== app).sort((a, b) => b.t - a.t);

// What an entry is, in words.
const KIND = {
  start: ['開戶金', 'Opening money'],
  grant: ['每週零用金', 'Weekly allowance'],
  pay: ['每月薪資', 'Monthly pay'],
  stake: ['下注', 'Bet'],
  payout: ['彩金', 'Winnings'],
  game: ['小遊戲', 'Mini game'],
  reward: ['學習獎勵', 'Study reward'],
  'xfer-in': ['轉入', 'Transfer in'],
  'xfer-out': ['轉出', 'Transfer out'],
  merge: ['合併帶入', 'Carried over (merge)']
};
export function describeEntry(e, lang = 'zh') {
  const i = lang === 'en' ? 1 : 0;
  const what = KIND[e.kind]?.[i] || e.kind;
  const from = e.app === 'eco' ? BRAND[lang === 'en' ? 'passEn' : 'passZh'] : appName(e.app, lang);
  const peer = e.peer ? ` ${e.peer}` : '';
  return `${from} · ${what}${peer}${e.note ? ` · ${e.note}` : ''}`;
}

// Setting values (newest wins across devices and apps).
export const setting = (wallet, key, fallback = null) => wallet?.settings?.[key]?.value ?? fallback;
export const settingPatch = (key, value) => ({ settings: { [key]: { value, t: Date.now() } } });

// Quadra Sportsbook's betting limit: the most it may stake in a Taiwan week
// (Monday to Sunday), 0 for none. Set in Sportsbook, kept in the wallet.
export const ODDS_LIMIT_KEY = 'oddsWeeklyLimit';

// Pins: matches Sportsbook sends to Fixtures' schedule, by match id.
export const activePins = wallet =>
  Object.entries(wallet?.pins || {})
    .filter(([, p]) => p.on)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));

// ---- The shell: installed-only on phones, and always the newest version ----------

export function isStandalone() {
  return Boolean(globalThis.matchMedia?.('(display-mode: standalone)').matches || globalThis.matchMedia?.('(display-mode: fullscreen)').matches || globalThis.navigator?.standalone);
}
export function isPhoneOrTablet() {
  const ua = globalThis.navigator?.userAgent || '';
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  // iPadOS reports itself as a Mac.
  return /Macintosh/.test(ua) && (globalThis.navigator?.maxTouchPoints || 0) > 1;
}
const isIOS = () => /iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent || '') || (/Macintosh/.test(globalThis.navigator?.userAgent || '') && (globalThis.navigator?.maxTouchPoints || 0) > 1);
// In-app browsers (LINE, Instagram, Facebook…) can't add to the home screen.
const inAppBrowser = () => /Line\/|FBAN|FBAV|Instagram|Messenger|MicroMessenger|KAKAOTALK/i.test(globalThis.navigator?.userAgent || '');

// On a phone or tablet the apps only run from the home screen (where they
// get their own full screen, storage that lasts and notifications). In a
// browser tab there, this covers the page with how to add it. Returns true
// if it did (the app shouldn't start).
export function installGate(app, lang = 'zh') {
  if (!isPhoneOrTablet() || isStandalone()) return false;
  const en = lang === 'en';
  const name = appName(app, lang);
  const steps = inAppBrowser()
    ? en
      ? ['Open this page in Safari (iPhone) or Chrome (Android): tap ⋯ and “Open in browser”.', 'Then add it to your home screen.']
      : ['請先用 Safari（iPhone）或 Chrome（Android）開啟：點右上角 ⋯，選「在瀏覽器開啟」。', '再加入主畫面。']
    : isIOS()
      ? en
        ? ['Tap Share (the square with an arrow) at the bottom of Safari.', 'Choose “Add to Home Screen”, then “Add”.', `Open ${name} from its new icon.`]
        : ['點 Safari 下方的「分享」（方框加箭頭）。', '選「加入主畫面」，再點「新增」。', `從主畫面上的新圖示打開${name}。`]
      : en
        ? ['Tap ⋮ at the top right of Chrome.', 'Choose “Add to Home screen” (or “Install app”).', `Open ${name} from its new icon.`]
        : ['點 Chrome 右上角的 ⋮。', '選「加入主畫面」或「安裝應用程式」。', `從主畫面上的新圖示打開${name}。`];
  const gate = document.createElement('div');
  gate.className = 'quadra-gate';
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-modal', 'true');
  gate.innerHTML = `
    <div class="quadra-gate-box">
      <img class="quadra-gate-icon" src="./favicon.svg" alt="" width="84" height="84" />
      <p class="quadra-gate-brand">${en ? 'Quadra' : '四方 Quadra'}</p>
      <h1 class="quadra-gate-title"></h1>
      <p class="quadra-gate-lede"></p>
      <ol class="quadra-gate-steps"></ol>
      <p class="quadra-gate-why"></p>
    </div>`;
  gate.querySelector('.quadra-gate-title').textContent = en ? `Add ${name} to your home screen` : `把${name}加入主畫面`;
  gate.querySelector('.quadra-gate-lede').textContent = en
    ? 'On phones and tablets the Quadra apps run from the home screen only.'
    : '在手機和平板上，四方的應用程式只能從主畫面開啟。';
  const list = gate.querySelector('.quadra-gate-steps');
  for (const step of steps) {
    const li = document.createElement('li');
    li.textContent = step;
    list.append(li);
  }
  gate.querySelector('.quadra-gate-why').textContent = en
    ? 'Why: a home-screen app gets its own full screen, keeps your data (Safari can clear a site’s data after 7 days unopened), can notify you, and updates itself.'
    : '原因：加入主畫面後有完整畫面、資料不會被清掉（Safari 會清除 7 天沒開的網站資料）、可以通知你，也會自動更新。';
  document.body.append(gate);
  document.documentElement.classList.add('quadra-gated');
  return true;
}

// Always the newest deploy. Every deploy writes version.json; this checks it
// on opening, whenever the app comes back to the screen, and every few
// minutes while it's open. When there's a newer one: every cached file is
// thrown away (so nothing old can linger in a home-screen app), the service
// worker updates, and the page reloads under the new version, once.
// `busy()` (optional): true while reloading now would interrupt something
// (a game round, typing); the reload then waits for the next check.
export function watchUpdates({ current, key, busy = () => false, every = 5 * 60_000 } = {}) {
  if (!current || current === 'dev') return;
  let checking = false;
  async function check() {
    if (checking || document.visibilityState === 'hidden') return;
    checking = true;
    try {
      const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
      const latest = res.ok ? (await res.json())?.version : null;
      if (!latest || latest === current || busy()) return;
      const flag = `${key || 'quadra'}.reloadedTo`;
      if (sessionStorage.getItem(flag) === latest) return;
      sessionStorage.setItem(flag, latest);
      document.documentElement.classList.add('quadra-updating');
      if (globalThis.caches) for (const name of await caches.keys()) await caches.delete(name);
      const reg = await navigator.serviceWorker?.getRegistration?.();
      await reg?.update?.().catch(() => {});
      location.replace(`${location.pathname}?v=${encodeURIComponent(latest)}${location.hash}`);
    } catch {
    } finally {
      checking = false;
    }
  }
  check();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
  globalThis.addEventListener?.('pageshow', event => event.persisted && check());
  setInterval(check, every);
}
