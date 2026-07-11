/**
 * keyBackend — the transport in front of the {@link ./keyCore} key engine.
 *
 * The rest of the app talks to keys ONLY through this backend, by opaque
 * `slotId`. Two transports implement the SAME crypto (keyCore); only how a
 * request reaches keyCore differs:
 *
 *   - {@link WorkerKeyBackend} — posts to a dedicated module Web Worker, so the
 *     DEK/KEK and the imported CryptoKeys live in the WORKER heap, never the
 *     main-thread heap. This is what the browser uses.
 *   - {@link InProcessKeyBackend} — calls {@link handleKeyRequest} directly. Used
 *     by the test runner (jsdom/node has no Web Worker) and as a safe fallback.
 *     It is the exact same keyCore code the worker runs, so tests exercise the
 *     real encrypt/decrypt/wrap path, just without the postMessage hop.
 *
 * The public crypto API ({@link ./space}, {@link ./blob}) is unchanged; it just
 * resolves a {@link KeyHandle} to its `slotId` and routes here.
 */
import { handleKeyRequest, type KeyRequest, type KeyResult, type SpaceKeyRecord } from './keyCore'
import type { KdfParams } from './kdf'

/** The slot-oriented key operations every backend exposes. */
export interface KeyBackend {
  createSpace(password: string, kdf?: KdfParams): Promise<{ record: SpaceKeyRecord; recoveryDisplay: string; slotId: string }>
  unlockPassword(record: SpaceKeyRecord, password: string): Promise<{ slotId: string }>
  unlockRecovery(record: SpaceKeyRecord, display: string): Promise<{ slotId: string }>
  changePassword(record: SpaceKeyRecord, oldPassword: string, newPassword: string): Promise<SpaceKeyRecord>
  /** Adopt raw DEK bytes into a slot (bootstrap / test seam). */
  importDEK(dek: Uint8Array): Promise<{ slotId: string }>
  encrypt(slotId: string, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>
  decrypt(slotId: string, blob: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>
  /** Forget a slot's key material (lock / logout). */
  drop(slotId: string): Promise<void>
}

/**
 * Shared method surface implemented in terms of a single {@link send}. The two
 * transports differ ONLY in `send`, so the request→result mapping (and its type
 * discipline) lives in exactly one place.
 */
abstract class BaseKeyBackend implements KeyBackend {
  protected abstract send(req: KeyRequest): Promise<KeyResult>

  async createSpace(password: string, kdf?: KdfParams) {
    const r = await this.send({ op: 'createSpace', password, kdf })
    if (r.op !== 'createSpace') throw unexpected(r)
    return { record: r.record, recoveryDisplay: r.recoveryDisplay, slotId: r.slotId }
  }

  async unlockPassword(record: SpaceKeyRecord, password: string) {
    return { slotId: slotOf(await this.send({ op: 'unlockPassword', record, password })) }
  }

  async unlockRecovery(record: SpaceKeyRecord, display: string) {
    return { slotId: slotOf(await this.send({ op: 'unlockRecovery', record, display })) }
  }

  async changePassword(record: SpaceKeyRecord, oldPassword: string, newPassword: string) {
    const r = await this.send({ op: 'changePassword', record, oldPassword, newPassword })
    if (r.op !== 'record') throw unexpected(r)
    return r.record
  }

  async importDEK(dek: Uint8Array) {
    return { slotId: slotOf(await this.send({ op: 'importDEK', dek })) }
  }

  async encrypt(slotId: string, plaintext: Uint8Array, aad?: Uint8Array) {
    return bytesOf(await this.send({ op: 'encrypt', slotId, plaintext, aad }))
  }

  async decrypt(slotId: string, blob: Uint8Array, aad?: Uint8Array) {
    return bytesOf(await this.send({ op: 'decrypt', slotId, blob, aad }))
  }

  async drop(slotId: string) {
    await this.send({ op: 'drop', slotId })
  }
}

function unexpected(r: KeyResult): Error {
  return new Error(`key backend: unexpected response ${r.op}`)
}
function slotOf(r: KeyResult): string {
  if (r.op !== 'slot') throw unexpected(r)
  return r.slotId
}
function bytesOf(r: KeyResult): Uint8Array {
  if (r.op !== 'bytes') throw unexpected(r)
  return r.bytes
}

/** In-process transport: run keyCore directly. Same code the worker runs. */
export class InProcessKeyBackend extends BaseKeyBackend {
  protected send(req: KeyRequest): Promise<KeyResult> {
    return handleKeyRequest(req)
  }
}

/** Worker transport: keyCore runs in a dedicated module Web Worker. */
export class WorkerKeyBackend extends BaseKeyBackend {
  private readonly worker: Worker
  private seq = 0
  private readonly pending = new Map<number, { resolve: (r: KeyResult) => void; reject: (e: Error) => void }>()

  constructor() {
    super()
    // Vite bundles the referenced module as a separate worker chunk; `type:
    // 'module'` lets hash-wasm + WebCrypto load with normal ESM imports inside it.
    this.worker = new Worker(new URL('./keyWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { id: number; ok: boolean; result?: KeyResult; error?: string; errorName?: string }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok && msg.result) p.resolve(msg.result)
      else {
        // Re-raise the worker-side failure faithfully so callers that inspect it
        // (e.g. the unlock screen's wrong-password detection) still see a matching
        // message/name — a wrong password surfaces as the same GCM-tag error.
        const err = new Error(msg.error || msg.errorName || 'key worker error')
        if (msg.errorName) err.name = msg.errorName
        p.reject(err)
      }
    }
    this.worker.onerror = () => {
      const err = new Error('key worker crashed')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    }
  }

  protected send(req: KeyRequest): Promise<KeyResult> {
    const id = ++this.seq
    return new Promise<KeyResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, req })
    })
  }
}

// ── the app-wide singleton ───────────────────────────────────────────────────

let backend: KeyBackend | null = null

/** True in a real browser main thread with module-worker support (not the test runner). */
function canUseWorker(): boolean {
  try {
    // Vitest / Vite set MODE to 'test' under the runner — force the in-process path.
    if ((import.meta as unknown as { env?: { MODE?: string } }).env?.MODE === 'test') return false
  } catch {
    /* import.meta.env not available — fall through to the capability check */
  }
  // jsdom (and most Node) define no global Worker, so tests land on InProcess.
  return typeof Worker !== 'undefined' && typeof window !== 'undefined'
}

function createDefaultBackend(): KeyBackend {
  if (canUseWorker()) {
    try {
      return new WorkerKeyBackend()
    } catch {
      /* worker spawn failed — degrade to in-process rather than break crypto */
    }
  }
  return new InProcessKeyBackend()
}

/** The process-wide key backend, lazily created on first use. */
export function getKeyBackend(): KeyBackend {
  if (!backend) backend = createDefaultBackend()
  return backend
}

/** Override the backend (tests / bootstrap). Pass null to reset to the default. */
export function setKeyBackend(b: KeyBackend | null): void {
  backend = b
}
