import { describe, expect, it } from 'vitest'
import { DEFAULT_KDF_PARAMS, deriveKEK } from './kdf'
import type { KdfParams } from './kdf'
import { timingSafeEqual } from './bytes'

// Cheap params keep the suite fast; the crypto is identical to the defaults.
const fast: KdfParams = { algorithm: 'argon2id', memoryKiB: 256, iterations: 1, parallelism: 1, keyLen: 32 }
const salt = new Uint8Array(16).fill(7)

describe('deriveKEK (Argon2id)', () => {
  it('is deterministic for the same password, salt and params', async () => {
    const a = await deriveKEK('correct horse', salt, fast)
    const b = await deriveKEK('correct horse', salt, fast)
    expect(timingSafeEqual(a, b)).toBe(true)
    expect(a.length).toBe(32)
  })

  it('is salt-sensitive', async () => {
    const a = await deriveKEK('pw', new Uint8Array(16).fill(1), fast)
    const b = await deriveKEK('pw', new Uint8Array(16).fill(2), fast)
    expect(timingSafeEqual(a, b)).toBe(false)
  })

  it('is password-sensitive', async () => {
    const a = await deriveKEK('pw-one', salt, fast)
    const b = await deriveKEK('pw-two', salt, fast)
    expect(timingSafeEqual(a, b)).toBe(false)
  })

  it('honours the requested key length', async () => {
    const k = await deriveKEK('pw', salt, { ...fast, keyLen: 16 })
    expect(k.length).toBe(16)
  })

  it('rejects too-short salts and unknown algorithms', async () => {
    await expect(deriveKEK('pw', new Uint8Array(4), fast)).rejects.toThrow(/salt/)
    await expect(
      deriveKEK('pw', salt, { ...fast, algorithm: 'scrypt' as unknown as 'argon2id' }),
    ).rejects.toThrow(/algorithm/)
  })

  it('ships 64 MiB / 3-pass / 256-bit defaults', () => {
    expect(DEFAULT_KDF_PARAMS).toMatchObject({
      algorithm: 'argon2id',
      memoryKiB: 65536,
      iterations: 3,
      parallelism: 1,
      keyLen: 32,
    })
  })
})
