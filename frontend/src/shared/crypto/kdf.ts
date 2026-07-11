/**
 * Password-based key derivation via Argon2id (memory-hard, resistant to GPU
 * and side-channel attacks). Backed by hash-wasm's pure-WASM implementation,
 * which runs identically in the browser and in the Node/jsdom test runtime.
 *
 * The parameters are stored alongside every wrapped key ({@link KdfParams}) so
 * that the cost can be tuned over time and old material stays derivable.
 */
import { argon2id } from 'hash-wasm'
import { KEK_LEN } from './constants'

export interface KdfParams {
  /** Only 'argon2id' is defined today; kept explicit so the format can grow. */
  algorithm: 'argon2id'
  /** Memory cost in KiB. 65536 KiB = 64 MiB. */
  memoryKiB: number
  /** Time cost — number of passes. */
  iterations: number
  /** Degree of parallelism (lanes). */
  parallelism: number
  /** Derived key length in bytes. */
  keyLen: number
}

/**
 * Interactive-login defaults: ~64 MiB, 3 passes, 1 lane → a 256-bit key.
 * A sensible balance for unlocking a space on a laptop/phone; tune upward as
 * hardware improves (the params travel with the wrapped key).
 */
export const DEFAULT_KDF_PARAMS: KdfParams = {
  algorithm: 'argon2id',
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
  keyLen: KEK_LEN,
}

/**
 * Derive a key-encryption key (KEK) from a password and salt. Deterministic:
 * the same password + salt + params always yield the same bytes. Returns raw
 * key bytes — the caller imports them as a CryptoKey (see {@link ./keys}) and
 * should not retain the bytes longer than the wrap/unwrap needs them.
 */
export async function deriveKEK(
  password: string | Uint8Array,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<Uint8Array> {
  if (params.algorithm !== 'argon2id') {
    throw new Error(`kdf: unsupported algorithm ${params.algorithm}`)
  }
  if (salt.length < 8) {
    throw new Error('kdf: salt must be at least 8 bytes')
  }
  return argon2id({
    password,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: params.keyLen,
    outputType: 'binary',
  })
}
