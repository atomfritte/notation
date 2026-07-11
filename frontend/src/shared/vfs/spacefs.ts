/**
 * SpaceFS — the logical, path-based filesystem interface both backends will
 * implement in later phases. Phase 1 defines the contract only; there is no
 * implementation here.
 *
 * Two backends are planned:
 *
 *   - **PlaintextFS** — a thin wrapper over today's `admin/lib/api.ts`, mapping
 *     these logical operations onto the existing server REST endpoints. It
 *     exists so unencrypted spaces and encrypted spaces share one call site.
 *
 *   - **EncryptedFS** — the zero-knowledge backend. `tree()` is materialized by
 *     replaying the (decrypted) op-log ({@link ../vfs/ops#buildTree}); `read`/
 *     `write` en/decrypt content blobs ({@link ../crypto/blob}); structural
 *     mutations append encrypted ops ({@link ../vfs/opCrypto}). The server sees
 *     only ciphertext blobs and ordering metadata.
 *
 * All paths are logical, forward-slash separated, and rooted (no leading
 * slash, no `.`/`..`). Names collide within a directory only, never globally.
 */
import type { Node } from './nodes'

export interface SpaceFS {
  /** Snapshot of the current node set (excluding trashed nodes unless asked). */
  tree(): Node[]

  /** Read a file's decrypted content by logical path. */
  read(path: string): Promise<Uint8Array>

  /** Create or overwrite a file's content at a logical path. */
  write(path: string, data: Uint8Array): Promise<void>

  /** Create a directory (and any missing parents) at a logical path. */
  mkdir(path: string): Promise<void>

  /** Rename/replace a node from one logical path to another. */
  rename(from: string, to: string): Promise<void>

  /** Reparent a node by id under a new parent id (structural move). */
  move(nodeId: string, newParentId: string): Promise<void>

  /** Soft-delete the node at a logical path. */
  remove(path: string): Promise<void>
}
