/**
 * Recovery key: a second, password-independent way to unwrap a space's DEK.
 *
 * It is a random 256-bit key rendered as a grouped Crockford-base32 string for
 * the user to print or store safely. Because the key is already uniformly
 * random with full 256-bit entropy, it is used *directly* as the AES-GCM
 * wrapping key — no Argon2 stretching is needed (or wanted; it must unlock even
 * if the user forgets everything but the printed key).
 */
import { RECOVERY_KEY_LEN } from './constants'
import { randomBytes } from './bytes'
import { base32Decode, base32Encode } from './base32'
import type { WrappedKey } from './frame'
import { unwrapDEK, wrapDEK } from './frame'

/** Characters per dash-separated group in the printable form. */
const GROUP_SIZE = 4

export interface RecoveryKey {
  /** Raw 256-bit key bytes. */
  bytes: Uint8Array
  /** Human-friendly grouped base32 rendering (e.g. `A1B2-C3D4-…`). */
  display: string
}

/** Render recovery-key bytes as a grouped, printable base32 string. */
export function formatRecoveryDisplay(bytes: Uint8Array): string {
  const groups = base32Encode(bytes).match(new RegExp(`.{1,${GROUP_SIZE}}`, 'g'))
  return groups ? groups.join('-') : ''
}

/** Generate a fresh random recovery key and its printable form. */
export function generateRecoveryKey(): RecoveryKey {
  const bytes = randomBytes(RECOVERY_KEY_LEN)
  return { bytes, display: formatRecoveryDisplay(bytes) }
}

/**
 * Parse a printable recovery key back to its raw bytes. Tolerant of case,
 * spacing and the omitted-letter folding (see {@link ./base32}). Throws if the
 * decoded material is too short to be a recovery key.
 */
export function parseRecoveryKey(display: string): Uint8Array {
  const bytes = base32Decode(display)
  if (bytes.length < RECOVERY_KEY_LEN) {
    throw new Error('recovery: key is too short')
  }
  return bytes.subarray(0, RECOVERY_KEY_LEN)
}

/** Wrap a DEK under a recovery key (a second, independent wrap of the DEK). */
export function wrapDEKWithRecovery(dek: Uint8Array, recovery: Uint8Array): Promise<WrappedKey> {
  return wrapDEK(dek, recovery)
}

/** Unwrap a DEK with a recovery key. Wrong key fails the GCM tag and throws. */
export function unwrapDEKWithRecovery(wrapped: WrappedKey, recovery: Uint8Array): Promise<Uint8Array> {
  return unwrapDEK(wrapped, recovery)
}
