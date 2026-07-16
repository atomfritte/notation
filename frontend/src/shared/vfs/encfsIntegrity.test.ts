import { describe, expect, it } from 'vitest'
import { generateDEK, importContentKey } from '../crypto/keys'
import type { KeyHandle } from '../crypto/keys'
import { InMemoryEncStore, type EncStore, type StoredOp } from './encStore'
import type { SpaceKeyRecord } from '../crypto/space'
import { EncryptedFS } from './encfs'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const newKey = (): Promise<KeyHandle> => importContentKey(generateDEK())

/**
 * Rewrite the cleartext framing lamport of an op envelope to 0 WITHOUT touching
 * the ciphertext — exactly what a byzantine server would try, to make a client
 * skip an op (`meta.lamport <= checkpointLamport`) without decrypting it.
 * Framing: uint32-BE metaLen || meta(JSON) || ciphertext.
 */
function zeroFramingLamport(blob: Uint8Array): Uint8Array {
  const metaLen = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0, false)
  const meta = JSON.parse(new TextDecoder().decode(blob.subarray(4, 4 + metaLen)))
  meta.lamport = 0
  const newMeta = enc(JSON.stringify(meta))
  const ct = blob.subarray(4 + metaLen)
  const out = new Uint8Array(4 + newMeta.length + ct.length)
  new DataView(out.buffer).setUint32(0, newMeta.length, false)
  out.set(newMeta, 4)
  out.set(ct, 4 + newMeta.length)
  return out
}

/** A malicious store that zeroes every op's framing lamport on read. */
class LamportZeroingStore implements EncStore {
  constructor(private readonly inner: InMemoryEncStore) {}
  async listOps(since: number): Promise<StoredOp[]> {
    const ops = await this.inner.listOps(since)
    return ops.map((o) => ({ ...o, blob: zeroFramingLamport(o.blob) }))
  }
  getBlob(id: string) { return this.inner.getBlob(id) }
  putBlob(id: string, b: Uint8Array) { return this.inner.putBlob(id, b) }
  deleteBlob(id: string) { return this.inner.deleteBlob(id) }
  appendOp(id: string, b: Uint8Array) { return this.inner.appendOp(id, b) }
  getCheckpoint() { return this.inner.getCheckpoint() }
  putCheckpoint(b: Uint8Array) { return this.inner.putCheckpoint(b) }
  getKeyRecord(): Promise<SpaceKeyRecord | null> { return this.inner.getKeyRecord() }
  putKeyRecord(r: SpaceKeyRecord) { return this.inner.putKeyRecord(r) }
}

describe('EncryptedFS op-log integrity', () => {
  it('rejects (does not silently skip) an op whose cleartext framing lamport was tampered', async () => {
    const inner = new InMemoryEncStore()
    const key = await newKey()
    const fs = await EncryptedFS.open(inner, key, 'A')
    await fs.write('secret.md', enc('body'))
    expect(fs.tree().some((n) => n.name === 'secret.md')).toBe(true)

    // A fresh replica loading through the tampering store must FAIL LOUDLY — the
    // decrypt-first skip means the doctored lamport is caught by the AES-GCM AAD
    // check, rather than causing the create op to be silently dropped.
    await expect(EncryptedFS.open(new LamportZeroingStore(inner), key, 'B')).rejects.toThrow()
  })
})
