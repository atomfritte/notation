import { useEffect, useMemo, useState } from 'react'
import { Palette, Check, Trash2, X, Sparkles, Pencil, Download, RotateCcw, Save, Sun, Moon } from 'lucide-react'
import {
  type Theme,
  type ModePalette,
  type HeaderStyle,
  BUILTIN_THEMES,
  applyTheme,
  loadCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  getActiveThemeName,
  setActiveThemeName,
  findTheme,
  importVSCodeTheme,
  getHeaderStyle,
  setHeaderStyle,
} from '../lib/theme'

type Props = { onClose: () => void }

type TabKey = 'presets' | 'edit' | 'import'
type Mode = 'dark' | 'light'

/**
 * ThemePalette v3 — tabbed editor that handles light + dark palettes.
 *
 * Each theme defines THREE colours (accent / bg / surface) for EACH of two
 * modes (dark / light). The Edit tab has a Dark/Light mode toggle at the top
 * so the user only sees three pickers at a time, and a dual preview card
 * shows both modes side-by-side so the user can eyeball the pairing.
 *
 * Imports follow the same rule: a VS-Code theme that declares `"type":"dark"`
 * fills only the dark mode of the working theme, leaving light alone.
 */
export function ThemePalette({ onClose }: Props) {
  const [tab, setTab] = useState<TabKey>('presets')
  const [editMode, setEditMode] = useState<Mode>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  )
  const [activeName, setActiveName] = useState<string>(getActiveThemeName())
  const [customs, setCustoms] = useState<Theme[]>(loadCustomThemes())
  const [working, setWorking] = useState<Theme>(() => deepClone(findTheme(getActiveThemeName())))
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
    setWorking(deepClone(t))
  }

  function updatePalette(mode: Mode, patch: Partial<ModePalette>) {
    const next: Theme = {
      ...working,
      [mode]: { ...working[mode], ...patch },
      builtIn: false,
    }
    setWorking(next)
    applyTheme(next) // live preview, both modes
  }

  function updateName(name: string) {
    setWorking({ ...working, name, builtIn: false })
  }

  function onSaveCustom() {
    const name = working.name.trim()
    if (!name) return
    const t = { ...working, name, builtIn: false }
    saveCustomTheme(t)
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
    setWorking(deepClone(t))
    applyTheme(t)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--notation-backdrop)] backdrop-blur-sm animate-in fade-in duration-150 no-print"
      onClick={onClose}
    >
      <div
        className="surface-elevated surface-gradient bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-xl shadow-2xl max-w-2xl w-full animate-in zoom-in-95 duration-150 overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
        style={{ maxHeight: '88vh' }}
      >
        <div className="flex items-start justify-between px-6 pt-6 pb-4">
          <h2 className="text-xl font-bold text-[var(--notation-fg)] flex items-center gap-2">
            <Palette size={18} className="text-[color:var(--notation-accent)]" /> Themes
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] rounded -mr-1"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="px-6 border-b border-[var(--notation-border)] flex gap-1 flex-shrink-0">
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
              editMode={editMode}
              onChangeMode={setEditMode}
              onChangePalette={updatePalette}
              onChangeName={updateName}
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

function deepClone(t: Theme): Theme {
  return {
    name: t.name,
    dark: { ...t.dark },
    light: { ...t.light },
    builtIn: false,
  }
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
          ? 'border-[color:var(--notation-accent)] text-[var(--notation-fg)]'
          : 'border-transparent text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]')
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
        <div className="text-xs text-[var(--notation-fg-muted)] italic">
          Pick a preset and tweak it in Edit, or paste a VS&nbsp;Code theme in Import.
        </div>
      )}
    </div>
  )
}

function EditTab({
  working, editMode, onChangeMode, onChangePalette, onChangeName, onSave, onRevert,
}: {
  working: Theme
  editMode: Mode
  onChangeMode: (m: Mode) => void
  onChangePalette: (mode: Mode, patch: Partial<ModePalette>) => void
  onChangeName: (name: string) => void
  onSave: () => void
  onRevert: () => void
}) {
  const palette = working[editMode]
  return (
    <div className="space-y-5">
      <DualPreview theme={working} />

      <div className="flex items-center gap-2">
        <ModeToggle active={editMode} onChange={onChangeMode} />
        <span className="text-xs text-[var(--notation-fg-muted)]">
          Editing the <strong className="text-[var(--notation-fg)]">{editMode}</strong> palette
        </span>
      </div>

      <PaletteSection title="Layout">
        <HeaderStyleRow />
      </PaletteSection>

      <PaletteSection title="Content surface">
        <ColorRow label="Accent" help="Links, cursor, primary buttons, active states."
          value={palette.accent} onChange={v => onChangePalette(editMode, { accent: v })} />
        <ColorRow label="Background" help="Page body — the main content area."
          value={palette.bg} onChange={v => onChangePalette(editMode, { bg: v })} />
        <ColorRow label="Subtle background" help="Hover surfaces, alternating rows, inline code highlights."
          value={palette.bgAlt} onChange={v => onChangePalette(editMode, { bgAlt: v })} />
        <ColorRow label="Text" help="Body text, headings, code — primary foreground on content."
          value={palette.fg} onChange={v => onChangePalette(editMode, { fg: v })} />
        <ColorRow label="Muted text" help="Secondary copy — breadcrumbs, captions, hints."
          value={palette.fgMuted} onChange={v => onChangePalette(editMode, { fgMuted: v })} />
        <ColorRow label="Border" help="Dividers + hover background tint on content."
          value={palette.border} onChange={v => onChangePalette(editMode, { border: v })} />
      </PaletteSection>

      <PaletteSection title="Chrome (sidebars, header, modals)">
        <ColorRow label="Chrome background" help="Sidebars, header, outline + comments panels, modals."
          value={palette.bgElevated} onChange={v => onChangePalette(editMode, { bgElevated: v })} />
        <ColorRow label="Chrome text" help="Primary text painted on the chrome surface."
          value={palette.chromeFg} onChange={v => onChangePalette(editMode, { chromeFg: v })} />
        <ColorRow label="Chrome muted text" help="Captions and hints on the chrome surface."
          value={palette.chromeFgMuted} onChange={v => onChangePalette(editMode, { chromeFgMuted: v })} />
        <ColorRow label="Chrome border" help="Dividers inside sidebars / header / modals."
          value={palette.chromeBorder} onChange={v => onChangePalette(editMode, { chromeBorder: v })} />
      </PaletteSection>

      <PaletteSection title="Status">
        <ColorRow label="Danger" help="Errors, destructive actions (delete buttons, validation messages)."
          value={palette.danger} onChange={v => onChangePalette(editMode, { danger: v })} />
        <ColorRow label="Warning" help="Cautions, expiring tokens, dirty-state hints."
          value={palette.warning} onChange={v => onChangePalette(editMode, { warning: v })} />
        <ColorRow label="Success" help="Confirmations, saved indicators."
          value={palette.success} onChange={v => onChangePalette(editMode, { success: v })} />
        <ColorRow label="Info" help="Neutral informational hints and links."
          value={palette.info} onChange={v => onChangePalette(editMode, { info: v })} />
      </PaletteSection>

      <PaletteSection title="Misc">
        <ColorRow label="Text on accent" help="Text painted on top of accent (primary buttons, badges)."
          value={palette.fgOnAccent} onChange={v => onChangePalette(editMode, { fgOnAccent: v })} />
        <BackdropRow
          value={palette.backdrop}
          onChange={v => onChangePalette(editMode, { backdrop: v })}
        />
      </PaletteSection>

      <div className="flex items-center gap-2 pt-2 border-t border-[var(--notation-border)]">
        <input
          value={working.name}
          onChange={e => onChangeName(e.target.value)}
          placeholder="Theme name…"
          className="flex-1 px-3 py-2 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)] text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--notation-accent-30)]"
        />
        <button
          onClick={onRevert}
          className="p-2 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-border)] transition-colors"
          title="Discard preview, go back to active theme"
        >
          <RotateCcw size={14} />
        </button>
        <button
          onClick={onSave}
          disabled={!working.name.trim()}
          className="px-3 py-2 rounded-md text-sm font-semibold bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:bg-[var(--notation-bg-alt)] dark:hover:opacity-90 disabled:opacity-40 transition-colors flex items-center gap-1.5"
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
      <p className="text-sm text-[var(--notation-fg-muted)]">
        Paste a VS&nbsp;Code colour-theme JSON. We extract the accent, the
        editor background, and the sidebar background. The theme's
        <code className="px-1 py-0.5 rounded bg-[var(--notation-bg-alt)] text-[11px] mx-1">"type"</code>
        field (dark/light) decides which mode of your theme is filled —
        the other mode keeps its current palette. Comments inside the
        JSON are tolerated.
      </p>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder='{ "type": "dark", "name": "Tokyo Night", "colors": { ... } }'
        rows={10}
        spellCheck={false}
        className="w-full px-3 py-2 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)] text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[color:var(--notation-accent-30)]"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={onImport}
          disabled={!value.trim()}
          className="px-3 py-2 rounded-md text-sm font-semibold bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:bg-[var(--notation-bg-alt)] dark:hover:opacity-90 disabled:opacity-40 transition-colors flex items-center gap-1.5"
        >
          <Download size={14} /> Parse &amp; preview
        </button>
        {error && <span className="text-[var(--notation-danger)] text-xs">{error}</span>}
      </div>
      {warnings.length > 0 && (
        <ul className="text-xs text-[var(--notation-warning)] dark:text-[var(--notation-warning)] space-y-1">
          {warnings.map((w, i) => <li key={i}>· {w}</li>)}
        </ul>
      )}
    </div>
  )
}

// ---- Sub-components ----------------------------------------------------

function SectionHeading({ label }: { label: string }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--notation-fg-muted)] mb-2">
      {label}
    </h3>
  )
}

function ModeToggle({ active, onChange }: { active: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="inline-flex rounded-md border border-[var(--notation-border)] p-0.5 bg-[var(--notation-bg)]">
      {([
        { k: 'dark',  icon: <Moon size={12} />, label: 'Dark' },
        { k: 'light', icon: <Sun size={12} />,  label: 'Light' },
      ] as const).map(opt => (
        <button
          key={opt.k}
          onClick={() => onChange(opt.k)}
          className={
            'px-2.5 py-1 text-xs font-medium rounded flex items-center gap-1 transition-colors ' +
            (active === opt.k
              ? 'bg-[var(--notation-bg-alt)] bg-[var(--notation-bg-alt)] text-[var(--notation-fg)]'
              : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]')
          }
        >
          {opt.icon} {opt.label}
        </button>
      ))}
    </div>
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
            : 'border-[var(--notation-border)] hover:border-[var(--notation-border)] dark:hover:border-[var(--notation-border)]')
        }
      >
        <div className="flex h-14">
          <ThemeMiniSwatch palette={theme.dark} />
          <ThemeMiniSwatch palette={theme.light} />
        </div>
        <div className="px-2.5 py-2 flex items-center justify-between bg-[var(--notation-bg-elevated)]">
          <span className="text-xs font-medium text-[var(--notation-fg)] truncate">{theme.name}</span>
          {active && <Check size={12} className="text-[color:var(--notation-accent)] flex-shrink-0" />}
        </div>
      </button>
      {onDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-[var(--notation-backdrop)] backdrop-blur text-white/80 opacity-0 group-hover:opacity-100 hover:bg-[var(--notation-danger)] hover:text-white transition-all flex items-center justify-center"
          aria-label={`Delete ${theme.name}`}
          title="Delete theme"
        >
          <Trash2 size={10} />
        </button>
      )}
    </div>
  )
}

function ThemeMiniSwatch({ palette }: { palette: ModePalette }) {
  // Half of a theme card: a tiny representation of one mode (sidebar +
  // body + accent dot).
  return (
    <div className="flex-1 flex" style={{ background: palette.bg }}>
      <div className="w-1/3" style={{ background: palette.bgElevated }} />
      <div className="flex-1 flex items-center justify-center">
        <div className="w-3.5 h-3.5 rounded-full shadow-sm" style={{ background: palette.accent }} />
      </div>
    </div>
  )
}

function DualPreview({ theme }: { theme: Theme }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <PreviewCard label="Dark"  palette={theme.dark}  isDark />
      <PreviewCard label="Light" palette={theme.light} />
    </div>
  )
}

function PreviewCard({ label, palette, isDark }: { label: string; palette: ModePalette; isDark?: boolean }) {
  const textColor = isDark ? '#FFFFFFCC' : '#000000CC'
  const lineColor = isDark ? '#FFFFFF26' : '#00000026'
  return (
    <div className="rounded-lg overflow-hidden border border-[var(--notation-border)]">
      <div className="flex h-24" style={{ background: palette.bg }}>
        <div className="w-1/3 p-2 flex flex-col gap-1.5" style={{ background: palette.bgElevated }}>
          <div className="h-1.5 rounded" style={{ background: palette.accent, width: '80%' }} />
          <div className="h-1 rounded" style={{ background: lineColor }} />
          <div className="h-1 rounded" style={{ background: lineColor, width: '70%' }} />
          <div className="h-1 rounded" style={{ background: lineColor }} />
        </div>
        <div className="flex-1 p-2 flex flex-col gap-1.5">
          <div className="h-2 rounded" style={{ background: textColor, width: '60%' }} />
          <div className="h-1 rounded" style={{ background: lineColor, width: '90%' }} />
          <div className="h-1 rounded" style={{ background: lineColor, width: '80%' }} />
          <div className="flex gap-1 mt-auto">
            <div
              className="px-1.5 py-0.5 text-[9px] rounded font-semibold"
              style={{ background: palette.accent, color: isDark ? '#0a0a0a' : '#ffffff' }}
            >
              Aa
            </div>
            <div
              className="px-1.5 py-0.5 text-[9px] rounded font-mono"
              style={{ color: palette.accent, border: `1px solid ${palette.accent}` }}
            >
              link
            </div>
          </div>
        </div>
      </div>
      <div className="px-2 py-1 text-[10px] uppercase tracking-wider font-semibold bg-[var(--notation-bg-elevated)] text-[var(--notation-fg-muted)]">
        {label}
      </div>
    </div>
  )
}

// HeaderStyleRow toggles the reading-pane header between chrome (default —
// matches the sidebars) and content (matches the page body, flush reading
// area). The setter dispatches the custom event so any mounted SpaceView
// re-renders without needing a context.
function HeaderStyleRow() {
  const [style, setStyle] = useState<HeaderStyle>(() => getHeaderStyle())
  function pick(s: HeaderStyle) {
    setStyle(s)
    setHeaderStyle(s)
  }
  return (
    <div className="flex items-start gap-3">
      <div className="w-10 h-10 rounded-md border border-[var(--notation-border)] overflow-hidden flex-shrink-0">
        {/* Mini diagram: top strip = header, bottom = page body. The strip
            colour reflects which surface the header is currently following. */}
        <div className="h-3" style={{ background: style === 'chrome' ? 'var(--notation-bg-elevated)' : 'var(--notation-bg)' }} />
        <div className="h-7" style={{ background: 'var(--notation-bg)' }} />
      </div>
      <div className="flex-1 min-w-0">
        <label className="text-sm font-medium text-[var(--notation-fg)]">Header style</label>
        <p className="text-[11px] text-[var(--notation-fg-muted)] mt-0.5 mb-2">
          Reading-pane header follows the sidebar (chrome) or the page body (content).
        </p>
        <div className="inline-flex rounded-md border border-[var(--notation-border)] p-0.5 bg-[var(--notation-bg)]">
          {(['chrome', 'content'] as const).map(opt => (
            <button
              key={opt}
              onClick={() => pick(opt)}
              className={
                'px-2.5 py-1 text-xs font-medium rounded transition-colors ' +
                (style === opt
                  ? 'bg-[var(--notation-bg-alt)] text-[var(--notation-fg)]'
                  : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]')
              }
            >
              {opt === 'chrome' ? 'Follow sidebars' : 'Follow content'}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function PaletteSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--notation-fg-muted)] border-b border-[var(--notation-border)] pb-1.5">
        {title}
      </h4>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

// Backdrop is the only token that isn't a plain hex — it's an rgba(...) so a
// scrim can be partially transparent. The row exposes a hex picker for the
// colour and a 0-100 slider for the alpha, then composes them back into an
// rgba string for storage.
function BackdropRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsed = parseRGBA(value)
  const hex = parsed?.hex ?? '#000000'
  const alpha = parsed?.alpha ?? 0.4
  return (
    <div className="flex items-start gap-3">
      <input
        type="color"
        value={hex}
        onChange={e => onChange(toRGBA(e.target.value, alpha))}
        className="w-10 h-10 rounded-md cursor-pointer bg-transparent border border-[var(--notation-border)] p-0.5 flex-shrink-0"
        aria-label="Backdrop colour"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <label className="text-sm font-medium text-[var(--notation-fg)]">Modal backdrop</label>
          <span className="px-1.5 py-0.5 text-[11px] font-mono rounded border border-[var(--notation-border)] bg-[var(--notation-bg)] text-[var(--notation-fg-muted)]">
            {Math.round(alpha * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(alpha * 100)}
          onChange={e => onChange(toRGBA(hex, Number(e.target.value) / 100))}
          className="w-full mt-1 accent-[color:var(--notation-accent)]"
          aria-label="Backdrop opacity"
        />
        <p className="text-[11px] text-[var(--notation-fg-muted)] mt-0.5">Scrim painted behind modals (Themes, Command Palette, …).</p>
      </div>
    </div>
  )
}

function parseRGBA(s: string): { hex: string; alpha: number } | null {
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (!m) return null
  const r = Math.min(255, parseInt(m[1], 10))
  const g = Math.min(255, parseInt(m[2], 10))
  const b = Math.min(255, parseInt(m[3], 10))
  const a = m[4] !== undefined ? Math.min(1, Math.max(0, parseFloat(m[4]))) : 1
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0').toUpperCase()).join('')
  return { hex, alpha: a }
}

function toRGBA(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`
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
        className="w-10 h-10 rounded-md cursor-pointer bg-transparent border border-[var(--notation-border)] p-0.5 flex-shrink-0"
        aria-label={label}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <label htmlFor={id} className="text-sm font-medium text-[var(--notation-fg)]">{label}</label>
          <input
            value={value}
            onChange={e => {
              const v = e.target.value.toUpperCase()
              if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) onChange(v)
            }}
            className="px-1.5 py-0.5 text-[11px] font-mono rounded border border-[var(--notation-border)] bg-[var(--notation-bg)] w-20 focus:outline-none focus:ring-1 focus:ring-[color:var(--notation-accent-40)]"
          />
        </div>
        <p className="text-[11px] text-[var(--notation-fg-muted)] mt-0.5">{help}</p>
      </div>
    </div>
  )
}
