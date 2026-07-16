import { beforeEach, describe, expect, it } from 'vitest'
import { loadRegistry, saveRegistry, type NodeIdCodec } from './newPages'
import { loadReadPos, saveReadPos, type PathCodec } from './readAloud'

// A tiny bidirectional path<->nodeId map standing in for an EncryptedFS.
const tree: Record<string, string> = { 'notes/secret.md': 'n1a2b3', 'readme.md': 'deadbeef' }
const codec: NodeIdCodec & PathCodec = {
  encode: (p) => tree[p],
  decode: (id) => Object.keys(tree).find((p) => tree[p] === id),
}

// A minimal in-memory localStorage — vitest's jsdom env doesn't enable one.
beforeEach(() => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  }
})

describe('new-page registry — encrypted keying', () => {
  it('persists nodeIds, never cleartext paths, and round-trips back to paths', () => {
    saveRegistry('k', { files: ['notes/secret.md', 'readme.md'], forms: {} }, codec)
    const raw = localStorage.getItem('k')!
    // The secret path must not appear in localStorage; the opaque nodeId does.
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('notes')
    expect(raw).toContain('n1a2b3')
    // Reading back resolves nodeIds → paths.
    expect(loadRegistry('k', codec)).toEqual({ files: ['notes/secret.md', 'readme.md'], forms: {} })
  })

  it('drops entries whose nodeId no longer resolves (deleted file)', () => {
    localStorage.setItem('k', JSON.stringify({ files: ['n1a2b3', 'gone999'], forms: {} }))
    expect(loadRegistry('k', codec)).toEqual({ files: ['notes/secret.md'], forms: {} })
  })

  it('plaintext spaces (no codec) keep storing paths as-is', () => {
    saveRegistry('k', { files: ['notes/secret.md'], forms: {} })
    expect(localStorage.getItem('k')).toContain('notes/secret.md')
    expect(loadRegistry('k')).toEqual({ files: ['notes/secret.md'], forms: {} })
  })
})

describe('read-aloud position — encrypted keying', () => {
  it('persists the file by nodeId, never a cleartext path, and round-trips', () => {
    saveReadPos('rp', { file: 'notes/secret.md', sentence: 7 }, codec)
    const raw = localStorage.getItem('rp')!
    expect(raw).not.toContain('secret')
    expect(raw).toContain('n1a2b3')
    expect(loadReadPos('rp', codec)).toEqual({ file: 'notes/secret.md', sentence: 7 })
  })

  it('does not persist a position whose path has no nodeId yet', () => {
    saveReadPos('rp', { file: 'unknown.md', sentence: 1 }, codec)
    expect(localStorage.getItem('rp')).toBeNull()
  })

  it('returns null when a stored nodeId no longer resolves', () => {
    localStorage.setItem('rp', JSON.stringify({ file: 'gone999', sentence: 3 }))
    expect(loadReadPos('rp', codec)).toBeNull()
  })
})
