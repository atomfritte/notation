/**
 * Op-log: the source of truth for tree structure.
 *
 * Every structural change is an append-only {@link Op}. Rebuilding the tree is
 * a deterministic replay of the log. Phase 1 implements the SINGLE-WRITER
 * correct semantics — a total order by (lamport, opId), last-write-wins per
 * field, cycle-forming moves skipped, deletes soft-deleted into a trash root.
 * Phase 2 will swap the replay core for a concurrent CRDT (see the seam near
 * {@link mergeOps}) without changing these types.
 */
import type { Node, NodeType } from './nodes'
import { ROOT_ID, TRASH_ID } from './nodes'

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

/** Total order over ops: ascending lamport, then opId as a deterministic tie-break. */
export function compareOps(a: Op, b: Op): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  if (a.opId === b.opId) return 0
  return a.opId < b.opId ? -1 : 1
}

/**
 * Is `candidateAncestor` inside the subtree rooted at `nodeId`? Used to reject
 * a move that would put a node under one of its own descendants (a cycle).
 */
function wouldCycle(map: Map<string, Node>, candidateParent: string, nodeId: string): boolean {
  let cursor = candidateParent
  const seen = new Set<string>()
  while (cursor !== ROOT_ID && cursor !== TRASH_ID) {
    if (cursor === nodeId) return true
    if (seen.has(cursor)) return false // guard against a pre-existing cycle
    seen.add(cursor)
    const parent = map.get(cursor)
    if (!parent) return false
    cursor = parent.parentId
  }
  return false
}

function applyOp(map: Map<string, Node>, op: Op): void {
  switch (op.type) {
    case 'create': {
      // Idempotent; under single-writer semantics the first Create wins.
      if (map.has(op.nodeId)) return
      map.set(op.nodeId, {
        nodeId: op.nodeId,
        parentId: op.parentId,
        name: op.name,
        type: op.nodeType,
        blobId: op.blobId,
        createdAt: op.lamport,
        updatedAt: op.lamport,
      })
      return
    }
    case 'rename': {
      const node = map.get(op.nodeId)
      if (!node) return
      node.name = op.name
      node.updatedAt = op.lamport
      return
    }
    case 'move': {
      const node = map.get(op.nodeId)
      if (!node) return
      const target = op.newParentId
      if (target === op.nodeId) return // cannot parent to self
      if (target !== ROOT_ID && target !== TRASH_ID && !map.has(target)) return // no such parent
      if (wouldCycle(map, target, op.nodeId)) return // skip cycle-forming move
      node.parentId = target
      node.updatedAt = op.lamport
      return
    }
    case 'delete': {
      const node = map.get(op.nodeId)
      if (!node) return
      node.parentId = TRASH_ID
      node.deleted = true
      node.updatedAt = op.lamport
      return
    }
  }
}

function sortNodes(nodes: Node[]): Node[] {
  return nodes.sort((a, b) => a.createdAt - b.createdAt || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
}

/**
 * Replay ops (in total order) into an existing node map, mutating it in place.
 * Kept separate so a checkpoint can seed the map and the Phase-2 CRDT can
 * replace just this core.
 */
function replay(map: Map<string, Node>, ops: Op[]): Map<string, Node> {
  const ordered = [...ops].sort(compareOps)
  for (const op of ordered) applyOp(map, op)
  return map
}

/**
 * Materialize the node set from a full op-log. Sorts by (lamport, opId) and
 * replays; cycle-forming Moves are skipped and Deletes soft-delete into the
 * trash root.
 *
 * Phase 2: concurrent CRDT merge (undo/redo per Kleppmann) replaces the replay
 * core; the signature stays the same.
 */
export function buildTree(ops: Op[]): Node[] {
  return sortNodes([...replay(new Map<string, Node>(), ops).values()])
}

// ── Phase 2: concurrent CRDT merge (undo/redo per Kleppmann) ────────────────
// `buildTree` above is deliberately single-writer: it assumes a total order
// and last-write-wins per field. The Phase-2 engine will replace `replay` with
// a move-operation CRDT that, on each incoming op, *undoes* the ops ordered
// after it, applies the new op, then *redoes* the rest — making concurrent
// moves converge without cycles or lost updates. `mergeOps` is the seam: for
// now it simply unions the logs, de-duplicates by opId, and re-sorts.
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
 * or below the checkpoint's high-water mark are ignored (already folded in).
 */
export function treeFromCheckpointAndOps(checkpoint: Checkpoint, opsSince: Op[]): Node[] {
  const map = new Map<string, Node>()
  for (const node of checkpoint.nodes) map.set(node.nodeId, { ...node })
  const relevant = opsSince.filter((op) => op.lamport > checkpoint.lamport)
  return sortNodes([...replay(map, relevant).values()])
}
