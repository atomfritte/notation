/**
 * On-disk / on-wire format constants for the space-encryption suite.
 *
 * Every persisted ciphertext produced by this library is *self-framing*: it
 * begins with a 2-byte header — a {@link FORMAT_VERSION} byte followed by a
 * {@link CipherSuite} id — so a reader always knows how to interpret the
 * remaining bytes and the format can evolve without ambiguity. The header
 * bytes are additionally fed to AES-GCM as associated data (AAD), so any
 * downgrade or tamper of the header is caught by the authentication tag.
 *
 * The identifiers here are an append-only registry: existing numbers must
 * never be renumbered or reused, only new ones added, so that old ciphertext
 * stays decryptable forever.
 */

/** Envelope format version. Bump only on a breaking framing change. */
export const FORMAT_VERSION = 1 as const

/** Cipher/KDF suite identifiers. Append-only — never renumber or reuse. */
export const CipherSuite = {
  /** AES-256-GCM content/key encryption; Argon2id key derivation. */
  AES_256_GCM: 1,
} as const
export type CipherSuiteId = (typeof CipherSuite)[keyof typeof CipherSuite]

/** version(1) || suite(1) */
export const HEADER_LEN = 2
/** 96-bit nonce — the size AES-GCM is defined and optimised for. */
export const GCM_NONCE_LEN = 12
/** 128-bit GCM authentication tag (WebCrypto's default tagLength). */
export const GCM_TAG_LEN = 16
/** 256-bit data-encryption key. */
export const DEK_LEN = 32
/** 256-bit key-encryption key (Argon2id output). */
export const KEK_LEN = 32
/** 256-bit recovery key. */
export const RECOVERY_KEY_LEN = 32
/** KDF salt length. */
export const KDF_SALT_LEN = 16
