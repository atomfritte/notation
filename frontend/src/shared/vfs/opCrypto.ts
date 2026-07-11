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

export interface EncryptedOpEnvelope {
  /** Cleartext ordering metadata (mirrors the sealed op, bound as AAD). */
  opId: string
  lamport: number
  actorId: string
  /** Self-framing AES-256-GCM blob of the serialized {@link Op}. */
  ciphertext: Uint8Array
}

/** Serialize an op to bytes (canonical JSON → UTF-8). */
export function encodeOp(op: Op): Uint8Array {
  return utf8Encode(JSON.stringify(op))
}

/** Deserialize op bytes produced by {@link encodeOp}. */
export function decodeOp(bytes: Uint8Array): Op {
  return JSON.parse(utf8Decode(bytes)) as Op
}

function envelopeAad(opId: string, lamport: number, actorId: string): Uint8Array {
  return utf8Encode(`${opId}|${lamport}|${actorId}`)
}

/** Encrypt an op into an {@link EncryptedOpEnvelope}. */
export async function sealOp(op: Op, key: KeyHandle): Promise<EncryptedOpEnvelope> {
  const aad = envelopeAad(op.opId, op.lamport, op.actorId)
  const ciphertext = await encryptBlob(encodeOp(op), key, aad)
  return { opId: op.opId, lamport: op.lamport, actorId: op.actorId, ciphertext }
}

/**
 * Decrypt an op envelope. Throws if the ciphertext is tampered, the AAD
 * (cleartext metadata) does not match, or the decrypted op's own metadata
 * disagrees with the envelope header.
 */
export async function openOp(envelope: EncryptedOpEnvelope, key: KeyHandle): Promise<Op> {
  const aad = envelopeAad(envelope.opId, envelope.lamport, envelope.actorId)
  const op = decodeOp(await decryptBlob(envelope.ciphertext, key, aad))
  if (op.opId !== envelope.opId || op.lamport !== envelope.lamport || op.actorId !== envelope.actorId) {
    throw new Error('vfs: op envelope metadata does not match sealed op')
  }
  return op
}
