import { useEffect, useState, type FormEvent } from 'react'
import { Lock, Unlock, ShieldAlert, X, AlertTriangle } from 'lucide-react'
import * as api from '../lib/api'
import * as keyStore from '../lib/keyStore'
import { getActorId } from '../lib/encSpace'
import { encryptSpaceContent, decryptSpaceContent, type PlaintextSource, type PlaintextSink } from '../lib/convert'
import { purgeLocalSpaceData } from '../lib/purgeLocalSpaceData'
import { migrateLegacyComments } from '../lib/encComments'
import { EncryptedFS } from '../../shared/vfs/encfs'
import { HttpEncStore } from '../../shared/vfs/httpEncStore'
import type { KeyHandle } from '../../shared/crypto/keys'
import { RecoveryKeyModal } from './RecoveryKeyModal'

/**
 * ConvertDialog — the blocking UI that converts an existing space between
 * plaintext and zero-knowledge encrypted, in either direction.
 *
 *   to-encrypted: password + confirm → copy every file as ciphertext → show the
 *                 one-time recovery key → finalize (purges plaintext + history).
 *   to-plaintext: a stern confirm → decrypt every file back to plaintext →
 *                 finalize (purges ciphertext), then re-lock the (now plaintext)
 *                 space.
 *
 * The source mode is never destroyed until the very last finalize step, and any
 * failure before then calls abort-convert so the original space stays intact.
 */
type Phase = 'input' | 'working' | 'recovery' | 'error'

export function ConvertDialog({
  spaceID,
  direction,
  handle,
  onClose,
  onDone,
}: {
  spaceID: string
  direction: api.ConvertDirection
  /** Unlocked session handle — required for to-plaintext (reading ciphertext). */
  handle?: KeyHandle
  onClose: () => void
  onDone: (meta: api.Meta) => void
}) {
  const encrypting = direction === 'to-encrypted'
  const [phase, setPhase] = useState<Phase>('input')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [recovery, setRecovery] = useState<string | null>(null)
  const [pendingHandle, setPendingHandle] = useState<KeyHandle | null>(null)

  // Esc closes only while it is still safe (before work starts) — a mid-flight
  // conversion must not be abandoned by a stray keypress.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && phase === 'input') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  const onProgress = (done: number, total: number) => setProgress({ done, total })

  async function runEncrypt() {
    setErr(null)
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return }
    if (password !== confirm) { setErr('Passwords do not match.'); return }
    setPhase('working')
    setProgress(null)
    let begun = false
    try {
      await api.beginConvert(spaceID, 'to-encrypted')
      begun = true
      const source: PlaintextSource = {
        listFiles: () => api.listFilesFlat(spaceID),
        readBytes: (p) => api.readFileBytes(spaceID, p),
      }
      const store = new HttpEncStore(spaceID)
      const res = await encryptSpaceContent(source, store, password, { actorId: getActorId(), onProgress })
      // Migrate existing plaintext comments into the encrypted op-log BEFORE
      // finalize purges comments.jsonl. The all-comments endpoint is reachable
      // here because the in-flight conversion relaxes the plaintext gate. A
      // failure falls through to the catch → abortConvert (nothing destroyed).
      const legacyComments = await api.getAllComments(spaceID)
      if (legacyComments.length > 0) {
        const fs = await EncryptedFS.open(store, res.handle, getActorId())
        await migrateLegacyComments(fs, legacyComments)
      }
      setPendingHandle(res.handle)
      setRecovery(res.recoveryDisplay)
      setPhase('recovery')
    } catch (e) {
      // Nothing plaintext was destroyed — roll the marker + staging back.
      if (begun) { try { await api.abortConvert(spaceID) } catch { /* best-effort */ } }
      setErr(errMsg(e))
      setPhase('error')
    }
  }

  // Called from the recovery modal's Continue button: the ONLY destructive step.
  async function finishEncrypt() {
    try {
      const meta = await api.finalizeConvert(spaceID)
      // The server side is now ciphertext-only — but this browser still holds
      // everything plaintext mode wrote for the SAME space id: the opt-in
      // offline copy (real file bodies!), bookmarks, scroll/read positions and
      // the collapsed-folder map, all in the clear. Encrypted mode never reads
      // them, so nothing would ever overwrite them. Wipe them here, or the
      // zero-knowledge promise is only true on the server.
      await purgeLocalSpaceData(spaceID)
      if (pendingHandle) keyStore.set(spaceID, pendingHandle)
      onDone(meta)
    } catch (e) {
      setErr(errMsg(e))
      setRecovery(null)
      setPhase('error')
    }
  }

  async function runDecrypt() {
    setErr(null)
    if (!handle) { setErr('Space is locked — unlock it first.'); return }
    setPhase('working')
    setProgress(null)
    let begun = false
    try {
      await api.beginConvert(spaceID, 'to-plaintext')
      begun = true
      const store = new HttpEncStore(spaceID)
      const sink: PlaintextSink = {
        writeBytes: (p, bytes) => api.writeFileBinary(spaceID, p, new Blob([bytes as BlobPart])),
      }
      await decryptSpaceContent(store, handle, sink, { actorId: getActorId(), onProgress })
      const meta = await api.finalizeConvert(spaceID)
      keyStore.lock(spaceID) // it is plaintext now — drop the key
      onDone(meta)
    } catch (e) {
      if (begun) { try { await api.abortConvert(spaceID) } catch { /* best-effort */ } }
      setErr(errMsg(e))
      setPhase('error')
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (encrypting) void runEncrypt()
    else void runDecrypt()
  }

  if (phase === 'recovery' && recovery) {
    return <RecoveryKeyModal recovery={recovery} onConfirm={() => void finishEncrypt()} />
  }

  const inputCls = 'w-full px-3 py-2 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--notation-accent-30)] focus:border-[color:var(--notation-accent-40)] transition-colors'

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-[var(--notation-backdrop)] backdrop-blur-sm animate-in fade-in duration-150"
      onClick={() => { if (phase === 'input' || phase === 'error') onClose() }}
    >
      <div
        className="surface-gradient bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] rounded-xl shadow-2xl max-w-md w-full p-6 animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="convert-title"
      >
        <div className="flex items-start justify-between mb-1">
          <h2 id="convert-title" className="text-xl font-bold text-[var(--notation-fg)] flex items-center gap-2">
            {encrypting ? <Lock size={18} /> : <Unlock size={18} />}
            {encrypting ? 'Encrypt this space' : 'Decrypt this space'}
          </h2>
          {(phase === 'input' || phase === 'error') && (
            <button onClick={onClose} className="p-1 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] rounded -mr-1" aria-label="Close">
              <X size={18} />
            </button>
          )}
        </div>

        {phase === 'working' ? (
          <div className="py-6 text-center">
            <div className="inline-block w-8 h-8 border-2 border-[color:var(--notation-accent)] border-t-transparent rounded-full animate-spin mb-4" />
            <p className="text-sm text-[var(--notation-fg)]">
              {encrypting ? 'Encrypting your content…' : 'Decrypting your content…'}
            </p>
            {progress && (
              <p className="text-xs text-[var(--notation-fg-muted)] mt-1 tabular-nums">
                {progress.done} / {progress.total} files
              </p>
            )}
            <p className="text-[11px] text-[var(--notation-fg-muted)] mt-3">
              Do not close this tab until it finishes.
            </p>
          </div>
        ) : encrypting ? (
          <form onSubmit={submit} className="space-y-4 mt-2">
            <div className="flex items-start gap-2 rounded-md border border-[color:var(--notation-warning)] bg-[color:var(--notation-warning)]/10 p-3 text-xs text-[var(--notation-fg)]">
              <ShieldAlert size={16} className="text-[var(--notation-warning)] flex-shrink-0 mt-0.5" />
              <span>
                Content is encrypted in your browser; the server keeps only ciphertext and the
                plaintext history is <strong>permanently erased</strong>. There is no password reset —
                you will get a one-time recovery key. This cannot be undone without the password.
              </span>
            </div>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password" placeholder="Password (min 8 chars)" className={inputCls} />
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" placeholder="Confirm password" className={inputCls} />
            {err && <p className="text-[var(--notation-danger)] text-sm flex items-start gap-1.5"><AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />{err}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose} className="flex-1 px-4 py-2 rounded-md text-sm font-medium text-[var(--notation-fg)] hover:bg-[var(--notation-border)] transition-colors">Cancel</button>
              <button type="submit" disabled={!password || !confirm} className="flex-1 px-4 py-2 rounded-md text-sm font-semibold bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:opacity-90 disabled:opacity-40 transition-colors">Encrypt</button>
            </div>
          </form>
        ) : (
          <form onSubmit={submit} className="space-y-4 mt-2">
            <div className="flex items-start gap-2 rounded-md border border-[color:var(--notation-warning)] bg-[color:var(--notation-warning)]/10 p-3 text-xs text-[var(--notation-fg)]">
              <ShieldAlert size={16} className="text-[var(--notation-warning)] flex-shrink-0 mt-0.5" />
              <span>
                Decrypting writes every file back as <strong>plaintext the server can read</strong>.
                The encryption, recovery key and zero-knowledge protection are removed. Search,
                sharing, comments and MCP become available again.
              </span>
            </div>
            {err && <p className="text-[var(--notation-danger)] text-sm flex items-start gap-1.5"><AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />{err}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose} className="flex-1 px-4 py-2 rounded-md text-sm font-medium text-[var(--notation-fg)] hover:bg-[var(--notation-border)] transition-colors">Cancel</button>
              <button type="submit" className="flex-1 px-4 py-2 rounded-md text-sm font-semibold bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:opacity-90 transition-colors">Decrypt</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e)
}
