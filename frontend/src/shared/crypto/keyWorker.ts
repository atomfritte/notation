/**
 * keyWorker — the Web Worker that owns all secret key material.
 *
 * It is a thin transport shell around {@link ./keyCore}: receive a
 * {@link KeyRequest}, run it through {@link handleKeyRequest} (which holds the
 * DEK/KEK and the imported CryptoKeys in THIS worker's heap), post the result
 * back. The DEK, KEK, and CryptoKey objects therefore never exist in the
 * main-thread heap — only slot ids and op results cross the boundary.
 *
 * Bundled as a module worker (see {@link ./keyBackend} `WorkerKeyBackend`), so
 * hash-wasm (Argon2id) and WebCrypto load with ordinary ESM imports here.
 */
import { handleKeyRequest, type KeyRequest } from './keyCore'

// `self` is typed as a DOM WindowOrWorkerGlobalScope under the app's tsconfig
// (no WebWorker lib, to avoid clashing with the DOM lib the app already uses);
// narrow it to just the worker surface we touch.
const ctx = self as unknown as {
  onmessage: ((e: { data: { id: number; req: KeyRequest } }) => void) | null
  postMessage: (message: unknown) => void
}

ctx.onmessage = async (e) => {
  const { id, req } = e.data
  try {
    const result = await handleKeyRequest(req)
    ctx.postMessage({ id, ok: true, result })
  } catch (err) {
    // Serialize the failure so the main thread can re-raise a faithful error —
    // a wrong password/recovery key comes through as its original GCM-tag error.
    const error = (err as { message?: string })?.message || String(err)
    const errorName = (err as { name?: string })?.name
    ctx.postMessage({ id, ok: false, error, errorName })
  }
}
