import { useState, type FormEvent } from 'react'
import { AlertTriangle, Key } from 'lucide-react'
import * as auth from '../../lib/auth'
import { AuthShell } from './AuthShell'

type Props = { onDone: () => void }

/**
 * Claim is the first screen the admin sees after fresh deploy. Paste the
 * one-time bootstrap token (printed to the container's stderr on startup),
 * the server validates with constant-time compare, then we drop the user
 * directly into PasskeySetup.
 */
export function Claim({ onDone }: Props) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      await auth.claim(token.trim())
      onDone()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="Claim admin account"
      subtitle="Paste the one-time bootstrap token from your container logs."
    >
      <form onSubmit={submit} className="space-y-3">
        <input
          autoFocus
          value={token}
          onChange={e => setToken(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="paste token here"
          className="w-full bg-white dark:bg-zinc-950 border border-[var(--notation-border)] focus:border-zinc-400 dark:focus:border-[color:var(--notation-accent)] focus:ring-1 focus:ring-zinc-300 dark:focus:ring-[color:var(--notation-accent)] outline-none rounded-md px-3 py-2 font-mono text-sm text-[var(--notation-fg)] placeholder-zinc-400"
        />
        <button
          type="submit"
          disabled={busy || !token.trim()}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-zinc-900 text-white dark:bg-[color:var(--notation-accent)] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-[#a6d944] font-semibold text-sm rounded-md transition-colors disabled:opacity-40"
        >
          <Key size={14} /> {busy ? 'ClaimingÃ¢â‚¬Â¦' : 'Claim admin'}
        </button>
        {err && (
          <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 mt-2">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{err}</span>
          </div>
        )}
      </form>
      <p className="mt-4 text-xs text-[var(--notation-fg-muted)]">
        Where do I find this? Run <code className="px-1 bg-zinc-100 dark:bg-zinc-800 rounded">docker logs notation</code>{' '}
        Ã¢â‚¬â€ the token is printed in a banner each restart, until claimed.
      </p>
    </AuthShell>
  )
}
