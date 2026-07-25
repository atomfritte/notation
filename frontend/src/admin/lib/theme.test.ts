import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES, applyTheme, loadCustomThemes, type ModePalette } from './theme'

// The palette contract, pinned: every built-in must be complete (a missing
// token renders as an invalid CSS var, i.e. an unpainted surface), split-tone
// themes must actually differ between chrome and content, and a theme saved
// before `chromeBg` existed must keep looking exactly as it did.

const REQUIRED: (keyof ModePalette)[] = [
  'accent', 'bg', 'bgElevated', 'bgAlt', 'fg', 'fgMuted', 'border',
  'chromeBg', 'chromeBgAlt', 'chromeFg', 'chromeFgMuted', 'chromeBorder',
  'danger', 'warning', 'success', 'info', 'fgOnAccent', 'backdrop',
]

/** Relative luminance, the same 0..1 scale the theme module derives ink from. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const SPLIT_TONE = ['Studio', 'Manuscript', 'Evergreen', 'Nocturne']

// This jsdom build doesn't expose localStorage globally; the migration test only
// needs get/set/remove, so stand one up when it's missing.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size },
    },
  })
}

describe('built-in themes', () => {
  it('define every palette token in both modes', () => {
    for (const t of BUILTIN_THEMES) {
      for (const mode of ['dark', 'light'] as const) {
        for (const key of REQUIRED) {
          expect(t[mode][key], `${t.name}.${mode}.${key}`).toBeTruthy()
        }
      }
    }
  })

  it('keeps chrome and content identical for the uniform themes', () => {
    for (const t of BUILTIN_THEMES.filter(t => !SPLIT_TONE.includes(t.name))) {
      expect(t.light.chromeBg, t.name).toBe(t.light.bgElevated)
      expect(t.dark.chromeBg, t.name).toBe(t.dark.bgElevated)
      // …including the subtle surface, so hover rows and comment cards in a
      // uniform theme render exactly as they did before chromeBgAlt existed.
      expect(t.light.chromeBgAlt, t.name).toBe(t.light.bgAlt)
      expect(t.dark.chromeBgAlt, t.name).toBe(t.dark.bgAlt)
    }
  })

  it('gives the split-tone themes a dark frame around a bright page', () => {
    for (const name of SPLIT_TONE) {
      const t = BUILTIN_THEMES.find(x => x.name === name)!
      expect(t, name).toBeTruthy()
      // Light mode: the reading area is near-paper, the chrome is deep.
      expect(luminance(t.light.bg), `${name} light page`).toBeGreaterThan(0.85)
      expect(luminance(t.light.chromeBg), `${name} light chrome`).toBeLessThan(0.1)
      // …and the elevated surface stays with the CONTENT, so inputs and cards
      // in a dialog don't turn into dark-on-dark.
      expect(luminance(t.light.bgElevated), `${name} light elevated`).toBeGreaterThan(0.7)
      // Dark mode inverts the relationship: the page is lifted out of the frame.
      expect(luminance(t.dark.bg), `${name} dark page`).toBeGreaterThan(luminance(t.dark.chromeBg))
    }
  })

  it('keeps chrome text readable on the chrome CARD surface', () => {
    // The regression this pins: comment cards, hover rows and inputs inside
    // chrome paint bgAlt. Before chromeBgAlt existed a split-tone theme painted
    // the CONTENT's light tint there and then wrote near-white chrome text on
    // it — comments were invisible.
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    for (const t of BUILTIN_THEMES) {
      for (const mode of ['dark', 'light'] as const) {
        expect(contrast(t[mode].chromeFg, t[mode].chromeBgAlt), `${t.name} ${mode} card`).toBeGreaterThan(7)
        expect(contrast(t[mode].chromeFgMuted, t[mode].chromeBgAlt), `${t.name} ${mode} card muted`).toBeGreaterThan(3.5)
      }
    }
  })

  it('picks accent text on the readable side of the white/black crossover', () => {
    // A mid-bright accent (#7DA2FF, #A5B4FC…) used to get white text at ~2.5:1.
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    for (const t of BUILTIN_THEMES) {
      for (const mode of ['dark', 'light'] as const) {
        expect(contrast(t[mode].fgOnAccent, t[mode].accent), `${t.name} ${mode} on-accent`).toBeGreaterThan(3.5)
      }
    }
  })

  it('keeps body text comfortably readable on every surface', () => {
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    for (const t of BUILTIN_THEMES.filter(x => SPLIT_TONE.includes(x.name))) {
      for (const mode of ['dark', 'light'] as const) {
        // AA for body text is 4.5:1; these are reading themes, so hold them higher.
        expect(contrast(t[mode].fg, t[mode].bg), `${t.name} ${mode} body`).toBeGreaterThan(9)
        expect(contrast(t[mode].chromeFg, t[mode].chromeBg), `${t.name} ${mode} chrome`).toBeGreaterThan(9)
        // Muted copy still has to clear AA.
        expect(contrast(t[mode].fgMuted, t[mode].bg), `${t.name} ${mode} muted`).toBeGreaterThan(4.5)
        expect(contrast(t[mode].chromeFgMuted, t[mode].chromeBg), `${t.name} ${mode} chrome muted`).toBeGreaterThan(4)
      }
    }
  })
})

describe('theme storage migration', () => {
  it('fills chromeBg from bgElevated for a theme saved before it existed', () => {
    const legacy = BUILTIN_THEMES.find(t => t.name === 'Nord')!
    const strip = (p: ModePalette) => {
      const copy = { ...p } as Partial<ModePalette>
      delete copy.chromeBg
      return copy
    }
    localStorage.setItem(
      'notation_themes',
      JSON.stringify([{ name: 'Legacy', dark: strip(legacy.dark), light: strip(legacy.light) }]),
    )
    const [restored] = loadCustomThemes()
    expect(restored?.name).toBe('Legacy')
    // The uniform look it was saved with is preserved exactly.
    expect(restored.light.chromeBg).toBe(legacy.light.bgElevated)
    expect(restored.dark.chromeBg).toBe(legacy.dark.bgElevated)
    localStorage.removeItem('notation_themes')
  })

  it('emits a chrome-bg variable for both modes', () => {
    applyTheme(BUILTIN_THEMES.find(t => t.name === 'Studio')!)
    const css = document.getElementById('notation-theme-style')?.textContent ?? ''
    expect(css.match(/--notation-chrome-bg:/g) ?? []).toHaveLength(2)
    expect(css).toContain('--notation-chrome-bg: #1B1F29')
  })
})
