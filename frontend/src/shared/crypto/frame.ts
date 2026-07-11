/**
 * Self-framing AEAD blob format + DEK-wrap primitives — the SINGLE source of
 * truth for the on-disk / on-wire byte layout.
 *
 *     version(1) || suite(1) || nonce(12) || ciphertext(+16 tag)
 *
 * The 2-byte header is authenticated as AES-GCM associated data (together with
 * any caller-supplied `aad`), so a suite downgrade or header tamper fails the
 * tag check rather than silently mis-parsing. A fresh random nonce is drawn per
 * call, so encrypting identical plaintext twice yields different blobs.
 *
 * These helpers operate on a bare {@link CryptoKey} and therefore run ONLY where
 * secret key material is allowed to live: inside the key worker / in-process key
 * backend (see {@link ./keyCore}). The main-thread {@link ./blob} API never
 * touches a CryptoKey — it routes to the backend by slot id. Keeping the framing
 * here (and reusing it verbatim for DEK wrapping) is what guarantees the format
 * stays byte-identical across the worker refactor: old spaces keep opening.
 */
import {
  CipherSuite,
  DEK_LEN,
  FORMAT_VERSION,
  GCM_NONCE_LEN,
  HEADER_LEN,
} from './constants'
import { concatBytes, randomBytes } from './bytes'
import { gcmDecrypt, gcmEncrypt, importAesGcmKey, newNonce } from './aesgcm'

/** Opaque wrapped-key bytes — a self-framing blob in this same format. */
export type WrappedKey = Uint8Array

/** Generate a fresh random 256-bit DEK. */
export function generateDEK(): Uint8Array {
  return randomBytes(DEK_LEN)
}

function headerBytes(): Uint8Array {
  return new Uint8Array([FORMAT_VERSION, CipherSuite.AES_256_GCM])
}

/**
 * Encrypt bytes into a versioned, self-framing AES-256-GCM blob under a bare
 * {@link CryptoKey}. `aad` is bound to the ciphertext (NOT stored), so the same
 * value must be supplied on decrypt.
 */
export async function sealFramed(
  contentKey: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const header = headerBytes()
  const nonce = newNonce()
  const fullAad = aad ? concatBytes(header, aad) : header
  const ct = await gcmEncrypt(contentKey, nonce, plaintext, fullAad)
  return concatBytes(header, nonce, ct)
}

/**
 * Decrypt a blob produced by {@link sealFramed}. Throws on an unknown
 * version/suite, a truncated blob, or a failed authentication tag (wrong key,
 * tampering, or mismatched `aad`).
 */
export async function openFramed(
  contentKey: CryptoKey,
  blob: Uint8Array,
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
  return gcmDecrypt(contentKey, nonce, ct, fullAad)
}

// ── DEK wrap/unwrap primitives ───────────────────────────────────────────────
//
// A space's DEK is *wrapped* (encrypted) under a KEK using the exact same blob
// framing above, so `wrappedByPassword` / `wrappedByRecovery` in a SpaceKeyRecord
// share the on-disk format with content blobs. These are pure functions over raw
// bytes and are used ONLY inside the key backend (see {@link ./keyCore}).

/** Import a KEK's raw bytes as a (non-extractable) wrapping key. */
function importWrappingKey(kek: Uint8Array): Promise<CryptoKey> {
  return importAesGcmKey(kek, ['encrypt', 'decrypt'], false)
}

/** Wrap (encrypt) a DEK under a KEK. */
export async function wrapDEK(dek: Uint8Array, kek: Uint8Array): Promise<WrappedKey> {
  return sealFramed(await importWrappingKey(kek), dek)
}

/**
 * Unwrap (decrypt) a DEK with a KEK. A wrong KEK — e.g. one derived from the
 * wrong password — fails the GCM authentication tag and throws; the DEK is
 * never returned for a bad key.
 */
export async function unwrapDEK(wrapped: WrappedKey, kek: Uint8Array): Promise<Uint8Array> {
  return openFramed(await importWrappingKey(kek), wrapped)
}

/**
 * Re-wrap a DEK from an old KEK to a new one without changing the DEK. This is
 * the whole of a password change: unwrap with the old KEK, wrap with the new.
 */
export async function rewrapDEK(
  wrapped: WrappedKey,
  oldKek: Uint8Array,
  newKek: Uint8Array,
): Promise<WrappedKey> {
  const dek = await unwrapDEK(wrapped, oldKek)
  return wrapDEK(dek, newKek)
}
