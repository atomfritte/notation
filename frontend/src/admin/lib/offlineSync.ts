// Per-space offline sync. Marking a space "available offline" pre-fetches its
// tree + every file into the Cache API; the service worker then serves those
// cached responses when the network is down (airplane mode), so the space can be
// browsed + read offline. A small localStorage registry tracks what's synced.
//
// Caches the tree, every file, and comments (space-wide + per-file). Bookmarks
// are already offline (localStorage). Audio comes in a later phase; forms are
// skipped (interactive, fetched separately).

import * as api from './api'

const REG_KEY = 'notation_offline_v1'
const cacheNameFor = (id: string) => `notation-offline-${id}`

export type OfflineEntry = {
  name: string; syncedAt: number; files: number; failed: number
  /** Paths that failed to cache (capped — `failed` is the true total). Optional
   *  so entries written before this field round-trip without migration. */
  failedPaths?: string[]
}
export type OfflineRegistry = Record<string, OfflineEntry>

export const offlineSupported = typeof caches !== 'undefined'

export function registry(): OfflineRegistry {
  try {
    return JSON.parse(localStorage.getItem(REG_KEY) || '{}') as OfflineRegistry
  } catch {
    return {}
  }
}

function saveRegistry(r: OfflineRegistry) {
  try { localStorage.setItem(REG_KEY, JSON.stringify(r)) } catch { /* quota */ }
}

export function isOffline(id: string): boolean {
  return !!registry()[id]
}

export function offlineInfo(id: string): OfflineEntry | undefined {
  return registry()[id]
}

// flattenFiles collects readable file paths from a tree — skipping directories
// and form folders (forms are fetched via /form/*, handled separately).
function flattenFiles(entries: api.Entry[], out: string[] = []): string[] {
  for (const e of entries) {
    if (e.is_dir) {
      if (!e.form && e.children) flattenFiles(e.children, out)
    } else {
      out.push(e.path)
    }
  }
  return out
}

// fetchAndCache fetches a same-origin URL and stores it, returning the response
// (so the caller can both cache AND read it) or null on any failure.
async function fetchAndCache(cache: Cache, url: string): Promise<Response | null> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) return null
    await cache.put(url, res.clone())
    return res
  } catch {
    return null
  }
}

const SYNC_CONCURRENCY = 6

/**
 * syncSpace pulls a space's tree + every file into its offline cache and records
 * it in the registry. onProgress fires with (done, total) for a UI bar. Files
 * are fetched in small parallel batches; entries no longer in the tree are
 * pruned; the registry records how many actually cached.
 */
export async function syncSpace(
  id: string,
  name: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ files: number; failed: number }> {
  if (!offlineSupported) throw new Error('offline storage isn’t available in this browser')
  const cache = await caches.open(cacheNameFor(id))

  const treeURL = `/api/admin/spaces/${encodeURIComponent(id)}/tree`
  const treeRes = await fetchAndCache(cache, treeURL)
  if (!treeRes) throw new Error('couldn’t fetch the space — are you online?')
  const tree = (await treeRes.json()) as api.Entry[]
  const files = flattenFiles(tree)

  // The space-wide comment list (sidebar) + each file's comments are cached too,
  // so comments are readable offline. Bookmarks already live in localStorage.
  await fetchAndCache(cache, api.allCommentsURL(id))

  // Track everything we want cached (absolute URLs) so we can prune the rest.
  const abs = (u: string) => new URL(u, location.origin).href
  const wanted = new Set([
    treeURL,
    api.allCommentsURL(id),
    ...files.flatMap(p => [api.fileURL(id, p), api.commentsURL(id, p)]),
  ].map(abs))

  let done = 0
  const failedPaths: string[] = []
  onProgress?.(0, files.length)
  for (let i = 0; i < files.length; i += SYNC_CONCURRENCY) {
    const batch = files.slice(i, i + SYNC_CONCURRENCY)
    const results = await Promise.all(batch.map(async (p) => {
      const [file] = await Promise.all([
        fetchAndCache(cache, api.fileURL(id, p)),
        fetchAndCache(cache, api.commentsURL(id, p)), // comments are optional — don't count as a failure
      ])
      return { p, ok: !!file }
    }))
    for (const r of results) {
      if (!r.ok) failedPaths.push(r.p)
      done++
    }
    onProgress?.(done, files.length)
  }
  const failed = failedPaths.length

  // Prune files that were removed server-side since the last sync.
  for (const req of await cache.keys()) {
    if (!wanted.has(req.url)) await cache.delete(req)
  }

  const synced = files.length - failed
  const r = registry()
  // Cap the stored list (it's JSON-persisted to localStorage); `failed` keeps the
  // true total so the "N failed" count stays accurate even when the list is clipped.
  r[id] = { name, syncedAt: Date.now(), files: synced, failed, failedPaths: failedPaths.slice(0, 50) }
  saveRegistry(r)
  return { files: synced, failed }
}

/** unsyncSpace drops a space's offline copy + its synthesised audio + registry
 *  entry — so removing a space removes ALL of its recordings (they're cached in a
 *  per-space audio cache, never shared with another space). */
export async function unsyncSpace(id: string): Promise<void> {
  if (offlineSupported) {
    try { await caches.delete(cacheNameFor(id)) } catch { /* ignore */ }
    try { await caches.delete(`notation-audio-${id}`) } catch { /* ignore */ }
  }
  const r = registry()
  delete r[id]
  saveRegistry(r)
}
