import { describe, expect, it } from 'vitest'
import { CipherSuite, FORMAT_VERSION, GCM_NONCE_LEN, HEADER_LEN } from './constants'
import { decryptBlob, decryptText, encryptBlob, encryptText } from './blob'
import { generateDEK, importContentKey } from './keys'
import { utf8Encode } from './bytes'

async function freshHandle() {
  return importContentKey(generateDEK())
}

describe('encryptBlob / decryptBlob', () => {
  it('round-trips arbitrary bytes', async () => {
    const key = await freshHandle()
    const plaintext = utf8Encode('the quick brown fox')
    const blob = await encryptBlob(plaintext, key)
    expect([...(await decryptBlob(blob, key))]).toEqual([...plaintext])
  })

  it('round-trips unicode text', async () => {
    const key = await freshHandle()
    const text = 'zero-knowledge — 秘密 🔒'
    expect(await decryptText(await encryptText(text, key), key)).toBe(text)
  })

  it('emits a self-framing version+suite header', async () => {
    const key = await freshHandle()
    const blob = await encryptBlob(utf8Encode('x'), key)
    expect(blob[0]).toBe(FORMAT_VERSION)
    expect(blob[1]).toBe(CipherSuite.AES_256_GCM)
    // header + 96-bit nonce + ciphertext + 128-bit tag
    expect(blob.length).toBe(HEADER_LEN + GCM_NONCE_LEN + 1 + 16)
  })

  it('uses a fresh nonce so identical plaintext yields different blobs', async () => {
    const key = await freshHandle()
    const a = await encryptBlob(utf8Encode('same'), key)
    const b = await encryptBlob(utf8Encode('same'), key)
    expect([...a]).not.toEqual([...b])
    // nonces (bytes 2..14) differ
    expect([...a.subarray(HEADER_LEN, HEADER_LEN + GCM_NONCE_LEN)]).not.toEqual([
      ...b.subarray(HEADER_LEN, HEADER_LEN + GCM_NONCE_LEN),
    ])
  })

  it('fails to decrypt tampered ciphertext (AEAD integrity)', async () => {
    const key = await freshHandle()
    const blob = await encryptBlob(utf8Encode('secret'), key)
    blob[blob.length - 1] ^= 0x01
    await expect(decryptBlob(blob, key)).rejects.toThrow()
  })

  it('fails when the header is tampered (bound as AAD)', async () => {
    const key = await freshHandle()
    const blob = await encryptBlob(utf8Encode('secret'), key)
    blob[1] = 99 // unknown suite id
    await expect(decryptBlob(blob, key)).rejects.toThrow(/suite/)
  })

  it('fails to decrypt with the wrong key', async () => {
    const blob = await encryptBlob(utf8Encode('secret'), await freshHandle())
    await expect(decryptBlob(blob, await freshHandle())).rejects.toThrow()
  })

  it('rejects a truncated blob', async () => {
    const key = await freshHandle()
    await expect(decryptBlob(new Uint8Array(3), key)).rejects.toThrow(/too short/)
  })

  it('binds optional AAD: same AAD decrypts, different AAD fails', async () => {
    const key = await freshHandle()
    const aad = utf8Encode('context-A')
    const blob = await encryptBlob(utf8Encode('secret'), key, aad)
    expect(await decryptText(blob, key, aad)).toBe('secret')
    await expect(decryptBlob(blob, key, utf8Encode('context-B'))).rejects.toThrow()
  })

  it('is keyed only by the opaque handle: a second handle over the same DEK decrypts it', async () => {
    // No bare CryptoKey exists on the main thread any more — the DEK identity is
    // what decrypts, so an independent handle imported from the same DEK opens
    // the first handle's blob.
    const dek = generateDEK()
    const h1 = await importContentKey(dek)
    const h2 = await importContentKey(dek)
    const blob = await encryptBlob(utf8Encode('via same dek'), h1)
    expect(await decryptText(blob, h2)).toBe('via same dek')
  })
})
