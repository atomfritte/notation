// Per-space offline sync. Marking a space "available offline" pre-fetches its
// tree + every file into the Cache API; the service worker then serves those
// cached responses when the network is down (airplane mode), so the space can be
// browsed + read offline. A small localStorage registry tracks what's synced.
//
// Bookmarks are already offline (they live in localStorage). Comments + audio
// come in later phases. Forms are skipped (interactive, fetched separately).

import * as api from './api'

const REG_KEY = 'notation_offline_v1'
const cacheNameFor = (id: string) => `notation-offline-${id}`

export type OfflineEntry = { name: string; syncedAt: number; files: number; failed: number }
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

  // Track everything we want cached (absolute URLs) so we can prune the rest.
  const wanted = new Set([treeURL, ...files.map(p => api.fileURL(id, p))].map(u => new URL(u, location.origin).href))

  let done = 0
  let failed = 0
  onProgress?.(0, files.length)
  for (let i = 0; i < files.length; i += SYNC_CONCURRENCY) {
    const batch = files.slice(i, i + SYNC_CONCURRENCY)
    const results = await Promise.all(batch.map(p => fetchAndCache(cache, api.fileURL(id, p))))
    for (const r of results) {
      if (!r) failed++
      done++
    }
    onProgress?.(done, files.length)
  }

  // Prune files that were removed server-side since the last sync.
  for (const req of await cache.keys()) {
    if (!wanted.has(req.url)) await cache.delete(req)
  }

  const synced = files.length - failed
  const r = registry()
  r[id] = { name, syncedAt: Date.now(), files: synced, failed }
  saveRegistry(r)
  return { files: synced, failed }
}

/** unsyncSpace drops a space's offline copy + registry entry. */
export async function unsyncSpace(id: string): Promise<void> {
  if (offlineSupported) {
    try { await caches.delete(cacheNameFor(id)) } catch { /* ignore */ }
  }
  const r = registry()
  delete r[id]
  saveRegistry(r)
}
