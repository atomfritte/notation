/**
 * Thin, typed wrappers over WebCrypto AES-256-GCM. These deal in raw nonce +
 * ciphertext; the self-framing envelope (version/suite header) lives in
 * {@link ./blob}. AEAD associated data is threaded through so callers can bind
 * a plaintext to a context (envelope header, op metadata, …).
 */
import { GCM_NONCE_LEN } from './constants'
import { randomBytes } from './bytes'

/**
 * Bridge the type gap at the WebCrypto edge. TypeScript 5.7+ types
 * `Uint8Array` as `Uint8Array<ArrayBufferLike>`, but DOM's `BufferSource`
 * requires an `ArrayBuffer`-backed view. Every buffer we pass here is
 * ArrayBuffer-backed at runtime (never a SharedArrayBuffer), so this cast is
 * sound; it exists purely to reconcile the type parameter.
 */
const buf = (bytes: Uint8Array): BufferSource => bytes as unknown as BufferSource

/**
 * Import raw key bytes as an AES-GCM {@link CryptoKey}.
 *
 * `extractable` defaults to false: content and wrapping keys must never leave
 * the WebCrypto boundary once imported.
 */
export function importAesGcmKey(
  raw: Uint8Array,
  usages: KeyUsage[] = ['encrypt', 'decrypt'],
  extractable = false,
): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, extractable, usages)
}

/** Fresh random 96-bit AES-GCM nonce. */
export function newNonce(): Uint8Array {
  return randomBytes(GCM_NONCE_LEN)
}

/** Encrypt with AES-256-GCM; returns ciphertext||tag. */
export async function gcmEncrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const params: AesGcmParams = { name: 'AES-GCM', iv: buf(nonce) }
  if (aad) params.additionalData = buf(aad)
  const ct = await crypto.subtle.encrypt(params, key, buf(plaintext))
  return new Uint8Array(ct)
}

/**
 * Decrypt AES-256-GCM ciphertext||tag. Throws if the tag fails to verify —
 * i.e. wrong key, wrong nonce, wrong AAD, or tampered ciphertext.
 */
export async function gcmDecrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const params: AesGcmParams = { name: 'AES-GCM', iv: buf(nonce) }
  if (aad) params.additionalData = buf(aad)
  const pt = await crypto.subtle.decrypt(params, key, buf(ciphertext))
  return new Uint8Array(pt)
}
