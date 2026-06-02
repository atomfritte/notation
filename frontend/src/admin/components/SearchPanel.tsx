import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'

// Minimal shape we render. Both admin & share API hits return at least
// these fields, so the component itself doesn't care which backend it
// talked to — the caller passes in an onSearch closure.
export type SearchPanelMatch = {
  path: string
  line: number
  content: string
}

type Props = {
  open: boolean
  onClose: () => void
  /** Receives the chosen file plus the query that produced the hit so the
   *  viewer can scroll to / highlight matches. `line` is the source-line
   *  number; the viewer maps query → DOM occurrences and uses line only
   *  as a tiebreaker when the query matches multiple places. */
  onSelect: (path: string, opts?: { line?: number; query?: string }) => void
  /** Called with the user's query; returns matches. The component handles
   *  debouncing, loading state and error surfacing. Wraps the admin or
   *  share-side search endpoint depending on the caller. */
  onSearch: (q: string) => Promise<SearchPanelMatch[]>
}

/**
 * SearchPanel — full-text search modal across all files in the Space.
 * Triggered by Cmd+Shift+F. The actual API call is the caller's
 * responsibility (admin uses api.searchSpace, share uses its own
 * share-side search). Component is otherwise self-contained.
 */
export function SearchPanel({ open, onClose, onSelect, onSearch }: Props) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchPanelMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setResults([])
      setErr(null)
      const t = setTimeout(() => inputRef.current?.focus(), 10)
      return () => clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setResults([])
      return
    }
    setLoading(true)
    setErr(null)
    const t = setTimeout(() => {
      onSearch(q)
        .then(r => setResults(Array.isArray(r) ? r : []))
        .catch(e => setErr(String(e)))
        .finally(() => setLoading(false))
    }, 200) // simple debounce
    return () => clearTimeout(t)
  }, [q, open, onSearch])

  if (!open) return null

  // Group matches by file
  const grouped: Record<string, SearchPanelMatch[]> = {}
  for (const m of results) {
    ;(grouped[m.path] ??= []).push(m)
  }
  const files = Object.keys(grouped)

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[8vh] bg-[var(--notation-backdrop)] backdrop-blur-sm animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl surface-elevated surface-gradient bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-top-4 duration-150 flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--notation-border)]">
          <Search size={18} className="text-[var(--notation-fg-muted)]" />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') onClose()
            }}
            placeholder="Search across all pages…"
            className="flex-1 bg-transparent outline-none text-sm text-[var(--notation-fg)] placeholder-zinc-400"
          />
          {loading && <span className="text-xs text-[var(--notation-fg-muted)]">searching…</span>}
          <button onClick={onClose} className="text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {err && <div className="p-4 text-sm text-[var(--notation-danger)]">{err}</div>}
          {!err && q.trim().length >= 2 && results.length === 0 && !loading && (
            <div className="p-6 text-center text-sm text-[var(--notation-fg-muted)] italic">No matches</div>
          )}
          {q.trim().length < 2 && (
            <div className="p-6 text-center text-sm text-[var(--notation-fg-muted)] italic">Type at least 2 characters</div>
          )}
          {files.map(path => (
            <div key={path} className="border-b border-[var(--notation-border)]/50 last:border-0">
              <button
                onClick={() => {
                  onSelect(path, { query: q })
                  onClose()
                }}
                className="w-full text-left px-4 py-2 text-xs font-mono text-[var(--notation-fg)] bg-[var(--notation-bg-elevated)] bg-[var(--notation-bg-elevated)]/30 hover:bg-[var(--notation-border)]"
              >
                {path.replace(/\.md$/i, '')}
              </button>
              <ul>
                {grouped[path].map((m, i) => (
                  <li
                    key={i}
                    onClick={() => {
                      onSelect(path, { line: m.line, query: q })
                      onClose()
                    }}
                    className="px-4 py-2 text-xs hover:bg-[var(--notation-bg-alt)] hover:bg-[var(--notation-bg-alt)]/30 cursor-pointer flex gap-3"
                  >
                    <span className="text-[var(--notation-fg-muted)] select-none w-8 text-right shrink-0">{m.line}</span>
                    <span className="text-[var(--notation-fg-muted)] text-[var(--notation-fg)] truncate">
                      <Highlight text={m.content} query={q} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const parts: Array<{ s: string; hit: boolean }> = []
  let i = 0
  while (i < text.length) {
    const next = lower.indexOf(q, i)
    if (next === -1) {
      parts.push({ s: text.slice(i), hit: false })
      break
    }
    if (next > i) parts.push({ s: text.slice(i, next), hit: false })
    parts.push({ s: text.slice(next, next + q.length), hit: true })
    i = next + q.length
  }
  return (
    <>
      {parts.map((p, k) =>
        p.hit ? (
          <mark key={k} className="bg-[color:var(--notation-accent-30)] text-[var(--notation-fg)] dark:text-[color:var(--notation-accent)] rounded px-0.5">
            {p.s}
          </mark>
        ) : (
          <span key={k}>{p.s}</span>
        ),
      )}
    </>
  )
}
