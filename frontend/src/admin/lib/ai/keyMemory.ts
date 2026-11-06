/**
 * The unlocked Claude API key, in memory only.
 *
 * Same posture as the Space keys (lib/keyStore.ts): never localStorage,
 * sessionStorage, IndexedDB or a cookie. A reload, a sign-out or "Lock" wipes
 * it, and the chat password is needed again. Kept free of imports so the
 * sign-out path (lib/auth.ts) can lock it without an import cycle.
 */
import { useSyncExternalStore } from 'react'

let held: { key: string; hint: string } | null = null
let version = 0
const listeners = new Set<() => void>()

function emit() {
  version++
  for (const l of listeners) l()
}

export function heldKey(): { key: string; hint: string } | null {
  return held
}

export function holdKey(key: string, hint: string): void {
  held = { key, hint }
  emit()
}

/** Forget the key (Lock, sign-out, a key change). */
export function lockAIKey(): void {
  if (held) {
    held = null
    emit()
  }
}

/** Re-renders on lock/unlock. The snapshot is a counter, never the key. */
export function useKeyMemory(): number {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    () => version,
  )
}
