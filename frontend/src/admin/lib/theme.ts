/**
 * Theme system — full palette per mode (dark + light).
 *
 * Each theme defines a Palette for BOTH modes:
 *
 *   { name,
 *     dark:  { accent, bg, bgElevated, ..., chromeFg, ..., danger, ... },
 *     light: { ... } }
 *
 * Surfaces:
 *   - `bg`         : main content area background
 *   - `bgElevated` : chrome surface (sidebars, header, modals, popovers)
 *   - `bgAlt`      : subtle off-bg (hover bg, alt-row stripe, inline code)
 *
 * Foregrounds:
 *   - `fg`, `fgMuted`, `border`     : on content
 *   - `chromeFg`, `chromeFgMuted`, `chromeBorder` : on chrome
 *     (the `.surface-elevated` cascade in index.css rebinds the content
 *     tokens to these inside chrome wrappers, so most components don't
 *     need to know which surface they're on)
 *
 * Status:
 *   - `danger, warning, success, info`
 *
 * Misc:
 *   - `fgOnAccent` : text colour painted on top of `accent`
 *   - `backdrop`   : modal/overlay scrim (rgba)
 *
 * applyTheme() writes a dynamic <style> tag scoping :root + .dark. Flipping
 * the `.dark` class on documentElement swaps palettes. Consumers reference
 * the colours via `bg-[var(--notation-...)]`.
 *
 * Storage:
 *   notation_active_theme  → theme name
 *   notation_themes        → user-saved Theme[]
 */

export type ModePalette = {
  // Accent & content surface (the original 6)
  accent: string
  bg: string
  bgElevated: string
  fg: string
  fgMuted: string
  border: string

  // Subtle surface tint — hover bg, alt-row stripes, inline code highlights.
  bgAlt: string

  // Chrome surface foregrounds — were auto-derived by luminance, now user-
  // controlled with the same auto-derivation as defaults when unset.
  chromeFg: string
  chromeFgMuted: string
  chromeBorder: string

  // Status colours.
  danger: string
  warning: string
  success: string
  info: string

  // Text painted on top of the accent (primary buttons, accent badges).
  fgOnAccent: string

  // Modal / popover scrim. Stored as an rgba(...) string so partial alpha
  // works without us baking in a specific tint.
  backdrop: string
}

export type Theme = {
  name: string
  dark: ModePalette
  light: ModePalette
  builtIn?: boolean
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/
// Backdrop accepts rgba(...) or hex (we mainly persist rgba for partial-alpha
// scrims, but treat #RRGGBB as opaque).
const BACKDROP_RE = /^(#[0-9A-Fa-f]{6}|rgba?\([^)]+\))$/

function isValidPalette(p: any): p is ModePalette {
  if (!p) return false
  const hexFields = [
    'accent', 'bg', 'bgElevated', 'fg', 'fgMuted', 'border',
    'bgAlt', 'chromeFg', 'chromeFgMuted', 'chromeBorder',
    'danger', 'warning', 'success', 'info', 'fgOnAccent',
  ] as const
  for (const f of hexFields) if (!HEX_RE.test(p[f])) return false
  if (!BACKDROP_RE.test(p.backdrop)) return false
  return true
}
function isValidTheme(t: any): t is Theme {
  return t && typeof t.name === 'string' && isValidPalette(t.dark) && isValidPalette(t.light)
}

// ---- Built-ins -----------------------------------------------------------
//
// The six "tint" themes share neutral dark/light surfaces and only differ
// in accent. The four "world" themes ship full palettes inspired by popular
// editor themes; the light variants are best-effort companions.

// Status defaults — Tailwind 500/400 pairs, picked for AA contrast against
// the neutral backgrounds below. Custom themes that don't override these
// inherit them via fillPalette().
const DEFAULT_STATUS_DARK = {
  danger: '#F87171',   // red-400
  warning: '#FBBF24',  // amber-400
  success: '#34D399',  // emerald-400
  info: '#60A5FA',     // blue-400
} as const
const DEFAULT_STATUS_LIGHT = {
  danger: '#DC2626',   // red-600
  warning: '#D97706',  // amber-600
  success: '#059669',  // emerald-600
  info: '#2563EB',     // blue-600
} as const

const NEUTRAL_DARK = {
  bg: '#0A0A0A', bgElevated: '#111111', bgAlt: '#1F1F23',
  fg: '#E4E4E7', fgMuted: '#A1A1AA', border: '#27272A',
  // chromeBorder defaults to a sleek hairline barely above bgElevated. Set it
  // equal to bgElevated for a fully borderless sidebar, or pick a stronger
  // value in the theme editor.
  chromeFg: '#FAFAFA', chromeFgMuted: '#A1A1AA', chromeBorder: '#1E1E20',
  fgOnAccent: '#0A0A0A',
  backdrop: 'rgba(0, 0, 0, 0.55)',
  ...DEFAULT_STATUS_DARK,
} as const
const NEUTRAL_LIGHT = {
  bg: '#FFFFFF', bgElevated: '#FAFAFA', bgAlt: '#F4F4F5',
  fg: '#18181B', fgMuted: '#71717A', border: '#E4E4E7',
  chromeFg: '#18181B', chromeFgMuted: '#71717A', chromeBorder: '#ECECEC',
  fgOnAccent: '#FFFFFF',
  backdrop: 'rgba(0, 0, 0, 0.35)',
  ...DEFAULT_STATUS_LIGHT,
} as const

function tint(name: string, dark: string, light: string): Theme {
  return {
    name,
    builtIn: true,
    dark:  { ...NEUTRAL_DARK,  accent: dark,  fgOnAccent: pickOnAccent(dark) },
    light: { ...NEUTRAL_LIGHT, accent: light, fgOnAccent: pickOnAccent(light) },
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
    dark:  fillPalette({ accent: '#BD93F9', bg: '#282A36', bgElevated: '#21222C', fg: '#F8F8F2', fgMuted: '#6272A4', border: '#44475A' }, NEUTRAL_DARK),
    light: fillPalette({ accent: '#6F42C1', bg: '#F8F8F2', bgElevated: '#ECECE8', fg: '#21222C', fgMuted: '#6272A4', border: '#D6D6CE' }, NEUTRAL_LIGHT),
  },
  {
    name: 'Monokai', builtIn: true,
    dark:  fillPalette({ accent: '#A6E22E', bg: '#272822', bgElevated: '#1E1F1C', fg: '#F8F8F2', fgMuted: '#75715E', border: '#3E3D32' }, NEUTRAL_DARK),
    light: fillPalette({ accent: '#75A300', bg: '#FAFAFA', bgElevated: '#F0F0EE', fg: '#1E1F1C', fgMuted: '#75715E', border: '#D9D9D2' }, NEUTRAL_LIGHT),
  },
  {
    name: 'Solarized', builtIn: true,
    dark:  fillPalette({ accent: '#268BD2', bg: '#002B36', bgElevated: '#003B49', fg: '#839496', fgMuted: '#586E75', border: '#073642' }, NEUTRAL_DARK),
    light: fillPalette({ accent: '#268BD2', bg: '#FDF6E3', bgElevated: '#EEE8D5', fg: '#586E75', fgMuted: '#93A1A1', border: '#E0DAC4' }, NEUTRAL_LIGHT),
  },
  {
    name: 'Nord', builtIn: true,
    dark:  fillPalette({ accent: '#88C0D0', bg: '#2E3440', bgElevated: '#3B4252', fg: '#ECEFF4', fgMuted: '#81A1C1', border: '#4C566A' }, NEUTRAL_DARK),
    light: fillPalette({ accent: '#5E81AC', bg: '#ECEFF4', bgElevated: '#E5E9F0', fg: '#2E3440', fgMuted: '#4C566A', border: '#D8DEE4' }, NEUTRAL_LIGHT),
  },
]

// fillPalette takes a partial palette (the explicitly-set tokens for a
// hand-tuned theme) and fills in any missing field from the neutral defaults
// for that mode, then derives chrome + fg-on-accent from the chosen colours.
function fillPalette(partial: Partial<ModePalette>, neutral: typeof NEUTRAL_DARK | typeof NEUTRAL_LIGHT): ModePalette {
  const merged: ModePalette = { ...neutral, ...partial } as ModePalette
  // chrome* defaults: derive from bgElevated via luminance, like we did in v4.
  // The previous version did this inline in applyTheme; we now bake it into
  // the palette so the theme editor can show + override the derived values.
  if (partial.chromeFg === undefined) merged.chromeFg = pickOnSurface(merged.bgElevated)
  if (partial.chromeFgMuted === undefined) merged.chromeFgMuted = mix(merged.chromeFg, merged.bgElevated, 0.45)
  // Sleeker default: barely-there hairline (92% bgElevated + 8% chromeFg).
  if (partial.chromeBorder === undefined) merged.chromeBorder = mix(merged.chromeFg, merged.bgElevated, 0.92)
  if (partial.fgOnAccent === undefined) merged.fgOnAccent = pickOnAccent(merged.accent)
  return merged
}

/** Pick black or white based on bg luminance — WCAG-ish contrast pick. */
function pickOnSurface(bg: string): string {
  return luminance(bg) > 0.45 ? '#0A0A0A' : '#FAFAFA'
}

/** Same heuristic but tuned for buttons (slightly different cutoff). */
function pickOnAccent(accent: string): string {
  return luminance(accent) > 0.55 ? '#0A0A0A' : '#FFFFFF'
}

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

// Migration history (newest first):
//   v5 (current): adds bgAlt + chromeFg/chromeFgMuted/chromeBorder +
//                 danger/warning/success/info + fgOnAccent + backdrop
//   v4: per-mode fg/fgMuted/border
//   v3: per-mode {accent, bg, bgElevated}
//   v2: top-level {accent, bg, bgElevated}
//   v1: { accent }
function migrateLegacyTheme(t: any): Theme | null {
  if (!t) return null
  if (isValidTheme(t)) return t
  if (typeof t.name !== 'string') return null

  // v3 or v4 → v5: dark/light sub-objects exist; fill in any missing tokens
  // from the neutral defaults (and re-derive chrome* + fgOnAccent if absent).
  if (t.dark && t.light && typeof t.dark === 'object' && typeof t.light === 'object') {
    return {
      name: t.name,
      dark:  fillPalette(t.dark,  NEUTRAL_DARK),
      light: fillPalette(t.light, NEUTRAL_LIGHT),
    }
  }
  // v1/v2 → v5
  if (HEX_RE.test(t.accent)) {
    const darkPartial: Partial<ModePalette> = {
      accent: t.accent,
      bg: HEX_RE.test(t.bg) ? t.bg : undefined,
      bgElevated: HEX_RE.test(t.bgElevated) ? t.bgElevated : undefined,
    }
    return {
      name: t.name,
      dark:  fillPalette(darkPartial, NEUTRAL_DARK),
      light: fillPalette({ accent: t.accent }, NEUTRAL_LIGHT),
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

/** WCAG-style relative luminance. Returns 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const lin = (v: number) => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Mix two hex colours by `ratio` (0 = all `a`, 1 = all `b`). Result hex. */
function mix(a: string, b: string, ratio: number): string {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16))
  return '#' + pa.map((v, i) =>
    Math.round(v * (1 - ratio) + pb[i] * ratio).toString(16).padStart(2, '0').toUpperCase(),
  ).join('')
}

function paletteToVars(p: ModePalette): Record<string, string> {
  return {
    '--notation-accent': p.accent,
    '--notation-bg': p.bg,
    '--notation-bg-elevated': p.bgElevated,
    '--notation-bg-alt': p.bgAlt,
    '--notation-fg': p.fg,
    '--notation-fg-muted': p.fgMuted,
    '--notation-border': p.border,
    '--notation-fg-on-elevated': p.chromeFg,
    '--notation-fg-on-elevated-muted': p.chromeFgMuted,
    '--notation-border-on-elevated': p.chromeBorder,
    '--notation-danger': p.danger,
    '--notation-warning': p.warning,
    '--notation-success': p.success,
    '--notation-info': p.info,
    '--notation-fg-on-accent': p.fgOnAccent,
    '--notation-backdrop': p.backdrop,
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

// ---- Header style preference --------------------------------------------
//
// The reading-pane header can either follow the chrome surface (sidebars +
// modals — original behavior) or the content surface (flush with the page
// body, useful when the user prefers a continuous reading area). Stored as
// a per-user UI preference, NOT inside the theme JSON, so it survives a
// theme switch. ThemePalette dispatches a custom event when the user
// toggles it; components subscribe via the small hook in their own file.

export type HeaderStyle = 'chrome' | 'content'
const HEADER_STYLE_KEY = 'notation_header_style'
export const HEADER_STYLE_EVENT = 'notation:header-style-change'

export function getHeaderStyle(): HeaderStyle {
  return localStorage.getItem(HEADER_STYLE_KEY) === 'content' ? 'content' : 'chrome'
}

export function setHeaderStyle(s: HeaderStyle): void {
  localStorage.setItem(HEADER_STYLE_KEY, s)
  window.dispatchEvent(new CustomEvent(HEADER_STYLE_EVENT, { detail: s }))
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
  const fg = pickHex(colors, [
    'editor.foreground',
    'foreground',
    'sideBar.foreground',
  ])
  const fgMuted = pickHex(colors, [
    'descriptionForeground',
    'disabledForeground',
    'editorLineNumber.foreground',
    'breadcrumb.foreground',
  ])
  const border = pickHex(colors, [
    'panel.border',
    'sideBar.border',
    'contrastBorder',
    'editorGroup.border',
    'titleBar.border',
  ])
  const chromeFg = pickHex(colors, [
    'sideBar.foreground',
    'titleBar.activeForeground',
    'activityBar.foreground',
  ])
  // Status colours from VS Code's notification + git decorations palette.
  const danger = pickHex(colors, ['errorForeground', 'notificationsErrorIcon.foreground', 'gitDecoration.deletedResourceForeground'])
  const warning = pickHex(colors, ['notificationsWarningIcon.foreground', 'editorWarning.foreground', 'gitDecoration.modifiedResourceForeground'])
  const success = pickHex(colors, ['notificationsInfoIcon.foreground', 'gitDecoration.addedResourceForeground', 'terminal.ansiGreen'])
  const info = pickHex(colors, ['notificationsInfoIcon.foreground', 'editorInfo.foreground', 'terminal.ansiBlue'])

  if (!accent) warnings.push('No accent colour found — kept the previous accent.')
  if (!bg) warnings.push('No editor.background found — kept the previous background.')
  if (!bgElevated) warnings.push('No sidebar background found — falling back to the page background.')

  const current = findTheme(getActiveThemeName())
  const neutral = (declaredType === 'light') ? NEUTRAL_LIGHT : NEUTRAL_DARK
  const baseSide = (declaredType === 'light') ? current.light : current.dark

  const partial: Partial<ModePalette> = {
    accent: accent || baseSide.accent,
    bg: bg || baseSide.bg,
    bgElevated: bgElevated || bg || baseSide.bgElevated,
    fg: fg || baseSide.fg,
    fgMuted: fgMuted || fg || baseSide.fgMuted,
    border: border || baseSide.border,
    chromeFg: chromeFg || undefined,
    danger: danger || undefined,
    warning: warning || undefined,
    success: success || undefined,
    info: info || undefined,
  }
  const palette = fillPalette(partial, neutral)
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
