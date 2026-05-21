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

export type Meta = {
  id: string
  name: string
  created_at: string
  updated_at: string
  owner: string
}

export type Entry = {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: string
  children?: Entry[]
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
  return p
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

export const me = () => fetchJSON<{ name: string; groups: string[] | null }>('/api/admin/me')

export const listSpaces = () => fetchJSON<Meta[]>('/api/admin/spaces')

export const createSpace = (id: string, name?: string) =>
  fetchJSON<Meta>('/api/admin/spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name }),
  })

export const deleteSpace = (id: string) =>
  fetchJSON<void>(`/api/admin/spaces/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const getTree = (id: string) =>
  fetchJSON<Entry[]>(`/api/admin/spaces/${encodeURIComponent(id)}/tree`)

export const readFile = async (id: string, path: string): Promise<{content: string, etag: string | null}> => {
  const r = await fetch(`/api/admin/spaces/${encodeURIComponent(id)}/file/${encodePath(path)}`)
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

export const getComments = (id: string, path: string) =>
  fetchJSON<CommentItem[]>(`/api/admin/spaces/${encodeURIComponent(id)}/comments/${encodePath(path)}`)

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
