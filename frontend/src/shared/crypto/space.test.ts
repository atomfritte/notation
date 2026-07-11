import { describe, expect, it } from 'vitest'
import type { KdfParams } from './kdf'
import {
  changePassword,
  createEncryptedSpace,
  unlockWithPassword,
  unlockWithRecovery,
} from './space'
import { decryptText, encryptText } from './blob'

// Cheap KDF params keep the flow fast; semantics are identical to the defaults.
const fast: KdfParams = { algorithm: 'argon2id', memoryKiB: 256, iterations: 1, parallelism: 1, keyLen: 32 }

describe('space unlock flows', () => {
  it('creates a space and unlocks it with the password', async () => {
    const { record, handle } = await createEncryptedSpace('hunter2', fast)
    const cipher = await encryptText('top secret', handle)

    const reopened = await unlockWithPassword(record, 'hunter2')
    expect(await decryptText(cipher, reopened)).toBe('top secret')
  })

  it('rejects the wrong password', async () => {
    const { record } = await createEncryptedSpace('hunter2', fast)
    await expect(unlockWithPassword(record, 'wrong')).rejects.toThrow()
  })

  it('unlocks with the recovery key and rejects a wrong one', async () => {
    const { record, recoveryDisplay, handle } = await createEncryptedSpace('hunter2', fast)
    const cipher = await encryptText('recover me', handle)

    const viaRecovery = await unlockWithRecovery(record, recoveryDisplay)
    expect(await decryptText(cipher, viaRecovery)).toBe('recover me')

    // A different, valid-format recovery key must not unwrap this DEK.
    const other = (await createEncryptedSpace('x', fast)).recoveryDisplay
    await expect(unlockWithRecovery(record, other)).rejects.toThrow()
  })

  it('changes password by re-wrap: old fails, new works, same DEK decrypts old content', async () => {
    const created = await createEncryptedSpace('old-pw', fast)
    const cipher = await encryptText('unchanged content', created.handle)

    const updated = await changePassword(created.record, 'old-pw', 'new-pw')

    await expect(unlockWithPassword(updated, 'old-pw')).rejects.toThrow()
    const reopened = await unlockWithPassword(updated, 'new-pw')
    // Same DEK underneath: content encrypted before the change still decrypts.
    expect(await decryptText(cipher, reopened)).toBe('unchanged content')
  })

  it('leaves the recovery wrap working after a password change', async () => {
    const created = await createEncryptedSpace('old-pw', fast)
    const cipher = await encryptText('still recoverable', created.handle)
    const updated = await changePassword(created.record, 'old-pw', 'new-pw')

    const viaRecovery = await unlockWithRecovery(updated, created.recoveryDisplay)
    expect(await decryptText(cipher, viaRecovery)).toBe('still recoverable')
  })

  it('rejects change-password with the wrong old password', async () => {
    const { record } = await createEncryptedSpace('old-pw', fast)
    await expect(changePassword(record, 'not-it', 'new-pw')).rejects.toThrow()
  })
})
