/**
 * EncStore — the transport the encrypted filesystem persists to.
 *
 * It is the client-side mirror of the Phase 3a *blind* server store
 * (`backend/internal/space/enc.go`): opaque ciphertext content blobs, an
 * append-only op-log the server sequences with a monotonic `seq`, a single
 * checkpoint blob, and the non-secret {@link SpaceKeyRecord}. Nothing here
 * decrypts anything — the store only ever moves bytes, so the server (and any
 * `EncStore`) stays zero-knowledge.
 *
 * Two implementations exist:
 *   - {@link InMemoryEncStore} — a faithful fake with the SAME semantics as the
 *     Go server (server-assigned monotonic seq, `seq > since` slicing, id
 *     validation). Used by the tests; no network.
 *   - {@link HttpEncStore} (see `./httpEncStore`) — the real `fetch` client.
 */
import { isSafeId } from './ids'
import type { SpaceKeyRecord } from '../crypto/space'

/** One op-log entry as the store hands it back (mirrors the server's OpRecord). */
export interface StoredOp {
  /** Server-assigned monotonic sequence number (ascending, gap-free per space). */
  seq: number
  /** Cleartext op id (the log's server-side ordering handle). */
  opId: string
  /** The sealed op envelope bytes exactly as they were appended. */
  blob: Uint8Array
}

/**
 * The persistence surface {@link EncryptedFS} drives. Every method is async so
 * the in-memory fake and the HTTP client are interchangeable. All byte payloads
 * are opaque ciphertext; `getX` returns `null` when the object does not exist
 * (the server's 404), never throwing for absence.
 */
export interface EncStore {
  /** Raw ciphertext of a content blob, or `null` if it does not exist. */
  getBlob(id: string): Promise<Uint8Array | null>
  /** Store (overwrite) a content blob's ciphertext. */
  putBlob(id: string, bytes: Uint8Array): Promise<void>
  /** Remove a content blob (no-op if already absent). */
  deleteBlob(id: string): Promise<void>

  /** Append one sealed op; the store assigns and returns its monotonic seq. */
  appendOp(opId: string, sealedBytes: Uint8Array): Promise<{ seq: number }>
  /** Every op with `seq > sinceSeq`, ascending by seq. */
  listOps(sinceSeq: number): Promise<StoredOp[]>

  /** The latest encrypted checkpoint blob, or `null` if none has been written. */
  getCheckpoint(): Promise<Uint8Array | null>
  /** Overwrite the single checkpoint blob. */
  putCheckpoint(bytes: Uint8Array): Promise<void>

  /** The stored {@link SpaceKeyRecord}, or `null` if none. */
  getKeyRecord(): Promise<SpaceKeyRecord | null>
  /** Persist the (non-secret) {@link SpaceKeyRecord}. */
  putKeyRecord(record: SpaceKeyRecord): Promise<void>

  // ── op-log pruning (optional) ─────────────────────────────────────────────
  //
  // A store that bounds op-log growth implements these; one that does not (older
  // fakes, test wrappers) omits them, and {@link EncryptedFS} treats their
  // absence as "never pruned" (floor 0, no base) — i.e. the whole log is always
  // present, exactly the pre-pruning behavior.

  /** The highest pruned seq (the log is served from `floor + 1`); 0 if never
   *  pruned. A client trusts this as the log's legitimate start so a deliberate
   *  prune is not mistaken for a truncating server. */
  getOpsFloor?(): Promise<number>
  /** The durable prune-base checkpoint — the snapshot folding EXACTLY the pruned
   *  prefix ({@link StoredOp} with `seq <= floor}`), or `null` if never pruned. A
   *  re-fold of the retained log seeds from this. */
  getCheckpointBase?(): Promise<Uint8Array | null>
  /** Ask the store to prune ops with `seq <= upToSeq`, installing `base` (which
   *  MUST fold exactly that prefix) as the fallback seed. Conservative and
   *  idempotent: the store enforces the causal-safety cuts and returns the
   *  resulting `floor` — unchanged when it refused the prune as unsafe/stale. */
  pruneOps?(upToSeq: number, base: Uint8Array): Promise<{ floor: number }>
}

/**
 * Read the cleartext framing Lamport of a sealed op envelope WITHOUT decrypting
 * (`uint32-BE metaLen || meta JSON || ciphertext`). The client binds this meta as
 * AES-GCM AAD, so a tampered value fails every reader's decrypt — the value here
 * is the one the op's author committed to. `null` on malformed framing. This is
 * the same peek the Go server does to judge prune safety blindly.
 */
export function peekEnvelopeLamport(blob: Uint8Array): number | null {
  if (blob.length < 4) return null
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const metaLen = dv.getUint32(0, false)
  if (blob.length < 4 + metaLen) return null
  try {
    const meta = JSON.parse(new TextDecoder().decode(blob.subarray(4, 4 + metaLen)))
    return typeof meta.lamport === 'number' ? meta.lamport : null
  } catch {
    return null
  }
}

/** Defensive copy so callers can't mutate a store's internal buffers. */
const copy = (b: Uint8Array): Uint8Array => b.slice()

/**
 * In-memory {@link EncStore} with the same observable semantics as the Go
 * blind store, for deterministic, network-free tests:
 *
 *   - `appendOp` hands out a monotonic seq starting at 1 (matching the server's
 *     `maxSeq + 1`), so two appends never collide and ordering is total.
 *   - `listOps(since)` returns exactly the entries with `seq > since`, ascending.
 *   - opaque ids are validated against the same charset the server enforces.
 *   - every payload is stored/served as a private copy (no aliasing).
 */
export class InMemoryEncStore implements EncStore {
  private readonly blobs = new Map<string, Uint8Array>()
  private opsLog: StoredOp[] = []
  private nextSeq = 1
  private checkpoint: Uint8Array | null = null
  private checkpointBase: Uint8Array | null = null
  private opsFloor = 0
  private keyRecord: SpaceKeyRecord | null = null
  /** Causal-stability margin the fake enforces, mirroring the Go server's
   *  {@link space.PruneLamportMargin}. Lowered by tests for speed. */
  private readonly pruneMargin: number

  constructor(opts?: { pruneMargin?: number }) {
    this.pruneMargin = opts?.pruneMargin ?? 500
  }

  private static assertId(id: string): void {
    // Mirror the server's ValidEncID gate (8–64 hex): a bad id is a 400, never
    // silently accepted.
    if (!isSafeId(id)) throw new Error(`encstore: invalid opaque id ${JSON.stringify(id)}`)
  }

  async getBlob(id: string): Promise<Uint8Array | null> {
    InMemoryEncStore.assertId(id)
    const b = this.blobs.get(id)
    return b ? copy(b) : null
  }

  async putBlob(id: string, bytes: Uint8Array): Promise<void> {
    InMemoryEncStore.assertId(id)
    this.blobs.set(id, copy(bytes))
  }

  async deleteBlob(id: string): Promise<void> {
    InMemoryEncStore.assertId(id)
    this.blobs.delete(id)
  }

  async appendOp(opId: string, sealedBytes: Uint8Array): Promise<{ seq: number }> {
    InMemoryEncStore.assertId(opId)
    const seq = this.nextSeq++
    this.opsLog.push({ seq, opId, blob: copy(sealedBytes) })
    return { seq }
  }

  async listOps(sinceSeq: number): Promise<StoredOp[]> {
    return this.opsLog
      .filter((o) => o.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq)
      .map((o) => ({ seq: o.seq, opId: o.opId, blob: copy(o.blob) }))
  }

  async getCheckpoint(): Promise<Uint8Array | null> {
    return this.checkpoint ? copy(this.checkpoint) : null
  }

  async putCheckpoint(bytes: Uint8Array): Promise<void> {
    this.checkpoint = copy(bytes)
  }

  async getKeyRecord(): Promise<SpaceKeyRecord | null> {
    return this.keyRecord
  }

  async putKeyRecord(record: SpaceKeyRecord): Promise<void> {
    this.keyRecord = record
  }

  async getOpsFloor(): Promise<number> {
    return this.opsFloor
  }

  async getCheckpointBase(): Promise<Uint8Array | null> {
    return this.checkpointBase ? copy(this.checkpointBase) : null
  }

  /**
   * Prune ops with `seq <= upToSeq`, mirroring the Go server's blind safety
   * checks EXACTLY (so the fake proves the real end-to-end behavior):
   *   - a latest checkpoint must exist,
   *   - the request must advance the floor (`upToSeq > floor`),
   *   - CLEAN CUT: max Lamport of the pruned prefix < min Lamport of the retained
   *     suffix (Lamport is the CRDT's primary order key),
   *   - MARGIN: max pruned Lamport <= frontier - pruneMargin.
   * On any failure it is a NO-OP returning the current floor. Commit order
   * base → floor → delete matches the server.
   */
  async pruneOps(upToSeq: number, base: Uint8Array): Promise<{ floor: number }> {
    if (this.checkpoint == null) return { floor: this.opsFloor }
    if (upToSeq <= this.opsFloor) return { floor: this.opsFloor }
    let maxPruned = -1
    let minRetained = -1
    let frontier = -1
    let sawPruned = false
    let sawRetained = false
    for (const o of this.opsLog) {
      const lam = peekEnvelopeLamport(o.blob)
      if (lam == null) return { floor: this.opsFloor } // can't verify → refuse
      if (lam > frontier) frontier = lam
      if (o.seq <= upToSeq) {
        sawPruned = true
        if (lam > maxPruned) maxPruned = lam
      } else {
        sawRetained = true
        if (minRetained < 0 || lam < minRetained) minRetained = lam
      }
    }
    if (!sawPruned) return { floor: this.opsFloor }
    if (sawRetained && maxPruned >= minRetained) return { floor: this.opsFloor }
    if (maxPruned > frontier - this.pruneMargin) return { floor: this.opsFloor }
    this.checkpointBase = copy(base)
    this.opsFloor = upToSeq
    this.opsLog = this.opsLog.filter((o) => o.seq > upToSeq)
    return { floor: upToSeq }
  }

  // ---- test/inspection helpers (not part of EncStore) ----

  /** Number of ops in the log — for asserting an op was (not) appended. */
  opCount(): number {
    return this.opsLog.length
  }

  /** Number of content blobs stored. */
  blobCount(): number {
    return this.blobs.size
  }

  /**
   * Every opaque byte payload the store holds (content blobs + op envelopes +
   * checkpoint). Used to prove no plaintext ever reaches the store.
   */
  allStoredBytes(): Uint8Array[] {
    const out: Uint8Array[] = []
    for (const b of this.blobs.values()) out.push(b)
    for (const o of this.opsLog) out.push(o.blob)
    if (this.checkpoint) out.push(this.checkpoint)
    if (this.checkpointBase) out.push(this.checkpointBase)
    return out
  }
}
