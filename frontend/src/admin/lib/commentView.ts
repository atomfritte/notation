/**
 * commentView — "am I looking at comments, or at everything?"
 *
 * An emoji reaction is stored as a comment with an `emoji` and no text, which
 * makes it a first-class annotation of a passage — but listing it among written
 * comments by default would bury them. So the panels filter, and this is the
 * one place that decides how.
 *
 * The preference is shared: the per-file column and the space-wide sidebar tab
 * are often open at once, and flipping one while the other disagrees looks
 * broken. Persisted like the other UI preferences, and broadcast so every
 * mounted panel re-renders without threading state through the tree.
 */
import { useEffect, useState } from 'react'

export type CommentFilter = 'comments' | 'all'

const KEY = 'notation_comment_filter'
export const COMMENT_FILTER_EVENT = 'notation:comment-filter-change'

export function getCommentFilter(): CommentFilter {
  try {
    return localStorage.getItem(KEY) === 'all' ? 'all' : 'comments'
  } catch {
    return 'comments'
  }
}

export function setCommentFilter(v: CommentFilter): void {
  try { localStorage.setItem(KEY, v) } catch { /* private mode — in-memory only */ }
  window.dispatchEvent(new CustomEvent(COMMENT_FILTER_EVENT, { detail: v }))
}

/** The current filter, kept in step with every other panel on screen. */
export function useCommentFilter(): [CommentFilter, (v: CommentFilter) => void] {
  const [filter, setLocal] = useState<CommentFilter>(getCommentFilter)
  useEffect(() => {
    const onChange = (e: Event) => setLocal((e as CustomEvent).detail as CommentFilter)
    window.addEventListener(COMMENT_FILTER_EVENT, onChange)
    return () => window.removeEventListener(COMMENT_FILTER_EVENT, onChange)
  }, [])
  return [filter, setCommentFilter]
}

/** Drop reactions unless the reader asked to see them. */
export function applyCommentFilter<T extends { emoji?: string }>(items: T[], filter: CommentFilter): T[] {
  return filter === 'all' ? items : items.filter(c => !c.emoji)
}
