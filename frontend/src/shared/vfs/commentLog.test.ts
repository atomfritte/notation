import { describe, expect, it } from 'vitest'
import { CommentLog, newCommentId, type CommentOp, type EncComment } from './commentLog'

let seq = 0
const opId = () => `op${(seq++).toString(16).padStart(4, '0')}`

const mkComment = (over: Partial<EncComment> = {}): EncComment => ({
  id: over.id ?? newCommentId(),
  parentId: over.parentId,
  nodeId: over.nodeId ?? 'node-1',
  createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
  author: over.author ?? 'admin:me',
  text: over.text ?? 'a comment',
  anchor: over.anchor,
})

const add = (comment: EncComment, lamport: number): CommentOp => ({
  type: 'comment-add',
  opId: opId(),
  lamport,
  actorId: 'A',
  comment,
})

const del = (commentId: string, lamport: number): CommentOp => ({
  type: 'comment-delete',
  opId: opId(),
  lamport,
  actorId: 'A',
  commentId,
})

const ids = (list: EncComment[]) => list.map((c) => c.id).sort()

describe('CommentLog', () => {
  it('adds and lists comments', () => {
    const c1 = mkComment({ id: 'c1', text: 'first' })
    const c2 = mkComment({ id: 'c2', text: 'second' })
    const log = new CommentLog().applyAll([add(c1, 1), add(c2, 2)])
    expect(ids(log.materialize())).toEqual(['c1', 'c2'])
  })

  it('is idempotent — a redelivered op does not duplicate', () => {
    const c1 = mkComment({ id: 'c1' })
    const op = add(c1, 1)
    const log = new CommentLog().applyAll([op, op, op])
    expect(log.materialize()).toHaveLength(1)
  })

  it('tombstones a deleted comment', () => {
    const c1 = mkComment({ id: 'c1' })
    const log = new CommentLog().applyAll([add(c1, 1), del('c1', 2)])
    expect(log.materialize()).toHaveLength(0)
    expect(log.isLive('c1')).toBe(false)
  })

  it('converges regardless of op order (delete before add still wins)', () => {
    const c1 = mkComment({ id: 'c1' })
    const forward = new CommentLog().applyAll([add(c1, 1), del('c1', 2)])
    const reversed = new CommentLog().applyAll([del('c1', 2), add(c1, 1)])
    expect(reversed.materialize()).toEqual(forward.materialize())
    expect(reversed.materialize()).toHaveLength(0)
  })

  it('hides replies whose top-level parent is deleted (cascade at materialize)', () => {
    const top = mkComment({ id: 'top' })
    const reply = mkComment({ id: 'r1', parentId: 'top' })
    const log = new CommentLog().applyAll([add(top, 1), add(reply, 2)])
    expect(ids(log.materialize())).toEqual(['r1', 'top'])
    log.apply(del('top', 3))
    // Deleting the parent hides the orphaned reply too.
    expect(log.materialize()).toHaveLength(0)
  })

  it('drops a reply whose parent never arrived', () => {
    const reply = mkComment({ id: 'r1', parentId: 'ghost' })
    const log = new CommentLog().applyAll([add(reply, 1)])
    expect(log.materialize()).toHaveLength(0)
  })

  it('sorts by createdAt then id', () => {
    const a = mkComment({ id: 'b', createdAt: '2026-01-02T00:00:00.000Z' })
    const b = mkComment({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' })
    const log = new CommentLog().applyAll([add(a, 1), add(b, 2)])
    expect(log.materialize().map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('round-trips through a checkpoint snapshot', () => {
    const c1 = mkComment({ id: 'c1' })
    const c2 = mkComment({ id: 'c2' })
    const src = new CommentLog().applyAll([add(c1, 1), add(c2, 2), del('c2', 3)])
    const seeded = new CommentLog().seed(src.snapshot())
    expect(ids(seeded.materialize())).toEqual(['c1'])
    // A late delete of c1 applied on top of the seed still takes effect.
    seeded.apply(del('c1', 4))
    expect(seeded.materialize()).toHaveLength(0)
  })
})
