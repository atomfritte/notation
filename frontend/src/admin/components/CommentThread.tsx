import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { MessageSquare, Quote, Trash2 } from 'lucide-react'
import { type CommentFilter } from '../lib/commentView'

export type CommentItem = {
  id: string
  parent_id?: string
  created_at: string
  author: string
  text: string
  anchor?: { quote: string; prefix: string; suffix: string }
  /** Set when this entry is an emoji reaction on a passage, not a written comment. */
  emoji?: string
}

type Props = {
  comments: CommentItem[]
  canAdd: boolean
  initialText?: string
  onAdd?: (text: string, opts?: { parentID?: string }) => Promise<void>
  /** Deleting a comment also removes any replies (server cascades). When
   *  omitted, no delete button is rendered (e.g. read-only share view). */
  onDelete?: (id: string) => Promise<void>
  /** Comment ID currently hovered/highlighted somewhere else (e.g. matching
   *  anchor mark in the viewer). The matching sidebar entry pulses to match. */
  activeID?: string | null
  /** Notify parent when a comment row is hovered, so the viewer can light up
   *  the corresponding anchor mark (highlight only — no scrolling). */
  onHoverComment?: (id: string | null) => void
  /** Notify parent when a comment row is CLICKED. That is the deliberate act
   *  that scrolls the viewer to the anchored passage and keeps it highlighted. */
  onSelectComment?: (id: string) => void
  /** Current comments-vs-everything filter + its setter. Omit to hide the
   *  switcher entirely (the caller then decides what `comments` contains). */
  filter?: CommentFilter
  onFilterChange?: (v: CommentFilter) => void
}

/**
 * CommentThread renders a 2-level threaded list of comments. Top-level entries
 * each have a Reply affordance that opens an inline composer; replies render
 * indented underneath. Anchored comments (with a `quote`) show the quoted
 * snippet so the author of the comment has context even when the original
 * paragraph scrolls out of view.
 */
export function CommentThread({ comments, canAdd, initialText, onAdd, onDelete, activeID, onHoverComment, onSelectComment, filter, onFilterChange }: Props) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<string | null>(null)

  // initialText is set when the editor's selection toolbar triggers a comment.
  useEffect(() => {
    if (initialText) {
      setText(prev => (prev ? prev + '\n\n' + initialText : initialText))
    }
  }, [initialText])

  // Group: parents → replies (sorted by creation time within each group).
  // A reaction is neither: it carries no text and nothing replies to it, so it
  // sits at the top level and renders as its own compact row.
  const { tops, repliesByParent } = useMemo(() => {
    const tops: CommentItem[] = []
    const repliesByParent: Record<string, CommentItem[]> = {}
    for (const c of comments) {
      if (c.parent_id && !c.emoji) {
        ;(repliesByParent[c.parent_id] ??= []).push(c)
      } else {
        tops.push(c)
      }
    }
    return { tops, repliesByParent }
  }, [comments])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || !onAdd) return
    setSubmitting(true)
    setErr(null)
    try {
      await onAdd(text, replyTo ? { parentID: replyTo } : undefined)
      setText('')
      setReplyTo(null)
    } catch (err) {
      setErr(String(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function submitReply(parentID: string, replyText: string) {
    if (!onAdd) return
    await onAdd(replyText, { parentID })
  }

  return (
    <aside className="p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="font-semibold text-sm text-[var(--notation-fg)] flex items-center gap-2">
          Comments
          {comments.length > 0 && (
            <span className="bg-[var(--notation-bg-alt)] text-lime-600 dark:text-[color:var(--notation-accent)] px-2 py-0.5 rounded-full text-xs font-bold">
              {comments.length}
            </span>
          )}
        </h3>
        {filter && onFilterChange && <FilterSwitch value={filter} onChange={onFilterChange} />}
      </div>

      {tops.length === 0 && (
        <p className="text-xs text-[var(--notation-fg-muted)] italic mb-3">
          {filter === 'comments' ? 'No comments yet.' : 'Nothing here yet.'}
        </p>
      )}

      <ul className="space-y-4 mb-4">
        {tops.map(c => (
          <li key={c.id}>
            {c.emoji ? (
              <ReactionRow
                comment={c}
                active={activeID === c.id}
                onDelete={onDelete}
                onHoverComment={onHoverComment}
                onSelectComment={onSelectComment}
              />
            ) : (
            <CommentRow
              comment={c}
              active={activeID === c.id}
              canReply={canAdd}
              onHoverComment={onHoverComment}
              onSelectComment={onSelectComment}
              onReply={canAdd && onAdd ? (text) => submitReply(c.id, text) : undefined}
              onDelete={onDelete}
            />
            )}
            {repliesByParent[c.id]?.length ? (
              <ul className="pl-5 mt-2 border-l-2 border-[var(--notation-border)] space-y-2">
                {repliesByParent[c.id].map(r => (
                  <li key={r.id}>
                    <CommentRow
                      comment={r}
                      active={activeID === r.id}
                      onHoverComment={onHoverComment}
                      onSelectComment={onSelectComment}
                      onDelete={onDelete}
                      compact
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>

      {canAdd && onAdd && !replyTo && (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Add a comment…"
            className="w-full bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] focus:border-lime-500 dark:focus:border-[color:var(--notation-accent)] focus:ring-1 focus:ring-lime-500 dark:focus:ring-[color:var(--notation-accent)] outline-none rounded-md p-2 text-sm text-[var(--notation-fg)] resize-none transition-all"
            rows={2}
            disabled={submitting}
          />
          <button
            type="submit"
            disabled={!text.trim() || submitting}
            className="self-end px-4 py-1.5 bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] font-semibold text-sm rounded-md shadow-sm disabled:opacity-40 hover:bg-[var(--notation-bg-alt)] dark:hover:bg-[#a6d944] transition-colors"
          >
            {submitting ? 'Posting…' : 'Post Comment'}
          </button>
        </form>
      )}
      {err && <p className="text-[var(--notation-danger)] text-xs mt-2">{err}</p>}
    </aside>
  )
}

/**
 * Two-way switch between written comments and everything (comments + emoji
 * reactions). Deliberately tiny — it sits in the panel header, not in the way.
 */
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

/** A reaction: an emoji on a passage, with no body and nothing to reply to. */
function ReactionRow({
  comment, active, onDelete, onHoverComment, onSelectComment,
}: {
  comment: CommentItem
  active: boolean
  onDelete?: (id: string) => Promise<void>
  onHoverComment?: (id: string | null) => void
  onSelectComment?: (id: string) => void
}) {
  const [deleting, setDeleting] = useState(false)
  return (
    <div
      data-comment-id={comment.id}
      onMouseEnter={() => onHoverComment?.(comment.id)}
      onMouseLeave={() => onHoverComment?.(null)}
      onClick={e => {
        if ((e.target as HTMLElement).closest('button')) return
        onSelectComment?.(comment.id)
      }}
      title={onSelectComment && comment.anchor ? 'Jump to the passage' : undefined}
      className={
        'group flex items-start gap-2 rounded-md border p-2 text-sm transition-all ' +
        (active
          ? 'border-[color:var(--notation-accent)] bg-[color:var(--notation-accent-10)]'
          : 'border-[var(--notation-border)] bg-[var(--notation-bg-alt)]') +
        (onSelectComment && comment.anchor ? ' cursor-pointer' : '')
      }
    >
      <span className="text-lg leading-none flex-shrink-0" aria-hidden="true">{comment.emoji}</span>
      <div className="min-w-0 flex-1">
        <div className="flex justify-between text-xs text-[var(--notation-fg-muted)] gap-2">
          <span className="font-semibold text-[var(--notation-fg)] truncate">{comment.author}</span>
          <span className="flex-shrink-0">{new Date(comment.created_at).toLocaleString()}</span>
        </div>
        {comment.anchor?.quote && (
          <div className="text-xs text-[var(--notation-fg-muted)] italic flex items-start gap-1 mt-0.5">
            <Quote size={10} className="mt-0.5 flex-shrink-0 opacity-60" />
            <span className="line-clamp-1">{comment.anchor.quote}</span>
          </div>
        )}
      </div>
      {onDelete && (
        <button
          onClick={async () => {
            if (deleting) return
            if (!window.confirm('Remove this reaction?')) return
            setDeleting(true)
            try { await onDelete(comment.id) } finally { setDeleting(false) }
          }}
          disabled={deleting}
          title="Remove reaction"
          className="opacity-0 group-hover:opacity-100 transition-opacity text-[var(--notation-fg-muted)] hover:text-[var(--notation-danger)] flex-shrink-0 disabled:opacity-40"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  )
}

function CommentRow({
  comment,
  active,
  canReply,
  compact,
  onReply,
  onDelete,
  onHoverComment,
  onSelectComment,
}: {
  comment: CommentItem
  active: boolean
  canReply?: boolean
  compact?: boolean
  onReply?: (text: string) => Promise<void>
  onDelete?: (id: string) => Promise<void>
  onHoverComment?: (id: string | null) => void
  onSelectComment?: (id: string) => void
}) {
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!onReply || !replyText.trim()) return
    setBusy(true)
    try {
      await onReply(replyText)
      setReplyText('')
      setReplyOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-comment-id={comment.id}
      onMouseEnter={() => onHoverComment?.(comment.id)}
      onMouseLeave={() => onHoverComment?.(null)}
      // Clicking anywhere on the row (except its buttons / the reply form)
      // jumps the viewer to the anchored passage and keeps it lit.
      onClick={e => {
        if ((e.target as HTMLElement).closest('button, textarea, form')) return
        onSelectComment?.(comment.id)
      }}
      className={
        'rounded-md border text-sm transition-all ' +
        (active
          ? 'border-[color:var(--notation-accent)] bg-[color:var(--notation-accent)]/5 dark:bg-[color:var(--notation-accent-10)] shadow-sm'
          : 'border-[var(--notation-border)] bg-[var(--notation-bg-alt)]') +
        (compact ? ' p-2' : ' p-3') +
        (onSelectComment && comment.anchor ? ' cursor-pointer' : '')
      }
      title={onSelectComment && comment.anchor ? 'Jump to the commented passage' : undefined}
    >
      <div className="flex justify-between text-xs text-[var(--notation-fg-muted)] mb-1.5">
        <span className="font-semibold text-[var(--notation-fg)] truncate">{comment.author}</span>
        <span className="flex-shrink-0">{new Date(comment.created_at).toLocaleString()}</span>
      </div>
      {comment.anchor?.quote && (
        <div className="text-xs text-[var(--notation-fg-muted)] mb-2 pl-2 border-l-2 border-[var(--notation-border)] italic flex items-start gap-1">
          <Quote size={10} className="mt-0.5 flex-shrink-0 opacity-60" />
          <span className="line-clamp-2">{comment.anchor.quote}</span>
        </div>
      )}
      <p className="whitespace-pre-wrap text-[var(--notation-fg)]">{comment.text}</p>

      <div className="mt-2 flex items-center gap-3">
        {canReply && onReply && !replyOpen && (
          <button
            onClick={() => setReplyOpen(true)}
            className="text-xs text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] flex items-center gap-1"
          >
            <MessageSquare size={11} /> Reply
          </button>
        )}
        {onDelete && (
          <button
            onClick={async () => {
              if (deleting) return
              const msg = comment.parent_id
                ? 'Delete this reply?'
                : 'Delete this comment and all replies?'
              if (!window.confirm(msg)) return
              setDeleting(true)
              try { await onDelete(comment.id) }
              finally { setDeleting(false) }
            }}
            disabled={deleting}
            className="text-xs text-[var(--notation-fg-muted)] hover:text-[var(--notation-danger)] flex items-center gap-1 ml-auto disabled:opacity-40"
            title="Delete"
          >
            <Trash2 size={11} /> {deleting ? '…' : 'Delete'}
          </button>
        )}
      </div>
      {replyOpen && onReply && (
        <form onSubmit={send} className="mt-2 flex flex-col gap-1.5">
          <textarea
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            placeholder="Write a reply…"
            autoFocus
            rows={2}
            disabled={busy}
            className="w-full bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] focus:border-lime-500 dark:focus:border-[color:var(--notation-accent)] focus:ring-1 focus:ring-lime-500 dark:focus:ring-[color:var(--notation-accent)] outline-none rounded-md p-2 text-sm text-[var(--notation-fg)] resize-none"
          />
          <div className="flex gap-1.5 justify-end">
            <button
              type="button"
              onClick={() => {
                setReplyOpen(false)
                setReplyText('')
              }}
              className="px-2 py-1 text-xs text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!replyText.trim() || busy}
              className="px-3 py-1 text-xs font-semibold bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] rounded-md hover:bg-[var(--notation-bg-alt)] dark:hover:bg-[#a6d944] disabled:opacity-40"
            >
              {busy ? '…' : 'Reply'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
