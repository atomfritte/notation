/**
 * spaceZip — build a DECRYPTED ZIP of a zero-knowledge space entirely in the
 * browser.
 *
 * The server only ever holds ciphertext (its /export endpoint 409s for an
 * encrypted space), so a portable backup has to be assembled client-side: walk
 * the unlocked {@link EncryptedFS}, decrypt every file's bytes with {@link
 * EncryptedFS.read}, and pack them under their real logical paths so the archive
 * reconstructs the full folder structure with plaintext names and byte-identical
 * content. Directories (including empty ones) are emitted as explicit `dir/`
 * entries so the tree is preserved even where a folder holds no files.
 *
 * The heavy lifting (deflate) is fflate's; it is small and dependency-free.
 */
import { zip } from 'fflate'
import { EncryptedFS } from '../../shared/vfs/encfs'

/** A file path + its decrypted bytes, or a directory marker (bytes = null). */
interface ZipNode {
  path: string
  isDir: boolean
}

/**
 * The full set of visible nodes as `{ path, isDir }`, in a deterministic order
 * (shallow-first, then case-folded name) so the archive layout is stable. Trash
 * is already excluded by {@link EncryptedFS.tree}.
 */
export function listZipNodes(fs: EncryptedFS): ZipNode[] {
  const nodes: ZipNode[] = []
  for (const n of fs.tree()) {
    const path = fs.pathOf(n.nodeId)
    if (!path) continue // orphaned / trashed — pathOf returns undefined
    nodes.push({ path, isDir: n.type === 'dir' })
  }
  nodes.sort((a, b) => {
    const da = a.path.split('/').length
    const db = b.path.split('/').length
    if (da !== db) return da - db
    return a.path.toLowerCase().localeCompare(b.path.toLowerCase())
  })
  return nodes
}

/**
 * Build a decrypted ZIP of the whole space. Every file is read (decrypted)
 * through the {@link EncryptedFS} and stored under its logical path; directories
 * become explicit `dir/` entries so empty folders survive the round-trip.
 * Returns the finished zip bytes.
 */
export async function buildDecryptedZip(fs: EncryptedFS): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {}
  for (const node of listZipNodes(fs)) {
    if (node.isDir) {
      // A trailing slash with empty content is fflate's empty-directory entry.
      entries[node.path + '/'] = new Uint8Array(0)
    } else {
      entries[node.path] = await fs.read(node.path)
    }
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    // level 6 is a sensible size/speed default; personal note corpora are small.
    zip(entries, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)))
  })
}

/**
 * Build the decrypted ZIP and trigger a browser download of `space-<id>.zip`
 * via a synthetic `<a download>`. The object URL is revoked after a delay so the
 * download can start before the blob is reclaimed (revoking synchronously aborts
 * it in some browsers — same pattern as {@link downloadDecryptedFile}).
 */
export async function downloadDecryptedSpaceZip(fs: EncryptedFS, spaceId: string): Promise<void> {
  const bytes = await buildDecryptedZip(fs)
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `space-${spaceId}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
