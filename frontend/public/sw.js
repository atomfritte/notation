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
// v3 also evicts any space/share FILE responses that the pre-fix asset rule
// mistakenly parked in the v2 shell cache (see the fetch handler).
const VERSION = 'v3'
const SHELL = 'notation-shell-' + VERSION

// Admin read-aloud audio is cached PER SPACE — never in one shared bucket — so a
// clip is strictly bound to its space: removed when that space's offline copy is
// removed (offlineSync.unsyncSpace) and never served for another space. Returns
// the per-space cache name for an admin /tts URL, else null. The id comes straight
// from the URL the client built from its canonical spaceID, so it matches the
// bucket the server scopes to + the one unsync deletes.
//
// Share (/s/api/<token>/tts) audio is intentionally NOT cached here: shares aren't
// an offline target, and per-token caches have no revoke/expiry cleanup hook — so
// share audio stays network-only and can't linger on a device past the share.
// True for anything served by the HTTP API (admin or share). Those responses
// are access-controlled per request and must never be answered from a shared,
// long-lived cache — only the explicit per-space offline caches may hold them.
function isApiPath(url) {
  return url.pathname.startsWith('/api/') || /^\/[^/]+\/api\//.test(url.pathname)
}

function audioCacheName(url) {
  const m = url.pathname.match(/^\/api\/admin\/spaces\/([^/]+)\/tts$/)
  return m ? 'notation-audio-' + decodeURIComponent(m[1]) : null
}

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
          // Old shell versions + the legacy single shared audio cache (audio is
          // now per-space; the old global bucket is orphaned + must not linger).
          .filter((k) => (k.startsWith('notation-shell-') && k !== SHELL) || k === 'notation-audio')
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

  // Synthesised read-aloud audio (admin) — deterministic, immutable → cache-first
  // into the per-space audio cache. Share /tts is network-only (see audioCacheName).
  const audioCache = audioCacheName(url)
  if (audioCache) {
    event.respondWith(cacheFirst(audioCache, req))
    return
  }
  // Hashed/static assets — immutable → cache-first.
  //
  // The extension test must NEVER see an API URL. A space file is addressed as
  // /api/admin/spaces/<id>/file/<path> (and /s/api/<token>/file/<path>), so a
  // plain `photos/plan.png` used to match here and land in the SHELL cache:
  // one bucket shared by every space and every share token, served cache-first
  // (i.e. WITHOUT re-checking authorization) and untouched by unsyncSpace, by
  // logout, and by share revocation. API paths are owned by the branches below.
  if (!isApiPath(url) &&
      (url.pathname.includes('/_assets/') || /\.(?:js|css|woff2?|png|svg|ico|webmanifest)$/.test(url.pathname))) {
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
