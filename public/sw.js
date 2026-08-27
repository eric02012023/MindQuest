/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: public/sw.js
 * Purpose: Service worker for the installable (PWA) version of MindQuest.
 * Notes: Served from the site root by server.js so its scope covers every page.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * It never caches a page. Every HTML page in MindQuest is rendered for one
 * logged-in person — a student's billing page, a tutor's submissions list, an
 * admin's user table. A cached page would be replayed to whoever opens the app
 * next on that device, and would keep showing yesterday's figures. So HTML is
 * always fetched from the network, and the only thing kept for offline use is
 * a static "you are offline" page.
 *
 * It also stays out of the way of anything private or live:
 *   /uploads/   handouts and chat files, gated per user on the server
 *   /download/  the same, through the guarded download route
 *   /socket.io/ the live messaging and call signalling transport
 *   every POST  logins, payments, assessment submissions
 * Those requests are not intercepted at all, so they behave exactly as they do
 * in a normal browser tab.
 *
 * IF THIS WORKER EVER MISBEHAVES
 * ------------------------------
 * Bump CACHE_VERSION and deploy. `skipWaiting` + `clients.claim` below make the
 * new worker take over on the next page load, and `activate` deletes every
 * cache that is not the current one — so one deploy is the whole fix. A user
 * can also clear it by hand in the browser: DevTools > Application >
 * Service Workers > Unregister.
 */

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `mindquest-static-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline.html';

// Kept from the very first install so the offline page can still be shown when
// the network is gone before anything else has been visited.
const PRECACHE_URLS = [OFFLINE_URL, '/assets/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== STATIC_CACHE).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/**
 * Paths this worker is allowed to touch, and how.
 *
 * /css/ and /js/ are network-first: MindQuest ships stylesheets and scripts
 * under fixed names (no content hash in the filename), so a cache-first rule
 * would serve the previous deploy's CSS for one more load after every release —
 * the "my design change did not show up" class of bug. Network-first keeps them
 * always current when online and still works from cache when offline.
 *
 * /assets/ is stale-while-revalidate: the logo and the landing-page artwork are
 * the heavy files and they almost never change, so they are served instantly
 * from cache while a fresh copy is fetched for next time.
 */
const NETWORK_FIRST_PREFIXES = ['/css/', '/js/'];
const STALE_WHILE_REVALIDATE_PREFIXES = ['/assets/'];
const NEVER_HANDLE_PREFIXES = ['/uploads/', '/download/', '/socket.io/', '/webhook/'];

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Anything that changes state on the server is passed straight through.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Google Fonts and any other third party: not ours to cache.
  if (url.origin !== self.location.origin) return;

  if (NEVER_HANDLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  // A page load. Always the network; the offline page only if that fails.
  if (request.mode === 'navigate') {
    event.respondWith(networkOnlyWithOfflinePage(request));
    return;
  }

  if (NETWORK_FIRST_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (STALE_WHILE_REVALIDATE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(staleWhileRevalidate(request));
  }

  // Everything else falls through to the browser's own handling.
});

/**
 * Page loads. The request object is passed through untouched so it keeps the
 * session cookie a navigation normally carries — the server still decides who
 * is logged in and what they may see.
 */
async function networkOnlyWithOfflinePage(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cache = await caches.open(STATIC_CACHE);
    const offlinePage = await cache.match(OFFLINE_URL);
    return offlinePage || Response.error();
  }
}

async function networkFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const fromNetwork = fetch(request)
    .then((response) => {
      if (isCacheable(response)) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  return (await fromNetwork) || Response.error();
}

// `basic` means a same-origin response we are allowed to read. Opaque and error
// responses, and anything the server refused, are never stored.
function isCacheable(response) {
  return Boolean(response) && response.ok && response.type === 'basic';
}
