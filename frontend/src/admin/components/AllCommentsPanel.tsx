import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, FileText, Trash2, FileQuestion, CornerDownRight, Search } from 'lucide-react'
import * as api from '../lib/api'
import { applyCommentFilter, type CommentFilter } from '../lib/commentView'
import type { Candidate, OrphanGroup } from '../lib/commentTargets'

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
  /** Comments-vs-everything switcher; omit to hide it. */
  filter?: CommentFilter
  onFilterChange?: (v: CommentFilter) => void
  /**
   * Every file path the space currently holds. A comment group whose file isn't
   * in here lost its target — it gets the "moved or deleted" treatment instead
   * of a link into nothing. Omit (or pass an empty set) to switch that off,
   * e.g. while the tree is still loading.
   */
  existingPaths?: Set<string>
  /** Find likely new homes for a stranded thread (see {@link ../lib/commentTargets}). */
  resolveTargets?: (group: OrphanGroup) => Promise<Candidate[]>
  /** Re-file a stranded thread onto the picked file. */
  onRelocate?: (group: OrphanGroup, target: string) => Promise<void>
}

/**
 * AllCommentsPanel — sidebar view of every comment in the Space, grouped
 * by file path. Each comment card shows the author, a relative timestamp,
 * the anchored quote (if any), and the comment body. Clicking the row
 * navigates to the file. The delete control mirrors the inline thread.
 */
export function AllCommentsPanel({
  spaceID, currentFile, onSelectFile, refreshKey = 0, items, onDeleteComment,
  filter = 'comments', onFilterChange, existingPaths, resolveTargets, onRelocate,
}: Props) {
  // Encrypted spaces pass `items` (client-side); plaintext spaces fetch here.
  const clientMode = items !== undefined
  const [fetched, setFetched] = useState<api.AllCommentItem[]>([])
  const [loading, setLoading] = useState(!clientMode)
  const [err, setErr] = useState<string | null>(null)
  // Reactions are annotations of a passage too; the switcher decides whether
  // they are listed here or only the written comments are. (An encrypted space
  // passes an already-filtered list, so this is a no-op there.)
  const comments = applyCommentFilter(clientMode ? items : fetched, filter)

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

  // Group: file → list of top-level comments (replies hidden under their parent
  // count). Keyed by node id where we have one (an encrypted space), so two
  // deleted pages that happened to share a filename don't merge into one group.
  // Sort groups by most-recent-comment first; within a group, newest first too.
  const groups = useMemo(() => {
    const byFile = new Map<string, api.AllCommentItem[]>()
    for (const c of comments) {
      const key = c.node_id ?? c.path
      const list = byFile.get(key) ?? []
      list.push(c)
      byFile.set(key, list)
    }
    const out = Array.from(byFile.entries()).map(([key, list]) => {
      const sorted = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at))
      const tops = sorted.filter(c => !c.parent_id)
      const repliesByParent: Record<string, number> = {}
      for (const c of sorted) {
        if (c.parent_id) repliesByParent[c.parent_id] = (repliesByParent[c.parent_id] ?? 0) + 1
      }
      const path = list[0].path
      // "Gone" is only knowable once we've been handed the space's file set;
      // until then every group is treated as fine (no false alarms on load).
      const missing = Boolean(list[0].orphan || (existingPaths && existingPaths.size > 0 && !existingPaths.has(path)))
      return {
        key,
        path,
        nodeId: list[0].node_id,
        missing,
        tops,
        repliesByParent,
        total: list.length,
        newest: sorted[0]?.created_at ?? '',
      }
    })
    out.sort((a, b) => b.newest.localeCompare(a.newest))
    return out
  }, [comments, existingPaths])

  if (loading && comments.length === 0) {
    return <div className="p-4 text-xs text-[var(--notation-fg-muted)] italic">Loading…</div>
  }
  if (err) {
    return <div className="p-4 text-xs text-[var(--notation-danger)]">Error: {err}</div>
  }
  if (groups.length === 0) {
    return (
      <div className="p-2 space-y-2">
        {onFilterChange && (
          <div className="flex justify-end px-2 pt-1"><FilterSwitch value={filter} onChange={onFilterChange} /></div>
        )}
        <p className="px-2 text-xs text-[var(--notation-fg-muted)] italic">
          {filter === 'comments' ? 'No comments anywhere in this Space yet.' : 'Nothing anywhere in this Space yet.'}
        </p>
      </div>
    )
  }

  return (
    <div className="p-2 space-y-3">
      <div className="flex items-center justify-between gap-2 px-2 pt-1">
        {/* Compact so it stays on one line next to the switcher. */}
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--notation-fg-muted)] truncate">
          {comments.length} {filter === 'all' ? 'total' : comments.length === 1 ? 'comment' : 'comments'}
          {' · '}
          {groups.length} page{groups.length === 1 ? '' : 's'}
        </div>
        {onFilterChange && <FilterSwitch value={filter} onChange={onFilterChange} />}
      </div>
      {groups.map(g => (
        <section key={g.key}>
          <button
            onClick={() => { if (!g.missing) onSelectFile(g.path) }}
            className={
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-semibold transition-colors ' +
              (g.missing
                ? 'text-[var(--notation-fg-muted)] cursor-default'
                : g.path === currentFile
                  ? 'bg-[var(--notation-border)] text-[var(--notation-fg)]'
                  : 'text-[var(--notation-fg)] hover:bg-[var(--notation-border)]')
            }
            title={g.missing ? `${g.path} — no longer in this Space` : g.path}
          >
            {g.missing
              ? <FileQuestion size={14} className="flex-shrink-0 text-[var(--notation-warning)]" />
              : <FileText size={14} className="flex-shrink-0 opacity-70" />}
            <span className={'truncate flex-1 text-left' + (g.missing ? ' line-through decoration-1' : '')}>
              {g.path.replace(/\.md$/i, '')}
            </span>
            <span className="text-[10px] font-bold text-[color:var(--notation-accent)] bg-[color:var(--notation-accent-15)] px-1.5 py-0.5 rounded-full">
              {g.total}
            </span>
          </button>
          {g.missing && (
            <MissingTarget
              group={{ path: g.path, nodeId: g.nodeId, comments: comments.filter(c => (c.node_id ?? c.path) === g.key) }}
              resolveTargets={resolveTargets}
              onRelocate={onRelocate}
              onOpen={onSelectFile}
            />
          )}
          <ul className="pl-2 mt-1 space-y-1.5">
            {g.tops.map(c => {
              const replies = g.repliesByParent[c.id] ?? 0
              return (
                <li key={c.id}>
                  <div
                    className="group rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg-alt)] hover:border-[color:var(--notation-accent-40)] transition-colors"
                  >
                    <button
                      onClick={() => { if (!g.missing) onSelectFile(c.path, c.id) }}
                      className={'w-full text-left p-2' + (g.missing ? ' cursor-default' : '')}
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
                      {c.emoji ? (
                      <p className="text-xs text-[var(--notation-fg-muted)] flex items-center gap-1.5">
                        <span className="text-base leading-none" aria-hidden="true">{c.emoji}</span>
                        <span>reacted</span>
                      </p>
                    ) : (
                    <p className="text-xs text-[var(--notation-fg)] whitespace-pre-wrap line-clamp-3">
                        {c.text}
                      </p>
                    )}
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

/**
 * The repair strip under a group whose file is gone: says so plainly, then goes
 * looking for where the page went and offers what it found.
 *
 * The search runs by itself, once per group — being told "this page is gone" and
 * having to press a button to learn anything more is exactly the dead end this
 * replaces. Re-attaching is one click and reversible (the thread can be moved
 * again), so nothing here needs a confirmation dialog.
 */
function MissingTarget({
  group, resolveTargets, onRelocate, onOpen,
}: {
  group: OrphanGroup
  resolveTargets?: (g: OrphanGroup) => Promise<Candidate[]>
  onRelocate?: (g: OrphanGroup, target: string) => Promise<void>
  onOpen: (path: string) => void
}) {
  const [state, setState] = useState<'idle' | 'searching' | 'done'>('idle')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current || !resolveTargets) return
    ran.current = true
    let live = true
    setState('searching')
    resolveTargets(group)
      .then(list => { if (live) { setCandidates(list); setState('done') } })
      .catch(e => { if (live) { setErr(String(e)); setState('done') } })
    return () => { live = false }
  }, [group, resolveTargets])

  async function relocate(path: string) {
    if (!onRelocate) return
    setBusy(path)
    setErr(null)
    try {
      await onRelocate(group, path)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-1 ml-2 rounded-md border border-[color:var(--notation-warning)] bg-[color:var(--notation-warning)]/10 p-2">
      <p className="text-[11px] text-[var(--notation-fg)] leading-snug">
        This page was <strong>moved or deleted</strong> — the comments below have nothing to open.
      </p>
      {state === 'searching' && (
        <p className="mt-1 text-[11px] text-[var(--notation-fg-muted)] flex items-center gap-1.5">
          <Search size={11} className="animate-pulse" /> Looking for where it went…
        </p>
      )}
      {state === 'done' && candidates.length === 0 && (
        <p className="mt-1 text-[11px] text-[var(--notation-fg-muted)]">
          No likely match in this Space. Delete the comments below if the page is gone for good.
        </p>
      )}
      {candidates.length > 0 && (
        <>
          <p className="mt-1.5 mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--notation-fg-muted)]">
            Might be
          </p>
          <ul className="space-y-1.5">
            {candidates.map(c => (
              <li key={c.path}>
                {/* The sidebar is narrow, so the folder truncates and the
                    filename — the part that identifies the page — always
                    survives in full. */}
                <button
                  onClick={() => onOpen(c.path)}
                  className="w-full flex items-baseline min-w-0 text-[11px] font-mono hover:underline"
                  title={`Open ${c.path}`}
                >
                  {c.path.includes('/') && (
                    <span className="truncate min-w-0 text-[var(--notation-fg-muted)]">
                      {c.path.slice(0, c.path.lastIndexOf('/') + 1)}
                    </span>
                  )}
                  <span className="flex-shrink-0 text-[var(--notation-fg)]">
                    {c.path.slice(c.path.lastIndexOf('/') + 1)}
                  </span>
                </button>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--notation-fg-muted)]">
                    {reasonLabel(c)}
                  </span>
                  {onRelocate && (
                    <button
                      onClick={() => void relocate(c.path)}
                      disabled={busy !== null}
                      title="Move these comments onto that page"
                      className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] text-[var(--notation-fg)] hover:border-[color:var(--notation-accent-40)] disabled:opacity-40 transition-colors"
                    >
                      <CornerDownRight size={10} />
                      {busy === c.path ? 'Moving…' : 'Move here'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {err && <p className="mt-1 text-[11px] text-[var(--notation-danger)]">{err}</p>}
    </div>
  )
}

/** Why a candidate was offered — the confidence, in words, kept short enough
 *  to survive the sidebar's width next to the button. */
function reasonLabel(c: Candidate): string {
  if (c.reason === 'quote') return 'contains the quote'
  if (c.reason === 'name') return 'same name, elsewhere'
  // score is half the name similarity for this tier — report the similarity.
  return `similar name · ${Math.round(c.score * 200)}%`
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

/** Comments-only vs. comments + reactions. Mirrors the thread panel's switch. */
function FilterSwitch({ value, onChange }: { value: CommentFilter; onChange: (v: CommentFilter) => void }) {
  const btn = (v: CommentFilter, label: string, title: string) => (
    <button
      onClick={() => onChange(v)}
      title={title}
      aria-pressed={value === v}
      className={
        'px-2 py-0.5 rounded transition-colors ' +
        (value === v
          ? 'bg-[var(--notation-bg-elevated)] text-[var(--notation-fg)] shadow-sm'
          : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]')
      }
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-0.5 text-[11px] font-medium rounded-md border border-[var(--notation-border)] p-0.5 flex-shrink-0">
      {btn('comments', 'Comments', 'Written comments only')}
      {btn('all', 'All', 'Comments and emoji reactions')}
    </div>
  )
}
