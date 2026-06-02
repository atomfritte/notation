import { useMemo, useState } from 'react'
import {
  ClipboardList, Plus, ListChecks, Calendar as CalIcon, Search as SearchIcon,
  ChevronLeft, ChevronRight, ChevronDown, Check,
} from 'lucide-react'

// Types mirror the backend form API (and the api.ts FormData shape). Defined
// here so the component is shared by the admin + share SPAs structurally.
export type FormFieldType =
  | 'string' | 'text' | 'integer' | 'number' | 'bool'
  | 'date' | 'time' | 'datetime' | 'select' | 'email' | 'url'
export type FormField = {
  key: string; label: string; type: FormFieldType
  required: boolean; options?: string[]; default?: string
}
export type FormSchema = { title: string; title_field: string; fields: FormField[] }
export type FormEntry = {
  id: string; path: string; created_at: string; title: string
  values: Record<string, unknown>
}
export type FormData = {
  folder: string; schema: FormSchema; entries: FormEntry[]; can_submit: boolean
}

type Tab = 'new' | 'entries' | 'calendar' | 'search'

export function FormView({
  data, onSubmit, onEditTemplate,
}: {
  data: FormData
  onSubmit: (values: Record<string, unknown>) => Promise<void>
  /** Admin-only: open the _form.md template in the editor. */
  onEditTemplate?: () => void
}) {
  const { schema, entries, can_submit } = data
  const [tab, setTab] = useState<Tab>(can_submit ? 'new' : 'entries')
  const [openId, setOpenId] = useState<string | null>(null)

  const tabs: { key: Tab; label: string; icon: React.ReactNode; show: boolean; badge?: number }[] = [
    { key: 'new', label: 'New entry', icon: <Plus size={15} />, show: can_submit },
    { key: 'entries', label: 'Entries', icon: <ListChecks size={15} />, show: true, badge: entries.length },
    { key: 'calendar', label: 'Calendar', icon: <CalIcon size={15} />, show: true },
    { key: 'search', label: 'Search', icon: <SearchIcon size={15} />, show: true },
  ]

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 md:p-8">
        <header className="flex items-center gap-2.5 mb-1">
          <ClipboardList size={22} className="text-[color:var(--notation-accent)]" />
          <h1 className="text-2xl font-bold text-[var(--notation-fg)] tracking-tight flex-1 truncate">{schema.title}</h1>
          {onEditTemplate && (
            <button
              onClick={onEditTemplate}
              className="text-xs text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] border border-[var(--notation-border)] rounded-md px-2 py-1 flex-shrink-0"
              title="Edit the _form.md template"
            >
              Edit form
            </button>
          )}
        </header>
        <p className="text-sm text-[var(--notation-fg-muted)] mb-5">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          {!can_submit && ' · read-only'}
        </p>

        <div className="flex gap-1 border-b border-[var(--notation-border)] mb-5">
          {tabs.filter(t => t.show).map(t => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setOpenId(null) }}
              className={
                'flex items-center gap-1.5 px-3 py-2 text-sm font-medium -mb-px border-b-2 transition-colors ' +
                (tab === t.key
                  ? 'border-[color:var(--notation-accent)] text-[var(--notation-fg)]'
                  : 'border-transparent text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]')
              }
            >
              {t.icon}{t.label}
              {t.badge ? <span className="text-[10px] font-bold bg-[color:var(--notation-accent-15)] text-[color:var(--notation-accent)] px-1.5 py-0.5 rounded-full">{t.badge}</span> : null}
            </button>
          ))}
        </div>

        {tab === 'new' && can_submit && (
          <NewEntryForm schema={schema} onSubmit={onSubmit} onDone={() => setTab('entries')} />
        )}
        {tab === 'entries' && (
          <EntryBrowser schema={schema} entries={entries} openId={openId} setOpenId={setOpenId} />
        )}
        {tab === 'calendar' && (
          <CalendarView entries={entries} onPick={(id) => { setOpenId(id); setTab('entries') }} />
        )}
        {tab === 'search' && (
          <SearchView schema={schema} entries={entries} onOpen={(id) => { setOpenId(id); setTab('entries') }} />
        )}
      </div>
    </div>
  )
}

// ---- New entry form ------------------------------------------------------

function NewEntryForm({
  schema, onSubmit, onDone,
}: {
  schema: FormSchema
  onSubmit: (values: Record<string, unknown>) => Promise<void>
  onDone: () => void
}) {
  const initial = useMemo(() => {
    const v: Record<string, unknown> = {}
    for (const f of schema.fields) {
      v[f.key] = f.type === 'bool' ? false : (f.default ?? '')
    }
    return v
  }, [schema])
  const [values, setValues] = useState<Record<string, unknown>>(initial)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  function set(key: string, val: unknown) { setValues(prev => ({ ...prev, [key]: val })) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(null)
    try {
      await onSubmit(values)
      setValues(initial)
      setDone(true)
      window.setTimeout(() => setDone(false), 2500)
      onDone()
    } catch (e) {
      setErr(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {schema.fields.map(f => (
        <div key={f.key}>
          <label className="block text-sm font-medium text-[var(--notation-fg)] mb-1">
            {f.label}{f.required && <span className="text-[var(--notation-danger)] ml-0.5">*</span>}
          </label>
          <FieldInput field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
        </div>
      ))}
      {err && <p className="text-sm text-[var(--notation-danger)]">{err}</p>}
      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={busy}
          className="px-4 py-2 bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] font-semibold text-sm rounded-md disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Submit entry'}
        </button>
        {done && <span className="text-sm text-[color:var(--notation-accent)] flex items-center gap-1"><Check size={14} /> Saved</span>}
      </div>
    </form>
  )
}

function FieldInput({ field, value, onChange }: { field: FormField; value: unknown; onChange: (v: unknown) => void }) {
  const cls = 'w-full bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] rounded-md px-3 py-2 text-sm text-[var(--notation-fg)] outline-none focus:border-[color:var(--notation-accent)]'
  const s = value == null ? '' : String(value)
  switch (field.type) {
    case 'text':
      return <textarea className={cls + ' resize-y min-h-[5rem]'} value={s} onChange={e => onChange(e.target.value)} />
    case 'bool':
      return (
        <label className="inline-flex items-center gap-2 text-sm text-[var(--notation-fg)] cursor-pointer">
          <input type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} className="w-4 h-4 accent-[var(--notation-accent)]" />
          <span className="text-[var(--notation-fg-muted)]">Yes</span>
        </label>
      )
    case 'integer':
      return <input type="number" step="1" className={cls} value={s} onChange={e => onChange(e.target.value)} />
    case 'number':
      return <input type="number" step="any" className={cls} value={s} onChange={e => onChange(e.target.value)} />
    case 'date':
      return <input type="date" className={cls} value={s} onChange={e => onChange(e.target.value)} />
    case 'time':
      return <input type="time" className={cls} value={s} onChange={e => onChange(e.target.value)} />
    case 'datetime':
      return <input type="datetime-local" className={cls} value={s} onChange={e => onChange(e.target.value)} />
    case 'email':
      return <input type="email" className={cls} value={s} onChange={e => onChange(e.target.value)} />
    case 'url':
      return <input type="url" className={cls} value={s} onChange={e => onChange(e.target.value)} />
    case 'select':
      return (
        <div className="relative">
          <select className={cls + ' appearance-none pr-8'} value={s} onChange={e => onChange(e.target.value)}>
            <option value="">—</option>
            {(field.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--notation-fg-muted)]" />
        </div>
      )
    default:
      return <input type="text" className={cls} value={s} onChange={e => onChange(e.target.value)} />
  }
}

// ---- Entries browser (list + detail) -------------------------------------

function EntryBrowser({
  schema, entries, openId, setOpenId,
}: {
  schema: FormSchema
  entries: FormEntry[]
  openId: string | null
  setOpenId: (id: string | null) => void
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-[var(--notation-fg-muted)] italic">No entries yet.</p>
  }
  const idx = openId ? entries.findIndex(e => e.id === openId) : -1
  if (idx >= 0) {
    return (
      <EntryDetail
        schema={schema}
        entry={entries[idx]}
        onBack={() => setOpenId(null)}
        onPrev={idx < entries.length - 1 ? () => setOpenId(entries[idx + 1].id) : undefined}
        onNext={idx > 0 ? () => setOpenId(entries[idx - 1].id) : undefined}
        position={`${idx + 1} / ${entries.length}`}
      />
    )
  }
  return <EntryList schema={schema} entries={entries} onOpen={setOpenId} />
}

function EntryList({ schema, entries, onOpen }: { schema: FormSchema; entries: FormEntry[]; onOpen: (id: string) => void }) {
  const secondary = schema.fields.filter(f => f.key !== schema.title_field).slice(0, 2)
  return (
    <ul className="space-y-2">
      {entries.map(e => (
        <li key={e.id}>
          <button
            onClick={() => onOpen(e.id)}
            className="w-full text-left p-3 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] hover:border-[color:var(--notation-accent-40)] transition-colors"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold text-sm text-[var(--notation-fg)] truncate">{e.title || '(untitled)'}</span>
              <span className="text-[11px] text-[var(--notation-fg-muted)] flex-shrink-0">{formatDateTime(e.created_at)}</span>
            </div>
            {secondary.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[var(--notation-fg-muted)]">
                {secondary.map(f => (
                  <span key={f.key} className="truncate"><span className="opacity-70">{f.label}:</span> {fieldDisplay(f, e.values[f.key])}</span>
                ))}
              </div>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

function EntryDetail({
  schema, entry, onBack, onPrev, onNext, position,
}: {
  schema: FormSchema; entry: FormEntry
  onBack: () => void; onPrev?: () => void; onNext?: () => void; position: string
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button onClick={onBack} className="text-sm text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] flex items-center gap-1">
          <ChevronLeft size={15} /> All entries
        </button>
        <div className="flex items-center gap-2 text-xs text-[var(--notation-fg-muted)]">
          <button onClick={onPrev} disabled={!onPrev} className="p-1 rounded hover:bg-[var(--notation-border)] disabled:opacity-30" title="Older"><ChevronLeft size={16} /></button>
          <span>{position}</span>
          <button onClick={onNext} disabled={!onNext} className="p-1 rounded hover:bg-[var(--notation-border)] disabled:opacity-30" title="Newer"><ChevronRight size={16} /></button>
        </div>
      </div>
      <div className="rounded-lg border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--notation-border)]">
          <div className="font-semibold text-[var(--notation-fg)]">{entry.title || '(untitled)'}</div>
          <div className="text-xs text-[var(--notation-fg-muted)]">{formatDateTime(entry.created_at)}</div>
        </div>
        <dl className="divide-y divide-[var(--notation-border)]">
          {schema.fields.map(f => (
            <div key={f.key} className="px-4 py-2.5 grid grid-cols-3 gap-3">
              <dt className="text-sm text-[var(--notation-fg-muted)] truncate col-span-1">{f.label}</dt>
              <dd className="text-sm text-[var(--notation-fg)] col-span-2 whitespace-pre-wrap break-words">{fieldDisplay(f, entry.values[f.key]) || <span className="opacity-40">—</span>}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}

// ---- Calendar ------------------------------------------------------------

function CalendarView({ entries, onPick }: { entries: FormEntry[]; onPick: (id: string) => void }) {
  const byDay = useMemo(() => {
    const m = new Map<string, FormEntry[]>()
    for (const e of entries) {
      const key = localDayKey(e.created_at)
      if (!key) continue
      const list = m.get(key) ?? []
      list.push(e)
      m.set(key, list)
    }
    return m
  }, [entries])

  const newest = entries[0] ? new Date(entries[0].created_at) : new Date()
  const [view, setView] = useState({ y: newest.getFullYear(), m: newest.getMonth() })
  const [selDay, setSelDay] = useState<string | null>(null)

  const first = new Date(view.y, view.m, 1)
  const startDow = (first.getDay() + 6) % 7 // Monday-first
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate()
  const cells: (number | null)[] = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  function shift(delta: number) {
    setSelDay(null)
    setView(v => {
      const nm = v.m + delta
      return { y: v.y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 }
    })
  }
  const monthLabel = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const selected = selDay ? (byDay.get(selDay) ?? []) : []

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button onClick={() => shift(-1)} className="p-1.5 rounded hover:bg-[var(--notation-border)]"><ChevronLeft size={16} /></button>
        <div className="font-semibold text-sm text-[var(--notation-fg)]">{monthLabel}</div>
        <button onClick={() => shift(1)} className="p-1.5 rounded hover:bg-[var(--notation-border)]"><ChevronRight size={16} /></button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => (
          <div key={d} className="text-[11px] font-semibold text-[var(--notation-fg-muted)] py-1">{d}</div>
        ))}
        {cells.map((d, i) => {
          if (d == null) return <div key={i} />
          const key = `${view.y}-${pad(view.m + 1)}-${pad(d)}`
          const count = byDay.get(key)?.length ?? 0
          const isSel = selDay === key
          return (
            <button
              key={i}
              onClick={() => count > 0 && setSelDay(isSel ? null : key)}
              disabled={count === 0}
              className={
                'aspect-square rounded-md text-sm flex flex-col items-center justify-center transition-colors ' +
                (isSel ? 'bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] font-semibold'
                  : count > 0 ? 'bg-[color:var(--notation-accent-10)] text-[var(--notation-fg)] hover:bg-[color:var(--notation-accent-20)]'
                  : 'text-[var(--notation-fg-muted)]')
              }
            >
              {d}
              {count > 0 && <span className={'mt-0.5 w-1.5 h-1.5 rounded-full ' + (isSel ? 'bg-[var(--notation-fg-on-accent)]' : 'bg-[color:var(--notation-accent)]')} />}
            </button>
          )
        })}
      </div>
      {selDay && (
        <ul className="mt-4 space-y-1.5">
          {selected.map(e => (
            <li key={e.id}>
              <button onClick={() => onPick(e.id)} className="w-full text-left px-3 py-2 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] hover:border-[color:var(--notation-accent-40)] flex justify-between gap-3">
                <span className="text-sm text-[var(--notation-fg)] truncate">{e.title || '(untitled)'}</span>
                <span className="text-[11px] text-[var(--notation-fg-muted)] flex-shrink-0">{formatTime(e.created_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---- Search --------------------------------------------------------------

function SearchView({ schema, entries, onOpen }: { schema: FormSchema; entries: FormEntry[]; onOpen: (id: string) => void }) {
  const [q, setQ] = useState('')
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter(e => {
      if (e.title.toLowerCase().includes(needle)) return true
      return Object.values(e.values).some(v => String(v ?? '').toLowerCase().includes(needle))
    })
  }, [q, entries])
  return (
    <div>
      <div className="relative mb-4">
        <SearchIcon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--notation-fg-muted)]" />
        <input
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search entries…"
          className="w-full bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] rounded-md pl-9 pr-3 py-2 text-sm text-[var(--notation-fg)] outline-none focus:border-[color:var(--notation-accent)]"
        />
      </div>
      {results.length === 0
        ? <p className="text-sm text-[var(--notation-fg-muted)] italic">No matching entries.</p>
        : <EntryList schema={schema} entries={results} onOpen={onOpen} />}
    </div>
  )
}

// ---- helpers -------------------------------------------------------------

function fieldDisplay(f: FormField, v: unknown): string {
  if (v == null || v === '') return ''
  if (f.type === 'bool') return v === true ? 'Yes' : 'No'
  return String(v)
}
function pad(n: number): string { return n < 10 ? '0' + n : String(n) }
function localDayKey(iso: string): string | null {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function formatDateTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
function formatTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleTimeString(undefined, { timeStyle: 'short' })
}
