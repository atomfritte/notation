/**
 * Open-file URL parameter encoding.
 *
 * Plaintext spaces carry the file PATH in the query (`?file=notes/x.md`). For a
 * zero-knowledge space that path is a secret the server must never see, yet a
 * full document load (open-in-new-tab, reload, bookmark, a resolved in-document
 * link) puts the query into the server's / a reverse proxy's access logs. So
 * encrypted spaces address the file by its OPAQUE nodeId instead (`?n=<hex>`):
 * the server already knows every nodeId from the op-log, so this leaks no name.
 *
 * These are pure functions over an `idAt` (path → nodeId) / `pathOf` (nodeId →
 * path) resolver so the SpaceView can share one encoding across every URL write
 * (setFileParam, open-in-new-tab, in-document links) and the reverse read.
 */

type IdAt = (path: string) => string | undefined
type PathOf = (nodeId: string) => string | undefined

/** The query params that open `path`, as a record for `setSearchParams`. */
export function fileParams(encrypted: boolean, path: string, idAt: IdAt): Record<string, string> {
  if (!path) return {}
  if (!encrypted) return { file: path }
  const n = idAt(path)
  return n ? { n } : {}
}

/** The query STRING (leading `?`, or '' when empty) that opens `path`. */
export function fileSearchString(encrypted: boolean, path: string, idAt: IdAt): string {
  const s = new URLSearchParams(fileParams(encrypted, path, idAt)).toString()
  return s ? `?${s}` : ''
}

/** Resolve the current open-file param back to a logical path (or '' if none). */
export function resolveFileParam(encrypted: boolean, params: URLSearchParams, pathOf: PathOf): string {
  if (!encrypted) return params.get('file') ?? ''
  const n = params.get('n')
  return n ? pathOf(n) ?? '' : ''
}
