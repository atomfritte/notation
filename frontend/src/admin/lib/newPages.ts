import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Entry } from './api'

/**
 * New-page tracking for the sidebar tree: a page is "new" when it appeared in
 * the tree after this client last saw the space, and stays badged until it is
 * opened (or "mark all seen"). Form folders count as new when their submission
 * count grows, so incoming form entries are spottable too.
 *
 * The registry of seen paths lives in localStorage per space (admin) or per
 * share link — it's a per-device reading aid, never round-tripped to the
 * server. First visit on a device seeds the registry with the current tree so
 * a fresh browser doesn't badge every page at once.
 */

type Registry = {
  files: string[]
  // form folder path -> last seen submission count
  forms: Record<string, number>
}

type Snapshot = {
  files: string[]
  forms: Record<string, number>
}

function collectSnapshot(tree: Entry[]): Snapshot {
  const files: string[] = []
  const forms: Record<string, number> = {}
  const walk = (entries: Entry[]) => {
    for (const e of entries) {
      if (e.form) {
        forms[e.path] = e.entries ?? 0
      } else if (e.is_dir) {
        if (e.children) walk(e.children)
      } else {
        files.push(e.path)
      }
    }
  }
  walk(tree)
  return { files, forms }
}

function loadRegistry(key: string): Registry | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.files)) return null
    return { files: parsed.files, forms: parsed.forms ?? {} }
  } catch {
    return null
  }
}

function saveRegistry(key: string, reg: Registry) {
  try { localStorage.setItem(key, JSON.stringify(reg)) }
  catch { /* quota / private mode — badges just won't persist */ }
}

/** Pure diff: which current paths does the registry not know yet? Exported
 *  for tests. */
export function diffNewPaths(reg: Registry, snap: Snapshot): Set<string> {
  const known = new Set(reg.files)
  const out = new Set<string>()
  for (const f of snap.files) if (!known.has(f)) out.add(f)
  for (const [p, count] of Object.entries(snap.forms)) {
    const prev = reg.forms[p]
    if (prev === undefined || count > prev) out.add(p)
  }
  return out
}

/** Pure: registry after marking one path (file or form folder) seen. Also
 *  prunes registry entries whose path vanished from the tree, so renames and
 *  deletes don't accumulate. Exported for tests. */
export function registryMarkSeen(reg: Registry, path: string, snap: Snapshot): Registry {
  const live = new Set(snap.files)
  const files = reg.files.filter(f => live.has(f))
  if (live.has(path) && !files.includes(path)) files.push(path)
  const forms: Record<string, number> = {}
  for (const [p, prev] of Object.entries(reg.forms)) {
    if (p in snap.forms) forms[p] = prev
  }
  if (path in snap.forms) forms[path] = snap.forms[path]
  return { files, forms }
}

export function useNewPages(storageKey: string | null | undefined, tree: Entry[], currentFile: string) {
  const snapshot = useMemo(() => collectSnapshot(tree), [tree])
  const [reg, setReg] = useState<Registry | null>(() => (storageKey ? loadRegistry(storageKey) : null))

  // Re-load when the key changes (navigating between spaces reuses the view).
  useEffect(() => {
    setReg(storageKey ? loadRegistry(storageKey) : null)
  }, [storageKey])

  // First visit on this device: seed with the current tree — everything
  // counts as seen, badges only appear for pages that arrive afterwards.
  // Gated on a non-empty tree so the async-load empty state can't seed.
  useEffect(() => {
    if (!storageKey || reg !== null || tree.length === 0) return
    const seeded: Registry = { files: snapshot.files, forms: snapshot.forms }
    setReg(seeded)
    saveRegistry(storageKey, seeded)
  }, [storageKey, reg, tree.length, snapshot])

  const newPaths = useMemo(() => {
    if (!storageKey || !reg || tree.length === 0) return new Set<string>()
    return diffNewPaths(reg, snapshot)
  }, [storageKey, reg, snapshot, tree.length])

  // Opening a page marks it seen (covers tree clicks, palette, wiki-links,
  // prev/next — anything that changes the current file).
  useEffect(() => {
    if (!storageKey || !reg || !currentFile || !newPaths.has(currentFile)) return
    const next = registryMarkSeen(reg, currentFile, snapshot)
    setReg(next)
    saveRegistry(storageKey, next)
  }, [storageKey, reg, currentFile, newPaths, snapshot])

  const markAllSeen = useCallback(() => {
    if (!storageKey || tree.length === 0) return
    const all: Registry = { files: snapshot.files, forms: snapshot.forms }
    setReg(all)
    saveRegistry(storageKey, all)
  }, [storageKey, snapshot, tree.length])

  return { newPaths, markAllSeen }
}
