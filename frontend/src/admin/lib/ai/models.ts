/**
 * The Claude models the assistant offers, their per-token prices (for the cost
 * estimate in the chat header) and the request features each one takes.
 *
 * Prices are USD per million tokens, Anthropic first-party API rates. They only
 * drive an ESTIMATE shown as "≈": a fallback hop bills at the fallback model's
 * rate and cache writes depend on TTL, so the Console stays the source of truth.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelInfo {
  id: string
  label: string
  /** One short line for the picker. */
  blurb: string
  /** USD per MTok: input, output, cache read, cache write (5-minute TTL). */
  price: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** Server-side refusal fallback (`fallbacks: "default"`) is available. */
  fallback: boolean
}

export const MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    blurb: 'Recommended: strong at research, structure and long documents',
    price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    fallback: true,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    blurb: 'Faster and half the price, for everyday work',
    price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    fallback: true,
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    blurb: 'Very cheap, for small tasks',
    price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    fallback: false,
  },
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    blurb: 'The most capable model, noticeably pricier',
    price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    fallback: true,
  },
]

export const DEFAULT_MODEL = 'claude-opus-5-5'
export const DEFAULT_EFFORT: Effort = 'high'

export const EFFORTS: { id: Effort; label: string; blurb: string }[] = [
  { id: 'low', label: 'Quick', blurb: 'Short answers, little deliberation' },
  { id: 'medium', label: 'Balanced', blurb: 'Fine for simple edits' },
  { id: 'high', label: 'Thorough', blurb: 'Default: careful without overdoing it' },
  { id: 'xhigh', label: 'Very thorough', blurb: 'For big restructurings and research' },
  { id: 'max', label: 'Maximum', blurb: 'When correctness matters more than cost' },
]

export function modelInfo(id: string): ModelInfo {
  return MODELS.find(m => m.id === id) ?? {
    id,
    label: id,
    blurb: '',
    // Unknown model: price it like Opus so the estimate errs high, not low.
    price: MODELS[0].price,
    fallback: false,
  }
}

export function isEffort(v: unknown): v is Effort {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max'
}

/** Accumulated token usage of a chat (summed over every API request). */
export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Estimated cost in USD, summed per request at that request's model rate. */
  cost: number
}

export const emptyUsage = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })

/** The token counts one response reports (a subset of the API's usage object). */
export interface RequestUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** Add one response's usage to the running totals. */
export function addUsage(t: UsageTotals, u: RequestUsage, modelId: string): UsageTotals {
  const p = modelInfo(modelId).price
  const input = u.input_tokens ?? 0
  const output = u.output_tokens ?? 0
  const cacheRead = u.cache_read_input_tokens ?? 0
  const cacheWrite = u.cache_creation_input_tokens ?? 0
  const cost = (input * p.input + output * p.output + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite) / 1e6
  return {
    input: t.input + input,
    output: t.output + output,
    cacheRead: t.cacheRead + cacheRead,
    cacheWrite: t.cacheWrite + cacheWrite,
    cost: t.cost + cost,
  }
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return usd === 0 ? '$0' : '<$0.01'
  if (usd < 10) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(0)}`
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(2)}M`
}
