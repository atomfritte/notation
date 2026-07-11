/**
 * Opaque, filesystem-safe identifiers for nodes, blobs and ops.
 *
 * Ids are lowercase hex only, so they are safe to splice directly into a path
 * segment (`blobs/<id>`, `ops/<id>`) with no `/`, `.`, `..`, whitespace, or
 * case-folding hazard on any filesystem or object store.
 */

const NODE_ID_BYTES = 16 // 128-bit
const BLOB_ID_BYTES = 16
const OP_ID_BYTES = 16

/** A valid opaque id: 8–64 lowercase hex characters. */
export const SAFE_ID_RE = /^[0-9a-f]{8,64}$/

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** Generate a fresh random node id. */
export const newNodeId = (): string => randomHex(NODE_ID_BYTES)
/** Generate a fresh random content-blob id. */
export const newBlobId = (): string => randomHex(BLOB_ID_BYTES)
/** Generate a fresh random op id. */
export const newOpId = (): string => randomHex(OP_ID_BYTES)

/** True if `id` is a well-formed, filesystem-safe opaque id. */
export const isSafeId = (id: string): boolean => SAFE_ID_RE.test(id)

/** Throw unless `id` is filesystem-safe. */
export function assertSafeId(id: string): void {
  if (!isSafeId(id)) throw new Error(`vfs: unsafe id ${JSON.stringify(id)}`)
}

/** Storage path for a content blob. Validates the id first. */
export function blobPath(id: string): string {
  assertSafeId(id)
  return `blobs/${id}`
}

/** Storage path for an op-log entry. Validates the id first. */
export function opPath(id: string): string {
  assertSafeId(id)
  return `ops/${id}`
}
