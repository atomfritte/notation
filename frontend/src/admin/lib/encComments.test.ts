import { describe, expect, it } from 'vitest'
import { generateDEK, importContentKey } from '../../shared/crypto/keys'
import { InMemoryEncStore } from '../../shared/vfs/encStore'
import { EncryptedFS } from '../../shared/vfs/encfs'
import type { AllCommentItem } from './api'
import { allComments, fileComments, migrateLegacyComments } from './encComments'

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
