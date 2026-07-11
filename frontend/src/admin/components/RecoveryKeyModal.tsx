import { useState } from 'react'
import { ShieldAlert, Copy, Check } from 'lucide-react'

/**
 * RecoveryKeyModal — shows a freshly created encrypted space's recovery key
 * exactly ONCE. The key is the only way back in if the password is forgotten,
 * and it is never persisted anywhere, so the user must copy/write it down and
 * explicitly confirm before this dismisses.
 */
export function RecoveryKeyModal({
  recovery,
  onConfirm,
}: {
  recovery: string
  onConfirm: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(recovery)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked — the key is visible to copy manually */
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-[var(--notation-backdrop)] backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="surface-gradient bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] rounded-xl shadow-2xl max-w-md w-full p-6 animate-in zoom-in-95 duration-150"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-title"
      >
        <div className="flex items-center gap-2 mb-2 text-[var(--notation-warning)]">
          <ShieldAlert size={20} />
          <h2 id="recovery-title" className="text-xl font-bold text-[var(--notation-fg)]">
            Save your recovery key
          </h2>
        </div>
        <p className="text-sm text-[var(--notation-fg-muted)] mb-4 leading-relaxed">
          This is shown <strong className="text-[var(--notation-fg)]">once</strong>. Save it now — it
          is the <strong className="text-[var(--notation-fg)]">only</strong> way in if you forget the
          password. It is stored nowhere and <strong className="text-[var(--notation-fg)]">cannot be
          recovered</strong>.
        </p>

        <div className="relative">
          <pre className="bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-md p-4 text-sm font-mono text-[var(--notation-fg)] break-all whitespace-pre-wrap select-all leading-relaxed">
            {recovery}
          </pre>
          <button
            onClick={copy}
            className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] transition-colors"
            title="Copy recovery key"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <label className="flex items-start gap-2 mt-5 text-sm text-[var(--notation-fg)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="mt-0.5 accent-[var(--notation-accent)]"
          />
          <span>I have saved this recovery key somewhere safe.</span>
        </label>

        <button
          onClick={onConfirm}
          disabled={!saved}
          className="mt-5 w-full px-4 py-2 rounded-md text-sm font-semibold bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
