/**
 * The plaintext-Space transport the assistant writes through.
 *
 * Identical to the folder sync's {@link httpPlaintextTransport} except that
 * every state-changing request carries `X-Notation-Actor: ai`, so the server
 * commits it under an `ai:` author and the page history tells the assistant's
 * edits from the owner's own. (A zero-knowledge Space goes through EncryptedFS
 * instead and sends no such marker: the server learning "an AI changed
 * something" would be metadata it has no need for.)
 */
import { getCSRF } from '../auth'
import * as api from '../api'
import type { PlaintextTransport } from '../syncSpace'

function encodePath(p: string): string {
  return p.normalize('NFC').split('/').filter(Boolean).map(encodeURIComponent).join('/')
}

async function send(url: string, init: RequestInit): Promise<void> {
  const headers = new Headers(init.headers)
  headers.set('X-Notation-Actor', 'ai')
  const csrf = getCSRF()
  if (csrf) headers.set('X-CSRF-Token', csrf)
  const r = await fetch(url, { ...init, headers, credentials: 'same-origin' })
  if (r.status === 401) window.dispatchEvent(new CustomEvent('notation:auth-expired'))
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const j = await r.json()
      if (j?.error) msg = j.error
    } catch { /* not JSON */ }
    throw Object.assign(new Error(msg), { status: r.status })
  }
}

export function aiPlaintextTransport(spaceID: string): PlaintextTransport {
  const base = `/api/admin/spaces/${encodeURIComponent(spaceID)}`
  return {
    listFiles: () => api.listFilesFlat(spaceID),
    pruneEmptyDirs: () => api.pruneEmptyDirs(spaceID).then(r => r.removed),
    listTree: () => api.getTree(spaceID),
    // no-store: the assistant must see the page as it is now, never a cached
    // copy from before someone (or itself) changed it.
    readBytes: async (path) => {
      const r = await fetch(api.fileURL(spaceID, path), { credentials: 'same-origin', cache: 'no-store' })
      if (!r.ok) throw Object.assign(new Error(r.status === 404 ? `${path} does not exist` : `HTTP ${r.status}`), { status: r.status })
      return new Uint8Array(await r.arrayBuffer())
    },
    writeBytes: (path, bytes) => send(`${base}/file/${encodePath(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Blob([bytes as BlobPart]),
    }),
    renamePath: (from, to) => send(`${base}/rename/${encodePath(from)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    }),
    deleteFile: (path) => send(`${base}/file/${encodePath(path)}`, { method: 'DELETE' }),
  }
}
