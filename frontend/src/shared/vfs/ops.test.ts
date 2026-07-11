import { describe, expect, it } from 'vitest'
import { ROOT_ID, TRASH_ID } from './nodes'
import type { Node, NodeType } from './nodes'
import {
  buildTree,
  compareOps,
  mergeOps,
  treeFromCheckpointAndOps,
} from './ops'
import type { CreateOp, DeleteOp, MoveOp, Op, RenameOp } from './ops'

let seq = 0
const create = (
  nodeId: string,
  parentId: string,
  name: string,
  nodeType: NodeType,
  lamport: number,
  blobId?: string,
): CreateOp => ({ type: 'create', opId: `op${++seq}`, nodeId, parentId, name, nodeType, lamport, actorId: 'A', blobId })
const rename = (nodeId: string, name: string, lamport: number, opId = `op${++seq}`): RenameOp => ({
  type: 'rename', opId, nodeId, name, lamport, actorId: 'A',
})
const move = (nodeId: string, newParentId: string, lamport: number): MoveOp => ({
  type: 'move', opId: `op${++seq}`, nodeId, newParentId, lamport, actorId: 'A',
})
const del = (nodeId: string, lamport: number): DeleteOp => ({
  type: 'delete', opId: `op${++seq}`, nodeId, lamport, actorId: 'A',
})

const byId = (nodes: Node[]) => new Map(nodes.map((n) => [n.nodeId, n]))

describe('buildTree', () => {
  it('replays create ops into a nested tree with correct parent links and blob ids', () => {
    const ops: Op[] = [
      create('d1', ROOT_ID, 'docs', 'dir', 1),
      create('d2', 'd1', 'sub', 'dir', 2),
      create('f1', 'd2', 'a.md', 'file', 3, 'blob1'),
    ]
    const nodes = byId(buildTree(ops))
    expect(nodes.get('d1')).toMatchObject({ parentId: ROOT_ID, name: 'docs', type: 'dir' })
    expect(nodes.get('d2')).toMatchObject({ parentId: 'd1', name: 'sub' })
    expect(nodes.get('f1')).toMatchObject({ parentId: 'd2', name: 'a.md', type: 'file', blobId: 'blob1' })
  })

  it('orders by (lamport, opId) regardless of input order', () => {
    // Same node renamed at the same lamport; higher opId is applied last and wins.
    const ops: Op[] = [
      create('n', ROOT_ID, 'orig', 'file', 1),
      rename('n', 'zzz-later', 5, 'op-b'),
      rename('n', 'aaa-earlier', 5, 'op-a'),
    ]
    expect(byId(buildTree(ops)).get('n')?.name).toBe('zzz-later')
  })

  it('applies renames', () => {
    const ops: Op[] = [create('n', ROOT_ID, 'before', 'file', 1), rename('n', 'after', 2)]
    expect(byId(buildTree(ops)).get('n')?.name).toBe('after')
  })

  it('moves a subtree to a new parent', () => {
    const ops: Op[] = [
      create('a', ROOT_ID, 'a', 'dir', 1),
      create('b', ROOT_ID, 'b', 'dir', 2),
      create('c', 'a', 'c', 'dir', 3), // c under a
      move('c', 'b', 4), // move c under b
    ]
    expect(byId(buildTree(ops)).get('c')?.parentId).toBe('b')
  })

  it('skips a move that would create a cycle', () => {
    const ops: Op[] = [
      create('a', ROOT_ID, 'a', 'dir', 1),
      create('b', 'a', 'b', 'dir', 2), // b under a
      move('a', 'b', 3), // try to move a under its own descendant b → cycle
    ]
    // a stays at root; the cycle-forming move is ignored.
    expect(byId(buildTree(ops)).get('a')?.parentId).toBe(ROOT_ID)
  })

  it('skips a self-parenting move and a move under a nonexistent parent', () => {
    const ops: Op[] = [
      create('a', ROOT_ID, 'a', 'dir', 1),
      move('a', 'a', 2), // self
      move('a', 'ghost', 3), // no such parent
    ]
    expect(byId(buildTree(ops)).get('a')?.parentId).toBe(ROOT_ID)
  })

  it('soft-deletes into the trash root, keeping children attached', () => {
    const ops: Op[] = [
      create('dir', ROOT_ID, 'dir', 'dir', 1),
      create('child', 'dir', 'child', 'file', 2),
      del('dir', 3),
    ]
    const nodes = byId(buildTree(ops))
    expect(nodes.get('dir')).toMatchObject({ parentId: TRASH_ID, deleted: true })
    // child still hangs off the (now-trashed) dir — the subtree is preserved.
    expect(nodes.get('child')?.parentId).toBe('dir')
  })

  it('is idempotent for a duplicate create (first one wins)', () => {
    const ops: Op[] = [
      create('n', ROOT_ID, 'first', 'file', 1),
      create('n', ROOT_ID, 'second', 'file', 2),
    ]
    expect(byId(buildTree(ops)).get('n')?.name).toBe('first')
  })

  it('ignores ops targeting an unknown node', () => {
    expect(buildTree([rename('missing', 'x', 1), del('missing', 2)])).toEqual([])
  })
})

describe('compareOps', () => {
  it('orders by lamport first, then opId', () => {
    const a: Op = { type: 'delete', opId: 'b', nodeId: 'n', lamport: 1, actorId: 'A' }
    const b: Op = { type: 'delete', opId: 'a', nodeId: 'n', lamport: 2, actorId: 'A' }
    const c: Op = { type: 'delete', opId: 'a', nodeId: 'n', lamport: 1, actorId: 'A' }
    expect(compareOps(a, b)).toBeLessThan(0) // lower lamport wins
    expect(compareOps(a, c)).toBeGreaterThan(0) // same lamport, 'b' > 'a'
    expect(compareOps(c, c)).toBe(0)
  })
})

describe('mergeOps (Phase 2 seam)', () => {
  it('unions logs, de-duplicates by opId, and sorts', () => {
    const shared: Op = { type: 'delete', opId: 'dup', nodeId: 'n', lamport: 2, actorId: 'A' }
    const x: Op = { type: 'delete', opId: 'x', nodeId: 'n', lamport: 1, actorId: 'A' }
    const y: Op = { type: 'delete', opId: 'y', nodeId: 'n', lamport: 3, actorId: 'B' }
    const merged = mergeOps([x, shared], [shared, y])
    expect(merged.map((o) => o.opId)).toEqual(['x', 'dup', 'y'])
  })
})

describe('treeFromCheckpointAndOps', () => {
  it('seeds from a checkpoint and applies only ops past the high-water mark', () => {
    const base = buildTree([
      create('d', ROOT_ID, 'd', 'dir', 1),
      create('f', 'd', 'f', 'file', 2),
    ])
    const checkpoint = { lamport: 2, nodes: base }
    const nodes = byId(
      treeFromCheckpointAndOps(checkpoint, [
        rename('f', 'ignored-old', 2), // <= high-water: already folded in, ignored
        rename('f', 'applied-new', 3), // > high-water: applied
      ]),
    )
    expect(nodes.get('f')?.name).toBe('applied-new')
    expect(nodes.get('d')?.name).toBe('d')
  })
})
