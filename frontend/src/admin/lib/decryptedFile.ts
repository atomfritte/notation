/**
 * Client-side decrypted-file plumbing for binary previews in a zero-knowledge
 * space. The server only holds ciphertext, so its /file endpoint 409s for an
 * encrypted space; instead we decrypt through the {@link EncryptedFS} and feed
 * the viewers the bytes directly:
 *
 *   - URL-based viewers (image / pdf / video / audio / download) get a
 *     `blob:` object URL built from the decrypted bytes + the path's MIME.
 *   - byte-parsing viewers (docx / xlsx) get the raw {@link Uint8Array}.
 *
 * Object URLs are always revoked (on unmount, on path change, or after a
 * download starts) so opening many attachments never leaks them.
 */
import { useEffect, useState } from 'react'
import type { EncryptedFS } from '../../shared/vfs/encfs'
import { mimeForPath } from './fileTypes'

/**
 * Build a `blob:` object URL for decrypted bytes, tagged with the path's MIME.
 * Returns the URL plus an idempotent `revoke()` — the single owner of that URL's
 * lifetime. Framework-agnostic so it is trivially unit-testable.
 */
export function makeDecryptedObjectURL(
  bytes: Uint8Array,
  path: string,
): { url: string; revoke: () => void } {
  // fs.read() bytes are always backed by a real ArrayBuffer (never shared); the
  // cast satisfies TS's ArrayBuffer-specific BlobPart with no copy.
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeForPath(path) })
  const url = URL.createObjectURL(blob)
  let revoked = false
  return {
    url,
    revoke: () => {
      if (revoked) return
      revoked = true
      URL.revokeObjectURL(url)
    },
  }
}

export interface DecryptedFile {
  /** `blob:` object URL for URL-based viewers, or null while loading / errored. */
  url: string | null
  /** Raw decrypted bytes for byte-parsing viewers (docx / xlsx), or null. */
  bytes: Uint8Array | null
  loading: boolean
  error: string | null
}

/**
 * Decrypt a single file from an {@link EncryptedFS} and expose it as both a
 * `blob:` object URL and the raw bytes. The object URL is created once the bytes
 * arrive and REVOKED on unmount or whenever `fs`/`path` changes.
 */
export function useDecryptedFile(fs: EncryptedFS | null, path: string): DecryptedFile {
  const [state, setState] = useState<DecryptedFile>({
    url: null, bytes: null, loading: true, error: null,
  })

  useEffect(() => {
    if (!fs || !path) {
      setState({ url: null, bytes: null, loading: false, error: null })
      return
    }
    let cancelled = false
    let handle: { url: string; revoke: () => void } | null = null
    setState({ url: null, bytes: null, loading: true, error: null })
    fs.read(path)
      .then((bytes) => {
        if (cancelled) return
        handle = makeDecryptedObjectURL(bytes, path)
        setState({ url: handle.url, bytes, loading: false, error: null })
      })
      .catch((e) => {
        if (!cancelled) setState({ url: null, bytes: null, loading: false, error: String(e) })
      })
    return () => {
      cancelled = true
      handle?.revoke()
    }
  }, [fs, path])

  return state
}

/**
 * Download a single decrypted file client-side via a synthetic `<a download>`.
 * Used wherever the plaintext UI would call the server /file endpoint (which
 * 409s for an encrypted space).
 */
export async function downloadDecryptedFile(fs: EncryptedFS, path: string): Promise<void> {
  const bytes = await fs.read(path)
  const { url, revoke } = makeDecryptedObjectURL(bytes, path)
  const a = document.createElement('a')
  a.href = url
  a.download = path.split('/').pop() || 'download'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Keep the URL alive long enough for the browser to start the download, then
  // reclaim it. Revoking synchronously aborts the download in some browsers.
  setTimeout(revoke, 60_000)
}
