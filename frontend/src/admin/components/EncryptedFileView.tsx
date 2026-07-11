import { AlertTriangle } from 'lucide-react'
import type { EncryptedFS } from '../../shared/vfs/encfs'
import { useDecryptedFile } from '../lib/decryptedFile'
import { FileViewer } from './FileViewer'

type Props = {
  fs: EncryptedFS
  spaceID: string
  path: string
  theme: 'light' | 'dark'
}

/**
 * Adapter that feeds {@link FileViewer} DECRYPTED bytes for a binary file in a
 * zero-knowledge space. It decrypts the file through the {@link EncryptedFS},
 * hands URL-based viewers (image / pdf / video / audio / download) a `blob:`
 * object URL and byte-parsing viewers (docx / xlsx) the raw bytes — so the
 * server file URL (which 409s for ciphertext) is never touched. Plaintext
 * spaces bypass this entirely and render FileViewer against the server URL.
 */
export function EncryptedFileView({ fs, spaceID, path, theme }: Props) {
  const { url, bytes, loading, error } = useDecryptedFile(fs, path)

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-3">
        <AlertTriangle size={32} className="text-[var(--notation-danger)]" />
        <div className="text-sm text-[var(--notation-fg)]">Could not decrypt this file</div>
        <div className="text-xs text-[var(--notation-fg-muted)] font-mono break-all max-w-md">{error}</div>
      </div>
    )
  }
  if (loading || !url) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--notation-fg-muted)] text-sm">
        Decrypting…
      </div>
    )
  }

  return (
    <FileViewer
      spaceID={spaceID}
      path={path}
      content=""
      theme={theme}
      urlFor={() => url}
      bytes={bytes ?? undefined}
    />
  )
}
