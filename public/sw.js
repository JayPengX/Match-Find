// ---- public/sw.js ----
// Keeps this site's own code (the "app shell": index.html, app.js,
// styles.css, every module, icons) on the device, so opening the page -
// the home-screen app especially, which iOS cold-starts far more often than
// a Safari tab and which shares no cache with Safari - no longer waits on
// GitHub Pages for anything before it can start fetching match data.
// Everything live (match data, odds, logos, fonts) is left alone and goes
// to the network exactly as without this file.
//
// One cache per deploy: deploy.yml stamps BUILD_ID with the commit sha (the
// same way it stamps app.js's APP_BUILD_ID), which changes this file's
// bytes, so the browser installs a new worker on the next visit after every
// deploy. That worker downloads the new build's whole shell into its own
// cache before taking over, then deletes the old cache - so the files
// served together always come from ONE deploy, never a new app.js with an
// old module. app.js's own new-version check (checkForAppVersionUpdate)
// fetches app.js with `cache: 'no-store'`, which this worker deliberately
// passes straight to the network; before the reload that follows, app.js
// makes sure this worker has been replaced by the new deploy's (or removes
// it) - see prepareServiceWorkerForBuild there.
const BUILD_ID = '__BUILD_ID__';
const CACHE_PREFIX = 'matchfind-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;

// Keep in sync with public/ (tests/app-shell.test.mjs checks every
// module under lib/ is listed, and that every entry exists).
const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './favicon.svg',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-512.png',
  './lib/color.mjs',
  './lib/espn.mjs',
  './lib/i18n.mjs',
  './lib/match-builder.mjs',
  './lib/objective-score.mjs',
  './lib/playoff.mjs',
  './lib/polymarket.mjs',
  './lib/preferences.mjs',
  './lib/recommendation.mjs',
  './lib/sport-duration.mjs',
  './lib/sport-signals.mjs',
  './lib/tap-log.mjs',
  './lib/team-names.mjs',
  './lib/locales/en.mjs',
  './lib/locales/zh-TW.mjs'
];

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        // `cache: 'reload'` skips the HTTP cache, which could still hold the
        // PREVIOUS deploy's copy of a file for up to GitHub Pages' 10 minutes.
        await cache.addAll(SHELL_FILES.map(url => new Request(url, { cache: 'reload' })));
        // Refuse to install a mixed shell: if the CDN handed back an app.js
        // from a different deploy than this worker's own, fail - the browser
        // simply retries on a later visit, and the old worker keeps serving
        // its own consistent set meanwhile.
        if (!BUILD_ID.startsWith('__')) {
          const appJs = await cache.match('./app.js');
          const text = appJs ? await appJs.text() : '';
          if (!text.includes(BUILD_ID)) throw new Error('app.js in the cache is not from this build');
        }
      } catch (error) {
        // A half-filled cache named after this build would look, to
        // app.js's prepareServiceWorkerForBuild, like a finished update.
        await caches.delete(CACHE_NAME);
        throw error;
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

async function fromCacheThenNetwork(request, fallbackKey) {
  const cache = await caches.open(CACHE_NAME);
  const cached = (await cache.match(request, { ignoreSearch: true })) || (fallbackKey && (await cache.match(fallbackKey)));
  return cached || fetch(request);
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only this site's own files - match data, odds, logos and fonts all
  // come from other origins and stay untouched.
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL('./', self.location).pathname)) return;
  // An explicit "don't use a cache" request (app.js's own version check)
  // must see the real, current deploy.
  if (request.cache === 'no-store' || request.cache === 'reload') return;
  if (url.pathname.endsWith('/sw.js')) return;

  if (request.mode === 'navigate') {
    // Always from this worker's own cache, so the page and every file it
    // loads come from the same deploy (see this file's top comment).
    event.respondWith(fromCacheThenNetwork(request, './'));
    return;
  }
  // Static files: the deployed index.html asks for `app.js?v=<sha>`, so
  // the query is ignored when matching.
  event.respondWith(fromCacheThenNetwork(request));
});
