/* eslint-disable */
/**
 * QD Auctions Service Worker
 * --------------------------------------------------------------
 * Lightweight, zero-dependency service worker that gives us a
 * production-grade offline shell + smart runtime caching without
 * pulling in Workbox (which would bloat the JS bundle and require
 * a custom Metro/webpack plugin in Expo Router's bundler).
 *
 * Caching strategy:
 *   - PRECACHE (static shell)     → cache-first, served instantly
 *   - HTML navigations             → network-first w/ offline fallback
 *   - API GETs (`/api/...`)        → stale-while-revalidate (5min)
 *   - Images & static media        → cache-first (30d, max 80 items)
 *   - Bundles (/_expo/static/...)  → cache-first (immutable)
 *
 * Mutating verbs (POST/PUT/DELETE/PATCH) and WebSocket upgrades are
 * never cached — they fall straight through to the network.
 *
 * The version string below busts every cache on deploy. Bumping it
 * forces clients to discard old caches on the next activate event.
 */
const SW_VERSION = 'qdauctions-pwa-v1.0.3';
const SHELL_CACHE = `${SW_VERSION}-shell`;
const RUNTIME_CACHE = `${SW_VERSION}-runtime`;
const API_CACHE = `${SW_VERSION}-api`;
const IMG_CACHE = `${SW_VERSION}-img`;

const OFFLINE_URL = '/offline.html';
const PRECACHE_URLS = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

// --------------------------------------------------------------
// Install — precache the offline shell.
// --------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Use { cache: 'reload' } so a stale browser HTTP cache doesn't poison precache.
      Promise.all(
        PRECACHE_URLS.map((u) =>
          cache.add(new Request(u, { cache: 'reload' })).catch(() => {
            // Best-effort precache; never block install on a single 404.
            console.warn('[sw] precache miss:', u);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// --------------------------------------------------------------
// Activate — purge old caches from previous SW versions.
// --------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(SW_VERSION))
          .map((k) => caches.delete(k))
      );
      // Enable navigation preload — fetches the network resource in
      // parallel with the SW boot so first-paint is faster.
      if (self.registration.navigationPreload) {
        try { await self.registration.navigationPreload.enable(); } catch {}
      }
      await self.clients.claim();
    })()
  );
});

// Allow page to nudge SW into immediate activation on update.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// --------------------------------------------------------------
// Helpers
// --------------------------------------------------------------
function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}
function isImageRequest(req, url) {
  if (req.destination === 'image') return true;
  return /\.(?:png|jpg|jpeg|gif|webp|svg|ico)$/i.test(url.pathname);
}
function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/_expo/static/') ||
    url.pathname.startsWith('/assets/') ||
    /\.(?:js|css|woff2?|ttf|otf)$/i.test(url.pathname)
  );
}
function isNavigationRequest(req) {
  return req.mode === 'navigate' || (req.method === 'GET' && req.headers.get('accept')?.includes('text/html'));
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  // Drop the oldest entries (FIFO — keys() returns insertion order).
  for (let i = 0; i < keys.length - maxEntries; i++) {
    await cache.delete(keys[i]);
  }
}

// --------------------------------------------------------------
// Fetch — main routing matrix.
// --------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Same-origin only — never intercept cross-origin (Firebase, Google APIs, etc.).
  if (url.origin !== self.location.origin) return;
  // Never cache non-GET.
  if (req.method !== 'GET') return;
  // Don't touch WebSocket upgrades (they show up as fetch with Upgrade header).
  if (req.headers.get('upgrade') === 'websocket') return;

  // ---- 1) HTML navigations ----
  if (isNavigationRequest(req)) {
    event.respondWith(handleNavigation(event));
    return;
  }

  // ---- 2) API GETs — stale-while-revalidate, 5min freshness ----
  if (isApiRequest(url)) {
    event.respondWith(handleApiGet(req));
    return;
  }

  // ---- 3) Images ----
  if (isImageRequest(req, url)) {
    event.respondWith(handleImage(req));
    return;
  }

  // ---- 4) Static bundles (JS/CSS/fonts) — cache-first, immutable URLs ----
  if (isStaticAsset(url)) {
    event.respondWith(handleStaticAsset(req));
    return;
  }

  // ---- 5) Default — network-first with cache fallback ----
  event.respondWith(handleDefault(req));
});

// --------------------------------------------------------------
// Strategy implementations
// --------------------------------------------------------------
async function handleNavigation(event) {
  const req = event.request;
  try {
    // navigationPreload gives us a response in parallel with SW startup.
    const preload = await event.preloadResponse;
    if (preload) {
      // Stash the latest HTML so the SPA shell stays fresh.
      const cache = await caches.open(SHELL_CACHE);
      cache.put('/', preload.clone()).catch(() => {});
      return preload;
    }
    const fresh = await fetch(req);
    const cache = await caches.open(SHELL_CACHE);
    cache.put('/', fresh.clone()).catch(() => {});
    return fresh;
  } catch (_err) {
    // Offline — serve the cached SPA shell so client-side routing still works.
    const cache = await caches.open(SHELL_CACHE);
    const shell = await cache.match('/') || await cache.match(OFFLINE_URL);
    return shell || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function handleApiGet(req) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((res) => {
      // Only cache successful 200s (skip 401/403/404/5xx).
      if (res && res.status === 200 && res.type !== 'opaque') {
        cache.put(req, res.clone()).catch(() => {});
        trimCache(API_CACHE, 60).catch(() => {});
      }
      return res;
    })
    .catch((err) => {
      if (cached) return cached;
      throw err;
    });
  // Return cached immediately if present — revalidate in background.
  return cached || networkPromise;
}

async function handleImage(req) {
  const cache = await caches.open(IMG_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.status === 200 || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(() => {});
      trimCache(IMG_CACHE, 80).catch(() => {});
    }
    return res;
  } catch {
    // Tiny transparent SVG fallback so broken images don't blow up the layout.
    return new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      { headers: { 'Content-Type': 'image/svg+xml' } }
    );
  }
}

async function handleStaticAsset(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.status === 200) {
    cache.put(req, res.clone()).catch(() => {});
  }
  return res;
}

async function handleDefault(req) {
  try {
    const res = await fetch(req);
    if (res && res.status === 200) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    throw new Error('Network error and no cache for: ' + req.url);
  }
}

// --------------------------------------------------------------
// Push (Web Push API) — fires when FCM delivers a payload to the
// page subscription. We surface a system notification with the
// QD Auctions branding and deep-link into the live lot on tap.
// --------------------------------------------------------------
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text() || '' }; }
  const data = payload.data || payload.notification || payload;
  const title = (payload.notification && payload.notification.title) || data.title || 'QD Auctions';
  const body  = (payload.notification && payload.notification.body)  || data.body  || 'You have a new update.';
  const auctionId = data.auction_id || data.auctionId;
  const url = auctionId ? `/lot/${auctionId}` : (data.url || '/auctions');

  const options = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || (auctionId ? `lot-${auctionId}` : 'qd-general'),
    renotify: !!data.renotify,
    data: { url, ...data },
    vibrate: [200, 100, 200],
    requireInteraction: !!data.requireInteraction,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clientsArr) {
      if ('focus' in c) {
        try { await c.focus(); } catch {}
        try { c.postMessage({ type: 'NAVIGATE', url: target }); } catch {}
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(target);
    }
  })());
});
