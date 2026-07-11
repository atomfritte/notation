/**
 * convert — the client half of Phase 3d: turning an existing plaintext space
 * into a zero-knowledge one and back. The heavy lifting (KDF, DEK wrap, sealing
 * ops, encrypting blobs) all runs HERE, in the browser; the server only ever
 * receives opaque ciphertext.
 *
 * These functions are transport-agnostic: they take a {@link PlaintextSource} /
 * {@link PlaintextSink} for the plaintext side and an {@link EncStore} for the
 * ciphertext side, so the exact same orchestration runs against the real HTTP
 * endpoints in the app AND against in-memory fakes in the tests (proving a
 * lossless round-trip without a network).
 *
 * SAFETY: neither function destroys anything. Encrypt only READS the source and
 * WRITES ciphertext; decrypt only READS ciphertext and WRITES plaintext. The
 * caller destroys the other mode via `finalize-convert` — and only after these
 * resolve.
 */
import { createEncryptedSpace } from '../../shared/crypto/space'
import { EncryptedFS } from '../../shared/vfs/encfs'
import type { EncStore } from '../../shared/vfs/encStore'
import type { KeyHandle } from '../../shared/crypto/keys'

/** A read-only view of a plaintext space's files, for encryption. */
export interface PlaintextSource {
  /** Every file path (logical, `/`-separated, no leading slash), files only. */
  listFiles(): Promise<string[]>
  /** Raw bytes of one file — used for text AND binary, so it is byte-lossless. */
  readBytes(path: string): Promise<Uint8Array>
}

/** A write sink for decrypted plaintext files, for decryption. */
export interface PlaintextSink {
  /** Persist raw bytes at a logical path (parents created as needed). */
  writeBytes(path: string, data: Uint8Array): Promise<void>
}

export interface ConvertOpts {
  /** Stable CRDT actor id for the ops this run issues (a non-secret hex id). */
  actorId: string
  /** Optional progress callback: (filesDone, filesTotal). */
  onProgress?: (done: number, total: number) => void
}

export interface EncryptResult {
  /** Unlocked session handle for the freshly-encrypted space. */
  handle: KeyHandle
  /** Show this to the user ONCE (recovery key), then forget it. */
  recoveryDisplay: string
  /** Number of files encrypted. */
  fileCount: number
}

/**
 * Encrypt an existing plaintext space's content into a blind {@link EncStore}.
 *
 * Derives a fresh DEK + recovery key ({@link createEncryptedSpace}), persists the
 * (non-secret) key record so the store is a valid encrypted space the moment any
 * ciphertext lands, then walks the source and re-creates every file through
 * {@link EncryptedFS.write} — which reproduces the folder structure via Create
 * ops for the parent dirs and encrypts each file's RAW bytes into a content blob.
 *
 * Does NOT touch the source. On any throw, nothing here has destroyed plaintext;
 * the caller aborts the conversion (leaving the source intact).
 */
export async function encryptSpaceContent(
  source: PlaintextSource,
  store: EncStore,
  password: string,
  opts: ConvertOpts,
): Promise<EncryptResult> {
  const { record, recoveryDisplay, handle } = await createEncryptedSpace(password)
  await store.putKeyRecord(record)
  const fs = await EncryptedFS.open(store, handle, opts.actorId)

  const paths = await source.listFiles()
  let done = 0
  for (const path of paths) {
    const bytes = await source.readBytes(path)
    await fs.write(path, bytes)
    opts.onProgress?.(++done, paths.length)
  }
  return { handle, recoveryDisplay, fileCount: paths.length }
}

/**
 * Decrypt every file of an encrypted space (read through an {@link EncryptedFS}
 * over `store`) and write it as plaintext through `sink`. Returns the restored
 * paths. Does NOT touch the ciphertext; the caller purges it via finalize only
 * after this resolves.
 */
export async function decryptSpaceContent(
  store: EncStore,
  handle: KeyHandle,
  sink: PlaintextSink,
  opts: ConvertOpts,
): Promise<string[]> {
  const fs = await EncryptedFS.open(store, handle, opts.actorId)
  const files = fs.tree().filter((n) => n.type === 'file')
  const paths: string[] = []
  let done = 0
  for (const node of files) {
    const path = fs.pathOf(node.nodeId)
    if (!path) continue
    const bytes = await fs.read(path)
    await sink.writeBytes(path, bytes)
    paths.push(path)
    opts.onProgress?.(++done, files.length)
  }
  return paths
}
