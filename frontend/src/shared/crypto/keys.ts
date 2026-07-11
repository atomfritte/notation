/**
 * Space key model.
 *
 * A space is protected by a single random 256-bit **DEK** (data-encryption
 * key) that encrypts all content. The DEK is never derived from the password;
 * instead it is *wrapped* (encrypted) independently under one or more
 * **KEKs** (key-encryption keys) — one derived from the user's password via
 * Argon2id, and one derived from a printable recovery key. This buys two
 * properties for free:
 *
 *   - password change = re-wrap the DEK only ({@link rewrapDEK}); content is
 *     never re-encrypted and the DEK is unchanged;
 *   - a lost password is recoverable via the second (recovery) wrap.
 */
import { DEK_LEN } from './constants'
import { randomBytes } from './bytes'
import { importAesGcmKey } from './aesgcm'
import { decryptBlob, encryptBlob } from './blob'

/**
 * Session-only handle to a space's in-memory content key(s).
 *
 * SECURITY POLICY — read before extending:
 *   - The {@link CryptoKey} held here is imported `extractable: false`; its raw
 *     bytes cannot be read back out of the WebCrypto boundary.
 *   - It lives ONLY for the lifetime of the unlocked session (the JS runtime).
 *     Locking a space means dropping every reference to its KeyHandle so it is
 *     garbage-collected.
 *   - This library NEVER writes any key — DEK, KEK, recovery key, or KeyHandle
 *     — to localStorage, sessionStorage, IndexedDB, cookies, or any other
 *     persistence. Raw key *bytes* (KEK/DEK) exist only transiently for the
 *     duration of a wrap/unwrap and are not retained.
 */
export interface KeyHandle {
  readonly contentKey: CryptoKey
}

/** A content key accepted by the blob API: a session {@link KeyHandle} or a bare CryptoKey. */
export type ContentKey = KeyHandle | CryptoKey

/** Opaque wrapped-key bytes — a self-framing blob (see {@link ./blob}). */
export type WrappedKey = Uint8Array

function isKeyHandle(key: ContentKey): key is KeyHandle {
  return typeof key === 'object' && key !== null && 'contentKey' in key
}

/** Normalise a {@link ContentKey} to its underlying CryptoKey. */
export function resolveContentKey(key: ContentKey): CryptoKey {
  return isKeyHandle(key) ? key.contentKey : key
}

/** Generate a fresh random 256-bit DEK. */
export function generateDEK(): Uint8Array {
  return randomBytes(DEK_LEN)
}

/**
 * Import DEK bytes as a non-extractable AES-GCM content key wrapped in a
 * session {@link KeyHandle}. Callers should discard the raw `dek` bytes after
 * this returns.
 */
export async function importContentKey(dek: Uint8Array): Promise<KeyHandle> {
  const contentKey = await importAesGcmKey(dek, ['encrypt', 'decrypt'], false)
  return { contentKey }
}

/** Import a KEK's raw bytes as a wrapping key (used only for wrap/unwrap). */
function importWrappingKey(kek: Uint8Array): Promise<CryptoKey> {
  return importAesGcmKey(kek, ['encrypt', 'decrypt'], false)
}

/** Wrap (encrypt) a DEK under a KEK. */
export async function wrapDEK(dek: Uint8Array, kek: Uint8Array): Promise<WrappedKey> {
  return encryptBlob(dek, await importWrappingKey(kek))
}

/**
 * Unwrap (decrypt) a DEK with a KEK. A wrong KEK — e.g. one derived from the
 * wrong password — fails the GCM authentication tag and throws; the DEK is
 * never returned for a bad key.
 */
export async function unwrapDEK(wrapped: WrappedKey, kek: Uint8Array): Promise<Uint8Array> {
  return decryptBlob(wrapped, await importWrappingKey(kek))
}

/**
 * Re-wrap a DEK from an old KEK to a new one without changing the DEK. This is
 * the whole of a password change: unwrap with the old KEK, wrap with the new.
 * The old wrapped blob can then be discarded; content stays decryptable.
 */
export async function rewrapDEK(
  wrapped: WrappedKey,
  oldKek: Uint8Array,
  newKek: Uint8Array,
): Promise<WrappedKey> {
  const dek = await unwrapDEK(wrapped, oldKek)
  return wrapDEK(dek, newKek)
}
