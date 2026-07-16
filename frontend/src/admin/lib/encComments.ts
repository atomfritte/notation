/**
 * encComments — the admin app's glue between the encrypted comment log
 * ({@link EncryptedFS} + {@link ../../shared/vfs/commentLog}) and the path-based
 * comment UI (CommentThread + AllCommentsPanel).
 *
 * The encrypted log references files by opaque CRDT nodeId; the UI thinks in
 * paths and the snake_case {@link api.CommentItem} shape. These helpers translate
 * between the two, and migrate a plaintext space's comments into the encrypted
 * log during (or after) encryption.
 */
import type { EncryptedFS } from '../../shared/vfs/encfs'
import type { EncComment } from '../../shared/vfs/commentLog'
import type { AllCommentItem, CommentItem } from './api'

/** Project an encrypted comment (nodeId-based) to the UI's CommentItem shape. */
export function toCommentItem(c: EncComment): CommentItem {
  return {
    id: c.id,
    parent_id: c.parentId,
    created_at: c.createdAt,
    author: c.author,
    text: c.text,
    anchor: c.anchor,
  }
}

/** Visible comments for one file node, in the UI shape (creation order). */
export function fileComments(fs: EncryptedFS, nodeId: string): CommentItem[] {
  return fs.commentsForNode(nodeId).map(toCommentItem)
}

/**
 * Every visible comment in the space as {@link AllCommentItem}, resolving each
 * comment's nodeId to its current path. Comments whose file no longer resolves
 * (trashed/orphaned) are dropped from the space-wide view.
 */
export function allComments(fs: EncryptedFS): AllCommentItem[] {
  const out: AllCommentItem[] = []
  for (const c of fs.comments()) {
    const path = fs.pathOf(c.nodeId)
    if (!path) continue
    out.push({ ...toCommentItem(c), path })
  }
  return out
}

/**
 * Migrate plaintext comments (path-based) into the encrypted op-log, resolving
 * each path to a nodeId. Threading is preserved by re-mapping old comment ids to
 * the freshly-minted ones; original authors and timestamps are kept. A comment
 * whose file (or whose parent) no longer resolves is skipped. Returns how many
 * were migrated.
 */
export async function migrateLegacyComments(fs: EncryptedFS, legacy: AllCommentItem[]): Promise<number> {
  // Top-level comments first, so a reply's parent already exists when added.
  const tops = legacy.filter((c) => !c.parent_id)
  const replies = legacy.filter((c) => c.parent_id)
  const remap = new Map<string, { newId: string; nodeId: string }>()
  let migrated = 0

  for (const c of tops) {
    const nodeId = fs.idAt(c.path)
    if (!nodeId) continue // file no longer exists → nothing to anchor to
    const added = await fs.addComment(nodeId, {
      text: c.text,
      author: c.author,
      anchor: c.anchor,
      createdAt: c.created_at,
    })
    remap.set(c.id, { newId: added.id, nodeId })
    migrated++
  }
  for (const c of replies) {
    const parent = c.parent_id ? remap.get(c.parent_id) : undefined
    if (!parent) continue // parent didn't migrate → drop the orphaned reply
    await fs.addComment(parent.nodeId, {
      text: c.text,
      author: c.author,
      parentId: parent.newId,
      createdAt: c.created_at,
    })
    migrated++
  }
  return migrated
}
