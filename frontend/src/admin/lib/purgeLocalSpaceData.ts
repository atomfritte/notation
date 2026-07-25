/**
 * purgeLocalSpaceData — erase every CLEARTEXT client-side trace of one space.
 *
 * Encrypting an existing space rewrites the server side (the plaintext files are
 * purged and git is re-initialised) but the browser keeps working on the same
 * space id, so everything the plaintext mode had written locally would survive:
 *
 *   - the opt-in offline copy — **full plaintext file bodies**, the cleartext
 *     tree JSON and comments, in the Cache API,
 *   - bookmarks, the new-page registry, read-aloud position, scroll positions
 *     and the collapsed-folder map — all keyed by, or holding, cleartext paths.
 *
 * Encrypted mode never reads those values (they no longer resolve), so nothing
 * overwrites them: the user believes the space is zero-knowledge while a stolen
 * browser profile still yields the pre-conversion structure — and, if offline
 * sync was ever enabled, the pre-conversion content. This wipes all of it.
 *
 * Best-effort by design: a failure here must never break the conversion, which
 * has already succeeded on the server by the time we run.
 */
import { unsyncSpace } from './offlineSync'
import { clearFolder } from './folderHandleStore'

/** localStorage keys written per space, as `<prefix><spaceID>`. */
const EXACT_KEY_PREFIXES = [
  'notation_bookmarks_',
  'notation_new_pages_',
  'notation_readpos_',
  'notation_tree_collapsed_',
]

/** Keys written as `notation_scroll_<spaceID>__<file>` — matched by prefix. */
const SCROLL_PREFIX = 'notation_scroll_'

export async function purgeLocalSpaceData(spaceID: string): Promise<void> {
  if (!spaceID) return

  // 1. The offline copy + its synthesised audio (the big one: real content).
  try { await unsyncSpace(spaceID) } catch { /* best-effort */ }

  // 2. Per-space localStorage entries, including the path-suffixed scroll keys.
  try {
    for (const prefix of EXACT_KEY_PREFIXES) localStorage.removeItem(prefix + spaceID)
    const scrollPrefix = `${SCROLL_PREFIX}${spaceID}__`
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      // The key ITSELF carries the cleartext path here, so prefix-match it.
      if (key && key.startsWith(scrollPrefix)) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch { /* private mode / quota — best-effort */ }

  // 3. The picked local-sync folder handle + its manifest (path -> hash of the
  //    plaintext bytes) in IndexedDB.
  try { await clearFolder(spaceID) } catch { /* best-effort */ }

  // The in-memory body cache needs no sweep: it is a plain Map that dies with
  // the tab, and encrypted mode never reads it (bodies come from the FS).
}
