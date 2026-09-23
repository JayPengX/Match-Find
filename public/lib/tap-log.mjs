// On-screen tap/gesture logger, for debugging input bugs that only happen on
// a real iPhone (no devtools, no backend to send logs to). Off by default.
// Turn it on by tapping the "Data last updated" line 5 times quickly, or by
// opening the page with ?debug=taps. It stays on across reloads until turned
// off with its own "Off" button (the flag lives in localStorage, which a new
// deploy wipes anyway - see app.js's wipeStorageOnNewBuild).
//
// What it records, all at the document's capture phase so nothing on the
// page can hide an event from it: every touch/pointer/mouse/click event
// (with its target and the topmost element actually under the finger),
// scroll events (a stuck momentum scroll swallows taps), plus app-level
// markers that app.js reports through tapLog() (swipe start/end, renders).
// "Copy" puts the whole log on the clipboard so it can be pasted anywhere.
//
// Heads-up: turning the log on is NOT side-effect free. Its document-level
// listeners change how iOS WebKit routes taps, so it can make a bug
// disappear. That's a clue, not a dead end - it's exactly how the iOS
// "every tap needs two taps after a swipe" bug was found (see the
// "DO NOT REMOVE - iOS Safari" listeners near the top of app.js).

const STORAGE_KEY = 'matchfind-tap-log-enabled';
const MAX_LINES = 300;
const TOGGLE_TAPS = 5;
const TOGGLE_WINDOW_MS = 2500;

const lines = [];
let enabled = false;
let panel = null;
let listEl = null;
let startedAt = 0;

function describe(el) {
  if (!el || el.nodeType !== 1) return el === document ? 'document' : String(el && el.nodeName);
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
  if (cls.length) s += `.${cls.join('.')}`;
  return s;
}

function stamp() {
  return ((performance.now() - startedAt) / 1000).toFixed(3).padStart(8, ' ');
}

export function tapLog(message) {
  if (!enabled) return;
  lines.push(`${stamp()} ${message}`);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  if (listEl) {
    listEl.textContent = lines.slice(-60).join('\n');
    listEl.scrollTop = listEl.scrollHeight;
  }
}

function logEvent(event) {
  if (panel && panel.contains(event.target)) return; // the log's own buttons
  let extra = '';
  if (event.touches) {
    const touch = event.changedTouches[0];
    if (touch) {
      const x = Math.round(touch.clientX);
      const y = Math.round(touch.clientY);
      extra = ` @${x},${y} n=${event.touches.length}`;
      if (event.type === 'touchstart') extra += ` top=${describe(document.elementFromPoint(x, y))}`;
    }
  } else if (event.pointerType !== undefined) {
    extra = ` ${event.pointerType} id=${event.pointerId} @${Math.round(event.clientX)},${Math.round(event.clientY)}`;
  } else if (event.clientX !== undefined) {
    extra = ` @${Math.round(event.clientX)},${Math.round(event.clientY)}`;
  }
  if (event.defaultPrevented) extra += ' PREVENTED';
  if (!event.isTrusted) extra += ' SYNTHETIC';
  tapLog(`${event.type} ${describe(event.target)}${extra}`);
}

let lastScrollLogAt = 0;
function logScroll(event) {
  if (panel && panel.contains(event.target)) return;
  // Throttled - a momentum scroll fires dozens of these a second.
  const now = performance.now();
  if (now - lastScrollLogAt < 250) return;
  lastScrollLogAt = now;
  const target = event.target === document ? `page y=${Math.round(window.scrollY)}` : `${describe(event.target)} x=${Math.round(event.target.scrollLeft)}`;
  tapLog(`scroll ${target}`);
}

const EVENT_TYPES = [
  'touchstart', 'touchend', 'touchcancel',
  'pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture',
  'mouseover', 'mousedown', 'mouseup', 'click',
  'gesturestart', 'gestureend', 'contextmenu', 'selectstart', 'dragstart', 'focusin'
];

function buildPanel() {
  panel = document.createElement('div');
  panel.setAttribute('style', [
    'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
    'height:38vh', 'display:flex', 'flex-direction:column',
    'background:rgba(0,0,0,0.85)', 'color:#7CFC8A',
    'font:10px/1.35 ui-monospace,Menlo,monospace',
    'padding-bottom:env(safe-area-inset-bottom)'
  ].join(';'));

  const bar = document.createElement('div');
  bar.setAttribute('style', 'display:flex;gap:6px;padding:6px;flex:none');
  const mkBtn = (label, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('style', 'font:12px system-ui;padding:6px 10px;border-radius:6px;border:1px solid #555;background:#222;color:#fff');
    b.addEventListener('click', onClick);
    bar.appendChild(b);
    return b;
  };
  const copyBtn = mkBtn('Copy', () => copyLog(copyBtn));
  mkBtn('Clear', () => { lines.length = 0; tapLog('--- cleared ---'); });
  mkBtn('Mark', () => tapLog('========== MARK =========='));
  let collapsed = false;
  const hideBtn = mkBtn('Hide', () => {
    collapsed = !collapsed;
    listEl.style.display = collapsed ? 'none' : '';
    panel.style.height = collapsed ? 'auto' : '38vh';
    hideBtn.textContent = collapsed ? 'Show' : 'Hide';
  });
  mkBtn('Off', () => setEnabled(false));

  listEl = document.createElement('pre');
  // pointer-events:none so the log area never eats a tap meant for the page
  // behind it - only the buttons above are interactive.
  listEl.setAttribute('style', 'margin:0;padding:0 6px 6px;overflow:hidden;flex:1;white-space:pre-wrap;word-break:break-all;pointer-events:none');

  panel.append(bar, listEl);
  document.body.appendChild(panel);
}

async function copyLog(btn) {
  const text = [
    `UA: ${navigator.userAgent}`,
    `standalone: ${Boolean(navigator.standalone) || matchMedia('(display-mode: standalone)').matches}`,
    `viewport: ${innerWidth}x${innerHeight} dpr=${devicePixelRatio}`,
    '',
    ...lines
  ].join('\n');
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Older iOS / non-secure context fallback: a selected textarea + execCommand.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  btn.textContent = ok ? 'Copied!' : 'Copy failed';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

function setEnabled(value) {
  if (value === enabled) return;
  enabled = value;
  try {
    if (value) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage blocked - still works for this page load */ }
  if (value) {
    startedAt = performance.now();
    EVENT_TYPES.forEach(type => document.addEventListener(type, logEvent, { capture: true, passive: true }));
    document.addEventListener('scroll', logScroll, { capture: true, passive: true });
    buildPanel();
    tapLog('tap log on');
  } else {
    EVENT_TYPES.forEach(type => document.removeEventListener(type, logEvent, { capture: true }));
    document.removeEventListener('scroll', logScroll, { capture: true });
    panel?.remove();
    panel = null;
    listEl = null;
    lines.length = 0;
  }
}

export function installTapLog(toggleEl) {
  let storedOn = false;
  try { storedOn = localStorage.getItem(STORAGE_KEY) === '1'; } catch { /* ignore */ }
  if (storedOn || new URLSearchParams(location.search).get('debug') === 'taps') setEnabled(true);

  if (!toggleEl) return;
  let taps = [];
  toggleEl.addEventListener('click', () => {
    const now = Date.now();
    taps = taps.filter(t => now - t < TOGGLE_WINDOW_MS);
    taps.push(now);
    if (taps.length >= TOGGLE_TAPS) {
      taps = [];
      setEnabled(!enabled);
    }
  });
}
