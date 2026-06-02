// In-memory file-content cache shared by the admin SpaceView and the share App.
//
// Why this exists: every time you open a page the viewer fetched its markdown
// over the network with no caching, so re-visiting a page — or just clicking
// around — paid a fresh round-trip each time. The variable latency is what made
// page switching feel "slow and inconsistent". This cache lets the viewer paint
// a page's text the instant it's opened (stale-while-revalidate): show the
// cached body immediately, then refresh from the server in the background.
//
// Paired with prefetchFile() — called on hover in the file tree / on link
// hover in the viewer — even a first visit is usually instant, because the
// content is already warm by the time the click lands.
//
// The cache is process-lifetime only (a plain Map, never persisted) and bounded
// by a small LRU so a huge Space can't grow it without limit. Both SPAs import
// it; keys are namespaced by caller (`a\0<space>\0<path>` / `s\0<token>\0<path>`)
// so admin and share never collide in the same browser.

export type CachedFile = { content: string; etag: string | null }

const MAX_ENTRIES = 80
const cache = new Map<string, CachedFile>()
const inflight = new Map<string, Promise<CachedFile>>()

export function getCachedFile(key: string): CachedFile | undefined {
  const hit = cache.get(key)
  // Touch on read so the LRU eviction below drops genuinely-cold entries.
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

export function setCachedFile(key: string, content: string, etag: string | null = null): void {
  cache.delete(key)
  cache.set(key, { content, etag })
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

export function clearCachedFile(key: string): void {
  cache.delete(key)
  inflight.delete(key)
}

/**
 * Best-effort warm of the cache. Deduped against both the cache (already warm →
 * no-op) and any in-flight fetch for the same key, so hovering a row repeatedly
 * fires at most one request. Errors are swallowed — a prefetch that fails just
 * means the real load will fetch normally. Never rejects.
 */
export function prefetchFile(key: string, fetcher: () => Promise<CachedFile>): void {
  if (cache.has(key) || inflight.has(key)) return
  const p = fetcher()
    .then(res => {
      setCachedFile(key, res.content, res.etag)
      inflight.delete(key)
      return res
    })
    .catch(err => {
      inflight.delete(key)
      throw err
    })
  inflight.set(key, p)
  void p.catch(() => {})
}
