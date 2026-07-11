import { describe, expect, it } from 'vitest'
import { concatBytes, fromHex, randomBytes, timingSafeEqual, toHex, utf8Decode, utf8Encode } from './bytes'

describe('byte helpers', () => {
  it('round-trips UTF-8 text including multibyte characters', () => {
    const text = 'héllo — 世界 🌍'
    expect(utf8Decode(utf8Encode(text))).toBe(text)
  })

  it('concatenates buffers in order into a fresh array', () => {
    const out = concatBytes(new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3]))
    expect([...out]).toEqual([1, 2, 3])
  })

  it('round-trips hex encoding', () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xa0, 0xff])
    expect(toHex(bytes)).toBe('000fa0ff')
    expect([...fromHex('000fa0ff')]).toEqual([0, 15, 160, 255])
  })

  it('rejects malformed hex', () => {
    expect(() => fromHex('abc')).toThrow()
    expect(() => fromHex('zz')).toThrow()
  })

  it('produces random bytes of the requested length', () => {
    const a = randomBytes(32)
    const b = randomBytes(32)
    expect(a.length).toBe(32)
    expect(timingSafeEqual(a, b)).toBe(false)
  })

  it('compares bytes for equality', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })
})
