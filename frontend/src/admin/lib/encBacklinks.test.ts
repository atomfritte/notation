import { describe, expect, it } from 'vitest'
import { EncryptedFS } from '../../shared/vfs/encfs'
import { InMemoryEncStore } from '../../shared/vfs/encStore'
import { generateDEK, importContentKey } from '../../shared/crypto/keys'
import { createEncryptedSearchIndex } from './encSearch'

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

const sorted = (ms: { path: string }[]) => ms.map(m => m.path).sort()

describe('EncryptedSearchIndex.backlinks', () => {
  it('finds pages linking to the target incl. #section + |alias variants, skips non-matching links', async () => {
    const files = ['A.md', 'Other.md', 'B.md', 'C.md', 'D.md']
    const fs = await seedFS({
      'A.md': '# A\n\nthe target page',
      'Other.md': '# Other\n\na different page',
      'B.md': 'see [[A]] for details',
      'C.md': 'anchor [[A#intro]] and alias [[A|the A page]]',
      'D.md': 'this points at [[Other]], not the A page',
    })
    const idx = createEncryptedSearchIndex(fs)

    // B (plain), C (#section AND |alias both resolve to A) link to A. D doesn't.
    expect(sorted(await idx.backlinks('A.md', files))).toEqual(['B.md', 'C.md'])
    // Only D links to the existing Other page — the "the one file" case.
    expect(sorted(await idx.backlinks('Other.md', files))).toEqual(['D.md'])
  })

  it('returns the SearchMatch shape (path/line/content) pointing at the linking line', async () => {
    const files = ['A.md', 'B.md']
    const fs = await seedFS({ 'A.md': 'target', 'B.md': 'intro line\nlink to [[A]] here\ntail' })
    const idx = createEncryptedSearchIndex(fs)

    const hits = await idx.backlinks('A.md', files)
    expect(hits).toEqual([{ path: 'B.md', line: 2, content: 'link to [[A]] here' }])
    expect(Object.keys(hits[0]).sort()).toEqual(['content', 'line', 'path'])
  })

  it('resolves basename + case exactly like the plaintext link resolver', async () => {
    // notes/A.md linked from the root as [[A]] (basename resolution across folders),
    // and Guide.md linked as [[guide]] (case-insensitive basename match).
    const files = ['notes/A.md', 'Guide.md', 'root.md']
    const fs = await seedFS({
      'notes/A.md': 'deep target',
      'Guide.md': 'the guide',
      'root.md': 'jump to [[A]] and to [[guide]]',
    })
    const idx = createEncryptedSearchIndex(fs)

    expect(sorted(await idx.backlinks('notes/A.md', files))).toEqual(['root.md'])
    expect(sorted(await idx.backlinks('Guide.md', files))).toEqual(['root.md'])
  })

  it('a page with no inbound links has empty backlinks', async () => {
    const files = ['A.md', 'B.md']
    const fs = await seedFS({ 'A.md': 'links to [[B]]', 'B.md': 'nobody links to me' })
    const idx = createEncryptedSearchIndex(fs)
    // B is linked, A is not.
    expect(await idx.backlinks('A.md', files)).toEqual([])
    expect(sorted(await idx.backlinks('B.md', files))).toEqual(['A.md'])
  })

  it('a link to a non-existent page yields no backlinks (nothing resolves to it)', async () => {
    const files = ['B.md']
    const fs = await seedFS({ 'B.md': 'dangling [[Ghost]]' })
    const idx = createEncryptedSearchIndex(fs)
    // Ghost.md isn't in the Space, so the link resolves to nothing → no backlinks.
    expect(await idx.backlinks('Ghost.md', files)).toEqual([])
  })

  it('never lists the page as its own backlink (self-link excluded)', async () => {
    const files = ['A.md', 'B.md']
    const fs = await seedFS({ 'A.md': 'I link to myself via [[A]]', 'B.md': 'and I link to [[A]]' })
    const idx = createEncryptedSearchIndex(fs)
    expect(sorted(await idx.backlinks('A.md', files))).toEqual(['B.md'])
  })

  it('drops a linker after it is edited to remove the link (invalidate → no stale)', async () => {
    const files = ['A.md', 'B.md', 'C.md']
    const fs = await seedFS({
      'A.md': 'target',
      'B.md': 'link [[A]] one',
      'C.md': 'link [[A]] two',
    })
    const idx = createEncryptedSearchIndex(fs)
    expect(sorted(await idx.backlinks('A.md', files))).toEqual(['B.md', 'C.md'])

    // Overwrite B to remove its [[A]] (content overwrite reuses the path).
    await fs.write('B.md', enc('no more link here'))

    // Without invalidation the warm cache still reports the old link (cache is real)…
    expect(sorted(await idx.backlinks('A.md', files))).toEqual(['B.md', 'C.md'])

    // …after invalidating B's path, the recompute drops it.
    idx.invalidate('B.md')
    expect(sorted(await idx.backlinks('A.md', files))).toEqual(['C.md'])
  })

  it('clear() drops the whole cache so an edited linker re-resolves', async () => {
    const files = ['A.md', 'B.md']
    const fs = await seedFS({ 'A.md': 'target', 'B.md': 'link [[A]]' })
    const idx = createEncryptedSearchIndex(fs)
    expect(sorted(await idx.backlinks('A.md', files))).toEqual(['B.md']) // warms B

    await fs.write('B.md', enc('no link now'))
    idx.clear()
    expect(await idx.backlinks('A.md', files)).toEqual([])
  })

  it('drops a deleted linker (gone from the walk, even with a warm cache)', async () => {
    const files = ['A.md', 'keep.md', 'gone.md']
    const fs = await seedFS({
      'A.md': 'target',
      'keep.md': 'link [[A]]',
      'gone.md': 'link [[A]]',
    })
    const idx = createEncryptedSearchIndex(fs)
    expect(sorted(await idx.backlinks('A.md', files))).toEqual(['gone.md', 'keep.md'])

    await fs.remove('gone.md')
    await fs.sync()
    // gone.md is no longer in fs.tree(), so the walk never visits it.
    expect(sorted(await idx.backlinks('A.md', files.filter(f => f !== 'gone.md')))).toEqual(['keep.md'])
  })
})
