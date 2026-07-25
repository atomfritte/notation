import { useCallback, useEffect, useState } from 'react'
import {
  X, FolderSync, FolderOpen, FolderDown, FolderUp, HardDrive, AlertTriangle,
  ShieldAlert, Info, Check, Plus, Pencil, Trash2, RefreshCw,
} from 'lucide-react'
import type { SyncSpace } from '../lib/syncSpace'
import {
  pull, preparePush, applyPush, type PreparedPush, type PushEntry, type SyncDirHandle,
} from '../lib/folderSync'
import {
  getFolderRecord, setFolderHandle, setManifest, clearFolder,
} from '../lib/folderHandleStore'
import {
  folderSyncSupported, pickDirectory, ensureReadWritePermission, hasReadWritePermission,
} from '../lib/fsAccess'

/**
 * FolderSyncPanel — the UI for manual local-folder sync, for ANY space
 * (encrypted or plaintext); the {@link SyncSpace} port hides the difference.
 *
 * Two explicit, user-driven actions (never live auto-sync):
 *   - **Pull** writes the whole space into a folder the user picks, so a local
 *     agent (Claude Code) can work on it as plain files.
 *   - **Push** reads the folder back, previews a 3-way diff (new / modified /
 *     deleted / conflict) against the current space + last-sync manifest, and —
 *     only on explicit confirm — applies the changes. Deletions are opt-in.
 *
 * For an ENCRYPTED space the browser stays the crypto authority (bytes are
 * de/encrypted in-page, the server only ever sees ciphertext) and the panel
 * states plainly that Pull writes DECRYPTED plaintext to local disk. For a
 * plaintext space a push is an ordinary server write, so git history records it.
 */
type Phase = 'home' | 'working' | 'preview' | 'result' | 'error'

// The engine speaks a minimal subset of FileSystemDirectoryHandle; cast at the
// boundary (the real handle structurally provides it).
const asSyncDir = (h: FileSystemDirectoryHandle): SyncDirHandle => h as unknown as SyncDirHandle

export function FolderSyncPanel({
  space,
  spaceID,
  onClose,
  onSynced,
}: {
  space: SyncSpace
  spaceID: string
  onClose: () => void
  /**
   * Called after a push applies so the caller can refresh its file tree — and
   * drop any cached body for the paths that changed.
   */
  onSynced: (changedPaths: string[]) => void
}) {
  const supported = folderSyncSupported()
  const encrypted = space.encrypted
  const [phase, setPhase] = useState<Phase>('home')
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [granted, setGranted] = useState(false)
  const [busy, setBusy] = useState<string>('') // label while working
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ path: string; error: string }[]>([])
  const [prepared, setPrepared] = useState<PreparedPush | null>(null)
  const [applyDeletions, setApplyDeletions] = useState(false)
  const onProgress = useCallback((done: number, total: number) => setProgress({ done, total }), [])

  // Restore a previously-picked folder handle from IndexedDB (non-secret). We
  // only QUERY permission here (no prompt) — re-granting needs a user click.
  useEffect(() => {
    let cancelled = false
    getFolderRecord(spaceID).then(async (rec) => {
      if (cancelled || !rec?.handle) return
      setHandle(rec.handle)
      setGranted(await hasReadWritePermission(rec.handle))
    })
    return () => { cancelled = true }
  }, [spaceID])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && phase !== 'working') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  const folderName = handle?.name ?? null

  /** Resolve a usable, permission-granted handle — picking one if needed. */
  const ensureHandle = useCallback(async (): Promise<FileSystemDirectoryHandle | null> => {
    let h = handle
    if (!h) {
      h = await pickDirectory()
      if (!h) return null // user cancelled
      await setFolderHandle(spaceID, h)
      setHandle(h)
    }
    const ok = await ensureReadWritePermission(h)
    setGranted(ok)
    if (!ok) throw new Error('Permission to read/write that folder was not granted.')
    return h
  }, [handle, spaceID])

  const chooseFolder = useCallback(async () => {
    setErr(null)
    try {
      const h = await pickDirectory()
      if (!h) return
      await setFolderHandle(spaceID, h)
      setHandle(h)
      setGranted(await ensureReadWritePermission(h))
    } catch (e) { setErr(errMsg(e)) }
  }, [spaceID])

  const disconnect = useCallback(async () => {
    await clearFolder(spaceID)
    setHandle(null)
    setGranted(false)
    setPrepared(null)
  }, [spaceID])

  const doPull = useCallback(async () => {
    setErr(null); setResult(null); setFailed([]); setProgress(null)
    setPhase('working')
    setBusy(encrypted ? 'Decrypting the space into your folder…' : 'Copying the space into your folder…')
    try {
      const h = await ensureHandle()
      if (!h) { setPhase('home'); return }
      const res = await pull(space, asSyncDir(h), onProgress)
      await setManifest(spaceID, res.manifest.entries)
      setResult(`Wrote ${res.written.length} file${res.written.length === 1 ? '' : 's'} to “${h.name}”.`)
      setPhase('result')
    } catch (e) { setErr(errMsg(e)); setPhase('error') }
  }, [ensureHandle, space, spaceID, encrypted, onProgress])

  const doPreparePush = useCallback(async () => {
    setErr(null); setResult(null); setFailed([]); setProgress(null); setApplyDeletions(false)
    setPhase('working'); setBusy('Reading folder & diffing against the space…')
    try {
      const h = await ensureHandle()
      if (!h) { setPhase('home'); return }
      const rec = await getFolderRecord(spaceID)
      const p = await preparePush(space, asSyncDir(h), rec?.manifest, onProgress)
      setPrepared(p)
      setPhase('preview')
    } catch (e) { setErr(errMsg(e)); setPhase('error') }
  }, [ensureHandle, space, spaceID, onProgress])

  const confirmPush = useCallback(async () => {
    if (!prepared || !handle) return
    setProgress(null)
    setPhase('working')
    setBusy(encrypted ? 'Re-encrypting folder changes into the space…' : 'Writing folder changes into the space…')
    try {
      const res = await applyPush(space, asSyncDir(handle), prepared, { applyDeletions }, onProgress)
      await setManifest(spaceID, res.manifest.entries)
      const parts: string[] = []
      if (res.applied.new) parts.push(`${res.applied.new} added`)
      if (res.applied.modified) parts.push(`${res.applied.modified} updated`)
      if (res.applied.deleted) parts.push(`${res.applied.deleted} deleted`)
      if (res.skippedDeletions) parts.push(`${res.skippedDeletions} deletion${res.skippedDeletions === 1 ? '' : 's'} skipped`)
      setResult(parts.length ? `Applied: ${parts.join(' · ')}.` : 'Nothing to apply — the space was already up to date.')
      setFailed(res.failed)
      setPrepared(null)
      onSynced(res.changedPaths)
      setPhase('result')
    } catch (e) { setErr(errMsg(e)); setPhase('error') }
  }, [prepared, handle, space, spaceID, applyDeletions, onSynced, encrypted, onProgress])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-[var(--notation-backdrop)] backdrop-blur-sm animate-in fade-in duration-150"
      onClick={() => { if (phase !== 'working') onClose() }}
    >
      <div
        className="surface-gradient bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] rounded-xl shadow-2xl max-w-lg w-full p-6 animate-in zoom-in-95 duration-150 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="foldersync-title"
      >
        <div className="flex items-start justify-between mb-2 flex-shrink-0">
          <h2 id="foldersync-title" className="text-xl font-bold text-[var(--notation-fg)] flex items-center gap-2">
            <FolderSync size={18} /> Local folder sync
          </h2>
          {phase !== 'working' && (
            <button onClick={onClose} className="p-1 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] rounded -mr-1" aria-label="Close">
              <X size={18} />
            </button>
          )}
        </div>

        {!supported ? (
          <p className="text-sm text-[var(--notation-fg-muted)] py-4">
            This browser can’t open a local folder. Use a Chromium-based browser (Chrome, Edge, Brave)
            over https or localhost to sync this space to a folder.
          </p>
        ) : phase === 'working' ? (
          <div className="py-8 text-center">
            <div className="inline-block w-8 h-8 border-2 border-[color:var(--notation-accent)] border-t-transparent rounded-full animate-spin mb-4" />
            <p className="text-sm text-[var(--notation-fg)]">{busy}</p>
            {progress && progress.total > 0 && (
              <div className="mt-4 mx-auto max-w-[16rem]">
                <div className="h-1.5 rounded-full bg-[var(--notation-border)] overflow-hidden">
                  <div
                    className="h-full bg-[color:var(--notation-accent)] transition-[width] duration-150"
                    style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                  />
                </div>
                <p className="text-[11px] text-[var(--notation-fg-muted)] mt-1.5 tabular-nums">
                  {progress.done} / {progress.total} files
                </p>
              </div>
            )}
            <p className="text-[11px] text-[var(--notation-fg-muted)] mt-3">Do not close this tab until it finishes.</p>
          </div>
        ) : phase === 'preview' && prepared ? (
          <PushPreview
            prepared={prepared}
            applyDeletions={applyDeletions}
            onToggleDeletions={setApplyDeletions}
            onBack={() => setPhase('home')}
            onConfirm={() => void confirmPush()}
          />
        ) : phase === 'result' ? (
          <div className="py-2">
            <div className="flex items-start gap-2 rounded-md border border-[color:var(--notation-accent-40)] bg-[color:var(--notation-accent-10)] p-3 text-sm text-[var(--notation-fg)] mb-4">
              <Check size={16} className="text-[color:var(--notation-accent)] flex-shrink-0 mt-0.5" />
              <span>{result}</span>
            </div>
            {failed.length > 0 && (
              <div className="rounded-md border border-[color:var(--notation-danger)] bg-[var(--notation-danger)]/10 p-3 mb-4">
                <p className="text-xs text-[var(--notation-fg)] flex items-start gap-1.5 mb-2">
                  <AlertTriangle size={13} className="text-[var(--notation-danger)] flex-shrink-0 mt-0.5" />
                  <span>
                    {failed.length} file{failed.length === 1 ? '' : 's'} could not be written. They stay
                    out of the sync record, so the next push retries them.
                  </span>
                </p>
                <ul className="max-h-32 overflow-y-auto space-y-1">
                  {failed.map((f) => (
                    <li key={f.path} className="text-[11px] text-[var(--notation-fg-muted)]">
                      <span className="font-mono text-[var(--notation-fg)]">{f.path}</span> — {f.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button onClick={() => setPhase('home')} className="w-full px-4 py-2 rounded-md text-sm font-medium text-[var(--notation-fg)] hover:bg-[var(--notation-border)] transition-colors">
              Back
            </button>
          </div>
        ) : phase === 'error' ? (
          <div className="py-2">
            <p className="text-[var(--notation-danger)] text-sm flex items-start gap-1.5 mb-4">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />{err}
            </p>
            <button onClick={() => { setErr(null); setPhase('home') }} className="w-full px-4 py-2 rounded-md text-sm font-medium text-[var(--notation-fg)] hover:bg-[var(--notation-border)] transition-colors">
              Back
            </button>
          </div>
        ) : (
          // ── home ──
          <div className="space-y-4 overflow-y-auto">
            {encrypted ? (
              <div className="flex items-start gap-2 rounded-md border border-[color:var(--notation-warning)] bg-[color:var(--notation-warning)]/10 p-3 text-xs text-[var(--notation-fg)]">
                <ShieldAlert size={16} className="text-[var(--notation-warning)] flex-shrink-0 mt-0.5" />
                <span>
                  Pull writes <strong>decrypted (plaintext) files</strong> to the folder you choose so a local
                  tool can edit them. Only your device sees them — the server still stores ciphertext only.
                  Push re-encrypts your edits back in, with a change preview first.
                </span>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] p-3 text-xs text-[var(--notation-fg-muted)]">
                <Info size={16} className="text-[color:var(--notation-accent)] flex-shrink-0 mt-0.5" />
                <span>
                  Pull copies this space into the folder you choose so a local tool can edit it. Push writes
                  your edits back, with a change preview first — each pushed file lands in the space’s
                  version history like any other edit.
                </span>
              </div>
            )}

            {/* Folder connection status */}
            <div className="flex items-center gap-3 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] p-3">
              <HardDrive size={18} className="text-[var(--notation-fg-muted)] flex-shrink-0" />
              <div className="min-w-0 flex-1">
                {folderName ? (
                  <>
                    <div className="text-sm text-[var(--notation-fg)] font-medium truncate flex items-center gap-1.5">
                      {folderName}
                      {granted
                        ? <span className="text-[10px] font-semibold text-[color:var(--notation-accent)] uppercase tracking-wide">connected</span>
                        : <span className="text-[10px] font-semibold text-[var(--notation-warning)] uppercase tracking-wide">needs re-grant</span>}
                    </div>
                    <div className="text-[11px] text-[var(--notation-fg-muted)]">
                      {granted ? 'Ready to pull / push.' : 'Click Pull or Push to re-grant folder access.'}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-[var(--notation-fg-muted)]">No folder chosen yet.</div>
                )}
              </div>
              {folderName ? (
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => void chooseFolder()} title="Choose a different folder" className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-border)] transition-colors">
                    <RefreshCw size={15} />
                  </button>
                  <button onClick={() => void disconnect()} title="Forget this folder" className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-danger)] hover:bg-[var(--notation-border)] transition-colors">
                    <Trash2 size={15} />
                  </button>
                </div>
              ) : (
                <button onClick={() => void chooseFolder()} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] text-[var(--notation-fg)] hover:bg-[var(--notation-border)] transition-colors">
                  <FolderOpen size={15} /> Choose…
                </button>
              )}
            </div>

            {/* Actions */}
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => void doPull()} className="flex flex-col items-start gap-1 p-3 rounded-lg border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] hover:border-[color:var(--notation-accent-40)] hover:bg-[color:var(--notation-accent-10)] transition-colors text-left">
                <FolderDown size={18} className="text-[color:var(--notation-accent)]" />
                <span className="text-sm font-semibold text-[var(--notation-fg)]">Pull</span>
                <span className="text-[11px] text-[var(--notation-fg-muted)] leading-tight">
                  {encrypted ? 'Decrypt the space into the folder.' : 'Copy the space into the folder.'}
                </span>
              </button>
              <button onClick={() => void doPreparePush()} className="flex flex-col items-start gap-1 p-3 rounded-lg border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] hover:border-[color:var(--notation-accent-40)] hover:bg-[color:var(--notation-accent-10)] transition-colors text-left">
                <FolderUp size={18} className="text-[color:var(--notation-accent)]" />
                <span className="text-sm font-semibold text-[var(--notation-fg)]">Push</span>
                <span className="text-[11px] text-[var(--notation-fg-muted)] leading-tight">Review folder edits & apply them back.</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── push change preview ──────────────────────────────────────────────────────

export function PushPreview({
  prepared, applyDeletions, onToggleDeletions, onBack, onConfirm,
}: {
  prepared: PreparedPush
  applyDeletions: boolean
  onToggleDeletions: (v: boolean) => void
  onBack: () => void
  onConfirm: () => void
}) {
  const { counts } = prepared.plan
  const deletions = prepared.plan.entries.filter((e) => e.kind === 'deleted')
  const nonDeletions = prepared.plan.entries.filter((e) => e.kind !== 'deleted')
  const nothing = prepared.plan.entries.length === 0

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex flex-wrap gap-2 mb-3 text-xs flex-shrink-0">
        <Stat label="new" n={counts.new} tone="accent" />
        <Stat label="modified" n={counts.modified} tone="warning" />
        <Stat label="deleted" n={counts.deleted} tone="danger" />
        {counts.conflict > 0 && <Stat label="conflict" n={counts.conflict} tone="danger" />}
        <Stat label="unchanged" n={counts.unchanged} tone="muted" />
      </div>

      {prepared.manifestSource === 'none' && !nothing && (
        <div className="flex items-start gap-2 rounded-md border border-[color:var(--notation-warning)] bg-[color:var(--notation-warning)]/10 p-2.5 text-[11px] text-[var(--notation-fg)] mb-3">
          <AlertTriangle size={13} className="text-[var(--notation-warning)] flex-shrink-0 mt-0.5" />
          <span>No prior sync record found for this folder, so this diff is best-effort (folder-wins). Review carefully.</span>
        </div>
      )}

      {counts.conflict > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-[color:var(--notation-danger)] bg-[color:var(--notation-danger)]/10 p-2.5 text-[11px] text-[var(--notation-fg)] mb-3">
          <AlertTriangle size={13} className="text-[var(--notation-danger)] flex-shrink-0 mt-0.5" />
          <span>{counts.conflict} file{counts.conflict === 1 ? ' was' : 's were'} changed in BOTH the folder and the space since the last sync. Applying keeps the folder’s version (folder-wins).</span>
        </div>
      )}

      {nothing ? (
        <p className="text-sm text-[var(--notation-fg-muted)] py-4 text-center">The folder matches the space — nothing to apply.</p>
      ) : (
        <div className="overflow-y-auto min-h-0 flex-1 border border-[var(--notation-border)] rounded-md divide-y divide-[var(--notation-border)] mb-3 max-h-[45vh]">
          {nonDeletions.map((e) => <Row key={e.path} entry={e} />)}
          {deletions.map((e) => <Row key={e.path} entry={e} dimmed={!applyDeletions} />)}
        </div>
      )}

      {deletions.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-[var(--notation-fg)] mb-3 cursor-pointer flex-shrink-0">
          <input type="checkbox" checked={applyDeletions} onChange={(e) => onToggleDeletions(e.target.checked)} className="accent-[color:var(--notation-danger)]" />
          <span>Also delete {deletions.length} file{deletions.length === 1 ? '' : 's'} from the space (missing from the folder)</span>
        </label>
      )}

      <div className="flex gap-2 flex-shrink-0">
        <button onClick={onBack} className="flex-1 px-4 py-2 rounded-md text-sm font-medium text-[var(--notation-fg)] hover:bg-[var(--notation-border)] transition-colors">Cancel</button>
        <button
          onClick={onConfirm}
          disabled={nothing}
          className="flex-1 px-4 py-2 rounded-md text-sm font-semibold bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:opacity-90 disabled:opacity-40 transition-colors"
        >
          Apply to space
        </button>
      </div>
    </div>
  )
}

function Row({ entry, dimmed }: { entry: PushEntry; dimmed?: boolean }) {
  const icon =
    entry.kind === 'new' ? <Plus size={13} className="text-[color:var(--notation-accent)]" />
    : entry.kind === 'modified' ? <Pencil size={13} className="text-[var(--notation-warning)]" />
    : <Trash2 size={13} className="text-[var(--notation-danger)]" />
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 text-xs ${dimmed ? 'opacity-40' : ''}`}>
      <span className="flex-shrink-0">{icon}</span>
      <span className="truncate text-[var(--notation-fg)] font-mono">{entry.path}</span>
      {entry.conflict && (
        <span className="ml-auto flex-shrink-0 text-[9px] font-bold uppercase tracking-wide text-[var(--notation-danger)] bg-[var(--notation-danger)]/15 px-1.5 py-0.5 rounded">conflict</span>
      )}
    </div>
  )
}

function Stat({ label, n, tone }: { label: string; n: number; tone: 'accent' | 'warning' | 'danger' | 'muted' }) {
  const color =
    tone === 'accent' ? 'text-[color:var(--notation-accent)]'
    : tone === 'warning' ? 'text-[var(--notation-warning)]'
    : tone === 'danger' ? 'text-[var(--notation-danger)]'
    : 'text-[var(--notation-fg-muted)]'
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)]">
      <span className={`font-bold tabular-nums ${color}`}>{n}</span>
      <span className="text-[var(--notation-fg-muted)]">{label}</span>
    </span>
  )
}

function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e)
}
