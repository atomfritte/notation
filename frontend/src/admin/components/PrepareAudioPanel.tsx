import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Headphones, Loader2, Check, FolderTree } from 'lucide-react'
import * as api from '../lib/api'
import { folderList, markdownPagesUnder, vertonenPages, defaultVoice, type VertonenProgress, type VertonenResult, type Cancel } from '../lib/vertonen'

type Props = {
  open: boolean
  spaceID: string
  tree: api.Entry[]
  voices: api.ServerVoice[]
  onClose: () => void
}

/**
 * PrepareAudioPanel pre-synthesises ("vertont") a folder's pages — recursing into
 * all subfolders — and caches the audio so the space can be *heard* offline after
 * a re-sync. It reproduces the read-aloud player's exact chunks (see vertonen.ts /
 * markdownChunks.tsx) so the cached clips are the ones the player later requests.
 */
export function PrepareAudioPanel({ open, spaceID, tree, voices, onClose }: Props) {
  const folders = useMemo(() => folderList(tree), [tree])
  const [folder, setFolder] = useState('') // '' = whole space
  const [voiceId, setVoiceId] = useState(() => defaultVoice(voices))
  const pages = useMemo(() => markdownPagesUnder(tree, folder), [tree, folder])
  const [progress, setProgress] = useState<VertonenProgress | null>(null)
  const [result, setResult] = useState<VertonenResult | null>(null)
  const [running, setRunning] = useState(false)
  const cancelRef = useRef<Cancel>({ cancelled: false })

  // If the panel unmounts mid-run (e.g. navigating away from the Space), abort the
  // batch so it doesn't keep hammering /tts in the background uncancellably.
  useEffect(() => () => { cancelRef.current.cancelled = true }, [])

  if (!open) return null

  const start = async () => {
    if (!pages.length || !voiceId) return
    // Make the player default to the same voice we pre-generate, so the cached
    // clips are the ones it later requests (the cache key includes the voice).
    try { localStorage.setItem('notation_readaloud_voice', voiceId) } catch { /* quota */ }
    setResult(null)
    setRunning(true)
    cancelRef.current = { cancelled: false }
    try {
      const r = await vertonenPages(spaceID, pages, voiceId, setProgress, cancelRef.current)
      setResult(r)
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--notation-backdrop)] backdrop-blur-sm animate-in fade-in duration-100 p-4"
      onClick={() => { if (!running) onClose() }}
    >
      <div
        className="w-full max-w-lg surface-gradient bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 duration-150 flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--notation-border)]">
          <div>
            <h2 className="text-lg font-semibold text-[var(--notation-fg)] flex items-center gap-2">
              <Headphones size={18} /> Audio vorbereiten
            </h2>
            <p className="text-xs text-[var(--notation-fg-muted)] mt-0.5">
              Vertont alle Seiten im gewählten Ordner (inkl. Unterordner) und legt sie im Cache ab.
              Danach den Space erneut offline synchronisieren, um sie im Flugmodus zu hören.
            </p>
          </div>
          <button
            onClick={() => { if (!running) onClose() }}
            disabled={running}
            className="text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] p-1 rounded-md disabled:opacity-40"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {voices.length === 0 ? (
            <p className="text-sm text-[var(--notation-fg-muted)]">
              Keine Studio-Stimme verfügbar — der Server hat kein TTS konfiguriert.
            </p>
          ) : (
            <>
              <label className="block">
                <span className="text-xs font-medium text-[var(--notation-fg-muted)]">Ordner</span>
                <div className="mt-1 flex items-center gap-2">
                  <FolderTree size={14} className="text-[var(--notation-fg-muted)] flex-shrink-0" />
                  <select
                    value={folder}
                    onChange={e => setFolder(e.target.value)}
                    disabled={running}
                    className="w-full bg-[var(--notation-bg)] border border-[var(--notation-border)] rounded-md px-2 py-1.5 text-sm text-[var(--notation-fg)] disabled:opacity-50"
                  >
                    <option value="">Ganzer Space</option>
                    {folders.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
              </label>

              <label className="block">
                <span className="text-xs font-medium text-[var(--notation-fg-muted)]">Stimme</span>
                <select
                  value={voiceId}
                  onChange={e => setVoiceId(e.target.value)}
                  disabled={running}
                  className="mt-1 w-full bg-[var(--notation-bg)] border border-[var(--notation-border)] rounded-md px-2 py-1.5 text-sm text-[var(--notation-fg)] disabled:opacity-50"
                >
                  {voices.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                </select>
              </label>

              <p className="text-sm text-[var(--notation-fg)]">
                <span className="font-semibold">{pages.length}</span>{' '}
                {pages.length === 1 ? 'Seite' : 'Seiten'} werden vertont.
                {pages.length === 0 && <span className="text-[var(--notation-fg-muted)]"> (keine Markdown-Seiten hier)</span>}
              </p>
              <p className="text-xs text-[var(--notation-fg-muted)]">
                Im Player dieselbe Stimme („{voices.find(v => v.id === voiceId)?.label ?? voiceId}") wählen, um die Audios offline zu hören.
              </p>

              {running && progress && (
                <div className="space-y-1.5">
                  <div className="h-2 rounded-full bg-[var(--notation-bg)] overflow-hidden border border-[var(--notation-border)]">
                    <div className="h-full bg-[var(--notation-accent)] transition-all duration-200" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-xs text-[var(--notation-fg-muted)]">
                    <span className="truncate pr-2">{progress.current || '…'}</span>
                    <span className="flex-shrink-0">{progress.done}/{progress.total} · {progress.clips} Clips</span>
                  </div>
                </div>
              )}

              {result && (
                <div className="flex items-start gap-2 text-sm rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)] p-3">
                  <Check size={16} className="text-[var(--notation-accent)] mt-0.5 flex-shrink-0" />
                  <div className="text-[var(--notation-fg)]">
                    {result.cancelled ? 'Abgebrochen — ' : 'Fertig — '}
                    {result.clips} Clips aus {result.pages} {result.pages === 1 ? 'Seite' : 'Seiten'} gecacht
                    {result.emptyPages > 0 && <span className="text-[var(--notation-fg-muted)]">, {result.emptyPages} ohne Text</span>}
                    {result.pageFailed > 0 && <span className="text-[var(--notation-danger)]">, {result.pageFailed} Seiten fehlgeschlagen</span>}
                    {result.clipFailed > 0 && <span className="text-[var(--notation-danger)]">, {result.clipFailed} Clips fehlgeschlagen</span>}.
                    {(result.failedPages.length > 0 || result.failedClips.length > 0) && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-[var(--notation-danger)]">Fehlgeschlagene Seiten anzeigen</summary>
                        <ul className="mt-1 max-h-32 overflow-y-auto space-y-0.5 font-mono text-[11px] text-[var(--notation-fg-muted)]">
                          {result.failedPages.map(p => <li key={'p' + p} title="Seite konnte nicht geladen/gerendert werden">⚠ {p}</li>)}
                          {result.failedClips.map(p => <li key={'c' + p} title="Audio-Clip(s) fehlgeschlagen">♪ {p}</li>)}
                        </ul>
                      </details>
                    )}
                    <div className="text-xs text-[var(--notation-fg-muted)] mt-1">
                      Jetzt im Space-Manager den Space (erneut) offline synchronisieren — die Audios sind dann im Flugmodus verfügbar.
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--notation-border)]">
          {running ? (
            <button
              onClick={() => { cancelRef.current.cancelled = true }}
              className="px-3 py-1.5 text-sm rounded-md border border-[var(--notation-border)] text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50"
            >
              Stoppen
            </button>
          ) : (
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-md border border-[var(--notation-border)] text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50"
            >
              Schließen
            </button>
          )}
          <button
            onClick={start}
            disabled={running || !pages.length || !voiceId}
            className="px-3 py-1.5 text-sm rounded-md bg-[var(--notation-accent)] text-white font-medium hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Headphones size={14} />}
            {running ? 'Vertont…' : 'Vertonen'}
          </button>
        </div>
      </div>
    </div>
  )
}
