import { useState, type FormEvent } from 'react'

export type CommentItem = {
  id: string
  created_at: string
  author: string
  text: string
}

type Props = {
  comments: CommentItem[]
  canAdd: boolean
  onAdd?: (text: string) => Promise<void>
}

/**
 * CommentThread renders a flat list of document-level comments (oldest first)
 * plus an inline form when the viewer has comment or edit permissions.
 * Anchored / inline comments are out of scope for stage 6 — they'd require a
 * selection-position model the markdown viewer doesn't expose yet.
 */
export function CommentThread({ comments, canAdd, onAdd }: Props) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || !onAdd) return
    setSubmitting(true)
    setErr(null)
    try {
      await onAdd(text)
      setText('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <aside className="border-t bg-gray-50 p-4">
      <h3 className="font-semibold text-sm mb-3">
        Comments {comments.length > 0 && <span className="text-gray-500">({comments.length})</span>}
      </h3>
      {comments.length === 0 && (
        <p className="text-xs text-gray-500 italic mb-3">No comments yet.</p>
      )}
      <ul className="space-y-2 mb-3">
        {comments.map(c => (
          <li key={c.id} className="bg-white border rounded p-2 text-sm">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span className="font-mono">{c.author}</span>
              <span>{new Date(c.created_at).toLocaleString()}</span>
            </div>
            <p className="whitespace-pre-wrap">{c.text}</p>
          </li>
        ))}
      </ul>
      {canAdd && onAdd && (
        <form onSubmit={submit} className="flex gap-2 items-stretch">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Add a comment…"
            className="flex-1 border rounded px-2 py-1 text-sm resize-none"
            rows={2}
            disabled={submitting}
          />
          <button
            type="submit"
            disabled={!text.trim() || submitting}
            className="px-3 py-1 bg-blue-600 text-white text-sm rounded disabled:opacity-40"
          >
            {submitting ? '…' : 'Post'}
          </button>
        </form>
      )}
      {err && <p className="text-red-600 text-xs mt-2">{err}</p>}
    </aside>
  )
}
