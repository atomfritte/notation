import { describe, expect, it } from 'vitest'
import { RECOVERY_KEY_LEN } from './constants'
import {
  generateRecoveryKey,
  parseRecoveryKey,
  unwrapDEKWithRecovery,
  wrapDEKWithRecovery,
} from './recovery'
import { generateDEK } from './keys'
import { timingSafeEqual } from './bytes'

describe('recovery key', () => {
  it('generates a 256-bit key with a grouped printable form', () => {
    const rk = generateRecoveryKey()
    expect(rk.bytes.length).toBe(RECOVERY_KEY_LEN)
    expect(rk.display).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/)
  })

  it('parses its own printable form back to the same bytes', () => {
    const rk = generateRecoveryKey()
    expect(timingSafeEqual(parseRecoveryKey(rk.display), rk.bytes)).toBe(true)
  })

  it('parses tolerantly of case and spacing', () => {
    const rk = generateRecoveryKey()
    const messy = rk.display.toLowerCase().replace(/-/g, ' ')
    expect(timingSafeEqual(parseRecoveryKey(messy), rk.bytes)).toBe(true)
  })

  it('rejects a too-short key', () => {
    expect(() => parseRecoveryKey('ABCD')).toThrow(/too short/)
  })

  it('wraps and unwraps a DEK; the wrong recovery key fails', async () => {
    const dek = generateDEK()
    const rk = generateRecoveryKey()
    const wrapped = await wrapDEKWithRecovery(dek, rk.bytes)
    expect(timingSafeEqual(await unwrapDEKWithRecovery(wrapped, rk.bytes), dek)).toBe(true)

    const wrong = generateRecoveryKey()
    await expect(unwrapDEKWithRecovery(wrapped, wrong.bytes)).rejects.toThrow()
  })
})
