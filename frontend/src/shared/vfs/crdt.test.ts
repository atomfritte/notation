import { describe, expect, it } from 'vitest'
import { ROOT_ID, TRASH_ID } from './nodes'
import type { Node, NodeType } from './nodes'
import { buildTree, treeFromCheckpointAndOps } from './ops'
import type { CreateOp, DeleteOp, MoveOp, Op, RenameOp } from './ops'
import { LamportClock, TreeReplica, compareTimestamps } from './crdt'

// ── op builders (unique opIds across the whole file) ────────────────────────
let seq = 0
const nextOpId = () => `op${(seq++).toString(36)}`
const create = (
  nodeId: string,
  parentId: string,
  name: string,
  nodeType: NodeType,
  lamport: number,
  actorId = 'A',
  blobId?: string,
): CreateOp => ({ type: 'create', opId: nextOpId(), nodeId, parentId, name, nodeType, lamport, actorId, blobId })
const rename = (nodeId: string, name: string, lamport: number, actorId = 'A'): RenameOp => ({
  type: 'rename', opId: nextOpId(), nodeId, name, lamport, actorId,
})
const move = (nodeId: string, newParentId: string, lamport: number, actorId = 'A'): MoveOp => ({
  type: 'move', opId: nextOpId(), nodeId, newParentId, lamport, actorId,
})
const del = (nodeId: string, lamport: number, actorId = 'A'): DeleteOp => ({
  type: 'delete', opId: nextOpId(), nodeId, lamport, actorId,
})

const byId = (nodes: Node[]) => new Map(nodes.map((n) => [n.nodeId, n]))
const fingerprint = (nodes: Node[]) => JSON.stringify(nodes)

/** Deterministic linear-congruential RNG so fuzz runs are reproducible from a seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/** Fisher–Yates shuffle using the given RNG (defaults to Math.random). */
function shuffle<T>(arr: readonly T[], rand: () => number = Math.random): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Throws if the parent links contain a cycle (orphans — parent not a node — are fine). */
function assertAcyclicTree(nodes: Node[]): void {
  const map = byId(nodes)
  for (const n of nodes) {
    const seen = new Set<string>()
    let cursor: string | undefined = n.nodeId
    while (cursor !== undefined && cursor !== ROOT_ID && cursor !== TRASH_ID) {
      if (seen.has(cursor)) throw new Error(`cycle through ${cursor}`)
      seen.add(cursor)
      cursor = map.get(cursor)?.parentId
    }
  }
}

/**
 * The gold-standard convergence check: materialize `ops` in `shuffles` random
 * permutations and assert every one is byte-identical to the sorted baseline.
 * Returns the converged tree.
 */
function assertConverges(ops: Op[], shuffles: number, rand: () => number = Math.random): Node[] {
  const baseline = buildTree(ops)
  const baselineFp = fingerprint(baseline)
  assertAcyclicTree(baseline)
  for (let i = 0; i < shuffles; i++) {
    const permuted = shuffle(ops, rand)
    expect(fingerprint(buildTree(permuted))).toBe(baselineFp)
  }
  // Also prove incremental, one-at-a-time application matches batch application.
  const incremental = new TreeReplica()
  for (const op of shuffle(ops, rand)) incremental.apply(op)
  expect(fingerprint(incremental.materialize())).toBe(baselineFp)
  return baseline
}

/**
 * Generate a realistic multi-actor op stream. Actors each keep a LamportClock
 * and occasionally observe one another (causal links); the rest run concurrently
 * (colliding lamports resolved by actorId), exercising creates, renames, moves
 * (including cycle- and orphan-forming ones) and deletes.
 */
function generateScenario(rand: () => number, actorCount: number, opCount: number): Op[] {
  const actors = Array.from({ length: actorCount }, (_, i) => String.fromCharCode(65 + i))
  const clocks = actors.map((a) => new LamportClock(a))
  const created: string[] = []
  const ops: Op[] = []
  let nodeSeq = 0
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]

  for (let i = 0; i < opCount; i++) {
    const ai = Math.floor(rand() * actorCount)
    const clock = clocks[ai]
    const actorId = actors[ai]
    // Occasionally sync this actor with another (creates causal ordering).
    if (rand() < 0.3) clock.observe(pick(clocks).value)
    const lamport = clock.tick()

    const roll = rand()
    if (created.length === 0 || roll < 0.4) {
      const nodeId = `nd${nodeSeq++}`
      const parent = pick([ROOT_ID, ...created])
      const type: NodeType = rand() < 0.5 ? 'dir' : 'file'
      ops.push(create(nodeId, parent, `n${nodeSeq}`, type, lamport, actorId, type === 'file' ? `b${nodeSeq}` : undefined))
      created.push(nodeId)
    } else if (roll < 0.6) {
      ops.push(rename(pick(created), `r${i}`, lamport, actorId))
    } else if (roll < 0.85) {
      // Move to root, an existing node (may form a cycle), or an unknown id (orphan).
      const target = pick([ROOT_ID, ...created, ...created, `ghost${i}`])
      ops.push(move(pick(created), target, lamport, actorId))
    } else {
      ops.push(del(pick(created), lamport, actorId))
    }
  }
  return ops
}

describe('LamportClock', () => {
  it('tick increments and returns the new counter', () => {
    const clock = new LamportClock('A')
    expect(clock.value).toBe(0)
    expect(clock.tick()).toBe(1)
    expect(clock.tick()).toBe(2)
    expect(clock.value).toBe(2)
  })

  it('observe sets counter = max(local, remote) + 1', () => {
    const clock = new LamportClock('A', 3)
    clock.observe(2) // remote behind → max(3,2)+1 = 4
    expect(clock.value).toBe(4)
    clock.observe(10) // remote ahead → max(4,10)+1 = 11
    expect(clock.value).toBe(11)
  })

  it('keeps an actor ahead of every op it has observed', () => {
    const a = new LamportClock('A')
    const b = new LamportClock('B')
    const t1 = a.tick() // 1
    b.observe(t1) // 2
    const t2 = b.tick() // 3
    a.observe(t2) // 4
    expect(a.tick()).toBeGreaterThan(t2)
  })
})

describe('compareTimestamps', () => {
  it('orders by lamport, then actorId, then opId — a strict total order', () => {
    expect(compareTimestamps({ lamport: 1, actorId: 'A', opId: 'z' }, { lamport: 2, actorId: 'A', opId: 'a' })).toBeLessThan(0)
    expect(compareTimestamps({ lamport: 5, actorId: 'A', opId: 'z' }, { lamport: 5, actorId: 'B', opId: 'a' })).toBeLessThan(0)
    expect(compareTimestamps({ lamport: 5, actorId: 'A', opId: 'b' }, { lamport: 5, actorId: 'A', opId: 'a' })).toBeGreaterThan(0)
    expect(compareTimestamps({ lamport: 5, actorId: 'A', opId: 'a' }, { lamport: 5, actorId: 'A', opId: 'a' })).toBe(0)
  })
})

describe('convergence (gold standard)', () => {
  it('materializes byte-identically across 200 random permutations (Math.random)', () => {
    const ops = generateScenario(Math.random, 4, 120)
    assertConverges(ops, 200)
  })

  it('is reproducible for fixed seeds', () => {
    for (const seed of [1, 42, 1337, 2026, 0xbeef]) {
      const rand = lcg(seed)
      const ops = generateScenario(rand, 3, 80)
      const tree = assertConverges(ops, 60, lcg(seed ^ 0x9e3779b9))
      assertAcyclicTree(tree) // never a cycle, whatever the moves were
    }
  })

  it('converges for a hand-written concurrent fixture applied every which way', () => {
    const ops: Op[] = [
      create('a', ROOT_ID, 'a', 'dir', 1, 'A'),
      create('b', ROOT_ID, 'b', 'dir', 1, 'B'),
      create('c', 'a', 'c', 'dir', 2, 'A'),
      create('d', 'b', 'd', 'file', 2, 'B', 'blobD'),
      move('c', 'b', 3, 'A'),
      rename('d', 'd-renamed', 3, 'B'),
      move('a', 'c', 4, 'B'), // concurrent-ish; may or may not cycle depending on order — engine decides once
      del('b', 5, 'A'),
    ]
    assertConverges(ops, 200)
  })
})

describe('concurrent conflicting move of the same node', () => {
  const base: Op[] = [
    create('x', ROOT_ID, 'x', 'dir', 1, 'A'),
    create('p1', ROOT_ID, 'p1', 'dir', 2, 'A'),
    create('p2', ROOT_ID, 'p2', 'dir', 3, 'A'),
  ]

  it('picks the higher-timestamp move deterministically; replicas agree', () => {
    const mA = move('x', 'p1', 10, 'A')
    const mB = move('x', 'p2', 10, 'B') // same lamport, actorId B > A → higher timestamp wins
    const forward = byId(buildTree([...base, mA, mB]))
    const reverse = byId(buildTree([mB, mA, ...base]))
    expect(forward.get('x')?.parentId).toBe('p2')
    expect(reverse.get('x')?.parentId).toBe('p2')
    assertConverges([...base, mA, mB], 100)
  })
})

describe('concurrent moves that would form a cycle', () => {
  const base: Op[] = [
    create('x', ROOT_ID, 'x', 'dir', 1, 'A'),
    create('y', ROOT_ID, 'y', 'dir', 2, 'A'),
  ]

  it('applies exactly one, forms no cycle, and both replicas agree', () => {
    const xUnderY = move('x', 'y', 10, 'A') // lower timestamp
    const yUnderX = move('y', 'x', 10, 'B') // higher timestamp — rejected as it would cycle
    const ops = [...base, xUnderY, yUnderX]

    const tree = assertConverges(ops, 200)
    const nodes = byId(tree)
    // The lower-timestamp move applied first survives; the later one would cycle.
    expect(nodes.get('x')?.parentId).toBe('y')
    expect(nodes.get('y')?.parentId).toBe(ROOT_ID)
    // Exactly one of the two edges exists.
    const xUnderYNow = nodes.get('x')?.parentId === 'y'
    const yUnderXNow = nodes.get('y')?.parentId === 'x'
    expect(xUnderYNow !== yUnderXNow).toBe(true)
    assertAcyclicTree(tree)
  })
})

describe('delete vs concurrent move / rename', () => {
  const base: Op[] = [
    create('x', ROOT_ID, 'x', 'dir', 1, 'A'),
    create('y', ROOT_ID, 'y', 'dir', 2, 'A'),
  ]

  it('higher-timestamp move wins → node lives at the new parent, undeleted; replicas agree', () => {
    const d = del('x', 10, 'A')
    const m = move('x', 'y', 10, 'B') // higher timestamp
    const tree = assertConverges([...base, d, m], 100)
    const x = byId(tree).get('x')
    expect(x?.parentId).toBe('y')
    expect(x?.deleted).toBeFalsy()
  })

  it('higher-timestamp delete wins → node soft-deleted to trash; nothing lost; replicas agree', () => {
    const m = move('x', 'y', 10, 'A')
    const d = del('x', 10, 'B') // higher timestamp
    const tree = assertConverges([...base, m, d], 100)
    const x = byId(tree).get('x')
    expect(x?.parentId).toBe(TRASH_ID)
    expect(x?.deleted).toBe(true)
    expect(byId(tree).has('x')).toBe(true) // never dropped
  })

  it('delete + concurrent rename → renamed AND soft-deleted, deterministically', () => {
    const d = del('x', 10, 'A')
    const r = rename('x', 'x-renamed', 10, 'B') // higher timestamp; rename does not un-delete
    const tree = assertConverges([...base, d, r], 100)
    const x = byId(tree).get('x')
    expect(x?.name).toBe('x-renamed')
    expect(x?.parentId).toBe(TRASH_ID)
    expect(x?.deleted).toBe(true)
  })

  it('a deleted directory keeps its whole subtree (nothing lost)', () => {
    const ops: Op[] = [
      create('dir', ROOT_ID, 'dir', 'dir', 1, 'A'),
      create('kid', 'dir', 'kid', 'file', 2, 'A'),
      del('dir', 3, 'A'),
    ]
    const tree = assertConverges(ops, 50)
    const nodes = byId(tree)
    expect(nodes.get('dir')).toMatchObject({ parentId: TRASH_ID, deleted: true })
    expect(nodes.get('kid')?.parentId).toBe('dir') // subtree preserved, not individually flagged
    expect(nodes.get('kid')?.deleted).toBeFalsy()
  })
})

describe('idempotent redelivery', () => {
  it('a duplicate opId has no effect (applied twice = once)', () => {
    const ops: Op[] = [create('n', ROOT_ID, 'n', 'file', 1), rename('n', 'renamed', 2)]
    const once = fingerprint(buildTree(ops))
    const withDupes = [...ops, ops[0], ops[1], ops[1], ops[0]]
    expect(fingerprint(buildTree(withDupes))).toBe(once)
  })

  it('re-applying the same op to a live replica is a no-op', () => {
    const c = create('n', ROOT_ID, 'n', 'file', 1)
    const replica = new TreeReplica().apply(c).apply(rename('n', 'r', 2))
    const before = fingerprint(replica.materialize())
    replica.apply(c) // redeliver the create
    expect(fingerprint(replica.materialize())).toBe(before)
  })
})

describe('create-from-limbo ordering', () => {
  it('a rename delivered before its create still lands (create wins the past, rename the future)', () => {
    const c = create('x', ROOT_ID, 'orig', 'file', 5)
    const r = rename('x', 'renamed', 6)
    expect(byId(buildTree([r, c])).get('x')?.name).toBe('renamed')
    expect(byId(buildTree([c, r])).get('x')?.name).toBe('renamed')
  })

  it('a move delivered before both its create and its parent create still converges', () => {
    const cp = create('p', ROOT_ID, 'p', 'dir', 1)
    const cx = create('x', ROOT_ID, 'x', 'file', 5)
    const mv = move('x', 'p', 6)
    const expected = byId(buildTree([cp, cx, mv])).get('x')?.parentId
    expect(expected).toBe('p')
    expect(byId(buildTree([mv, cx, cp])).get('x')?.parentId).toBe('p')
    expect(byId(buildTree([mv, cp, cx])).get('x')?.parentId).toBe('p')
  })

  it('first create wins for a duplicated nodeId regardless of arrival order', () => {
    const first = create('n', ROOT_ID, 'first', 'file', 1)
    const second = create('n', ROOT_ID, 'second', 'file', 2)
    expect(byId(buildTree([first, second])).get('n')?.name).toBe('first')
    expect(byId(buildTree([second, first])).get('n')?.name).toBe('first')
  })
})

describe('checkpoint + later ops', () => {
  it('seeding from a checkpoint then applying later ops equals a full replay', () => {
    for (const seed of [7, 99, 555, 31337]) {
      const ops = generateScenario(lcg(seed), 3, 90)
      const lamports = ops.map((o) => o.lamport).sort((a, b) => a - b)
      const cut = lamports[Math.floor(lamports.length / 2)] // split point on the lamport axis

      const early = ops.filter((o) => o.lamport <= cut)
      const late = ops.filter((o) => o.lamport > cut)
      const checkpoint = { lamport: cut, nodes: buildTree(early) }

      const viaCheckpoint = treeFromCheckpointAndOps(checkpoint, shuffle(late))
      const fromScratch = buildTree(ops)
      expect(fingerprint(viaCheckpoint)).toBe(fingerprint(fromScratch))
    }
  })

  it('ignores ops at or below the checkpoint high-water mark', () => {
    const base = buildTree([
      create('d', ROOT_ID, 'd', 'dir', 1),
      create('f', 'd', 'f', 'file', 2),
    ])
    const checkpoint = { lamport: 2, nodes: base }
    const nodes = byId(
      treeFromCheckpointAndOps(checkpoint, [
        rename('f', 'ignored-old', 2), // <= high-water: already folded in
        rename('f', 'applied-new', 3), // > high-water: applied
      ]),
    )
    expect(nodes.get('f')?.name).toBe('applied-new')
  })
})
