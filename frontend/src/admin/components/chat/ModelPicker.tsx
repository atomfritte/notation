import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cpu, Loader2, RefreshCw } from 'lucide-react'
import { EFFORTS, MODELS, type Effort } from '../../lib/ai/models'
import { useModelList, type LiveModel } from '../../lib/ai/modelList'

const short = (label: string) => label.replace(/^Claude /, '')

function price(id: string): string | null {
  const m = MODELS.find(k => k.id === id)
  if (!m) return null
  const f = (n: number) => (n < 1 ? `$${n}` : `$${n.toFixed(n % 1 ? 2 : 0)}`)
  return `${f(m.price.input)} in · ${f(m.price.output)} out per M tokens`
}

/**
 * The model + effort for the next message, as a pill in the composer that
 * opens a picker: every model the API key can use (live from the Models API
 * once unlocked), what each costs, and how hard Claude should think.
 */
export function ModelPicker({
  model,
  effort,
  onChange,
  onMakeDefault,
  isDefault,
  onRefresh,
  disabled,
}: {
  model: string
  effort: Effort
  onChange: (model: string, effort: Effort) => void
  /** Save the current pick as the default for new chats. */
  onMakeDefault: () => Promise<void>
  isDefault: boolean
  /** Re-ask the Models API (only when the key is usable). */
  onRefresh?: () => Promise<void>
  disabled?: boolean
}) {
  const { models, live } = useModelList()
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])

  const list: LiveModel[] = models.some(m => m.id === model)
    ? models
    : [...models, { id: model, label: model, deprecated: false, known: false }]
  const current = list.find(m => m.id === model)!
  const efforts = current.efforts
  const effortLabel = efforts && efforts.length === 0 ? null : EFFORTS.find(e => e.id === effort)?.label

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${current.label}${effortLabel ? `, ${effortLabel}` : ''}. Change`}
        title="Choose the model and how thoroughly Claude works"
        className="flex items-center gap-1 max-w-full pl-1.5 pr-1 py-0.5 rounded-md border border-[var(--notation-border)] text-[11.5px] text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] disabled:opacity-50"
      >
        <Cpu size={11} className="flex-shrink-0 text-[color:var(--notation-accent-text)]" />
        <span className="truncate font-medium">{short(current.label)}</span>
        {effortLabel && <span className="truncate text-[var(--notation-fg-muted)]">· {effortLabel}</span>}
        <ChevronDown size={11} className="flex-shrink-0 text-[var(--notation-fg-muted)]" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Model and effort"
          className="absolute bottom-full left-0 mb-1.5 z-30 w-[min(22rem,calc(100vw-1.5rem))] max-h-[min(70vh,34rem)] overflow-y-auto rounded-xl text-[var(--notation-fg)] border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] shadow-2xl animate-in fade-in slide-in-from-bottom-1 duration-100"
        >
          <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--notation-fg-muted)]">Model</span>
            {onRefresh && (
              <button
                type="button"
                onClick={async () => { setRefreshing(true); try { await onRefresh() } finally { setRefreshing(false) } }}
                className="flex items-center gap-1 text-[11px] text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]"
                title={live ? 'Ask the API again which models this key can use' : 'Load the models this key can use'}
              >
                {refreshing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                {live ? 'Refresh' : 'Load all models'}
              </button>
            )}
          </div>
          <ul className="px-1.5 pb-1.5" role="listbox" aria-label="Model">
            {list.map(m => {
              const sel = m.id === model
              const known = MODELS.find(k => k.id === m.id)
              const p = price(m.id)
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={sel}
                    onClick={() => onChange(m.id, effort)}
                    className={`w-full text-left flex gap-2 px-2 py-1.5 rounded-lg ${sel ? 'bg-[var(--notation-accent-10)]' : 'hover:bg-[var(--notation-bg-alt)]'}`}
                  >
                    <span className="w-3.5 flex-shrink-0 pt-0.5">{sel && <Check size={13} className="text-[color:var(--notation-accent-text)]" />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                        <span className="truncate">{m.label}</span>
                        {m.deprecated && <span className="text-[10px] font-normal px-1 rounded bg-[var(--notation-bg-alt)] text-[var(--notation-fg-muted)]">deprecated</span>}
                      </span>
                      <span className="block text-[11px] text-[var(--notation-fg-muted)] leading-snug">
                        {known?.blurb || (m.released ? `Released ${m.released}` : m.id)}
                      </span>
                      <span className="block text-[10.5px] text-[var(--notation-fg-muted)] tabular-nums">
                        {p ?? 'Price not known here — the cost estimate assumes Opus rates'}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="border-t border-[var(--notation-border)] px-3 py-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--notation-fg-muted)] mb-1.5">Effort</div>
            {efforts && efforts.length === 0 ? (
              <div className="text-[11.5px] text-[var(--notation-fg-muted)]">This model has no effort setting.</div>
            ) : (
              <>
                <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label="Effort">
                  {EFFORTS.map(x => {
                    const ok = !efforts || efforts.includes(x.id)
                    const sel = x.id === effort
                    return (
                      <button
                        key={x.id}
                        type="button"
                        role="radio"
                        aria-checked={sel}
                        disabled={!ok}
                        onClick={() => onChange(model, x.id)}
                        title={ok ? x.blurb : 'Not available for this model'}
                        className={`px-1 py-1 rounded-md text-[10.5px] leading-tight border ${sel ? 'border-[color:var(--notation-accent)] bg-[var(--notation-accent-10)] font-medium' : 'border-[var(--notation-border)] hover:bg-[var(--notation-bg-alt)]'} disabled:opacity-35`}
                      >
                        {x.label}
                      </button>
                    )
                  })}
                </div>
                <div className="mt-1.5 text-[11px] text-[var(--notation-fg-muted)]">
                  {EFFORTS.find(x => x.id === effort)?.blurb}. Higher effort thinks longer and costs more.
                </div>
              </>
            )}
          </div>

          <div className="border-t border-[var(--notation-border)] px-3 py-2 flex items-center gap-2 text-[11px] text-[var(--notation-fg-muted)]">
            <span className="flex-1">Applies to this chat from the next message on.</span>
            {isDefault ? (
              <span className="flex items-center gap-1"><Check size={11} /> Default</span>
            ) : (
              <button
                type="button"
                disabled={saving}
                onClick={async () => { setSaving(true); try { await onMakeDefault() } finally { setSaving(false) } }}
                className="px-2 py-0.5 rounded-md border border-[var(--notation-border)] text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Use for new chats'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
