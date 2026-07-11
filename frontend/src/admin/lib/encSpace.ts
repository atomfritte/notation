/**
 * encSpace — the admin app's glue between {@link EncryptedFS} and the
 * path-based UI (FileTree + SpaceView).
 *
 *   - {@link getActorId} mints/returns a stable per-device CRDT actor id.
 *   - {@link openEncryptedFS} constructs+loads an {@link EncryptedFS} over the
 *     real {@link HttpEncStore} using an unlocked session handle.
 *   - {@link fsToEntries} projects the encrypted filesystem's node set into the
 *     exact {@link api.Entry} shape the FileTree already renders, so the tree
 *     UI is identical whether a space is plaintext or encrypted.
 */
import { EncryptedFS } from '../../shared/vfs/encfs'
import { HttpEncStore } from '../../shared/vfs/httpEncStore'
import { ROOT_ID, type Node } from '../../shared/vfs/nodes'
import type { KeyHandle } from '../../shared/crypto/keys'
import type { Entry } from './api'

// The actor id is a CRDT tiebreaker only — NOT a secret. It is persisted under
// a non-secret localStorage key so every op this device issues sorts
// deterministically against other devices editing the same space.
const ACTOR_ID_KEY = 'notation_actor_id'

/** Stable, non-secret per-device CRDT actor id (16 random bytes as hex). */
export function getActorId(): string {
  let id = localStorage.getItem(ACTOR_ID_KEY)
  if (!id || !/^[0-9a-f]{8,64}$/.test(id)) {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(ACTOR_ID_KEY, id)
  }
  return id
}

/** Open (construct + load the op-log for) an EncryptedFS for a space. */
export function openEncryptedFS(spaceId: string, handle: KeyHandle): Promise<EncryptedFS> {
  return EncryptedFS.open(new HttpEncStore(spaceId), handle, getActorId())
}

/**
 * Project the encrypted filesystem's visible node set into the nested
 * {@link Entry} tree the FileTree renders. Ordering mirrors the plaintext
 * server tree (files before subfolders, then case-insensitive by name) so the
 * two experiences look identical.
 */
export function fsToEntries(fs: EncryptedFS): Entry[] {
  const childrenOf = new Map<string, Node[]>()
  for (const n of fs.tree()) {
    const arr = childrenOf.get(n.parentId)
    if (arr) arr.push(n)
    else childrenOf.set(n.parentId, [n])
  }

  const build = (parentId: string, parentPath: string): Entry[] => {
    const kids = (childrenOf.get(parentId) ?? []).slice().sort((a, b) => {
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? 1 : -1
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    })
    return kids.map((n) => {
      const path = parentPath ? `${parentPath}/${n.name}` : n.name
      if (n.type === 'dir') {
        return { name: n.name, path, is_dir: true, size: 0, modified: '', children: build(n.nodeId, path) }
      }
      return { name: n.name, path, is_dir: false, size: 0, modified: '' }
    })
  }
  return build(ROOT_ID, '')
}
