/**
 * Op-log: the source of truth for tree structure.
 *
 * Every structural change is an append-only {@link Op}. Rebuilding the tree is
 * a deterministic replay of the log. Phase 2 folds the log through a concurrent
 * move-operation CRDT ({@link TreeReplica}) so that ops from multiple devices
 * converge to the byte-identical tree regardless of arrival order — no lost
 * updates, no cycles. These wire types are unchanged from Phase 1; the CRDT
 * unifies them internally (see {@link ./crdt}).
 */
import type { Node, NodeType } from './nodes'
import { TreeReplica, compareTimestamps } from './crdt'

export interface OpBase {
  /** Unique id of this op (also the tie-breaker in the total order). */
  opId: string
  /** Node this op targets. */
  nodeId: string
  /** Lamport logical clock — primary sort key. */
  lamport: number
  /** Id of the actor (device/session) that issued the op. */
  actorId: string
}

export interface CreateOp extends OpBase {
  type: 'create'
  parentId: string
  name: string
  nodeType: NodeType
  /** For files: the content blob id. */
  blobId?: string
}

export interface RenameOp extends OpBase {
  type: 'rename'
  name: string
}

export interface MoveOp extends OpBase {
  type: 'move'
  newParentId: string
}

export interface DeleteOp extends OpBase {
  type: 'delete'
}

export type Op = CreateOp | RenameOp | MoveOp | DeleteOp

/**
 * Total order over ops: ascending lamport, then actorId, then opId. This is the
 * same {@link Timestamp} order the CRDT sequences ops by, so sorting a log with
 * `compareOps` matches the state {@link buildTree} converges to.
 */
export function compareOps(a: Op, b: Op): number {
  return compareTimestamps(a, b)
}

/**
 * Materialize the node set from a full op-log by folding it through the
 * concurrent move CRDT ({@link TreeReplica}). Ops may be passed in ANY order
 * (including with duplicates) — the result is identical. Cycle-forming Moves
 * become no-ops and Deletes soft-delete into the trash root.
 */
export function buildTree(ops: Op[]): Node[] {
  return new TreeReplica().applyAll(ops).materialize()
}

/**
 * Merge structure logs from several replicas into one op-log: union the entries,
 * de-duplicate by opId, and sort into the CRDT's total order. Convergence is the
 * engine's job — {@link buildTree} yields the same tree for any permutation — so
 * this only needs to produce the deduplicated set; the sort is for a canonical
 * on-the-wire ordering.
 */
export function mergeOps(...logs: Op[][]): Op[] {
  const byId = new Map<string, Op>()
  for (const log of logs) {
    for (const op of log) {
      if (!byId.has(op.opId)) byId.set(op.opId, op)
    }
  }
  return [...byId.values()].sort(compareOps)
}

/**
 * A materialized node set at a lamport high-water mark, for future op-log
 * compaction: instead of replaying from genesis, seed from the checkpoint and
 * replay only ops after it.
 */
export interface Checkpoint {
  /** Ops with lamport <= this are already folded into {@link nodes}. */
  lamport: number
  nodes: Node[]
}

/**
 * Materialize the tree from a checkpoint plus the ops recorded since it. Ops at
 * or below the checkpoint's high-water mark are ignored (already folded in);
 * the rest are folded through the CRDT seeded from the checkpoint's state. Since
 * every remaining op has a strictly higher lamport than everything the
 * checkpoint captured, this converges identically to replaying from scratch.
 */
export function treeFromCheckpointAndOps(checkpoint: Checkpoint, opsSince: Op[]): Node[] {
  const relevant = opsSince.filter((op) => op.lamport > checkpoint.lamport)
  return new TreeReplica().seed(checkpoint.nodes).applyAll(relevant).materialize()
}
