/**
 * Instance settings for the assistant, and the API key hand-off.
 *
 * The key lives on the server (0600, or in the environment) so it follows the
 * owner across devices. The browser fetches it into MEMORY ONLY — never
 * localStorage, never IndexedDB — the first time a chat needs it, and drops it
 * on an authentication failure or a settings change. That is the same posture
 * as the Space key: present while the page is in use, gone with the tab.
 */
import { getCSRF } from '../auth'

export interface AISettings {
  enabled: boolean
  configured: boolean
  key_source: '' | 'env' | 'settings'
  key_hint?: string
  default_model: string
  default_effort: string
  instructions: string
  skills_space: string
}

export interface AISettingsUpdate {
  api_key?: string
  default_model?: string
  default_effort?: string
  instructions?: string
  skills_space?: string
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'GET') {
    const csrf = getCSRF()
    if (csrf) headers.set('X-CSRF-Token', csrf)
  }
  const r = await fetch(url, { ...init, headers, credentials: 'same-origin', cache: 'no-store' })
  if (r.status === 401) window.dispatchEvent(new CustomEvent('notation:auth-expired'))
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const j = await r.json()
      if (j?.error) msg = j.error
    } catch { /* not JSON */ }
    throw Object.assign(new Error(msg), { status: r.status })
  }
  if (r.status === 204) return undefined as T
  return r.json() as Promise<T>
}

export const getAISettings = () => call<AISettings>('/api/admin/ai/settings')

export async function saveAISettings(u: AISettingsUpdate): Promise<AISettings> {
  const res = await call<AISettings>('/api/admin/ai/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(u),
  })
  // A new (or removed) key must not be shadowed by the one already in memory.
  if (u.api_key !== undefined) forgetSessionKey()
  return res
}

let keyPromise: Promise<string> | null = null

/** The API key for this page session, fetched once and held in memory. */
export function sessionKey(): Promise<string> {
  if (!keyPromise) {
    keyPromise = call<{ api_key: string }>('/api/admin/ai/key', { method: 'POST' })
      .then(r => r.api_key)
      .catch(e => { keyPromise = null; throw e })
  }
  return keyPromise
}

/** Drop the in-memory key (after a 401 from the API, or a settings change). */
export function forgetSessionKey(): void {
  keyPromise = null
}

let available: Promise<boolean> | null = null

/**
 * Whether this instance offers the assistant at all (NOTATION_AI_DISABLED
 * turns the endpoints into 404s). Asked once per page load.
 */
export function aiAvailable(): Promise<boolean> {
  if (!available) {
    available = getAISettings()
      .then(s => s.enabled)
      .catch(e => {
        const status = (e as { status?: number })?.status
        if (status !== 404) available = null // transient: ask again next time
        return false
      })
  }
  return available
}
