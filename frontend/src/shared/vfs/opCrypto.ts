/**
 * Encrypted op-log envelope.
 *
 * For the zero-knowledge model, the op *body* (which node, its name, parent,
 * blob) is encrypted, while the ordering metadata the server needs to sequence
 * the log — opId, lamport, actorId — travels in the clear. That cleartext is
 * bound into the ciphertext as AES-GCM associated data, so it cannot be
 * swapped or replayed against a different body without failing the auth tag.
 */
import type { KeyHandle } from '../crypto/keys'
import { decryptBlob, encryptBlob } from '../crypto/blob'
import { utf8Decode, utf8Encode } from '../crypto/bytes'
import type { Op } from './ops'

/**
 * The minimal shape every log record carries: the cleartext ordering metadata
 * the server sequences the log by. Both structural {@link Op}s and comment ops
 * ({@link ../vfs/commentLog}) satisfy it, so a single envelope seals either.
 */
export interface LogRecord {
  opId: string
  lamport: number
  actorId: string
}

export interface EncryptedOpEnvelope {
  /** Cleartext ordering metadata (mirrors the sealed record, bound as AAD). */
  opId: string
  lamport: number
  actorId: string
  /** Self-framing AES-256-GCM blob of the serialized record. */
  ciphertext: Uint8Array
}

/** Serialize a log record to bytes (canonical JSON → UTF-8). */
export function encodeOp<T extends LogRecord>(op: T): Uint8Array {
  return utf8Encode(JSON.stringify(op))
}

/** Deserialize record bytes produced by {@link encodeOp} (defaults to {@link Op}). */
export function decodeOp<T extends LogRecord = Op>(bytes: Uint8Array): T {
  return JSON.parse(utf8Decode(bytes)) as T
}

function envelopeAad(opId: string, lamport: number, actorId: string): Uint8Array {
  return utf8Encode(`${opId}|${lamport}|${actorId}`)
}

/** Encrypt a log record into an {@link EncryptedOpEnvelope}. */
export async function sealOp<T extends LogRecord>(op: T, key: KeyHandle): Promise<EncryptedOpEnvelope> {
  const aad = envelopeAad(op.opId, op.lamport, op.actorId)
  const ciphertext = await encryptBlob(encodeOp(op), key, aad)
  return { opId: op.opId, lamport: op.lamport, actorId: op.actorId, ciphertext }
}

/**
 * Decrypt an op envelope (defaults to {@link Op}). Throws if the ciphertext is
 * tampered, the AAD (cleartext metadata) does not match, or the decrypted
 * record's own metadata disagrees with the envelope header.
 */
export async function openOp<T extends LogRecord = Op>(envelope: EncryptedOpEnvelope, key: KeyHandle): Promise<T> {
  const aad = envelopeAad(envelope.opId, envelope.lamport, envelope.actorId)
  const op = decodeOp<T>(await decryptBlob(envelope.ciphertext, key, aad))
  if (op.opId !== envelope.opId || op.lamport !== envelope.lamport || op.actorId !== envelope.actorId) {
    throw new Error('vfs: op envelope metadata does not match sealed op')
  }
  return op
}
