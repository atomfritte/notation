import { getCSRF } from './auth'

// Dispatched when any API call returns 401 — AuthGate listens and re-fetches
// /api/auth/state to bounce the user back to the login screen.
const AUTH_EXPIRED_EVENT = 'notation:auth-expired'

function attachCSRF(init: RequestInit | undefined): RequestInit {
  const out: RequestInit = init ? { ...init } : {}
  const method = (out.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return out
  const csrf = getCSRF()
  if (!csrf) return out
  const headers = new Headers(out.headers)
  headers.set('X-CSRF-Token', csrf)
  out.headers = headers
  return out
}

/** Kanban columns on the landing-page board. `''`/undefined = untriaged → Inbox. */
export type BoardColumn = 'inbox' | 'backlog' | 'active' | 'archive'

export type Meta = {
  id: string
  name: string
  created_at: string
  updated_at: string
  owner: string
  /** Kanban column; absent/'' means untriaged (rendered in Inbox). */
  status?: BoardColumn | ''
  /** Manual sort rank within a column (ascending); absent = 0. */
  order?: number
  /** Zero-knowledge space: its content lives as opaque ciphertext blobs +
   *  a sealed op-log under /enc/*, and the plaintext file/tree/search/… APIs
   *  409. The client drives it through EncryptedFS. */
  encrypted?: boolean
  /** Set while a space is mid-conversion between modes: "to-encrypted" or
   *  "to-plaintext". Empty/absent for a settled space. Both mode gates are
   *  relaxed while it is set. */
  converting?: '' | 'to-encrypted' | 'to-plaintext'
}

/** Conversion direction for the encrypt/decrypt flows. */
export type ConvertDirection = 'to-encrypted' | 'to-plaintext'

export type BoardMove = { id: string; status: BoardColumn; order: number }

export type Entry = {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: string
  children?: Entry[]
  /** A directory containing a _form.md template — rendered as a form, not a
   *  file listing. `entries` is the submission count. */
  form?: boolean
  entries?: number
}

export type FormFieldType =
  | 'string' | 'text' | 'integer' | 'number' | 'bool'
  | 'date' | 'time' | 'datetime' | 'select' | 'email' | 'url'
  | 'buttons' | 'multiselect' | 'smiley' | 'rating' | 'slider' | 'image'

export type FormField = {
  key: string
  label: string
  type: FormFieldType
  required: boolean
  options?: string[]
  default?: string
  min?: number
  max?: number
  step?: number
  levels?: number
}

export type FormSchema = {
  title: string
  title_field: string
  fields: FormField[]
}

export type FormEntry = {
  id: string
  path: string
  created_at: string
  title: string
  values: Record<string, unknown>
}

export type FormData = {
  folder: string
  schema: FormSchema
  entries: FormEntry[]
  can_submit: boolean
  can_edit?: boolean
}

export type Commit = {
  hash: string
  author: string
  email: string
  date: string
  subject: string
}

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, attachCSRF(init))
  if (r.status === 401) {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
  }
  if (!r.ok) throw await asError(r)
  if (r.status === 204) return undefined as T
  return r.json() as Promise<T>
}

async function asError(r: Response): Promise<Error> {
  let msg = `HTTP ${r.status}`
  try {
    const j = await r.json()
    if (j?.error) msg = j.error
  } catch {
    /* ignore */
  }
  return Object.assign(new Error(msg), { status: r.status })
}

function encodePath(p: string): string {
  // NFC-normalise before encoding so filenames typed on different OSes
  // round-trip cleanly through the URL → backend → filesystem lookup.
  return p
    .normalize('NFC')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

export const me = () => fetchJSON<{ name: string; groups: string[] | null }>('/api/admin/me')

export const listSpaces = () => fetchJSON<Meta[]>('/api/admin/spaces')

/** Fetch a single space's metadata — notably the `encrypted` flag the
 *  SpaceView needs to decide between the plaintext API path and EncryptedFS. */
export const getSpace = (id: string) =>
  fetchJSON<Meta>(`/api/admin/spaces/${encodeURIComponent(id)}`)

export const createSpace = (id: string, name?: string, encrypted = false) =>
  fetchJSON<Meta>('/api/admin/spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name, encrypted }),
  })

export const deleteSpace = (id: string) =>
  fetchJSON<void>(`/api/admin/spaces/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** Persist Kanban column + ordering for one or more spaces in a single batch
 *  (one drag typically reindexes the source + target columns). */
export const updateBoard = (moves: BoardMove[]) =>
  fetchJSON<void>('/api/admin/board', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ moves }),
  })

export const getTree = (id: string) =>
  fetchJSON<Entry[]>(`/api/admin/spaces/${encodeURIComponent(id)}/tree`)

/** Flat list of every file path in the space (form folders NOT collapsed).
 *  Used by the encrypt conversion so nothing is dropped from the copy. */
export const listFilesFlat = (id: string) =>
  fetchJSON<string[]>(`/api/admin/spaces/${encodeURIComponent(id)}/files-flat`)

export const getForm = (id: string, folder: string) =>
  fetchJSON<FormData>(`/api/admin/spaces/${encodeURIComponent(id)}/form/${encodePath(folder)}`)

export const submitForm = (id: string, folder: string, values: Record<string, unknown>) =>
  fetchJSON<FormEntry>(`/api/admin/spaces/${encodeURIComponent(id)}/form/${encodePath(folder)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  })

export const updateForm = (id: string, folder: string, entryID: string, values: Record<string, unknown>) =>
  fetchJSON<FormEntry>(`/api/admin/spaces/${encodeURIComponent(id)}/form/${encodePath(folder)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: entryID, values }),
  })

export const deleteFormEntry = (id: string, folder: string, entryID: string) =>
  fetchJSON<void>(`/api/admin/spaces/${encodeURIComponent(id)}/form/${encodePath(folder)}?id=${encodeURIComponent(entryID)}`, {
    method: 'DELETE',
  })

/** Upload one image attachment for a form; returns its stored path. */
export const uploadFormImage = async (id: string, folder: string, blob: Blob): Promise<string> => {
  const headers: Record<string, string> = { 'Content-Type': blob.type || 'application/octet-stream' }
  const csrf = getCSRF()
  if (csrf) headers['X-CSRF-Token'] = csrf
  const r = await fetch(`/api/admin/spaces/${encodeURIComponent(id)}/form-upload/${encodePath(folder)}`, {
    method: 'POST',
    headers,
    body: blob,
  })
  if (r.status === 401) window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
  if (!r.ok) throw await asError(r)
  return (await r.json() as { path: string }).path
}

export const readFile = async (id: string, path: string): Promise<{content: string, etag: string | null}> => {
  const r = await fetch(`/api/admin/spaces/${encodeURIComponent(id)}/file/${encodePath(path)}`, { credentials: 'same-origin' })
  if (!r.ok) throw await asError(r)
  const etag = r.headers.get('ETag')
  const content = await r.text()
  return { content, etag }
}

export const writeFile = (id: string, path: string, content: string, etag: string | null = null, mime = 'text/markdown') => {
  const headers: Record<string, string> = { 'Content-Type': mime }
  if (etag) headers['If-Match'] = etag
  return fetchJSON<void>(`/api/admin/spaces/${encodeURIComponent(id)}/file/${encodePath(path)}`, {
    method: 'PUT',
    headers,
    body: content,
  })
}

/** Upload a binary file (image, pdf, xlsx, …). Uses the same PUT endpoint as
 * writeFile but sends a Blob and lets the browser set Content-Type. */
export const writeFileBinary = async (id: string, path: string, blob: Blob): Promise<void> => {
  const headers: Record<string, string> = {
    'Content-Type': blob.type || 'application/octet-stream',
  }
  const csrf = getCSRF()
  if (csrf) headers['X-CSRF-Token'] = csrf
  const r = await fetch(`/api/admin/spaces/${encodeURIComponent(id)}/file/${encodePath(path)}`, {
    method: 'PUT',
    headers,
    body: blob,
  })
  if (r.status === 401) {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
  }
  if (!r.ok) throw await asError(r)
}

/** Direct URL for downloading or rendering a file via <img>. */
export const fileURL = (id: string, path: string) =>
  `/api/admin/spaces/${encodeURIComponent(id)}/file/${encodePath(path)}`

/** Read a file's RAW bytes (text OR binary) — used by the encrypt conversion so
 *  attachments round-trip losslessly (a .text() read would corrupt binary). */
export const readFileBytes = async (id: string, path: string): Promise<Uint8Array> => {
  const r = await fetch(fileURL(id, path), { credentials: 'same-origin' })
  if (!r.ok) throw await asError(r)
  return new Uint8Array(await r.arrayBuffer())
}

// ---- convert an existing space between plaintext and encrypted -------------

/** Set the transient conversion marker (non-destructive). Relaxes the gate. */
export const beginConvert = (id: string, direction: ConvertDirection) =>
  fetchJSON<Meta>(`/api/admin/spaces/${encodeURIComponent(id)}/enc/begin-convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction }),
  })

/** Drop the staged target-mode data and return to the original mode intact. */
export const abortConvert = (id: string) =>
  fetchJSON<Meta>(`/api/admin/spaces/${encodeURIComponent(id)}/enc/abort-convert`, {
    method: 'POST',
  })

/** The DESTRUCTIVE commit: purge the source mode, flip the flag, re-init git. */
export const finalizeConvert = (id: string) =>
  fetchJSON<Meta>(`/api/admin/spaces/${encodeURIComponent(id)}/enc/finalize-convert`, {
    method: 'POST',
  })

// ---- server-side TTS (read-aloud studio voice) ----
export type ServerVoice = { id: string; label: string; lang: string }

export const ttsInfo = () =>
  fetchJSON<{ available: boolean; voices: ServerVoice[] }>('/api/admin/tts/info')

/** Audio URL for one chunk; deterministic + immutable so the browser caches it.
 *  Space-scoped: the clip is keyed + cached per space (server scope + per-space SW
 *  cache), so a recording can never be served for, or bleed into, another space. */
export const ttsURL = (spaceId: string, voiceId: string, text: string, style?: string) =>
  `/api/admin/spaces/${encodeURIComponent(spaceId)}/tts?voice=${encodeURIComponent(voiceId)}&text=${encodeURIComponent(text)}` +
  (style ? `&style=${encodeURIComponent(style)}` : '')

/** Direct URL for the whole-Space ZIP export (attachment download). */
export const exportURL = (id: string) =>
  `/api/admin/spaces/${encodeURIComponent(id)}/export`

// Trigger a browser download via a synthetic <a download>. Works for any
// same-origin file even when the endpoint serves it inline (PDF/image), since
// the download attribute overrides the inline Content-Disposition. The session
// cookie rides along automatically on the GET.
function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Download a single file from the Space. */
export const downloadFile = (id: string, path: string) =>
  triggerDownload(fileURL(id, path), path.split('/').pop() || 'download')

/** Download the whole Space as a ZIP archive. */
export const downloadSpaceZip = (id: string) =>
  triggerDownload(exportURL(id), `${id}.zip`)

export const deleteFile = (id: string, path: string) =>
  fetchJSON<void>(`/api/admin/spaces/${encodeURIComponent(id)}/file/${encodePath(path)}`, {
    method: 'DELETE',
  })

export const renameFile = (id: string, from: string, to: string) =>
  fetchJSON<void>(`/api/admin/spaces/${encodeURIComponent(id)}/rename/${encodePath(from)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to }),
  })

export const mkdir = (id: string, path: string) =>
  fetchJSON<void>(`/api/admin/spaces/${encodeURIComponent(id)}/mkdir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })

export const getLog = (id: string) =>
  fetchJSON<Commit[]>(`/api/admin/spaces/${encodeURIComponent(id)}/log`)

export const snapshot = (id: string, message: string) =>
  fetchJSON<void>(`/api/admin/spaces/${encodeURIComponent(id)}/snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })

// ---- Magic-link shares ---------------------------------------------------

export type SharePermission = 'read' | 'comment' | 'edit'
export type ShareFeatures = {
  outline: boolean
  search: boolean
  palette: boolean
  bookmarks: boolean
  theme: boolean
  print: boolean
}
export const DEFAULT_SHARE_FEATURES: ShareFeatures = {
  outline: true, search: true, palette: true,
  bookmarks: true, theme: true, print: true,
}
export type Share = {
  id: string
  permission: SharePermission
  // Page/folder the link is limited to; absent/empty = whole space.
  scope?: string
  label: string
  created_at: string
  expires_at?: string
  created_by: string
  last_used?: string
  features: ShareFeatures
}
export type ShareCreated = { share: Share; token: string; url: string }

export const listShares = (id: string) =>
  fetchJSON<Share[]>(`/api/admin/spaces/${encodeURIComponent(id)}/shares`)

export const createShare = (
  id: string,
  body: {
    permission: SharePermission
    scope?: string
    label?: string
    expires_in?: string
    features?: ShareFeatures
  },
) =>
  fetchJSON<ShareCreated>(`/api/admin/spaces/${encodeURIComponent(id)}/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const deleteShare = (id: string, shareID: string) =>
  fetchJSON<void>(
    `/api/admin/spaces/${encodeURIComponent(id)}/shares/${encodeURIComponent(shareID)}`,
    { method: 'DELETE' },
  )

// ---- MCP tokens ----------------------------------------------------------

export type MCPToken = {
  id: string
  label: string
  created_at: string
  created_by: string
  last_used?: string
}
export type MCPTokenCreated = { token: MCPToken; raw: string; url: string }

export const listMCPTokens = (id: string) =>
  fetchJSON<MCPToken[]>(`/api/admin/spaces/${encodeURIComponent(id)}/mcp-tokens`)

export const createMCPToken = (id: string, label: string) =>
  fetchJSON<MCPTokenCreated>(`/api/admin/spaces/${encodeURIComponent(id)}/mcp-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  })

export const deleteMCPToken = (id: string, tokenID: string) =>
  fetchJSON<void>(
    `/api/admin/spaces/${encodeURIComponent(id)}/mcp-tokens/${encodeURIComponent(tokenID)}`,
    { method: 'DELETE' },
  )

export type CommentAnchor = {
  quote: string
  prefix: string
  suffix: string
}

export type CommentItem = {
  id: string
  parent_id?: string
  created_at: string
  author: string
  text: string
  anchor?: CommentAnchor
}

// URL builders shared by the fetchers + offline sync, so the cached URL is
// byte-identical to the one requested at read time.
export const commentsURL = (id: string, path: string) =>
  `/api/admin/spaces/${encodeURIComponent(id)}/comments/${encodePath(path)}`
export const allCommentsURL = (id: string) =>
  `/api/admin/spaces/${encodeURIComponent(id)}/all-comments`

export const getComments = (id: string, path: string) =>
  fetchJSON<CommentItem[]>(commentsURL(id, path))

// AllCommentItem extends CommentItem with the path field that the
// space-wide listing carries — needed so the "All comments" tab can group
// and link back to the file each comment lives on.
export type AllCommentItem = CommentItem & { path: string }

export const getAllComments = (id: string) =>
  fetchJSON<AllCommentItem[]>(allCommentsURL(id))

export const deleteComment = (id: string, commentID: string) =>
  fetchJSON<void>(`/api/admin/spaces/${encodeURIComponent(id)}/comments/by-id/${encodeURIComponent(commentID)}`, {
    method: 'DELETE',
  })

// ---- legacy plaintext metadata cleanup (encrypted spaces) ------------------
//
// A space encrypted before comments joined the crypto system still carries the
// plaintext .notation/comments.jsonl (+ audit.log) that predates encryption.
// The client reads the orphaned comments, migrates them into the encrypted
// op-log, then purges both sidecars.

export type LegacyMetadata = {
  /** comments.jsonl exists — the one sidecar the client migrates before purge. */
  has_comments: boolean
  /** audit.log / shares.json / mcp-tokens.json exist — dropped outright. */
  has_other: boolean
  comments: AllCommentItem[]
}

export const getLegacyComments = (id: string) =>
  fetchJSON<LegacyMetadata>(`/api/admin/spaces/${encodeURIComponent(id)}/enc/legacy-comments`)

export const purgeLegacyMetadata = (id: string) =>
  fetchJSON<void>(`/api/admin/spaces/${encodeURIComponent(id)}/enc/purge-legacy-metadata`, { method: 'POST' })

export const postComment = (
  id: string,
  path: string,
  text: string,
  opts: { parentID?: string; anchor?: CommentAnchor } = {},
) =>
  fetchJSON<CommentItem>(`/api/admin/spaces/${encodeURIComponent(id)}/comments/${encodePath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      parent_id: opts.parentID,
      anchor: opts.anchor,
    }),
  })

export type SearchMatch = {
  path: string
  line: number
  content: string
}

export const searchSpace = (id: string, q: string, glob?: string) => {
  const params = new URLSearchParams({ q })
  if (glob) params.set('glob', glob)
  return fetchJSON<SearchMatch[]>(`/api/admin/spaces/${encodeURIComponent(id)}/search?${params}`)
}

export type AuditEntry = {
  ts: string
  actor: string
  action: string
  path?: string
  ip?: string
  ua?: string
  err?: string
}

export const getAudit = (id: string, limit = 200) =>
  fetchJSON<AuditEntry[]>(`/api/admin/spaces/${encodeURIComponent(id)}/audit?limit=${limit}`)

export const getDiff = async (id: string, hash: string): Promise<string> => {
  const r = await fetch(`/api/admin/spaces/${encodeURIComponent(id)}/diff/${encodeURIComponent(hash)}`)
  if (!r.ok) throw await asError(r)
  return r.text()
}

export const getFileHistory = (id: string, path: string) =>
  fetchJSON<Commit[]>(`/api/admin/spaces/${encodeURIComponent(id)}/file-history/${encodePath(path)}`)

export const getFileAtCommit = async (id: string, hash: string, path: string): Promise<string> => {
  const r = await fetch(
    `/api/admin/spaces/${encodeURIComponent(id)}/file-at/${encodeURIComponent(hash)}/${encodePath(path)}`,
  )
  if (!r.ok) throw await asError(r)
  return r.text()
}

export const fileAtURL = (id: string, hash: string, path: string) =>
  `/api/admin/spaces/${encodeURIComponent(id)}/file-at/${encodeURIComponent(hash)}/${encodePath(path)}`

export const getFileDiff = async (id: string, path: string, from: string, to: string): Promise<string> => {
  const params = new URLSearchParams({ from, to })
  const r = await fetch(
    `/api/admin/spaces/${encodeURIComponent(id)}/file-diff/${encodePath(path)}?${params}`,
  )
  if (!r.ok) throw await asError(r)
  return r.text()
}

export const restoreFile = (id: string, path: string, hash: string) =>
  fetchJSON<void>(`/api/admin/spaces/${encodeURIComponent(id)}/restore/${encodePath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  })
