/**
 * Public blob API — self-framing AEAD blobs, keyed by an opaque {@link KeyHandle}.
 *
 *     version(1) || suite(1) || nonce(12) || ciphertext(+16 tag)
 *
 * The framing and the AES-GCM itself live in the key worker (see {@link ./frame}
 * / {@link ./keyCore}); these functions are a thin shim that resolves the handle
 * to its worker slot id and routes the op there. The signatures are unchanged
 * from before the worker refactor — callers are unaffected — and the on-disk
 * bytes are byte-identical, so spaces created before the change still open.
 *
 * `aad` is bound to the ciphertext as AES-GCM associated data but NOT stored, so
 * the caller must supply the same value on decrypt.
 */
import { utf8Decode, utf8Encode } from './bytes'
import type { ContentKey } from './keys'
import { resolveContentKey } from './keys'
import { getKeyBackend } from './keyBackend'

/** Encrypt bytes into a versioned, self-framing AES-256-GCM blob. */
export function encryptBlob(plaintext: Uint8Array, key: ContentKey, aad?: Uint8Array): Promise<Uint8Array> {
  return getKeyBackend().encrypt(resolveContentKey(key), plaintext, aad)
}

/**
 * Decrypt a blob produced by {@link encryptBlob}. Throws on an unknown
 * version/suite, a truncated blob, or a failed authentication tag (wrong key,
 * tampering, or mismatched `aad`).
 */
export function decryptBlob(blob: Uint8Array, key: ContentKey, aad?: Uint8Array): Promise<Uint8Array> {
  return getKeyBackend().decrypt(resolveContentKey(key), blob, aad)
}

/** Encrypt a UTF-8 string into a blob. */
export function encryptText(text: string, key: ContentKey, aad?: Uint8Array): Promise<Uint8Array> {
  return encryptBlob(utf8Encode(text), key, aad)
}

/** Decrypt a blob and UTF-8 decode it to a string. */
export async function decryptText(blob: Uint8Array, key: ContentKey, aad?: Uint8Array): Promise<string> {
  return utf8Decode(await decryptBlob(blob, key, aad))
}
