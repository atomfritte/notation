/**
 * Space-encryption crypto core (Phase 1).
 *
 * Zero-knowledge, client-side primitives shared by the admin and share SPAs:
 * Argon2id key derivation, an AES-256-GCM DEK wrapped independently under a
 * password and a recovery key, and a versioned self-framing AEAD blob format.
 *
 * No key material is ever persisted to storage — session keys live only in
 * memory as non-extractable CryptoKeys (see {@link KeyHandle}).
 */
export * from './constants'
export * from './bytes'
export * from './aesgcm'
export * from './blob'
export * from './keys'
export * from './kdf'
export * from './base32'
export * from './recovery'
export * from './space'
