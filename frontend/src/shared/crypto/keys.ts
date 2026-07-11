/**
 * Space key model — the main-thread view.
 *
 * A space is protected by a single random 256-bit **DEK** that encrypts all
 * content. The DEK is never derived from the password; it is *wrapped* under one
 * or more **KEKs** (one from the password via Argon2id, one from a printable
 * recovery key). But NONE of that secret material lives here: on the main thread
 * a space's key is only an opaque {@link KeyHandle} — a `slotId` naming a DEK
 * that lives inside the key worker (see {@link ./keyCore} / {@link ./keyBackend}).
 *
 * SECURITY POLICY — read before extending:
 *   - A {@link KeyHandle} carries NO key bytes and NO CryptoKey. It is just a
 *     slot id; the CryptoKey it names is non-extractable and lives in the worker
 *     heap, unreachable from the main thread.
 *   - The handle is valid ONLY for the unlocked session. Locking a space drops
 *     the worker slot ({@link ./keyBackend} `drop`) and forgets the handle.
 *   - This library NEVER persists any key material to storage of any kind.
 *
 * The DEK-wrap primitives ({@link wrapDEK} et al.) and {@link generateDEK} are
 * re-exported from {@link ./frame} for callers/tests that build wraps directly;
 * in the app they run only inside the key engine.
 */
import { getKeyBackend } from './keyBackend'

export {
  generateDEK,
  wrapDEK,
  unwrapDEK,
  rewrapDEK,
  type WrappedKey,
} from './frame'

/**
 * Session-only handle to a space's unlocked key. It exposes ONLY a `slotId`; the
 * DEK/CryptoKey it refers to lives in the key worker, never here.
 */
export interface KeyHandle {
  readonly slotId: string
}

/** A content key accepted by the blob API — a session {@link KeyHandle}. */
export type ContentKey = KeyHandle

/** Normalise a {@link ContentKey} to the worker slot id that names its DEK. */
export function resolveContentKey(key: ContentKey): string {
  return key.slotId
}

/**
 * Adopt raw DEK bytes into a worker slot and return the opaque handle. The DEK
 * is handed to the key backend, which imports it non-extractable and holds it in
 * the worker; the caller should discard the raw `dek` bytes after this returns.
 *
 * The production create/unlock flows do NOT go through here — they generate or
 * unwrap the DEK entirely inside the worker so no raw DEK ever touches the main
 * thread. This is the bootstrap/test seam for building a handle from a known DEK.
 */
export async function importContentKey(dek: Uint8Array): Promise<KeyHandle> {
  const { slotId } = await getKeyBackend().importDEK(dek)
  return { slotId }
}
