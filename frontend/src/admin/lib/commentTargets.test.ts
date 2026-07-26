import { describe, expect, it } from 'vitest'
import { bestQuoteNeedle, findCommentTargets, findOrphanGroups, rankCandidates, similarity } from './commentTargets'
import type { AllCommentItem } from './api'

const comment = (over: Partial<AllCommentItem> = {}): AllCommentItem => ({
  id: 'c_' + Math.random().toString(16).slice(2),
  path: 'notes/page.md',
  created_at: '2026-07-20T10:00:00Z',
  author: 'me',
  text: 'a note',
  ...over,
})

describe('similarity', () => {
  it('is 1 for equal strings and 0 for unrelated ones', () => {
    expect(similarity('meeting', 'meeting')).toBe(1)
    expect(similarity('meeting', 'zzzz')).toBe(0)
  })

  it('rates a suffixed name well above an unrelated one', () => {
    expect(similarity('meeting', 'meeting-2024')).toBeGreaterThan(0.6)
    expect(similarity('meeting', 'groceries')).toBeLessThan(0.3)
  })

  it('handles degenerate inputs without dividing by zero', () => {
    expect(similarity('', '')).toBe(1)
    expect(similarity('a', 'b')).toBe(0)
    expect(Number.isFinite(similarity('a', 'abc'))).toBe(true)
  })
})

describe('rankCandidates', () => {
  const paths = ['archive/meeting.md', 'notes/meeting-2024.md', 'notes/groceries.md', 'inbox/other.md']

  it('puts a file that still holds the quoted passage on top', () => {
    const out = rankCandidates({ missing: 'notes/meeting.md', paths, quoteHits: ['inbox/other.md'] })
    expect(out[0].path).toBe('inbox/other.md')
    expect(out[0].reason).toBe('quote')
    // Everything else is still offered, just below it.
    expect(out.map((c) => c.path)).toContain('archive/meeting.md')
  })

  it('offers the same filename elsewhere ahead of a merely similar one', () => {
    const out = rankCandidates({ missing: 'notes/meeting.md', paths })
    expect(out[0].path).toBe('archive/meeting.md')
    expect(out[0].reason).toBe('name')
    expect(out[1].path).toBe('notes/meeting-2024.md')
    expect(out[1].reason).toBe('similar')
  })

  it('keeps unrelated files out entirely', () => {
    const out = rankCandidates({ missing: 'notes/meeting.md', paths })
    expect(out.map((c) => c.path)).not.toContain('notes/groceries.md')
    expect(out.map((c) => c.path)).not.toContain('inbox/other.md')
  })

  it('ranks the nearer folder first among same-name candidates', () => {
    const out = rankCandidates({
      missing: 'projects/alpha/spec.md',
      paths: ['projects/alpha-v2/spec.md', 'totally/elsewhere/spec.md'],
    })
    expect(out[0].path).toBe('projects/alpha-v2/spec.md')
  })

  it('matches on the bare filename an encrypted space is left with', () => {
    // A trashed CRDT node keeps its name but not its place in the tree.
    const out = rankCandidates({ missing: 'spec.md', paths: ['projects/spec.md'] })
    expect(out[0]).toMatchObject({ path: 'projects/spec.md', reason: 'name' })
  })

  it('never suggests the missing path itself and honours the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => `dir${i}/page.md`)
    const out = rankCandidates({ missing: 'dir3/page.md', paths: many, limit: 3 })
    expect(out).toHaveLength(3)
    expect(out.map((c) => c.path)).not.toContain('dir3/page.md')
  })
})

describe('bestQuoteNeedle', () => {
  it('picks the longest single line across the thread', () => {
    const needle = bestQuoteNeedle([
      comment({ anchor: { quote: 'short one', prefix: '', suffix: '' } }),
      comment({ anchor: { quote: 'a much longer quoted passage\nsecond line', prefix: '', suffix: '' } }),
    ])
    expect(needle).toBe('a much longer quoted passage')
  })

  it('refuses a quote too short to identify a file', () => {
    expect(bestQuoteNeedle([comment({ anchor: { quote: 'yes', prefix: '', suffix: '' } })])).toBeNull()
    expect(bestQuoteNeedle([comment()])).toBeNull() // no anchor at all
  })

  it('clips a very long quote to something a substring search can still match', () => {
    const long = 'x'.repeat(400)
    expect(bestQuoteNeedle([comment({ anchor: { quote: long, prefix: '', suffix: '' } })])!.length).toBe(120)
  })
})

describe('findOrphanGroups', () => {
  it('groups only the comments whose file is gone', () => {
    const groups = findOrphanGroups(
      [
        comment({ path: 'notes/here.md' }),
        comment({ path: 'notes/gone.md', text: 'first' }),
        comment({ path: 'notes/gone.md', text: 'second' }),
      ],
      new Set(['notes/here.md']),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].path).toBe('notes/gone.md')
    expect(groups[0].comments).toHaveLength(2)
  })

  it('trusts an explicit orphan flag even when a live file shares the name', () => {
    // An encrypted space marks these itself: the node is trashed, and the name
    // it left behind may well be in use by a different, living page.
    const groups = findOrphanGroups(
      [comment({ path: 'idea.md', orphan: true, node_id: 'n1' })],
      new Set(['idea.md']),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].nodeId).toBe('n1')
  })

  it('keeps two deleted pages of the same name apart, by node', () => {
    const groups = findOrphanGroups(
      [
        comment({ path: 'idea.md', orphan: true, node_id: 'n1' }),
        comment({ path: 'idea.md', orphan: true, node_id: 'n2' }),
      ],
      new Set(),
    )
    expect(groups).toHaveLength(2)
  })
})

describe('findCommentTargets', () => {
  const group = (over: Partial<AllCommentItem> = {}) => ({
    path: 'notes/meeting.md',
    comments: [comment({ anchor: { quote: 'the quarterly numbers we discussed', prefix: '', suffix: '' }, ...over })],
  })
  const paths = ['archive/meeting.md', 'minutes/2026-q1.md', 'notes/groceries.md']

  it('leads with the file that still holds the quoted passage', async () => {
    const out = await findCommentTargets({
      group: group(),
      paths,
      search: async (needle) => {
        expect(needle).toBe('the quarterly numbers we discussed')
        return [{ path: 'minutes/2026-q1.md' }, { path: 'minutes/2026-q1.md' }]
      },
    })
    expect(out[0]).toMatchObject({ path: 'minutes/2026-q1.md', reason: 'quote' })
    expect(out.filter((c) => c.path === 'minutes/2026-q1.md')).toHaveLength(1) // deduped
  })

  it('falls back to names when the search fails or there is no usable quote', async () => {
    const broken = await findCommentTargets({ group: group(), paths, search: async () => { throw new Error('offline') } })
    expect(broken[0]).toMatchObject({ path: 'archive/meeting.md', reason: 'name' })

    const noQuote = await findCommentTargets({
      group: { path: 'notes/meeting.md', comments: [comment()] },
      paths,
      search: async () => { throw new Error('must not be called') },
    })
    expect(noQuote[0]).toMatchObject({ path: 'archive/meeting.md', reason: 'name' })
  })
})
