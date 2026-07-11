/**
 * keyStore — the session-only lifecycle for unlocked space keys.
 *
 * It maps `spaceId -> KeyHandle` for every space the user has unlocked this
 * session. The handles wrap a non-extractable AES-GCM CryptoKey (see the
 * security note on {@link KeyHandle}); they live in this module's memory ONLY.
 *
 * SECURITY POLICY — read before extending:
 *   - NOTHING here is ever written to localStorage, sessionStorage, IndexedDB,
 *     cookies, or any other persistence. A page reload wipes the map, so an
 *     encrypted space must be re-unlocked from its password / recovery key.
 *   - {@link lockAll} is called on logout so a shared machine never keeps a key
 *     alive past the session.
 *   - future: move the handles into a dedicated Web Worker so the main-thread
 *     JS context can't be scraped for a live CryptoKey reference. An in-memory
 *     non-extractable CryptoKey on the main thread is the acceptable baseline.
 */
import { useSyncExternalStore } from 'react'
import type { KeyHandle } from '../../shared/crypto/keys'

const handles = new Map<string, KeyHandle>()
const listeners = new Set<() => void>()

// A monotonically increasing version is the useSyncExternalStore snapshot: it
// changes on every lock/unlock so subscribed components re-render, without ever
// exposing the (secret) handles as the snapshot value.
let version = 0

function emit(): void {
  version++
  for (const l of listeners) l()
}

/** True if `spaceId` currently has an unlocked key in memory. */
export function isUnlocked(spaceId: string): boolean {
  return handles.has(spaceId)
}

/** The unlocked handle for `spaceId`, or `undefined` if locked. */
export function get(spaceId: string): KeyHandle | undefined {
  return handles.get(spaceId)
}

/** Store an unlocked handle (e.g. right after create or a successful unlock). */
export function set(spaceId: string, handle: KeyHandle): void {
  handles.set(spaceId, handle)
  emit()
}

/** Re-lock one space: drop its handle so it is garbage-collected. */
export function lock(spaceId: string): void {
  if (handles.delete(spaceId)) emit()
}

/** Lock every space. Called on logout. */
export function lockAll(): void {
  if (handles.size > 0) {
    handles.clear()
    emit()
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Subscribe a component to lock/unlock changes. The returned number is opaque —
 * read {@link isUnlocked}/{@link get} in render; this only forces a re-render
 * when the set of unlocked spaces changes.
 */
export function useKeyStoreVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}
