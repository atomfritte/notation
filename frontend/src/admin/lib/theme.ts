/**
 * Theme system — accent-colour level.
 *
 * The CSS contains a fixed default in :root (`--notation-accent: #BFF355`).
 * This module overrides that variable + the alpha siblings on
 * `document.documentElement` based on the user's last picked theme. Themes
 * are just `{ name, accent }` pairs; six built-ins ship with the app, and
 * the user can save unlimited custom themes via the ThemePalette UI.
 *
 * Storage:
 *   notation_active_theme        → string (theme name)
 *   notation_themes              → Theme[] (user-saved customs)
 */

export type Theme = {
  name: string
  accent: string // 6-digit hex with leading #
  builtIn?: boolean
}

export const BUILTIN_THEMES: Theme[] = [
  { name: 'Lime',    accent: '#BFF355', builtIn: true },
  { name: 'Sky',     accent: '#7DD3FC', builtIn: true },
  { name: 'Rose',    accent: '#FB7185', builtIn: true },
  { name: 'Amber',   accent: '#FCD34D', builtIn: true },
  { name: 'Violet',  accent: '#C4B5FD', builtIn: true },
  { name: 'Mint',    accent: '#6EE7B7', builtIn: true },
]

const STORE_THEMES = 'notation_themes'
const STORE_ACTIVE = 'notation_active_theme'

export function listThemes(): Theme[] {
  const custom = loadCustomThemes()
  return [...BUILTIN_THEMES, ...custom]
}

export function loadCustomThemes(): Theme[] {
  try {
    const raw = localStorage.getItem(STORE_THEMES)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(t => typeof t?.name === 'string' && /^#[0-9A-Fa-f]{6}$/.test(t?.accent ?? ''))
  } catch {
    return []
  }
}

export function saveCustomTheme(t: Theme): void {
  const custom = loadCustomThemes().filter(x => x.name !== t.name)
  custom.push({ name: t.name, accent: t.accent })
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

/** Look up theme by name across both built-ins and custom. Falls back to
 *  the first built-in if the active name has been deleted. */
export function findTheme(name: string): Theme {
  const all = listThemes()
  return all.find(t => t.name === name) || BUILTIN_THEMES[0]
}

/** Push the theme's accent + alpha siblings into `:root` so every
 *  `var(--notation-accent…)` consumer re-renders. Safe to call at any time;
 *  no React re-render is required. */
export function applyTheme(t: Theme): void {
  const root = document.documentElement
  root.style.setProperty('--notation-accent', t.accent)
  // Alpha siblings: hex+alpha. Math.round(pct/100 * 255).toString(16).
  const a = (pct: number) => {
    const v = Math.round((pct / 100) * 255)
    return '#' + t.accent.slice(1) + v.toString(16).padStart(2, '0').toUpperCase()
  }
  root.style.setProperty('--notation-accent-10', a(10))
  root.style.setProperty('--notation-accent-15', a(15))
  root.style.setProperty('--notation-accent-20', a(20))
  root.style.setProperty('--notation-accent-30', a(30))
  root.style.setProperty('--notation-accent-40', a(40))
  root.style.setProperty('--notation-accent-50', a(50))
}

/** Convenience: load + apply in one shot. Call this once at app mount. */
export function initTheme(): Theme {
  const t = findTheme(getActiveThemeName())
  applyTheme(t)
  return t
}
