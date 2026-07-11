/**
 * Space unlock orchestration — the handful of flows a caller performs: create,
 * unlock (password or recovery), and change password.
 *
 * Every secret step (KDF, DEK generation, wrap/unwrap, importing the DEK as a
 * CryptoKey) happens inside the key worker via {@link ./keyBackend}; this module
 * only shuttles the (non-secret) {@link SpaceKeyRecord} and returns opaque
 * {@link KeyHandle}s naming worker slots. The public signatures are unchanged
 * from before the worker refactor.
 *
 * The {@link SpaceKeyRecord} is the only thing persisted, and it is NON-secret:
 * KDF params, a salt, and two wrapped copies of the DEK — none usable without
 * the password or the recovery key.
 */
import type { KdfParams } from './kdf'
import type { KeyHandle } from './keys'
import { getKeyBackend } from './keyBackend'

// Re-exported from the key engine so the public import path `crypto/space` stays
// stable for callers (encfs, SpaceList, …).
export { SPACE_KEY_RECORD_VERSION } from './keyCore'
export type { SpaceKeyRecord } from './keyCore'
import type { SpaceKeyRecord } from './keyCore'

export interface CreatedSpace {
  record: SpaceKeyRecord
  /** Show this to the user ONCE, then forget it — it is not recoverable. */
  recoveryDisplay: string
  /** Unlocked session handle for immediate use. */
  handle: KeyHandle
}

/**
 * Create a new encrypted space: the worker generates a random DEK, wraps it
 * under both a password-derived KEK and a fresh recovery key, and holds the DEK
 * in a slot. Returns the persistable record, the one-time recovery display, and
 * a ready-to-use session handle.
 */
export async function createEncryptedSpace(password: string, kdf?: KdfParams): Promise<CreatedSpace> {
  const { record, recoveryDisplay, slotId } = await getKeyBackend().createSpace(password, kdf)
  return { record, recoveryDisplay, handle: { slotId } }
}

/** Unlock a space with its password. Wrong password throws (GCM tag). */
export async function unlockWithPassword(record: SpaceKeyRecord, password: string): Promise<KeyHandle> {
  const { slotId } = await getKeyBackend().unlockPassword(record, password)
  return { slotId }
}

/** Unlock a space with its printable recovery key. Wrong key throws. */
export async function unlockWithRecovery(record: SpaceKeyRecord, recoveryDisplay: string): Promise<KeyHandle> {
  const { slotId } = await getKeyBackend().unlockRecovery(record, recoveryDisplay)
  return { slotId }
}

/**
 * Change a space's password by re-wrapping the DEK — the DEK is unchanged, so
 * all existing content stays decryptable and the recovery wrap is untouched. A
 * fresh salt is drawn for the new password. Wrong old password throws.
 *
 * Returns a new record; the caller persists it and discards the old one.
 */
export function changePassword(
  record: SpaceKeyRecord,
  oldPassword: string,
  newPassword: string,
): Promise<SpaceKeyRecord> {
  return getKeyBackend().changePassword(record, oldPassword, newPassword)
}
