/**
 * Encrypted comment log — the zero-knowledge counterpart to the plaintext
 * server-side `CommentStore` (`backend/internal/share/comments.go`).
 *
 * For a plaintext space, comments live in `<space>/.notation/comments.jsonl`
 * with the file PATH, author, text and anchor quote all in the clear — which
 * leaks structure and content to anyone who can read the disk/backups. For an
 * encrypted space that is unacceptable, so comments instead ride the same
 * append-only, end-to-end-encrypted op-log the filesystem structure uses:
 *
 *   - Each comment references its file by the stable CRDT {@link Node} id, NOT a
 *     plaintext path. The admin UI resolves nodeId → path locally for display.
 *   - `comment-add` / `comment-delete` ops are sealed exactly like structural
 *     ops ({@link ../vfs/opCrypto}); the server only ever sees ciphertext plus
 *     the cleartext ordering metadata (opId, lamport, actorId) it sequences by.
 *
 * Convergence: like the tree CRDT, the log is fed the FULL op set in any order
 * and folds to the same result. Adds are keyed by a unique comment id (so they
 * are idempotent); deletes are tombstones (so a delete that is observed before
 * its add still wins). Replies whose parent is gone are hidden at materialize
 * time, mirroring the server's cascade-on-delete.
 */
import type { LogRecord } from './opCrypto'

/**
 * Anchor pins a comment to a text range using the W3C Web Annotation
 * "TextQuoteSelector" pattern — identical shape to the plaintext store's
 * `Anchor`, so migrated comments and the UI need no translation.
 */
export interface CommentAnchor {
  quote: string
  prefix: string
  suffix: string
}

/**
 * A comment in an encrypted space. It is the plaintext {@link EncComment}
 * BEFORE sealing — it never reaches the server except inside an encrypted op
 * body. `nodeId` (not a path) ties it to its file so nothing structural leaks.
 */
export interface EncComment {
  /** Stable comment id (`c_`-prefixed, matching the plaintext store's shape). */
  id: string
  /** Set on replies: the top-level comment this answers (one level only). */
  parentId?: string
  /** The file's stable CRDT node id — resolved to a path by the UI. */
  nodeId: string
  /** Wall-clock creation time (ISO 8601), for display + sort. */
  createdAt: string
  /** Display name of the author (the unlocked admin, client-supplied). */
  author: string
  /** The comment body. Empty for a reaction (see {@link emoji}). */
  text: string
  /** Optional text-range anchor. */
  anchor?: CommentAnchor
  /** When set, this is an anchored REACTION (a single emoji pinned to a passage)
   *  rather than a text comment: rendered as an emoji marker, never a thread. */
  emoji?: string
}

/** Append a comment. */
export interface CommentAddOp extends LogRecord {
  type: 'comment-add'
  comment: EncComment
}

/** Tombstone a comment (and, when it is a top-level entry, its replies). */
export interface CommentDeleteOp extends LogRecord {
  type: 'comment-delete'
  commentId: string
}

export type CommentOp = CommentAddOp | CommentDeleteOp

/** Narrow a decoded log record to a comment op (vs. a structural tree op). */
export function isCommentOp(rec: { type: string }): rec is CommentOp {
  return rec.type === 'comment-add' || rec.type === 'comment-delete'
}

/** A compaction snapshot of the comment log, embedded in the FS checkpoint. */
export interface CommentLogSnapshot {
  /** Every added comment (INCLUDING tombstoned ones — `deleted` decides visibility). */
  comments: EncComment[]
  /** Ids of tombstoned comments. */
  deleted: string[]
}

/** Mint a fresh comment id. Not a store path segment, so the `c_` prefix is fine. */
export function newCommentId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return 'c_' + hex
}

/**
 * A replica of a space's comments that converges under concurrent, out-of-order
 * ops. Feed ops via {@link apply}/{@link applyAll} (duplicates deduped by opId);
 * {@link materialize} yields the visible comment set.
 */
export class CommentLog {
  private readonly adds = new Map<string, EncComment>()
  private readonly deleted = new Set<string>()
  private readonly seen = new Set<string>()

  /** Seed from a checkpoint snapshot (adds + tombstones). */
  seed(snapshot: CommentLogSnapshot): this {
    for (const c of snapshot.comments) this.adds.set(c.id, c)
    for (const id of snapshot.deleted) this.deleted.add(id)
    return this
  }

  /** Apply one op. Idempotent (deduped by opId) and order-independent. */
  apply(op: CommentOp): this {
    if (this.seen.has(op.opId)) return this
    this.seen.add(op.opId)
    if (op.type === 'comment-add') {
      // Comment ids are unique per comment, so the first add for an id wins; a
      // redelivered add is a no-op. A tombstone is never resurrected here — the
      // `deleted` set is consulted at materialize, so add-vs-delete order is
      // irrelevant.
      if (!this.adds.has(op.comment.id)) this.adds.set(op.comment.id, op.comment)
    } else {
      this.deleted.add(op.commentId)
    }
    return this
  }

  /** Apply many ops. The result does not depend on their order. */
  applyAll(ops: Iterable<CommentOp>): this {
    for (const op of ops) this.apply(op)
    return this
  }

  /** Is this comment id currently live (added and not tombstoned)? */
  isLive(commentId: string): boolean {
    return this.adds.has(commentId) && !this.deleted.has(commentId)
  }

  /**
   * Visible comments: added, not tombstoned, and — for replies — whose parent is
   * itself a live top-level comment. That hides replies of a deleted parent
   * (cascade) without needing an explicit tombstone per reply.
   */
  materialize(): EncComment[] {
    const live = new Map<string, EncComment>()
    for (const [id, c] of this.adds) {
      if (!this.deleted.has(id)) live.set(id, c)
    }
    const out: EncComment[] = []
    for (const c of live.values()) {
      if (c.parentId) {
        const parent = live.get(c.parentId)
        if (!parent || parent.parentId) continue // parent gone, or itself a reply
      }
      out.push(c)
    }
    out.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
    return out
  }

  /** Snapshot the raw state (all adds + tombstones) for a checkpoint. */
  snapshot(): CommentLogSnapshot {
    return { comments: [...this.adds.values()], deleted: [...this.deleted] }
  }
}
