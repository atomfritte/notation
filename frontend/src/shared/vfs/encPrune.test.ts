import { describe, expect, it } from 'vitest'
import { generateDEK, importContentKey } from '../crypto/keys'
import type { KeyHandle } from '../crypto/keys'
import { InMemoryEncStore, type EncStore, type StoredOp } from './encStore'
import type { SpaceKeyRecord } from '../crypto/space'
import type { Node } from './nodes'
import { EncryptedFS, VfsError } from './encfs'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const newKey = (): Promise<KeyHandle> => importContentKey(generateDEK())
const fp = (nodes: Node[]): string => JSON.stringify(nodes.map((n) => [n.nodeId, n.parentId, n.name]).sort())
const names = (fs: EncryptedFS): string[] => fs.tree().map((n) => n.name).sort()

// A small margin makes pruning trigger after a handful of ops, keeping tests fast
// while still exercising the real clean-cut + margin gates end to end.
const MARGIN = 4
const openFs = (store: EncStore, key: KeyHandle, actor: string) =>
  EncryptedFS.open(store, key, actor, { pruneMargin: MARGIN })
const newStore = () => new InMemoryEncStore({ pruneMargin: MARGIN })

/** Wrap a store, omitting one op seq from listOps to model a truncating server —
 *  forwarding EVERY method (including the optional prune surface) so a loader can
 *  still seed the base and reach the real gap in the retained range. */
class GapStore implements EncStore {
  constructor(
    private readonly inner: EncStore,
    private readonly dropSeq: number,
  ) {}
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
  getOpsFloor() { return this.inner.getOpsFloor!() }
  getCheckpointBase() { return this.inner.getCheckpointBase!() }
  pruneOps(u: number, b: Uint8Array) { return this.inner.pruneOps!(u, b) }
}

/** Wrap a store, counting getCheckpointBase reads — so a test can prove a reload
 *  actually re-folded from the base (the fallback ran) rather than the fast path. */
class BaseCountingStore implements EncStore {
  baseReads = 0
  constructor(private readonly inner: EncStore) {}
  async getCheckpointBase(): Promise<Uint8Array | null> {
    this.baseReads++
    return this.inner.getCheckpointBase!()
  }
  listOps(since: number) { return this.inner.listOps(since) }
  getBlob(id: string) { return this.inner.getBlob(id) }
  putBlob(id: string, b: Uint8Array) { return this.inner.putBlob(id, b) }
  deleteBlob(id: string) { return this.inner.deleteBlob(id) }
  appendOp(id: string, b: Uint8Array) { return this.inner.appendOp(id, b) }
  getCheckpoint() { return this.inner.getCheckpoint() }
  putCheckpoint(b: Uint8Array) { return this.inner.putCheckpoint(b) }
  getKeyRecord(): Promise<SpaceKeyRecord | null> { return this.inner.getKeyRecord() }
  putKeyRecord(r: SpaceKeyRecord) { return this.inner.putKeyRecord(r) }
  getOpsFloor() { return this.inner.getOpsFloor!() }
  pruneOps(u: number, b: Uint8Array) { return this.inner.pruneOps!(u, b) }
}

describe('EncryptedFS op-log pruning — correctness', () => {
  it('prunes a checkpoint-folded prefix; a fresh reload converges byte-identically', async () => {
    const store = newStore()
    const key = await newKey()

    // A builds a base checkpoint over an initial history.
    const a = await openFs(store, key, 'A')
    await a.mkdir('docs')
    await a.write('docs/a.md', enc('1'))
    await a.write('docs/b.md', enc('2'))
    await a.sync()
    await a.writeCheckpoint()

    // B seeds from A's checkpoint, adds enough ops to age the base past the
    // margin, then a sync folds them and trips the prune.
    const b = await openFs(store, key, 'B')
    for (let i = 0; i < 8; i++) await b.write(`docs/g${i}.md`, enc(`w${i}`))
    const opsAtPeak = store.opCount() // all ops appended, before the pruning sync
    await b.sync()

    // A prune actually happened: the floor advanced, a base checkpoint exists, and
    // ops were PHYSICALLY deleted from the log.
    const floor = await store.getOpsFloor()
    expect(floor).toBeGreaterThan(0)
    expect(await store.getCheckpointBase()).not.toBeNull()
    expect(store.opCount()).toBeLessThan(opsAtPeak)
    // Every op still in the log sits strictly above the floor.
    for (const op of await store.listOps(0)) expect(op.seq).toBeGreaterThan(floor)
    // `b` folded the ENTIRE history (its checkpoint seed is a faithful fold of the
    // pruned prefix — #105 proves seed == from-scratch), so it is our reference.
    const reference = fp(b.allNodes())

    const c = await openFs(store, key, 'C')
    // Post-prune reload reconstructs the whole tree, pruned prefix included.
    expect(fp(c.allNodes())).toBe(reference)
    expect(names(c)).toContain('a.md')
    expect(names(c)).toContain('b.md')
    expect(c.resolve('docs/g7.md')?.type).toBe('file')
  })

  it('recovers a late op that sorts below the latest checkpoint from the base (no loss)', async () => {
    const store = newStore()
    const key = await newKey()

    const a = await openFs(store, key, 'A')
    await a.mkdir('root')
    for (let i = 0; i < 3; i++) await a.write(`root/a${i}.md`, enc(`a${i}`))
    await a.sync()
    await a.writeCheckpoint() // base-able checkpoint @S0, hi0

    // A slightly-stale writer opened at S0 (clock ~hi0) — it will commit later.
    const d = await openFs(store, key, 'D')

    // B advances the frontier, prunes {seq<=S0}, THEN writes a newer latest
    // checkpoint so its high-water sits ABOVE the base.
    const b = await openFs(store, key, 'B')
    for (let i = 0; i < 10; i++) await b.write(`root/b${i}.md`, enc(`b${i}`))
    await b.sync() // folds + prunes {seq<=S0}; latest checkpoint still @S0
    expect(await store.getOpsFloor()).toBeGreaterThan(0)
    await b.writeCheckpoint() // latest advances to @S1 (hi1 > hi0)

    // D (still at the low clock) commits: its Lamport is ABOVE the base's hi but
    // BELOW the latest checkpoint's hi — the exact realistic-concurrency window.
    await d.write('root/late.md', enc('late'))

    // A fresh reload seeds the LATEST checkpoint, sees late.md sort <= its hi, and
    // re-folds from the BASE — recovering late.md AND the pruned prefix.
    const counting = new BaseCountingStore(store)
    const c = await EncryptedFS.open(counting, key, 'C', { pruneMargin: MARGIN })
    // Prove the fallback actually ran (the base was fetched to re-fold).
    expect(counting.baseReads).toBeGreaterThan(0)
    expect(names(c)).toContain('late.md')
    expect(c.resolve('root/a0.md')?.type).toBe('file') // pruned prefix, via base
    expect(c.resolve('root/b5.md')?.type).toBe('file') // retained
  })

  it('fails LOUD (never diverges) when a pruned-below op appears after pruning', async () => {
    const store = newStore()
    const key = await newKey()

    // A very stale writer opened on the empty store — its clock never advances.
    const stale = await openFs(store, key, 'stale')

    const a = await openFs(store, key, 'A')
    await a.mkdir('root')
    for (let i = 0; i < 12; i++) await a.write(`root/a${i}.md`, enc(`a${i}`))
    await a.sync()
    await a.writeCheckpoint()

    const b = await openFs(store, key, 'B')
    for (let i = 0; i < 12; i++) await b.write(`root/b${i}.md`, enc(`b${i}`))
    await b.sync()
    expect(await store.getOpsFloor()).toBeGreaterThan(0)

    // The stale writer commits with a Lamport far below the pruned floor's hi.
    await stale.write('ancient.md', enc('x'))

    // A reload cannot correctly order the ancient op (its concurrent ops were
    // pruned): it must THROW rather than silently materialize a divergent tree.
    await expect(openFs(store, key, 'C')).rejects.toThrow(VfsError)
    await expect(openFs(store, key, 'C2')).rejects.toThrow(/reconstruct|margin|floor/)
  })

  it('accepts the log starting at the pruned floor, but still throws on a real gap above it', async () => {
    const store = newStore()
    const key = await newKey()

    const a = await openFs(store, key, 'A')
    await a.mkdir('root')
    for (let i = 0; i < 4; i++) await a.write(`root/a${i}.md`, enc(`a${i}`))
    await a.sync()
    await a.writeCheckpoint()

    const b = await openFs(store, key, 'B')
    for (let i = 0; i < 8; i++) await b.write(`root/b${i}.md`, enc(`b${i}`))
    await b.sync() // prunes {seq<=S0}; base@S0 == latest checkpoint @S0
    const floor = await store.getOpsFloor()
    expect(floor).toBeGreaterThan(0)

    // Corrupt the LATEST checkpoint: a reload must fall back to the base@floor and
    // apply the retained log starting at floor+1 — the pruned floor is the
    // legitimate start, NOT a gap.
    await store.putCheckpoint(enc('garbage-not-a-real-checkpoint'))
    const c = await openFs(store, key, 'C')
    expect(names(c)).toContain('a0.md') // pruned prefix recovered via base
    expect(names(c)).toContain('b7.md') // retained
    const reference = fp(c.allNodes())

    // Now a REAL gap in the retained range (a dropped seq above the floor) must
    // still fail loud — the floor only excuses the pruned prefix, nothing above.
    const gapStore = new GapStore(store, floor + 2)
    await expect(EncryptedFS.open(gapStore, key, 'D', { pruneMargin: MARGIN })).rejects.toThrow(/gap/)

    // And the un-gapped reload remains stable/deterministic.
    const c2 = await openFs(store, key, 'C2')
    expect(fp(c2.allNodes())).toBe(reference)
  })

  it('reconciles a client whose position falls below an advanced floor (floor > lastSeq)', async () => {
    const store = newStore()
    const key = await newKey()

    const a = await openFs(store, key, 'A')
    await a.mkdir('root')
    for (let i = 0; i < 6; i++) await a.write(`root/a${i}.md`, enc(`a${i}`))
    await a.sync()
    await a.writeCheckpoint() // cpA @S0

    // X loads from cpA and then sits idle (its lastSeq stays at S0).
    const x = await openFs(store, key, 'X')

    // B advances one generation and writes cpB, pruning to S0.
    const b = await openFs(store, key, 'B')
    for (let i = 0; i < 8; i++) await b.write(`root/b${i}.md`, enc(`b${i}`))
    await b.sync()
    await b.writeCheckpoint() // cpB @S1

    // C advances another generation, pruning to S1 — now floor > X.lastSeq(S0).
    const c = await openFs(store, key, 'C')
    for (let i = 0; i < 8; i++) await c.write(`root/c${i}.md`, enc(`c${i}`))
    await c.sync() // prunes {seq<=S1}; base becomes cpB@S1
    expect(await store.getOpsFloor()).toBeGreaterThan(0)

    // X syncs: the floor has advanced past its position, so listOps(lastSeq) would
    // start above lastSeq+1. Instead of a false gap, X rebuilds from the base and
    // converges to C's full state — no op lost across the prune.
    await x.sync()
    expect(fp(x.allNodes())).toBe(fp(c.allNodes()))
    expect(names(x)).toContain('a0.md')
    expect(names(x)).toContain('b0.md')
    expect(names(x)).toContain('c0.md')
  })

  it('the in-memory store refuses an unsafe (non-clean-cut) prune, mirroring the server', async () => {
    // Directly probe the fake's blind safety cuts so the client tests above can
    // trust it behaves like the Go server. Craft framed ops with explicit
    // Lamports: a stale low-Lamport op sits in the RETAINED range.
    const store = new InMemoryEncStore({ pruneMargin: 1 })
    const frame = (lamport: number): Uint8Array => {
      const meta = new TextEncoder().encode(JSON.stringify({ opId: 'x', lamport, actorId: 'd' }))
      const out = new Uint8Array(4 + meta.length + 1)
      new DataView(out.buffer).setUint32(0, meta.length, false)
      out.set(meta, 4)
      return out
    }
    // seq 1..3 Lamports 1,2,3; seq 4 is a STALE op with Lamport 2 (<= max pruned).
    for (const [i, lam] of [1, 2, 3, 2, 50].entries()) {
      await store.appendOp(`${(i + 1).toString(16).padStart(8, '0')}`, frame(lam))
    }
    await store.putCheckpoint(enc('cp'))

    // upTo=3 has max pruned Lamport 3, but the retained op at seq 4 has Lamport 2
    // (< 3) → not a clean cut → refused (floor stays 0, nothing deleted).
    const res = await store.pruneOps(3, enc('base'))
    expect(res.floor).toBe(0)
    expect(await store.getOpsFloor()).toBe(0)
    expect(await store.getCheckpointBase()).toBeNull()
  })
})
