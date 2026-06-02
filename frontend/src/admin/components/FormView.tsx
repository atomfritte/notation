import { createContext, useContext, useMemo, useRef, useState } from 'react'
import {
  ClipboardList, Plus, ListChecks, Calendar as CalIcon, Search as SearchIcon,
  ChevronLeft, ChevronRight, ChevronDown, Check, X, ImagePlus, Loader2,
  Pencil, Trash2, Star,
} from 'lucide-react'

// Types mirror the backend form API (and the api.ts FormData shape). Defined
// here so the component is shared by the admin + share SPAs structurally.
export type FormFieldType =
  | 'string' | 'text' | 'integer' | 'number' | 'bool'
  | 'date' | 'time' | 'datetime' | 'select' | 'email' | 'url'
  | 'buttons' | 'multiselect' | 'smiley' | 'rating' | 'slider' | 'image'
export type FormField = {
  key: string; label: string; type: FormFieldType
  required: boolean; options?: string[]; default?: string
  min?: number; max?: number; step?: number; levels?: number
}
export type FormSchema = { title: string; title_field: string; fields: FormField[] }
export type FormEntry = {
  id: string; path: string; created_at: string; title: string
  values: Record<string, unknown>
}
export type FormData = {
  folder: string; schema: FormSchema; entries: FormEntry[]
  can_submit: boolean; can_edit?: boolean
}

type Tab = 'new' | 'entries' | 'calendar' | 'search'

// Image upload + URL building differ between the admin and share SPAs, so the
// host provides them; FieldInput / ImageField / FieldValue read them here rather
// than threading through every layer.
const FormIO = createContext<{
  uploadImage?: (file: Blob) => Promise<string>
  imageURL: (path: string) => string
}>({ imageURL: p => p })

export function FormView({
  data, onSubmit, onUpdate, onDelete, uploadImage, imageURL, onEditTemplate,
}: {
  data: FormData
  onSubmit: (values: Record<string, unknown>) => Promise<void>
  /** Admin-only: update an existing entry. */
  onUpdate?: (id: string, values: Record<string, unknown>) => Promise<void>
  /** Admin-only: delete an existing entry. */
  onDelete?: (id: string) => Promise<void>
  /** Upload one image attachment, returning its stored path. */
  uploadImage?: (file: Blob) => Promise<string>
  /** Build a URL for rendering a stored image path. */
  imageURL?: (path: string) => string
  /** Admin-only: open the _form.md template in the editor. */
  onEditTemplate?: () => void
}) {
  const io = useMemo(() => ({ uploadImage, imageURL: imageURL ?? ((p: string) => p) }), [uploadImage, imageURL])
  const canEdit = !!data.can_edit && !!onUpdate && !!onDelete
  // Defensive: a template with no recognised fields can arrive with a missing
  // / null `fields` — normalise so nothing tries to iterate `undefined`.
  const schema: FormSchema = {
    title: data.schema?.title || 'Form',
    title_field: data.schema?.title_field || '',
    fields: data.schema?.fields ?? [],
  }
  const entries = data.entries ?? []
  const can_submit = !!data.can_submit
  const noFields = schema.fields.length === 0
  const [tab, setTab] = useState<Tab>(can_submit ? 'new' : 'entries')
  const [openId, setOpenId] = useState<string | null>(null)

  const tabs: { key: Tab; label: string; icon: React.ReactNode; show: boolean; badge?: number }[] = [
    { key: 'new', label: 'New entry', icon: <Plus size={15} />, show: can_submit },
    { key: 'entries', label: 'Entries', icon: <ListChecks size={15} />, show: true, badge: entries.length },
    { key: 'calendar', label: 'Calendar', icon: <CalIcon size={15} />, show: true },
    { key: 'search', label: 'Search', icon: <SearchIcon size={15} />, show: true },
  ]

  return (
    <FormIO.Provider value={io}>
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
          noFields ? (
            <div className="text-sm text-[var(--notation-fg-muted)] space-y-3">
              <p>This form has no fields yet. Edit the <code className="px-1 py-0.5 rounded bg-[var(--notation-bg-alt)] text-[var(--notation-fg)]">_form.md</code> template — every line with a <code className="px-1 py-0.5 rounded bg-[var(--notation-bg-alt)] text-[var(--notation-fg)]">[type]</code> tag becomes a field:</p>
              <pre className="bg-[var(--notation-bg-alt)] text-[var(--notation-fg)] rounded-md p-3 text-xs overflow-x-auto">{`# My form
Name: ______ [string] (required)
Date: ______ [date]
Rating: ______ [select: low, mid, high]
Notes:
______ [text]`}</pre>
              {onEditTemplate && (
                <button onClick={onEditTemplate} className="px-4 py-2 bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] font-semibold text-sm rounded-md hover:opacity-90">
                  Edit the template
                </button>
              )}
            </div>
          ) : (
            <EntryForm key="new" schema={schema} initial={blankValues(schema)} submitLabel="Submit entry"
              resetAfter onSubmit={onSubmit} onDone={() => setTab('entries')} />
          )
        )}
        {tab === 'entries' && (
          <EntryBrowser schema={schema} entries={entries} openId={openId} setOpenId={setOpenId}
            canEdit={canEdit} onUpdate={onUpdate} onDelete={onDelete} />
        )}
        {tab === 'calendar' && (
          <CalendarView entries={entries} onPick={(id) => { setOpenId(id); setTab('entries') }} />
        )}
        {tab === 'search' && (
          <SearchView schema={schema} entries={entries} onOpen={(id) => { setOpenId(id); setTab('entries') }} />
        )}
      </div>
    </div>
    </FormIO.Provider>
  )
}

// ---- Entry form (shared by New + Edit) -----------------------------------

// blankValues seeds a fresh entry: booleans false, arrays empty, everything else
// the declared default (or empty). editValues maps a stored entry to input shape.
function blankValues(schema: FormSchema): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const f of schema.fields) {
    if (f.type === 'bool') v[f.key] = false
    else if (f.type === 'multiselect' || f.type === 'image') v[f.key] = []
    else if (f.type === 'slider') v[f.key] = f.default ?? (f.min ?? 0)
    else v[f.key] = f.default ?? ''
  }
  return v
}
function editValues(schema: FormSchema, src: Record<string, unknown>): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const f of schema.fields) {
    const cur = src[f.key]
    if (f.type === 'bool') v[f.key] = cur === true
    else if (f.type === 'multiselect' || f.type === 'image') v[f.key] = Array.isArray(cur) ? cur.map(String) : (cur ? [String(cur)] : [])
    else v[f.key] = cur == null ? '' : cur
  }
  return v
}

function EntryForm({
  schema, initial, submitLabel, onSubmit, onDone, onCancel, resetAfter,
}: {
  schema: FormSchema
  initial: Record<string, unknown>
  submitLabel: string
  onSubmit: (values: Record<string, unknown>) => Promise<void>
  onDone?: () => void
  onCancel?: () => void
  resetAfter?: boolean
}) {
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
      if (resetAfter) {
        setValues(initial)
        setDone(true)
        window.setTimeout(() => setDone(false), 2500)
      }
      onDone?.()
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
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy}
            className="px-3 py-2 text-sm text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] disabled:opacity-50">
            Cancel
          </button>
        )}
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
    case 'buttons':
      return <ButtonChoice options={field.options ?? []} value={s} onChange={onChange} />
    case 'multiselect':
      return <MultiChoice options={field.options ?? []} value={asArray(value)} onChange={onChange} />
    case 'smiley':
      return <SmileyPicker value={toNum(value)} onChange={onChange} />
    case 'rating':
      return <RatingPicker levels={field.levels || 5} value={toNum(value)} onChange={onChange} />
    case 'slider':
      return <SliderInput field={field} value={s} onChange={onChange} />
    case 'image':
      return <ImageField value={asArray(value)} onChange={onChange} />
    default:
      return <input type="text" className={cls} value={s} onChange={e => onChange(e.target.value)} />
  }
}

const pillBase = 'px-3 py-1.5 rounded-full text-sm border transition-colors select-none'
const pillOn = 'bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] border-[var(--notation-accent)]'
const pillOff = 'bg-[var(--notation-bg-alt)] text-[var(--notation-fg)] border-[var(--notation-border)] hover:border-[color:var(--notation-accent-40)]'

function ButtonChoice({ options, value, onChange }: { options: string[]; value: string; onChange: (v: unknown) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(o => (
        <button key={o} type="button" onClick={() => onChange(value === o ? '' : o)}
          className={pillBase + ' ' + (value === o ? pillOn : pillOff)} aria-pressed={value === o}>
          {o}
        </button>
      ))}
    </div>
  )
}

function MultiChoice({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: unknown) => void }) {
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter(x => x !== o) : [...value, o])
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(o => {
        const on = value.includes(o)
        return (
          <button key={o} type="button" onClick={() => toggle(o)} aria-pressed={on}
            className={pillBase + ' inline-flex items-center gap-1 ' + (on ? pillOn : pillOff)}>
            {on && <Check size={13} />}{o}
          </button>
        )
      })}
    </div>
  )
}

const SMILEYS = ['😢', '🙁', '😐', '🙂', '😄']
function SmileyPicker({ value, onChange }: { value: number; onChange: (v: unknown) => void }) {
  return (
    <div className="flex gap-1.5">
      {SMILEYS.map((face, i) => {
        const n = i + 1
        return (
          <button key={n} type="button" onClick={() => onChange(value === n ? '' : n)} title={`${n}/5`}
            className={'text-2xl leading-none p-1 rounded-md transition-transform hover:scale-110 ' + (value === n ? 'grayscale-0 scale-110' : 'grayscale opacity-60')}>
            {face}
          </button>
        )
      })}
    </div>
  )
}

function RatingPicker({ levels, value, onChange }: { levels: number; value: number; onChange: (v: unknown) => void }) {
  return (
    <div className="flex gap-0.5 items-center">
      {Array.from({ length: levels }, (_, i) => i + 1).map(n => (
        <button key={n} type="button" onClick={() => onChange(value === n ? '' : n)} title={`${n}/${levels}`}
          className="p-0.5 text-[color:var(--notation-accent)] hover:scale-110 transition-transform">
          <Star size={22} fill={n <= value ? 'currentColor' : 'none'} className={n <= value ? '' : 'text-[var(--notation-fg-muted)]'} />
        </button>
      ))}
      {value > 0 && <span className="ml-1.5 text-xs text-[var(--notation-fg-muted)]">{value}/{levels}</span>}
    </div>
  )
}

function SliderInput({ field, value, onChange }: { field: FormField; value: string; onChange: (v: unknown) => void }) {
  const min = field.min ?? 0, max = field.max ?? 100, step = field.step ?? 1
  const cur = value === '' ? min : Number(value)
  return (
    <div className="flex items-center gap-3">
      <input type="range" min={min} max={max} step={step} value={cur}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1 accent-[var(--notation-accent)]" />
      <span className="text-sm font-medium text-[var(--notation-fg)] tabular-nums w-12 text-right">{cur}</span>
    </div>
  )
}

function ImageField({ value, onChange }: { value: string[]; onChange: (v: unknown) => void }) {
  const { uploadImage, imageURL } = useContext(FormIO)
  const [busy, setBusy] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function add(files: FileList | null) {
    if (!files || !uploadImage) return
    setErr(null)
    const list = Array.from(files).filter(f => f.type.startsWith('image/'))
    setBusy(b => b + list.length)
    const added: string[] = []
    for (const file of list) {
      try {
        added.push(await uploadImage(await prepareImage(file)))
      } catch (e) {
        setErr(String((e as Error)?.message ?? e))
      } finally {
        setBusy(b => b - 1)
      }
    }
    if (added.length) onChange([...value, ...added])
    if (inputRef.current) inputRef.current.value = ''
  }

  if (!uploadImage) {
    return <p className="text-xs text-[var(--notation-fg-muted)]">Image upload isn’t available here.</p>
  }
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map(p => (
            <div key={p} className="relative">
              <img src={imageURL(p)} alt="" loading="lazy"
                className="w-20 h-20 object-cover rounded-md border border-[var(--notation-border)]" />
              <button type="button" onClick={() => onChange(value.filter(x => x !== p))} title="Remove"
                className="absolute -top-1.5 -right-1.5 bg-[color:var(--notation-danger,#dc2626)] text-white rounded-full p-0.5 shadow">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <label className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-dashed border-[var(--notation-border)] text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:border-[color:var(--notation-accent-40)] cursor-pointer w-fit">
        {busy > 0 ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
        {busy > 0 ? `Uploading… (${busy})` : value.length ? 'Add more' : 'Add image'}
        <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={e => add(e.target.files)} />
      </label>
      {err && <p className="text-xs text-[var(--notation-danger)]">{err}</p>}
    </div>
  )
}

// prepareImage downscales large/heavy images in the browser (respecting EXIF
// orientation) to a reasonable JPEG before upload, so phone photos don't ship at
// full resolution. Falls back to the original file if it can't decode.
async function prepareImage(file: File): Promise<Blob> {
  const MAX_DIM = 1600, MAX_BYTES = 1_000_000
  if (!file.type.startsWith('image/')) return file
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
  } catch {
    return file
  }
  try {
    const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height))
    if (scale === 1 && file.size <= MAX_BYTES) return file
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bmp, 0, 0, w, h)
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.82))
    return blob ?? file
  } finally {
    bmp.close()
  }
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (v == null || v === '') return []
  return [String(v)]
}
function toNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// ---- Entries browser (list + detail) -------------------------------------

function EntryBrowser({
  schema, entries, openId, setOpenId, canEdit, onUpdate, onDelete,
}: {
  schema: FormSchema
  entries: FormEntry[]
  openId: string | null
  setOpenId: (id: string | null) => void
  canEdit: boolean
  onUpdate?: (id: string, values: Record<string, unknown>) => Promise<void>
  onDelete?: (id: string) => Promise<void>
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
        canEdit={canEdit}
        onUpdate={onUpdate}
        onDelete={onDelete}
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
  schema, entry, onBack, onPrev, onNext, position, canEdit, onUpdate, onDelete,
}: {
  schema: FormSchema; entry: FormEntry
  onBack: () => void; onPrev?: () => void; onNext?: () => void; position: string
  canEdit: boolean
  onUpdate?: (id: string, values: Record<string, unknown>) => Promise<void>
  onDelete?: (id: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [delBusy, setDelBusy] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)

  async function doDelete() {
    if (!onDelete) return
    setDelBusy(true); setDelErr(null)
    try {
      await onDelete(entry.id)
      onBack()
    } catch (e) {
      setDelErr(String((e as Error)?.message ?? e))
      setDelBusy(false)
    }
  }

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

      {editing ? (
        <div className="rounded-lg border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] p-4">
          <div className="text-sm font-semibold text-[var(--notation-fg)] mb-3">Edit entry</div>
          <EntryForm
            key={entry.id}
            schema={schema}
            initial={editValues(schema, entry.values)}
            submitLabel="Save changes"
            onSubmit={async (vals) => { await onUpdate?.(entry.id, vals); setEditing(false) }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--notation-border)] flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold text-[var(--notation-fg)] truncate">{entry.title || '(untitled)'}</div>
              <div className="text-xs text-[var(--notation-fg-muted)]">{formatDateTime(entry.created_at)}</div>
            </div>
            {canEdit && (
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => setEditing(true)} title="Edit entry"
                  className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-border)]">
                  <Pencil size={15} />
                </button>
                <button onClick={() => setConfirmDel(true)} title="Delete entry"
                  className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[color:var(--notation-danger,#dc2626)] hover:bg-[var(--notation-border)]">
                  <Trash2 size={15} />
                </button>
              </div>
            )}
          </div>
          {confirmDel && (
            <div className="px-4 py-3 border-b border-[var(--notation-border)] bg-[color:var(--notation-danger-bg,rgba(220,38,38,0.08))] flex items-center gap-3 flex-wrap">
              <span className="text-sm text-[var(--notation-fg)]">Delete this entry? This can’t be undone.</span>
              <div className="flex items-center gap-2 ml-auto">
                <button onClick={doDelete} disabled={delBusy}
                  className="text-sm px-3 py-1.5 rounded-md bg-[color:var(--notation-danger,#dc2626)] text-white disabled:opacity-50">
                  {delBusy ? 'Deleting…' : 'Delete'}
                </button>
                <button onClick={() => setConfirmDel(false)} disabled={delBusy}
                  className="text-sm px-2 py-1.5 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]">Cancel</button>
              </div>
              {delErr && <span className="text-xs text-[var(--notation-danger)] w-full">{delErr}</span>}
            </div>
          )}
          <dl className="divide-y divide-[var(--notation-border)]">
            {schema.fields.map(f => (
              <div key={f.key} className="px-4 py-2.5 grid grid-cols-3 gap-3">
                <dt className="text-sm text-[var(--notation-fg-muted)] truncate col-span-1">{f.label}</dt>
                <dd className="text-sm text-[var(--notation-fg)] col-span-2 whitespace-pre-wrap break-words"><FieldValue field={f} value={entry.values[f.key]} /></dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  )
}

// FieldValue renders a stored value richly in the entry detail (images as
// thumbnails, ratings as stars, etc.).
function FieldValue({ field, value }: { field: FormField; value: unknown }) {
  const { imageURL } = useContext(FormIO)
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
    return <span className="opacity-40">—</span>
  }
  switch (field.type) {
    case 'image':
      return (
        <div className="flex flex-wrap gap-2">
          {asArray(value).map(p => (
            <a key={p} href={imageURL(p)} target="_blank" rel="noreferrer">
              <img src={imageURL(p)} alt="" loading="lazy" className="w-24 h-24 object-cover rounded-md border border-[var(--notation-border)] hover:opacity-90" />
            </a>
          ))}
        </div>
      )
    case 'rating': {
      const n = toNum(value), levels = field.levels || 5
      return (
        <span className="inline-flex items-center gap-0.5 text-[color:var(--notation-accent)]">
          {Array.from({ length: levels }, (_, i) => (
            <Star key={i} size={16} fill={i < n ? 'currentColor' : 'none'} className={i < n ? '' : 'text-[var(--notation-fg-muted)]'} />
          ))}
          <span className="ml-1 text-xs text-[var(--notation-fg-muted)]">{n}/{levels}</span>
        </span>
      )
    }
    case 'smiley': {
      const n = Math.min(Math.max(toNum(value), 1), 5)
      return <span className="text-xl">{SMILEYS[n - 1]} <span className="text-xs text-[var(--notation-fg-muted)] align-middle">{toNum(value)}/5</span></span>
    }
    case 'multiselect':
      return (
        <div className="flex flex-wrap gap-1.5">
          {asArray(value).map(o => <span key={o} className="text-xs px-2 py-0.5 rounded-full bg-[color:var(--notation-accent-15)] text-[var(--notation-fg)]">{o}</span>)}
        </div>
      )
    case 'bool':
      return <span>{value === true ? 'Yes' : 'No'}</span>
    case 'url':
      return <a href={String(value)} target="_blank" rel="noreferrer" className="text-[color:var(--notation-accent)] underline break-all">{String(value)}</a>
    default:
      return <span>{String(value)}</span>
  }
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
  switch (f.type) {
    case 'bool': return v === true ? 'Yes' : 'No'
    case 'smiley': { const n = toNum(v); return n ? SMILEYS[Math.min(Math.max(n, 1), 5) - 1] : '' }
    case 'rating': return '★'.repeat(toNum(v))
    case 'multiselect': return asArray(v).join(', ')
    case 'image': { const n = asArray(v).length; return n ? `${n} image${n > 1 ? 's' : ''}` : '' }
  }
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
