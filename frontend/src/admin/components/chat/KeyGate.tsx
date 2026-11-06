import { useEffect, useRef, useState } from 'react'
import { KeyRound, Loader2, LockKeyhole, ShieldAlert } from 'lucide-react'
import { WrongPasswordError } from '../../lib/ai/keySeal'
import { passwordProblem, protectKey, unlockKey, type AISettings } from '../../lib/ai/settings'

/**
 * Password managers file the chat password under this name. Fixed, so the
 * same entry fills on every Space and device.
 */
const PM_USERNAME = 'Claude assistant'

export const inputCls =
  'w-full min-w-0 px-2.5 py-1.5 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)] text-[13px] outline-none focus:border-[color:var(--notation-accent)]'

/**
 * Takes the composer's place while the API key is sealed and not yet unlocked
 * in this tab (the chat history above stays readable), or while an old
 * unencrypted key waits to be protected with a password.
 */
export function UnlockBar({
  state,
  hint,
  onDone,
  onForgot,
}: {
  state: 'locked' | 'legacy'
  hint?: string
  onDone: (s?: AISettings) => void
  onForgot: () => void
}) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault()
    if (busy) return
    setErr(null)
    if (state === 'legacy') {
      const p = passwordProblem(pw, pw2)
      if (p) { setErr(p); return }
    } else if (!pw) {
      return
    }
    setBusy(true)
    try {
      if (state === 'legacy') onDone(await protectKey(pw))
      else { await unlockKey(pw); onDone() }
    } catch (e) {
      setErr(e instanceof WrongPasswordError ? 'Wrong password.' : (e as Error).message)
      setPw('')
      setTimeout(() => ref.current?.focus(), 0)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border-t border-[var(--notation-border)] px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex flex-col gap-2 bg-[var(--notation-bg-alt)]"
      aria-label={state === 'legacy' ? 'Protect the API key' : 'Unlock the assistant'}
    >
      <div className="flex items-start gap-2 text-[12.5px]">
        {state === 'legacy'
          ? <ShieldAlert size={15} className="flex-shrink-0 mt-0.5 text-[var(--notation-warning)]" />
          : <LockKeyhole size={15} className="flex-shrink-0 mt-0.5 text-[color:var(--notation-accent-text)]" />}
        <div className="min-w-0">
          {state === 'legacy' ? (
            <>
              <div className="font-medium">Protect your API key with a chat password</div>
              <div className="text-[11.5px] text-[var(--notation-fg-muted)] leading-snug">
                Your key ({hint}) is stored unencrypted on the server. Choose a password: the key is encrypted in this browser and the server keeps only the sealed copy. You enter it once per tab.
              </div>
            </>
          ) : (
            <>
              <div className="font-medium">Assistant locked</div>
              <div className="text-[11.5px] text-[var(--notation-fg-muted)] leading-snug">
                Enter your chat password to unlock the API key ({hint}) for this tab.
              </div>
            </>
          )}
        </div>
      </div>
      {/* For password managers: one fixed entry for the chat password. */}
      <input type="text" name="username" autoComplete="username" value={PM_USERNAME} readOnly hidden />
      <div className="flex gap-1.5">
        <input
          ref={ref}
          type="password"
          name="password"
          autoComplete={state === 'legacy' ? 'new-password' : 'current-password'}
          value={pw}
          onChange={e => setPw(e.target.value)}
          placeholder={state === 'legacy' ? 'New chat password' : 'Chat password'}
          aria-label={state === 'legacy' ? 'New chat password' : 'Chat password'}
          className={inputCls}
          disabled={busy}
        />
        {state === 'locked' && (
          <button
            type="submit"
            disabled={busy || !pw}
            className="flex-shrink-0 px-3 py-1.5 rounded-md bg-[color:var(--notation-accent)] text-[var(--notation-fg-on-accent,#fff)] text-[12.5px] font-medium disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} Unlock
          </button>
        )}
      </div>
      {state === 'legacy' && (
        <div className="flex gap-1.5">
          <input
            type="password"
            name="password-confirm"
            autoComplete="new-password"
            value={pw2}
            onChange={e => setPw2(e.target.value)}
            placeholder="Repeat password"
            aria-label="Repeat password"
            className={inputCls}
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !pw || !pw2}
            className="flex-shrink-0 px-3 py-1.5 rounded-md bg-[color:var(--notation-accent)] text-[var(--notation-fg-on-accent,#fff)] text-[12.5px] font-medium disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <LockKeyhole size={13} />} Encrypt key
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 text-[11.5px] min-h-[1rem]">
        {busy ? (
          <span className="text-[var(--notation-fg-muted)]">{state === 'legacy' ? 'Encrypting…' : 'Unlocking…'}</span>
        ) : err ? (
          <span className="text-[var(--notation-danger)]" role="alert">{err}</span>
        ) : null}
        {state === 'locked' && (
          <button type="button" onClick={onForgot} className="ml-auto text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:underline">
            Forgot the password?
          </button>
        )}
      </div>
    </form>
  )
}
