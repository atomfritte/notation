/**
 * folderSync — the manual, safe "local folder sync" engine, for ANY space
 * (zero-knowledge encrypted or plaintext).
 *
 * A local agent (e.g. Claude Code) can only work on PLAIN files in a real
 * directory. This module bridges a space and such a folder with two explicit,
 * user-driven actions — never a live auto-sync:
 *
 *   - **Pull** ({@link pull}): write every space file into a user-picked local
 *     folder. For an encrypted space that means DECRYPTING first (the browser is
 *     the crypto authority; the server only ever holds ciphertext) — plaintext
 *     lands on disk, which is the user's deliberate choice and the UI states it
 *     plainly.
 *   - **Push** ({@link preparePush} + {@link applyPush}): read the folder back,
 *     3-way diff it against the CURRENT space content AND the last-sync manifest,
 *     present a change preview, and — only on explicit confirm — write the
 *     changes into the space. Deletions are opt-in and never silent.
 *
 * Which space it talks to is entirely the {@link SyncSpace} port's business
 * ({@link ./syncSpace}): the encrypted backend en/decrypts in-page, the
 * plaintext one speaks the server's file API. The engine below is identical for
 * both.
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
import type { SyncSpace } from './syncSpace'
import { guideFiles, isGeneratedGuide, isGuideName, type GuideContext } from './spaceGuide'

/** Reports `done` of `total` units while a long pull/push walks the file set. */
export type ProgressFn = (done: number, total: number) => void

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
 * Every visible, non-ignored FILE in the space as `path -> bytes` (decrypted for
 * an encrypted space). Directories are skipped here (they carry no content) but
 * recreated on pull for fidelity.
 */
export async function collectSpaceFiles(space: SyncSpace, onProgress?: ProgressFn): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  const files = (await space.listNodes()).filter((n) => !n.isDir && !isIgnored(n.path))
  let done = 0
  for (const n of files) {
    out.set(n.path, await space.read(n.path))
    onProgress?.(++done, files.length)
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
  /**
   * Agent briefings dropped into the folder root ({@link guideFiles}). They are
   * tooling, never Space content: they stay out of the manifest and the push
   * strips them again.
   */
  guides: string[]
}

/** What a pull needs to know to write the agent briefing (see {@link ./spaceGuide}). */
export interface GuideOptions {
  /** Display name of the space, for the guide's heading. */
  spaceName: string
}

/**
 * Write the whole space into the folder: every file at its logical path
 * (creating subdirectories, decrypting first for an encrypted space), recreate
 * empty directories, and record the manifest (`path -> hash`) both in the folder
 * and in the returned result. Never deletes anything already in the folder — a
 * local agent's scratch files are preserved.
 *
 * When `guide` is given, the folder also gets `AGENTS.md` / `CLAUDE.md` telling
 * a local CLI agent what a notation Space is and how this folder round-trips —
 * but only for names the space doesn't itself use, so a real `AGENTS.md` page is
 * never clobbered. Omit `guide` to pull content only.
 */
export async function pull(
  space: SyncSpace,
  dir: SyncDirHandle,
  onProgress?: ProgressFn,
  guide?: GuideOptions,
): Promise<PullResult> {
  const written: string[] = []
  const dirs: string[] = []
  const entries: ManifestEntries = {}
  const nodes = (await space.listNodes()).filter((n) => !isIgnored(n.path))
  let done = 0
  for (const n of nodes) {
    if (n.isDir) {
      await ensureFolderDir(dir, n.path)
      dirs.push(n.path)
    } else {
      const bytes = await space.read(n.path)
      await writeFileTo(dir, n.path, bytes)
      entries[n.path] = await sha256Hex(bytes)
      written.push(n.path)
    }
    onProgress?.(++done, nodes.length)
  }
  const manifest = await writeManifestFile(dir, entries)

  const guides: string[] = []
  if (guide) {
    const ctx: GuideContext = {
      spaceName: guide.spaceName,
      encrypted: space.encrypted,
      formFolders: formFoldersOf(written),
      fileCount: written.length,
    }
    for (const g of guideFiles(ctx)) {
      // The space's own file at that path always wins — it was just written.
      if (entries[g.name] !== undefined) continue
      await writeFileTo(dir, g.name, new TextEncoder().encode(g.content))
      guides.push(g.name)
    }
  }
  return { written, dirs, manifest, guides }
}

/** Folders rendered as Forms — the ones holding a `_form.md` template. */
function formFoldersOf(paths: string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    if (!p.endsWith('/_form.md')) continue
    out.add(p.slice(0, -'/_form.md'.length))
  }
  return [...out].sort()
}

/**
 * Drop the briefings {@link pull} generated from the folder's file set, so a
 * push never carries them into the space. A guide only counts as ours when it
 * sits at the root under a {@link isGuideName} name, still carries the marker,
 * and the space doesn't have a file of its own at that path. Mutates
 * `folderFiles` and returns what it removed (for the UI note).
 */
export function stripGeneratedGuides(
  folderFiles: Map<string, Uint8Array>,
  spaceFiles: Map<string, Uint8Array>,
): string[] {
  const removed: string[] = []
  for (const [path, bytes] of folderFiles) {
    if (!isGuideName(path) || spaceFiles.has(path)) continue
    if (!isGeneratedGuide(bytes)) continue
    folderFiles.delete(path)
    removed.push(path)
  }
  return removed
}

// ── push: 3-way diff ─────────────────────────────────────────────────────────

export type PushKind = 'new' | 'modified' | 'deleted' | 'moved'

export interface PushEntry {
  path: string
  kind: PushKind
  /**
   * True when both sides diverged from the last-sync baseline (a real
   * conflict). For `new`/`modified`/`moved` the resolution is folder-wins
   * (surfaced, not silent); for `deleted` it flags "folder removed a file the
   * space had also edited since the last sync".
   */
  conflict: boolean
  /** `moved` only: the path in the space this file is moving away from. */
  from?: string
  /**
   * `moved` only: the folder's bytes differ from what the space currently holds
   * at {@link from}, so the move is followed by a content write (folder-wins).
   * False for a pure relocation.
   */
  edited?: boolean
}

export interface PushCounts {
  new: number
  modified: number
  deleted: number
  moved: number
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

  const moved = detectMoves(entries, spaceHashes, folderManifest, manifest)

  moved.sort((a, b) => a.path.localeCompare(b.path))
  entries.sort((a, b) => a.path.localeCompare(b.path))
  const all = [...moved, ...entries]
  const counts: PushCounts = {
    new: entries.filter((e) => e.kind === 'new').length,
    modified: entries.filter((e) => e.kind === 'modified').length,
    deleted: entries.filter((e) => e.kind === 'deleted').length,
    moved: moved.length,
    conflict: all.filter((e) => e.conflict).length,
    unchanged,
  }
  return { entries: all, counts, folderManifest }
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/**
 * Recognise renames/moves inside a computed diff and REPLACE the delete+create
 * pair they were classified as with a single `moved` entry.
 *
 * A folder has no notion of identity — moving a page there reaches us as "this
 * path vanished, that one appeared". Applied literally that destroys the page's
 * identity in the space: the old node (with its comments, reactions and, for a
 * plaintext space, its git history) is deleted and an unrelated new file appears
 * elsewhere. Every annotation on it then points at nothing. Recognising the pair
 * lets {@link applyPush} perform a real move instead, which keeps all of it.
 *
 * Two tiers, deliberately in this order:
 *   1. **identical content** — the strongest possible evidence; ambiguity inside
 *      one hash group is harmless (the bytes are the same either way) and is
 *      broken by preferring an unchanged filename, then by path order.
 *   2. **identical filename** — catches "moved AND edited", but only when it is
 *      unambiguous (exactly one candidate on each side), since a wrong guess
 *      here would move a file the user meant to keep.
 *
 * `entries` is mutated: paired `deleted`/`new` entries are removed from it.
 */
function detectMoves(
  entries: PushEntry[],
  spaceHashes: ManifestEntries,
  folderManifest: ManifestEntries,
  baseline: ManifestEntries,
): PushEntry[] {
  const dels = entries.filter((e) => e.kind === 'deleted').map((e) => e.path)
  const news = entries.filter((e) => e.kind === 'new').map((e) => e.path)
  if (dels.length === 0 || news.length === 0) return []

  const pairs: { from: string; to: string }[] = []
  const takenFrom = new Set<string>()
  const takenTo = new Set<string>()

  // ── tier 1: same content ──
  const byHash = new Map<string, { from: string[]; to: string[] }>()
  for (const p of dels) {
    const h = spaceHashes[p]
    if (!h) continue
    const g = byHash.get(h) ?? { from: [], to: [] }
    g.from.push(p)
    byHash.set(h, g)
  }
  for (const p of news) {
    const h = folderManifest[p]
    if (!h) continue
    const g = byHash.get(h)
    if (g) g.to.push(p)
  }
  for (const g of byHash.values()) {
    const from = [...g.from].sort()
    const to = [...g.to].sort()
    // Same name first — with several identical-content files, that is the
    // pairing a human would call the move.
    for (const f of from) {
      const i = to.findIndex((t) => basename(t) === basename(f))
      if (i === -1) continue
      pairs.push({ from: f, to: to[i] })
      takenFrom.add(f)
      takenTo.add(to.splice(i, 1)[0])
    }
    for (const f of from) {
      if (takenFrom.has(f)) continue
      const t = to.shift()
      if (!t) break
      pairs.push({ from: f, to: t })
      takenFrom.add(f)
      takenTo.add(t)
    }
  }

  // ── tier 2: same filename, changed content — only when unambiguous ──
  const restFrom = dels.filter((p) => !takenFrom.has(p))
  const restTo = news.filter((p) => !takenTo.has(p))
  for (const f of restFrom) {
    const matches = restTo.filter((t) => !takenTo.has(t) && basename(t) === basename(f))
    if (matches.length !== 1) continue
    const rivals = restFrom.filter((o) => !takenFrom.has(o) && basename(o) === basename(f))
    if (rivals.length !== 1) continue
    pairs.push({ from: f, to: matches[0] })
    takenFrom.add(f)
    takenTo.add(matches[0])
  }

  if (pairs.length === 0) return []

  // Drop the halves we just consumed; what's left is a genuine create/delete.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if ((e.kind === 'deleted' && takenFrom.has(e.path)) || (e.kind === 'new' && takenTo.has(e.path))) {
      entries.splice(i, 1)
    }
  }

  return pairs.map(({ from, to }) => {
    const base = baseline[from]
    return {
      path: to,
      kind: 'moved' as const,
      from,
      // The space may have moved on since the baseline; folder-wins, so the move
      // is followed by a write whenever the two sides don't already agree.
      edited: folderManifest[to] !== spaceHashes[from],
      conflict: base !== undefined && spaceHashes[from] !== base && folderManifest[to] !== base,
    }
  })
}

// ── push: prepare + apply ────────────────────────────────────────────────────

export interface PreparedPush {
  plan: PushPlan
  folderFiles: Map<string, Uint8Array>
  spaceFiles: Map<string, Uint8Array>
  /** Where the baseline manifest came from (drives a UI note when it's missing). */
  manifestSource: 'folder' | 'fallback' | 'none'
  /** Generated agent briefings held back from the diff ({@link stripGeneratedGuides}). */
  strippedGuides: string[]
}

/**
 * Read the folder + its manifest, collect the current space content, and compute
 * the {@link PushPlan}. The manifest is the folder's `.notation-sync.json` when
 * present (it also catches out-of-band edits), else a caller-supplied fallback
 * (the IndexedDB copy), else empty. Nothing is mutated — this only previews.
 */
export async function preparePush(
  space: SyncSpace,
  dir: SyncDirHandle,
  fallbackManifest?: ManifestEntries,
  onProgress?: ProgressFn,
): Promise<PreparedPush> {
  const folderFiles = await readFolderFiles(dir)
  const spaceFiles = await collectSpaceFiles(space, onProgress)
  // Our own AGENTS.md / CLAUDE.md briefing is tooling for the local agent, not
  // content — it must never travel back into the space.
  const strippedGuides = stripGeneratedGuides(folderFiles, spaceFiles)
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
  return { plan, folderFiles, spaceFiles, manifestSource, strippedGuides }
}

export interface PushApplyResult {
  applied: { new: number; modified: number; deleted: number; moved: number }
  /** Folders removed afterwards because they ended up holding nothing. */
  prunedDirs: string[]
  /** Deletion candidates left in place because `applyDeletions` was off. */
  skippedDeletions: number
  /** Paths actually written to / removed from the space (for cache eviction). */
  changedPaths: string[]
  /** Entries that threw (e.g. a rejected upload); the rest still applied. */
  failed: { path: string; error: string }[]
  /** The refreshed baseline manifest (also written back to the folder). */
  manifest: SyncManifest
}

/**
 * Apply a previewed {@link PreparedPush} to the space: relocate every recognised
 * move, write every new / modified file (folder-wins for conflicts), and — only
 * when `applyDeletions` is set — delete the paths the folder dropped. Then
 * {@link SyncSpace.flush}, drop any folder left holding nothing
 * ({@link SyncSpace.pruneEmptyDirs}), and refresh the manifest to the folder's
 * file set (the agreed source of truth, so deletion-not-applied and browser-only
 * files never become false deletions on the next push).
 *
 * Moves run FIRST and are a real {@link SyncSpace.move}, not delete+create: that
 * is what keeps a relocated page's identity — its comments, reactions and
 * history — instead of orphaning every annotation on it. They are not gated
 * behind `applyDeletions`, because a move removes nothing: the content is listed
 * in the preview with both of its paths and travels intact to the new one.
 *
 * One failing entry does NOT abort the push: a rejected write (over the server's
 * upload limit, a lost connection mid-batch) is collected into `failed` and its
 * path is dropped from the new baseline, so the very next push retries it
 * instead of mistaking it for already-synced.
 */
export async function applyPush(
  space: SyncSpace,
  dir: SyncDirHandle,
  prepared: PreparedPush,
  opts: { applyDeletions: boolean },
  onProgress?: ProgressFn,
): Promise<PushApplyResult> {
  const { plan, folderFiles } = prepared
  let nNew = 0
  let nMod = 0
  let nDel = 0
  let nMoved = 0
  let skippedDeletions = 0
  const changedPaths: string[] = []
  const failed: { path: string; error: string }[] = []
  let done = 0

  // Moves before writes: the source has to still be where the space thinks it
  // is when we relocate it.
  const ordered = [
    ...plan.entries.filter((e) => e.kind === 'moved'),
    ...plan.entries.filter((e) => e.kind !== 'moved'),
  ]

  for (const e of ordered) {
    try {
      if (e.kind === 'moved' && e.from) {
        await space.move(e.from, e.path)
        // The folder edited it on the way; folder-wins, same as `modified`.
        if (e.edited) {
          const bytes = folderFiles.get(e.path)
          if (bytes) await space.write(e.path, bytes)
        }
        changedPaths.push(e.from, e.path)
        nMoved++
      } else if (e.kind === 'new' || e.kind === 'modified') {
        const bytes = folderFiles.get(e.path)
        if (!bytes) continue
        await space.write(e.path, bytes)
        changedPaths.push(e.path)
        if (e.kind === 'new') nNew++
        else nMod++
      } else if (e.kind === 'deleted' && opts.applyDeletions) {
        await space.remove(e.path)
        changedPaths.push(e.path)
        nDel++
      } else {
        skippedDeletions++
      }
    } catch (err) {
      failed.push({ path: e.path, error: String((err as Error)?.message ?? err) })
    }
    onProgress?.(++done, plan.entries.length)
  }

  await space.flush()

  // Folders the push emptied (or that never had anything the folder knows
  // about) would otherwise linger in the tree as clutter the user never made.
  // Best-effort: a failure here must not fail an otherwise-applied push.
  let prunedDirs: string[] = []
  try {
    prunedDirs = await space.pruneEmptyDirs()
  } catch (err) {
    failed.push({ path: '(empty folders)', error: String((err as Error)?.message ?? err) })
  }
  // A failed path must not enter the baseline as "synced" — drop it so the next
  // diff still sees it as new/modified.
  const nextManifest = { ...plan.folderManifest }
  for (const f of failed) delete nextManifest[f.path]
  const manifest = await writeManifestFile(dir, nextManifest)
  return {
    applied: { new: nNew, modified: nMod, deleted: nDel, moved: nMoved },
    prunedDirs,
    skippedDeletions,
    changedPaths,
    failed,
    manifest,
  }
}
