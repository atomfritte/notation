import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Entry } from './api'

/**
 * New/edited-page tracking for the sidebar tree: a page is badged when it
 * appeared, OR changed, since this client last saw the space — so imports and
 * MCP/agent edits are both spottable. It stays badged until the page is opened
 * (or "mark all seen"). Form folders badge when their submission count grows.
 *
 * Edit detection compares a per-file SIGNATURE (server mtime + size). Encrypted
 * spaces have no signature (content edits overwrite the ciphertext blob without
 * touching the op-log/tree, so there's no cheap change signal) — they get
 * new-page badges only. MCP is sealed for encrypted spaces anyway, so the
 * edit-badge use case is inherently a plaintext one.
 *
 * The registry lives in localStorage per space (admin) / per share link — a
 * per-device reading aid, never round-tripped. First visit seeds from the
 * current tree so a fresh browser doesn't badge everything at once.
 *
 * Encrypted spaces pass a {@link NodeIdCodec} so the registry is PERSISTED by
 * opaque nodeId, never cleartext paths — otherwise a stolen browser profile
 * (without the key) could read the file structure from localStorage. In memory
 * the registry is always path-based; the codec only maps at the storage edge.
 */

/** Maps a logical path to its opaque nodeId and back, for encrypted spaces. */
export type NodeIdCodec = {
  encode: (path: string) => string | undefined
  decode: (id: string) => string | undefined
}

/** Per-file change signature (mtime|size); '' when unavailable (encrypted). */
type FileMap = Record<string, string>

type Registry = {
  files: FileMap
  // form folder path -> last seen submission count
  forms: Record<string, number>
}

type Snapshot = Registry

/** The change signature of a file — its server mtime + size. Empty for
 *  encrypted spaces (fsToEntries leaves modified/size blank), which disables
 *  edit detection there. */
function sigOf(e: Entry): string {
  return e.modified ? `${e.modified}|${e.size}` : ''
}

function collectSnapshot(tree: Entry[]): Snapshot {
  const files: FileMap = {}
  const forms: Record<string, number> = {}
  const walk = (entries: Entry[]) => {
    for (const e of entries) {
      if (e.form) {
        forms[e.path] = e.entries ?? 0
      } else if (e.is_dir) {
        if (e.children) walk(e.children)
      } else {
        files[e.path] = sigOf(e)
      }
    }
  }
  walk(tree)
  return { files, forms }
}

/** Exported for tests: reads the registry, decoding nodeIds → paths when a
 *  codec is given (encrypted spaces). Tolerates the legacy `files: string[]`
 *  format (no signatures) by treating every entry's signature as unknown (''),
 *  so nothing false-flags as edited right after the format change. */
export function loadRegistry(key: string, codec?: NodeIdCodec): Registry | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed) return null
    const rawFiles: FileMap | null = Array.isArray(parsed.files)
      ? Object.fromEntries((parsed.files as string[]).map((p) => [p, '']))
      : parsed.files && typeof parsed.files === 'object'
        ? (parsed.files as FileMap)
        : null
    if (!rawFiles) return null
    const rawForms: Record<string, number> = parsed.forms ?? {}
    if (!codec) return { files: rawFiles, forms: rawForms }
    // Encrypted: keys are nodeIds → resolve to paths, dropping any that no
    // longer exist in the tree.
    const files: FileMap = {}
    for (const [id, sig] of Object.entries(rawFiles)) { const p = codec.decode(id); if (p) files[p] = sig }
    const forms: Record<string, number> = {}
    for (const [id, count] of Object.entries(rawForms)) { const p = codec.decode(id); if (p) forms[p] = count as number }
    return { files, forms }
  } catch {
    return null
  }
}

/** Exported for tests: persists the registry, encoding paths → nodeIds when a
 *  codec is given (encrypted spaces), so no cleartext path lands in storage. */
export function saveRegistry(key: string, reg: Registry, codec?: NodeIdCodec) {
  try {
    let out: Registry = reg
    if (codec) {
      const files: FileMap = {}
      for (const [p, sig] of Object.entries(reg.files)) { const id = codec.encode(p); if (id) files[id] = sig }
      const forms: Record<string, number> = {}
      for (const [p, count] of Object.entries(reg.forms)) { const id = codec.encode(p); if (id) forms[id] = count }
      out = { files, forms }
    }
    localStorage.setItem(key, JSON.stringify(out))
  } catch { /* quota / private mode — badges just won't persist */ }
}

/** Pure diff: which current paths are NEW (unknown) or EDITED (known but the
 *  signature changed)? A signature change only counts when BOTH the remembered
 *  and current signatures are known (non-empty), so a legacy '' registry and
 *  encrypted spaces never false-flag edits. Exported for tests. */
export function diffNewPaths(reg: Registry, snap: Snapshot): Set<string> {
  const out = new Set<string>()
  for (const [p, sig] of Object.entries(snap.files)) {
    const prev = reg.files[p]
    if (prev === undefined) out.add(p) // new
    else if (prev && sig && prev !== sig) out.add(p) // edited
  }
  for (const [p, count] of Object.entries(snap.forms)) {
    const prev = reg.forms[p]
    if (prev === undefined || count > prev) out.add(p)
  }
  return out
}

/** Pure: registry after marking one path (file or form folder) seen — records
 *  its current signature so a later edit re-badges it. Also prunes registry
 *  entries whose path vanished from the tree. Exported for tests. */
export function registryMarkSeen(reg: Registry, path: string, snap: Snapshot): Registry {
  const files: FileMap = {}
  for (const [p, sig] of Object.entries(reg.files)) if (p in snap.files) files[p] = sig
  if (path in snap.files) files[path] = snap.files[path]
  const forms: Record<string, number> = {}
  for (const [p, prev] of Object.entries(reg.forms)) {
    if (p in snap.forms) forms[p] = prev
  }
  if (path in snap.forms) forms[path] = snap.forms[path]
  return { files, forms }
}

export function useNewPages(
  storageKey: string | null | undefined,
  tree: Entry[],
  currentFile: string,
  codec?: NodeIdCodec,
) {
  const snapshot = useMemo(() => collectSnapshot(tree), [tree])
  const [reg, setReg] = useState<Registry | null>(() => (storageKey ? loadRegistry(storageKey, codec) : null))

  // Re-load when the key changes (navigating between spaces reuses the view).
  useEffect(() => {
    setReg(storageKey ? loadRegistry(storageKey, codec) : null)
  }, [storageKey, codec])

  // First visit on this device: seed with the current tree — everything
  // counts as seen, badges only appear for pages that arrive afterwards.
  // Gated on a non-empty tree so the async-load empty state can't seed.
  useEffect(() => {
    if (!storageKey || reg !== null || tree.length === 0) return
    const seeded: Registry = { files: snapshot.files, forms: snapshot.forms }
    setReg(seeded)
    saveRegistry(storageKey, seeded, codec)
  }, [storageKey, reg, tree.length, snapshot, codec])

  // Backfill signatures for a registry that predates edit-detection (legacy
  // format, or an entry seeded before a signature was available): adopt the
  // current signature as "seen" so edit detection activates from the NEXT change
  // instead of false-flagging the current state. Fires at most once per gap.
  useEffect(() => {
    if (!storageKey || !reg || tree.length === 0) return
    let changed = false
    const files = { ...reg.files }
    for (const [p, sig] of Object.entries(snapshot.files)) {
      if (files[p] === '' && sig) { files[p] = sig; changed = true }
    }
    if (changed) {
      const next: Registry = { files, forms: reg.forms }
      setReg(next)
      saveRegistry(storageKey, next, codec)
    }
  }, [storageKey, reg, snapshot, tree.length, codec])

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
    saveRegistry(storageKey, next, codec)
  }, [storageKey, reg, currentFile, newPaths, snapshot, codec])

  const markAllSeen = useCallback(() => {
    if (!storageKey || tree.length === 0) return
    const all: Registry = { files: snapshot.files, forms: snapshot.forms }
    setReg(all)
    saveRegistry(storageKey, all, codec)
  }, [storageKey, snapshot, tree.length, codec])

  return { newPaths, markAllSeen }
}
