import { describe, expect, it } from 'vitest'
import { generateDEK, importContentKey } from '../crypto/keys'
import type { KeyHandle } from '../crypto/keys'
import { InMemoryEncStore, type EncStore, type StoredOp } from './encStore'
import type { SpaceKeyRecord } from '../crypto/space'
import type { Node } from './nodes'
import { EncryptedFS } from './encfs'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const newKey = (): Promise<KeyHandle> => importContentKey(generateDEK())
const fp = (nodes: Node[]): string => JSON.stringify(nodes.map((n) => [n.nodeId, n.parentId, n.name]).sort())
const names = (fs: EncryptedFS) => fs.tree().map((n) => n.name).sort()

/** Wrap a store, recording every `listOps(since)` call — so a test can prove a
 *  reload seeded from the checkpoint (no listOps(0)) vs. fully replayed. */
class RecordingStore implements EncStore {
  readonly sinceCalls: number[] = []
  constructor(private readonly inner: EncStore) {}
  async listOps(since: number): Promise<StoredOp[]> { this.sinceCalls.push(since); return this.inner.listOps(since) }
  getBlob(id: string) { return this.inner.getBlob(id) }
  putBlob(id: string, b: Uint8Array) { return this.inner.putBlob(id, b) }
  deleteBlob(id: string) { return this.inner.deleteBlob(id) }
  appendOp(id: string, b: Uint8Array) { return this.inner.appendOp(id, b) }
  getCheckpoint() { return this.inner.getCheckpoint() }
  putCheckpoint(b: Uint8Array) { return this.inner.putCheckpoint(b) }
  getKeyRecord(): Promise<SpaceKeyRecord | null> { return this.inner.getKeyRecord() }
  putKeyRecord(r: SpaceKeyRecord) { return this.inner.putKeyRecord(r) }
}

/** Wrap a store, omitting one op seq from listOps to model a truncating server. */
class GapStore implements EncStore {
  constructor(private readonly inner: EncStore, private readonly dropSeq: number) {}
  async listOps(since: number): Promise<StoredOp[]> {
    return (await this.inner.listOps(since)).filter((o) => o.seq !== this.dropSeq)
  }
  getBlob(id: string) { return this.inner.getBlob(id) }
  putBlob(id: string, b: Uint8Array) { return this.inner.putBlob(id, b) }
  deleteBlob(id: string) { return this.inner.deleteBlob(id) }
  appendOp(id: string, b: Uint8Array) { return this.inner.appendOp(id, b) }
  getCheckpoint() { return this.inner.getCheckpoint() }
  putCheckpoint(b: Uint8Array) { return this.inner.putCheckpoint(b) }
  getKeyRecord(): Promise<SpaceKeyRecord | null> { return this.inner.getKeyRecord() }
  putKeyRecord(r: SpaceKeyRecord) { return this.inner.putKeyRecord(r) }
}

describe('EncryptedFS compaction — correctness', () => {
  it('a reload seeds from the checkpoint and fetches only newer ops (no full replay)', async () => {
    const inner = new InMemoryEncStore()
    const key = await newKey()
    const a = await EncryptedFS.open(inner, key, 'a')
    await a.mkdir('docs/guides')
    await a.write('docs/guides/intro.md', enc('hi'))
    await a.sync() // lastSeq now reflects the folded ops
    await a.writeCheckpoint()
    await a.write('after.md', enc('later')) // strictly higher timestamp

    const rec = new RecordingStore(inner)
    const b = await EncryptedFS.open(rec, key, 'b')
    // Seed used: the only fetch is listOps(checkpointSeq>0); no listOps(0) replay.
    expect(rec.sinceCalls).not.toContain(0)
    expect(names(b)).toEqual(['after.md', 'docs', 'guides', 'intro.md'])
    expect(fp(b.allNodes())).toBe(fp(a.allNodes()))
  })

  it('never loses a concurrent op after a checkpoint (the #3 data-loss fix)', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const a = await EncryptedFS.open(store, key, 'actor-a')
    const b = await EncryptedFS.open(store, key, 'actor-b')
    await a.write('base.md', enc('x'))
    await b.sync()

    // Concurrent commits WITHOUT syncing between them: their lamports can tie.
    await a.write('from-a.md', enc('a'))
    await b.write('from-b.md', enc('b'))
    // A observes B, then checkpoints at the merged high-water.
    await a.sync()
    await a.writeCheckpoint()

    // A fresh replica loading from that checkpoint must see BOTH files — the old
    // `lamport <= checkpointLamport` skip would have silently dropped B's op.
    const c = await EncryptedFS.open(store, key, 'c')
    expect(names(c)).toEqual(['base.md', 'from-a.md', 'from-b.md'])
    expect(fp(c.allNodes())).toBe(fp(a.allNodes()))
  })

  it('falls back to a full replay when a late op sorts at/before the checkpoint', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const a = await EncryptedFS.open(store, key, 'a')
    const b = await EncryptedFS.open(store, key, 'b') // opens empty → clock stays low

    // A drives its lamport high and checkpoints.
    await a.mkdir('x/y/z')
    await a.write('x/y/z/deep.md', enc('deep'))
    await a.sync()
    await a.writeCheckpoint()

    // B (stale, low clock) commits — its op's lamport is BELOW the checkpoint
    // high-water, so a seed can't order it correctly → the loader must full-replay.
    await b.write('b-late.md', enc('late'))

    const rec = new RecordingStore(store)
    const c = await EncryptedFS.open(rec, key, 'c')
    expect(rec.sinceCalls).toContain(0) // full replay happened
    // No data lost: both A's deep file and B's late file are present.
    expect(names(c)).toContain('b-late.md')
    expect(c.resolve('x/y/z/deep.md')?.type).toBe('file')
    // And it converges to what A + B agree on after a mutual sync.
    await a.sync(); await b.sync()
    expect(fp(c.allNodes())).toBe(fp(a.allNodes()))
  })

  it('detects a truncating server (op-log seq gap) instead of silently missing an op', async () => {
    const inner = new InMemoryEncStore()
    const key = await newKey()
    const a = await EncryptedFS.open(inner, key, 'a')
    await a.write('one.md', enc('1'))
    await a.write('two.md', enc('2'))
    await a.write('three.md', enc('3'))

    // A fresh replica whose server drops seq 2 must throw, not skip it.
    const b = new EncryptedFS(new GapStore(inner, 2), key, 'b')
    await expect(b.load()).rejects.toThrow(/gap/)
  })

  it('writes a checkpoint automatically once enough ops accrue', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const a = await EncryptedFS.open(store, key, 'a')
    expect(await store.getCheckpoint()).toBeNull()
    // AUTO_CHECKPOINT_EVERY is 150; create comfortably more, then one sync folds
    // them all and trips the auto-checkpoint.
    for (let i = 0; i < 160; i++) await a.mkdir(`d${i}`)
    await a.sync()
    expect(await store.getCheckpoint()).not.toBeNull()

    // The auto-written checkpoint is usable: a fresh load matches.
    const b = await EncryptedFS.open(store, key, 'b')
    expect(fp(b.allNodes())).toBe(fp(a.allNodes()))
  })

  it('survives a corrupt/unopenable checkpoint by loading from the full log', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const a = await EncryptedFS.open(store, key, 'a')
    await a.write('keep.md', enc('data'))
    await a.sync()
    // Poison the checkpoint slot with garbage bytes.
    await store.putCheckpoint(enc('not a real checkpoint'))

    const b = await EncryptedFS.open(store, key, 'b')
    // The space still opens and its content is intact (full-log fallback).
    expect(names(b)).toEqual(['keep.md'])
    expect(fp(b.allNodes())).toBe(fp(a.allNodes()))
  })

  it('a checkpoint blob cannot be opened as (or swapped with) a content blob', async () => {
    const store = new InMemoryEncStore()
    const key = await newKey()
    const a = await EncryptedFS.open(store, key, 'a')
    await a.write('note.md', enc('secret'))
    await a.sync()
    await a.writeCheckpoint()
    const cp = (await store.getCheckpoint())!
    const node = a.tree().find((n) => n.type === 'file')!
    // The checkpoint binds a domain-tag AAD, so it won't decrypt as a content
    // blob (which binds its blobId) — cross-context substitution fails.
    await store.putBlob(node.blobId!, cp)
    await expect(a.read('note.md')).rejects.toThrow()
  })
})
