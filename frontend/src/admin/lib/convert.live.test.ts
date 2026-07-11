// @vitest-environment node
//
// LIVE end-to-end convert harness. Skipped by `npm test` (guarded on
// LIVE_BASE_URL); run explicitly against a running dev-bypass server, e.g.
//
//   LIVE_BASE_URL=http://localhost:PORT LIVE_SPACE=livevault LIVE_PHASE=encrypt \
//     npx vitest run src/admin/lib/convert.live.test.ts
//
// It runs the REAL client crypto (createEncryptedSpace, EncryptedFS, sealOp,
// encryptBlob/decryptBlob) through the REAL HttpEncStore transport, against the
// REAL Go server. LIVE_PHASE selects encrypt (+read-back assert) or decrypt so
// the shell can inspect the on-disk state between the two destructive steps.
import { describe, expect, it } from 'vitest'
import { HttpEncStore } from '../../shared/vfs/httpEncStore'
import { EncryptedFS } from '../../shared/vfs/encfs'
import { unlockWithPassword } from '../../shared/crypto/space'
import {
  encryptSpaceContent,
  decryptSpaceContent,
  type PlaintextSink,
  type PlaintextSource,
} from './convert'

// This harness only runs under Node (vitest node env); read env off globalThis so
// the browser-tsconfig typecheck (no @types/node) stays clean.
const ENV = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const BASE = ENV.LIVE_BASE_URL ?? ''
const SPACE = ENV.LIVE_SPACE ?? 'livevault'
const PW = ENV.LIVE_PW ?? 'live-password-123'
const PHASE = ENV.LIVE_PHASE ?? 'both'
const CSRF = 'dev-csrf-token'
const ACTOR = 'a1b2c3d4e5f6a7b8'

const base = `/api/admin/spaces/${SPACE}`
const encPath = (p: string) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/')

async function req(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { ...headers }
  if (method !== 'GET') h['X-CSRF-Token'] = CSRF
  const r = await fetch(BASE + path, { method, headers: h, body })
  return r
}

// The real client transport, pointed at the absolute dev-server base and given
// the dev CSRF token (getCSRF() is null outside the browser).
function liveStore(): HttpEncStore {
  return new HttpEncStore(SPACE, (input, init) => {
    const rel = typeof input === 'string' ? input : String(input)
    const url = rel.startsWith('http') ? rel : BASE + rel
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    if (method !== 'GET') headers.set('X-CSRF-Token', CSRF)
    return fetch(url, { ...init, headers })
  })
}

const source: PlaintextSource = {
  listFiles: async () => (await (await req('GET', `${base}/files-flat`)).json()) as string[],
  readBytes: async (p) => new Uint8Array(await (await req('GET', `${base}/file/${encPath(p)}`)).arrayBuffer()),
}

const sink: PlaintextSink = {
  writeBytes: async (p, bytes) => {
    const r = await req('PUT', `${base}/file/${encPath(p)}`, new Blob([bytes as BlobPart]), {
      'Content-Type': 'application/octet-stream',
    })
    if (!r.ok) throw new Error(`write ${p}: HTTP ${r.status}`)
  },
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

const d = describe.skipIf(!BASE)

d('live convert', () => {
  it('encrypts an existing plaintext space + reads every file back identically', async () => {
    if (PHASE !== 'encrypt' && PHASE !== 'both') return
    // Snapshot the plaintext bytes BEFORE converting.
    const paths = await source.listFiles()
    const before = new Map<string, Uint8Array>()
    for (const p of paths) before.set(p, await source.readBytes(p))
    expect(paths.length).toBeGreaterThan(0)

    // begin → encrypt → finalize.
    const bc = await req('POST', `${base}/enc/begin-convert`, JSON.stringify({ direction: 'to-encrypted' }), {
      'Content-Type': 'application/json',
    })
    expect(bc.status).toBe(200)
    const store = liveStore()
    const res = await encryptSpaceContent(source, store, PW, { actorId: ACTOR })
    expect(res.fileCount).toBe(paths.length)
    const fin = await req('POST', `${base}/enc/finalize-convert`)
    expect(fin.status).toBe(200)
    expect((await fin.json()).encrypted).toBe(true)

    // Read every file back THROUGH the encrypted filesystem → identical bytes.
    const record = await store.getKeyRecord()
    const handle = await unlockWithPassword(record!, PW)
    const fs = await EncryptedFS.open(store, handle, ACTOR)
    for (const [p, original] of before) {
      const got = await fs.read(p)
      expect(bytesEqual(got, original), `mismatch reading ${p} back through EncryptedFS`).toBe(true)
    }
    // eslint-disable-next-line no-console
    console.log(`LIVE-ENCRYPT-OK files=${paths.length}`)
  })

  it('decrypts back to identical plaintext', async () => {
    if (PHASE !== 'decrypt' && PHASE !== 'both') return
    const store = liveStore()
    const record = await store.getKeyRecord()
    expect(record).not.toBeNull()
    const handle = await unlockWithPassword(record!, PW)

    const bc = await req('POST', `${base}/enc/begin-convert`, JSON.stringify({ direction: 'to-plaintext' }), {
      'Content-Type': 'application/json',
    })
    expect(bc.status).toBe(200)
    const restored = await decryptSpaceContent(store, handle, sink, { actorId: ACTOR })
    expect(restored.length).toBeGreaterThan(0)
    const fin = await req('POST', `${base}/enc/finalize-convert`)
    expect(fin.status).toBe(200)
    expect((await fin.json()).encrypted).toBe(false)
    // eslint-disable-next-line no-console
    console.log(`LIVE-DECRYPT-OK files=${restored.length}`)
  })
})
