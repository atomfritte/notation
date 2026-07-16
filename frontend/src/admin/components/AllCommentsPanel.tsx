import { useEffect, useMemo, useState } from 'react'
import { MessageSquare, FileText, Trash2 } from 'lucide-react'
import * as api from '../lib/api'

type Props = {
  spaceID: string
  /** Currently-open file path, so the matching group can highlight. */
  currentFile: string
  /** Open a file (and optionally jump to a comment via #anchor). */
  onSelectFile: (path: string, commentID?: string) => void
  /** Refresh trigger — bump from parent when comments are added/removed
   *  elsewhere so this panel re-fetches. */
  refreshKey?: number
  /** Encrypted spaces have no server comments; the parent supplies them from
   *  the client-side {@link EncryptedFS} instead of this panel fetching. When
   *  set, `onDeleteComment` handles deletion too. */
  items?: api.AllCommentItem[]
  onDeleteComment?: (id: string) => Promise<void>
}

/**
 * AllCommentsPanel — sidebar view of every comment in the Space, grouped
 * by file path. Each comment card shows the author, a relative timestamp,
 * the anchored quote (if any), and the comment body. Clicking the row
 * navigates to the file. The delete control mirrors the inline thread.
 */
export function AllCommentsPanel({ spaceID, currentFile, onSelectFile, refreshKey = 0, items, onDeleteComment }: Props) {
  // Encrypted spaces pass `items` (client-side); plaintext spaces fetch here.
  const clientMode = items !== undefined
  const [fetched, setFetched] = useState<api.AllCommentItem[]>([])
  const [loading, setLoading] = useState(!clientMode)
  const [err, setErr] = useState<string | null>(null)
  const comments = clientMode ? items : fetched

  function reload() {
    if (clientMode) return
    setLoading(true)
    api.getAllComments(spaceID)
      .then(list => {
        setFetched(list || [])
        setErr(null)
      })
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!spaceID || clientMode) return
    reload()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceID, refreshKey, clientMode])

  async function onDelete(id: string) {
    if (!window.confirm('Delete this comment and all replies?')) return
    try {
      if (clientMode) await onDeleteComment?.(id)
      else {
        await api.deleteComment(spaceID, id)
        reload()
      }
    } catch (e) {
      setErr(String(e))
    }
  }

  // Group: file path → list of top-level comments (replies hidden under
  // their parent count). Sort groups by most-recent-comment first; within
  // a group, newest first too.
  const groups = useMemo(() => {
    const byPath = new Map<string, api.AllCommentItem[]>()
    for (const c of comments) {
      const list = byPath.get(c.path) ?? []
      list.push(c)
      byPath.set(c.path, list)
    }
    const out = Array.from(byPath.entries()).map(([path, list]) => {
      const sorted = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at))
      const tops = sorted.filter(c => !c.parent_id)
      const repliesByParent: Record<string, number> = {}
      for (const c of sorted) {
        if (c.parent_id) repliesByParent[c.parent_id] = (repliesByParent[c.parent_id] ?? 0) + 1
      }
      return { path, tops, repliesByParent, total: list.length, newest: sorted[0]?.created_at ?? '' }
    })
    out.sort((a, b) => b.newest.localeCompare(a.newest))
    return out
  }, [comments])

  if (loading && comments.length === 0) {
    return <div className="p-4 text-xs text-[var(--notation-fg-muted)] italic">Loading…</div>
  }
  if (err) {
    return <div className="p-4 text-xs text-[var(--notation-danger)]">Error: {err}</div>
  }
  if (groups.length === 0) {
    return (
      <div className="p-4 text-xs text-[var(--notation-fg-muted)] italic">
        No comments anywhere in this Space yet.
      </div>
    )
  }

  return (
    <div className="p-2 space-y-3">
      <div className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--notation-fg-muted)]">
        {comments.length} comment{comments.length === 1 ? '' : 's'} across {groups.length} page{groups.length === 1 ? '' : 's'}
      </div>
      {groups.map(g => (
        <section key={g.path}>
          <button
            onClick={() => onSelectFile(g.path)}
            className={
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-semibold transition-colors ' +
              (g.path === currentFile
                ? 'bg-[var(--notation-border)] text-[var(--notation-fg)]'
                : 'text-[var(--notation-fg)] hover:bg-[var(--notation-border)]')
            }
            title={g.path}
          >
            <FileText size={14} className="flex-shrink-0 opacity-70" />
            <span className="truncate flex-1 text-left">{g.path.replace(/\.md$/i, '')}</span>
            <span className="text-[10px] font-bold text-[color:var(--notation-accent)] bg-[color:var(--notation-accent-15)] px-1.5 py-0.5 rounded-full">
              {g.total}
            </span>
          </button>
          <ul className="pl-2 mt-1 space-y-1.5">
            {g.tops.map(c => {
              const replies = g.repliesByParent[c.id] ?? 0
              return (
                <li key={c.id}>
                  <div
                    className="group rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)] hover:border-[color:var(--notation-accent-40)] transition-colors"
                  >
                    <button
                      onClick={() => onSelectFile(c.path, c.id)}
                      className="w-full text-left p-2"
                    >
                      <div className="flex items-baseline gap-2 mb-0.5">
                        <span className="font-semibold text-xs text-[var(--notation-fg)] truncate">
                          {c.author}
                        </span>
                        <span className="text-[10px] text-[var(--notation-fg-muted)] flex-shrink-0">
                          {formatRelative(c.created_at)}
                        </span>
                      </div>
                      {c.anchor?.quote && (
                        <div className="text-[11px] text-[var(--notation-fg-muted)] italic line-clamp-1 mb-1 border-l-2 border-[var(--notation-border)] pl-1.5">
                          {c.anchor.quote}
                        </div>
                      )}
                      <p className="text-xs text-[var(--notation-fg)] whitespace-pre-wrap line-clamp-3">
                        {c.text}
                      </p>
                      {replies > 0 && (
                        <div className="mt-1 text-[10px] text-[var(--notation-fg-muted)] flex items-center gap-1">
                          <MessageSquare size={9} /> {replies} repl{replies === 1 ? 'y' : 'ies'}
                        </div>
                      )}
                    </button>
                    <button
                      onClick={() => onDelete(c.id)}
                      title="Delete"
                      className="absolute opacity-0 group-hover:opacity-100 transition-opacity p-1.5 text-[var(--notation-fg-muted)] hover:text-[var(--notation-danger)]"
                      style={{ position: 'relative', float: 'right', marginTop: '-30px', marginRight: '4px' }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = Math.round((Date.now() - t) / 1000)
  if (d < 60) return `${d}s ago`
  if (d < 3600) return `${Math.round(d / 60)}m ago`
  if (d < 86400) return `${Math.round(d / 3600)}h ago`
  return new Date(t).toLocaleDateString()
}
