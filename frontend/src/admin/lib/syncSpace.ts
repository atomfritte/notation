/**
 * syncSpace — the small port the local-folder-sync engine speaks, so ONE engine
 * serves both space kinds.
 *
 * Folder sync started as an encrypted-space feature (a local agent can't work on
 * ciphertext, so the browser had to decrypt into a real folder). The same
 * pull/diff/push loop is just as useful for a plaintext space — "edit my notes
 * with local tools, review the diff, push it back" — the only difference is
 * WHERE the bytes live: behind an in-browser {@link EncryptedFS}, or behind the
 * server's plaintext REST API.
 *
 * {@link SyncSpace} is that difference, and nothing else:
 *
 *   - {@link encryptedSyncSpace} — reads/writes through the unlocked
 *     {@link EncryptedFS}; the browser stays the crypto authority and `flush()`
 *     pushes the op-log.
 *   - {@link plaintextSyncSpace} — reads/writes through a
 *     {@link PlaintextTransport} (HTTP in the app, a fake in tests). Writes are
 *     ordinary file PUTs, so the server's git history records the push like any
 *     other edit.
 *
 * Keeping the transport injectable is what makes the plaintext side testable
 * without a network — the same shape {@link ../lib/convert} uses.
 */
import type { EncryptedFS } from '../../shared/vfs/encfs'
import { listZipNodes } from './spaceZip'
import * as api from './api'

/** One node of the space's content set: a file, or a directory marker. */
export interface SyncNode {
  /** Logical, `/`-separated path, no leading slash. */
  path: string
  isDir: boolean
}

/**
 * The whole surface {@link ./folderSync} needs from a space. Deliberately
 * minimal: no rename/move (the engine models a rename as delete + create with
 * the content preserved) and no mkdir (both backends create parent directories
 * implicitly on write).
 */
export interface SyncSpace {
  /** True for a zero-knowledge space — drives the plaintext-on-disk warning. */
  readonly encrypted: boolean
  /** Every visible node, deterministically ordered (shallow-first, then name). */
  listNodes(): Promise<SyncNode[]>
  /** Raw bytes of one file (decrypted for an encrypted space). */
  read(path: string): Promise<Uint8Array>
  /** Create or overwrite a file, creating any missing parent directories. */
  write(path: string, bytes: Uint8Array): Promise<void>
  /** Delete the file at `path` (soft-delete for an encrypted space). */
  remove(path: string): Promise<void>
  /** Settle a batch of mutations (encrypted: push the op-log). */
  flush(): Promise<void>
}

/**
 * Deterministic order for a node set: shallow paths first, then case-folded
 * name. Mirrors {@link listZipNodes} so both backends yield the same layout.
 */
export function sortNodes(nodes: SyncNode[]): SyncNode[] {
  return nodes.sort((a, b) => {
    const da = a.path.split('/').length
    const db = b.path.split('/').length
    if (da !== db) return da - db
    return a.path.toLowerCase().localeCompare(b.path.toLowerCase())
  })
}

// ── encrypted backend ────────────────────────────────────────────────────────

/**
 * A {@link SyncSpace} over an unlocked {@link EncryptedFS}. Every byte is
 * en/decrypted in the browser; the server only ever sees ciphertext. `flush()`
 * is {@link EncryptedFS.sync} so a push's ops reach the server before the UI
 * re-projects the tree.
 */
export function encryptedSyncSpace(fs: EncryptedFS): SyncSpace {
  return {
    encrypted: true,
    listNodes: async () => listZipNodes(fs),
    read: (path) => fs.read(path),
    write: (path, bytes) => fs.write(path, bytes),
    remove: (path) => fs.remove(path),
    flush: () => fs.sync(),
  }
}

// ── plaintext backend ────────────────────────────────────────────────────────

/** The server operations the plaintext backend needs; faked in tests. */
export interface PlaintextTransport {
  /** Every file path in the space, flat (form-folder contents NOT collapsed). */
  listFiles(): Promise<string[]>
  /** The recursive tree — used for DIRECTORIES only (incl. empty ones). */
  listTree(): Promise<api.Entry[]>
  readBytes(path: string): Promise<Uint8Array>
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
  deleteFile(path: string): Promise<void>
}

/** The real HTTP transport for a plaintext space. */
export function httpPlaintextTransport(spaceID: string): PlaintextTransport {
  return {
    listFiles: () => api.listFilesFlat(spaceID),
    listTree: () => api.getTree(spaceID),
    readBytes: (path) => api.readFileBytes(spaceID, path),
    writeBytes: (path, bytes) => api.writeFileBinary(spaceID, path, new Blob([bytes as BlobPart])),
    deleteFile: (path) => api.deleteFile(spaceID, path),
  }
}

/** Collect every directory path from a (recursive) tree listing. */
function treeDirs(entries: api.Entry[], out: string[] = []): string[] {
  for (const e of entries) {
    if (!e.is_dir) continue
    out.push(e.path)
    if (e.children) treeDirs(e.children, out)
  }
  return out
}

/**
 * A {@link SyncSpace} over the server's plaintext file API.
 *
 * The node set is assembled from TWO endpoints on purpose: `files-flat` for the
 * files (the tree hides a form folder's contents, and a sync that silently
 * dropped form entries would delete them on the next push), and the tree for the
 * directories (so empty folders survive a pull). Dotfiles are excluded on both
 * — server-side and again by the engine's ignore set.
 */
export function plaintextSyncSpace(transport: PlaintextTransport): SyncSpace {
  return {
    encrypted: false,
    async listNodes() {
      const [files, tree] = await Promise.all([transport.listFiles(), transport.listTree()])
      const nodes: SyncNode[] = treeDirs(tree).map((path) => ({ path, isDir: true }))
      for (const path of files) nodes.push({ path, isDir: false })
      return sortNodes(nodes)
    },
    read: (path) => transport.readBytes(path),
    write: (path, bytes) => transport.writeBytes(path, bytes),
    remove: (path) => transport.deleteFile(path),
    // Server-side writes are already durable when their request resolves; the
    // debounced git commit needs no client-side settle.
    flush: async () => {},
  }
}
