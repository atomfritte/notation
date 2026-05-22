import { useEffect, useMemo, useState } from 'react'
import { Palette, Check, Trash2, X, Sparkles, Pencil, Download, RotateCcw, Save } from 'lucide-react'
import {
  type Theme,
  BUILTIN_THEMES,
  applyTheme,
  loadCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  getActiveThemeName,
  setActiveThemeName,
  findTheme,
  importVSCodeTheme,
} from '../lib/theme'

type Props = { onClose: () => void }

type TabKey = 'presets' | 'edit' | 'import'

/**
 * ThemePalette v2 — tabbed editor.
 *
 *   Presets  — built-ins + saved customs, click a card to apply.
 *   Edit     — sliders/pickers for accent, bg, bg-elevated, plus name + Save.
 *              Live preview applies the moment the user changes a swatch.
 *   Import   — paste a VS Code colour-theme JSON; we extract the three
 *              colours we model and load them into the Edit tab.
 *
 * The currently-previewed theme lives in component state; persistence happens
 * on Save (writes to custom themes + sets as active) or on picking a preset
 * (sets as active). Picking a preset jumps the Edit tab's working copy to
 * that theme too, so "preset → tweak → save" feels seamless.
 */
export function ThemePalette({ onClose }: Props) {
  const [tab, setTab] = useState<TabKey>('presets')
  const [activeName, setActiveName] = useState<string>(getActiveThemeName())
  const [customs, setCustoms] = useState<Theme[]>(loadCustomThemes())
  // Working copy for the Edit tab.
  const [working, setWorking] = useState<Theme>(() => ({ ...findTheme(getActiveThemeName()), builtIn: false }))
  const [importText, setImportText] = useState('')
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function pickTheme(t: Theme) {
    applyTheme(t)
    setActiveThemeName(t.name)
    setActiveName(t.name)
    setWorking({ ...t, builtIn: false })
  }

  function updateWorking(patch: Partial<Theme>) {
    const next = { ...working, ...patch }
    setWorking(next)
    applyTheme(next) // live preview
  }

  function onSaveCustom() {
    const name = working.name.trim()
    if (!name) return
    saveCustomTheme({ ...working, name })
    setCustoms(loadCustomThemes())
    setActiveThemeName(name)
    setActiveName(name)
    setTab('presets')
  }

  function onDeleteCustom(name: string) {
    deleteCustomTheme(name)
    setCustoms(loadCustomThemes())
    if (activeName === name) pickTheme(BUILTIN_THEMES[0])
  }

  function onImportClick() {
    setImportError(null)
    setImportWarnings([])
    try {
      const result = importVSCodeTheme(importText)
      if (!result.theme) throw new Error('Could not parse theme.')
      setWorking({ ...result.theme, builtIn: false })
      applyTheme(result.theme)
      setImportWarnings(result.warnings)
      setTab('edit')
    } catch (e) {
      setImportError(String(e instanceof Error ? e.message : e))
    }
  }

  function revertToActive() {
    const t = findTheme(activeName)
    setWorking({ ...t, builtIn: false })
    applyTheme(t)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150 no-print"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-[var(--notation-bg-elevated)] border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl max-w-2xl w-full animate-in zoom-in-95 duration-150 overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
        style={{ maxHeight: '85vh' }}
      >
        <div className="flex items-start justify-between px-6 pt-6 pb-4">
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

        <nav className="px-6 border-b border-zinc-200 dark:border-zinc-800 flex gap-1 flex-shrink-0">
          <TabBtn label="Presets" icon={<Sparkles size={13} />} active={tab === 'presets'} onClick={() => setTab('presets')} />
          <TabBtn label="Edit"    icon={<Pencil size={13} />}    active={tab === 'edit'}    onClick={() => setTab('edit')} />
          <TabBtn label="Import"  icon={<Download size={13} />}  active={tab === 'import'}  onClick={() => setTab('import')} />
        </nav>

        <div className="px-6 py-5 overflow-y-auto flex-1">
          {tab === 'presets' && (
            <PresetsTab
              activeName={activeName}
              customs={customs}
              onPick={pickTheme}
              onDelete={onDeleteCustom}
            />
          )}
          {tab === 'edit' && (
            <EditTab
              working={working}
              onChange={updateWorking}
              onSave={onSaveCustom}
              onRevert={revertToActive}
            />
          )}
          {tab === 'import' && (
            <ImportTab
              value={importText}
              warnings={importWarnings}
              error={importError}
              onChange={setImportText}
              onImport={onImportClick}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ---- Tabs --------------------------------------------------------------

function TabBtn({
  label, icon, active, onClick,
}: { label: string; icon: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        'px-3 py-2 text-sm font-medium flex items-center gap-1.5 border-b-2 transition-colors ' +
        (active
          ? 'border-[color:var(--notation-accent)] text-zinc-900 dark:text-zinc-100'
          : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200')
      }
    >
      {icon} {label}
    </button>
  )
}

function PresetsTab({
  activeName, customs, onPick, onDelete,
}: {
  activeName: string
  customs: Theme[]
  onPick: (t: Theme) => void
  onDelete: (name: string) => void
}) {
  return (
    <div className="space-y-5">
      <div>
        <SectionHeading label="Built-in" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {BUILTIN_THEMES.map(t => (
            <ThemeCard key={t.name} theme={t} active={activeName === t.name} onClick={() => onPick(t)} />
          ))}
        </div>
      </div>
      {customs.length > 0 && (
        <div>
          <SectionHeading label="Saved" />
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {customs.map(t => (
              <ThemeCard
                key={t.name}
                theme={t}
                active={activeName === t.name}
                onClick={() => onPick(t)}
                onDelete={() => onDelete(t.name)}
              />
            ))}
          </div>
        </div>
      )}
      {customs.length === 0 && (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 italic">
          Pick a preset and tweak it in Edit, or paste a VS&nbsp;Code theme in Import.
        </div>
      )}
    </div>
  )
}

function EditTab({
  working, onChange, onSave, onRevert,
}: {
  working: Theme
  onChange: (patch: Partial<Theme>) => void
  onSave: () => void
  onRevert: () => void
}) {
  return (
    <div className="space-y-5">
      <PreviewCard theme={working} />

      <div className="space-y-3">
        <ColorRow
          label="Accent"
          help="Links, cursor, primary buttons, active states."
          value={working.accent}
          onChange={v => onChange({ accent: v })}
        />
        <ColorRow
          label="Background"
          help="Page body (main content area in dark mode)."
          value={working.bg}
          onChange={v => onChange({ bg: v })}
        />
        <ColorRow
          label="Surface"
          help="Sidebar, modals, and other elevated surfaces."
          value={working.bgElevated}
          onChange={v => onChange({ bgElevated: v })}
        />
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
        <input
          value={working.name}
          onChange={e => onChange({ name: e.target.value })}
          placeholder="Theme name…"
          className="flex-1 px-3 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[var(--notation-bg)] text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--notation-accent-30)]"
        />
        <button
          onClick={onRevert}
          className="p-2 rounded-md text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          title="Discard preview, go back to active theme"
        >
          <RotateCcw size={14} />
        </button>
        <button
          onClick={onSave}
          disabled={!working.name.trim()}
          className="px-3 py-2 rounded-md text-sm font-semibold bg-zinc-900 text-white dark:bg-[color:var(--notation-accent)] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:opacity-90 disabled:opacity-40 transition-colors flex items-center gap-1.5"
        >
          <Save size={14} /> Save
        </button>
      </div>
    </div>
  )
}

function ImportTab({
  value, warnings, error, onChange, onImport,
}: {
  value: string
  warnings: string[]
  error: string | null
  onChange: (s: string) => void
  onImport: () => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Paste a VS&nbsp;Code colour-theme JSON. We extract the accent, the
        editor background, and the sidebar background — everything else is
        ignored. Comments inside the JSON are tolerated.
      </p>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder='{ "name": "Dracula Pro", "colors": { ... } }'
        rows={10}
        spellCheck={false}
        className="w-full px-3 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[var(--notation-bg)] text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[color:var(--notation-accent-30)]"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={onImport}
          disabled={!value.trim()}
          className="px-3 py-2 rounded-md text-sm font-semibold bg-zinc-900 text-white dark:bg-[color:var(--notation-accent)] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:opacity-90 disabled:opacity-40 transition-colors flex items-center gap-1.5"
        >
          <Download size={14} /> Parse &amp; preview
        </button>
        {error && <span className="text-red-500 text-xs">{error}</span>}
      </div>
      {warnings.length > 0 && (
        <ul className="text-xs text-amber-600 dark:text-amber-400 space-y-1">
          {warnings.map((w, i) => <li key={i}>· {w}</li>)}
        </ul>
      )}
    </div>
  )
}

// ---- Sub-components ----------------------------------------------------

function SectionHeading({ label }: { label: string }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
      {label}
    </h3>
  )
}

function ThemeCard({
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
          'w-full rounded-lg border overflow-hidden transition-all text-left ' +
          (active
            ? 'border-[color:var(--notation-accent)] ring-2 ring-[color:var(--notation-accent-30)]'
            : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700')
        }
      >
        <ThemeSwatchHeader theme={theme} />
        <div className="px-2.5 py-2 flex items-center justify-between bg-white dark:bg-[var(--notation-bg-elevated)]">
          <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{theme.name}</span>
          {active && <Check size={12} className="text-[color:var(--notation-accent)] flex-shrink-0" />}
        </div>
      </button>
      {onDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/40 backdrop-blur text-white/80 opacity-0 group-hover:opacity-100 hover:bg-red-500 hover:text-white transition-all flex items-center justify-center"
          aria-label={`Delete ${theme.name}`}
          title="Delete theme"
        >
          <Trash2 size={10} />
        </button>
      )}
    </div>
  )
}

function ThemeSwatchHeader({ theme }: { theme: Theme }) {
  return (
    <div className="h-14 flex" style={{ background: theme.bg }}>
      <div className="w-1/3 h-full" style={{ background: theme.bgElevated }} />
      <div className="flex-1 flex items-center justify-center">
        <div className="w-6 h-6 rounded-full shadow-sm" style={{ background: theme.accent }} />
      </div>
    </div>
  )
}

function PreviewCard({ theme }: { theme: Theme }) {
  // A miniature reproduction of the app chrome using the working colours,
  // so the user can eyeball how the three values play together.
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="flex h-24" style={{ background: theme.bg }}>
        <div className="w-24 p-2 flex flex-col gap-1.5" style={{ background: theme.bgElevated }}>
          <div className="h-2 rounded" style={{ background: theme.accent, width: '70%' }} />
          <div className="h-1.5 rounded bg-white/10" />
          <div className="h-1.5 rounded bg-white/10" />
          <div className="h-1.5 rounded bg-white/10" style={{ width: '60%' }} />
        </div>
        <div className="flex-1 p-3 flex flex-col gap-1.5">
          <div className="h-2.5 rounded bg-white/30" style={{ width: '60%' }} />
          <div className="h-1.5 rounded bg-white/15" style={{ width: '90%' }} />
          <div className="h-1.5 rounded bg-white/15" style={{ width: '80%' }} />
          <div className="flex gap-1 mt-1">
            <div className="px-2 py-0.5 text-[10px] rounded font-semibold" style={{ background: theme.accent, color: '#0a0a0a' }}>
              Button
            </div>
            <div className="px-2 py-0.5 text-[10px] rounded font-mono" style={{ background: 'rgba(255,255,255,0.1)', color: theme.accent }}>
              link
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ColorRow({
  label, help, value, onChange,
}: {
  label: string
  help: string
  value: string
  onChange: (v: string) => void
}) {
  const id = useMemo(() => `color-${label.toLowerCase().replace(/\s+/g, '-')}`, [label])
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="color"
        value={value}
        onChange={e => onChange(e.target.value.toUpperCase())}
        className="w-10 h-10 rounded-md cursor-pointer bg-transparent border border-zinc-200 dark:border-zinc-800 p-0.5 flex-shrink-0"
        aria-label={label}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <label htmlFor={id} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</label>
          <input
            value={value}
            onChange={e => {
              const v = e.target.value.toUpperCase()
              if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) onChange(v)
            }}
            className="px-1.5 py-0.5 text-[11px] font-mono rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[var(--notation-bg)] w-20 focus:outline-none focus:ring-1 focus:ring-[color:var(--notation-accent-40)]"
          />
        </div>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">{help}</p>
      </div>
    </div>
  )
}
