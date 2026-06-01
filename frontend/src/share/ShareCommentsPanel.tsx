import { useMemo } from 'react'
import { MessageSquare, FileText } from 'lucide-react'
import type { Comment } from './lib/api'
import { stripMdExt } from '../admin/components/MarkdownView'

type Props = {
  comments: Comment[]
  /** Currently-open file, so its group highlights. */
  currentFile: string
  /** Open a file and optionally focus a specific comment. */
  onSelect: (path: string, commentID?: string) => void
}

/**
 * ShareCommentsPanel — guest-facing sidebar view of every comment in the
 * Space, grouped by page (mirrors the admin AllCommentsPanel but read-only:
 * guests can read + jump to comments, deletion stays an admin action). Clicking
 * a page opens it; clicking a comment opens it and scrolls to its anchor.
 */
export function ShareCommentsPanel({ comments, currentFile, onSelect }: Props) {
  const groups = useMemo(() => {
    const byPath = new Map<string, Comment[]>()
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

  if (groups.length === 0) {
    return (
      <p className="p-3 text-xs text-[var(--notation-fg-muted)] italic">
        No comments yet. Select text on a page and click “Comment” to start one.
      </p>
    )
  }

  return (
    <div className="space-y-3 p-1">
      <div className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--notation-fg-muted)]">
        {comments.length} comment{comments.length === 1 ? '' : 's'} across {groups.length} page{groups.length === 1 ? '' : 's'}
      </div>
      {groups.map(g => (
        <section key={g.path}>
          <button
            onClick={() => onSelect(g.path)}
            title={g.path}
            className={
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-semibold transition-colors ' +
              (g.path === currentFile
                ? 'bg-[var(--notation-border)] text-[var(--notation-fg)]'
                : 'text-[var(--notation-fg)] hover:bg-[var(--notation-border)]')
            }
          >
            <FileText size={14} className="flex-shrink-0 opacity-70" />
            <span className="truncate flex-1 text-left">{stripMdExt(g.path)}</span>
            <span className="text-[10px] font-bold text-[color:var(--notation-accent)] bg-[color:var(--notation-accent-15)] px-1.5 py-0.5 rounded-full">
              {g.total}
            </span>
          </button>
          <ul className="pl-2 mt-1 space-y-1.5">
            {g.tops.map(c => {
              const replies = g.repliesByParent[c.id] ?? 0
              return (
                <li key={c.id}>
                  <button
                    onClick={() => onSelect(c.path, c.id)}
                    className="w-full text-left p-2 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)] hover:border-[color:var(--notation-accent-40)] transition-colors"
                  >
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <span className="font-semibold text-xs text-[var(--notation-fg)] truncate">{c.author}</span>
                      <span className="text-[10px] text-[var(--notation-fg-muted)] flex-shrink-0">{formatRelative(c.created_at)}</span>
                    </div>
                    {c.anchor?.quote && (
                      <div className="text-[11px] text-[var(--notation-fg-muted)] italic line-clamp-1 mb-1 border-l-2 border-[var(--notation-border)] pl-1.5">
                        {c.anchor.quote}
                      </div>
                    )}
                    <p className="text-xs text-[var(--notation-fg)] whitespace-pre-wrap line-clamp-3">{c.text}</p>
                    {replies > 0 && (
                      <div className="mt-1 text-[10px] text-[var(--notation-fg-muted)] flex items-center gap-1">
                        <MessageSquare size={9} /> {replies} repl{replies === 1 ? 'y' : 'ies'}
                      </div>
                    )}
                  </button>
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
