import { useEffect, useState } from 'react'
import { Palette, Plus, Check, Trash2, X } from 'lucide-react'
import {
  type Theme,
  BUILTIN_THEMES,
  applyTheme,
  loadCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  getActiveThemeName,
  setActiveThemeName,
} from '../lib/theme'

type Props = {
  onClose: () => void
}

/**
 * ThemePalette — modal for picking, creating and saving accent themes.
 *
 * Left column: six built-in themes (read-only swatches).
 * Right column: user-saved custom themes + the picker form. The picker is
 * a native <input type="color"> plus a name field; saving overrides any
 * existing theme of the same name. The active theme is highlighted with a
 * check and persists across reloads via localStorage.
 *
 * Theme application is instant — clicking a swatch immediately pushes the
 * CSS variables to :root, so the user can preview each option without
 * having to confirm. Closing the modal commits the choice as the active
 * theme name.
 */
export function ThemePalette({ onClose }: Props) {
  const [active, setActive] = useState<string>(getActiveThemeName())
  const [customs, setCustoms] = useState<Theme[]>(loadCustomThemes())
  const [newName, setNewName] = useState('')
  const [newAccent, setNewAccent] = useState('#7DD3FC')

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function pickTheme(t: Theme) {
    applyTheme(t)
    setActiveThemeName(t.name)
    setActive(t.name)
  }

  function onSaveCustom() {
    const name = newName.trim()
    if (!name) return
    const t: Theme = { name, accent: newAccent.toUpperCase() }
    saveCustomTheme(t)
    setCustoms(loadCustomThemes())
    pickTheme(t)
    setNewName('')
  }

  function onDeleteCustom(name: string) {
    deleteCustomTheme(name)
    setCustoms(loadCustomThemes())
    if (active === name) {
      // Fall back to Lime.
      pickTheme(BUILTIN_THEMES[0])
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150 no-print"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl max-w-xl w-full p-6 animate-in zoom-in-95 duration-150"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Palette size={18} className="text-[color:var(--notation-accent)]" /> Themes
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 rounded -mr-1"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-5">
          Pick an accent colour. The whole app re-skins live; the choice persists across sessions.
        </p>

        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
          Built-in
        </h3>
        <div className="grid grid-cols-3 gap-2 mb-6">
          {BUILTIN_THEMES.map(t => (
            <Swatch key={t.name} theme={t} active={active === t.name} onClick={() => pickTheme(t)} />
          ))}
        </div>

        {customs.length > 0 && (
          <>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
              Saved
            </h3>
            <div className="grid grid-cols-3 gap-2 mb-6">
              {customs.map(t => (
                <Swatch
                  key={t.name}
                  theme={t}
                  active={active === t.name}
                  onClick={() => pickTheme(t)}
                  onDelete={() => onDeleteCustom(t.name)}
                />
              ))}
            </div>
          </>
        )}

        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
          Custom
        </h3>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={newAccent}
            onChange={e => setNewAccent(e.target.value)}
            className="w-10 h-10 rounded-md cursor-pointer bg-transparent border border-zinc-200 dark:border-zinc-800 p-0.5"
            aria-label="Pick accent colour"
          />
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Theme name…"
            className="flex-1 px-3 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--notation-accent-30)] focus:border-zinc-300 dark:focus:border-zinc-700"
            onKeyDown={e => {
              if (e.key === 'Enter') onSaveCustom()
            }}
          />
          <button
            onClick={onSaveCustom}
            disabled={!newName.trim()}
            className="px-3 py-2 rounded-md text-sm font-semibold bg-zinc-900 text-white dark:bg-[color:var(--notation-accent)] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:opacity-90 disabled:opacity-40 transition-colors flex items-center gap-1.5"
          >
            <Plus size={14} /> Save
          </button>
        </div>
      </div>
    </div>
  )
}

function Swatch({
  theme, active, onClick, onDelete,
}: {
  theme: Theme
  active: boolean
  onClick: () => void
  onDelete?: () => void
}) {
  return (
    <div className="relative group">
      <button
        onClick={onClick}
        className={
          'w-full flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-all ' +
          (active
            ? 'border-zinc-900 dark:border-[color:var(--notation-accent)] bg-zinc-50 dark:bg-zinc-800/50'
            : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/30')
        }
        title={theme.accent}
      >
        <span
          className="w-5 h-5 rounded-full shadow-inner flex-shrink-0"
          style={{ backgroundColor: theme.accent }}
        />
        <span className="truncate flex-1 text-left text-zinc-700 dark:text-zinc-200">{theme.name}</span>
        {active && <Check size={14} className="text-[color:var(--notation-accent)]" />}
      </button>
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 opacity-0 group-hover:opacity-100 hover:bg-red-500 hover:text-white transition-all flex items-center justify-center"
          aria-label={`Delete ${theme.name}`}
          title="Delete theme"
        >
          <Trash2 size={10} />
        </button>
      )}
    </div>
  )
}
