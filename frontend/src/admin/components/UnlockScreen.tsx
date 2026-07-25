import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Lock, KeyRound, AlertTriangle, ChevronLeft } from 'lucide-react'
import { HttpEncStore } from '../../shared/vfs/httpEncStore'
import { unlockWithPassword, unlockWithRecovery } from '../../shared/crypto/space'
import type { KeyHandle } from '../../shared/crypto/keys'

/**
 * UnlockScreen — the gate shown when an encrypted space is opened but its key
 * is not in the session {@link keyStore}. It fetches the (non-secret)
 * SpaceKeyRecord, derives the DEK from the password (or the recovery key), and
 * hands the resulting session handle back to the caller, which stores it.
 *
 * The password / recovery key never leave this component: they are used to
 * unwrap the DEK in-memory and then dropped.
 */
export function UnlockScreen({
  spaceID,
  onUnlocked,
}: {
  spaceID: string
  onUnlocked: (handle: KeyHandle) => void
}) {
  const [mode, setMode] = useState<'password' | 'recovery'>('password')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset the field when switching between password / recovery so a half-typed
  // secret doesn't carry over into the other mode.
  useEffect(() => {
    setSecret('')
    setErr(null)
    inputRef.current?.focus()
  }, [mode])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!secret || busy) return
    setBusy(true)
    setErr(null)
    try {
      const record = await new HttpEncStore(spaceID).getKeyRecord()
      if (!record) throw new Error('This space has no key record yet.')
      const handle =
        mode === 'password'
          ? await unlockWithPassword(record, secret)
          : await unlockWithRecovery(record, secret)
      onUnlocked(handle)
    } catch (e) {
      // A wrong password/recovery key fails the AES-GCM tag inside unlock*,
      // which surfaces here as a decrypt error — report it as a bad secret.
      const msg = String((e as Error)?.message ?? e)
      const looksLikeAuthFail = /decrypt|tag|operation-specific|OperationError/i.test(msg)
      setErr(
        looksLikeAuthFail
          ? mode === 'password'
            ? 'Wrong password. Try again, or use your recovery key.'
            : 'That recovery key did not work. Check for typos.'
          : msg,
      )
      setSecret('')
      inputRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-[100dvh] flex flex-col items-center justify-center bg-[var(--notation-bg)] text-[var(--notation-fg)] p-4">
      <div className="w-full max-w-sm">
        <Link
          to="/admin"
          className="inline-flex items-center gap-1 text-sm text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] mb-6 transition-colors"
        >
          <ChevronLeft size={15} /> All Spaces
        </Link>

        <div className="surface-gradient bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] rounded-xl shadow-2xl p-6">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-9 h-9 rounded-lg bg-[color:var(--notation-accent-15)] text-[color:var(--notation-accent)] flex items-center justify-center">
              <Lock size={18} />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">Locked space</h1>
              <p className="text-xs text-[var(--notation-fg-muted)] font-mono">{spaceID}</p>
            </div>
          </div>
          <p className="text-sm text-[var(--notation-fg-muted)] mt-3 mb-5 leading-relaxed">
            This is a zero-knowledge space. Enter its{' '}
            {mode === 'password' ? 'password' : 'recovery key'} to decrypt it in this browser. The
            server never sees the key.
          </p>

          <form onSubmit={submit} className="space-y-3">
            <input
              ref={inputRef}
              type={mode === 'password' ? 'password' : 'text'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoFocus
              autoComplete={mode === 'password' ? 'current-password' : 'off'}
              spellCheck={false}
              placeholder={mode === 'password' ? 'Password' : 'XXXX-XXXX-XXXX-…'}
              className="w-full px-3 py-2 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--notation-accent-30)] focus:border-[color:var(--notation-accent-40)] transition-colors font-mono"
            />
            {err && (
              <p className="flex items-start gap-1.5 text-[var(--notation-danger)] text-xs" aria-live="polite">
                <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
                <span>{err}</span>
              </p>
            )}
            <button
              type="submit"
              disabled={busy || !secret}
              className="w-full px-4 py-2 rounded-md text-sm font-semibold bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
          </form>

          <button
            onClick={() => setMode(mode === 'password' ? 'recovery' : 'password')}
            className="mt-4 inline-flex items-center gap-1.5 text-xs text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] transition-colors"
          >
            <KeyRound size={13} />
            {mode === 'password' ? 'Use recovery key instead' : 'Use password instead'}
          </button>
        </div>
      </div>
    </div>
  )
}
