/**
 * folderSync — the manual, safe "local folder sync" engine for zero-knowledge
 * ENCRYPTED spaces.
 *
 * A local agent (e.g. Claude Code) can only work on PLAIN files in a real
 * directory, but the space's bytes live encrypted behind an {@link EncryptedFS}
 * whose key never leaves the browser. This module bridges the two with two
 * explicit, user-driven actions — never a live auto-sync:
 *
 *   - **Pull** ({@link pull}): decrypt every space file and write it into a
 *     user-picked local folder (the browser is the crypto authority; the server
 *     only ever holds ciphertext). Writes DECRYPTED plaintext to disk — that is
 *     the user's deliberate choice and the UI states it plainly.
 *   - **Push** ({@link preparePush} + {@link applyPush}): read the folder back,
 *     3-way diff it against the CURRENT space content AND the last-sync manifest,
 *     present a change preview, and — only on explicit confirm — re-encrypt the
 *     changes into the space. Deletions are opt-in and never silent.
 *
 * The **manifest** (`path -> contentHash`) captured at the last successful
 * pull/push is what makes the diff 3-way: it distinguishes "folder added a file"
 * from "space deleted a file", and flags a genuine conflict (both sides changed
 * the same path since the last sync). It is written into the folder as
 * {@link MANIFEST_FILENAME} so it is portable and survives across machines.
 *
 * Everything here operates over a minimal {@link SyncDirHandle} interface — the
 * exact subset of the File System Access API we use — so the engine is fully
 * unit-testable against an in-memory fake handle (the native picker can't be
 * automated). The real `FileSystemDirectoryHandle` structurally provides this
 * subset; the UI casts it at the boundary.
 */
import { EncryptedFS } from '../../shared/vfs/encfs'
import { listZipNodes } from './spaceZip'

// ── File System Access API subset ───────────────────────────────────────────
// We deliberately re-declare only what the engine touches so it stays decoupled
// from lib.dom's (partial) FS-Access typings and trivially fakeable in tests.

/** A writable stream over a single file (from `createWritable()`). */
export interface SyncWritable {
  write(data: BufferSource): Promise<void>
  close(): Promise<void>
}

/** A handle to one file. */
export interface SyncFileHandle {
  readonly kind: 'file'
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>
  createWritable(): Promise<SyncWritable>
}

/** A handle to one directory — the root the user picked, or a subdirectory. */
export interface SyncDirHandle {
  readonly kind: 'directory'
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<SyncDirHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<SyncFileHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  entries(): AsyncIterableIterator<[string, SyncFileHandle | SyncDirHandle]>
}

// ── manifest ─────────────────────────────────────────────────────────────────

/** The sync-state file written into the folder; also mirrored in IndexedDB. */
export const MANIFEST_FILENAME = '.notation-sync.json'

/** A `path -> sha256-hex` map captured at the last successful pull/push. */
export type ManifestEntries = Record<string, string>

export interface SyncManifest {
  version: 1
  updatedAt: string
  /** Logical path -> SHA-256 hex of the (decrypted) bytes at last sync. */
  entries: ManifestEntries
}

// ── ignore set ───────────────────────────────────────────────────────────────

/**
 * Paths the sync never touches, on BOTH sides (space and folder):
 *   - `.notation-sync.json` — our own manifest (dotfile, caught below).
 *   - any `node_modules/` — dependency scratch a local agent may create.
 *   - any dotfile / dot-directory (`.git/`, `.env`, …) — VCS + tool scratch,
 *     and it keeps a local `.git` safe from being overwritten on pull.
 *
 * Applied symmetrically so a file that would be ignored on read is also never
 * written on the other side (no half-synced dotfiles).
 */
export function isIgnored(path: string): boolean {
  const segs = path.split('/').filter(Boolean)
  if (segs.length === 0) return true
  for (const s of segs) {
    if (s === 'node_modules') return true
    if (s.startsWith('.')) return true // .git, .notation-sync.json, dotfiles
  }
  return false
}

// ── hashing ──────────────────────────────────────────────────────────────────

/** SHA-256 of bytes as lowercase hex — the content identity used for diffing. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  const view = new Uint8Array(digest)
  let out = ''
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0')
  return out
}

/** Hash a whole `path -> bytes` map into a manifest-shaped `path -> hash` map. */
export async function hashFiles(files: Map<string, Uint8Array>): Promise<ManifestEntries> {
  const out: ManifestEntries = {}
  for (const [path, bytes] of files) out[path] = await sha256Hex(bytes)
  return out
}

// ── space <-> folder byte collection ─────────────────────────────────────────

/**
 * Every visible, non-ignored FILE in the space as `path -> decrypted bytes`.
 * Reuses {@link listZipNodes}'s deterministic collection; directories are
 * skipped here (they carry no content) but recreated on pull for fidelity.
 */
export async function collectSpaceFiles(fs: EncryptedFS): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  for (const n of listZipNodes(fs)) {
    if (n.isDir || isIgnored(n.path)) continue
    out.set(n.path, await fs.read(n.path))
  }
  return out
}

/** Walk the folder recursively into `path -> bytes`, skipping the ignore set. */
export async function readFolderFiles(dir: SyncDirHandle): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  async function walk(handle: SyncDirHandle, prefix: string): Promise<void> {
    for await (const [name, child] of handle.entries()) {
      const path = prefix ? `${prefix}/${name}` : name
      if (isIgnored(path)) continue
      if (child.kind === 'directory') {
        await walk(child, path)
      } else {
        const file = await child.getFile()
        out.set(path, new Uint8Array(await file.arrayBuffer()))
      }
    }
  }
  await walk(dir, '')
  return out
}

// ── folder writes ────────────────────────────────────────────────────────────

/** Resolve (creating) the subdirectory chain `segs` under `root`. */
async function dirFor(root: SyncDirHandle, segs: string[]): Promise<SyncDirHandle> {
  let cur = root
  for (const s of segs) cur = await cur.getDirectoryHandle(s, { create: true })
  return cur
}

/** Ensure the directory at `path` exists in the folder (create parents). */
export async function ensureFolderDir(root: SyncDirHandle, path: string): Promise<void> {
  await dirFor(root, path.split('/').filter(Boolean))
}

/** Write `bytes` to `path` in the folder, creating any missing parent dirs. */
export async function writeFileTo(root: SyncDirHandle, path: string, bytes: Uint8Array): Promise<void> {
  const segs = path.split('/').filter(Boolean)
  const name = segs.pop()
  if (!name) throw new Error(`folderSync: cannot write to ${JSON.stringify(path)}`)
  const dir = await dirFor(root, segs)
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(bytes as unknown as BufferSource)
  await w.close()
}

// ── manifest IO ──────────────────────────────────────────────────────────────

/** Read `.notation-sync.json` from the folder, or `null` if absent/corrupt. */
export async function readManifestFile(dir: SyncDirHandle): Promise<SyncManifest | null> {
  try {
    const fh = await dir.getFileHandle(MANIFEST_FILENAME)
    const file = await fh.getFile()
    const text = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()))
    const parsed = JSON.parse(text) as SyncManifest
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/** Write the manifest into the folder as `.notation-sync.json`. */
export async function writeManifestFile(dir: SyncDirHandle, entries: ManifestEntries): Promise<SyncManifest> {
  const manifest: SyncManifest = { version: 1, updatedAt: new Date().toISOString(), entries }
  await writeFileTo(dir, MANIFEST_FILENAME, new TextEncoder().encode(JSON.stringify(manifest, null, 2)))
  return manifest
}

// ── pull ─────────────────────────────────────────────────────────────────────

export interface PullResult {
  /** Logical paths written (files only), in write order. */
  written: string[]
  /** Directories (incl. empty ones) recreated for structural fidelity. */
  dirs: string[]
  /** The manifest captured for this sync (also written to the folder). */
  manifest: SyncManifest
}

/**
 * Decrypt the whole space into the folder: write every file at its logical path
 * (creating subdirectories), recreate empty directories, and record the manifest
 * (`path -> hash`) both in the folder and in the returned result. Never deletes
 * anything already in the folder — a local agent's scratch files are preserved.
 */
export async function pull(fs: EncryptedFS, dir: SyncDirHandle): Promise<PullResult> {
  const written: string[] = []
  const dirs: string[] = []
  const entries: ManifestEntries = {}
  for (const n of listZipNodes(fs)) {
    if (isIgnored(n.path)) continue
    if (n.isDir) {
      await ensureFolderDir(dir, n.path)
      dirs.push(n.path)
      continue
    }
    const bytes = await fs.read(n.path)
    await writeFileTo(dir, n.path, bytes)
    entries[n.path] = await sha256Hex(bytes)
    written.push(n.path)
  }
  const manifest = await writeManifestFile(dir, entries)
  return { written, dirs, manifest }
}

// ── push: 3-way diff ─────────────────────────────────────────────────────────

export type PushKind = 'new' | 'modified' | 'deleted'

export interface PushEntry {
  path: string
  kind: PushKind
  /**
   * True when both sides diverged from the last-sync baseline (a real
   * conflict). For `new`/`modified` the resolution is folder-wins (surfaced, not
   * silent); for `deleted` it flags "folder removed a file the space had also
   * edited since the last sync".
   */
  conflict: boolean
}

export interface PushCounts {
  new: number
  modified: number
  deleted: number
  conflict: number
  unchanged: number
}

export interface PushPlan {
  entries: PushEntry[]
  counts: PushCounts
  /** Folder file set hashed (`path -> hash`) — the new baseline after apply. */
  folderManifest: ManifestEntries
}

/**
 * Classify every path across the space and folder against the last-sync manifest
 * into new / modified / deleted / unchanged, flagging conflicts. Pure over three
 * maps (space bytes, folder bytes, manifest) so it is exhaustively unit-testable
 * without any handle at all.
 *
 * Manifest-aware safety rules (stricter than a naive 2-way diff):
 *   - folder-has / space-lacks, and the folder byte matches the baseline → the
 *     space intentionally deleted it and the folder is stale → do NOT resurrect.
 *   - space-has / folder-lacks, but the path was NOT in the last sync → it was
 *     created in the browser after the pull → NOT a deletion candidate.
 *   - space-has / folder-lacks AND it was in the last sync → deletion candidate.
 */
export async function computePushPlan(
  spaceFiles: Map<string, Uint8Array>,
  folderFiles: Map<string, Uint8Array>,
  manifest: ManifestEntries,
): Promise<PushPlan> {
  const spaceHashes = await hashFiles(spaceFiles)
  const folderManifest = await hashFiles(folderFiles)

  const entries: PushEntry[] = []
  let unchanged = 0

  const allPaths = new Set<string>([...Object.keys(spaceHashes), ...Object.keys(folderManifest)])
  for (const path of allPaths) {
    const s = spaceHashes[path]
    const f = folderManifest[path]
    const base = manifest[path]

    if (f !== undefined && s === undefined) {
      // In folder, not in space.
      if (base !== undefined && base === f) continue // space deleted it; folder stale → respect deletion
      // A brand-new file, or the folder re-added/edited a space-deleted path.
      entries.push({ path, kind: 'new', conflict: base !== undefined && base !== f })
    } else if (f !== undefined && s !== undefined) {
      // In both.
      if (f === s) { unchanged++; continue }
      entries.push({ path, kind: 'modified', conflict: base !== undefined && s !== base && f !== base })
    } else {
      // In space, not in folder.
      if (base === undefined) continue // space-only file created after last sync → leave alone
      entries.push({ path, kind: 'deleted', conflict: s !== base }) // folder removed it; conflict if space also edited it
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path))
  const counts: PushCounts = {
    new: entries.filter((e) => e.kind === 'new').length,
    modified: entries.filter((e) => e.kind === 'modified').length,
    deleted: entries.filter((e) => e.kind === 'deleted').length,
    conflict: entries.filter((e) => e.conflict).length,
    unchanged,
  }
  return { entries, counts, folderManifest }
}

// ── push: prepare + apply ────────────────────────────────────────────────────

export interface PreparedPush {
  plan: PushPlan
  folderFiles: Map<string, Uint8Array>
  spaceFiles: Map<string, Uint8Array>
  /** Where the baseline manifest came from (drives a UI note when it's missing). */
  manifestSource: 'folder' | 'fallback' | 'none'
}

/**
 * Read the folder + its manifest, collect the current space content, and compute
 * the {@link PushPlan}. The manifest is the folder's `.notation-sync.json` when
 * present (it also catches out-of-band edits), else a caller-supplied fallback
 * (the IndexedDB copy), else empty. Nothing is mutated — this only previews.
 */
export async function preparePush(
  fs: EncryptedFS,
  dir: SyncDirHandle,
  fallbackManifest?: ManifestEntries,
): Promise<PreparedPush> {
  const folderFiles = await readFolderFiles(dir)
  const spaceFiles = await collectSpaceFiles(fs)
  const manifestFile = await readManifestFile(dir)

  let manifest: ManifestEntries
  let manifestSource: PreparedPush['manifestSource']
  if (manifestFile) {
    manifest = manifestFile.entries
    manifestSource = 'folder'
  } else if (fallbackManifest) {
    manifest = fallbackManifest
    manifestSource = 'fallback'
  } else {
    manifest = {}
    manifestSource = 'none'
  }

  const plan = await computePushPlan(spaceFiles, folderFiles, manifest)
  return { plan, folderFiles, spaceFiles, manifestSource }
}

export interface PushApplyResult {
  applied: { new: number; modified: number; deleted: number }
  /** Deletion candidates left in place because `applyDeletions` was off. */
  skippedDeletions: number
  /** The refreshed baseline manifest (also written back to the folder). */
  manifest: SyncManifest
}

/**
 * Apply a previewed {@link PreparedPush} to the space: re-encrypt every new /
 * modified file (folder-wins for conflicts), and — only when `applyDeletions` is
 * set — soft-delete the paths the folder dropped. Then {@link EncryptedFS.sync}
 * and refresh the manifest to the folder's file set (the agreed source of truth,
 * so deletion-not-applied and browser-only files never become false deletions on
 * the next push). Renames surface as delete+create with content preserved.
 */
export async function applyPush(
  fs: EncryptedFS,
  dir: SyncDirHandle,
  prepared: PreparedPush,
  opts: { applyDeletions: boolean },
): Promise<PushApplyResult> {
  const { plan, folderFiles } = prepared
  let nNew = 0
  let nMod = 0
  let nDel = 0
  let skippedDeletions = 0

  for (const e of plan.entries) {
    if (e.kind === 'new' || e.kind === 'modified') {
      const bytes = folderFiles.get(e.path)
      if (!bytes) continue
      await fs.write(e.path, bytes)
      if (e.kind === 'new') nNew++
      else nMod++
    } else {
      if (opts.applyDeletions) {
        await fs.remove(e.path)
        nDel++
      } else {
        skippedDeletions++
      }
    }
  }

  await fs.sync()
  const manifest = await writeManifestFile(dir, plan.folderManifest)
  return { applied: { new: nNew, modified: nMod, deleted: nDel }, skippedDeletions, manifest }
}
