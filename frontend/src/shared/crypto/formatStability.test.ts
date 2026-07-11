/**
 * Format-stability regression: the worker refactor must NOT change a single byte
 * of the on-disk blob/op framing, or spaces created before it stop opening.
 *
 * We pin the framing two independent ways under a KNOWN DEK:
 *   1. a blob produced by the (worker-backed) public API decrypts with a DIRECT
 *      WebCrypto reference that assumes the documented layout
 *      `version || suite || nonce(12) || ciphertext+tag(16)` — proving the new
 *      code still emits exactly that;
 *   2. a blob hand-built by that reference decryptor (i.e. an "old" blob) opens
 *      through the new `decryptBlob` — proving old ciphertext still reads.
 * The op envelope is the same framing with a bound AAD, so it is covered too.
 */
import { describe, expect, it } from 'vitest'
import { CipherSuite, FORMAT_VERSION, GCM_NONCE_LEN, GCM_TAG_LEN, HEADER_LEN } from './constants'
import { decryptBlob, encryptBlob } from './blob'
import { importContentKey } from './keys'
import { concatBytes, utf8Decode, utf8Encode } from './bytes'
import { sealOp } from '../vfs/opCrypto'
import type { CreateOp } from '../vfs/ops'
import { ROOT_ID } from '../vfs/nodes'

// A fixed, known DEK so the framing assertions are deterministic.
const DEK = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff)
const PLAINTEXT = utf8Encode('format-stability payload — 秘密 🔒')

/** Reference AES-256-GCM key over the same raw DEK, imported directly. */
function refKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', DEK as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

const header = () => new Uint8Array([FORMAT_VERSION, CipherSuite.AES_256_GCM])

describe('on-disk format stability (worker refactor is byte-transparent)', () => {
  it('emits exactly version||suite||nonce(12)||ct+tag(16)', async () => {
    const handle = await importContentKey(DEK)
    const blob = await encryptBlob(PLAINTEXT, handle)

    expect(blob[0]).toBe(FORMAT_VERSION)
    expect(blob[1]).toBe(CipherSuite.AES_256_GCM)
    expect(blob.length).toBe(HEADER_LEN + GCM_NONCE_LEN + PLAINTEXT.length + GCM_TAG_LEN)
  })

  it('a new-code blob decrypts with a direct WebCrypto reference (framing unchanged)', async () => {
    const handle = await importContentKey(DEK)
    const blob = await encryptBlob(PLAINTEXT, handle)

    const hdr = blob.subarray(0, HEADER_LEN)
    const nonce = blob.subarray(HEADER_LEN, HEADER_LEN + GCM_NONCE_LEN)
    const ct = blob.subarray(HEADER_LEN + GCM_NONCE_LEN)
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce as unknown as BufferSource, additionalData: hdr as unknown as BufferSource },
        await refKey(),
        ct as unknown as BufferSource,
      ),
    )
    expect([...pt]).toEqual([...PLAINTEXT])
  })

  it("an 'old' reference-built blob still opens through the new decryptBlob (with and without AAD)", async () => {
    const handle = await importContentKey(DEK)

    for (const aad of [undefined, utf8Encode('blob-abc')]) {
      const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_LEN))
      const fullAad = aad ? concatBytes(header(), aad) : header()
      const ct = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce as unknown as BufferSource, additionalData: fullAad as unknown as BufferSource },
          await refKey(),
          PLAINTEXT as unknown as BufferSource,
        ),
      )
      const oldBlob = concatBytes(header(), nonce, ct)
      expect(utf8Decode(await decryptBlob(oldBlob, handle, aad))).toBe(utf8Decode(PLAINTEXT))
    }
  })

  it('sealed op ciphertext uses the same framing (reference-decryptable under its AAD)', async () => {
    const handle = await importContentKey(DEK)
    const op: CreateOp = {
      type: 'create', opId: 'op1', nodeId: 'n1', parentId: ROOT_ID, name: 'secret', nodeType: 'dir', lamport: 3, actorId: 'dev',
    }
    const env = await sealOp(op, handle)
    // opCrypto binds `opId|lamport|actorId` as AAD; rebuild it and reference-decrypt.
    const aad = utf8Encode(`${op.opId}|${op.lamport}|${op.actorId}`)
    const blob = env.ciphertext
    const hdr = blob.subarray(0, HEADER_LEN)
    const nonce = blob.subarray(HEADER_LEN, HEADER_LEN + GCM_NONCE_LEN)
    const ct = blob.subarray(HEADER_LEN + GCM_NONCE_LEN)
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce as unknown as BufferSource, additionalData: concatBytes(hdr, aad) as unknown as BufferSource },
        await refKey(),
        ct as unknown as BufferSource,
      ),
    )
    expect(JSON.parse(utf8Decode(pt))).toEqual(op)
  })
})
