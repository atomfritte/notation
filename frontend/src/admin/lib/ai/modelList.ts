/**
 * The live model catalogue: what the owner's API key can actually use.
 *
 * Fetched from the Models API once the key is available, merged with the
 * built-in list (models.ts, which knows labels, blurbs and prices) and cached
 * in localStorage — model ids are public facts, not secrets, so the picker can
 * show the full list even before the key is unlocked. Refreshed at most once a
 * day, or on demand from the picker.
 *
 * The API also reports each model's capabilities; buildParams uses them to
 * leave out adaptive thinking or an effort level a model doesn't take, instead
 * of learning it from a failed request.
 */
import { useSyncExternalStore } from 'react'
import type Anthropic from '@anthropic-ai/sdk'
import { EFFORTS, MODELS, type Effort } from './models'

export interface LiveModel {
  id: string
  label: string
  /** Release date (YYYY-MM-DD) when the API knows it. */
  released?: string
  deprecated: boolean
  /** Adaptive thinking accepted (undefined: unknown → assume yes). */
  adaptive?: boolean
  /** Effort levels accepted (undefined: unknown → all; [] → no effort parameter). */
  efforts?: Effort[]
  /** From the built-in list: has a price and a blurb. */
  known: boolean
}

const CACHE_KEY = 'notation_ai_models'
const MAX_AGE = 24 * 3600 * 1000

interface Cached { at: number; models: LiveModel[] }

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Cached
    if (!Array.isArray(c?.models) || typeof c.at !== 'number') return null
    // Shape-check every entry: this is browser storage, not something we trust blindly.
    const ok = c.models.filter(m => typeof m?.id === 'string' && /^[a-z0-9][a-z0-9.-]{2,63}$/.test(m.id) && typeof m.label === 'string')
    return { at: c.at, models: ok.map(m => ({ ...m, label: m.label.slice(0, 80) })) }
  } catch {
    return null
  }
}

function writeCache(c: Cached) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)) } catch { /* private mode */ }
}

const builtIn = (): LiveModel[] => MODELS.map(m => ({ id: m.id, label: m.label, deprecated: false, known: true }))

let state: { models: LiveModel[]; at: number; live: boolean } = (() => {
  const c = readCache()
  return c && c.models.length ? { models: c.models, at: c.at, live: true } : { models: builtIn(), at: 0, live: false }
})()
let version = 0
const listeners = new Set<() => void>()
function set(next: typeof state) {
  state = next
  version++
  for (const l of listeners) l()
}

/** The current list (built-in until the API has been asked). Re-renders on change. */
export function useModelList(): { models: LiveModel[]; live: boolean } {
  useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    () => version,
  )
  return state
}

export function liveModel(id: string): LiveModel | undefined {
  return state.models.find(m => m.id === id)
}

const ALL_EFFORTS = EFFORTS.map(e => e.id)

function fromApi(m: Anthropic.Models.ModelInfo): LiveModel {
  const known = MODELS.find(k => k.id === m.id)
  const caps = m.capabilities
  let efforts: Effort[] | undefined
  if (caps?.effort) {
    efforts = caps.effort.supported
      ? ALL_EFFORTS.filter(e => (caps.effort as unknown as Record<string, { supported: boolean } | null>)[e]?.supported)
      : []
  }
  const released = m.created_at && !m.created_at.startsWith('1970') ? m.created_at.slice(0, 10) : undefined
  return {
    id: m.id,
    label: known?.label ?? (m.display_name || m.id),
    released,
    deprecated: m.lifecycle === 'deprecated',
    adaptive: caps?.thinking ? !!caps.thinking.types?.adaptive?.supported : undefined,
    efforts,
    known: !!known,
  }
}

let inflight: Promise<void> | null = null

/**
 * Ask the Models API for the key's models. `force` ignores the cache age.
 * Failures keep the previous list: the picker must never end up empty.
 */
export function refreshModels(client: () => Promise<Anthropic>, force = false): Promise<void> {
  if (!force && state.live && Date.now() - state.at < MAX_AGE) return Promise.resolve()
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const c = await client()
      const out: LiveModel[] = []
      for await (const m of c.models.list({ limit: 100 })) {
        if (m.lifecycle === 'retired') continue
        out.push(fromApi(m))
        if (out.length >= 200) break
      }
      if (!out.length) return
      // Known models first in our recommended order, then the rest newest first.
      const rank = (id: string) => { const i = MODELS.findIndex(k => k.id === id); return i < 0 ? MODELS.length : i }
      out.sort((a, b) => rank(a.id) - rank(b.id) || Number(a.deprecated) - Number(b.deprecated) || (b.released ?? '').localeCompare(a.released ?? ''))
      const next = { models: out, at: Date.now(), live: true }
      writeCache({ at: next.at, models: out })
      set(next)
    } catch {
      /* keep what we have */
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** The effort to send for `model`: the chosen one if it takes it, else the nearest it does, or none. */
export function effortFor(model: string, wanted: Effort): Effort | null {
  const efforts = liveModel(model)?.efforts
  if (!efforts) return wanted
  if (!efforts.length) return null
  if (efforts.includes(wanted)) return wanted
  const order = ALL_EFFORTS
  const w = order.indexOf(wanted)
  // Nearest supported level, preferring the lower one on a tie (cheaper).
  let best: Effort = efforts[0]
  let dist = Infinity
  for (const e of efforts) {
    const d = Math.abs(order.indexOf(e) - w)
    if (d < dist) { best = e; dist = d }
  }
  return best
}

/** Whether to send adaptive thinking to `model` (unknown → yes). */
export function adaptiveFor(model: string): boolean {
  return liveModel(model)?.adaptive !== false
}
