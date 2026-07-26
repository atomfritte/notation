import { describe, expect, it } from 'vitest'
import { generateDEK, importContentKey } from '../../shared/crypto/keys'
import { InMemoryEncStore } from '../../shared/vfs/encStore'
import { EncryptedFS } from '../../shared/vfs/encfs'
import type { AllCommentItem } from './api'
import { allComments, fileComments, migrateLegacyComments, reattachComments } from './encComments'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

async function fsWithFiles() {
  const store = new InMemoryEncStore()
  const fs = await EncryptedFS.open(store, await importContentKey(generateDEK()), 'A')
  await fs.write('readme.md', enc('r'))
  await fs.write('notes/deep.md', enc('d'))
  return fs
}

const legacy = (over: Partial<AllCommentItem>): AllCommentItem => ({
  id: over.id ?? 'x',
  parent_id: over.parent_id,
  path: over.path ?? 'readme.md',
  created_at: over.created_at ?? '2026-01-01T00:00:00.000Z',
  author: over.author ?? 'admin:me',
  text: over.text ?? 'body',
  anchor: over.anchor,
})

describe('migrateLegacyComments', () => {
  it('maps plaintext path-based comments onto nodeIds and preserves threading', async () => {
    const fs = await fsWithFiles()
    const migrated = await migrateLegacyComments(fs, [
      legacy({ id: 'top', path: 'readme.md', text: 'top-level', created_at: '2026-01-01T00:00:00.000Z' }),
      legacy({ id: 'rep', parent_id: 'top', path: 'readme.md', text: 'a reply' }),
      legacy({ id: 'other', path: 'notes/deep.md', text: 'on deep' }),
    ])
    expect(migrated).toBe(3)

    const readmeNode = fs.idAt('readme.md')!
    const onReadme = fileComments(fs, readmeNode)
    // Two comments on readme, threading preserved through re-mapped ids.
    const top = onReadme.find((c) => c.text === 'top-level')!
    const reply = onReadme.find((c) => c.text === 'a reply')!
    expect(top.parent_id).toBeUndefined()
    expect(reply.parent_id).toBe(top.id)
    // Original timestamp is kept.
    expect(top.created_at).toBe('2026-01-01T00:00:00.000Z')

    // The space-wide view resolves each comment back to its path.
    const all = allComments(fs)
    expect(all.filter((c) => c.path === 'readme.md')).toHaveLength(2)
    expect(all.filter((c) => c.path === 'notes/deep.md')).toHaveLength(1)
  })

  it('skips comments whose file no longer exists', async () => {
    const fs = await fsWithFiles()
    const migrated = await migrateLegacyComments(fs, [
      legacy({ id: 'ghost', path: 'deleted/gone.md', text: 'orphaned' }),
      legacy({ id: 'ok', path: 'readme.md', text: 'kept' }),
    ])
    expect(migrated).toBe(1)
    expect(allComments(fs).map((c) => c.text)).toEqual(['kept'])
  })

  it('drops a reply whose parent did not migrate', async () => {
    const fs = await fsWithFiles()
    const migrated = await migrateLegacyComments(fs, [
      legacy({ id: 'top', path: 'deleted/gone.md', text: 'parent-on-missing-file' }),
      legacy({ id: 'rep', parent_id: 'top', path: 'readme.md', text: 'reply-to-ghost' }),
    ])
    // Parent skipped (file gone) → reply has no valid parent → dropped too.
    expect(migrated).toBe(0)
    expect(allComments(fs)).toHaveLength(0)
  })
})

// ─── stranded threads ────────────────────────────────────────────────────────
// A page can leave without its comments: deleted and re-created elsewhere, or
// pushed back from a folder in a shape no move detection caught. The comments
// are still in the log — they just have nothing to open.

describe('allComments and orphaned files', () => {
  it('resolves a live comment to its path and node id', async () => {
    const fs = await fsWithFiles()
    const nodeId = fs.idAt('readme.md')!
    await fs.addComment(nodeId, { text: 'hello', author: 'me' })

    const [item] = allComments(fs)
    expect(item).toMatchObject({ path: 'readme.md', node_id: nodeId, text: 'hello' })
    expect(item.orphan).toBeUndefined()
  })

  it('keeps a deleted page’s comments, marked, instead of dropping them silently', async () => {
    const fs = await fsWithFiles()
    const nodeId = fs.idAt('notes/deep.md')!
    await fs.addComment(nodeId, { text: 'still here', author: 'me' })
    await fs.remove('notes/deep.md')

    const [item] = allComments(fs)
    expect(item.orphan).toBe(true)
    expect(item.node_id).toBe(nodeId)
    // A trashed node keeps its name but not its place — that name is what the
    // repair UI matches candidates against.
    expect(item.path).toBe('deep.md')
  })
})

describe('reattachComments', () => {
  it('moves a whole thread onto another file, keeping author, time and anchor', async () => {
    const fs = await fsWithFiles()
    const from = fs.idAt('readme.md')!
    const to = fs.idAt('notes/deep.md')!

    const top = await fs.addComment(from, {
      text: 'the point',
      author: 'ada',
      createdAt: '2026-01-02T03:04:05.000Z',
      anchor: { quote: 'a passage', prefix: '', suffix: '' },
    })
    await fs.addComment(from, { text: 'agreed', author: 'bob', parentId: top.id })
    await fs.addComment(from, { text: '', emoji: '🎉', author: 'ada', anchor: { quote: 'a passage', prefix: '', suffix: '' } })

    const moved = await reattachComments(fs, from, to)

    expect(moved).toBe(3)
    expect(fileComments(fs, from)).toHaveLength(0)
    const landed = fs.commentsForNode(to)
    expect(landed).toHaveLength(3)
    const carried = landed.find((c) => c.text === 'the point')!
    expect(carried.author).toBe('ada')
    expect(carried.createdAt).toBe('2026-01-02T03:04:05.000Z')
    expect(carried.anchor?.quote).toBe('a passage')
    // The reply still hangs off its (re-minted) parent, one level deep.
    expect(landed.find((c) => c.text === 'agreed')!.parentId).toBe(carried.id)
    expect(landed.find((c) => c.emoji === '🎉')).toBeTruthy()
  })

  it('repairs a thread whose file was deleted and re-created elsewhere', async () => {
    const fs = await fsWithFiles()
    const orphaned = fs.idAt('notes/deep.md')!
    await fs.addComment(orphaned, { text: 'keep this', author: 'me' })
    // What a naive push does: delete here, create there — a brand-new node.
    await fs.remove('notes/deep.md')
    await fs.write('projects/deep.md', enc('d'))
    expect(allComments(fs)[0].orphan).toBe(true)

    await reattachComments(fs, orphaned, fs.idAt('projects/deep.md')!)

    const [item] = allComments(fs)
    expect(item.orphan).toBeUndefined()
    expect(item.path).toBe('projects/deep.md')
    expect(item.text).toBe('keep this')
  })

  it('is a no-op for the same node or an empty thread', async () => {
    const fs = await fsWithFiles()
    const a = fs.idAt('readme.md')!
    expect(await reattachComments(fs, a, a)).toBe(0)
    expect(await reattachComments(fs, a, fs.idAt('notes/deep.md')!)).toBe(0)
  })
})
