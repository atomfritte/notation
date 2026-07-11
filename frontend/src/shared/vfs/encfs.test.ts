import { describe, expect, it } from 'vitest'
import { ROOT_ID, TRASH_ID } from './nodes'
import type { Node } from './nodes'
import { generateDEK, importContentKey } from '../crypto/keys'
import type { KeyHandle } from '../crypto/keys'
import { decryptBlob } from '../crypto/blob'
import { InMemoryEncStore } from './encStore'
import { EncryptedFS, VfsNotFoundError, openOpBytes } from './encfs'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)
const newKey = (): Promise<KeyHandle> => importContentKey(generateDEK())
const fingerprint = (nodes: Node[]): string => JSON.stringify(nodes)

/** True if the byte sequence `needle` occurs anywhere in `hay`. */
function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

/** Throws if the parent links form a cycle (orphans are fine). */
function assertAcyclic(nodes: Node[]): void {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  for (const n of nodes) {
    const seen = new Set<string>()
    let cursor: string | undefined = n.nodeId
    while (cursor !== undefined && cursor !== ROOT_ID && cursor !== TRASH_ID) {
      if (seen.has(cursor)) throw new Error(`cycle through ${cursor}`)
      seen.add(cursor)
      cursor = byId.get(cursor)?.parentId
    }
  }
}

const namesUnder = (fs: EncryptedFS, parentPathId: string): string[] =>
  fs
    .tree()
    .filter((n) => n.parentId === parentPathId)
    .map((n) => n.name)
    .sort()

describe('EncryptedFS round-trip', () => {
  it('creates dirs + files, reads back exact plaintext, and shows the right tree', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const fs = await EncryptedFS.open(store, key, 'A')

    await fs.mkdir('docs/guides')
    await fs.write('docs/guides/intro.txt', enc('hello world'))
    await fs.write('readme.txt', enc('top level'))

    expect(dec(await fs.read('docs/guides/intro.txt'))).toBe('hello world')
    expect(dec(await fs.read('readme.txt'))).toBe('top level')

    // Structure: docs + readme at root; guides under docs; intro under guides.
    expect(namesUnder(fs, ROOT_ID)).toEqual(['docs', 'readme.txt'])
    const docs = fs.idAt('docs')!
    expect(namesUnder(fs, docs)).toEqual(['guides'])
    const guides = fs.idAt('docs/guides')!
    expect(fs.tree().filter((n) => n.parentId === guides).map((n) => n.name)).toEqual(['intro.txt'])

    // A reload from the same store reconstructs the identical tree.
    const reloaded = await EncryptedFS.open(store, key, 'B')
    expect(fingerprint(reloaded.tree())).toBe(fingerprint(fs.tree()))
    expect(dec(await reloaded.read('docs/guides/intro.txt'))).toBe('hello world')
  })

  it('keeps the store blind: no plaintext name or content in any stored bytes', async () => {
    const store = new InMemoryEncStore()
    const fs = await EncryptedFS.open(store, await newKey(), 'A')

    await fs.mkdir('SECRETFOLDER')
    await fs.write('SECRETFOLDER/CONFIDENTIAL.txt', enc('TOPSECRETPLAINTEXT'))

    const markers = ['TOPSECRETPLAINTEXT', 'SECRETFOLDER', 'CONFIDENTIAL'].map(enc)
    for (const bytes of store.allStoredBytes()) {
      for (const marker of markers) {
        expect(containsBytes(bytes, marker)).toBe(false)
      }
    }
    // Sanity: it really is retrievable once decrypted.
    expect(dec(await fs.read('SECRETFOLDER/CONFIDENTIAL.txt'))).toBe('TOPSECRETPLAINTEXT')
  })

  it('creates missing parent dirs on write', async () => {
    const store = new InMemoryEncStore()
    const fs = await EncryptedFS.open(store, await newKey(), 'A')

    await fs.write('a/b/c/deep.txt', enc('deep'))

    expect(fs.idAt('a')).toBeDefined()
    expect(fs.resolve('a')?.type).toBe('dir')
    expect(fs.resolve('a/b/c')?.type).toBe('dir')
    expect(dec(await fs.read('a/b/c/deep.txt'))).toBe('deep')
  })
})

describe('EncryptedFS structural ops', () => {
  it('renames a file in place', async () => {
    const store = new InMemoryEncStore()
    const fs = await EncryptedFS.open(store, await newKey(), 'A')
    await fs.write('notes.txt', enc('body'))

    await fs.rename('notes.txt', 'renamed.txt')

    expect(fs.resolve('notes.txt')).toBeUndefined()
    expect(dec(await fs.read('renamed.txt'))).toBe('body')
  })

  it('moves a subtree to a new parent, content still readable at the new path', async () => {
    const store = new InMemoryEncStore()
    const fs = await EncryptedFS.open(store, await newKey(), 'A')
    await fs.mkdir('src/pkg')
    await fs.write('src/pkg/file.txt', enc('payload'))
    await fs.mkdir('dst')

    await fs.move(fs.idAt('src/pkg')!, fs.idAt('dst')!)

    expect(fs.resolve('src/pkg')).toBeUndefined()
    expect(fs.resolve('dst/pkg')?.type).toBe('dir')
    expect(dec(await fs.read('dst/pkg/file.txt'))).toBe('payload')
  })

  it('soft-deletes: node leaves tree() and lands in trash, subtree preserved', async () => {
    const store = new InMemoryEncStore()
    const fs = await EncryptedFS.open(store, await newKey(), 'A')
    await fs.mkdir('folder')
    await fs.write('folder/child.txt', enc('kept'))
    const folderId = fs.idAt('folder')!

    await fs.remove('folder')

    // Gone from the visible tree and from path lookups.
    expect(fs.resolve('folder')).toBeUndefined()
    expect(fs.tree().some((n) => n.nodeId === folderId)).toBe(false)
    await expect(fs.read('folder/child.txt')).rejects.toBeInstanceOf(VfsNotFoundError)

    // But preserved in trash (never dropped); its subtree rides along.
    const all = new Map(fs.allNodes().map((n) => [n.nodeId, n]))
    expect(all.get(folderId)?.parentId).toBe(TRASH_ID)
    expect(all.get(folderId)?.deleted).toBe(true)
    const childId = [...all.values()].find((n) => n.name === 'child.txt')!.nodeId
    expect(all.get(childId)?.parentId).toBe(folderId) // subtree intact under the trashed dir
  })

  it('read of a missing path throws a typed NotFound', async () => {
    const store = new InMemoryEncStore()
    const fs = await EncryptedFS.open(store, await newKey(), 'A')
    await expect(fs.read('nope.txt')).rejects.toBeInstanceOf(VfsNotFoundError)
  })
})

describe('EncryptedFS content overwrite', () => {
  it('reuses the blobId and appends NO op', async () => {
    const store = new InMemoryEncStore()
    const fs = await EncryptedFS.open(store, await newKey(), 'A')
    await fs.write('doc.txt', enc('v1'))

    const blobId = fs.resolve('doc.txt')!.blobId
    const opsAfterCreate = store.opCount()
    const blobsAfterCreate = store.blobCount()

    await fs.write('doc.txt', enc('v2-longer-content'))

    expect(store.opCount()).toBe(opsAfterCreate) // structure unchanged → no op
    expect(store.blobCount()).toBe(blobsAfterCreate) // same blob slot reused
    expect(fs.resolve('doc.txt')!.blobId).toBe(blobId) // same blobId
    expect(dec(await fs.read('doc.txt'))).toBe('v2-longer-content')
  })
})

describe('EncryptedFS wrong-key isolation', () => {
  it('cannot open ops or blobs sealed under a different key', async () => {
    const store = new InMemoryEncStore()
    const keyA = await newKey()
    const keyB = await newKey()
    const fsA = await EncryptedFS.open(store, keyA, 'A')
    await fs_write(fsA, 'secret.txt', 'classified')

    // An op sealed under A does not open under B.
    const [firstOp] = await store.listOps(0)
    await expect(openOpBytes(firstOp.blob, keyB)).rejects.toThrow()

    // A content blob sealed under A does not decrypt under B.
    const blobId = fsA.tree().find((n) => n.type === 'file')!.blobId!
    const cipher = (await store.getBlob(blobId))!
    await expect(decryptBlob(cipher, keyB)).rejects.toThrow()

    // And loading the whole space under the wrong key fails (can't open the log).
    await expect(EncryptedFS.open(store, keyB, 'C')).rejects.toThrow()
  })
})

describe('EncryptedFS checkpoint compaction', () => {
  it('reloads from a checkpoint + later ops identically to a full replay', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const fs = await EncryptedFS.open(store, key, 'A')

    await fs.mkdir('a/b')
    await fs.write('a/b/one.txt', enc('one'))
    await fs.writeCheckpoint()
    // Mutations after the checkpoint.
    await fs.write('a/b/two.txt', enc('two'))
    await fs.rename('a/b/one.txt', 'a/b/uno.txt')

    const reloaded = await EncryptedFS.open(store, key, 'B')
    expect(fingerprint(reloaded.tree())).toBe(fingerprint(fs.tree()))
    expect(dec(await reloaded.read('a/b/two.txt'))).toBe('two')
    expect(dec(await reloaded.read('a/b/uno.txt'))).toBe('one')
  })
})

describe('EncryptedFS two-replica convergence', () => {
  it('converges byte-identically under concurrent conflicting structural edits', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey() // same space key, different actors
    const a = await EncryptedFS.open(store, key, 'A')
    const b = await EncryptedFS.open(store, key, 'B')

    // Base structure built by A, observed by B.
    await a.mkdir('docs/sub')
    await a.mkdir('other')
    await a.write('docs/sub/note.txt', enc('note-body'))
    await a.write('docs/file.txt', enc('file-v1'))
    await b.sync()

    const subA = a.idAt('docs/sub')!
    const subB = b.idAt('docs/sub')!
    expect(subA).toBe(subB) // shared nodeIds across replicas
    const docsA = a.idAt('docs')!
    const otherB = b.idAt('other')!

    // ── concurrent edits, no sync in between ──
    // A: move `sub` to root; rename the file; move `docs` under `sub`.
    await a.move(subA, ROOT_ID)
    await a.rename('docs/file.txt', 'docs/file-renamed.txt')
    await a.move(docsA, subA) // would-be cycle vs B's move of sub, resolved by the CRDT
    // B: move the SAME `sub` under `other` (conflicting parent); overwrite the
    // file's content (no op); add a new dir.
    await b.move(subB, otherB)
    await b.write('docs/file.txt', enc('file-v2'))
    await b.mkdir('docs/newdir')

    // Both pull the full op set from the shared store.
    await a.sync()
    await b.sync()

    // Byte-identical materialized trees, and acyclic.
    expect(fingerprint(a.tree())).toBe(fingerprint(b.tree()))
    assertAcyclic(a.allNodes())

    // Every surviving file reads identically on both replicas.
    const files = a.tree().filter((n) => n.type === 'file')
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const path = a.pathOf(f.nodeId)!
      expect(path).toBeTruthy()
      const da = await a.read(path)
      const db = await b.read(path)
      expect(dec(da)).toBe(dec(db))
    }
    // The concurrently-overwritten file converged to B's later content.
    const filePath = a.pathOf(a.tree().find((n) => n.name === 'file-renamed.txt')!.nodeId)!
    expect(dec(await a.read(filePath))).toBe('file-v2')
  })
})

/** Small helper: write a UTF-8 string. */
async function fs_write(fs: EncryptedFS, path: string, text: string): Promise<void> {
  await fs.write(path, enc(text))
}
