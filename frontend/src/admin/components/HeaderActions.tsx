import { useCallback, useRef, useState } from 'react'
import type { MenuAction } from './ui/ActionMenu'

// A single header tool. Used to render either an inline icon button or a row in
// a menu, so the two never drift apart.
export type HeaderAction = MenuAction

// One header action rendered inline (icon + optional count badge).
export function HeaderActionBtn({ action }: { action: HeaderAction }) {
  const label = action.hint ? `${action.label} (${action.hint})` : action.label
  return (
    <button
      onClick={action.onClick}
      title={label}
      aria-label={label}
      aria-pressed={action.active}
      className={
        'p-1.5 rounded-md transition-colors flex items-center ' +
        (action.active
          ? 'bg-[var(--notation-border)] text-[color:var(--notation-accent-text)]'
          : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]')
      }
    >
      {action.icon}
      {action.badge ? <span className="ml-1 text-[10px] font-bold">{action.badge}</span> : null}
    </button>
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

// Collapse the inline action icons into the "More" menu when they (~34px each) would
// need more room than is available beside the reserved left content. Before the
// first measurement (width 0), fall back to the viewport heuristic.
export function headerIsCompact(width: number, actionCount: number, reservedW: number, isMobile: boolean): boolean {
  return width === 0 ? isMobile : actionCount * 34 > width - reservedW
}
