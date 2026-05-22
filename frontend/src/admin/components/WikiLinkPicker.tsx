import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FileText, Hash, Search } from 'lucide-react'
import * as api from '../lib/api'

type Heading = { level: number; text: string }

type Props = {
  open: boolean
  /** Screen-fixed coords where the popover should anchor (typically the
   *  cursor's bottom edge). When null the popover renders centered. */
  anchor: { x: number; y: number } | null
  spaceID: string
  allFiles: string[]
  /** When the current file is selected, we prefer the live editor buffer over
   *  the on-disk content so heading lookups reflect unsaved edits. */
  currentPath?: string
  currentContent?: string
  /** Called with the text to insert AFTER the existing `[[`. Should end with
   *  `]]` to close the wiki-link syntax. */
  onSelect: (insertText: string) => void
  onClose: () => void
}

/**
 * WikiLinkPicker is a floating, two-stage picker for [[wiki-links]]:
 *
 *   Stage 1 — Pages: fuzzy substring search over the Space's markdown files.
 *             Click a page to insert `[[page]]`, or click its chevron to drop
 *             into stage 2 for that page.
 *   Stage 2 — Headings: shows the page's headings (parsed from the live editor
 *             buffer if it's the current file, otherwise fetched). Click a
 *             heading to insert `[[page#heading]]`, or "Insert without heading"
 *             to fall back to `[[page]]`.
 *
 * Keyboard: Esc closes; Esc from stage 2 returns to stage 1.
 */
export function WikiLinkPicker({
  open,
  anchor,
  spaceID,
  allFiles,
  currentPath,
  currentContent,
  onSelect,
  onClose,
}: Props) {
  const [q, setQ] = useState('')
  const [headingQ, setHeadingQ] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [headings, setHeadings] = useState<Heading[]>([])
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const cache = useRef<Record<string, Heading[]>>({})

  // Click-outside dismisses the picker.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onClose])

  useEffect(() => {
    if (open) {
      setQ('')
      setHeadingQ('')
      setExpanded(null)
      setHeadings([])
      setIdx(0)
      const t = window.setTimeout(() => inputRef.current?.focus(), 10)
      return () => window.clearTimeout(t)
    }
  }, [open])

  // Filter the file list as the user types.
  const files = useMemo(() => {
    const onlyMd = allFiles.filter(f => /\.(md|markdown)$/i.test(f))
    if (q.trim() === '') return onlyMd.slice(0, 50)
    const needle = q.toLowerCase()
    return onlyMd.filter(f => f.toLowerCase().includes(needle)).slice(0, 50)
  }, [allFiles, q])

  // Heading filter applied after fetch.
  const filteredHeadings = useMemo(() => {
    if (headingQ.trim() === '') return headings
    const needle = headingQ.toLowerCase()
    return headings.filter(h => h.text.toLowerCase().includes(needle))
  }, [headings, headingQ])

  // Reset list cursor when query / mode changes.
  useEffect(() => {
    setIdx(0)
  }, [q, headingQ, expanded])

  // Load headings for the expanded file. Current file uses the live editor
  // content; other files are fetched from disk.
  useEffect(() => {
    if (!expanded) {
      setHeadings([])
      return
    }
    if (cache.current[expanded]) {
      setHeadings(cache.current[expanded])
      return
    }
    if (expanded === currentPath && currentContent !== undefined) {
      const h = extractHeadings(currentContent)
      cache.current[expanded] = h
      setHeadings(h)
      return
    }
    let cancelled = false
    api
      .readFile(spaceID, expanded)
      .then(res => {
        if (cancelled) return
        const h = extractHeadings(res.content)
        cache.current[expanded] = h
        setHeadings(h)
      })
      .catch(() => !cancelled && setHeadings([]))
    return () => {
      cancelled = true
    }
  }, [expanded, spaceID, currentPath, currentContent])

  if (!open || !anchor) return null

  function insertFile(file: string) {
    onSelect(`${file.replace(/\.md$/i, '')}]]`)
  }
  function insertHeading(file: string, headingText: string) {
    onSelect(`${file.replace(/\.md$/i, '')}#${headingText}]]`)
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (expanded) setExpanded(null)
      else onClose()
      return
    }
    const list = expanded ? filteredHeadings : files
    const length = expanded ? list.length + 1 : list.length // +1 for "without heading" row
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx(i => Math.min(i + 1, Math.max(0, length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (expanded) {
        if (idx === 0) insertFile(expanded)
        else {
          const h = filteredHeadings[idx - 1]
          if (h) insertHeading(expanded, h.text)
        }
      } else {
        const f = files[idx]
        if (f) insertFile(f)
      }
    } else if (e.key === 'ArrowRight' && !expanded) {
      const f = files[idx]
      if (f) setExpanded(f)
    } else if (e.key === 'ArrowLeft' && expanded) {
      setExpanded(null)
    }
  }

  // Clamp the picker inside the viewport so it doesn't render off-screen.
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.min(anchor.x, vw - 360)
  const top = Math.min(anchor.y, vh - 340)

  return (
    <div
      ref={containerRef}
      className="fixed z-[100] w-80 bg-white dark:bg-zinc-900 border border-[var(--notation-border)] rounded-md shadow-2xl overflow-hidden flex flex-col max-h-80"
      style={{ left, top }}
      onMouseDown={e => e.stopPropagation()}
      onKeyDown={onKey}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--notation-border)]">
        <Search size={14} className="text-zinc-400" />
        <input
          ref={inputRef}
          value={expanded ? headingQ : q}
          onChange={e => (expanded ? setHeadingQ(e.target.value) : setQ(e.target.value))}
          placeholder={expanded ? 'Filter headings…' : 'Search pages…'}
          className="flex-1 bg-transparent outline-none text-sm text-[var(--notation-fg)] placeholder-zinc-400"
        />
        {expanded && (
          <button
            onClick={() => setExpanded(null)}
            className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            ← pages
          </button>
        )}
      </div>

      <ul className="overflow-y-auto flex-1 py-1 text-sm">
        {!expanded &&
          (files.length === 0 ? (
            <li className="px-3 py-3 text-xs text-zinc-500 italic">No pages match.</li>
          ) : (
            files.map((f, i) => {
              const clean = f.replace(/\.md$/i, '')
              const active = i === idx
              return (
                <li
                  key={f}
                  onMouseEnter={() => setIdx(i)}
                  className={
                    'flex items-center transition-colors ' +
                    (active ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50')
                  }
                >
                  <button
                    onClick={() => insertFile(f)}
                    className="flex-1 text-left flex items-center gap-2 px-3 py-1.5 text-[var(--notation-fg)] min-w-0"
                  >
                    <FileText size={12} className={active ? 'text-[color:var(--notation-accent)]' : 'opacity-60'} />
                    <span className="truncate">{clean}</span>
                  </button>
                  <button
                    onClick={() => setExpanded(f)}
                    title="Pick a heading"
                    className="px-2 py-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                  >
                    <ChevronRight size={12} />
                  </button>
                </li>
              )
            })
          ))}

        {expanded && (
          <>
            <li
              onMouseEnter={() => setIdx(0)}
              className={idx === 0 ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'}
            >
              <button
                onClick={() => insertFile(expanded)}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[var(--notation-fg)] border-b border-[var(--notation-border)]/50"
              >
                <FileText size={12} className={idx === 0 ? 'text-[color:var(--notation-accent)]' : 'opacity-60'} />
                Insert <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">[[{expanded.replace(/\.md$/i, '')}]]</code>
              </button>
            </li>
            {filteredHeadings.length === 0 ? (
              <li className="px-3 py-3 text-xs text-zinc-500 italic">No headings in this page.</li>
            ) : (
              filteredHeadings.map((h, i) => {
                const rowIdx = i + 1
                const active = rowIdx === idx
                return (
                  <li
                    key={i}
                    onMouseEnter={() => setIdx(rowIdx)}
                    className={active ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'}
                  >
                    <button
                      onClick={() => insertHeading(expanded, h.text)}
                      className="w-full text-left flex items-center gap-2 py-1.5 text-[var(--notation-fg)]"
                      style={{ paddingLeft: (h.level - 1) * 10 + 12, paddingRight: 12 }}
                    >
                      <Hash size={10} className={active ? 'text-[color:var(--notation-accent)]' : 'opacity-50'} />
                      <span className="truncate">{h.text}</span>
                    </button>
                  </li>
                )
              })
            )}
          </>
        )}
      </ul>

      <div className="px-3 py-1.5 border-t border-[var(--notation-border)] flex items-center gap-3 text-[10px] text-zinc-500 bg-zinc-50 dark:bg-zinc-950/30">
        <span><kbd className="px-1 border border-[var(--notation-border)] rounded">↑↓</kbd> nav</span>
        <span><kbd className="px-1 border border-[var(--notation-border)] rounded">→</kbd> headings</span>
        <span><kbd className="px-1 border border-[var(--notation-border)] rounded">↵</kbd> insert</span>
        <span><kbd className="px-1 border border-[var(--notation-border)] rounded">esc</kbd> close</span>
      </div>
    </div>
  )
}

function extractHeadings(md: string): Heading[] {
  const stripped = md.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '')
  const re = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm
  const out: Heading[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    out.push({ level: m[1].length, text: m[2].replace(/[`*]/g, '').trim() })
  }
  return out
}
