/**
 * Node model for the logical (path-independent) filesystem tree.
 *
 * The tree is a set of {@link Node}s linked by `parentId`. Two reserved
 * sentinel ids anchor it: {@link ROOT_ID} for top-level entries and
 * {@link TRASH_ID} for soft-deleted ones. The sentinels are deliberately NOT
 * hex, so they can never collide with a generated (hex) node id.
 */

export type NodeType = 'file' | 'dir'

/** Parent id of top-level nodes. */
export const ROOT_ID = 'root'
/** Parent id under which deleted nodes are soft-collected. */
export const TRASH_ID = 'trash'

export interface Node {
  /** Stable random hex id. */
  nodeId: string
  /** Parent node id, {@link ROOT_ID}, or {@link TRASH_ID}. */
  parentId: string
  /** Display name within its parent. */
  name: string
  type: NodeType
  /** For files: the id of the encrypted content blob. */
  blobId?: string
  /** Lamport timestamp of the Create op. */
  createdAt: number
  /** Lamport timestamp of the most recently applied op. */
  updatedAt: number
  /** True once soft-deleted (reparented under {@link TRASH_ID}). */
  deleted?: boolean
}
