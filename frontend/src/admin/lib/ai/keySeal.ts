/**
 * Sealing the Claude API key under a chat password.
 *
 * The key never reaches the server in the clear: the browser derives a
 * key-encryption key from the password (Argon2id, the same parameters as a
 * Space password) and encrypts the API key with AES-256-GCM in the shared
 * self-framing blob format. The server stores the result and hands it back to
 * the signed-in admin's browser, which needs the password to open it.
 *
 * The record carries its KDF parameters so they can be raised later, and they
 * are CLAMPED on open: a tampered record must not be able to make the browser
 * allocate gigabytes or spin for minutes.
 */
import { DEFAULT_KDF_PARAMS, deriveKEK, type KdfParams } from '../../../shared/crypto/kdf'
import { importAesGcmKey } from '../../../shared/crypto/aesgcm'
import { openFramed, sealFramed } from '../../../shared/crypto/frame'
import { randomBytes, utf8Decode, utf8Encode } from '../../../shared/crypto/bytes'
import { KDF_SALT_LEN } from '../../../shared/crypto/constants'
import { base64ToBytes, bytesToBase64 } from './chatStore'

export interface SealedKey {
  v: 1
  kdf: { algorithm: 'argon2id'; memory_kib: number; iterations: number; parallelism: number }
  salt: string
  ct: string
  hint: string
}

/** Binds the ciphertext to its purpose, so no other sealed blob can stand in. */
const AAD = utf8Encode('notation:ai-key:v1')

/** The shortest chat password accepted. It guards a credential that costs money. */
export const MIN_PASSWORD_LEN = 8

/** Wrong password (or a damaged record): the tag check failed. */
export class WrongPasswordError extends Error {
  constructor() { super('Wrong password') }
}

/**
 * The same shape check the server applies, plus the admin-key refusal: an
 * organisation admin key (sk-ant-admin…) can do far more than a chat needs and
 * must never sit in a browser.
 */
export function checkApiKey(k: string): string | null {
  if (!k.startsWith('sk-ant-')) return 'That is not an Anthropic API key (it starts with sk-ant-).'
  if (k.startsWith('sk-ant-admin')) return 'That is an admin key. Use a normal API key — an admin key can manage your whole organisation.'
  if (k.length < 20 || k.length > 256 || !/^[A-Za-z0-9_-]+$/.test(k)) return 'That does not look like a complete API key.'
  return null
}

export function keyHint(k: string): string {
  return `sk-ant-…${k.slice(-4)}`
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n)))

/**
 * The KDF cost to run for a record, clamped to the bounds the server accepts
 * (64 MiB × 3 is the default; up to 256 MiB × 10 leaves room to raise it).
 */
export function kdfParamsOf(s: SealedKey): KdfParams {
  return {
    algorithm: 'argon2id',
    memoryKiB: clamp(s.kdf.memory_kib, 19456, 262144),
    iterations: clamp(s.kdf.iterations, 1, 10),
    parallelism: clamp(s.kdf.parallelism, 1, 4),
    keyLen: DEFAULT_KDF_PARAMS.keyLen,
  }
}

async function kek(password: string, salt: Uint8Array, params: KdfParams): Promise<CryptoKey> {
  const raw = await deriveKEK(password, salt, params)
  try {
    return await importAesGcmKey(raw, ['encrypt', 'decrypt'], false)
  } finally {
    raw.fill(0)
  }
}

export async function sealApiKey(apiKey: string, password: string, params: KdfParams = DEFAULT_KDF_PARAMS): Promise<SealedKey> {
  const salt = randomBytes(KDF_SALT_LEN)
  const ct = await sealFramed(await kek(password, salt, params), utf8Encode(apiKey), AAD)
  return {
    v: 1,
    kdf: { algorithm: 'argon2id', memory_kib: params.memoryKiB, iterations: params.iterations, parallelism: params.parallelism },
    salt: bytesToBase64(salt),
    ct: bytesToBase64(ct),
    hint: keyHint(apiKey),
  }
}

export async function openApiKey(sealed: SealedKey, password: string): Promise<string> {
  if (sealed?.v !== 1 || sealed.kdf?.algorithm !== 'argon2id') throw new Error('Unsupported key record')
  const key = await kek(password, base64ToBytes(sealed.salt), kdfParamsOf(sealed))
  let plain: Uint8Array
  try {
    plain = await openFramed(key, base64ToBytes(sealed.ct), AAD)
  } catch {
    throw new WrongPasswordError()
  }
  const apiKey = utf8Decode(plain)
  plain.fill(0)
  // A record that opens but holds something else was not made by us.
  if (checkApiKey(apiKey)) throw new Error('The stored key record is damaged')
  return apiKey
}
