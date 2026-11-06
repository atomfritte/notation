import { useEffect, useState } from 'react'
import { KeyRound, Loader2, ShieldCheck, X } from 'lucide-react'
import * as api from '../../lib/api'
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, MODELS, isEffort } from '../../lib/ai/models'
import { saveAISettings, type AISettings, type AISettingsUpdate } from '../../lib/ai/settings'

/**
 * Assistant settings: the Claude API key, the defaults new chats start with,
 * instructions for every Space, and an optional skill library Space.
 *
 * Rendered as a modal over the chat panel. `inline` renders the same form
 * without the modal chrome (first-run setup inside the panel).
 */
export function AISettingsForm({
  settings,
  onSaved,
  onCancel,
  firstRun = false,
}: {
  settings: AISettings
  onSaved: (s: AISettings) => void
  onCancel?: () => void
  firstRun?: boolean
}) {
  const [key, setKey] = useState('')
  const [model, setModel] = useState(settings.default_model || DEFAULT_MODEL)
  const [effort, setEffort] = useState(isEffort(settings.default_effort) ? settings.default_effort : DEFAULT_EFFORT)
  const [instructions, setInstructions] = useState(settings.instructions)
  const [library, setLibrary] = useState(settings.skills_space)
  const [spaces, setSpaces] = useState<api.Meta[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (firstRun) return
    api.listSpaces().then(list => setSpaces(list.filter(s => !s.encrypted))).catch(() => setSpaces([]))
  }, [firstRun])

  const fromEnv = settings.key_source === 'env'
  const needKey = !settings.configured

  async function save(extra: AISettingsUpdate = {}) {
    setBusy(true)
    setErr(null)
    try {
      const u: AISettingsUpdate = { ...extra }
      if (key.trim()) u.api_key = key.trim()
      if (!firstRun) {
        u.default_model = model
        u.default_effort = effort
        u.instructions = instructions
        u.skills_space = library
      }
      onSaved(await saveAISettings(u))
      setKey('')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-4 text-[13px]"
      onSubmit={(e) => { e.preventDefault(); void save() }}
    >
      <section className="flex flex-col gap-1.5">
        <label className="font-medium flex items-center gap-1.5" htmlFor="ai-key"><KeyRound size={14} /> Claude API key</label>
        {fromEnv ? (
          <p className="text-[var(--notation-fg-muted)]">
            Set on the server via <code>NOTATION_ANTHROPIC_API_KEY</code> ({settings.key_hint}). Change it there.
          </p>
        ) : (
          <>
            <input
              id="ai-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder={settings.configured ? `Saved: ${settings.key_hint} — paste a new key to replace it` : 'sk-ant-api…'}
              className="px-2.5 py-1.5 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)] font-mono text-[12.5px] outline-none focus:border-[color:var(--notation-accent)]"
              autoFocus={firstRun}
            />
            <p className="text-[11.5px] text-[var(--notation-fg-muted)]">
              Create one at <a className="underline" href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer">platform.claude.com</a>.
              It is stored on this server (readable only by the notation process) and fetched into the browser's memory while you chat.
              {settings.configured && !fromEnv && (
                <> <button type="button" className="underline hover:text-[var(--notation-danger)]" onClick={() => { if (window.confirm('Remove the saved API key? The assistant stops working until you add one again.')) void save({ api_key: '' }) }}>Remove the saved key</button>.</>
              )}
            </p>
          </>
        )}
      </section>

      {!firstRun && (
        <>
          <section className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="font-medium">Default model</span>
              <select value={model} onChange={e => setModel(e.target.value)} className="px-2 py-1.5 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)]">
                {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <span className="text-[11px] text-[var(--notation-fg-muted)]">{MODELS.find(m => m.id === model)?.blurb}</span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-medium">Default effort</span>
              <select value={effort} onChange={e => { const v = e.target.value; if (isEffort(v)) setEffort(v) }} className="px-2 py-1.5 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)]">
                {EFFORTS.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
              <span className="text-[11px] text-[var(--notation-fg-muted)]">{EFFORTS.find(x => x.id === effort)?.blurb}</span>
            </label>
          </section>

          <section className="flex flex-col gap-1">
            <label className="font-medium" htmlFor="ai-instructions">Instructions for every Space</label>
            <textarea
              id="ai-instructions"
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              rows={5}
              maxLength={32_000}
              placeholder="e.g. Write in German. Keep pages short and use tables for comparisons."
              className="px-2.5 py-1.5 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)] outline-none focus:border-[color:var(--notation-accent)] resize-y"
            />
            <span className="text-[11px] text-[var(--notation-fg-muted)]">
              A Space can add its own: an <code>AGENTS.md</code> or <code>CLAUDE.md</code> in its root, and skills as <code>skills/&lt;name&gt;/SKILL.md</code> — the same files Claude Code reads after a folder sync.
            </span>
          </section>

          <section className="flex flex-col gap-1">
            <label className="font-medium" htmlFor="ai-library">Skill library</label>
            <select
              id="ai-library"
              value={library}
              onChange={e => setLibrary(e.target.value)}
              className="px-2 py-1.5 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)]"
            >
              <option value="">None</option>
              {library && spaces && !spaces.some(s => s.id === library) && <option value={library}>{library} (not found)</option>}
              {spaces?.map(s => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
            </select>
            <span className="text-[11px] text-[var(--notation-fg-muted)]">
              A plaintext Space whose <code>SKILL.md</code> skills are offered in every chat. A Space's own skill of the same name wins.
            </span>
          </section>
        </>
      )}

      <section className="rounded-md bg-[var(--notation-bg-alt)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--notation-fg-muted)] flex gap-2">
        <ShieldCheck size={15} className="flex-shrink-0 mt-0.5 text-[var(--notation-success)]" />
        <div>
          <strong className="text-[var(--notation-fg)]">What goes where.</strong> Chats run in your browser and talk to the Claude API directly.
          What Claude reads to answer you (pages, search results) is sent to Anthropic — that is how it works; API data isn't used for training.
          The notation server never sees the conversation; it stores the chat history, sealed with the Space key on encrypted Spaces.
          Every change Claude proposes is shown to you first unless you switch on auto-apply.
        </div>
      </section>

      {err && <div className="text-[12px] text-[var(--notation-danger)]">{err}</div>}

      <div className="flex items-center justify-end gap-2">
        {onCancel && <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-md border border-[var(--notation-border)] hover:bg-[var(--notation-bg-alt)]">Cancel</button>}
        <button
          type="submit"
          disabled={busy || (needKey && !fromEnv && !key.trim())}
          className="px-3 py-1.5 rounded-md bg-[color:var(--notation-accent)] text-[var(--notation-fg-on-accent,#fff)] font-medium disabled:opacity-50 flex items-center gap-1.5"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          {firstRun ? 'Save key and start' : 'Save'}
        </button>
      </div>
    </form>
  )
}

export function AISettingsDialog({
  settings,
  onClose,
  onSaved,
}: {
  settings: AISettings
  onClose: () => void
  onSaved: (s: AISettings) => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[6vh] px-4 bg-[var(--notation-backdrop)] backdrop-blur-sm animate-in fade-in duration-100"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-xl max-h-[88vh] overflow-y-auto surface-gradient bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-xl shadow-2xl"
        onMouseDown={e => e.stopPropagation()}
        role="dialog"
        aria-label="Assistant settings"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--notation-border)]">
          <span className="font-semibold">Assistant settings</span>
          <button onClick={onClose} className="p-1 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="p-5">
          <AISettingsForm settings={settings} onSaved={(s) => { onSaved(s); onClose() }} onCancel={onClose} />
        </div>
      </div>
    </div>
  )
}
