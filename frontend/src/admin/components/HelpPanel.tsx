import { useEffect } from 'react'
import { Keyboard, MoreHorizontal, X } from 'lucide-react'

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
        className="w-full max-w-2xl surface-gradient bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-top-4 duration-150"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--notation-border)]">
          <div className="flex items-center gap-2 text-[var(--notation-fg)] font-semibold">
            <Keyboard size={16} />
            <span>{scope === 'admin' ? 'Help & shortcuts' : 'Keyboard shortcuts'}</span>
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
          {scope === 'admin' && (
            <section className="md:col-span-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--notation-fg-muted)] mb-2">Where things are</h3>
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1.5 text-sm text-[var(--notation-fg)]">
                <li><Dots /> <strong>More</strong> (top right) — this page (favorite, history, read aloud, print), the Space, theme and help</li>
                <li><Dots /> next to the <strong>Space name</strong> — Space tools (ZIP, folder sync, encryption) and sharing, integration, history, activity</li>
                <li><KeyCombo combo={`${MOD}+K`} inline /> — find any page <em>or action</em> by name; start with <code>&gt;</code> for actions only</li>
                <li>The tabs above the page tree — <strong>Pages</strong>, <strong>Favorites</strong>, <strong>Comments</strong></li>
              </ul>
            </section>
          )}
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

function Dots() {
  return <MoreHorizontal size={14} className="inline -mt-0.5 text-[var(--notation-fg-muted)]" aria-label="the ··· button" />
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
        { keys: `${MOD}+K`, label: 'Quick open — any page or action' },
        { keys: `${MOD}+Shift+F`, label: 'Search page titles + full text across the Space' },
        { keys: `${MOD}+\\`, label: 'Toggle sidebar' },
        { keys: 'Alt+N', label: 'Create new page' },
        { keys: 'Alt+A', label: 'Open / close the Claude assistant' },
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
        { keys: `${MOD}+Shift+F`, label: 'Search page titles + full text' },
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

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}
