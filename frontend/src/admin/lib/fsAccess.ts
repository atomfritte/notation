/**
 * fsAccess — thin, typed wrappers over the File System Access API bits that
 * lib.dom doesn't (fully) type: the directory picker and per-handle permission
 * grants. Kept out of {@link folderSync} so that engine stays pure and fakeable.
 *
 * These calls only work in a secure context (https / localhost) from a real user
 * gesture, and only in Chromium-family browsers today. Everything degrades
 * gracefully: {@link folderSyncSupported} gates the UI so unsupported browsers
 * never see a broken button.
 */

/** Permission states a `FileSystemHandle` can report. */
type PermissionState = 'granted' | 'denied' | 'prompt'

interface PermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

// The permission methods are a separate spec addition not always in lib.dom.
interface HandleWithPermission {
  queryPermission?(desc?: PermissionDescriptor): Promise<PermissionState>
  requestPermission?(desc?: PermissionDescriptor): Promise<PermissionState>
}

interface DirectoryPickerWindow {
  showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite'; id?: string }): Promise<FileSystemDirectoryHandle>
}

/** True when this browser can open a directory picker (Chromium, secure ctx). */
export function folderSyncSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function'
}

/**
 * Prompt the user to pick a directory (readwrite). MUST be called from a user
 * gesture. Returns `null` if the user cancels the native dialog.
 */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker
  if (!picker) throw new Error('This browser does not support folder access.')
  try {
    return await picker({ mode: 'readwrite', id: 'notation-folder-sync' })
  } catch (e) {
    // The user pressing Cancel rejects with an AbortError — treat as no-pick.
    if (e instanceof DOMException && e.name === 'AbortError') return null
    throw e
  }
}

/**
 * Ensure we hold `readwrite` permission on a handle, requesting it if needed
 * (the request MUST come from a user gesture). Returns whether it is granted.
 */
export async function ensureReadWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as unknown as HandleWithPermission
  const desc: PermissionDescriptor = { mode: 'readwrite' }
  if (h.queryPermission) {
    if ((await h.queryPermission(desc)) === 'granted') return true
  }
  if (h.requestPermission) {
    return (await h.requestPermission(desc)) === 'granted'
  }
  // No permission API (older impls): assume the handle is still usable.
  return true
}

/** Query (without prompting) whether we still hold readwrite permission. */
export async function hasReadWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as unknown as HandleWithPermission
  if (!h.queryPermission) return true
  try {
    return (await h.queryPermission({ mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}
