/**
 * EncryptedFS — the zero-knowledge {@link SpaceFS} backend (Phase 3b).
 *
 * It stitches together the three earlier phases against a blind {@link EncStore}:
 *
 *   - **crypto** (Phase 1): content is `encryptBlob`/`decryptBlob`; structural
 *     ops are sealed/opened with {@link sealOpBytes}/{@link openOpBytes}.
 *   - **CRDT** (Phase 2): structural ops fold through a {@link TreeReplica} so
 *     concurrent edits from several devices converge to the byte-identical tree.
 *   - **store protocol** (Phase 3a): sealed ops append to a server-sequenced
 *     log; ciphertext content lives in opaque blobs.
 *
 * The server only ever sees sealed op bytes and ciphertext blobs — never a
 * plaintext name, path, or byte of content.
 *
 * ── Path model ──────────────────────────────────────────────────────────────
 * Paths are logical, `/`-separated, rooted (no leading slash, no `.`/`..`), and
 * resolved by walking names from {@link ROOT_ID} through the materialized tree.
 * A name collides only within its parent directory. When two *live* siblings
 * share a name, resolution is deterministic: it picks the earliest-created one
 * (tie-broken by nodeId) — exactly the order {@link TreeReplica.materialize}
 * emits, so every replica resolves a path to the same node. A node is visible
 * (in {@link tree} and for lookups) iff its parent chain reaches ROOT without
 * passing through {@link TRASH_ID}; a soft-deleted subtree therefore vanishes
 * from paths but is never dropped.
 *
 * ── Lamport seeding ─────────────────────────────────────────────────────────
 * On every sync the clock is advanced past the highest lamport observed in the
 * batch (a single {@link LamportClock.observe}), so newly issued local ops sort
 * strictly after everything the replica has seen — the precondition for the
 * CRDT's total order.
 */
import { ROOT_ID, TRASH_ID } from './nodes'
import type { Node, NodeType } from './nodes'
import type { CreateOp, DeleteOp, MoveOp, Op, RenameOp } from './ops'
import { LamportClock, TreeReplica } from './crdt'
import { newBlobId, newNodeId, newOpId } from './ids'
import { sealOp, openOp } from './opCrypto'
import type { EncryptedOpEnvelope, LogRecord } from './opCrypto'
import {
  CommentLog,
  isCommentOp,
  newCommentId,
  type CommentAddOp,
  type CommentAnchor,
  type CommentDeleteOp,
  type CommentLogSnapshot,
  type CommentOp,
  type EncComment,
} from './commentLog'
import type { EncStore } from './encStore'
import type { SpaceFS } from './spacefs'
import type { KeyHandle } from '../crypto/keys'
import type { SpaceKeyRecord } from '../crypto/space'
import { decryptBlob, encryptBlob } from '../crypto/blob'
import { utf8Decode, utf8Encode } from '../crypto/bytes'

/** A decoded log record is either a structural tree op or a comment op. */
type LogEntryRecord = Op | CommentOp

// ── typed errors ────────────────────────────────────────────────────────────

/** Base class for filesystem-level failures. */
export class VfsError extends Error {}

/** A path (or node) that does not resolve to a live node. */
export class VfsNotFoundError extends VfsError {
  constructor(target: string) {
    super(`vfs: not found: ${target}`)
    this.name = 'VfsNotFoundError'
  }
}

/** A structural request that cannot be honored (e.g. a file where a dir is needed). */
export class VfsConflictError extends VfsError {
  constructor(message: string) {
    super(message)
    this.name = 'VfsConflictError'
  }
}

/** A comment reply that cannot be honored (parent missing/nested/other file). */
export class VfsCommentError extends VfsError {
  constructor(message: string) {
    super(message)
    this.name = 'VfsCommentError'
  }
}

// ── sealed-op wire framing ──────────────────────────────────────────────────
//
// The store moves opaque op bytes; the op's ordering metadata (opId, lamport,
// actorId) must survive alongside the ciphertext so a reader can rebuild the
// AAD before decrypting. We frame the {@link EncryptedOpEnvelope} as:
//
//     uint32-BE metaLen || meta(JSON: {opId,lamport,actorId}) || ciphertext
//
// The meta is cleartext (this is the same metadata the server sequences the log
// by) — so a peer can read a sealed op's lamport WITHOUT the key, which lets a
// checkpoint skip already-folded ops without decrypting them. The body stays
// encrypted and the meta is bound into it as AAD (see opCrypto), so it can't be
// swapped.

interface EnvelopeMeta {
  opId: string
  lamport: number
  actorId: string
}

/** Frame an envelope into self-describing wire bytes. */
function encodeEnvelope(env: EncryptedOpEnvelope): Uint8Array {
  const meta = utf8Encode(JSON.stringify({ opId: env.opId, lamport: env.lamport, actorId: env.actorId }))
  const out = new Uint8Array(4 + meta.length + env.ciphertext.length)
  new DataView(out.buffer).setUint32(0, meta.length, false)
  out.set(meta, 4)
  out.set(env.ciphertext, 4 + meta.length)
  return out
}

/** Split framed bytes into cleartext meta + ciphertext, WITHOUT decrypting. */
function peekEnvelope(bytes: Uint8Array): { meta: EnvelopeMeta; ciphertext: Uint8Array } {
  if (bytes.length < 4) throw new VfsError('vfs: truncated op envelope')
  const metaLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)
  if (bytes.length < 4 + metaLen) throw new VfsError('vfs: truncated op envelope')
  const meta = JSON.parse(utf8Decode(bytes.subarray(4, 4 + metaLen))) as EnvelopeMeta
  return { meta, ciphertext: bytes.subarray(4 + metaLen) }
}

/** Seal a log record into transport bytes (envelope framing over {@link sealOp}). */
export async function sealOpBytes<T extends LogRecord>(op: T, key: KeyHandle): Promise<Uint8Array> {
  return encodeEnvelope(await sealOp(op, key))
}

/** Open transport bytes back into a log record ({@link openOp} over the framing). */
export async function openOpBytes<T extends LogRecord = Op>(bytes: Uint8Array, key: KeyHandle): Promise<T> {
  const { meta, ciphertext } = peekEnvelope(bytes)
  return openOp<T>({ ...meta, ciphertext }, key)
}

// ── checkpoint envelope ─────────────────────────────────────────────────────

interface CheckpointData {
  /** Ops with lamport <= this are already folded into {@link nodes}/{@link comments}. */
  lamport: number
  nodes: Node[]
  /** Comment-log state at the same high-water mark (optional for old checkpoints). */
  comments?: CommentLogSnapshot
}

async function sealCheckpoint(cp: CheckpointData, key: KeyHandle): Promise<Uint8Array> {
  return encryptBlob(utf8Encode(JSON.stringify(cp)), key)
}

async function openCheckpoint(bytes: Uint8Array, key: KeyHandle): Promise<CheckpointData> {
  return JSON.parse(utf8Decode(await decryptBlob(bytes, key))) as CheckpointData
}

// ── EncryptedFS ─────────────────────────────────────────────────────────────

/** Content blobs bind their own blobId as AAD, so ciphertext can't be swapped. */
const blobAad = (blobId: string): Uint8Array => utf8Encode(blobId)

export class EncryptedFS implements SpaceFS {
  private readonly replica = new TreeReplica()
  /** Comments fold through their own reducer over the SAME sealed op-log. */
  private readonly commentLog = new CommentLog()
  private readonly clock: LamportClock
  private nodesList: Node[] = []
  private byId = new Map<string, Node>()
  private childrenByParent = new Map<string, Node[]>()
  /** High-water seq consumed from the store; the next sync fetches `> lastSeq`. */
  private lastSeq = 0
  /** Highest lamport folded into the replica (local ticks + remote ops). */
  private maxLamport = 0
  /** Ops at or below this lamport are already in the checkpoint seed. */
  private checkpointLamport = 0
  /** The (non-secret) key record, if the space has one persisted. */
  keyRecord: SpaceKeyRecord | null = null

  constructor(
    private readonly store: EncStore,
    private readonly key: KeyHandle,
    readonly actorId: string,
  ) {
    this.clock = new LamportClock(actorId)
  }

  /** Construct and load in one step. */
  static async open(store: EncStore, key: KeyHandle, actorId: string): Promise<EncryptedFS> {
    const fs = new EncryptedFS(store, key, actorId)
    await fs.load()
    return fs
  }

  /**
   * Load initial state: fetch the key record, seed from a checkpoint if one
   * exists, then pull and replay the op-log.
   */
  async load(): Promise<void> {
    this.keyRecord = await this.store.getKeyRecord()
    const cpBytes = await this.store.getCheckpoint()
    if (cpBytes) {
      const cp = await openCheckpoint(cpBytes, this.key)
      this.replica.seed(cp.nodes)
      if (cp.comments) this.commentLog.seed(cp.comments)
      this.checkpointLamport = cp.lamport
      this.maxLamport = Math.max(this.maxLamport, cp.lamport)
    }
    await this.sync()
  }

  /**
   * Pull new remote ops (`seq > lastSeq`), open and fold them into the CRDT,
   * then re-materialize. Idempotent: our own just-applied ops come back and are
   * deduped by opId, so a full re-fetch is never needed. Because the CRDT
   * converges, local-then-remote and remote-then-local yield the same tree.
   */
  async sync(): Promise<void> {
    const stored = await this.store.listOps(this.lastSeq)
    const treeOps: Op[] = []
    const commentOps: CommentOp[] = []
    let batchMax = 0
    for (const s of stored) {
      this.lastSeq = Math.max(this.lastSeq, s.seq)
      const { meta } = peekEnvelope(s.blob)
      // Ops already folded into the checkpoint seed carry no new information.
      if (meta.lamport <= this.checkpointLamport) continue
      const rec = await openOpBytes<LogEntryRecord>(s.blob, this.key)
      // One shared log carries two op families; route by the decrypted `type`.
      if (isCommentOp(rec)) commentOps.push(rec)
      else treeOps.push(rec)
      if (rec.lamport > batchMax) batchMax = rec.lamport
    }
    const applied = treeOps.length + commentOps.length
    if (applied > 0) {
      if (treeOps.length > 0) this.replica.applyAll(treeOps)
      if (commentOps.length > 0) this.commentLog.applyAll(commentOps)
      this.maxLamport = Math.max(this.maxLamport, batchMax)
      // Advance the clock past everything seen so local ops sort strictly after.
      this.clock.observe(batchMax)
      this.materialize()
    } else if (this.nodesList.length === 0) {
      // First load with no ops: materialize the (possibly checkpoint-seeded) tree.
      this.materialize()
    }
  }

  /**
   * Write a compaction checkpoint: the current materialized tree at the current
   * lamport high-water. A later {@link load} can seed from it and skip opening
   * every op at or below that lamport. Opt-in — {@link EncryptedFS} never writes
   * one automatically.
   */
  async writeCheckpoint(): Promise<void> {
    const cp: CheckpointData = {
      lamport: this.maxLamport,
      nodes: this.replica.materialize(),
      comments: this.commentLog.snapshot(),
    }
    await this.store.putCheckpoint(await sealCheckpoint(cp, this.key))
  }

  // ── SpaceFS surface ──────────────────────────────────────────────────────

  /** Visible nodes: everything reachable from ROOT (trash subtree excluded). */
  tree(): Node[] {
    return this.nodesList.filter((n) => this.isVisible(n.nodeId))
  }

  /**
   * The full materialized node set, INCLUDING trashed/orphaned nodes. For
   * inspection (e.g. confirming a soft-delete landed in trash); {@link tree} is
   * the visible-only view callers render.
   */
  allNodes(): Node[] {
    return [...this.nodesList]
  }

  async read(path: string): Promise<Uint8Array> {
    const node = this.resolvePath(path)
    if (!node || node.type !== 'file' || !node.blobId) throw new VfsNotFoundError(path)
    const cipher = await this.store.getBlob(node.blobId)
    if (!cipher) throw new VfsNotFoundError(path)
    return decryptBlob(cipher, this.key, blobAad(node.blobId))
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const segs = this.segments(path)
    if (segs.length === 0) throw new VfsConflictError('vfs: cannot write to root')
    const name = segs[segs.length - 1]

    const existing = this.resolvePath(path)
    if (existing) {
      if (existing.type !== 'file' || !existing.blobId) {
        throw new VfsConflictError(`vfs: not a file: ${path}`)
      }
      // Content overwrite: reuse the blobId and append NO op — the structure is
      // unchanged, only the ciphertext behind an existing node.
      await this.store.putBlob(existing.blobId, await encryptBlob(data, this.key, blobAad(existing.blobId)))
      return
    }

    // New file: create missing parents, put the blob, THEN append the Create op
    // (so the node only becomes visible once its content exists).
    const parentId = await this.ensureDir(segs.slice(0, -1))
    const nodeId = newNodeId()
    const blobId = newBlobId()
    await this.store.putBlob(blobId, await encryptBlob(data, this.key, blobAad(blobId)))
    await this.commit(this.mkCreate(nodeId, parentId, name, 'file', blobId))
  }

  async mkdir(path: string): Promise<void> {
    // ensureDir creates every missing segment as a directory (idempotent).
    await this.ensureDir(this.segments(path))
  }

  async rename(from: string, to: string): Promise<void> {
    const node = this.resolvePath(from)
    if (!node) throw new VfsNotFoundError(from)
    const toSegs = this.segments(to)
    if (toSegs.length === 0) throw new VfsConflictError('vfs: cannot rename to root')
    const toName = toSegs[toSegs.length - 1]
    const toParentId = await this.ensureDir(toSegs.slice(0, -1))

    // A cross-directory rename is a Move (reparent) plus, if the leaf name also
    // changed, a Rename. Duplicate target names are allowed and resolve
    // deterministically; rename never destroys an existing target.
    if (toParentId !== node.parentId) {
      await this.commit(this.mkMove(node.nodeId, toParentId))
    }
    const current = this.byId.get(node.nodeId)
    if (current && current.name !== toName) {
      await this.commit(this.mkRename(node.nodeId, toName))
    }
  }

  async move(nodeId: string, newParentId: string): Promise<void> {
    if (!this.byId.has(nodeId)) throw new VfsNotFoundError(nodeId)
    if (newParentId !== ROOT_ID && newParentId !== TRASH_ID) {
      const parent = this.byId.get(newParentId)
      if (!parent || parent.type !== 'dir') {
        throw new VfsConflictError(`vfs: invalid move target: ${newParentId}`)
      }
    }
    await this.commit(this.mkMove(nodeId, newParentId))
  }

  async remove(path: string): Promise<void> {
    const node = this.resolvePath(path)
    if (!node) throw new VfsNotFoundError(path)
    await this.commit(this.mkDelete(node.nodeId))
  }

  // ── comments ──────────────────────────────────────────────────────────────
  //
  // Comments ride the same sealed op-log as structure but fold through a
  // separate {@link CommentLog}. They reference their file by nodeId (never a
  // path), so the server learns nothing about which file — or what — is
  // commented on. The admin UI resolves nodeId → path via {@link pathOf}.

  /** Every visible comment in the space (nodeId-referenced, not path). */
  comments(): EncComment[] {
    return this.commentLog.materialize()
  }

  /** Visible comments anchored to one file node. */
  commentsForNode(nodeId: string): EncComment[] {
    return this.commentLog.materialize().filter((c) => c.nodeId === nodeId)
  }

  /**
   * Append a comment to the file identified by `nodeId`. Reply semantics mirror
   * the plaintext server store: a reply's parent must exist, live on the same
   * node, and itself be top-level (no nesting past one level).
   */
  async addComment(
    nodeId: string,
    input: { text: string; author: string; parentId?: string; anchor?: CommentAnchor; createdAt?: string },
  ): Promise<EncComment> {
    const text = input.text.trim()
    if (!text) throw new VfsError('vfs: comment text required')
    if (input.parentId) {
      const parent = this.commentLog.materialize().find((c) => c.id === input.parentId)
      if (!parent) throw new VfsCommentError('parent comment not found')
      if (parent.parentId) throw new VfsCommentError('replies cannot be nested further')
      if (parent.nodeId !== nodeId) throw new VfsCommentError('parent comment is on a different file')
    }
    const comment: EncComment = {
      id: newCommentId(),
      parentId: input.parentId || undefined,
      nodeId,
      // A migrated comment keeps its original time; a fresh one is stamped now.
      createdAt: input.createdAt ?? new Date().toISOString(),
      author: input.author,
      text,
      anchor: input.anchor,
    }
    await this.commitComment(this.mkCommentAdd(comment))
    return comment
  }

  /**
   * Tombstone a comment. Deleting a top-level entry cascades to its replies
   * (each is tombstoned too), matching the server's delete semantics.
   */
  async deleteComment(commentId: string): Promise<void> {
    const live = this.commentLog.materialize()
    const target = live.find((c) => c.id === commentId)
    const ids = [commentId]
    if (target && !target.parentId) {
      for (const c of live) if (c.parentId === commentId) ids.push(c.id)
    }
    for (const id of ids) await this.commitComment(this.mkCommentDelete(id))
  }

  // ── path helpers (public, handy for callers/tests) ────────────────────────

  /** Resolve a logical path to its live node, or `undefined`. */
  resolve(path: string): Node | undefined {
    return this.resolvePath(path)
  }

  /** The nodeId a path resolves to, or `undefined`. */
  idAt(path: string): string | undefined {
    return this.resolvePath(path)?.nodeId
  }

  /** The logical path of a live node, or `undefined` if it is trashed/orphaned. */
  pathOf(nodeId: string): string | undefined {
    const parts: string[] = []
    let cursor = nodeId
    const seen = new Set<string>()
    while (cursor !== ROOT_ID) {
      if (cursor === TRASH_ID || seen.has(cursor)) return undefined
      seen.add(cursor)
      const n = this.byId.get(cursor)
      if (!n) return undefined
      parts.unshift(n.name)
      cursor = n.parentId
    }
    return parts.join('/')
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private segments(path: string): string[] {
    const segs = path.split('/').filter(Boolean)
    for (const s of segs) {
      if (s === '.' || s === '..') throw new VfsError(`vfs: illegal path segment ${JSON.stringify(s)}`)
    }
    return segs
  }

  /** Rebuild the node index + children map from the freshly materialized set. */
  private materialize(): void {
    this.nodesList = this.replica.materialize()
    this.byId = new Map(this.nodesList.map((n) => [n.nodeId, n]))
    this.childrenByParent = new Map()
    for (const n of this.nodesList) {
      const arr = this.childrenByParent.get(n.parentId)
      if (arr) arr.push(n)
      else this.childrenByParent.set(n.parentId, [n])
    }
  }

  /** A node is visible iff its parent chain reaches ROOT without hitting trash. */
  private isVisible(nodeId: string): boolean {
    let cursor: string | undefined = nodeId
    const seen = new Set<string>()
    while (cursor !== ROOT_ID) {
      if (cursor === undefined || cursor === TRASH_ID || seen.has(cursor)) return false
      seen.add(cursor)
      cursor = this.byId.get(cursor)?.parentId
    }
    return true
  }

  /**
   * The visible child of `parentId` named `name`. `childrenByParent` preserves
   * materialize order (createdAt, nodeId), so `.find` deterministically returns
   * the earliest-created match when names collide.
   */
  private childByName(parentId: string, name: string): Node | undefined {
    const kids = this.childrenByParent.get(parentId)
    if (!kids) return undefined
    return kids.find((n) => n.name === name && this.isVisible(n.nodeId))
  }

  private resolvePath(path: string): Node | undefined {
    const segs = this.segments(path)
    if (segs.length === 0) return undefined // ROOT is not a Node
    let parentId = ROOT_ID
    let node: Node | undefined
    for (const seg of segs) {
      node = this.childByName(parentId, seg)
      if (!node) return undefined
      parentId = node.nodeId
    }
    return node
  }

  /**
   * Walk `segs` from ROOT, creating any missing directory as a Create op, and
   * return the id of the final directory (ROOT_ID for an empty path). Throws if
   * a segment already exists as a file.
   */
  private async ensureDir(segs: string[]): Promise<string> {
    let parentId = ROOT_ID
    for (const seg of segs) {
      const existing = this.childByName(parentId, seg)
      if (existing) {
        if (existing.type !== 'dir') throw new VfsConflictError(`vfs: path segment is a file: ${seg}`)
        parentId = existing.nodeId
      } else {
        const nodeId = newNodeId()
        await this.commit(this.mkCreate(nodeId, parentId, seg, 'dir'))
        parentId = nodeId
      }
    }
    return parentId
  }

  /** Seal, append to the store, apply locally, and re-materialize. */
  private async commit(op: Op): Promise<void> {
    const sealed = await sealOpBytes(op, this.key)
    await this.store.appendOp(op.opId, sealed)
    this.replica.apply(op)
    this.maxLamport = Math.max(this.maxLamport, op.lamport)
    this.materialize()
  }

  private mkCreate(nodeId: string, parentId: string, name: string, nodeType: NodeType, blobId?: string): CreateOp {
    return { type: 'create', opId: newOpId(), nodeId, parentId, name, nodeType, blobId, lamport: this.clock.tick(), actorId: this.actorId }
  }

  private mkRename(nodeId: string, name: string): RenameOp {
    return { type: 'rename', opId: newOpId(), nodeId, name, lamport: this.clock.tick(), actorId: this.actorId }
  }

  private mkMove(nodeId: string, newParentId: string): MoveOp {
    return { type: 'move', opId: newOpId(), nodeId, newParentId, lamport: this.clock.tick(), actorId: this.actorId }
  }

  private mkDelete(nodeId: string): DeleteOp {
    return { type: 'delete', opId: newOpId(), nodeId, lamport: this.clock.tick(), actorId: this.actorId }
  }

  /** Seal a comment op, append to the store, and fold it into the comment log. */
  private async commitComment(op: CommentOp): Promise<void> {
    const sealed = await sealOpBytes(op, this.key)
    await this.store.appendOp(op.opId, sealed)
    this.commentLog.apply(op)
    this.maxLamport = Math.max(this.maxLamport, op.lamport)
  }

  private mkCommentAdd(comment: EncComment): CommentAddOp {
    return { type: 'comment-add', opId: newOpId(), comment, lamport: this.clock.tick(), actorId: this.actorId }
  }

  private mkCommentDelete(commentId: string): CommentDeleteOp {
    return { type: 'comment-delete', opId: newOpId(), commentId, lamport: this.clock.tick(), actorId: this.actorId }
  }
}
