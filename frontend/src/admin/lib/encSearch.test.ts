import { describe, expect, it } from 'vitest'
import { EncryptedFS } from '../../shared/vfs/encfs'
import { InMemoryEncStore } from '../../shared/vfs/encStore'
import { generateDEK, importContentKey } from '../../shared/crypto/keys'
import { EncryptedSearchIndex, createEncryptedSearchIndex } from './encSearch'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const newKey = () => importContentKey(generateDEK())

/** Build a fresh encrypted FS seeded with the given path→text files. */
async function seedFS(files: Record<string, string>): Promise<EncryptedFS> {
  const fs = await EncryptedFS.open(new InMemoryEncStore(), await newKey(), 'A')
  for (const [path, body] of Object.entries(files)) {
    await fs.write(path, enc(body))
  }
  await fs.sync()
  return fs
}

describe('EncryptedSearchIndex', () => {
  it('finds the right files + 1-indexed lines and returns the GrepMatch shape', async () => {
    const fs = await seedFS({
      'notes/alpha.md': 'first line\nthe quick brown fox\nlast line',
      'notes/beta.md': 'nothing here\nfoxtrot is a word',
      'journal/gamma.md': '# gamma\n\nno match on this page',
    })
    const idx = createEncryptedSearchIndex(fs)

    const hits = await idx.search('fox')
    // alpha.md line 2 ("...brown fox") + beta.md line 2 ("foxtrot...").
    expect(hits).toEqual([
      { path: 'notes/alpha.md', line: 2, content: 'the quick brown fox' },
      { path: 'notes/beta.md', line: 2, content: 'foxtrot is a word' },
    ])
    // Exact shape: only path/line/content keys.
    expect(Object.keys(hits[0]).sort()).toEqual(['content', 'line', 'path'])
  })

  it('is case-insensitive (query and content case both ignored)', async () => {
    const fs = await seedFS({ 'a.md': 'Hello World\nGOODBYE' })
    const idx = createEncryptedSearchIndex(fs)

    expect((await idx.search('hello')).map(m => m.line)).toEqual([1])
    expect((await idx.search('WORLD')).map(m => m.line)).toEqual([1])
    expect((await idx.search('goodbye')).map(m => m.line)).toEqual([2])
  })

  it('returns [] for a query with no hits', async () => {
    const fs = await seedFS({ 'a.md': 'apples and oranges' })
    const idx = createEncryptedSearchIndex(fs)
    expect(await idx.search('bananas')).toEqual([])
  })

  it('returns [] for an empty query', async () => {
    const fs = await seedFS({ 'a.md': 'anything' })
    const idx = createEncryptedSearchIndex(fs)
    expect(await idx.search('')).toEqual([])
  })

  it('caps at the default 200 results', async () => {
    // One file with 250 matching lines — the server clamps to 200, so must we.
    const body = Array.from({ length: 250 }, (_, i) => `match line ${i}`).join('\n')
    const fs = await seedFS({ 'big.md': body })
    const idx = createEncryptedSearchIndex(fs)

    const hits = await idx.search('match')
    expect(hits.length).toBe(200)
    // The cap keeps the walk-order prefix: lines 1..200.
    expect(hits[0].line).toBe(1)
    expect(hits[199].line).toBe(200)
  })

  it('honours an explicit maxResults cap', async () => {
    const fs = await seedFS({ 'a.md': 'x\nx\nx\nx\nx' })
    const idx = createEncryptedSearchIndex(fs)
    expect((await idx.search('x', { maxResults: 3 })).length).toBe(3)
  })

  it('clips long lines to 240 chars + ellipsis, like the server', async () => {
    const long = 'q'.repeat(300)
    const fs = await seedFS({ 'a.md': long })
    const idx = createEncryptedSearchIndex(fs)
    const [hit] = await idx.search('q')
    expect(hit.content).toBe('q'.repeat(240) + '…')
    expect(hit.content.length).toBe(241)
  })

  it('skips binary / non-text nodes', async () => {
    const fs = await seedFS({
      'note.md': 'searchme in markdown',
      'image.png': 'searchme hidden in a png',
    })
    const idx = createEncryptedSearchIndex(fs)
    const hits = await idx.search('searchme')
    expect(hits.map(m => m.path)).toEqual(['note.md'])
  })

  it('reflects NEW content after a write + invalidate (no stale cache)', async () => {
    const fs = await seedFS({ 'a.md': 'oldword lives here' })
    const idx = createEncryptedSearchIndex(fs)

    // Populate the cache by searching the original content.
    expect((await idx.search('oldword')).length).toBe(1)

    // Overwrite the file (content overwrite reuses the path — no structural op).
    await fs.write('a.md', enc('newword lives here'))

    // Without invalidation the cache is stale (proves caching is real)…
    expect((await idx.search('oldword')).length).toBe(1)
    expect((await idx.search('newword')).length).toBe(0)

    // …after invalidating the path, the re-search reflects the new content.
    idx.invalidate('a.md')
    expect((await idx.search('oldword')).length).toBe(0)
    expect((await idx.search('newword')).map(m => m.path)).toEqual(['a.md'])
  })

  it('clear() drops the whole cache so every path re-decrypts', async () => {
    const fs = await seedFS({ 'a.md': 'oldword', 'b.md': 'oldword' })
    const idx = createEncryptedSearchIndex(fs)
    expect((await idx.search('oldword')).length).toBe(2) // warms both

    await fs.write('a.md', enc('newword'))
    await fs.write('b.md', enc('newword'))
    idx.clear()

    expect(await idx.search('oldword')).toEqual([])
    expect((await idx.search('newword')).length).toBe(2)
  })

  it('no longer matches a deleted file', async () => {
    const fs = await seedFS({ 'keep.md': 'target', 'gone.md': 'target' })
    const idx = createEncryptedSearchIndex(fs)
    expect((await idx.search('target')).map(m => m.path).sort()).toEqual(['gone.md', 'keep.md'])

    await fs.remove('gone.md')
    await fs.sync()
    // Deleted nodes drop out of fs.tree(), so the walk never visits gone.md —
    // even with a warm cache entry it can't appear in results.
    expect((await idx.search('target')).map(m => m.path)).toEqual(['keep.md'])
  })

  it('applies an optional glob filter with path.Match semantics', async () => {
    const fs = await seedFS({
      'root.md': 'keyword at root md',
      'root.txt': 'keyword at root txt',
      'sub/nested.md': 'keyword nested md',
    })
    const idx = new EncryptedSearchIndex(fs)

    // `*.md` matches a single segment only (no `/`), so nested.md is excluded.
    const md = await idx.search('keyword', { glob: '*.md' })
    expect(md.map(m => m.path)).toEqual(['root.md'])

    // `**`-style cross-segment matching isn't part of path.Match; use a class.
    const classed = await idx.search('keyword', { glob: 'root.[mt]*' })
    expect(classed.map(m => m.path).sort()).toEqual(['root.md', 'root.txt'])
  })

  it('walks files in the server walk order (dir children sorted by name)', async () => {
    const fs = await seedFS({
      'b.md': 'z',
      'a.md': 'z',
      'm/y.md': 'z',
      'm/x.md': 'z',
    })
    const idx = createEncryptedSearchIndex(fs)
    // Pre-order, each dir's children sorted by name: a.md, b.md, then m/{x,y}.
    expect((await idx.search('z')).map(m => m.path)).toEqual([
      'a.md', 'b.md', 'm/x.md', 'm/y.md',
    ])
  })
})
