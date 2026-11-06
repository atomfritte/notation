import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, X } from 'lucide-react'

/** One entry of a menu. The same shape drives inline buttons, menus and the command palette. */
export type MenuAction = {
  key: string
  label: string
  icon: ReactNode
  onClick: () => void
  /** A toggle that is on (shown as a check / pressed state). */
  active?: boolean
  /** A count (comments …). */
  badge?: number
  /** A keyboard shortcut to show beside the label. */
  hint?: string
  danger?: boolean
}

export type MenuSection = { title?: string; items: MenuAction[] }

/**
 * A labelled, grouped menu behind a trigger button.
 *
 * Rendered in a portal with fixed positioning measured from the trigger, so a
 * parent's `overflow: hidden` (the sidebar) can never clip it, and it flips up
 * or slides sideways to stay on screen. On phones it is a bottom sheet with
 * large touch targets instead of a dropdown. Arrow keys move, Esc closes and
 * returns focus to the trigger.
 */
export function ActionMenu({
  sections,
  label,
  icon,
  isMobile,
  title,
  triggerClassName,
  showLabel = false,
}: {
  sections: MenuSection[]
  /** Accessible name of the trigger (and tooltip). */
  label: string
  icon: ReactNode
  isMobile: boolean
  /** Heading of the bottom sheet on phones. */
  title?: string
  triggerClassName?: string
  /** Show the label next to the icon in the trigger. */
  showLabel?: boolean
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null)

  const close = useCallback((refocus = true) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus({ preventScroll: true })
  }, [])

  // Place the dropdown: below the trigger if it fits, else above; never off-screen.
  useLayoutEffect(() => {
    if (!open || isMobile) return
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect()
      const m = menuRef.current
      if (!t || !m) return
      const vw = window.innerWidth
      const vh = window.innerHeight
      const w = m.offsetWidth
      const h = m.scrollHeight
      const below = vh - t.bottom - 8
      const above = t.top - 8
      const down = below >= Math.min(h, 320) || below >= above
      const maxH = Math.max(160, (down ? below : above) - 4)
      const top = down ? t.bottom + 4 : Math.max(8, t.top - 4 - Math.min(h, maxH))
      // Right-align with the trigger when that keeps it on screen, else left-align.
      let left = t.right - w
      if (left < 8) left = t.left
      left = Math.max(8, Math.min(left, vw - w - 8))
      // Only a real change re-renders (this effect runs after every render).
      setPos(p => (p && p.top === top && p.left === left && p.maxH === maxH ? p : { top, left, maxH }))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  })

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      close(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown, { passive: true })
    // Focus the first item so the keyboard works right away.
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]')
    first?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [open, close])

  function onKeyDown(e: React.KeyboardEvent) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]') ?? [])
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus() }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
    else if (e.key === 'Tab') close(false)
  }

  const visible = sections.filter(s => s.items.length > 0)
  const badgeTotal = visible.reduce((n, s) => n + s.items.reduce((m, a) => m + (a.badge ?? 0), 0), 0)

  const list = (
    <>
      {visible.map((s, si) => (
        <div key={s.title ?? si} role="group" aria-label={s.title} className={si > 0 ? 'border-t border-[var(--notation-border)] mt-1 pt-1' : ''}>
          {s.title && (
            <div className={`px-3 ${isMobile ? 'pt-2 pb-1 text-[11.5px]' : 'pt-1.5 pb-0.5 text-[10.5px]'} font-semibold uppercase tracking-wider text-[var(--notation-fg-muted)]`}>
              {s.title}
            </div>
          )}
          {s.items.map(a => (
            <button
              key={a.key}
              role={a.active !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={a.active !== undefined ? a.active : undefined}
              onClick={() => { close(false); a.onClick() }}
              className={
                `w-full flex items-center gap-3 px-3 ${isMobile ? 'py-2.5 text-[15px]' : 'py-1.5 text-sm'} text-left outline-none transition-colors ` +
                'hover:bg-[var(--notation-bg-alt)] focus-visible:bg-[var(--notation-bg-alt)] ' +
                (a.danger ? 'text-[var(--notation-danger)]' : 'text-[var(--notation-fg)]')
              }
            >
              <span className="flex-shrink-0 flex items-center text-[var(--notation-fg-muted)]">{a.icon}</span>
              <span className="flex-1 min-w-0 truncate">{a.label}</span>
              {a.badge ? (
                <span className="text-[10px] font-bold bg-[color:var(--notation-accent-15)] text-[color:var(--notation-accent-text)] px-1.5 py-0.5 rounded-full">{a.badge}</span>
              ) : null}
              {a.hint && !isMobile && <kbd className="text-[10.5px] text-[var(--notation-fg-muted)] font-sans">{a.hint}</kbd>}
              {a.active && <Check size={14} className="text-[color:var(--notation-accent-text)] flex-shrink-0" />}
            </button>
          ))}
        </div>
      ))}
    </>
  )

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(v => !v)}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={triggerClassName ?? (
          'relative p-1.5 rounded-md transition-colors flex items-center gap-1.5 ' +
          (open ? 'bg-[var(--notation-bg-alt)] text-[var(--notation-fg)]' : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]')
        )}
      >
        {icon}
        {showLabel && <span className="text-sm">{label}</span>}
        {badgeTotal > 0 && !showLabel && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-[color:var(--notation-accent)] text-[var(--notation-fg-on-accent,#fff)] text-[9px] font-bold leading-[14px] text-center">
            {badgeTotal > 9 ? '9+' : badgeTotal}
          </span>
        )}
      </button>
      {open && createPortal(
        isMobile ? (
          <div className="fixed inset-0 z-[120]" onKeyDown={onKeyDown}>
            <div className="absolute inset-0 bg-[var(--notation-backdrop)] animate-in fade-in duration-100" onClick={() => close(false)} />
            <div
              ref={menuRef}
              role="menu"
              aria-label={title ?? label}
              className="surface-elevated absolute inset-x-0 bottom-0 max-h-[82dvh] overflow-y-auto rounded-t-2xl bg-[var(--notation-bg-elevated)] border-t border-[var(--notation-border)] shadow-2xl pb-[max(0.75rem,env(safe-area-inset-bottom))] animate-in slide-in-from-bottom-4 duration-150"
            >
              <div className="sticky top-0 z-10 flex items-center justify-between px-4 pt-3 pb-2 bg-[var(--notation-bg-elevated)]">
                <span className="font-semibold text-[15px]">{title ?? label}</span>
                <button onClick={() => close()} aria-label="Close menu" className="p-1.5 -mr-1.5 rounded-md text-[var(--notation-fg-muted)] hover:bg-[var(--notation-bg-alt)]"><X size={18} /></button>
              </div>
              {list}
            </div>
          </div>
        ) : (
          <div
            ref={menuRef}
            role="menu"
            aria-label={title ?? label}
            onKeyDown={onKeyDown}
            className="surface-elevated fixed z-[120] min-w-[230px] max-w-[min(320px,calc(100vw-16px))] overflow-y-auto bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-lg shadow-xl py-1 animate-in fade-in zoom-in-95 duration-100"
            style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxH } : { top: -9999, left: -9999 }}
          >
            {list}
          </div>
        ),
        document.body,
      )}
    </>
  )
}
