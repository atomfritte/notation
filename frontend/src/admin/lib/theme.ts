/**
 * Theme system — three colours × two modes.
 *
 * Every theme defines a full palette for BOTH dark and light mode:
 *
 *   { name,
 *     dark:  { accent, bg, bgElevated },
 *     light: { accent, bg, bgElevated } }
 *
 * `accent` drives links/cursor/buttons.
 * `bg` is the main content surface.
 * `bgElevated` is the sidebar / header / modal surface, deliberately distinct
 * from `bg` so the chrome reads as chrome.
 *
 * applyTheme() writes a dynamic <style> tag with both `:root` and `.dark`
 * scopes, so flipping the `.dark` class on the documentElement is enough to
 * swap palettes without re-applying. Consumers reference the colours via
 * `bg-[var(--notation-bg)]` and friends (no `dark:` prefix needed).
 *
 * Storage:
 *   notation_active_theme  → theme name
 *   notation_themes        → user-saved Theme[] (custom + VS-Code imports)
 */

export type ModePalette = {
  accent: string      // 6-digit hex
  bg: string          // 6-digit hex
  bgElevated: string  // 6-digit hex
}

export type Theme = {
  name: string
  dark: ModePalette
  light: ModePalette
  builtIn?: boolean
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/
function isValidPalette(p: any): p is ModePalette {
  return p && HEX_RE.test(p.accent) && HEX_RE.test(p.bg) && HEX_RE.test(p.bgElevated)
}
function isValidTheme(t: any): t is Theme {
  return t && typeof t.name === 'string' && isValidPalette(t.dark) && isValidPalette(t.light)
}

// ---- Built-ins -----------------------------------------------------------
//
// The six "tint" themes share neutral dark/light surfaces and only differ in
// accent. The four "world" themes ship full palettes inspired by popular
// editor themes; the light variants are best-effort companions.

const NEUTRAL_DARK  = { bg: '#0a0a0a', bgElevated: '#111111' } as const
const NEUTRAL_LIGHT = { bg: '#ffffff', bgElevated: '#fafafa' } as const

function tint(name: string, dark: string, light: string): Theme {
  return {
    name,
    builtIn: true,
    dark:  { accent: dark,  ...NEUTRAL_DARK  },
    light: { accent: light, ...NEUTRAL_LIGHT },
  }
}

export const BUILTIN_THEMES: Theme[] = [
  tint('Lime',   '#BFF355', '#65A30D'),
  tint('Sky',    '#7DD3FC', '#0284C7'),
  tint('Rose',   '#FB7185', '#E11D48'),
  tint('Amber',  '#FCD34D', '#D97706'),
  tint('Violet', '#C4B5FD', '#7C3AED'),
  tint('Mint',   '#6EE7B7', '#059669'),
  {
    name: 'Dracula', builtIn: true,
    dark:  { accent: '#BD93F9', bg: '#282A36', bgElevated: '#21222C' },
    light: { accent: '#6F42C1', bg: '#F8F8F2', bgElevated: '#ECECE8' },
  },
  {
    name: 'Monokai', builtIn: true,
    dark:  { accent: '#A6E22E', bg: '#272822', bgElevated: '#1E1F1C' },
    light: { accent: '#75A300', bg: '#FAFAFA', bgElevated: '#F0F0EE' },
  },
  {
    name: 'Solarized', builtIn: true,
    dark:  { accent: '#268BD2', bg: '#002B36', bgElevated: '#003B49' },
    light: { accent: '#268BD2', bg: '#FDF6E3', bgElevated: '#EEE8D5' },
  },
  {
    name: 'Nord', builtIn: true,
    dark:  { accent: '#88C0D0', bg: '#2E3440', bgElevated: '#3B4252' },
    light: { accent: '#5E81AC', bg: '#ECEFF4', bgElevated: '#E5E9F0' },
  },
]

// ---- Storage -------------------------------------------------------------

const STORE_THEMES = 'notation_themes'
const STORE_ACTIVE = 'notation_active_theme'

export function listThemes(): Theme[] {
  return [...BUILTIN_THEMES, ...loadCustomThemes()]
}

export function loadCustomThemes(): Theme[] {
  try {
    const raw = localStorage.getItem(STORE_THEMES)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(migrateLegacyTheme)
      .filter((t): t is Theme => isValidTheme(t))
  } catch { return [] }
}

// v1 stored `{ name, accent }`, v2 stored `{ name, accent, bg, bgElevated }`,
// v3 stores `{ name, dark, light }`. Roll old shapes forward so users don't
// lose their saved themes.
function migrateLegacyTheme(t: any): Theme | null {
  if (!t) return null
  if (isValidTheme(t)) return t
  if (typeof t.name !== 'string') return null
  if (HEX_RE.test(t.accent)) {
    const dark: ModePalette = {
      accent: t.accent,
      bg: HEX_RE.test(t.bg) ? t.bg : '#0a0a0a',
      bgElevated: HEX_RE.test(t.bgElevated) ? t.bgElevated : '#111111',
    }
    return {
      name: t.name,
      dark,
      light: { accent: t.accent, ...NEUTRAL_LIGHT },
    }
  }
  return null
}

export function saveCustomTheme(t: Theme): void {
  const custom = loadCustomThemes().filter(x => x.name !== t.name)
  custom.push({ ...t, builtIn: false })
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

// ---- Apply ---------------------------------------------------------------

const STYLE_ID = 'notation-theme-style'

function alphaSiblings(hex: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pct of [10, 15, 20, 30, 40, 50] as const) {
    const a = Math.round((pct / 100) * 255).toString(16).padStart(2, '0').toUpperCase()
    out[`--notation-accent-${pct}`] = '#' + hex.slice(1) + a
  }
  return out
}

function paletteToVars(p: ModePalette): Record<string, string> {
  return {
    '--notation-accent': p.accent,
    '--notation-bg': p.bg,
    '--notation-bg-elevated': p.bgElevated,
    ...alphaSiblings(p.accent),
  }
}

function varsToCSS(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')
}

/** applyTheme writes a single <style> tag at the top of <head> that defines
 *  both `:root` and `.dark` variable scopes. Toggling the .dark class on
 *  documentElement picks the right palette automatically. */
export function applyTheme(t: Theme): void {
  const css = [
    ':root {',
    varsToCSS(paletteToVars(t.light)),
    '}',
    '.dark {',
    varsToCSS(paletteToVars(t.dark)),
    '}',
  ].join('\n')

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = css
}

export function initTheme(): Theme {
  const t = findTheme(getActiveThemeName())
  applyTheme(t)
  return t
}

// ---- VS Code import ------------------------------------------------------

export type VSCodeImportResult = {
  theme: Theme
  warnings: string[]
}

export function importVSCodeTheme(raw: unknown): VSCodeImportResult {
  const json = typeof raw === 'string' ? safeParseJSON(raw) : raw
  const j = json as any
  const colors = (j?.colors || {}) as Record<string, string>
  const name = (typeof j?.name === 'string' && j.name) || 'Imported'
  const declaredType: string | undefined = j?.type
  const warnings: string[] = []

  const accent = pickHex(colors, [
    'button.background',
    'focusBorder',
    'editorCursor.foreground',
    'list.activeSelectionForeground',
    'activityBarBadge.background',
    'tab.activeBorderTop',
    'inputOption.activeBorder',
  ])
  const bg = pickHex(colors, ['editor.background', 'workbench.background'])
  const bgElevated = pickHex(colors, [
    'sideBar.background',
    'activityBar.background',
    'editorGroupHeader.tabsBackground',
    'titleBar.activeBackground',
    'panel.background',
  ])

  if (!accent) warnings.push('No accent colour found — kept the previous accent.')
  if (!bg) warnings.push('No editor.background found — kept the previous background.')
  if (!bgElevated) warnings.push('No sidebar background found — falling back to the page background.')

  // Start from the currently-active theme so the OTHER mode keeps its
  // existing palette and we only replace the one we're importing into.
  const current = findTheme(getActiveThemeName())
  const palette: ModePalette = {
    accent: accent || current.dark.accent,
    bg: bg || current.dark.bg,
    bgElevated: bgElevated || bg || current.dark.bgElevated,
  }
  // VS-Code themes declare "type": "dark" | "light" — respect it. If absent,
  // we infer from the background brightness.
  const mode: 'dark' | 'light' =
    declaredType === 'light' ? 'light' :
    declaredType === 'dark'  ? 'dark'  :
    inferMode(palette.bg)

  const theme: Theme = {
    name,
    dark:  mode === 'dark'  ? palette : current.dark,
    light: mode === 'light' ? palette : current.light,
  }
  if (declaredType === undefined) {
    warnings.push(`Theme didn't declare a type — inferred "${mode}" from the background brightness.`)
  }
  return { theme, warnings }
}

function pickHex(colors: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const raw = colors[k]
    if (typeof raw === 'string' && /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(raw)) {
      return '#' + raw.slice(1, 7).toUpperCase()
    }
  }
  return null
}

function inferMode(hex: string): 'dark' | 'light' {
  // Cheap luminance heuristic on the bg colour.
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum < 128 ? 'dark' : 'light'
}

function safeParseJSON(s: string): unknown {
  try {
    const cleaned = s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    return JSON.parse(cleaned)
  } catch { return null }
}
