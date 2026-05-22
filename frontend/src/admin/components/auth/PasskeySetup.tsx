import { useState } from 'react'
import { Fingerprint, AlertTriangle, Check } from 'lucide-react'
import * as auth from '../../lib/auth'
import { AuthShell } from './AuthShell'

type Props = { onDone: () => void }

/**
 * PasskeySetup runs right after the bootstrap claim — the admin has a session
 * but no credentials. We force a passkey registration here so that future
 * logins don't depend on the bootstrap token (which rotates per restart) and
 * are phishing-resistant. The admin can always add more passkeys later from
 * the settings page.
 */
export function PasskeySetup({ onDone }: Props) {
  const [label, setLabel] = useState(defaultLabel())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function register() {
    setBusy(true)
    setErr(null)
    try {
      await auth.registerPasskey(label.trim() || 'Passkey')
      onDone()
    } catch (e) {
      const msg = String(e)
      // Browsers fire a generic NotAllowedError if the user dismisses the
      // system prompt; surface that as a friendlier message.
      if (msg.includes('NotAllowedError')) {
        setErr('You cancelled the passkey prompt. Try again when ready.')
      } else {
        setErr(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="Add a passkey"
      subtitle="Use Touch ID, Windows Hello, your phone, or a hardware security key. Passkeys are phishing-resistant and never leave your device."
    >
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-[var(--notation-fg-muted)] mb-1">
            Label this device
          </label>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="MacBook"
            className="w-full bg-white dark:bg-zinc-950 border border-[var(--notation-border)] focus:border-zinc-400 dark:focus:border-[color:var(--notation-accent)] outline-none rounded-md px-3 py-2 text-sm text-[var(--notation-fg)]"
          />
        </div>
        <button
          onClick={register}
          disabled={busy}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-zinc-900 text-white dark:bg-[color:var(--notation-accent)] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-[#a6d944] font-semibold text-sm rounded-md transition-colors disabled:opacity-40"
        >
          <Fingerprint size={16} /> {busy ? 'Waiting for device…' : 'Register passkey'}
        </button>
        {err && (
          <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{err}</span>
          </div>
        )}
        <ul className="text-xs text-[var(--notation-fg-muted)] mt-4 space-y-1.5">
          <li className="flex items-center gap-2">
            <Check size={12} className="text-[color:var(--notation-accent)]" />
            Nothing is sent or stored on a server.
          </li>
          <li className="flex items-center gap-2">
            <Check size={12} className="text-[color:var(--notation-accent)]" />
            Works with Touch ID, Face ID, Windows Hello, YubiKey…
          </li>
          <li className="flex items-center gap-2">
            <Check size={12} className="text-[color:var(--notation-accent)]" />
            You can add more devices later.
          </li>
        </ul>
      </div>
    </AuthShell>
  )
}

function defaultLabel(): string {
  if (typeof navigator === 'undefined') return 'Passkey'
  const ua = navigator.userAgent
  if (/Mac OS X|Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  if (/Linux/.test(ua)) return 'Linux PC'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android device'
  return 'Passkey'
}
