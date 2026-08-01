import { describe, expect, it } from 'vitest'
import { generateDEK, importContentKey } from '../../shared/crypto/keys'
import { InMemoryEncStore } from '../../shared/vfs/encStore'
import { EncryptedFS } from '../../shared/vfs/encfs'
import { encryptedSyncSpace, plaintextSyncSpace, type PlaintextTransport } from './syncSpace'
import type * as api from './api'
import {
  applyPush,
  computePushPlan,
  MANIFEST_FILENAME,
  preparePush,
  pull,
  readFolderFiles,
  readManifestFile,
  sha256Hex,
  writeFileTo,
  type SyncDirHandle,
  type SyncFileHandle,
  type SyncWritable,
} from './folderSync'

// ─── helpers ─────────────────────────────────────────────────────────────────

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)
const newFs = async (): Promise<EncryptedFS> =>
  EncryptedFS.open(new InMemoryEncStore(), await importContentKey(generateDEK()), 'A')
// The engine speaks the SyncSpace port; these tests drive its encrypted backend
// (a separate suite covers the plaintext one against a fake transport).
const space = encryptedSyncSpace

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ─── in-memory fake File System Access handle ────────────────────────────────
// The native showDirectoryPicker dialog can't be automated, so the engine is
// verified against this faithful in-memory implementation of the exact subset it
// uses. It structurally satisfies SyncDirHandle.

const notFound = (): Error => Object.assign(new Error('NotFound'), { name: 'NotFoundError' })

class FakeFileHandle implements SyncFileHandle {
  readonly kind = 'file' as const
  bytes = new Uint8Array(0)
  async getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    const snapshot = this.bytes.slice()
    return { arrayBuffer: async () => snapshot.buffer }
  }
  async createWritable(): Promise<SyncWritable> {
    const chunks: Uint8Array[] = []
    const self = this
    return {
      async write(data: BufferSource) {
        const u8 =
          data instanceof Uint8Array
            ? data.slice()
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
              : new Uint8Array((data as ArrayBuffer).slice(0))
        chunks.push(u8)
      },
      async close() {
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const out = new Uint8Array(total)
        let off = 0
        for (const c of chunks) {
          out.set(c, off)
          off += c.length
        }
        self.bytes = out
      },
    }
  }
}

class FakeDirHandle implements SyncDirHandle {
  readonly kind = 'directory' as const
  children = new Map<string, FakeFileHandle | FakeDirHandle>()

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<SyncDirHandle> {
    const ex = this.children.get(name)
    if (ex) {
      if (ex.kind !== 'directory') throw new Error(`not a directory: ${name}`)
      return ex
    }
    if (!options?.create) throw notFound()
    const d = new FakeDirHandle()
    this.children.set(name, d)
    return d
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<SyncFileHandle> {
    const ex = this.children.get(name)
    if (ex) {
      if (ex.kind !== 'file') throw new Error(`not a file: ${name}`)
      return ex
    }
    if (!options?.create) throw notFound()
    const f = new FakeFileHandle()
    this.children.set(name, f)
    return f
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const ex = this.children.get(name)
    if (!ex) throw notFound()
    if (ex.kind === 'directory' && ex.children.size > 0 && !options?.recursive) {
      throw new Error(`directory not empty: ${name}`)
    }
    this.children.delete(name)
  }

  async *entries(): AsyncIterableIterator<[string, SyncFileHandle | SyncDirHandle]> {
    for (const [k, v] of this.children) yield [k, v]
  }
}

/** Read one file's bytes from the fake folder by logical path, or undefined. */
async function folderRead(root: FakeDirHandle, path: string): Promise<Uint8Array | undefined> {
  const files = await readFolderFiles(root)
  return files.get(path)
}

// ─── pull ────────────────────────────────────────────────────────────────────

describe('folderSync.pull', () => {
  it('writes every space file (nested + binary) byte-identically and skips the ignore set', async () => {
    const fs = await newFs()
    await fs.write('readme.md', enc('# Top\n\nhello'))
    await fs.write('docs/intro.md', enc('# Intro\n\nnested'))
    await fs.write('docs/guides/setup.md', enc('# Setup\n\ndeep'))
    const binary = new Uint8Array(256)
    for (let i = 0; i < 256; i++) binary[i] = i
    await fs.write('assets/logo.bin', binary)
    // A dotfile in the space must be ignored on pull.
    await fs.write('.secret.txt', enc('should not be exported'))

    const dir = new FakeDirHandle()
    const res = await pull(space(fs), dir)

    expect(res.written.sort()).toEqual(['assets/logo.bin', 'docs/guides/setup.md', 'docs/intro.md', 'readme.md'])
    expect(res.written).not.toContain('.secret.txt')

    expect(dec((await folderRead(dir, 'readme.md'))!)).toBe('# Top\n\nhello')
    expect(dec((await folderRead(dir, 'docs/intro.md'))!)).toBe('# Intro\n\nnested')
    expect(dec((await folderRead(dir, 'docs/guides/setup.md'))!)).toBe('# Setup\n\ndeep')
    expect(bytesEqual((await folderRead(dir, 'assets/logo.bin'))!, binary)).toBe(true)
    expect(await folderRead(dir, '.secret.txt')).toBeUndefined()
  })

  it('writes a portable manifest into the folder that round-trips', async () => {
    const fs = await newFs()
    await fs.write('a.md', enc('alpha'))
    await fs.write('nested/b.md', enc('beta'))

    const dir = new FakeDirHandle()
    const res = await pull(space(fs), dir)

    const onDisk = await readManifestFile(dir)
    expect(onDisk).not.toBeNull()
    expect(onDisk!.version).toBe(1)
    expect(onDisk!.entries).toEqual(res.manifest.entries)
    // The manifest hashes are the real SHA-256 of the decrypted bytes.
    expect(onDisk!.entries['a.md']).toBe(await sha256Hex(enc('alpha')))
    expect(onDisk!.entries['nested/b.md']).toBe(await sha256Hex(enc('beta')))
    // The manifest file itself is a dotfile and never counts as a folder file.
    expect((await readFolderFiles(dir)).has(MANIFEST_FILENAME)).toBe(false)
  })

  it('preserves scratch files already in the folder (never deletes extras)', async () => {
    const fs = await newFs()
    await fs.write('page.md', enc('content'))

    const dir = new FakeDirHandle()
    await writeFileTo(dir, 'scratch.txt', enc('agent scratch'))
    await pull(space(fs), dir)

    expect(dec((await folderRead(dir, 'scratch.txt'))!)).toBe('agent scratch')
    expect(dec((await folderRead(dir, 'page.md'))!)).toBe('content')
  })
})

// ─── push: classification (pure, over maps) ──────────────────────────────────

describe('folderSync.computePushPlan', () => {
  const m = (obj: Record<string, string>): Map<string, Uint8Array> => {
    const map = new Map<string, Uint8Array>()
    for (const [k, v] of Object.entries(obj)) map.set(k, enc(v))
    return map
  }

  it('classifies new / modified / unchanged / deleted against the manifest', async () => {
    const space = m({ 'keep.md': 'same', 'edit.md': 'space-old', 'gone.md': 'was-here' })
    const folder = m({ 'keep.md': 'same', 'edit.md': 'folder-new', 'fresh.md': 'brand new' })
    const manifest = {
      'keep.md': await sha256Hex(enc('same')),
      'edit.md': await sha256Hex(enc('space-old')),
      'gone.md': await sha256Hex(enc('was-here')),
    }

    const plan = await computePushPlan(space, folder, manifest)
    const byPath = Object.fromEntries(plan.entries.map((e) => [e.path, e.kind]))

    expect(byPath['fresh.md']).toBe('new') // folder-only, not in manifest
    expect(byPath['edit.md']).toBe('modified') // differs from space bytes
    expect(byPath['gone.md']).toBe('deleted') // was synced, now absent from folder
    expect(byPath['keep.md']).toBeUndefined() // unchanged → skipped
    expect(plan.counts).toMatchObject({ new: 1, modified: 1, deleted: 1, unchanged: 1 })
  })

  it('flags a 3-way conflict when both sides changed the same path since last sync', async () => {
    const base = await sha256Hex(enc('original'))
    const space = m({ 'doc.md': 'space edited' })
    const folder = m({ 'doc.md': 'folder edited' })
    const plan = await computePushPlan(space, folder, { 'doc.md': base })

    const entry = plan.entries.find((e) => e.path === 'doc.md')!
    expect(entry.kind).toBe('modified')
    expect(entry.conflict).toBe(true)
    expect(plan.counts.conflict).toBe(1)
  })

  it('does not resurrect a space-deleted file when the folder copy is unchanged', async () => {
    const base = await sha256Hex(enc('stale'))
    const plan = await computePushPlan(m({}), m({ 'x.md': 'stale' }), { 'x.md': base })
    expect(plan.entries).toHaveLength(0) // folder is stale → respect the space deletion
  })

  it('never proposes deleting a browser-created file absent from the folder', async () => {
    // In space, not in folder, NOT in the last-sync manifest → leave alone.
    const plan = await computePushPlan(m({ 'new-in-browser.md': 'x' }), m({}), {})
    expect(plan.entries).toHaveLength(0)
  })
})

// ─── push: prepare + apply (against the fake handle) ─────────────────────────

async function pulled(): Promise<{ fs: EncryptedFS; dir: FakeDirHandle }> {
  const fs = await newFs()
  await fs.write('readme.md', enc('# Readme\n\nhello'))
  await fs.write('docs/guide.md', enc('# Guide\n\nsteps'))
  const binary = new Uint8Array(256)
  for (let i = 0; i < 256; i++) binary[i] = 255 - i
  await fs.write('img/pic.bin', binary)
  const dir = new FakeDirHandle()
  await pull(space(fs), dir)
  return { fs, dir }
}

describe('folderSync push', () => {
  it('adds a new folder file into the space (decrypts back correctly)', async () => {
    const { fs, dir } = await pulled()
    await writeFileTo(dir, 'notes/added.md', enc('# Added by agent'))

    const prepared = await preparePush(space(fs), dir)
    expect(prepared.plan.counts.new).toBe(1)
    expect(prepared.plan.entries.find((e) => e.path === 'notes/added.md')?.kind).toBe('new')

    const res = await applyPush(space(fs), dir, prepared, { applyDeletions: false })
    expect(res.applied.new).toBe(1)
    expect(dec(await fs.read('notes/added.md'))).toBe('# Added by agent')
  })

  it('updates space content for a modified folder file (reuses the node, no new op)', async () => {
    const { fs, dir } = await pulled()
    const store = (fs as unknown as { store: InMemoryEncStore }).store
    const before = store.opCount()
    await writeFileTo(dir, 'readme.md', enc('# Readme\n\nEDITED locally'))

    const prepared = await preparePush(space(fs), dir)
    expect(prepared.plan.counts.modified).toBe(1)
    const res = await applyPush(space(fs), dir, prepared, { applyDeletions: false })

    expect(res.applied.modified).toBe(1)
    expect(dec(await fs.read('readme.md'))).toBe('# Readme\n\nEDITED locally')
    // A content overwrite reuses the blobId and appends NO structural op.
    expect(store.opCount()).toBe(before)
  })

  it('shows a deletion candidate but keeps it unless deletions are opted in', async () => {
    const { fs, dir } = await pulled()
    await dir.getDirectoryHandle('docs').then((d) => d.removeEntry('guide.md'))

    const prepared = await preparePush(space(fs), dir)
    expect(prepared.plan.counts.deleted).toBe(1)
    expect(prepared.plan.entries.find((e) => e.path === 'docs/guide.md')?.kind).toBe('deleted')

    // Deletions OFF: the space file survives.
    const kept = await applyPush(space(fs), dir, prepared, { applyDeletions: false })
    expect(kept.skippedDeletions).toBe(1)
    expect(kept.applied.deleted).toBe(0)
    expect(dec(await fs.read('docs/guide.md'))).toBe('# Guide\n\nsteps')

    // Deletions ON (same previewed plan): now it is removed from the space.
    const removed = await applyPush(space(fs), dir, prepared, { applyDeletions: true })
    expect(removed.applied.deleted).toBe(1)
    expect(fs.resolve('docs/guide.md')).toBeUndefined()
  })

  it('is a clean no-op when nothing changed (no spurious ops)', async () => {
    const { fs, dir } = await pulled()
    const store = (fs as unknown as { store: InMemoryEncStore }).store
    const before = store.opCount()

    const prepared = await preparePush(space(fs), dir)
    expect(prepared.plan.entries).toHaveLength(0)
    const res = await applyPush(space(fs), dir, prepared, { applyDeletions: false })

    expect(res.applied).toEqual({ new: 0, modified: 0, deleted: 0, moved: 0 })
    expect(store.opCount()).toBe(before)
  })

  it('skips ignored folder entries (.git, node_modules) on push', async () => {
    const { fs, dir } = await pulled()
    await writeFileTo(dir, '.git/config', enc('[core]'))
    await writeFileTo(dir, 'node_modules/pkg/index.js', enc('module.exports = {}'))
    await writeFileTo(dir, 'legit.md', enc('# Legit'))

    const prepared = await preparePush(space(fs), dir)
    const paths = prepared.plan.entries.map((e) => e.path)
    expect(paths).toContain('legit.md')
    expect(paths).not.toContain('.git/config')
    expect(paths).not.toContain('node_modules/pkg/index.js')

    await applyPush(space(fs), dir, prepared, { applyDeletions: false })
    expect(fs.resolve('.git/config')).toBeUndefined()
    expect(fs.resolve('node_modules/pkg/index.js')).toBeUndefined()
  })

  it('round-trips: pull → edit a file in the folder → push → space matches, binary intact', async () => {
    const { fs, dir } = await pulled()
    const originalBinary = await fs.read('img/pic.bin')

    // Simulate a local agent editing one markdown file.
    await writeFileTo(dir, 'docs/guide.md', enc('# Guide\n\nrewritten by Claude Code'))

    const prepared = await preparePush(space(fs), dir)
    await applyPush(space(fs), dir, prepared, { applyDeletions: false })

    expect(dec(await fs.read('docs/guide.md'))).toBe('# Guide\n\nrewritten by Claude Code')
    // Untouched files (incl. the binary) are byte-for-byte intact.
    expect(dec(await fs.read('readme.md'))).toBe('# Readme\n\nhello')
    expect(bytesEqual(await fs.read('img/pic.bin'), originalBinary)).toBe(true)

    // A second push with no further edits is a clean no-op.
    const again = await preparePush(space(fs), dir)
    expect(again.plan.entries).toHaveLength(0)
  })

  it('uses the fallback manifest when the folder has no .notation-sync.json', async () => {
    const fs = await newFs()
    await fs.write('doc.md', enc('v1'))
    const dir = new FakeDirHandle()
    // Populate the folder WITHOUT a manifest (as if it were copied elsewhere).
    await writeFileTo(dir, 'doc.md', enc('v2'))

    const noBaseline = await preparePush(space(fs), dir)
    expect(noBaseline.manifestSource).toBe('none')

    const withFallback = await preparePush(space(fs), dir, { 'doc.md': await sha256Hex(enc('v1')) })
    expect(withFallback.manifestSource).toBe('fallback')
    // With the baseline, the divergence is a plain folder-wins modification.
    expect(withFallback.plan.entries.find((e) => e.path === 'doc.md')?.kind).toBe('modified')
  })
})

// ─── the plaintext backend ───────────────────────────────────────────────────
// A plaintext space is reached over HTTP, so the transport is faked: an
// in-memory file map that answers the same five calls the real one does. This
// proves the engine is genuinely backend-agnostic — the identical pull/diff/push
// loop runs against the server API with no encryption involved.

class FakePlaintextTransport implements PlaintextTransport {
  files = new Map<string, Uint8Array>()
  /** Directories that exist with no file in them (only the tree reports these). */
  emptyDirs = new Set<string>()
  /** Paths whose write must fail, simulating e.g. an over-the-limit upload. */
  rejectWrites = new Set<string>()
  reads = 0

  set(path: string, bytes: Uint8Array): void { this.files.set(path, bytes.slice()) }

  async listFiles(): Promise<string[]> { return [...this.files.keys()] }

  /** Mirrors the server: a directory with no files under it disappears. */
  async pruneEmptyDirs(): Promise<string[]> {
    const removed: string[] = []
    for (const d of [...this.emptyDirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
      if (![...this.files.keys()].some(f => f.startsWith(d + '/'))) {
        this.emptyDirs.delete(d)
        removed.push(d)
      }
    }
    return removed
  }

  /** Rebuild the recursive tree the server would return (dirs + files). */
  async listTree(): Promise<api.Entry[]> {
    const roots: api.Entry[] = []
    const dirs = new Map<string, api.Entry>()
    const dirFor = (path: string): api.Entry => {
      const existing = dirs.get(path)
      if (existing) return existing
      const segs = path.split('/')
      const entry: api.Entry = {
        name: segs[segs.length - 1], path, is_dir: true, size: 0, modified: '', children: [],
      }
      dirs.set(path, entry)
      if (segs.length === 1) roots.push(entry)
      else dirFor(segs.slice(0, -1).join('/')).children!.push(entry)
      return entry
    }
    for (const d of this.emptyDirs) dirFor(d)
    for (const [path, bytes] of this.files) {
      const segs = path.split('/')
      const entry: api.Entry = {
        name: segs[segs.length - 1], path, is_dir: false, size: bytes.length, modified: '',
      }
      if (segs.length === 1) roots.push(entry)
      else dirFor(segs.slice(0, -1).join('/')).children!.push(entry)
    }
    return roots
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const b = this.files.get(path)
    if (!b) throw new Error(`404 ${path}`)
    this.reads++
    return b.slice()
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    if (this.rejectWrites.has(path)) throw new Error('file too big')
    this.files.set(path, bytes.slice())
  }

  /** Mirrors the server's rename: same bytes, new path, nothing else touched. */
  async renamePath(from: string, to: string): Promise<void> {
    const b = this.files.get(from)
    if (!b) throw new Error(`404 ${from}`)
    this.files.delete(from)
    this.files.set(to, b)
    this.renames.push(`${from} -> ${to}`)
  }

  renames: string[] = []

  async deleteFile(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`404 ${path}`)
  }
}

describe('folderSync over a plaintext space', () => {
  it('pulls the whole space (nested, binary, empty dirs) into the folder', async () => {
    const t = new FakePlaintextTransport()
    t.set('readme.md', enc('# Readme'))
    t.set('docs/guide.md', enc('# Guide'))
    const binary = new Uint8Array([0, 1, 255, 254, 66, 0, 153, 127])
    t.set('img/pic.bin', binary)
    t.emptyDirs.add('empty')
    const sp = plaintextSyncSpace(t)

    const dir = new FakeDirHandle()
    const res = await pull(sp, dir)

    expect(res.written.sort()).toEqual(['docs/guide.md', 'img/pic.bin', 'readme.md'])
    expect(res.dirs).toContain('empty')
    expect(dec((await folderRead(dir, 'docs/guide.md'))!)).toBe('# Guide')
    expect(bytesEqual((await folderRead(dir, 'img/pic.bin'))!, binary)).toBe(true)
    // The empty directory survived the round-trip as a real folder.
    expect((dir.children.get('empty') as FakeDirHandle).kind).toBe('directory')
  })

  it('round-trips add / modify / delete back into the space', async () => {
    const t = new FakePlaintextTransport()
    t.set('readme.md', enc('# Readme'))
    t.set('docs/guide.md', enc('# Guide'))
    t.set('stale.md', enc('remove me'))
    const sp = plaintextSyncSpace(t)

    const dir = new FakeDirHandle()
    await pull(sp, dir)

    // A local agent edits, adds and removes files in the folder.
    await writeFileTo(dir, 'docs/guide.md', enc('# Guide v2'))
    await writeFileTo(dir, 'notes/new.md', enc('# Fresh'))
    await dir.removeEntry('stale.md')

    const prepared = await preparePush(sp, dir)
    expect(prepared.plan.counts).toMatchObject({ new: 1, modified: 1, deleted: 1, conflict: 0 })

    const res = await applyPush(sp, dir, prepared, { applyDeletions: true })
    expect(res.applied).toEqual({ new: 1, modified: 1, deleted: 1, moved: 0 })
    expect(res.failed).toEqual([])
    expect(res.changedPaths.sort()).toEqual(['docs/guide.md', 'notes/new.md', 'stale.md'])
    expect(dec(t.files.get('docs/guide.md')!)).toBe('# Guide v2')
    expect(dec(t.files.get('notes/new.md')!)).toBe('# Fresh')
    expect(t.files.has('stale.md')).toBe(false)

    // The baseline is refreshed, so an immediate second push is a no-op.
    const again = await preparePush(sp, dir)
    expect(again.plan.entries).toHaveLength(0)
  })

  it('keeps a rejected write out of the baseline so the next push retries it', async () => {
    const t = new FakePlaintextTransport()
    t.set('readme.md', enc('# Readme'))
    const sp = plaintextSyncSpace(t)
    const dir = new FakeDirHandle()
    await pull(sp, dir)

    await writeFileTo(dir, 'readme.md', enc('# Readme v2'))
    await writeFileTo(dir, 'huge.bin', enc('too big for the server'))
    t.rejectWrites.add('huge.bin')

    const res = await applyPush(sp, dir, await preparePush(sp, dir), { applyDeletions: false })
    // The healthy file still applied; only the rejected one is reported.
    expect(res.applied.modified).toBe(1)
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].path).toBe('huge.bin')
    expect(res.manifest.entries['huge.bin']).toBeUndefined()
    expect(res.manifest.entries['readme.md']).toBe(await sha256Hex(enc('# Readme v2')))

    // Next push: the failed file is STILL pending (not silently swallowed).
    t.rejectWrites.clear()
    const retry = await preparePush(sp, dir)
    expect(retry.plan.entries.map((e) => e.path)).toEqual(['huge.bin'])
    await applyPush(sp, dir, retry, { applyDeletions: false })
    expect(dec(t.files.get('huge.bin')!)).toBe('too big for the server')
  })

  it('reports progress and never reads an ignored path', async () => {
    const t = new FakePlaintextTransport()
    t.set('a.md', enc('a'))
    t.set('b/c.md', enc('c'))
    const sp = plaintextSyncSpace(t)
    const dir = new FakeDirHandle()

    const seen: Array<[number, number]> = []
    await pull(sp, dir, (done, total) => seen.push([done, total]))
    expect(seen[seen.length - 1][0]).toBe(seen[seen.length - 1][1])

    // The manifest we just wrote is a dotfile: pushing must not read it back
    // into the space, and the space must not be asked for it either.
    const before = t.reads
    const prepared = await preparePush(sp, dir)
    expect(prepared.plan.entries).toHaveLength(0)
    expect(t.reads - before).toBe(2) // exactly the two real files
    expect(t.files.has(MANIFEST_FILENAME)).toBe(false)
  })
})

describe('empty folders after a push', () => {
  it('drops folders left holding nothing, and keeps the ones that still have files', async () => {
    const t = new FakePlaintextTransport()
    t.set('keep/note.md', enc('still here'))
    t.set('gone/only.md', enc('about to be deleted'))
    t.emptyDirs.add('keep')
    t.emptyDirs.add('gone')
    t.emptyDirs.add('never-had-anything')
    const sp = plaintextSyncSpace(t)

    const dir = new FakeDirHandle()
    await pull(sp, dir)
    // The local side loses the file, and with deletions on the space follows —
    // which is exactly how a folder ends up empty in the tree.
    await (dir.children.get('gone') as FakeDirHandle).removeEntry('only.md')

    const res = await applyPush(sp, dir, await preparePush(sp, dir), { applyDeletions: true })

    expect(res.applied.deleted).toBe(1)
    expect(res.prunedDirs.sort()).toEqual(['gone', 'never-had-anything'])
    expect(t.files.has('keep/note.md')).toBe(true)
    expect([...t.emptyDirs]).toEqual(['keep'])
  })

  it('reports a prune failure without failing the push', async () => {
    const t = new FakePlaintextTransport()
    t.set('a.md', enc('one'))
    t.pruneEmptyDirs = async () => { throw new Error('server said no') }
    const sp = plaintextSyncSpace(t)
    const dir = new FakeDirHandle()
    await pull(sp, dir)
    await writeFileTo(dir, 'b.md', enc('two'))

    const res = await applyPush(sp, dir, await preparePush(sp, dir), { applyDeletions: false })
    // The real work still landed…
    expect(res.applied.new).toBe(1)
    expect(dec(t.files.get('b.md')!)).toBe('two')
    // …and the cleanup failure is surfaced rather than swallowed.
    expect(res.prunedDirs).toEqual([])
    expect(res.failed.map(f => f.path)).toContain('(empty folders)')
  })
})

// ─── moves: keeping a page's identity across a relocation ────────────────────
// A folder can't express "this file moved" — it only shows one path gone and
// another appeared. Applied literally that deletes the page and creates an
// unrelated one, taking every comment and reaction on it down with it. These
// cover the recognition rules and the payoff.

describe('folderSync move detection', () => {
  const m = (obj: Record<string, string>): Map<string, Uint8Array> => {
    const map = new Map<string, Uint8Array>()
    for (const [k, v] of Object.entries(obj)) map.set(k, enc(v))
    return map
  }
  const hashes = async (obj: Record<string, string>): Promise<Record<string, string>> => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = await sha256Hex(enc(v))
    return out
  }

  it('pairs a vanished path with an identical new one as a move', async () => {
    const plan = await computePushPlan(
      m({ 'notes/old.md': 'same bytes' }),
      m({ 'archive/old.md': 'same bytes' }),
      await hashes({ 'notes/old.md': 'same bytes' }),
    )
    expect(plan.counts).toMatchObject({ moved: 1, new: 0, deleted: 0 })
    const e = plan.entries[0]
    expect(e.kind).toBe('moved')
    expect(e.from).toBe('notes/old.md')
    expect(e.path).toBe('archive/old.md')
    expect(e.edited).toBe(false)
  })

  it('still recognises a move when the file was edited on the way, by its name', async () => {
    const plan = await computePushPlan(
      m({ 'notes/report.md': 'v1' }),
      m({ 'archive/report.md': 'v2 — rewritten' }),
      await hashes({ 'notes/report.md': 'v1' }),
    )
    const e = plan.entries.find((x) => x.kind === 'moved')!
    expect(e.from).toBe('notes/report.md')
    expect(e.edited).toBe(true) // folder-wins: the move is followed by a write
  })

  it('refuses an ambiguous name pairing rather than guessing', async () => {
    // Two files called report.md left, two appeared — no way to tell which
    // became which, so they stay a plain delete + create.
    const plan = await computePushPlan(
      m({ 'a/report.md': 'one', 'b/report.md': 'two' }),
      m({ 'x/report.md': 'three', 'y/report.md': 'four' }),
      await hashes({ 'a/report.md': 'one', 'b/report.md': 'two' }),
    )
    expect(plan.counts.moved).toBe(0)
    expect(plan.counts.deleted).toBe(2)
    expect(plan.counts.new).toBe(2)
  })

  it('prefers the same filename when several files share the same content', async () => {
    const plan = await computePushPlan(
      m({ 'a/one.md': 'dup', 'a/two.md': 'dup' }),
      m({ 'b/two.md': 'dup', 'b/one.md': 'dup' }),
      await hashes({ 'a/one.md': 'dup', 'a/two.md': 'dup' }),
    )
    const byFrom = Object.fromEntries(plan.entries.map((e) => [e.from, e.path]))
    expect(byFrom['a/one.md']).toBe('b/one.md')
    expect(byFrom['a/two.md']).toBe('b/two.md')
  })

  it('does not read a copy as a move (nothing left)', async () => {
    const plan = await computePushPlan(
      m({ 'page.md': 'body' }),
      m({ 'page.md': 'body', 'copy.md': 'body' }),
      await hashes({ 'page.md': 'body' }),
    )
    expect(plan.counts.moved).toBe(0)
    expect(plan.entries.map((e) => e.kind)).toEqual(['new'])
  })

  it('carries an encrypted page’s comments to the new path instead of orphaning them', async () => {
    const fs = await newFs()
    await fs.write('inbox/idea.md', enc('# Idea\n\nthe passage'))
    const nodeId = fs.idAt('inbox/idea.md')!
    await fs.addComment(nodeId, { text: 'good one', author: 'me', anchor: { quote: 'the passage', prefix: '', suffix: '' } })

    const dir = new FakeDirHandle()
    await pull(space(fs), dir)

    // The agent files it away: same bytes, new path.
    await writeFileTo(dir, 'projects/idea.md', enc('# Idea\n\nthe passage'))
    await (dir.children.get('inbox') as FakeDirHandle).removeEntry('idea.md')

    const prepared = await preparePush(space(fs), dir)
    expect(prepared.plan.counts.moved).toBe(1)
    // Deletions stay OFF — a move is not a deletion and must not need the box.
    const res = await applyPush(space(fs), dir, prepared, { applyDeletions: false })

    expect(res.applied).toMatchObject({ moved: 1, new: 0, deleted: 0 })
    expect(fs.pathOf(nodeId)).toBe('projects/idea.md') // same node, new home
    expect(fs.commentsForNode(nodeId)).toHaveLength(1)
    expect(fs.resolve('inbox/idea.md')).toBeUndefined()
  })

  it('renames server-side (not delete + create) for a plaintext space', async () => {
    const t = new FakePlaintextTransport()
    t.set('notes/todo.md', enc('- [ ] one'))
    const sp = plaintextSyncSpace(t)
    const dir = new FakeDirHandle()
    await pull(sp, dir)

    await writeFileTo(dir, 'done/todo.md', enc('- [ ] one'))
    await (dir.children.get('notes') as FakeDirHandle).removeEntry('todo.md')

    const res = await applyPush(sp, dir, await preparePush(sp, dir), { applyDeletions: false })

    expect(res.applied.moved).toBe(1)
    // The rename endpoint carries the comments along; a write+delete would not.
    expect(t.renames).toEqual(['notes/todo.md -> done/todo.md'])
    expect(dec(t.files.get('done/todo.md')!)).toBe('- [ ] one')
    expect(t.files.has('notes/todo.md')).toBe(false)
  })
})

// ─── the agent briefing ──────────────────────────────────────────────────────

describe('folderSync agent briefing', () => {
  it('writes AGENTS.md + CLAUDE.md on pull, outside the manifest', async () => {
    const fs = await newFs()
    await fs.write('page.md', enc('# Page'))
    await fs.write('feedback/_form.md', enc('# Feedback\n\nName: ______ [string]'))

    const dir = new FakeDirHandle()
    const res = await pull(space(fs), dir, undefined, { spaceName: 'Notes' })

    expect(res.guides).toEqual(['AGENTS.md', 'CLAUDE.md'])
    const guide = dec((await folderRead(dir, 'AGENTS.md'))!)
    expect(guide).toContain('notation Space — Notes')
    expect(guide).toContain('_form.md') // the Forms manual is in there
    expect(guide).toContain('`feedback/`') // …including this space's own forms
    expect(dec((await folderRead(dir, 'CLAUDE.md'))!)).toContain('@AGENTS.md')
    // Briefings are tooling: they are not space content, so not in the baseline.
    expect(res.manifest.entries['AGENTS.md']).toBeUndefined()
  })

  it('tells the agent to keep an append-only changelog, in both guides', async () => {
    const fs = await newFs()
    await fs.write('page.md', enc('# Page'))
    const dir = new FakeDirHandle()
    await pull(space(fs), dir, undefined, { spaceName: 'Notes' })

    const guide = dec((await folderRead(dir, 'AGENTS.md'))!)
    expect(guide).toContain('CHANGELOG.md')
    expect(guide).toContain('Append only')
    expect(guide).toContain('**Request:**') // the entry template
    // The pointer repeats the rule, so a tool that doesn't follow @-imports
    // still learns about it.
    expect(dec((await folderRead(dir, 'CLAUDE.md'))!)).toContain('CHANGELOG.md')
  })

  it('carries the changelog the agent wrote into the space — it is not a guide', async () => {
    const fs = await newFs()
    await fs.write('page.md', enc('# Page'))
    const dir = new FakeDirHandle()
    await pull(space(fs), dir, undefined, { spaceName: 'Notes' })

    const log = '# Changelog\n\n## 2026-03-14 — Edited a page\n\n**Request:** …\n'
    await writeFileTo(dir, 'CHANGELOG.md', enc(log))

    const prepared = await preparePush(space(fs), dir)
    expect(prepared.strippedGuides).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(prepared.plan.entries.map((e) => e.path)).toEqual(['CHANGELOG.md'])
    await applyPush(space(fs), dir, prepared, { applyDeletions: false })
    expect(dec(await fs.read('CHANGELOG.md'))).toBe(log)
  })

  it('never pushes the briefing back into the space', async () => {
    const fs = await newFs()
    await fs.write('page.md', enc('# Page'))
    const dir = new FakeDirHandle()
    await pull(space(fs), dir, undefined, { spaceName: 'Notes' })

    // The agent even edits it — still ours, still held back.
    const edited = dec((await folderRead(dir, 'AGENTS.md'))!) + '\n\nagent scribbles\n'
    await writeFileTo(dir, 'AGENTS.md', enc(edited))

    const prepared = await preparePush(space(fs), dir)
    expect(prepared.strippedGuides).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(prepared.plan.entries).toHaveLength(0)

    await applyPush(space(fs), dir, prepared, { applyDeletions: false })
    expect(fs.resolve('AGENTS.md')).toBeUndefined()
    expect(fs.resolve('CLAUDE.md')).toBeUndefined()
  })

  it('leaves a real AGENTS.md page in the space alone, both ways', async () => {
    const fs = await newFs()
    await fs.write('AGENTS.md', enc('# My own agent notes'))
    const dir = new FakeDirHandle()
    const res = await pull(space(fs), dir, undefined, { spaceName: 'Notes' })

    // The space's own file wins the name; only CLAUDE.md is generated.
    expect(res.guides).toEqual(['CLAUDE.md'])
    expect(dec((await folderRead(dir, 'AGENTS.md'))!)).toBe('# My own agent notes')

    await writeFileTo(dir, 'AGENTS.md', enc('# My own agent notes, edited'))
    const prepared = await preparePush(space(fs), dir)
    expect(prepared.plan.entries.map((e) => e.path)).toEqual(['AGENTS.md'])
    await applyPush(space(fs), dir, prepared, { applyDeletions: false })
    expect(dec(await fs.read('AGENTS.md'))).toBe('# My own agent notes, edited')
  })

  it('pushes a briefing whose marker the user removed — it stopped being ours', async () => {
    const fs = await newFs()
    await fs.write('page.md', enc('# Page'))
    const dir = new FakeDirHandle()
    await pull(space(fs), dir, undefined, { spaceName: 'Notes' })
    await writeFileTo(dir, 'AGENTS.md', enc('# House rules\n\nmine now'))

    const prepared = await preparePush(space(fs), dir)
    expect(prepared.strippedGuides).toEqual(['CLAUDE.md'])
    expect(prepared.plan.entries.map((e) => e.path)).toEqual(['AGENTS.md'])
    await applyPush(space(fs), dir, prepared, { applyDeletions: false })
    expect(dec(await fs.read('AGENTS.md'))).toBe('# House rules\n\nmine now')
  })
})
