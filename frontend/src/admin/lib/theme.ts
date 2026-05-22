/**
 * Theme system — three-colour palette.
 *
 *   accent       — links / cursor / highlight / primary buttons
 *   bg           — page background (dark-mode body)
 *   bgElevated   — sidebar, modal, popover surfaces
 *
 * Tailwind classes that need to react to themes use the arbitrary-value
 * syntax, e.g. `dark:bg-[var(--notation-bg)]`. The accent has pre-baked
 * alpha siblings so `dark:bg-[color:var(--notation-accent-30)]` works
 * without a Tailwind opacity modifier (which can't compose with `var()`
 * inside `@apply`).
 *
 * Storage:
 *   notation_active_theme  → theme name (string)
 *   notation_themes        → user-saved Theme[] (custom + imports)
 */

export type Theme = {
  name: string
  accent: string       // 6-digit hex with leading #
  bg: string           // 6-digit hex
  bgElevated: string   // 6-digit hex
  builtIn?: boolean
}

const DARK_BG: Pick<Theme, 'bg' | 'bgElevated'> = {
  bg: '#0a0a0a',
  bgElevated: '#111111',
}

// Six "accent-only" themes inherit the default dark zinc surfaces.
// Four "world" themes ship their own full backgrounds (Dracula, Monokai,
// Solarized, Nord) so the user can flip the entire app's mood in one click.
export const BUILTIN_THEMES: Theme[] = [
  { name: 'Lime',      accent: '#BFF355', ...DARK_BG, builtIn: true },
  { name: 'Sky',       accent: '#7DD3FC', ...DARK_BG, builtIn: true },
  { name: 'Rose',      accent: '#FB7185', ...DARK_BG, builtIn: true },
  { name: 'Amber',     accent: '#FCD34D', ...DARK_BG, builtIn: true },
  { name: 'Violet',    accent: '#C4B5FD', ...DARK_BG, builtIn: true },
  { name: 'Mint',      accent: '#6EE7B7', ...DARK_BG, builtIn: true },
  { name: 'Dracula',   accent: '#BD93F9', bg: '#282A36', bgElevated: '#21222C', builtIn: true },
  { name: 'Monokai',   accent: '#A6E22E', bg: '#272822', bgElevated: '#1E1F1C', builtIn: true },
  { name: 'Solarized', accent: '#268BD2', bg: '#002B36', bgElevated: '#003B49', builtIn: true },
  { name: 'Nord',      accent: '#88C0D0', bg: '#2E3440', bgElevated: '#3B4252', builtIn: true },
]

const STORE_THEMES = 'notation_themes'
const STORE_ACTIVE = 'notation_active_theme'

const HEX_RE = /^#[0-9A-Fa-f]{6}$/

function isValidTheme(t: any): t is Theme {
  return t && typeof t.name === 'string'
    && HEX_RE.test(t.accent)
    && HEX_RE.test(t.bg)
    && HEX_RE.test(t.bgElevated)
}

export function listThemes(): Theme[] {
  return [...BUILTIN_THEMES, ...loadCustomThemes()]
}

export function loadCustomThemes(): Theme[] {
  try {
    const raw = localStorage.getItem(STORE_THEMES)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isValidTheme) : []
  } catch { return [] }
}

export function saveCustomTheme(t: Theme): void {
  const custom = loadCustomThemes().filter(x => x.name !== t.name)
  custom.push({ name: t.name, accent: t.accent.toUpperCase(), bg: t.bg.toUpperCase(), bgElevated: t.bgElevated.toUpperCase() })
  localStorage.setItem(STORE_THEMES, JSON.stringify(custom))
}

export function deleteCustomTheme(name: string): void {
  const next = loadCustomThemes().filter(t => t.name !== name)
  localStorage.setItem(STORE_THEMES, JSON.stringify(next))
}

export function getActiveThemeName(): string {
  return localStorage.getItem(STORE_ACTIVE) || 'Lime'
}

export function setActiveThemeName(name: string): void {
  localStorage.setItem(STORE_ACTIVE, name)
}

export function findTheme(name: string): Theme {
  return listThemes().find(t => t.name === name) || BUILTIN_THEMES[0]
}

/** Push the theme into :root. Safe to call any time; no React re-render
 *  needed since the consumers all read via CSS `var()`. */
export function applyTheme(t: Theme): void {
  const root = document.documentElement
  root.style.setProperty('--notation-accent', t.accent)
  // Pre-baked alpha siblings.
  for (const pct of [10, 15, 20, 30, 40, 50] as const) {
    const a = Math.round((pct / 100) * 255).toString(16).padStart(2, '0').toUpperCase()
    root.style.setProperty(`--notation-accent-${pct}`, '#' + t.accent.slice(1) + a)
  }
  root.style.setProperty('--notation-bg', t.bg)
  root.style.setProperty('--notation-bg-elevated', t.bgElevated)
}

export function initTheme(): Theme {
  const t = findTheme(getActiveThemeName())
  applyTheme(t)
  return t
}

// ---- VS Code theme import ----------------------------------------------
//
// We extract the three colours we model from the `colors` block of a
// VS Code colour-theme JSON. The keys are tried in priority order so we
// pick the most semantically appropriate value present. Tokens and syntax
// rules are ignored (we don't theme the markdown viewer with them).

export type VSCodeImportResult = {
  theme: Theme
  warnings: string[]
}

export function importVSCodeTheme(raw: unknown): VSCodeImportResult {
  const json = typeof raw === 'string' ? safeParseJSON(raw) : raw
  const colors = ((json as any)?.colors || {}) as Record<string, string>
  const warnings: string[] = []
  const name = ((json as any)?.name as string | undefined) || 'Imported'

  const accent = pickHex(colors, [
    'button.background',
    'focusBorder',
    'editorCursor.foreground',
    'list.activeSelectionForeground',
    'activityBarBadge.background',
    'inputOption.activeBorder',
    'tab.activeBorderTop',
  ])
  const bg = pickHex(colors, [
    'editor.background',
    'workbench.background',
    'panel.background',
  ])
  const bgElevated = pickHex(colors, [
    'sideBar.background',
    'activityBar.background',
    'editorGroupHeader.tabsBackground',
    'titleBar.activeBackground',
    'panel.background',
  ])

  if (!accent) warnings.push('No accent colour found in the theme — keeping the previous accent.')
  if (!bg) warnings.push('No editor.background found — keeping the previous page background.')
  if (!bgElevated) warnings.push('No sidebar background found — falling back to the page background.')

  const current = findTheme(getActiveThemeName())
  return {
    theme: {
      name,
      accent: accent || current.accent,
      bg: bg || current.bg,
      bgElevated: bgElevated || bg || current.bgElevated,
    },
    warnings,
  }
}

function pickHex(colors: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const raw = colors[k]
    if (typeof raw === 'string' && /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(raw)) {
      // Strip 8-digit (#RRGGBBAA) → keep RGB only.
      return '#' + raw.slice(1, 7).toUpperCase()
    }
  }
  return null
}

function safeParseJSON(s: string): unknown {
  try {
    // Allow VS Code's JSON-with-comments by stripping `//…` and `/* … */`.
    const cleaned = s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    return JSON.parse(cleaned)
  } catch { return null }
}
