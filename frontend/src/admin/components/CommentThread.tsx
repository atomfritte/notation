import { useState, useEffect, type FormEvent } from 'react'

export type CommentItem = {
  id: string
  created_at: string
  author: string
  text: string
}

type Props = {
  comments: CommentItem[]
  canAdd: boolean
  initialText?: string
  onAdd?: (text: string) => Promise<void>
}

export function CommentThread({ comments, canAdd, initialText, onAdd }: Props) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (initialText) {
      setText(prev => prev ? prev + '\n\n' + initialText : initialText)
    }
  }, [initialText])

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
    <aside className="p-4">
      <h3 className="font-semibold text-sm mb-3 text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
        Comments 
        {comments.length > 0 && <span className="bg-zinc-100 dark:bg-zinc-800 text-lime-600 dark:text-[#BFF355] px-2 py-0.5 rounded-full text-xs font-bold">{comments.length}</span>}
      </h3>
      {comments.length === 0 && (
        <p className="text-xs text-zinc-500 italic mb-3">No comments yet.</p>
      )}
      <ul className="space-y-3 mb-4">
        {comments.map(c => (
          <li key={c.id} className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-3 text-sm">
            <div className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400 mb-2">
              <span className="font-semibold text-zinc-700 dark:text-zinc-300">{c.author}</span>
              <span>{new Date(c.created_at).toLocaleString()}</span>
            </div>
            <p className="whitespace-pre-wrap text-zinc-800 dark:text-zinc-300">{c.text}</p>
          </li>
        ))}
      </ul>
      {canAdd && onAdd && (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Add a comment…"
            className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 focus:border-lime-500 dark:focus:border-[#BFF355] focus:ring-1 focus:ring-lime-500 dark:focus:ring-[#BFF355] outline-none rounded-md p-2 text-sm text-zinc-900 dark:text-zinc-100 resize-none transition-all"
            rows={2}
            disabled={submitting}
          />
          <button
            type="submit"
            disabled={!text.trim() || submitting}
            className="self-end px-4 py-1.5 bg-zinc-900 text-white dark:bg-[#BFF355] dark:text-zinc-950 font-semibold text-sm rounded-md shadow-sm disabled:opacity-40 hover:bg-zinc-800 dark:hover:bg-[#a6d944] transition-colors"
          >
            {submitting ? 'Posting…' : 'Post Comment'}
          </button>
        </form>
      )}
      {err && <p className="text-red-500 text-xs mt-2">{err}</p>}
    </aside>
  )
}
