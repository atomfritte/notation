import { useEffect, useState } from 'react'
import { Fingerprint, AlertTriangle } from 'lucide-react'
import * as auth from '../../lib/auth'
import { AuthShell } from './AuthShell'

type Props = { onDone: () => void }

/**
 * PasskeyLogin is the steady-state login screen. Single button kicks off the
 * WebAuthn discoverable-credential ceremony: the browser shows the system
 * passkey picker, the user authenticates, the server verifies the assertion
 * and sets a fresh session cookie.
 */
export function PasskeyLogin({ onDone }: Props) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function login() {
    setBusy(true)
    setErr(null)
    try {
      await auth.loginWithPasskey()
      onDone()
    } catch (e) {
      const msg = String(e)
      if (msg.includes('NotAllowedError')) {
        setErr('Sign-in was cancelled. Try again when you are ready.')
      } else {
        setErr(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  // Many users will land here via a redirect; auto-focus the button so Enter
  // immediately triggers the passkey prompt.
  useEffect(() => {
    const btn = document.getElementById('passkey-login-btn') as HTMLButtonElement | null
    btn?.focus()
  }, [])

  return (
    <AuthShell
      title="Sign in"
      subtitle="Use the passkey you registered on this device, your phone, or a security key."
    >
      <button
        id="passkey-login-btn"
        onClick={login}
        disabled={busy}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-900 text-white dark:bg-[color:var(--notation-accent)] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-[#a6d944] font-semibold text-sm rounded-md transition-colors disabled:opacity-40"
      >
        <Fingerprint size={16} /> {busy ? 'Waiting for device…' : 'Sign in with passkey'}
      </button>
      {err && (
        <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 mt-3">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{err}</span>
        </div>
      )}
      <p className="mt-6 text-xs text-[var(--notation-fg-muted)]">
        Lost your passkey? Run{' '}
        <code className="px-1 bg-zinc-100 dark:bg-zinc-800 rounded">
          rm /data/.notation/admin.json
        </code>{' '}
        on the server and restart — a fresh bootstrap token will print to the
        container logs. Your spaces, shares and MCP tokens stay intact.
      </p>
    </AuthShell>
  )
}
