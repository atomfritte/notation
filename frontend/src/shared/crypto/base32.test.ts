import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode } from './base32'
import { randomBytes } from './bytes'

describe('crockford base32', () => {
  it('round-trips buffers of every byte-length remainder mod 5', () => {
    for (const len of [1, 2, 3, 4, 5, 16, 31, 32, 33]) {
      const bytes = randomBytes(len)
      const decoded = base32Decode(base32Encode(bytes))
      expect([...decoded]).toEqual([...bytes])
    }
  })

  it('uses the ambiguity-free alphabet (no I, L, O, U)', () => {
    const encoded = base32Encode(randomBytes(64))
    expect(encoded).not.toMatch(/[ILOU]/)
  })

  it('decodes case-insensitively and ignores separators', () => {
    const bytes = randomBytes(32)
    const encoded = base32Encode(bytes)
    const grouped = (encoded.match(/.{1,4}/g) ?? []).join('-').toLowerCase()
    expect([...base32Decode(grouped)]).toEqual([...bytes])
  })

  it('folds look-alike characters O->0 and I/L->1', () => {
    expect([...base32Decode('O1')]).toEqual([...base32Decode('01')])
    expect([...base32Decode('I0')]).toEqual([...base32Decode('10')])
    expect([...base32Decode('L0')]).toEqual([...base32Decode('10')])
  })

  it('throws on an invalid character', () => {
    expect(() => base32Decode('AB!CD')).toThrow(/invalid character/)
  })
})
