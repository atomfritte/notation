import { describe, expect, it } from 'vitest'
import { generateDEK, importContentKey } from '../../shared/crypto/keys'
import { InMemoryEncStore } from '../../shared/vfs/encStore'
import { EncryptedFS } from '../../shared/vfs/encfs'
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
    const res = await pull(fs, dir)

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
    const res = await pull(fs, dir)

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
    await pull(fs, dir)

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
  await pull(fs, dir)
  return { fs, dir }
}

describe('folderSync push', () => {
  it('adds a new folder file into the space (decrypts back correctly)', async () => {
    const { fs, dir } = await pulled()
    await writeFileTo(dir, 'notes/added.md', enc('# Added by agent'))

    const prepared = await preparePush(fs, dir)
    expect(prepared.plan.counts.new).toBe(1)
    expect(prepared.plan.entries.find((e) => e.path === 'notes/added.md')?.kind).toBe('new')

    const res = await applyPush(fs, dir, prepared, { applyDeletions: false })
    expect(res.applied.new).toBe(1)
    expect(dec(await fs.read('notes/added.md'))).toBe('# Added by agent')
  })

  it('updates space content for a modified folder file (reuses the node, no new op)', async () => {
    const { fs, dir } = await pulled()
    const store = (fs as unknown as { store: InMemoryEncStore }).store
    const before = store.opCount()
    await writeFileTo(dir, 'readme.md', enc('# Readme\n\nEDITED locally'))

    const prepared = await preparePush(fs, dir)
    expect(prepared.plan.counts.modified).toBe(1)
    const res = await applyPush(fs, dir, prepared, { applyDeletions: false })

    expect(res.applied.modified).toBe(1)
    expect(dec(await fs.read('readme.md'))).toBe('# Readme\n\nEDITED locally')
    // A content overwrite reuses the blobId and appends NO structural op.
    expect(store.opCount()).toBe(before)
  })

  it('shows a deletion candidate but keeps it unless deletions are opted in', async () => {
    const { fs, dir } = await pulled()
    await dir.getDirectoryHandle('docs').then((d) => d.removeEntry('guide.md'))

    const prepared = await preparePush(fs, dir)
    expect(prepared.plan.counts.deleted).toBe(1)
    expect(prepared.plan.entries.find((e) => e.path === 'docs/guide.md')?.kind).toBe('deleted')

    // Deletions OFF: the space file survives.
    const kept = await applyPush(fs, dir, prepared, { applyDeletions: false })
    expect(kept.skippedDeletions).toBe(1)
    expect(kept.applied.deleted).toBe(0)
    expect(dec(await fs.read('docs/guide.md'))).toBe('# Guide\n\nsteps')

    // Deletions ON (same previewed plan): now it is removed from the space.
    const removed = await applyPush(fs, dir, prepared, { applyDeletions: true })
    expect(removed.applied.deleted).toBe(1)
    expect(fs.resolve('docs/guide.md')).toBeUndefined()
  })

  it('is a clean no-op when nothing changed (no spurious ops)', async () => {
    const { fs, dir } = await pulled()
    const store = (fs as unknown as { store: InMemoryEncStore }).store
    const before = store.opCount()

    const prepared = await preparePush(fs, dir)
    expect(prepared.plan.entries).toHaveLength(0)
    const res = await applyPush(fs, dir, prepared, { applyDeletions: false })

    expect(res.applied).toEqual({ new: 0, modified: 0, deleted: 0 })
    expect(store.opCount()).toBe(before)
  })

  it('skips ignored folder entries (.git, node_modules) on push', async () => {
    const { fs, dir } = await pulled()
    await writeFileTo(dir, '.git/config', enc('[core]'))
    await writeFileTo(dir, 'node_modules/pkg/index.js', enc('module.exports = {}'))
    await writeFileTo(dir, 'legit.md', enc('# Legit'))

    const prepared = await preparePush(fs, dir)
    const paths = prepared.plan.entries.map((e) => e.path)
    expect(paths).toContain('legit.md')
    expect(paths).not.toContain('.git/config')
    expect(paths).not.toContain('node_modules/pkg/index.js')

    await applyPush(fs, dir, prepared, { applyDeletions: false })
    expect(fs.resolve('.git/config')).toBeUndefined()
    expect(fs.resolve('node_modules/pkg/index.js')).toBeUndefined()
  })

  it('round-trips: pull → edit a file in the folder → push → space matches, binary intact', async () => {
    const { fs, dir } = await pulled()
    const originalBinary = await fs.read('img/pic.bin')

    // Simulate a local agent editing one markdown file.
    await writeFileTo(dir, 'docs/guide.md', enc('# Guide\n\nrewritten by Claude Code'))

    const prepared = await preparePush(fs, dir)
    await applyPush(fs, dir, prepared, { applyDeletions: false })

    expect(dec(await fs.read('docs/guide.md'))).toBe('# Guide\n\nrewritten by Claude Code')
    // Untouched files (incl. the binary) are byte-for-byte intact.
    expect(dec(await fs.read('readme.md'))).toBe('# Readme\n\nhello')
    expect(bytesEqual(await fs.read('img/pic.bin'), originalBinary)).toBe(true)

    // A second push with no further edits is a clean no-op.
    const again = await preparePush(fs, dir)
    expect(again.plan.entries).toHaveLength(0)
  })

  it('uses the fallback manifest when the folder has no .notation-sync.json', async () => {
    const fs = await newFs()
    await fs.write('doc.md', enc('v1'))
    const dir = new FakeDirHandle()
    // Populate the folder WITHOUT a manifest (as if it were copied elsewhere).
    await writeFileTo(dir, 'doc.md', enc('v2'))

    const noBaseline = await preparePush(fs, dir)
    expect(noBaseline.manifestSource).toBe('none')

    const withFallback = await preparePush(fs, dir, { 'doc.md': await sha256Hex(enc('v1')) })
    expect(withFallback.manifestSource).toBe('fallback')
    // With the baseline, the divergence is a plain folder-wins modification.
    expect(withFallback.plan.entries.find((e) => e.path === 'doc.md')?.kind).toBe('modified')
  })
})
