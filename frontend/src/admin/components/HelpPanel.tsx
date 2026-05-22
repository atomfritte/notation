import { useEffect } from 'react'
import { Keyboard, X } from 'lucide-react'

type Props = {
  open: boolean
  onClose: () => void
  /** Restrict the listed shortcuts. The admin view lists everything; the share
   *  view only lists keys that actually do something in read-only mode. */
  scope?: 'admin' | 'share'
}

type Shortcut = { keys: string; label: string }
type Group = { title: string; items: Shortcut[] }

const MOD = isMac() ? '⌘' : 'Ctrl'

/**
 * HelpPanel: a single source-of-truth modal listing every keyboard shortcut
 * the app reacts to. Both SpaceView (admin) and share App.tsx open this on
 * "?" or via a header button. Keep the lists in this file in sync with the
 * actual key handlers — if you add a shortcut, add the entry too.
 */
export function HelpPanel({ open, onClose, scope = 'admin' }: Props) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const groups: Group[] = scope === 'admin' ? adminGroups() : shareGroups()

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[8vh] bg-[var(--notation-backdrop)] backdrop-blur-sm animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-top-4 duration-150"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--notation-border)]">
          <div className="flex items-center gap-2 text-[var(--notation-fg)] font-semibold">
            <Keyboard size={16} />
            <span>Keyboard shortcuts</span>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] p-1 rounded-md hover:bg-[var(--notation-bg-alt)]"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
          {groups.map(g => (
            <section key={g.title}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--notation-fg-muted)] mb-2">
                {g.title}
              </h3>
              <ul className="space-y-1.5">
                {g.items.map(it => (
                  <li
                    key={it.keys + it.label}
                    className="flex items-center justify-between gap-3 text-sm text-[var(--notation-fg)]"
                  >
                    <span className="truncate">{it.label}</span>
                    <KeyCombo combo={it.keys} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="px-5 py-2 border-t border-[var(--notation-border)] text-[11px] text-[var(--notation-fg-muted)] flex items-center justify-between">
          <span>
            Press <KeyCombo combo="?" inline /> any time to reopen this list.
          </span>
          <span>
            <KeyCombo combo="Esc" inline /> to close
          </span>
        </div>
      </div>
    </div>
  )
}

function KeyCombo({ combo, inline = false }: { combo: string; inline?: boolean }) {
  const parts = combo.split('+').map(p => p.trim()).filter(Boolean)
  return (
    <span className={'inline-flex items-center gap-1 ' + (inline ? '' : 'flex-shrink-0')}>
      {parts.map((p, i) => (
        <kbd
          key={i}
          className="px-1.5 py-0.5 text-[10px] font-mono font-semibold text-[var(--notation-fg)] bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] rounded-md shadow-[inset_0_-1px_0_0_var(--notation-border)]"
        >
          {p}
        </kbd>
      ))}
    </span>
  )
}

function adminGroups(): Group[] {
  return [
    {
      title: 'Navigation',
      items: [
        { keys: `${MOD}+K`, label: 'Quick open — jump to any page' },
        { keys: `${MOD}+Shift+F`, label: 'Full-text search across the Space' },
        { keys: `${MOD}+\\`, label: 'Toggle sidebar' },
        { keys: 'Alt+N', label: 'Create new page' },
        { keys: '?', label: 'Show this help' },
      ],
    },
    {
      title: 'Inside lists & pickers',
      items: [
        { keys: '↑ / ↓', label: 'Move selection' },
        { keys: 'Enter', label: 'Open / confirm' },
        { keys: 'Esc', label: 'Close the modal' },
      ],
    },
    {
      title: 'Editor (Markdown)',
      items: [
        { keys: `${MOD}+S`, label: 'Save the page' },
        { keys: `${MOD}+B`, label: 'Bold' },
        { keys: `${MOD}+I`, label: 'Italic' },
        { keys: `${MOD}+E`, label: 'Highlight (wraps in <mark>)' },
        { keys: '[ [', label: 'Open the wiki-link picker' },
      ],
    },
    {
      title: 'Reading view',
      items: [
        { keys: `${MOD}+P`, label: 'Print the current page' },
        { keys: 'Click ↗ File', label: 'Open the linked file in the Space' },
        { keys: 'Right-click', label: 'Context menu (file tree, prose, etc.)' },
      ],
    },
  ]
}

function shareGroups(): Group[] {
  return [
    {
      title: 'Navigation',
      items: [
        { keys: `${MOD}+K`, label: 'Quick open — jump to any page' },
        { keys: `${MOD}+Shift+F`, label: 'Full-text search' },
        { keys: `${MOD}+\\`, label: 'Toggle sidebar' },
        { keys: '?', label: 'Show this help' },
      ],
    },
    {
      title: 'Inside lists & pickers',
      items: [
        { keys: '↑ / ↓', label: 'Move selection' },
        { keys: 'Enter', label: 'Open / confirm' },
        { keys: 'Esc', label: 'Close the modal' },
      ],
    },
    {
      title: 'Reading view',
      items: [
        { keys: `${MOD}+P`, label: 'Print the current page' },
        { keys: 'Click ↗ File', label: 'Open the linked file in the Space' },
      ],
    },
  ]
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}
