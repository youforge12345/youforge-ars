/* =============================================================================
   YouForge Auto Recovery 3X12 — Service Worker
   -----------------------------------------------------------------------------
   What this file does, in plain terms:

   1. On install, it downloads and caches the "app shell" (index.html, the
      manifest, icons) so the app can open even with no network connection.

   2. STATIC assets (the app shell, icons, Google Fonts, and the third-party
      libraries this app loads — Firebase SDK, Chart.js, jsPDF, html2canvas,
      xlsx — all from cdnjs.cloudflare.com / gstatic.com) use a "Cache
      First" strategy — serve instantly from cache, and only go to the
      network if something isn't cached yet. These are versioned URLs that
      rarely change, so this is safe and fast.

   3. Firebase/Firestore/Auth network calls use a "Network First" strategy
      — always try the real network first (so account data, trading state,
      and the single-device-login check are always fresh), and only fall
      back to a cached copy if the network is unreachable. Nothing here is
      ever treated as "static", so private account data is never served
      stale from a background cache.

   4. On navigation (loading the page itself) with no network and nothing
      cached, it serves /offline.html instead of a browser error page.

   5. HOW UPDATES WORK: every deploy, bump CACHE_VERSION below. The browser
      detects the new sw.js file, installs it in the background, and the
      page (see the registration code added in index.html) shows a
      "New version available" banner with an Update button. Clicking it
      calls skipWaiting() + reloads, so the new version takes over
      immediately instead of waiting for every tab to close.
   ============================================================================= */

// ── Bump this on every deploy — it's what makes the update flow above work. ──
const CACHE_VERSION = 'v1.0.0';

const STATIC_CACHE  = `yfar-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `yfar-runtime-${CACHE_VERSION}`;
const OFFLINE_URL   = '/offline.html';

// The core "app shell" — cached immediately on install so the app can
// launch offline right after the very first visit.
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png'
];

// Domains whose responses should NEVER be treated as "static" — always
// go to the network first for these (Firebase Auth/Firestore, and any
// REST-style API calls the app makes). This is also where the single-
// device-login check happens, so it must never be served stale.
const NETWORK_FIRST_HOSTS = [
  'firestore.googleapis.com',
  'firebaseio.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebasestorage.googleapis.com',
  'googleapis.com'
];

// Domains that ARE safe to cache long-term (fonts, the Firebase SDK,
// Chart.js/jsPDF/html2canvas/xlsx, etc.) — versioned/immutable URLs,
// not user data.
const STATIC_ALLOWLIST_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.gstatic.com',
  'cdnjs.cloudflare.com'
];

/* ---------------------------------------------------------------------------
   INSTALL — pre-cache the app shell, then activate immediately (don't wait
   for old tabs to close before the new SW takes over).
   ------------------------------------------------------------------------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

/* ---------------------------------------------------------------------------
   ACTIVATE — delete any cache from a previous version, then take control
   of all open tabs right away.
   ------------------------------------------------------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* ---------------------------------------------------------------------------
   Let the page (index.html) tell a *waiting* service worker to activate
   immediately when the user clicks "Update" on the new-version banner.
   ------------------------------------------------------------------------- */
self.addEventListener('message', (event) => {
  if(event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});

/* ---------------------------------------------------------------------------
   FETCH — routes every request through one of the two strategies above.
   ------------------------------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only GET requests are cacheable; let everything else (Firestore
  // writes, auth calls, etc.) pass straight through to the network
  // untouched.
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache anything Firebase considers sensitive/live — always hit
  // the network first for Auth/Firestore calls (this includes the
  // single-device-login deviceId check, which must always be current).
  if(NETWORK_FIRST_HOSTS.some((host) => url.hostname.includes(host))){
    event.respondWith(networkFirst(req));
    return;
  }

  // Full-page navigations (typing the URL, opening the installed app,
  // following a link) — try the network, fall back to the cached shell,
  // and finally to the dedicated offline page.
  if(req.mode === 'navigate'){
    event.respondWith(navigationHandler(req));
    return;
  }

  // Same-origin static assets, or an explicitly allow-listed CDN (fonts,
  // Firebase SDK, Chart.js, jsPDF, html2canvas, xlsx) — Cache First.
  const isSameOrigin = url.origin === self.location.origin;
  const isAllowlistedCdn = STATIC_ALLOWLIST_HOSTS.some((host) => url.hostname.includes(host));

  if(isSameOrigin || isAllowlistedCdn){
    event.respondWith(cacheFirst(req));
    return;
  }

  // Anything else (unrecognized third-party requests) — just let it
  // through to the network as normal, no caching either way.
});

/* ---- Cache First: serve from cache, fill the cache in the background
   from the network the first time anything is requested. ---- */
async function cacheFirst(req){
  const cached = await caches.match(req);
  if(cached) return cached;

  try{
    const fresh = await fetch(req);
    // Opaque (cross-origin, no-cors) responses are still cacheable and
    // useful offline, even though we can't inspect their status.
    if(fresh && (fresh.ok || fresh.type === 'opaque')){
      const cache = await caches.open(STATIC_CACHE);
      cache.put(req, fresh.clone());
    }
    return fresh;
  }catch(err){
    // Nothing cached and no network — let the caller's own error
    // handling (or the navigation fallback below) take over.
    throw err;
  }
}

/* ---- Network First: always prefer a live response; only fall back to
   whatever was last cached if the network is completely unreachable. ---- */
async function networkFirst(req){
  try{
    const fresh = await fetch(req);
    if(fresh && fresh.ok){
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, fresh.clone());
    }
    return fresh;
  }catch(err){
    const cached = await caches.match(req);
    if(cached) return cached;
    throw err;
  }
}

/* ---- Page navigations: network first, then cached shell, then the
   dedicated offline page as a last resort. ---- */
async function navigationHandler(req){
  try{
    const fresh = await fetch(req);
    if(fresh && fresh.ok){
      const cache = await caches.open(STATIC_CACHE);
      cache.put('/index.html', fresh.clone());
    }
    return fresh;
  }catch(err){
    const cachedShell = await caches.match('/index.html');
    if(cachedShell) return cachedShell;
    const offline = await caches.match(OFFLINE_URL);
    if(offline) return offline;
    throw err;
  }
}
