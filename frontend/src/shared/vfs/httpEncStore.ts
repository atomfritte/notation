/**
 * HttpEncStore — the real {@link EncStore}, talking to the Phase 3a blind
 * endpoints under `/api/admin/spaces/{id}/enc/*`.
 *
 * It reuses the admin app's CSRF mechanism exactly as `admin/lib/api.ts` does:
 * the token from {@link getCSRF} is attached as `X-CSRF-Token` on every
 * state-changing request (PUT/POST/DELETE), and omitted on reads. This module
 * is deliberately separate from {@link EncStore}/{@link InMemoryEncStore} so the
 * pure-library core (and its tests) never pulls in the auth/WebAuthn surface.
 */
import { getCSRF } from '../../admin/lib/auth'
import type { EncStore, StoredOp } from './encStore'
import type { SpaceKeyRecord } from '../crypto/space'
import type { KdfParams } from '../crypto/kdf'

// ---- base64 (byte <-> string) --------------------------------------------

function b64encode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---- SpaceKeyRecord <-> JSON wire shape -----------------------------------
//
// The record's byte fields (salt + two wrapped DEKs) are base64 on the wire so
// it is plain JSON. The server stores it verbatim (it only checks json.Valid),
// so the client owns this shape end-to-end.

interface WireKeyRecord {
  version: number
  kdf: KdfParams
  kdfSalt: string
  wrappedByPassword: string
  wrappedByRecovery: string
}

export function keyRecordToWire(r: SpaceKeyRecord): WireKeyRecord {
  return {
    version: r.version,
    kdf: r.kdf,
    kdfSalt: b64encode(r.kdfSalt),
    wrappedByPassword: b64encode(r.wrappedByPassword),
    wrappedByRecovery: b64encode(r.wrappedByRecovery),
  }
}

export function keyRecordFromWire(w: WireKeyRecord): SpaceKeyRecord {
  return {
    version: w.version,
    kdf: w.kdf,
    kdfSalt: b64decode(w.kdfSalt),
    wrappedByPassword: b64decode(w.wrappedByPassword),
    wrappedByRecovery: b64decode(w.wrappedByRecovery),
  }
}

const RAW = 'application/octet-stream'

// TS 5.7+ types a plain `Uint8Array` as `Uint8Array<ArrayBufferLike>`, which the
// DOM `BodyInit` union doesn't accept directly; the cast mirrors the crypto
// core's `buf` helper in aesgcm.ts. At runtime a Uint8Array is a valid fetch body.
const asBody = (bytes: Uint8Array): BodyInit => bytes as unknown as BodyInit

export class HttpEncStore implements EncStore {
  private readonly doFetch: typeof fetch

  constructor(
    private readonly spaceId: string,
    doFetch?: typeof fetch,
  ) {
    // A bare `fetch` reference invoked as `this.doFetch(...)` runs with `this`
    // bound to the store, which the DOM rejects ("Illegal invocation" — fetch
    // must be called on the global). Wrap it so the receiver is always correct;
    // an injected fetch (tests) is used verbatim.
    this.doFetch = doFetch ?? ((input, init) => fetch(input, init))
  }

  private base(): string {
    return `/api/admin/spaces/${encodeURIComponent(this.spaceId)}/enc`
  }

  /** Attach CSRF the way api.ts does: header on state-changing methods only. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrf = getCSRF()
      if (csrf) headers.set('X-CSRF-Token', csrf)
    }
    return this.doFetch(url, { credentials: 'same-origin', ...init, headers })
  }

  private static async fail(r: Response): Promise<never> {
    let msg = `HTTP ${r.status}`
    try {
      const j = await r.json()
      if (j?.error) msg = j.error
    } catch {
      /* ignore */
    }
    throw Object.assign(new Error(msg), { status: r.status })
  }

  async getBlob(id: string): Promise<Uint8Array | null> {
    const r = await this.send(`${this.base()}/blob/${id}`, {})
    if (r.status === 404) return null
    if (!r.ok) return HttpEncStore.fail(r)
    return new Uint8Array(await r.arrayBuffer())
  }

  async putBlob(id: string, bytes: Uint8Array): Promise<void> {
    const r = await this.send(`${this.base()}/blob/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': RAW },
      body: asBody(bytes),
    })
    if (!r.ok) await HttpEncStore.fail(r)
  }

  async deleteBlob(id: string): Promise<void> {
    const r = await this.send(`${this.base()}/blob/${id}`, { method: 'DELETE' })
    if (!r.ok && r.status !== 404) await HttpEncStore.fail(r)
  }

  async appendOp(opId: string, sealedBytes: Uint8Array): Promise<{ seq: number }> {
    const r = await this.send(`${this.base()}/ops?opId=${encodeURIComponent(opId)}`, {
      method: 'POST',
      headers: { 'Content-Type': RAW },
      body: asBody(sealedBytes),
    })
    if (!r.ok) return HttpEncStore.fail(r)
    return (await r.json()) as { seq: number }
  }

  async listOps(sinceSeq: number): Promise<StoredOp[]> {
    const r = await this.send(`${this.base()}/ops?since=${sinceSeq}`, {})
    if (!r.ok) return HttpEncStore.fail(r)
    const rows = (await r.json()) as { seq: number; opId: string; blob: string }[]
    return rows.map((row) => ({ seq: row.seq, opId: row.opId, blob: b64decode(row.blob) }))
  }

  async getCheckpoint(): Promise<Uint8Array | null> {
    const r = await this.send(`${this.base()}/checkpoint`, {})
    if (r.status === 404) return null
    if (!r.ok) return HttpEncStore.fail(r)
    return new Uint8Array(await r.arrayBuffer())
  }

  async putCheckpoint(bytes: Uint8Array): Promise<void> {
    const r = await this.send(`${this.base()}/checkpoint`, {
      method: 'PUT',
      headers: { 'Content-Type': RAW },
      body: asBody(bytes),
    })
    if (!r.ok) await HttpEncStore.fail(r)
  }

  async getKeyRecord(): Promise<SpaceKeyRecord | null> {
    const r = await this.send(`${this.base()}/keyrecord`, {})
    if (r.status === 404) return null
    if (!r.ok) return HttpEncStore.fail(r)
    return keyRecordFromWire((await r.json()) as WireKeyRecord)
  }

  async putKeyRecord(record: SpaceKeyRecord): Promise<void> {
    const r = await this.send(`${this.base()}/keyrecord`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(keyRecordToWire(record)),
    })
    if (!r.ok) await HttpEncStore.fail(r)
  }
}
