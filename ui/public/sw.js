// Service worker for the /admin PWA shell. Scope is implicitly /admin/ (a
// worker's max scope is the directory its own URL lives in, and this file
// is served at /admin/sw.js) -- it never sees, let alone caches, requests
// for the addon's own Stremio routes (/manifest.json, /stream/*, /meta/*)
// or anything outside /admin.
//
// Bump this on any change to the caching strategy below (not on every app
// release -- hashed asset filenames already bust themselves) so old
// clients drop stale cache entries instead of accumulating them forever.
const CACHE_VERSION = 'v1';
const SHELL_CACHE = `admin-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `admin-assets-${CACHE_VERSION}`;

const SHELL_URLS = ['/admin/', '/admin/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only ever handle same-origin GETs under /admin -- anything else (API
  // calls, the addon's own routes, cross-origin requests, non-GET
  // mutations) passes straight through to the network untouched. Admin
  // data (queue/library/health/feed) must never come from a cache.
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }
  if (!url.pathname.startsWith('/admin/')) {
    return;
  }

  // Vite's hashed build output (/admin/assets/*.js|css) -- the hash IS the
  // cache key, so a cache hit is always correct, not just fast. Falls back
  // to network for a cache miss (a fresh deploy's new hashed filenames) and
  // populates the cache for next time.
  if (url.pathname.startsWith('/admin/assets/')) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // Shell/document requests (/admin/, /admin/manifest.webmanifest, and the
  // SPA fallback for any other /admin/* path): network-first so an online
  // visit always gets the latest shell, falling back to the last cached
  // copy when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? caches.match('/admin/'))),
  );
});
