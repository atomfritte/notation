import { useEffect, useState } from 'react'
import { KeyRound, Loader2, LockKeyhole, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import * as api from '../../lib/api'
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, MODELS, isEffort } from '../../lib/ai/models'
import { useModelList } from '../../lib/ai/modelList'
import { checkApiKey, WrongPasswordError } from '../../lib/ai/keySeal'
import { useKeyMemory } from '../../lib/ai/keyMemory'
import {
  keyState, lockKey, passwordProblem, protectKey, removeKey, saveAISettings, unlockKey,
  type AISettings,
} from '../../lib/ai/settings'
import { inputCls } from './KeyGate'

const PM_USERNAME = 'Claude assistant'

const btn = 'px-2.5 py-1 rounded-md border border-[var(--notation-border)] text-[12px] hover:bg-[var(--notation-bg-alt)] disabled:opacity-50'
const primary = 'px-3 py-1.5 rounded-md bg-[color:var(--notation-accent)] text-[var(--notation-fg-on-accent,#fff)] text-[12.5px] font-medium disabled:opacity-50 flex items-center gap-1.5'

/**
 * Enter (or replace) the API key and the chat password that seals it. The key
 * is encrypted in this browser before it is sent; the server can't open it.
 */
function NewKeyForm({
  onSaved,
  onCancel,
  submitLabel,
  autoFocus,
}: {
  onSaved: (s: AISettings) => void
  onCancel?: () => void
  submitLabel: string
  autoFocus?: boolean
}) {
  const [key, setKey] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        setErr(null)
        const k = key.trim()
        const problem = checkApiKey(k) ?? passwordProblem(pw, pw2)
        if (problem) { setErr(problem); return }
        setBusy(true)
        try { onSaved(await protectKey(pw, k)) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
      }}
    >
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={e => setKey(e.target.value)}
        placeholder="sk-ant-api…"
        aria-label="Claude API key"
        className={`${inputCls} font-mono text-[12.5px]`}
        autoFocus={autoFocus}
        disabled={busy}
      />
      <input type="text" name="username" autoComplete="username" value={PM_USERNAME} readOnly hidden />
      <div className="grid grid-cols-2 gap-2">
        <input type="password" name="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Chat password" aria-label="Chat password" className={inputCls} disabled={busy} />
        <input type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="Repeat password" aria-label="Repeat chat password" className={inputCls} disabled={busy} />
      </div>
      <p className="text-[11.5px] text-[var(--notation-fg-muted)] leading-relaxed">
        Create a key at <a className="underline" href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer">platform.claude.com</a>.
        The chat password encrypts it in this browser (Argon2id + AES-256-GCM); the server stores only the sealed copy and can’t read it.
        You enter the password once per tab. If you forget it, just add the key again.
      </p>
      {err && <div className="text-[12px] text-[var(--notation-danger)]" role="alert">{err}</div>}
      <div className="flex items-center justify-end gap-2">
        {onCancel && <button type="button" onClick={onCancel} className={btn}>Cancel</button>}
        <button type="submit" disabled={busy || !key.trim() || !pw || !pw2} className={primary}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <LockKeyhole size={13} />}
          {busy ? 'Encrypting…' : submitLabel}
        </button>
      </div>
    </form>
  )
}

/** Change the chat password: the key stays, only its seal changes. */
function ChangePasswordForm({ unlocked, onSaved, onCancel }: { unlocked: boolean; onSaved: (s: AISettings) => void; onCancel: () => void }) {
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        setErr(null)
        const problem = passwordProblem(pw, pw2)
        if (problem) { setErr(problem); return }
        setBusy(true)
        try {
          if (!unlocked) await unlockKey(cur)
          onSaved(await protectKey(pw))
        } catch (e) {
          setErr(e instanceof WrongPasswordError ? 'The current password is wrong.' : (e as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <input type="text" name="username" autoComplete="username" value={PM_USERNAME} readOnly hidden />
      {!unlocked && (
        <input type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} placeholder="Current password" aria-label="Current chat password" className={inputCls} autoFocus disabled={busy} />
      )}
      <div className="grid grid-cols-2 gap-2">
        <input type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} placeholder="New password" aria-label="New chat password" className={inputCls} autoFocus={unlocked} disabled={busy} />
        <input type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="Repeat new password" aria-label="Repeat new chat password" className={inputCls} disabled={busy} />
      </div>
      {err && <div className="text-[12px] text-[var(--notation-danger)]" role="alert">{err}</div>}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className={btn}>Cancel</button>
        <button type="submit" disabled={busy || (!unlocked && !cur) || !pw || !pw2} className={primary}>
          {busy && <Loader2 size={13} className="animate-spin" />} Change password
        </button>
      </div>
    </form>
  )
}

/** The API key: where it comes from, whether it's unlocked, and what to do with it. */
export function KeySection({ settings, onSaved, firstRun = false }: { settings: AISettings; onSaved: (s: AISettings) => void; firstRun?: boolean }) {
  useKeyMemory()
  const [mode, setMode] = useState<'idle' | 'password' | 'replace' | 'protect'>('idle')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const state = keyState(settings)
  const done = (s: AISettings) => { setMode('idle'); onSaved(s) }

  if (settings.key_source === 'env') {
    return (
      <p className="text-[12.5px] text-[var(--notation-fg-muted)]">
        Set on the server via <code>NOTATION_ANTHROPIC_API_KEY</code> ({settings.key_hint}). Change it there.
        No chat password: whoever runs the server manages this key.
      </p>
    )
  }
  if (!settings.configured) {
    return <NewKeyForm onSaved={onSaved} submitLabel={firstRun ? 'Save key and start' : 'Save key'} autoFocus={firstRun} />
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 rounded-md border border-[var(--notation-border)] px-2.5 py-2">
        {state === 'legacy'
          ? <ShieldAlert size={15} className="flex-shrink-0 text-[var(--notation-warning)]" />
          : <ShieldCheck size={15} className="flex-shrink-0 text-[var(--notation-success)]" />}
        <div className="min-w-0 flex-1 text-[12.5px]">
          <div className="font-mono">{settings.key_hint}</div>
          <div className="text-[11.5px] text-[var(--notation-fg-muted)]">
            {state === 'legacy' ? 'Stored unencrypted — protect it with a chat password.'
              : state === 'ready' ? 'Encrypted with your chat password · unlocked in this tab'
              : 'Encrypted with your chat password · locked'}
          </div>
        </div>
        {state === 'ready' && (
          <button type="button" className={btn} onClick={() => lockKey()} title="Forget the key in this tab; the password is needed again">Lock</button>
        )}
      </div>

      {mode === 'idle' && (
        <div className="flex flex-wrap gap-1.5">
          {state === 'legacy'
            ? <button type="button" className={btn} onClick={() => setMode('protect')}>Set a chat password</button>
            : <button type="button" className={btn} onClick={() => setMode('password')}>Change password</button>}
          <button type="button" className={btn} onClick={() => setMode('replace')} title="Also the way out if you forgot the password">Replace key…</button>
          <button
            type="button"
            className={`${btn} hover:text-[var(--notation-danger)]`}
            disabled={busy}
            onClick={async () => {
              if (!window.confirm('Remove the saved API key? The assistant stops working until you add one again. Your chats stay.')) return
              setBusy(true); setErr(null)
              try { onSaved(await removeKey()) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
            }}
          >
            Remove key
          </button>
        </div>
      )}
      {mode === 'password' && <ChangePasswordForm unlocked={state === 'ready'} onSaved={done} onCancel={() => setMode('idle')} />}
      {mode === 'protect' && <ChangePasswordForm unlocked onSaved={done} onCancel={() => setMode('idle')} />}
      {mode === 'replace' && <NewKeyForm onSaved={done} onCancel={() => setMode('idle')} submitLabel="Replace key" autoFocus />}
      {err && <div className="text-[12px] text-[var(--notation-danger)]">{err}</div>}
    </div>
  )
}

/**
 * Assistant settings: the Claude API key, the defaults new chats start with,
 * instructions for every Space, and an optional skill library Space.
 *
 * `firstRun` renders only the key part (first-run setup inside the panel).
 */
export function AISettingsForm({
  settings,
  onSaved,
  onCancel,
  firstRun = false,
  focusKey = false,
}: {
  settings: AISettings
  /** `close` is false for key changes, which keep the dialog open. */
  onSaved: (s: AISettings, close: boolean) => void
  onCancel?: () => void
  firstRun?: boolean
  /** Open on the key section (e.g. from "Forgot the password?"). */
  focusKey?: boolean
}) {
  const { models } = useModelList()
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

  const keyPart = (
    <section className={`flex flex-col gap-1.5 ${focusKey ? 'rounded-lg ring-2 ring-[color:var(--notation-accent-30)] p-2 -m-2' : ''}`}>
      <span className="font-medium flex items-center gap-1.5"><KeyRound size={14} /> Claude API key</span>
      <KeySection settings={settings} onSaved={(s) => onSaved(s, firstRun)} firstRun={firstRun} />
    </section>
  )
  if (firstRun) return <div className="text-[13px]">{keyPart}</div>

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      onSaved(await saveAISettings({ default_model: model, default_effort: effort, instructions, skills_space: library }), true)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const modelList = models.some(m => m.id === model) ? models : [...models, { id: model, label: model }]
  return (
    <div className="flex flex-col gap-5 text-[13px]">
      {keyPart}

      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-medium">Default model</span>
            <select value={model} onChange={e => setModel(e.target.value)} className="px-2 py-1.5 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)]">
              {modelList.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <span className="text-[11px] text-[var(--notation-fg-muted)]">{MODELS.find(m => m.id === model)?.blurb ?? 'Price not known here'}</span>
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
            Like your personal <code>CLAUDE.md</code> in Claude Code. A Space adds its own — <code>CLAUDE.md</code> / <code>CLAUDE.local.md</code> or <code>AGENTS.md</code>, also in folders, and skills as <code>skills/&lt;name&gt;/SKILL.md</code> — loaded by Claude Code's rules. A folder sync hands Claude Code the same instructions and skills.
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
            A plaintext Space whose <code>SKILL.md</code> skills are offered in every chat — like personal skills in Claude Code, they win over a Space's own skill of the same name.
          </span>
        </section>

        <section className="rounded-md bg-[var(--notation-bg-alt)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--notation-fg-muted)] flex gap-2">
          <ShieldCheck size={15} className="flex-shrink-0 mt-0.5 text-[var(--notation-success)]" />
          <div>
            <strong className="text-[var(--notation-fg)]">What goes where.</strong> Chats run in your browser and talk to the Claude API directly.
            What Claude reads to answer you (pages, search results) is sent to Anthropic — that is how it works; API data isn't used for training.
            The notation server never sees the conversation or your API key; it stores the sealed key and the chat history, sealed with the Space key on encrypted Spaces.
            Every change Claude proposes is shown to you first unless you switch on auto-apply.
          </div>
        </section>

        {err && <div className="text-[12px] text-[var(--notation-danger)]">{err}</div>}

        <div className="flex items-center justify-end gap-2">
          {onCancel && <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-md border border-[var(--notation-border)] hover:bg-[var(--notation-bg-alt)]">Close</button>}
          <button type="submit" disabled={busy} className={primary}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            Save defaults
          </button>
        </div>
      </form>
    </div>
  )
}

export function AISettingsDialog({
  settings,
  onClose,
  onSaved,
  focusKey,
}: {
  settings: AISettings
  onClose: () => void
  onSaved: (s: AISettings) => void
  focusKey?: boolean
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
        className="w-full max-w-xl max-h-[88vh] overflow-y-auto surface-elevated surface-gradient bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-xl shadow-2xl"
        onMouseDown={e => e.stopPropagation()}
        role="dialog"
        aria-label="Assistant settings"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--notation-border)]">
          <span className="font-semibold">Assistant settings</span>
          <button onClick={onClose} className="p-1 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="p-5">
          <AISettingsForm settings={settings} focusKey={focusKey} onSaved={(s, close) => { onSaved(s); if (close) onClose() }} onCancel={onClose} />
        </div>
      </div>
    </div>
  )
}
