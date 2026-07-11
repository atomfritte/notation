import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Trash2, Cloud, CloudDownload, CloudOff, RefreshCw, Loader2, Headphones, Lock } from 'lucide-react'
import * as api from '../lib/api'
import * as offline from '../lib/offlineSync'
import { defaultVoice, markdownPagesUnder, vertonenPages, type Cancel } from '../lib/vertonen'

/**
 * SpaceCard — one workspace tile, shared by the landing page's grid view and
 * its Kanban board. Owns its own offline-sync / "include voice" state so the
 * card behaves identically wherever it's rendered. The board wraps this in a
 * sortable handle (see KanbanBoard) but never reaches into its internals.
 *
 * Each card's gradient is derived from a stable string hash of the space id, so
 * the same space always shows the same colour — useful "muscle memory" for
 * spotting a workspace quickly.
 */
export function SpaceCard({ space, onDelete, online, voices }: { space: api.Meta; onDelete: () => void; online: boolean; voices: api.ServerVoice[] }) {
  const hue = useMemo(() => hueFromString(space.id), [space.id])
  const hue2 = (hue + 40) % 360
  const initial = (space.name || space.id).charAt(0).toUpperCase()

  const [synced, setSynced] = useState(() => offline.isOffline(space.id))
  const [info, setInfo] = useState(() => offline.offlineInfo(space.id))
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [op, setOp] = useState<'sync' | 'voice'>('sync')
  const [oerr, setOErr] = useState<string | null>(null)
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null)
  const [voiceFailed, setVoiceFailed] = useState<string[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const voiceCancel = useRef<Cancel>({ cancelled: false })
  const alive = useRef(true)
  // On unmount (e.g. the search box filters this card out mid-run) abort the loop
  // and stop touching state. The cancel ref only breaks between pages/batches, so
  // `alive` also guards the post-await setState in doSync/doVoice.
  useEffect(() => () => { alive.current = false; voiceCancel.current.cancelled = true }, [])
  const busy = progress !== null
  // Offline + not synced = can't open it; dim + block navigation.
  const blocked = !online && !synced

  // Close the offline menu on an outside click, or when connectivity / sync
  // state changes underneath it.
  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])
  useEffect(() => { setMenuOpen(false) }, [online, synced])

  async function doSync() {
    setMenuOpen(false)
    setOErr(null)
    setVoiceMsg(null)
    setOp('sync')
    setProgress({ done: 0, total: 0 })
    try {
      await offline.syncSpace(space.id, space.name || space.id, (done, total) => { if (alive.current) setProgress({ done, total }) })
      if (!alive.current) return
      setSynced(true)
      setInfo(offline.offlineInfo(space.id))
    } catch (e) {
      if (alive.current) setOErr(String((e as Error)?.message ?? e))
    } finally {
      if (alive.current) setProgress(null)
    }
  }
  async function removeOffline() {
    setMenuOpen(false)
    await offline.unsyncSpace(space.id)
    setSynced(false)
    setInfo(undefined)
  }
  // "Include voice": pull the already-synthesised audio for the whole space into
  // the offline cache (cache-only — never triggers synthesis; that's the in-space
  // "Audio vorbereiten" manager's job). Skips clips already cached.
  async function doVoice() {
    setMenuOpen(false)
    setOErr(null)
    setVoiceMsg(null)
    setVoiceFailed([])
    const voiceId = defaultVoice(voices)
    if (!voiceId) return
    setOp('voice')
    setProgress({ done: 0, total: 0 })
    voiceCancel.current = { cancelled: false }
    try {
      const tree = await api.getTree(space.id)
      const pages = markdownPagesUnder(tree, '')
      const r = await vertonenPages(space.id, pages, voiceId, p => { if (alive.current) setProgress({ done: p.done, total: p.total }) }, voiceCancel.current, true)
      if (!alive.current) return
      const failed = [...r.failedPages, ...r.failedClips]
      setVoiceFailed(failed)
      // Surface what happened — a cache-only run on a space with nothing prepared
      // pulls 0 clips (all 404 → skipped), which would otherwise look identical to
      // success and leave airplane-mode playback silently empty.
      setVoiceMsg(
        r.clips > 0
          ? `${r.clips} Audios offline${failed.length ? ` · ${failed.length} fehlgeschlagen` : ''}`
          : 'Noch nichts vertont — erst „Audio vorbereiten" im Space',
      )
    } catch (e) {
      if (alive.current) setOErr(String((e as Error)?.message ?? e))
    } finally {
      if (alive.current) { setProgress(null); setOp('sync') }
    }
  }

  return (
    <div className="group relative" ref={rootRef}>
      <Link
        to={`/admin/spaces/${encodeURIComponent(space.id)}`}
        onClick={(e) => { if (blocked) e.preventDefault() }}
        aria-disabled={blocked}
        aria-busy={busy}
        className={
          'block rounded-xl border border-[var(--notation-border)] bg-gradient-to-b from-[var(--notation-bg-alt)] to-[var(--notation-bg)] overflow-hidden shadow-sm transition-all duration-200 ' +
          (blocked ? 'opacity-40 cursor-not-allowed' : 'hover:border-[color:var(--notation-accent-40)] hover:shadow-xl hover:shadow-black/5 dark:hover:shadow-black/40 hover:-translate-y-0.5')
        }
      >
        <div
          className="h-20 flex items-center justify-center relative"
          style={{ background: `linear-gradient(135deg, hsl(${hue}, 64%, 52%) 0%, hsl(${hue2}, 70%, 40%) 100%)` }}
        >
          <span className="text-3xl font-bold text-white drop-shadow-md select-none relative z-10">{initial}</span>
          <div className="absolute inset-0 bg-gradient-to-b from-white/15 via-transparent to-black/30 pointer-events-none" />
          {space.encrypted && (
            <span
              className="absolute bottom-1.5 right-1.5 z-10 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-black/40 backdrop-blur-sm text-white text-[10px] font-semibold"
              title="Zero-knowledge encrypted space"
            >
              <Lock size={10} /> Encrypted
            </span>
          )}
        </div>
        <div className="p-4">
          <div className="font-semibold text-[var(--notation-fg)] truncate">{space.name || space.id}</div>
          <div className="text-xs text-[var(--notation-fg-muted)] mt-0.5 font-mono truncate">/{space.id}</div>
          <div className="text-[11px] text-[var(--notation-fg-muted)] mt-3 flex items-center gap-2">
            {busy ? (
              <span className="inline-flex items-center gap-1 text-[color:var(--notation-accent)]">
                <Loader2 size={12} className="animate-spin" />
                {op === 'voice' ? 'Vertonen' : 'Syncing'} {progress!.total ? `${progress!.done}/${progress!.total}` : '…'}
              </span>
            ) : oerr ? (
              <span className="text-[var(--notation-danger)] truncate" title={oerr}>Offline sync failed</span>
            ) : voiceMsg ? (
              <span className="inline-flex items-center gap-1 text-[color:var(--notation-accent)] truncate"
                title={voiceFailed.length ? 'Fehlgeschlagen:\n' + voiceFailed.join('\n') : voiceMsg}>
                <Headphones size={12} className="flex-shrink-0" /> <span className="truncate">{voiceMsg}</span>
              </span>
            ) : synced ? (
              <span className="inline-flex items-center gap-1 text-[color:var(--notation-accent)]">
                <Cloud size={12} fill="currentColor" /> Offline{info ? ` · ${formatDate(new Date(info.syncedAt).toISOString())}` : ''}
                {info && info.failed > 0 && (
                  <span className="text-[var(--notation-danger)]"
                    title={info.failedPaths?.length ? 'Nicht gecacht:\n' + info.failedPaths.join('\n') + (info.failed > info.failedPaths.length ? `\n… (+${info.failed - info.failedPaths.length})` : '') : undefined}>
                    {' · '}{info.failed} failed</span>
                )}
              </span>
            ) : space.created_at ? (
              <span>Created {formatDate(space.created_at)}</span>
            ) : null}
          </div>
        </div>
      </Link>

      {/* Offline control (top-left) */}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (busy) return; if (synced) setMenuOpen(o => !o); else void doSync() }}
        disabled={busy}
        className={
          'absolute top-2 left-2 p-1.5 rounded-md backdrop-blur-sm transition-opacity ' +
          (synced || busy ? 'bg-black/30 text-white opacity-100' : 'bg-black/30 text-white/80 opacity-0 group-hover:opacity-100 hover:text-white')
        }
        title={synced ? 'Offline — manage' : 'Make available offline'}
        aria-label={synced ? `Manage offline copy of ${space.id}` : `Make ${space.id} available offline`}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : synced ? <Cloud size={13} fill="currentColor" /> : <CloudDownload size={13} />}
      </button>
      {menuOpen && synced && !busy && (
        <div className="absolute top-10 left-2 z-10 w-40 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] shadow-xl py-1 text-sm" onClick={e => e.preventDefault()}>
          <button onClick={(e) => { e.stopPropagation(); void doSync() }} className="w-full text-left px-3 py-1.5 hover:bg-[var(--notation-bg-alt)] flex items-center gap-2"><RefreshCw size={13} /> Update now</button>
          {voices.length > 0 && online && (
            <button onClick={(e) => { e.stopPropagation(); void doVoice() }} title="Bereits vertonte Audios offline mitnehmen" className="w-full text-left px-3 py-1.5 hover:bg-[var(--notation-bg-alt)] flex items-center gap-2"><Headphones size={13} /> Audio einbeziehen</button>
          )}
          <button onClick={(e) => { e.stopPropagation(); void removeOffline() }} className="w-full text-left px-3 py-1.5 hover:bg-[var(--notation-bg-alt)] text-[var(--notation-danger)] flex items-center gap-2"><CloudOff size={13} /> Remove offline</button>
        </div>
      )}

      {!online ? null : (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete() }}
          className="absolute top-2 right-2 p-1.5 rounded-md bg-black/30 backdrop-blur-sm text-white/80 hover:bg-[var(--notation-danger)]/90 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
          title="Delete space"
          aria-label={`Delete ${space.id}`}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}

// ---- Helpers ----------------------------------------------------------

// Deterministic per-id hue. Cheap string hash mod 360.
export function hueFromString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return ((h % 360) + 360) % 360
}

export function formatDate(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diffDays = Math.round((Date.now() - t) / (1000 * 60 * 60 * 24))
  if (diffDays < 1) return 'today'
  if (diffDays < 2) return 'yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
