/**
 * Self-framing AEAD blob format:
 *
 *     version(1) || suite(1) || nonce(12) || ciphertext(+16 tag)
 *
 * The 2-byte header is authenticated as AES-GCM associated data (together with
 * any caller-supplied `aad`), so a suite downgrade or header tamper fails the
 * tag check rather than silently mis-parsing. A fresh random nonce is drawn
 * per call, so encrypting identical plaintext twice yields different blobs.
 */
import {
  CipherSuite,
  FORMAT_VERSION,
  GCM_NONCE_LEN,
  HEADER_LEN,
} from './constants'
import { concatBytes, utf8Decode, utf8Encode } from './bytes'
import { gcmDecrypt, gcmEncrypt, newNonce } from './aesgcm'
import type { ContentKey } from './keys'
import { resolveContentKey } from './keys'

function headerBytes(): Uint8Array {
  return new Uint8Array([FORMAT_VERSION, CipherSuite.AES_256_GCM])
}

/**
 * Encrypt bytes into a versioned, self-framing AES-256-GCM blob.
 *
 * @param key   the space content key (a {@link KeyHandle} or bare CryptoKey).
 * @param aad   optional extra associated data bound to the ciphertext; it is
 *              NOT stored in the blob, so the caller must supply the same value
 *              on decrypt.
 */
export async function encryptBlob(
  plaintext: Uint8Array,
  key: ContentKey,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const contentKey = resolveContentKey(key)
  const header = headerBytes()
  const nonce = newNonce()
  const fullAad = aad ? concatBytes(header, aad) : header
  const ct = await gcmEncrypt(contentKey, nonce, plaintext, fullAad)
  return concatBytes(header, nonce, ct)
}

/**
 * Decrypt a blob produced by {@link encryptBlob}. Throws on an unknown
 * version/suite, a truncated blob, or a failed authentication tag (wrong key,
 * tampering, or mismatched `aad`).
 */
export async function decryptBlob(
  blob: Uint8Array,
  key: ContentKey,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  if (blob.length < HEADER_LEN + GCM_NONCE_LEN) {
    throw new Error('crypto: blob too short')
  }
  const version = blob[0]
  const suite = blob[1]
  if (version !== FORMAT_VERSION) {
    throw new Error(`crypto: unsupported format version ${version}`)
  }
  if (suite !== CipherSuite.AES_256_GCM) {
    throw new Error(`crypto: unsupported cipher suite ${suite}`)
  }
  const header = blob.subarray(0, HEADER_LEN)
  const nonce = blob.subarray(HEADER_LEN, HEADER_LEN + GCM_NONCE_LEN)
  const ct = blob.subarray(HEADER_LEN + GCM_NONCE_LEN)
  const fullAad = aad ? concatBytes(header, aad) : header
  return gcmDecrypt(resolveContentKey(key), nonce, ct, fullAad)
}

/** Encrypt a UTF-8 string into a blob. */
export function encryptText(text: string, key: ContentKey, aad?: Uint8Array): Promise<Uint8Array> {
  return encryptBlob(utf8Encode(text), key, aad)
}

/** Decrypt a blob and UTF-8 decode it to a string. */
export async function decryptText(blob: Uint8Array, key: ContentKey, aad?: Uint8Array): Promise<string> {
  return utf8Decode(await decryptBlob(blob, key, aad))
}
