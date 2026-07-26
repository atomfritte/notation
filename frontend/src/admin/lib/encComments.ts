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
    emoji: c.emoji,
  }
}

/** Visible comments for one file node, in the UI shape (creation order). */
export function fileComments(fs: EncryptedFS, nodeId: string): CommentItem[] {
  return fs.commentsForNode(nodeId).map(toCommentItem)
}

/**
 * Every visible comment in the space as {@link AllCommentItem}, resolving each
 * comment's nodeId to its current path.
 *
 * A comment whose node no longer resolves (deleted, or re-created as a fresh
 * node elsewhere) is kept and marked `orphan` instead of being dropped: the
 * thread still exists, it just has nothing to open, and silently hiding it is
 * how annotations quietly disappear. `path` then carries the last name we know —
 * the trashed node still has its name, though not its place in the tree — which
 * is also what the repair UI matches against.
 */
export function allComments(fs: EncryptedFS): AllCommentItem[] {
  const out: AllCommentItem[] = []
  const names = new Map(fs.allNodes().map((n) => [n.nodeId, n.name]))
  for (const c of fs.comments()) {
    const path = fs.pathOf(c.nodeId)
    if (path) out.push({ ...toCommentItem(c), path, node_id: c.nodeId })
    else out.push({ ...toCommentItem(c), path: names.get(c.nodeId) ?? '(deleted page)', node_id: c.nodeId, orphan: true })
  }
  return out
}

/**
 * Move a whole thread from one file node to another — the encrypted counterpart
 * of the server's comment relocation, used to repair comments stranded by a
 * delete-and-recreate.
 *
 * The op-log has no "re-anchor" op (a comment's nodeId is written once, at add
 * time), so this re-adds each comment under `toNodeId` keeping its author, time,
 * anchor and emoji, then tombstones the originals. Top-level comments are
 * re-added first so replies can point at their new parent id; deleting the old
 * top-level entries cascades to the old replies. Comment ids change — nothing
 * outside the log holds on to them. Returns how many were moved.
 */
export async function reattachComments(fs: EncryptedFS, fromNodeId: string, toNodeId: string): Promise<number> {
  if (fromNodeId === toNodeId) return 0
  const thread = fs.comments().filter((c) => c.nodeId === fromNodeId)
  if (thread.length === 0) return 0
  const tops = thread.filter((c) => !c.parentId)
  const replies = thread.filter((c) => c.parentId)
  const remap = new Map<string, string>()

  for (const c of tops) {
    const added = await fs.addComment(toNodeId, {
      text: c.text,
      author: c.author,
      anchor: c.anchor,
      emoji: c.emoji,
      createdAt: c.createdAt,
    })
    remap.set(c.id, added.id)
  }
  for (const c of replies) {
    const parentId = c.parentId ? remap.get(c.parentId) : undefined
    if (!parentId) continue // parent didn't come along → the reply has nothing to hang on
    await fs.addComment(toNodeId, {
      text: c.text,
      author: c.author,
      parentId,
      createdAt: c.createdAt,
    })
  }
  // Cascade takes the replies with each top-level entry.
  for (const c of tops) await fs.deleteComment(c.id)
  for (const c of replies) if (!remap.has(c.parentId ?? '')) await fs.deleteComment(c.id)
  return thread.length
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
