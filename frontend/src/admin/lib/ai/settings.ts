/**
 * Instance settings for the assistant, and the API key hand-off.
 *
 * The key is stored on the server SEALED under the owner's chat password (see
 * keySeal.ts), so it follows them across devices without the server — or a
 * backup of it — being able to read it. The browser fetches the sealed record,
 * opens it with the password and holds the key in MEMORY ONLY (keyMemory.ts):
 * gone with the tab, on sign-out, or on "Lock".
 *
 * Two other sources exist: NOTATION_ANTHROPIC_API_KEY on the server (the
 * operator's choice; no password then), and a plaintext key left by an older
 * version ("legacy"), which the chat asks to protect with a password before it
 * is used again.
 */
import { getCSRF } from '../auth'
import { heldKey, holdKey, lockAIKey } from './keyMemory'
import { checkApiKey, MIN_PASSWORD_LEN, openApiKey, sealApiKey, type SealedKey } from './keySeal'

export type KeySource = '' | 'env' | 'sealed' | 'legacy'

export interface AISettings {
  enabled: boolean
  configured: boolean
  key_source: KeySource
  key_hint?: string
  default_model: string
  default_effort: string
  instructions: string
  skills_space: string
}

export interface AISettingsUpdate {
  sealed_key?: SealedKey
  clear_key?: boolean
  default_model?: string
  default_effort?: string
  instructions?: string
  skills_space?: string
}

interface KeyMaterial {
  source: Exclude<KeySource, ''>
  api_key?: string
  sealed_key?: SealedKey
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
  return call<AISettings>('/api/admin/ai/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(u),
  })
}

const fetchKeyMaterial = () => call<KeyMaterial>('/api/admin/ai/key', { method: 'POST' })

/**
 * Where the key stands for this tab:
 *   none     — no key configured
 *   ready    — usable now (unlocked, or from the server environment)
 *   locked   — sealed; the chat password opens it
 *   legacy   — stored unencrypted by an older version; needs a password first
 */
export type KeyState = 'none' | 'ready' | 'locked' | 'legacy'

export function keyState(s: AISettings | null): KeyState {
  if (!s?.configured) return 'none'
  if (s.key_source === 'env') return 'ready'
  if (s.key_source === 'legacy') return 'legacy'
  // An unlocked key from before a key change elsewhere doesn't count.
  const h = heldKey()
  return h && h.hint === s.key_hint ? 'ready' : 'locked'
}

/** Thrown by {@link sessionKey} when the key needs the chat password first. */
export class KeyLockedError extends Error {
  constructor(readonly state: 'locked' | 'legacy') {
    super(state === 'legacy' ? 'Protect your API key with a chat password first.' : 'Unlock the assistant with your chat password.')
  }
}

let envKey: Promise<string> | null = null

/** The API key for this tab. Throws {@link KeyLockedError} until it's unlocked. */
export async function sessionKey(): Promise<string> {
  const h = heldKey()
  if (h) return h.key
  if (!envKey) {
    envKey = fetchKeyMaterial().then((m) => {
      if (m.source === 'env' && m.api_key) return m.api_key
      throw new KeyLockedError(m.source === 'legacy' ? 'legacy' : 'locked')
    })
    envKey.catch(() => { envKey = null })
  }
  return envKey
}

/** The API rejected the key (401): don't keep offering it. */
export function forgetSessionKey(): void {
  envKey = null
}

/** Open the sealed key with the chat password and hold it for this tab. */
export async function unlockKey(password: string): Promise<void> {
  const m = await fetchKeyMaterial()
  if (m.source === 'env') return
  if (m.source !== 'sealed' || !m.sealed_key) throw new KeyLockedError('legacy')
  const key = await openApiKey(m.sealed_key, password) // throws WrongPasswordError
  holdKey(key, m.sealed_key.hint)
}

export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LEN) return `Use at least ${MIN_PASSWORD_LEN} characters.`
  if (password !== confirm) return 'The passwords don’t match.'
  return null
}

/**
 * Seal a key under a (new) chat password and store it, replacing whatever was
 * there — the plaintext legacy copy included. `apiKey` omitted means "the key
 * this tab already has": the unlocked one (changing the password) or the
 * legacy plaintext one (protecting it).
 */
export async function protectKey(password: string, apiKey?: string): Promise<AISettings> {
  let key = apiKey?.trim()
  if (!key) {
    key = heldKey()?.key
    if (!key) {
      const m = await fetchKeyMaterial()
      if (m.source !== 'legacy' || !m.api_key) throw new Error('Unlock the key first, or paste it again.')
      key = m.api_key
    }
  }
  const bad = checkApiKey(key)
  if (bad) throw new Error(bad)
  const sealed = await sealApiKey(key, password)
  const res = await saveAISettings({ sealed_key: sealed })
  forgetSessionKey()
  holdKey(key, sealed.hint)
  return res
}

/** Remove the stored key. */
export async function removeKey(): Promise<AISettings> {
  const res = await saveAISettings({ clear_key: true })
  forgetSessionKey()
  lockAIKey()
  return res
}

export { lockAIKey as lockKey }

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
