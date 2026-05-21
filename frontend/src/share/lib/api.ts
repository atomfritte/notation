export type Permission = 'read' | 'comment' | 'edit'

export type SpaceInfo = {
  space: { id: string; name: string }
  permission: Permission
  label: string
}

export type Entry = {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: string
  children?: Entry[]
}

export type Comment = {
  id: string
  path: string
  created_at: string
  author: string
  text: string
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
  return new Error(msg)
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

export async function postComment(path: string, text: string): Promise<Comment> {
  const r = await fetch(`${API}/comments/${encodePath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!r.ok) throw await asError(r)
  return r.json()
}
