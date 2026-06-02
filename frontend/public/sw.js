/*
 * notation service worker.
 *
 * Phase 1: make the app installable + work offline at the SHELL level, and cache
 * the immutable bits so repeat loads are instant and already-played read-aloud
 * audio is available offline:
 *   - hashed assets (/s/_assets/*, icons, fonts) → cache-first (immutable)
 *   - synthesised audio (/tts, deterministic + immutable URLs) → cache-first
 *   - navigations (the SPA HTML) → network-first, fall back to the cached shell
 *   - everything else (API data) → straight to network (Phase 2 adds opt-in
 *     per-space offline data sync)
 *
 * Bump VERSION to invalidate the shell/asset caches on deploy. Audio is content-
 * addressed, so it's kept across versions.
 */
const VERSION = 'v2'
const SHELL = 'notation-shell-' + VERSION
const AUDIO = 'notation-audio' // content-addressed; survives version bumps

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.add('/')).catch(() => {}),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k.startsWith('notation-shell-') && k !== SHELL)
          .map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/sw.js') return // let the browser manage the worker itself

  // Synthesised read-aloud audio — deterministic, immutable → cache-first.
  if (url.pathname.endsWith('/tts')) {
    event.respondWith(cacheFirst(AUDIO, req))
    return
  }
  // Hashed/static assets — immutable → cache-first.
  if (url.pathname.includes('/_assets/') || /\.(?:js|css|woff2?|png|svg|ico|webmanifest)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(SHELL, req))
    return
  }
  // SPA navigations → network-first, fall back to the cached admin shell.
  if (req.mode === 'navigate' && !url.pathname.startsWith('/s/')) {
    event.respondWith(networkFirst(SHELL, req))
    return
  }
  // Spaces list + identity → network-first (always fresh online) + cache, so the
  // app can still boot offline and show which spaces are available.
  if (url.pathname === '/api/admin/spaces' || url.pathname === '/api/admin/me') {
    event.respondWith(networkFirst(SHELL, req))
    return
  }
  // Per-space data (tree/files/…) → always fresh online; offline, serve from the
  // explicitly-synced offline cache if it's there. We never cache on success
  // here — offlineSync.ts owns those caches (opt-in per space, no bloat).
  if (url.pathname.startsWith('/api/admin/spaces/')) {
    event.respondWith(networkThenCache(req))
    return
  }
  // Otherwise: network only.
})

async function networkThenCache(req) {
  try {
    return await fetch(req)
  } catch (err) {
    return (await caches.match(req)) || Response.error()
  }
}

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(req)
  if (hit) return hit
  try {
    const res = await fetch(req)
    // Only cache FULL responses. <audio> sends Range requests → the server replies
    // 206 Partial Content (a Content-Range body); caching that under the bare URL
    // would serve a partial/protocol-wrong clip to later non-Range requests. The
    // vertonen/prefetch fetches send no Range → clean 200 → cached for offline.
    if (res.status === 200) cache.put(req, res.clone())
    return res
  } catch (err) {
    return hit || Response.error()
  }
}

async function networkFirst(cacheName, req) {
  const cache = await caches.open(cacheName)
  try {
    const res = await fetch(req)
    if (res.ok) cache.put(req, res.clone())
    return res
  } catch (err) {
    return (await cache.match(req)) || (await cache.match('/')) || Response.error()
  }
}
