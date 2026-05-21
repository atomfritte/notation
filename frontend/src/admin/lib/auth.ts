// Auth state-machine + WebAuthn ceremony helpers. The backend's
// /api/auth/state endpoint drives which screen the AuthGate shows; the
// helpers below wrap fetch + @simplewebauthn/browser into a small surface
// that the screens call.

import { startAuthentication, startRegistration } from '@simplewebauthn/browser'

export type AuthState = {
  signed_in: boolean
  needs_claim: boolean
  needs_passkey_setup: boolean
  has_passkeys: boolean
  rp_id: string
  auth_mode: 'session' | 'authelia' | 'both'
  csrf_token?: string
  user?: string
}

export type Passkey = {
  id: string
  label: string
  created_at: string
  last_used?: string
}

// ---- CSRF token management ------------------------------------------------
//
// The CSRF token lives in the signed session cookie's payload but cookies
// are HttpOnly so the client can't read it directly. /api/auth/state returns
// the token for the *current* session as a JSON field; we mirror that into
// module-level state and api.ts attaches it to every state-changing fetch.

let csrf: string | null = null

export function getCSRF(): string | null {
  return csrf
}

export function setCSRF(token: string | null): void {
  csrf = token
}

// ---- Endpoints ------------------------------------------------------------

async function jsonOrThrow(r: Response) {
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const j = await r.json()
      if (j?.error) msg = j.error
    } catch { /* ignore */ }
    throw Object.assign(new Error(msg), { status: r.status })
  }
  if (r.status === 204) return undefined
  return r.json()
}

export async function fetchState(): Promise<AuthState> {
  const s = (await jsonOrThrow(await fetch('/api/auth/state'))) as AuthState
  setCSRF(s.csrf_token ?? null)
  return s
}

export async function claim(token: string): Promise<void> {
  await jsonOrThrow(
    await fetch('/api/auth/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  )
}

export async function logout(): Promise<void> {
  await jsonOrThrow(
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
    }),
  )
  setCSRF(null)
}

// ---- WebAuthn ceremonies --------------------------------------------------

export async function registerPasskey(label: string): Promise<void> {
  const beginRes = await fetch('/api/auth/passkey/register/begin', {
    method: 'POST',
    headers: csrf ? { 'X-CSRF-Token': csrf } : {},
  })
  // @simplewebauthn/browser v11 expects `{ optionsJSON: ... }`; the server
  // sends the inner PublicKey object directly so we wrap here.
  const optionsJSON = await jsonOrThrow(beginRes)
  const credential = await startRegistration({ optionsJSON })
  await jsonOrThrow(
    await fetch('/api/auth/passkey/register/finish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: JSON.stringify({ label, credential }),
    }),
  )
}

export async function loginWithPasskey(): Promise<void> {
  const beginRes = await fetch('/api/auth/passkey/login/begin', { method: 'POST' })
  const optionsJSON = await jsonOrThrow(beginRes)
  const credential = await startAuthentication({ optionsJSON })
  await jsonOrThrow(
    await fetch('/api/auth/passkey/login/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credential),
    }),
  )
}

export async function listPasskeys(): Promise<Passkey[]> {
  return (await jsonOrThrow(await fetch('/api/auth/passkeys'))) as Passkey[]
}

export async function deletePasskey(id: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
    }),
  )
}
