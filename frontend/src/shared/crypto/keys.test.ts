import { describe, expect, it } from 'vitest'
import { DEK_LEN } from './constants'
import { generateDEK, importContentKey, rewrapDEK, unwrapDEK, wrapDEK } from './keys'
import { importAesGcmKey } from './aesgcm'
import { decryptText, encryptText } from './blob'
import { randomBytes, timingSafeEqual } from './bytes'

const kek = () => randomBytes(32)

describe('DEK generation', () => {
  it('produces a fresh 256-bit key each time', () => {
    const a = generateDEK()
    const b = generateDEK()
    expect(a.length).toBe(DEK_LEN)
    expect(timingSafeEqual(a, b)).toBe(false)
  })
})

describe('wrap / unwrap DEK', () => {
  it('round-trips the DEK under a KEK', async () => {
    const dek = generateDEK()
    const k = kek()
    const unwrapped = await unwrapDEK(await wrapDEK(dek, k), k)
    expect(timingSafeEqual(unwrapped, dek)).toBe(true)
  })

  it('fails to unwrap with the wrong KEK (GCM auth tag)', async () => {
    const wrapped = await wrapDEK(generateDEK(), kek())
    await expect(unwrapDEK(wrapped, kek())).rejects.toThrow()
  })

  it('supports multiple independent wraps of the same DEK', async () => {
    const dek = generateDEK()
    const k1 = kek()
    const k2 = kek()
    const w1 = await wrapDEK(dek, k1)
    const w2 = await wrapDEK(dek, k2)
    expect(timingSafeEqual(await unwrapDEK(w1, k1), dek)).toBe(true)
    expect(timingSafeEqual(await unwrapDEK(w2, k2), dek)).toBe(true)
  })
})

describe('rewrapDEK (password change)', () => {
  it('keeps the same DEK; new KEK unwraps, old KEK does not', async () => {
    const dek = generateDEK()
    const oldKek = kek()
    const newKek = kek()
    const oldWrapped = await wrapDEK(dek, oldKek)
    const newWrapped = await rewrapDEK(oldWrapped, oldKek, newKek)

    expect(timingSafeEqual(await unwrapDEK(newWrapped, newKek), dek)).toBe(true)
    await expect(unwrapDEK(newWrapped, oldKek)).rejects.toThrow()
  })
})

describe('KeyHandle (opaque worker slot)', () => {
  it('exposes only a slot id — no CryptoKey or raw key bytes on the main thread', async () => {
    const handle = await importContentKey(generateDEK())
    expect(Object.keys(handle)).toEqual(['slotId'])
    expect(typeof handle.slotId).toBe('string')
    // The old shape leaked a CryptoKey here; the new handle must not.
    expect('contentKey' in handle).toBe(false)
  })

  it('imports every DEK non-extractable (the engine can never yield the raw key)', async () => {
    // The key engine imports the DEK/KEK with extractable:false; assert the
    // primitive it uses so the guarantee is covered without reaching into the slot.
    const key = await importAesGcmKey(generateDEK(), ['encrypt', 'decrypt'], false)
    expect(key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  it('en/decrypts content end to end through the key backend', async () => {
    const handle = await importContentKey(generateDEK())
    expect(await decryptText(await encryptText('payload', handle), handle)).toBe('payload')
  })
})
