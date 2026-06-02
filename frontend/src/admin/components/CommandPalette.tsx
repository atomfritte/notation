import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Search, ArrowRight, CornerDownLeft } from 'lucide-react'

type Props = {
  open: boolean
  files: string[]
  onClose: () => void
  onSelect: (path: string) => void
  /** optional secondary action e.g. open in new tab */
  onSelectSecondary?: (path: string) => void
}

/**
 * CommandPalette: Cmd/Ctrl+K modal for jumping to any file in the Space.
 * Fuzzy-matches against the path string (subsequence match, scored by
 * contiguous runs and start-of-segment hits). Arrow keys navigate, Enter
 * opens, Esc closes.
 */
export function CommandPalette({ open, files, onClose, onSelect }: Props) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const results = useMemo(() => fuzzyMatch(files, q).slice(0, 50), [files, q])

  useEffect(() => {
    if (open) {
      setQ('')
      setIdx(0)
      // focus after mount
      const t = setTimeout(() => inputRef.current?.focus(), 10)
      return () => clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    setIdx(0)
  }, [q])

  // Keep selected item in view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cp-idx="${idx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  if (!open) return null

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = results[idx]
      if (r) {
        onSelect(r.path)
        onClose()
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] bg-[var(--notation-backdrop)] backdrop-blur-sm animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl surface-elevated bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-top-4 duration-150"
        onClick={e => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--notation-border)]">
          <Search size={18} className="text-[var(--notation-fg-muted)]" />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Jump to page…"
            className="flex-1 bg-transparent outline-none text-sm text-[var(--notation-fg)] placeholder-zinc-400"
          />
          <kbd className="text-[10px] px-1.5 py-0.5 border border-[var(--notation-border)] rounded text-[var(--notation-fg-muted)]">esc</kbd>
        </div>
        <ul ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-[var(--notation-fg-muted)] italic">No matches</li>
          )}
          {results.map((r, i) => (
            <li
              key={r.path}
              data-cp-idx={i}
              onMouseEnter={() => setIdx(i)}
              onClick={() => {
                onSelect(r.path)
                onClose()
              }}
              className={
                'flex items-center gap-3 px-4 py-2 text-sm cursor-pointer transition-colors ' +
                (i === idx
                  ? 'bg-[var(--notation-bg-alt)] text-[var(--notation-fg)]'
                  : 'text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] hover:bg-[var(--notation-bg-alt)]/50')
              }
            >
              <FileText size={14} className={i === idx ? 'text-[color:var(--notation-accent)]' : 'opacity-50'} />
              <Highlighted text={r.path.replace(/\.md$/i, '')} positions={r.positions} />
              {i === idx && (
                <span className="ml-auto flex items-center gap-1 text-xs text-[var(--notation-fg-muted)]">
                  <CornerDownLeft size={12} />
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="px-4 py-2 border-t border-[var(--notation-border)] flex items-center gap-3 text-[11px] text-[var(--notation-fg-muted)] bg-[var(--notation-bg-elevated)] bg-[var(--notation-bg-elevated)]/30">
          <span className="flex items-center gap-1"><ArrowRight size={11} /> select</span>
          <span className="flex items-center gap-1"><kbd className="px-1 border border-[var(--notation-border)] rounded">↑↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd className="px-1 border border-[var(--notation-border)] rounded">↵</kbd> open</span>
        </div>
      </div>
    </div>
  )
}

function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  const set = new Set(positions)
  return (
    <span className="truncate">
      {[...text].map((ch, i) => (
        <span key={i} className={set.has(i) ? 'text-[color:var(--notation-accent)] font-semibold' : ''}>
          {ch}
        </span>
      ))}
    </span>
  )
}

type Result = { path: string; score: number; positions: number[] }

/**
 * fuzzyMatch — simple subsequence fuzzy matcher with scoring:
 *   +10 for chars that match at the start of a segment (after `/`)
 *   +5  for chars that continue a contiguous run
 *   +1  otherwise
 *   Negative score for the gap length (rewards tight matches).
 */
function fuzzyMatch(files: string[], q: string): Result[] {
  if (q === '') return files.map(p => ({ path: p, score: 0, positions: [] }))
  const needle = q.toLowerCase()
  const out: Result[] = []
  for (const path of files) {
    const hay = path.toLowerCase()
    let qi = 0
    let score = 0
    let lastMatch = -2
    const positions: number[] = []
    for (let i = 0; i < hay.length && qi < needle.length; i++) {
      if (hay[i] === needle[qi]) {
        positions.push(i)
        if (i === 0 || hay[i - 1] === '/' || hay[i - 1] === '-' || hay[i - 1] === '_') {
          score += 10
        } else if (i === lastMatch + 1) {
          score += 5
        } else {
          score += 1
        }
        lastMatch = i
        qi++
      }
    }
    if (qi === needle.length) {
      // Penalize loose matches: shorter span = better
      score -= positions[positions.length - 1] - positions[0]
      out.push({ path, score, positions })
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out
}
