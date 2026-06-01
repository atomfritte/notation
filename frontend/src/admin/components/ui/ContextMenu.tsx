import { useEffect, useRef } from 'react'

export type MenuItem = {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  danger?: boolean
}

type Props = {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  // Move focus into the menu on open so keyboard users can operate it, and
  // expose arrow-key navigation + Escape-to-close (the menu is the primary
  // file-operation surface, so it must be reachable without a pointer).
  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button')
    first?.focus()
  }, [])

  function onKeyDown(e: React.KeyboardEvent) {
    const btns = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    if (btns.length === 0) return
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      btns[(idx + 1 + btns.length) % btns.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      btns[(idx - 1 + btns.length) % btns.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      btns[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      btns[btns.length - 1]?.focus()
    }
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      className="fixed z-50 min-w-[160px] bg-white bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] rounded-md shadow-xl py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{ top: y, left: x }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          role="menuitem"
          onClick={() => {
            item.onClick()
            onClose()
          }}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-[var(--notation-border)] focus:bg-[var(--notation-border)] outline-none ${item.danger ? 'text-[var(--notation-danger)] dark:text-[var(--notation-danger)]' : 'text-[var(--notation-fg)]'}`}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}
