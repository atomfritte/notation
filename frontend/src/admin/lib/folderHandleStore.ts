/**
 * folderHandleStore — per-space persistence for the local-folder-sync feature.
 *
 * A `FileSystemDirectoryHandle` is a live, structured-cloneable object that can
 * NOT be serialized to localStorage, but CAN be stored in IndexedDB. We keep it
 * (plus the last-sync manifest mirror) per space so a returning user doesn't
 * re-pick their folder — they only re-grant permission with one click. This is
 * NON-secret metadata: the handle is just a pointer to a directory, and the
 * manifest is a `path -> hash` map. The encryption key is NEVER stored here.
 */
import type { ManifestEntries } from './folderSync'

const DB_NAME = 'notation-folder-sync'
const DB_VERSION = 1
const STORE = 'spaces'

/** One persisted row: the picked handle + the last-sync manifest, per space. */
export interface FolderSyncRecord {
  spaceId: string
  handle: FileSystemDirectoryHandle
  manifest?: ManifestEntries
  updatedAt?: string
}

/** IndexedDB may be unavailable (SSR / some test runners) — degrade to no-op. */
function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'spaceId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        t.oncomplete = () => db.close()
      }),
  )
}

/** The saved record for a space, or `null` if none / IndexedDB unavailable. */
export async function getFolderRecord(spaceId: string): Promise<FolderSyncRecord | null> {
  if (!idbAvailable()) return null
  try {
    const row = await tx<FolderSyncRecord | undefined>('readonly', (s) => s.get(spaceId))
    return row ?? null
  } catch {
    return null
  }
}

/** Remember (or replace) the picked directory handle for a space. */
export async function setFolderHandle(spaceId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  if (!idbAvailable()) return
  const existing = await getFolderRecord(spaceId)
  const record: FolderSyncRecord = {
    spaceId,
    handle,
    // A new handle means a new folder — its old manifest no longer applies.
    manifest: existing && existing.handle === handle ? existing.manifest : undefined,
    updatedAt: new Date().toISOString(),
  }
  try {
    await tx('readwrite', (s) => s.put(record))
  } catch {
    /* best-effort persistence */
  }
}

/** Mirror the last-sync manifest for a space (kept alongside the folder copy). */
export async function setManifest(spaceId: string, manifest: ManifestEntries): Promise<void> {
  if (!idbAvailable()) return
  const existing = await getFolderRecord(spaceId)
  if (!existing) return
  try {
    await tx('readwrite', (s) => s.put({ ...existing, manifest, updatedAt: new Date().toISOString() }))
  } catch {
    /* best-effort */
  }
}

/** Forget a space's folder + manifest (used when the user disconnects it). */
export async function clearFolder(spaceId: string): Promise<void> {
  if (!idbAvailable()) return
  try {
    await tx('readwrite', (s) => s.delete(spaceId))
  } catch {
    /* ignore */
  }
}
