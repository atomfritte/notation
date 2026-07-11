/**
 * Concurrent move-operation CRDT for the encrypted filesystem's structure log
 * (Phase 2).
 *
 * Implements Kleppmann, Mulligan, Gomes & Beresford, "A highly-available move
 * operation for replicated trees" (2021). Structural ops from any number of
 * devices/tabs converge to the byte-identical materialized tree regardless of
 * the order in which they arrive — with no lost updates and no cycles.
 *
 * ── The unification ────────────────────────────────────────────────────────
 * The four wire {@link Op} kinds are all internally a *move* of one node under
 * one parent, carrying optional metadata:
 *
 *   - **Create**  move a fresh nodeId out of "limbo" (no record) under its
 *                 parent, setting full meta {name, type, blobId}. Effective
 *                 only while the node is still in limbo, so the *first* create
 *                 for an id wins (idempotent re-creates are no-ops).
 *   - **Rename**  move to the SAME parent, replacing only the name.
 *   - **Move**    move to a new parent, meta unchanged.
 *   - **Delete**  move under {@link TRASH_ID} (soft delete — the node and its
 *                 subtree are preserved, never dropped).
 *
 * A node's `deleted` flag is *derived*: a node is deleted iff its parent is
 * {@link TRASH_ID}. That keeps parent and deleted flag inherently consistent
 * under concurrent delete-vs-move (whichever op wins the timestamp order also
 * decides the flag).
 *
 * ── Convergence ────────────────────────────────────────────────────────────
 * Every op carries a Lamport {@link Timestamp} = (lamport, actorId, opId) that
 * defines one total order (see {@link compareTimestamps}). The engine keeps its
 * applied ops in that order together with the OLD record each one overwrote. To
 * apply a new op it UNDOes every already-applied op ordered after it (in
 * reverse), performs the new op, then REDOes the undone ops in ascending order.
 * Because `do_op` is a pure function of the current state, the result is always
 * exactly the state you would get by replaying all ops in timestamp order — so
 * replicas that have observed the same set of ops agree, whatever the delivery
 * order.
 */
import { ROOT_ID, TRASH_ID } from './nodes'
import type { Node, NodeType } from './nodes'
import type { Op } from './ops'

/** A Lamport logical timestamp: the CRDT's total-order key for an op. */
export interface Timestamp {
  /** Lamport counter — primary key. */
  lamport: number
  /** Issuing actor (device/session) — first tie-break. */
  actorId: string
  /** Op id — final tie-break, guaranteeing a strict total order. */
  opId: string
}

/**
 * Total order over timestamps: ascending lamport, then actorId, then opId.
 * Returns <0, 0, or >0. Two distinct ops never compare equal.
 */
export function compareTimestamps(a: Timestamp, b: Timestamp): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  if (a.actorId !== b.actorId) return a.actorId < b.actorId ? -1 : 1
  if (a.opId === b.opId) return 0
  return a.opId < b.opId ? -1 : 1
}

const timestampOf = (op: Op): Timestamp => ({ lamport: op.lamport, actorId: op.actorId, opId: op.opId })

/**
 * A Lamport clock for *producing* ops. Each device owns one, stamps local ops
 * with {@link tick}, and folds in the clocks of remote ops with {@link observe}
 * so its counter always stays ahead of everything it has seen.
 */
export class LamportClock {
  private counter: number

  constructor(
    readonly actorId: string,
    initial = 0,
  ) {
    this.counter = initial
  }

  /** The last issued/observed logical time. */
  get value(): number {
    return this.counter
  }

  /** Advance for a local event; returns the new time to stamp onto an op. */
  tick(): number {
    this.counter += 1
    return this.counter
  }

  /** Fold in a remote op's lamport: counter = max(local, remote) + 1. */
  observe(remoteLamport: number): void {
    this.counter = Math.max(this.counter, remoteLamport) + 1
  }
}

/** Internal per-node record. `deleted` is derived (parent === TRASH_ID). */
interface Rec {
  parent: string
  name: string
  type: NodeType
  blobId?: string
  createdAt: number
  updatedAt: number
}

/** One applied op plus the record it overwrote, for undo/redo. */
interface LogEntry {
  ts: Timestamp
  op: Op
  /** The target node's record *before* this op ran; undefined = it had none. */
  undo: Rec | undefined
}

/**
 * A replica of the tree that converges under concurrent structural ops.
 *
 * Feed ops in via {@link apply}/{@link applyAll} in any order (duplicates are
 * ignored); {@link materialize} produces the ordered {@link Node} set. Two
 * replicas fed the same *set* of ops materialize identical trees.
 */
export class TreeReplica {
  private readonly state = new Map<string, Rec>()
  /** Applied ops in ascending timestamp order. */
  private readonly log: LogEntry[] = []
  /** Op ids already applied — for idempotent redelivery. */
  private readonly seen = new Set<string>()

  /**
   * Seed the replica from an already-materialized node set (e.g. a checkpoint).
   * Seeded nodes carry no log entries: subsequent ops are expected to have
   * higher timestamps than everything the checkpoint folded in, so they never
   * need to undo below the seed. Idempotent creates for seeded ids are no-ops.
   */
  seed(nodes: Iterable<Node>): this {
    for (const n of nodes) {
      this.state.set(n.nodeId, {
        parent: n.parentId,
        name: n.name,
        type: n.type,
        blobId: n.blobId,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      })
    }
    return this
  }

  /** Apply one op. Idempotent (deduped by opId) and order-independent. */
  apply(op: Op): this {
    if (this.seen.has(op.opId)) return this
    const ts = timestampOf(op)

    // Undo every applied op ordered strictly after this one (reverse order).
    const undone: LogEntry[] = []
    while (this.log.length > 0 && compareTimestamps(this.log[this.log.length - 1].ts, ts) > 0) {
      const entry = this.log.pop() as LogEntry
      this.undoOp(entry)
      undone.push(entry)
    }

    // Do the new op in its rightful place.
    this.seen.add(op.opId)
    this.log.push(this.doOp(op, ts))

    // Redo the undone ops in ascending order (re-evaluating their conditions).
    for (let i = undone.length - 1; i >= 0; i--) {
      this.log.push(this.doOp(undone[i].op, undone[i].ts))
    }
    return this
  }

  /** Apply many ops. The result does not depend on their order. */
  applyAll(ops: Iterable<Op>): this {
    for (const op of ops) this.apply(op)
    return this
  }

  /**
   * Perform an op against the current state, returning the log entry (with the
   * overwritten record captured for undo). A move that would form a cycle — or
   * a re-create of an existing node — is recorded but has no effect.
   */
  private doOp(op: Op, ts: Timestamp): LogEntry {
    const prev = this.state.get(op.nodeId)
    const undo = prev ? { ...prev } : undefined

    switch (op.type) {
      case 'create': {
        // First create wins: effective only while the node is still in limbo.
        if (!prev && !this.wouldCycle(op.parentId, op.nodeId)) {
          this.state.set(op.nodeId, {
            parent: op.parentId,
            name: op.name,
            type: op.nodeType,
            blobId: op.blobId,
            createdAt: ts.lamport,
            updatedAt: ts.lamport,
          })
        }
        break
      }
      case 'rename': {
        if (prev) this.state.set(op.nodeId, { ...prev, name: op.name, updatedAt: ts.lamport })
        break
      }
      case 'move': {
        if (prev && !this.wouldCycle(op.newParentId, op.nodeId)) {
          this.state.set(op.nodeId, { ...prev, parent: op.newParentId, updatedAt: ts.lamport })
        }
        break
      }
      case 'delete': {
        if (prev) this.state.set(op.nodeId, { ...prev, parent: TRASH_ID, updatedAt: ts.lamport })
        break
      }
    }
    return { ts, op, undo }
  }

  /** Restore the record an entry overwrote (removing the node if it had none). */
  private undoOp(entry: LogEntry): void {
    if (entry.undo === undefined) this.state.delete(entry.op.nodeId)
    else this.state.set(entry.op.nodeId, { ...entry.undo })
  }

  /**
   * Would parenting `child` under `candidateParent` create a cycle? True iff
   * `child` is `candidateParent` itself or one of its ancestors in the current
   * state. The `visited` guard defends against a malformed pre-existing cycle,
   * though the apply discipline keeps the parent graph acyclic by construction.
   */
  private wouldCycle(candidateParent: string, child: string): boolean {
    let cursor: string | undefined = candidateParent
    const visited = new Set<string>()
    while (cursor !== undefined && cursor !== ROOT_ID && cursor !== TRASH_ID) {
      if (cursor === child) return true
      if (visited.has(cursor)) return false
      visited.add(cursor)
      cursor = this.state.get(cursor)?.parent
    }
    return false
  }

  /**
   * Materialize the current node set, sorted by (createdAt, nodeId) for a
   * stable, order-independent output. `deleted` is set iff the node sits
   * directly under {@link TRASH_ID}.
   */
  materialize(): Node[] {
    const nodes: Node[] = []
    for (const [nodeId, rec] of this.state) {
      const node: Node = {
        nodeId,
        parentId: rec.parent,
        name: rec.name,
        type: rec.type,
        blobId: rec.blobId,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
      }
      if (rec.parent === TRASH_ID) node.deleted = true
      nodes.push(node)
    }
    nodes.sort((a, b) => a.createdAt - b.createdAt || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
    return nodes
  }
}
