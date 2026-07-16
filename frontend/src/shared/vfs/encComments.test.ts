import { describe, expect, it } from 'vitest'
import { generateDEK, importContentKey } from '../crypto/keys'
import type { KeyHandle } from '../crypto/keys'
import { InMemoryEncStore } from './encStore'
import { EncryptedFS, VfsCommentError } from './encfs'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const newKey = (): Promise<KeyHandle> => importContentKey(generateDEK())

/** True if the byte sequence `needle` occurs anywhere in `hay`. */
function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

async function fsWithFile(store: InMemoryEncStore, key: KeyHandle, actor = 'A') {
  const fs = await EncryptedFS.open(store, key, actor)
  await fs.write('docs/note.md', enc('# secret note'))
  return fs
}

describe('EncryptedFS comments', () => {
  it('adds a comment on a file node and lists it back', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const fs = await fsWithFile(store, key)
    const nodeId = fs.idAt('docs/note.md')!

    const c = await fs.addComment(nodeId, { text: 'looks good', author: 'admin:me' })
    expect(c.nodeId).toBe(nodeId)
    expect(fs.commentsForNode(nodeId).map((x) => x.text)).toEqual(['looks good'])
    expect(fs.comments()).toHaveLength(1)
  })

  it('persists comments across a reload (fresh replica sees them)', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const fs = await fsWithFile(store, key)
    const nodeId = fs.idAt('docs/note.md')!
    await fs.addComment(nodeId, { text: 'first', author: 'admin:me' })
    await fs.addComment(nodeId, { text: 'second', author: 'admin:me' })

    const reloaded = await EncryptedFS.open(store, key, 'B')
    // Assert presence, order-independent: both comments are stamped in the same
    // millisecond by the instant in-memory store, so their (createdAt,id) sort is
    // a tie broken by random id. In production each addComment awaits a network
    // round-trip, so createdAt is distinct — see commentLog.test.ts for ordering.
    expect(reloaded.commentsForNode(nodeId).map((c) => c.text).sort()).toEqual(['first', 'second'])
  })

  it('round-trips a comment anchor (quote/prefix/suffix) through a reload', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const fs = await fsWithFile(store, key)
    const nodeId = fs.idAt('docs/note.md')!
    const anchor = { quote: 'secret note', prefix: '# ', suffix: '' }
    await fs.addComment(nodeId, { text: 'on the heading', author: 'a', anchor })

    const reloaded = await EncryptedFS.open(store, key, 'B')
    expect(reloaded.commentsForNode(nodeId)[0].anchor).toEqual(anchor)
  })

  it('never writes comment text, author, anchor, or nodeId to the store in cleartext', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const fs = await fsWithFile(store, key)
    const nodeId = fs.idAt('docs/note.md')!
    await fs.addComment(nodeId, {
      text: 'TOP-SECRET-COMMENT',
      author: 'admin:alice',
      anchor: { quote: 'SENSITIVE-QUOTE', prefix: '', suffix: '' },
    })

    for (const bytes of store.allStoredBytes()) {
      expect(containsBytes(bytes, enc('TOP-SECRET-COMMENT'))).toBe(false)
      expect(containsBytes(bytes, enc('SENSITIVE-QUOTE'))).toBe(false)
      expect(containsBytes(bytes, enc('admin:alice'))).toBe(false)
      // The file's nodeId must not appear beside the ciphertext either.
      expect(containsBytes(bytes, enc(nodeId))).toBe(false)
    }
  })

  it('threads replies and enforces one-level nesting on the same file', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const fs = await fsWithFile(store, key)
    await fs.write('other.md', enc('x'))
    const nodeId = fs.idAt('docs/note.md')!
    const otherId = fs.idAt('other.md')!

    const top = await fs.addComment(nodeId, { text: 'top', author: 'a' })
    const reply = await fs.addComment(nodeId, { text: 'reply', author: 'b', parentId: top.id })
    expect(reply.parentId).toBe(top.id)

    // Nesting past one level is refused.
    await expect(
      fs.addComment(nodeId, { text: 'nested', author: 'c', parentId: reply.id }),
    ).rejects.toBeInstanceOf(VfsCommentError)
    // A reply whose parent is on a different file is refused.
    await expect(
      fs.addComment(otherId, { text: 'wrong-file', author: 'c', parentId: top.id }),
    ).rejects.toBeInstanceOf(VfsCommentError)
  })

  it('deletes a top-level comment and cascades to its replies', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const fs = await fsWithFile(store, key)
    const nodeId = fs.idAt('docs/note.md')!
    const top = await fs.addComment(nodeId, { text: 'top', author: 'a' })
    await fs.addComment(nodeId, { text: 'reply', author: 'b', parentId: top.id })

    await fs.deleteComment(top.id)
    expect(fs.comments()).toHaveLength(0)

    // The cascade survives a reload — replies are tombstoned, not just hidden.
    const reloaded = await EncryptedFS.open(store, key, 'B')
    expect(reloaded.comments()).toHaveLength(0)
  })

  it('converges across two replicas commenting concurrently', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const a = await fsWithFile(store, key, 'A')
    const b = await EncryptedFS.open(store, key, 'B')
    await b.sync()
    const nodeId = a.idAt('docs/note.md')!

    await a.addComment(nodeId, { text: 'from-A', author: 'A' })
    await b.addComment(nodeId, { text: 'from-B', author: 'B' })
    await a.sync()
    await b.sync()

    const textsA = a.commentsForNode(nodeId).map((c) => c.text).sort()
    const textsB = b.commentsForNode(nodeId).map((c) => c.text).sort()
    expect(textsA).toEqual(['from-A', 'from-B'])
    expect(textsB).toEqual(['from-A', 'from-B'])
  })

  it('preserves comments through a checkpoint compaction', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const fs = await fsWithFile(store, key)
    const nodeId = fs.idAt('docs/note.md')!
    await fs.addComment(nodeId, { text: 'before-checkpoint', author: 'a' })
    await fs.writeCheckpoint()
    await fs.addComment(nodeId, { text: 'after-checkpoint', author: 'a' })

    const reloaded = await EncryptedFS.open(store, key, 'B')
    // Presence, order-independent (same-millisecond createdAt tie — see above).
    expect(reloaded.commentsForNode(nodeId).map((c) => c.text).sort()).toEqual([
      'after-checkpoint',
      'before-checkpoint',
    ])
  })
})
