import { describe, expect, it } from 'vitest'
import { assertSafeId, blobPath, isSafeId, newBlobId, newNodeId, newOpId, opPath } from './ids'

describe('id generators', () => {
  it('produce valid, unique 32-char hex ids', () => {
    for (const gen of [newNodeId, newBlobId, newOpId]) {
      const a = gen()
      const b = gen()
      expect(a).toMatch(/^[0-9a-f]{32}$/)
      expect(a).not.toBe(b)
      expect(isSafeId(a)).toBe(true)
    }
  })
})

describe('isSafeId', () => {
  it('accepts well-formed hex ids', () => {
    expect(isSafeId('0123456789abcdef')).toBe(true)
    expect(isSafeId(newNodeId())).toBe(true)
  })

  it('rejects unsafe or malformed ids', () => {
    for (const bad of ['', 'ABCDEF01', 'xyz', 'abc', '../etc', 'a/b', 'blobs/1', 'has space', 'g0000000']) {
      expect(isSafeId(bad)).toBe(false)
    }
  })

  it('assertSafeId throws on bad ids', () => {
    expect(() => assertSafeId('../etc')).toThrow(/unsafe id/)
    expect(() => assertSafeId(newNodeId())).not.toThrow()
  })
})

describe('storage paths', () => {
  it('build validated blob/op paths', () => {
    const id = newBlobId()
    expect(blobPath(id)).toBe(`blobs/${id}`)
    expect(opPath(id)).toBe(`ops/${id}`)
  })

  it('refuse to build a path from an unsafe id', () => {
    expect(() => blobPath('../secret')).toThrow(/unsafe id/)
    expect(() => opPath('a/b')).toThrow(/unsafe id/)
  })
})
