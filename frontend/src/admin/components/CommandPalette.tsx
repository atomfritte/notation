import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Search, ArrowRight, CornerDownLeft, Zap } from 'lucide-react'
import type { MenuAction } from './ui/ActionMenu'

type Props = {
  open: boolean
  files: string[]
  /** Every action of the page/Space/app, found by name ("print", "share", …). */
  actions?: MenuAction[]
  onClose: () => void
  onSelect: (path: string) => void
  /** optional secondary action e.g. open in new tab */
  onSelectSecondary?: (path: string) => void
}

type Row =
  | { kind: 'file'; path: string; positions: number[] }
  | { kind: 'action'; action: MenuAction; positions: number[] }

/**
 * CommandPalette: Cmd/Ctrl+K — jump to any page, or run any action by name.
 * Fuzzy-matches page paths and action labels (subsequence match, scored by
 * contiguous runs and start-of-word hits). A leading ">" lists actions only.
 * Arrow keys navigate, Enter opens/runs, Esc closes.
 */
export function CommandPalette({ open, files, actions = [], onClose, onSelect }: Props) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const results = useMemo<Row[]>(() => {
    const onlyActions = q.startsWith('>')
    const query = onlyActions ? q.slice(1).trim() : q
    const labels = actions.map(a => a.label)
    const acts: Row[] = fuzzyMatch(labels, query, ' ')
      .map(r => ({ kind: 'action' as const, action: actions[labels.indexOf(r.path)], positions: r.positions }))
    if (onlyActions) return acts
    // No query: pages first (the palette's everyday use); a query: the best
    // few actions above the pages.
    const pages: Row[] = fuzzyMatch(files, query).slice(0, 50).map(r => ({ kind: 'file' as const, path: r.path, positions: r.positions }))
    return query ? [...acts.slice(0, 5), ...pages] : pages
  }, [files, actions, q])

  const run = (r: Row | undefined) => {
    if (!r) return
    onClose()
    if (r.kind === 'file') onSelect(r.path)
    else r.action.onClick()
  }

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
      run(results[idx])
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
            placeholder="Jump to a page, or type an action…"
            className="flex-1 bg-transparent outline-none text-sm text-[var(--notation-fg)]"
          />
          <kbd className="text-[10px] px-1.5 py-0.5 border border-[var(--notation-border)] rounded text-[var(--notation-fg-muted)]">esc</kbd>
        </div>
        <ul ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-[var(--notation-fg-muted)] italic">No matches</li>
          )}
          {results.map((r, i) => (
            <li
              key={r.kind === 'file' ? r.path : `action:${r.action.key}`}
              data-cp-idx={i}
              onMouseEnter={() => setIdx(i)}
              onClick={() => run(r)}
              className={
                'flex items-center gap-3 px-4 py-2 text-sm cursor-pointer transition-colors ' +
                (i === idx
                  ? 'bg-[var(--notation-bg-alt)] text-[var(--notation-fg)]'
                  : 'text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] hover:bg-[var(--notation-bg-alt)]/50')
              }
            >
              {r.kind === 'file' ? (
                <>
                  <FileText size={14} className={i === idx ? 'text-[color:var(--notation-accent-text)]' : 'opacity-50'} />
                  <Highlighted text={r.path.replace(/\.md$/i, '')} positions={r.positions} />
                </>
              ) : (
                <>
                  <span className={`flex-shrink-0 flex items-center [&>svg]:w-3.5 [&>svg]:h-3.5 ${i === idx ? 'text-[color:var(--notation-accent-text)]' : 'opacity-60'}`}>{r.action.icon ?? <Zap size={14} />}</span>
                  <Highlighted text={r.action.label} positions={r.positions} />
                  {r.action.active && <span className="text-[10.5px] text-[var(--notation-fg-muted)]">on</span>}
                  {r.action.hint && <kbd className="text-[10.5px] text-[var(--notation-fg-muted)] font-sans">{r.action.hint}</kbd>}
                  <span className="text-[10.5px] px-1.5 rounded bg-[var(--notation-bg-alt)] text-[var(--notation-fg-muted)]">action</span>
                </>
              )}
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
          {actions.length > 0 && <span className="ml-auto flex items-center gap-1"><kbd className="px-1 border border-[var(--notation-border)] rounded">&gt;</kbd> actions only</span>}
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
        <span key={i} className={set.has(i) ? 'text-[color:var(--notation-accent-text)] font-semibold' : ''}>
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
function fuzzyMatch(files: string[], q: string, wordSep = '/'): Result[] {
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
        if (i === 0 || hay[i - 1] === wordSep || hay[i - 1] === '/' || hay[i - 1] === '-' || hay[i - 1] === '_' || hay[i - 1] === ' ') {
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
