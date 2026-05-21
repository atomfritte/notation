import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import * as auth from '../lib/auth'
import { AuthShell } from './auth/AuthShell'
import { Claim } from './auth/Claim'
import { PasskeySetup } from './auth/PasskeySetup'
import { PasskeyLogin } from './auth/PasskeyLogin'

type Props = { children: ReactNode }

/**
 * AuthGate sits between the app router and the actual admin UI. On every
 * mount (and whenever a 401 fires via the `notation:auth-expired` event), it
 * re-fetches /api/auth/state and dispatches to the right screen:
 *
 *   needs_claim          → Claim
 *   !signed_in + passkey → PasskeyLogin
 *   !signed_in + no pk   → "stuck" recovery hint
 *   needs_passkey_setup  → PasskeySetup
 *   signed_in + ready    → render children
 *   auth_mode=authelia   → bypass entirely (perimeter handles it)
 */
export function AuthGate({ children }: Props) {
  const [state, setState] = useState<auth.AuthState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const s = await auth.fetchState()
      setState(s)
    } catch (e) {
      setErr(String(e))
      setState(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    function onExpired() {
      void refresh()
    }
    window.addEventListener('notation:auth-expired', onExpired)
    return () => window.removeEventListener('notation:auth-expired', onExpired)
  }, [refresh])

  if (loading && !state) {
    return (
      <AuthShell title="Loading…">
        <div className="h-2 w-full bg-zinc-100 dark:bg-zinc-800 rounded overflow-hidden">
          <div className="h-full w-1/3 bg-zinc-400 dark:bg-[#BFF355] animate-pulse rounded" />
        </div>
      </AuthShell>
    )
  }
  if (!state) {
    return (
      <AuthShell title="Server unreachable" subtitle="Could not fetch /api/auth/state.">
        <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{err ?? 'unknown error'}</span>
        </div>
        <button
          onClick={() => void refresh()}
          className="mt-4 w-full px-4 py-2 bg-zinc-900 text-white dark:bg-[#BFF355] dark:text-zinc-950 rounded-md text-sm font-semibold"
        >
          Retry
        </button>
      </AuthShell>
    )
  }

  // Authelia handles auth at the perimeter; trust the upstream check.
  if (state.auth_mode === 'authelia') {
    return <>{children}</>
  }

  if (state.needs_claim) {
    return <Claim onDone={refresh} />
  }
  if (!state.signed_in) {
    if (state.has_passkeys) {
      return <PasskeyLogin onDone={refresh} />
    }
    return (
      <AuthShell
        title="No way in"
        subtitle="The admin is claimed but no passkey is registered, and your session has expired."
      >
        <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
          Reset on the server to issue a new bootstrap token. Your spaces and
          shares are untouched.
        </p>
        <pre className="mt-3 bg-zinc-100 dark:bg-zinc-950 text-xs p-3 rounded-md overflow-auto select-all">
          rm /data/.notation/admin.json{'\n'}docker restart notation
        </pre>
        <button
          onClick={() => void refresh()}
          className="mt-4 w-full px-4 py-2 bg-zinc-900 text-white dark:bg-[#BFF355] dark:text-zinc-950 rounded-md text-sm font-semibold"
        >
          I did it — retry
        </button>
      </AuthShell>
    )
  }
  if (state.needs_passkey_setup) {
    return <PasskeySetup onDone={refresh} />
  }
  return <>{children}</>
}
