/**
 * keyCore — the zero-knowledge key engine.
 *
 * This is the ONLY module that ever holds a space's secret key material: the
 * DEK, the derived KEK bytes (transiently, during a wrap/unwrap), and the
 * imported non-extractable {@link CryptoKey}s. It runs INSIDE the key worker in
 * the browser (see {@link ./keyWorker}) and IN-PROCESS under the test runner
 * (see {@link ./keyBackend} `InProcessKeyBackend`) — the SAME code both ways;
 * only the transport that reaches it differs.
 *
 * Everything crosses the module boundary as opaque `slotId` strings plus the
 * results of crypto ops (ciphertext / plaintext bytes, the wrapped-key record
 * fields). A raw DEK, a raw KEK, or a live CryptoKey NEVER leaves this module.
 * The main-thread JS heap therefore holds no usable key material — only slot
 * handles.
 *
 * SECURITY / SCOPE NOTE: the DEK is imported non-extractable, and it lives only
 * for the unlocked session (until {@link coreDrop}). This does NOT stop an
 * active same-origin XSS from *asking* this engine to encrypt/decrypt while a
 * space is unlocked — the benefit is narrower and honest: the raw key bytes and
 * the CryptoKey objects are never reachable from the main-thread heap.
 */
import { KDF_SALT_LEN } from './constants'
import { randomBytes } from './bytes'
import { importAesGcmKey } from './aesgcm'
import { DEFAULT_KDF_PARAMS, deriveKEK } from './kdf'
import type { KdfParams } from './kdf'
import {
  generateDEK,
  openFramed,
  rewrapDEK,
  sealFramed,
  unwrapDEK,
  wrapDEK,
  type WrappedKey,
} from './frame'
import { generateRecoveryKey, parseRecoveryKey } from './recovery'

export const SPACE_KEY_RECORD_VERSION = 1

/**
 * Persistable, non-secret description of how a space's DEK is wrapped. Safe to
 * store server-side or in the op-log manifest — none of it is usable without the
 * password or the recovery key.
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

// ── the slot table ───────────────────────────────────────────────────────────
//
// slotId -> the space's DEK as a non-extractable AES-GCM CryptoKey. The map is
// module-private; nothing outside this file can read a CryptoKey out of it.

const slots = new Map<string, CryptoKey>()

/** Mint an unguessable slot id (non-secret; just a table key). */
function newSlotId(): string {
  const b = randomBytes(16)
  let hex = ''
  for (const x of b) hex += x.toString(16).padStart(2, '0')
  return `slot_${hex}`
}

/** Import raw DEK bytes as a non-extractable CryptoKey held under a fresh slot. */
async function holdDEK(dek: Uint8Array): Promise<string> {
  const key = await importAesGcmKey(dek, ['encrypt', 'decrypt'], false)
  const slotId = newSlotId()
  slots.set(slotId, key)
  return slotId
}

function requireSlot(slotId: string): CryptoKey {
  const key = slots.get(slotId)
  if (!key) throw new Error(`crypto: unknown key slot ${slotId}`)
  return key
}

// ── request / result protocol ────────────────────────────────────────────────
//
// A single discriminated dispatch, shared verbatim by both transports. Uint8Array
// fields structured-clone across the worker boundary; nothing here references a
// DOM or Worker global, so it also runs directly under Node/jsdom in tests.

export type KeyRequest =
  | { op: 'createSpace'; password: string; kdf?: KdfParams }
  | { op: 'unlockPassword'; record: SpaceKeyRecord; password: string }
  | { op: 'unlockRecovery'; record: SpaceKeyRecord; display: string }
  | { op: 'changePassword'; record: SpaceKeyRecord; oldPassword: string; newPassword: string }
  | { op: 'importDEK'; dek: Uint8Array }
  | { op: 'encrypt'; slotId: string; plaintext: Uint8Array; aad?: Uint8Array }
  | { op: 'decrypt'; slotId: string; blob: Uint8Array; aad?: Uint8Array }
  | { op: 'drop'; slotId: string }

export type KeyResult =
  | { op: 'createSpace'; record: SpaceKeyRecord; recoveryDisplay: string; slotId: string }
  | { op: 'slot'; slotId: string }
  | { op: 'record'; record: SpaceKeyRecord }
  | { op: 'bytes'; bytes: Uint8Array }
  | { op: 'ok' }

/**
 * Create a new encrypted space: random DEK, wrapped under BOTH a
 * password-derived KEK and a fresh recovery key. Returns the persistable
 * (non-secret) record, the one-time recovery display, and a slot holding the
 * unlocked DEK. The raw DEK/KEK never leave this function.
 */
async function coreCreateSpace(password: string, kdf: KdfParams = DEFAULT_KDF_PARAMS): Promise<KeyResult> {
  const dek = generateDEK()
  const kdfSalt = randomBytes(KDF_SALT_LEN)
  const kek = await deriveKEK(password, kdfSalt, kdf)
  const recovery = generateRecoveryKey()

  const record: SpaceKeyRecord = {
    version: SPACE_KEY_RECORD_VERSION,
    kdf,
    kdfSalt,
    wrappedByPassword: await wrapDEK(dek, kek),
    wrappedByRecovery: await wrapDEK(dek, recovery.bytes),
  }
  const slotId = await holdDEK(dek)
  return { op: 'createSpace', record, recoveryDisplay: recovery.display, slotId }
}

/** Unlock with the password. Wrong password fails the GCM tag and throws. */
async function coreUnlockPassword(record: SpaceKeyRecord, password: string): Promise<KeyResult> {
  const kek = await deriveKEK(password, record.kdfSalt, record.kdf)
  const dek = await unwrapDEK(record.wrappedByPassword, kek)
  return { op: 'slot', slotId: await holdDEK(dek) }
}

/** Unlock with the printable recovery key. Wrong key throws. */
async function coreUnlockRecovery(record: SpaceKeyRecord, display: string): Promise<KeyResult> {
  const recovery = parseRecoveryKey(display)
  const dek = await unwrapDEK(record.wrappedByRecovery, recovery)
  return { op: 'slot', slotId: await holdDEK(dek) }
}

/**
 * Change the password by re-wrapping the DEK under a KEK from a fresh salt — the
 * DEK is unchanged, so content stays decryptable and the recovery wrap is
 * untouched. Wrong old password throws. Returns the updated record only (no new
 * slot; the caller keeps using its existing unlocked handle).
 */
async function coreChangePassword(
  record: SpaceKeyRecord,
  oldPassword: string,
  newPassword: string,
): Promise<KeyResult> {
  const oldKek = await deriveKEK(oldPassword, record.kdfSalt, record.kdf)
  const newSalt = randomBytes(KDF_SALT_LEN)
  const newKek = await deriveKEK(newPassword, newSalt, record.kdf)
  const wrappedByPassword = await rewrapDEK(record.wrappedByPassword, oldKek, newKek)
  return { op: 'record', record: { ...record, kdfSalt: newSalt, wrappedByPassword } }
}

/**
 * Handle one key request. The single entry point shared by the worker
 * (`onmessage`) and the in-process backend — so the crypto is literally the same
 * code path regardless of transport.
 */
export async function handleKeyRequest(req: KeyRequest): Promise<KeyResult> {
  switch (req.op) {
    case 'createSpace':
      return coreCreateSpace(req.password, req.kdf)
    case 'unlockPassword':
      return coreUnlockPassword(req.record, req.password)
    case 'unlockRecovery':
      return coreUnlockRecovery(req.record, req.display)
    case 'changePassword':
      return coreChangePassword(req.record, req.oldPassword, req.newPassword)
    case 'importDEK':
      // Bootstrap / test seam: adopt an externally-provided DEK into a slot. The
      // production create/unlock paths above never send raw DEK bytes across the
      // boundary — they generate/unwrap the DEK entirely inside this engine.
      return { op: 'slot', slotId: await holdDEK(req.dek) }
    case 'encrypt':
      return { op: 'bytes', bytes: await sealFramed(requireSlot(req.slotId), req.plaintext, req.aad) }
    case 'decrypt':
      return { op: 'bytes', bytes: await openFramed(requireSlot(req.slotId), req.blob, req.aad) }
    case 'drop':
      slots.delete(req.slotId)
      return { op: 'ok' }
  }
}
