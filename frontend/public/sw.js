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
const VERSION = 'v1'
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
  // Otherwise: network only (API data; offline data sync is Phase 2).
})

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(req)
  if (hit) return hit
  try {
    const res = await fetch(req)
    if (res.ok) cache.put(req, res.clone())
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
