export type Permission = 'read' | 'comment' | 'edit'

// Per-share-link reader features. The admin ticks these at creation time;
// the share UI gates affordances accordingly. Backend backfills all-on for
// legacy shares so we never accidentally strip features post-upgrade.
export type Features = {
  outline: boolean
  search: boolean
  palette: boolean
  bookmarks: boolean
  theme: boolean
  print: boolean
}

export type SpaceInfo = {
  space: { id: string; name: string }
  permission: Permission
  // Page/folder this link is limited to; '' = whole space. Informational for
  // the UI — the server enforces the scope on every endpoint regardless.
  scope: string
  label: string
  features: Features
}

export type GrepMatch = {
  path: string
  line: number
  content: string
  before?: string[]
  after?: string[]
}

export type Entry = {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: string
  children?: Entry[]
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

export type CommentAnchor = {
  quote: string
  prefix: string
  suffix: string
}

export type Comment = {
  id: string
  parent_id?: string
  path: string
  created_at: string
  author: string
  text: string
  anchor?: CommentAnchor
}

function tokenFromPath(): string {
  return window.location.pathname.split('/').filter(Boolean)[1] ?? ''
}

export const TOKEN = tokenFromPath()
const API = `/s/api/${encodeURIComponent(TOKEN)}`

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
  return p.split('/').filter(Boolean).map(encodeURIComponent).join('/')
}

export async function getSpace(): Promise<SpaceInfo> {
  const r = await fetch(`${API}/space`)
  if (!r.ok) throw await asError(r)
  return r.json()
}

export async function getTree(): Promise<Entry[]> {
  const r = await fetch(`${API}/tree`)
  if (!r.ok) throw await asError(r)
  return r.json()
}

export async function readFile(path: string): Promise<string> {
  const r = await fetch(`${API}/file/${encodePath(path)}`)
  if (!r.ok) throw await asError(r)
  return r.text()
}

export async function writeFile(path: string, content: string): Promise<void> {
  const r = await fetch(`${API}/file/${encodePath(path)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown' },
    body: content,
  })
  if (!r.ok) throw await asError(r)
}

export async function listComments(path: string): Promise<Comment[]> {
  const r = await fetch(`${API}/comments/${encodePath(path)}`)
  if (!r.ok) throw await asError(r)
  return r.json()
}

/** Every comment in the Space (for the sidebar "Comments" tab). Gated
 *  server-side on comment permission; read-only shares get a 403. */
export async function listAllComments(): Promise<Comment[]> {
  const r = await fetch(`${API}/all-comments`)
  if (!r.ok) throw await asError(r)
  return r.json()
}

export async function getForm(folder: string): Promise<FormData> {
  const r = await fetch(`${API}/form/${encodePath(folder)}`)
  if (!r.ok) throw await asError(r)
  return r.json()
}

export async function submitForm(folder: string, values: Record<string, unknown>): Promise<FormEntry> {
  const r = await fetch(`${API}/form/${encodePath(folder)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  })
  if (!r.ok) throw await asError(r)
  return r.json()
}

/** Upload one image attachment for a form (comment/edit guests); returns its
 * stored path. Gated server-side like submission, not full file writes. */
export async function uploadFormImage(folder: string, blob: Blob): Promise<string> {
  const r = await fetch(`${API}/form-upload/${encodePath(folder)}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  })
  if (!r.ok) throw await asError(r)
  return (await r.json() as { path: string }).path
}

export async function postComment(
  path: string,
  text: string,
  opts: { parentID?: string; anchor?: CommentAnchor } = {},
): Promise<Comment> {
  const r = await fetch(`${API}/comments/${encodePath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      parent_id: opts.parentID,
      anchor: opts.anchor,
    }),
  })
  if (!r.ok) throw await asError(r)
  return r.json()
}

/** Direct URL for downloading or rendering a file via <img>/<iframe> on the
 * share side. Encodes path components individually so slashes survive. */
export function fileURLForShare(path: string): string {
  return `${API}/file/${encodePath(path)}`
}

// ---- server-side TTS (read-aloud studio voice) ----
export type ServerVoice = { id: string; label: string; lang: string }

export async function ttsInfo(): Promise<{ available: boolean; voices: ServerVoice[] }> {
  const r = await fetch(`${API}/tts/info`)
  if (!r.ok) throw await asError(r)
  return r.json()
}

/** Audio URL for one chunk; deterministic + immutable so the browser caches it. */
export function ttsURL(voiceId: string, text: string, style?: string): string {
  return `${API}/tts?voice=${encodeURIComponent(voiceId)}&text=${encodeURIComponent(text)}` +
    (style ? `&style=${encodeURIComponent(style)}` : '')
}

export async function searchSpace(q: string, glob?: string): Promise<GrepMatch[]> {
  const params = new URLSearchParams({ q })
  if (glob) params.set('glob', glob)
  const r = await fetch(`${API}/search?${params.toString()}`)
  if (!r.ok) throw await asError(r)
  return r.json()
}
