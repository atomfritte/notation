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

  return (
    <div 
      ref={menuRef}
      className="fixed z-50 min-w-[160px] bg-white dark:bg-zinc-900 border border-[var(--notation-border)] rounded-md shadow-xl py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{ top: y, left: x }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => {
            item.onClick()
            onClose()
          }}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-[var(--notation-border)] ${item.danger ? 'text-red-600 dark:text-red-400' : 'text-[var(--notation-fg)]'}`}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}
