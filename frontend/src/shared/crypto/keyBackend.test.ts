/**
 * Key-backend transport behaviour, exercised through the in-process backend
 * (the same keyCore the browser worker runs). Covers the slot lifecycle the
 * worker refactor introduced: import → use → drop, plus unknown-slot rejection.
 */
import { describe, expect, it } from 'vitest'
import { InProcessKeyBackend } from './keyBackend'
import { generateDEK } from './frame'
import { utf8Decode, utf8Encode } from './bytes'

describe('InProcessKeyBackend slot lifecycle', () => {
  it('imports a DEK, then encrypts + decrypts through the slot', async () => {
    const be = new InProcessKeyBackend()
    const { slotId } = await be.importDEK(generateDEK())
    const blob = await be.encrypt(slotId, utf8Encode('hello'))
    expect(utf8Decode(await be.decrypt(slotId, blob))).toBe('hello')
  })

  it('rejects ops against an unknown slot', async () => {
    const be = new InProcessKeyBackend()
    await expect(be.encrypt('slot_deadbeef', utf8Encode('x'))).rejects.toThrow(/unknown key slot/)
  })

  it('drop() forgets the DEK: further ops on the slot fail', async () => {
    const be = new InProcessKeyBackend()
    const { slotId } = await be.importDEK(generateDEK())
    const blob = await be.encrypt(slotId, utf8Encode('secret'))
    await be.drop(slotId)
    await expect(be.decrypt(slotId, blob)).rejects.toThrow(/unknown key slot/)
  })

  it('create → unlock round-trips content, and a wrong password is rejected', async () => {
    const be = new InProcessKeyBackend()
    const fast = { algorithm: 'argon2id' as const, memoryKiB: 256, iterations: 1, parallelism: 1, keyLen: 32 }
    const { record, slotId } = await be.createSpace('pw-123', fast)
    const blob = await be.encrypt(slotId, utf8Encode('unlock me'))

    const { slotId: reopened } = await be.unlockPassword(record, 'pw-123')
    expect(utf8Decode(await be.decrypt(reopened, blob))).toBe('unlock me')

    await expect(be.unlockPassword(record, 'nope')).rejects.toThrow()
  })
})
