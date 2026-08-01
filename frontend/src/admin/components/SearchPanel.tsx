import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { stripMdExt } from './MarkdownView'

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
  /** Every path the caller can open — the Space's file list in menu order.
   *  Titles are matched against it locally (see {@link matchTitles}), so a
   *  page is findable by its name and not only by what it says. Omit it and
   *  the panel is content-only, exactly as before. */
  files?: string[]
}

/** A page whose *title* matched — no line to point at, just the page. */
export type TitleHit = { path: string; title: string }

/**
 * Page titles containing the query, best first.
 *
 * A grep over file contents never sees the name a page is filed under, so
 * "Rechnungen" stayed unfindable unless the page also happened to write the
 * word. This closes that hole with the same rule the content search uses —
 * case-insensitive substring — applied to the display title (basename with the
 * markdown extension stripped, what the app shows everywhere else).
 *
 * Ranked whole-title match → title starts with the query → contains it, ties
 * broken by the caller's order (menu order), so the page you typed the name of
 * lands at the top rather than a long file that merely contains it.
 */
export function matchTitles(files: string[], query: string, max = 25): TitleHit[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const hits: Array<{ hit: TitleHit; rank: number; order: number }> = []
  files.forEach((path, order) => {
    const title = stripMdExt(path.slice(path.lastIndexOf('/') + 1))
    const at = title.toLowerCase().indexOf(needle)
    if (at === -1) return
    const rank = title.length === needle.length ? 0 : at === 0 ? 1 : 2
    hits.push({ hit: { path, title }, rank, order })
  })
  hits.sort((a, b) => a.rank - b.rank || a.order - b.order)
  return hits.slice(0, max).map(h => h.hit)
}

/**
 * SearchPanel — full-text search modal across all files in the Space.
 * Triggered by Cmd+Shift+F. The actual API call is the caller's
 * responsibility (admin uses api.searchSpace, share uses its own
 * share-side search). Component is otherwise self-contained.
 *
 * Page *titles* are matched locally against the `files` list instead of
 * through `onSearch` — that keeps one implementation for all three content
 * backends (plaintext admin, in-browser encrypted index, scoped share), and a
 * title hit still surfaces when the server's 200-match cap swallowed the tail.
 * The list is whatever the caller may open, so a scoped share stays scoped.
 */
export function SearchPanel({ open, onClose, onSelect, onSearch, files }: Props) {
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

  // Titles resolve from the in-memory file list, so they answer on the
  // keystroke — no debounce, no request, no waiting on the content round-trip.
  const titleHits = useMemo(
    () => (files && q.trim().length >= 2 ? matchTitles(files, q) : []),
    [files, q],
  )

  if (!open) return null

  // Group matches by file
  const grouped: Record<string, SearchPanelMatch[]> = {}
  for (const m of results) {
    ;(grouped[m.path] ??= []).push(m)
  }
  // Title hits lead — you typed a name, so the page by that name comes first —
  // then the files that only matched on content. A page that matched both ways
  // appears once, under its title, with its content lines attached.
  const byTitle = new Set(titleHits.map(h => h.path))
  const paths = [...titleHits.map(h => h.path), ...Object.keys(grouped).filter(p => !byTitle.has(p))]
  const empty = paths.length === 0

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
            placeholder={files ? 'Search page titles and content…' : 'Search across all pages…'}
            className="flex-1 bg-transparent outline-none text-sm text-[var(--notation-fg)] placeholder-zinc-400"
          />
          {loading && <span className="text-xs text-[var(--notation-fg-muted)]">searching…</span>}
          <button onClick={onClose} className="text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {err && <div className="p-4 text-sm text-[var(--notation-danger)]">{err}</div>}
          {!err && q.trim().length >= 2 && empty && !loading && (
            <div className="p-6 text-center text-sm text-[var(--notation-fg-muted)] italic">No matches</div>
          )}
          {q.trim().length < 2 && (
            <div className="p-6 text-center text-sm text-[var(--notation-fg-muted)] italic">Type at least 2 characters</div>
          )}
          {paths.map(path => (
            <div key={path} className="border-b border-[var(--notation-border)]/50 last:border-0">
              <button
                onClick={() => {
                  onSelect(path, { query: q })
                  onClose()
                }}
                className="w-full text-left px-4 py-2 text-xs font-mono text-[var(--notation-fg)] bg-[var(--notation-bg-elevated)] bg-[var(--notation-bg-elevated)]/30 hover:bg-[var(--notation-border)] flex items-center gap-2"
              >
                <span className="truncate">
                  <Highlight text={stripMdExt(path)} query={q} />
                </span>
                {byTitle.has(path) && (
                  // Says why a page with no quoted line below it is here at all.
                  <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[color:var(--notation-accent-30)] text-[color:var(--notation-accent)] font-sans">
                    title
                  </span>
                )}
              </button>
              <ul>
                {(grouped[path] ?? []).map((m, i) => (
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
