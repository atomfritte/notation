import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Menu, Check } from 'lucide-react'

// A single header tool. Used to render either an inline icon button or a row in
// the overflow ("tool") menu, so the two never drift apart.
export type HeaderAction = {
  key: string
  label: string
  icon: ReactNode
  onClick: () => void
  active?: boolean
  badge?: number
}

// One header action rendered inline (icon + optional count badge).
export function HeaderActionBtn({ action }: { action: HeaderAction }) {
  return (
    <button
      onClick={action.onClick}
      title={action.label}
      aria-label={action.label}
      aria-pressed={action.active}
      className={
        'p-1.5 rounded-md transition-colors flex items-center ' +
        (action.active
          ? 'bg-[var(--notation-border)] text-[color:var(--notation-accent)]'
          : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]')
      }
    >
      {action.icon}
      {action.badge ? <span className="ml-1 text-[10px] font-bold">{action.badge}</span> : null}
    </button>
  )
}

// Hamburger menu holding every header action when they don't fit inline.
export function HeaderOverflowMenu({ actions }: { actions: HeaderAction[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        title="More tools"
        aria-label="More tools"
        aria-haspopup="menu"
        aria-expanded={open}
        className="p-1.5 rounded-md transition-colors flex items-center text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]"
      >
        <Menu size={18} />
      </button>
      {open && (
        <div role="menu" className="surface-elevated absolute right-0 top-full mt-1 min-w-[210px] bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-md shadow-xl py-1 z-50">
          {actions.map(a => (
            <button
              key={a.key}
              role="menuitem"
              onClick={() => { a.onClick(); setOpen(false) }}
              className={
                'w-full flex items-center gap-2.5 px-3 py-1.5 text-sm transition-colors hover:bg-[var(--notation-border)] ' +
                (a.active ? 'text-[color:var(--notation-accent)]' : 'text-[var(--notation-fg)]')
              }
            >
              <span className="flex-shrink-0 flex items-center">{a.icon}</span>
              <span className="flex-1 text-left truncate">{a.label}</span>
              {a.badge ? (
                <span className="text-[10px] font-bold bg-[color:var(--notation-accent-15)] text-[color:var(--notation-accent)] px-1.5 py-0.5 rounded-full">{a.badge}</span>
              ) : a.active ? (
                <Check size={14} className="text-[color:var(--notation-accent)] flex-shrink-0" />
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * useHeaderWidth watches the header element's content width via a ResizeObserver
 * and returns a callback ref to attach to the <header> plus the latest width.
 * The caller decides whether to collapse (see headerIsCompact) — the action
 * count it needs is only known after the component's early returns, so the
 * decision can't live in the hook.
 */
export function useHeaderWidth() {
  const [width, setWidth] = useState(0)
  const roRef = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLElement | null) => {
    roRef.current?.disconnect()
    if (el && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(entries => { for (const e of entries) setWidth(e.contentRect.width) })
      ro.observe(el)
      roRef.current = ro
    }
  }, [])
  return { ref, width }
}

// Collapse the action icons into the overflow menu when they (~34px each) would
// need more room than is available beside the reserved left content. Before the
// first measurement (width 0), fall back to the viewport heuristic.
export function headerIsCompact(width: number, actionCount: number, reservedW: number, isMobile: boolean): boolean {
  return width === 0 ? isMobile : actionCount * 34 > width - reservedW
}
