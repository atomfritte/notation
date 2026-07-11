/**
 * Space unlock orchestration — ties the KDF, DEK wrapping and recovery key
 * together into the handful of flows a caller actually performs: create,
 * unlock (password or recovery), and change password.
 *
 * The {@link SpaceKeyRecord} is the only thing that gets persisted, and it is
 * NON-secret: it holds the KDF params, the salt, and two wrapped copies of the
 * DEK. None of it is usable without the password or the recovery key. No
 * unwrapped key ever leaves this module except as a session {@link KeyHandle}
 * (see the security note on that type).
 */
import { KDF_SALT_LEN } from './constants'
import { randomBytes } from './bytes'
import { DEFAULT_KDF_PARAMS, deriveKEK } from './kdf'
import type { KdfParams } from './kdf'
import type { KeyHandle, WrappedKey } from './keys'
import { generateDEK, importContentKey, rewrapDEK, unwrapDEK, wrapDEK } from './keys'
import { generateRecoveryKey, parseRecoveryKey, unwrapDEKWithRecovery, wrapDEKWithRecovery } from './recovery'

export const SPACE_KEY_RECORD_VERSION = 1

/**
 * Persistable, non-secret description of how a space's DEK is wrapped. Safe to
 * store server-side or in the op-log manifest.
 */
export interface SpaceKeyRecord {
  version: number
  kdf: KdfParams
  /** Salt for the password KEK derivation. */
  kdfSalt: Uint8Array
  /** DEK wrapped under the password-derived KEK. */
  wrappedByPassword: WrappedKey
  /** DEK wrapped under the recovery key. */
  wrappedByRecovery: WrappedKey
}

export interface CreatedSpace {
  record: SpaceKeyRecord
  /** Show this to the user ONCE, then forget it — it is not recoverable. */
  recoveryDisplay: string
  /** Unlocked session handle for immediate use. */
  handle: KeyHandle
}

/**
 * Create a new encrypted space: generate a random DEK, wrap it under both a
 * password-derived KEK and a fresh recovery key, and return the persistable
 * record plus a ready-to-use session handle.
 */
export async function createEncryptedSpace(
  password: string,
  kdf: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<CreatedSpace> {
  const dek = generateDEK()
  const kdfSalt = randomBytes(KDF_SALT_LEN)
  const kek = await deriveKEK(password, kdfSalt, kdf)
  const recovery = generateRecoveryKey()

  const record: SpaceKeyRecord = {
    version: SPACE_KEY_RECORD_VERSION,
    kdf,
    kdfSalt,
    wrappedByPassword: await wrapDEK(dek, kek),
    wrappedByRecovery: await wrapDEKWithRecovery(dek, recovery.bytes),
  }
  const handle = await importContentKey(dek)
  return { record, recoveryDisplay: recovery.display, handle }
}

/** Unlock a space with its password. Wrong password throws (GCM tag). */
export async function unlockWithPassword(record: SpaceKeyRecord, password: string): Promise<KeyHandle> {
  const kek = await deriveKEK(password, record.kdfSalt, record.kdf)
  const dek = await unwrapDEK(record.wrappedByPassword, kek)
  return importContentKey(dek)
}

/** Unlock a space with its printable recovery key. Wrong key throws. */
export async function unlockWithRecovery(record: SpaceKeyRecord, recoveryDisplay: string): Promise<KeyHandle> {
  const recovery = parseRecoveryKey(recoveryDisplay)
  const dek = await unwrapDEKWithRecovery(record.wrappedByRecovery, recovery)
  return importContentKey(dek)
}

/**
 * Change a space's password by re-wrapping the DEK — the DEK is unchanged, so
 * all existing content stays decryptable and the recovery wrap is untouched. A
 * fresh salt is drawn for the new password. Wrong old password throws.
 *
 * Returns a new record; the caller persists it and discards the old one.
 */
export async function changePassword(
  record: SpaceKeyRecord,
  oldPassword: string,
  newPassword: string,
): Promise<SpaceKeyRecord> {
  const oldKek = await deriveKEK(oldPassword, record.kdfSalt, record.kdf)
  const newSalt = randomBytes(KDF_SALT_LEN)
  const newKek = await deriveKEK(newPassword, newSalt, record.kdf)
  const wrappedByPassword = await rewrapDEK(record.wrappedByPassword, oldKek, newKek)
  return { ...record, kdfSalt: newSalt, wrappedByPassword }
}
