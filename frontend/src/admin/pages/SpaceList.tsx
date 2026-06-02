import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Search, Moon, Sun, Trash2, FolderOpen, Sparkles, LogOut, X, Palette, CloudDownload, Cloud, CloudOff, RefreshCw, Loader2, Headphones } from 'lucide-react'
import * as api from '../lib/api'
import { logout } from '../lib/auth'
import * as offline from '../lib/offlineSync'
import { defaultVoice, markdownPagesUnder, vertonenPages, type Cancel } from '../lib/vertonen'
import { ThemePalette } from '../components/ThemePalette'

/**
 * SpaceList — the workspace switcher / landing page.
 *
 * Layout:
 *   - sticky branded header with theme toggle + signed-in chip
 *   - title section ("Your Spaces")
 *   - search + "New Space" CTA
 *   - responsive card grid (1/2/3 cols) with a deterministic gradient avatar
 *     per space, plus a dashed "+ New" card at the end of the grid
 *   - empty / no-results state
 *   - modal form for creating new spaces
 *
 * Each card's gradient is derived from a stable string hash of the space id,
 * so the same space always shows up in the same colour — useful for the
 * "muscle memory" of finding a workspace quickly.
 */
export function SpaceList() {
  const [spaces, setSpaces] = useState<api.Meta[]>([])
  const [me, setMe] = useState<{ name: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)

  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('notation_theme') as 'light' | 'dark') || 'dark'
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('notation_theme', theme)
  }, [theme])

  // Studio voices (fetched once, shared by all cards) gate the offline "include
  // voice" action and tell it which voice to pull.
  const [ttsVoices, setTtsVoices] = useState<api.ServerVoice[]>([])

  function refresh() {
    api.listSpaces().then(setSpaces).catch(e => setErr(String(e)))
  }

  useEffect(() => {
    refresh()
    api.me().then(setMe).catch(() => {})
    api.ttsInfo().then(r => setTtsVoices(r.available ? r.voices : [])).catch(() => {})
  }, [])

  async function onDelete(id: string) {
    if (!window.confirm(`Delete space "${id}" and all its files? This cannot be undone.`)) return
    try {
      await api.deleteSpace(id)
      await offline.unsyncSpace(id) // drop any offline copy too
      refresh()
    } catch (e) {
      setErr(String(e))
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return spaces
    return spaces.filter(s =>
      s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q),
    )
  }, [spaces, query])

  return (
    <div className="relative isolate min-h-screen bg-[var(--notation-bg)] text-[var(--notation-fg)] selection:bg-[color:var(--notation-accent-30)]">
      {/* Soft brand glow behind the header — adds depth to the otherwise-flat
          dark canvas; barely-there in light. -z-10 keeps it under the content
          (the root's `isolate` scopes the stacking context). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[460px] opacity-50 dark:opacity-100"
        style={{ background: 'radial-gradient(75% 100% at 50% 0%, var(--notation-accent-10), transparent 72%)' }}
      />
      <header className="sticky top-0 z-30 border-b border-[var(--notation-border)] bg-[var(--notation-bg-elevated)]/70 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link to="/admin" className="flex items-center gap-2 group">
            <div className="w-7 h-7 rounded-md bg-[var(--notation-bg-alt)] dark:bg-[color:var(--notation-accent)] flex items-center justify-center transition-transform group-hover:scale-105">
              <FolderOpen size={14} className="text-[var(--notation-fg)] dark:text-[var(--notation-fg-on-accent)]" strokeWidth={2.5} />
            </div>
            <span className="font-bold text-base tracking-tight">notation</span>
          </Link>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setThemeOpen(true)}
              className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] transition-colors"
              title="Accent colour"
            >
              <Palette size={16} />
            </button>
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] transition-colors"
              title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            {me && (
              <div className="flex items-center gap-2 pl-3 ml-1 border-l border-[var(--notation-border)]">
                <span className="text-sm text-[var(--notation-fg-muted)] hidden sm:inline">
                  {me.name}
                </span>
                <button
                  onClick={async () => {
                    try { await logout() } catch {/* best-effort */}
                    window.location.href = '/'
                  }}
                  className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] transition-colors"
                  title="Sign out"
                >
                  <LogOut size={15} />
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-12">
        <div className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight text-[var(--notation-fg)]">
            Your Spaces
          </h1>
          <p className="text-[var(--notation-fg-muted)] mt-2">
            Self-hosted workspaces for notes, files, and AI sessions.
          </p>
        </div>

        <div className="flex items-center gap-3 mb-6">
          <div className="relative flex-1 max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--notation-fg-muted)]" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search spaces…"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg-alt)] focus:outline-none focus:ring-2 focus:ring-[color:var(--notation-accent-30)] focus:border-[color:var(--notation-accent-40)] transition-colors"
            />
          </div>
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-md bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:opacity-90 transition-colors whitespace-nowrap"
          >
            <Plus size={15} /> New Space
          </button>
        </div>

        {!online && (
          <div className="mb-6 p-3 rounded-md bg-[color:var(--notation-accent-10)] border border-[color:var(--notation-accent-40)] text-sm text-[var(--notation-fg)] flex items-center gap-2">
            <CloudOff size={16} className="text-[color:var(--notation-accent)] flex-shrink-0" />
            <span>You’re offline — only spaces marked for offline can be opened.</span>
          </div>
        )}

        {err && (
          <div className="mb-6 p-3 rounded-md bg-[var(--notation-danger)]/10 dark:bg-[var(--notation-danger)]/30 text-[var(--notation-danger)] dark:text-[var(--notation-danger)] text-sm border border-[var(--notation-danger)] dark:border-[var(--notation-danger)]/30 flex items-start justify-between gap-3">
            <span>{err}</span>
            <button onClick={() => setErr(null)} className="text-[var(--notation-danger)] hover:text-[var(--notation-danger)]">
              <X size={14} />
            </button>
          </div>
        )}

        {spaces.length === 0 ? (
          <EmptyState onCreate={() => setCreating(true)} />
        ) : filtered.length === 0 ? (
          <NoResults query={query} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(s => (
              <SpaceCard key={s.id} space={s} onDelete={() => onDelete(s.id)} online={online} voices={ttsVoices} />
            ))}
            <CreateCard onClick={() => setCreating(true)} />
          </div>
        )}
      </main>

      <footer className="max-w-6xl mx-auto px-6 py-8 mt-4 text-center text-xs text-[var(--notation-fg-muted)] border-t border-[var(--notation-border)]">
        <a
          href="https://github.com/atomfritte/notation"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 hover:text-[var(--notation-fg)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          atomfritte/notation
        </a>
        <span className="mx-2 opacity-50">·</span>
        <span>self-hosted notation</span>
      </footer>

      {creating && (
        <CreateModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            refresh()
          }}
        />
      )}

      {themeOpen && <ThemePalette onClose={() => setThemeOpen(false)} />}
    </div>
  )
}

// ---- Card --------------------------------------------------------------

function SpaceCard({ space, onDelete, online, voices }: { space: api.Meta; onDelete: () => void; online: boolean; voices: api.ServerVoice[] }) {
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
        className={
          'block rounded-xl border border-[var(--notation-border)] bg-[var(--notation-bg-alt)] overflow-hidden shadow-sm transition-all duration-200 ' +
          (blocked ? 'opacity-40 cursor-not-allowed' : 'hover:border-[color:var(--notation-accent-40)] hover:shadow-xl hover:shadow-black/5 dark:hover:shadow-black/40 hover:-translate-y-0.5')
        }
      >
        <div
          className="h-20 flex items-center justify-center relative"
          style={{ background: `linear-gradient(135deg, hsl(${hue}, 64%, 52%) 0%, hsl(${hue2}, 70%, 40%) 100%)` }}
        >
          <span className="text-3xl font-bold text-white drop-shadow-md select-none relative z-10">{initial}</span>
          <div className="absolute inset-0 bg-gradient-to-b from-white/15 via-transparent to-black/30 pointer-events-none" />
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

function CreateCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border-2 border-dashed border-[var(--notation-border)] hover:border-[color:var(--notation-accent-40)] hover:bg-[color:var(--notation-accent-10)] transition-colors flex flex-col items-center justify-center min-h-[12rem] text-[var(--notation-fg-muted)] hover:text-[color:var(--notation-accent)] group"
    >
      <div className="w-10 h-10 rounded-full border-2 border-current flex items-center justify-center mb-2 group-hover:scale-105 transition-transform">
        <Plus size={20} strokeWidth={2} />
      </div>
      <span className="text-sm font-medium">New Space</span>
    </button>
  )
}

// ---- Empty / no-results -----------------------------------------------

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="text-center py-20 px-4">
      <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-gradient-to-br from-zinc-100 to-zinc-200 dark:from-zinc-800/40 dark:to-zinc-900 flex items-center justify-center">
        <FolderOpen size={28} className="text-[var(--notation-fg-muted)] text-[var(--notation-fg-muted)]" strokeWidth={1.5} />
      </div>
      <h3 className="text-lg font-semibold text-[var(--notation-fg)] mb-2">
        No spaces yet
      </h3>
      <p className="text-sm text-[var(--notation-fg-muted)] mb-6 max-w-sm mx-auto">
        Create your first workspace to start writing notes, sharing pages, and connecting an MCP client.
      </p>
      <button
        onClick={onCreate}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-md bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:opacity-90 transition-colors"
      >
        <Sparkles size={14} /> Create your first Space
      </button>
    </div>
  )
}

function NoResults({ query }: { query: string }) {
  return (
    <div className="text-center py-16 text-[var(--notation-fg-muted)] text-sm">
      No spaces match &ldquo;{query}&rdquo;.
    </div>
  )
}

// ---- Create modal -----------------------------------------------------

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setSubmitting(true)
    try {
      await api.createSpace(id, name || undefined)
      onCreated()
    } catch (e) {
      setErr(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--notation-backdrop)] backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] rounded-xl shadow-2xl max-w-md w-full p-6 animate-in zoom-in-95 duration-150"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-xl font-bold text-[var(--notation-fg)]">Create a new Space</h2>
          <button
            onClick={onClose}
            className="p-1 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] rounded -mr-1"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-[var(--notation-fg-muted)] mb-5">
          A new workspace for notes, files, and AI sessions.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--notation-fg)] mb-1">
              ID
            </label>
            <input
              value={id}
              onChange={e => setId(e.target.value)}
              required
              pattern="[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]"
              autoFocus
              className="w-full px-3 py-2 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-[color:var(--notation-accent-30)] focus:border-[var(--notation-border)] dark:focus:border-[var(--notation-border)] transition-colors"
              placeholder="my-project"
            />
            <p className="text-[11px] text-[var(--notation-fg-muted)] mt-1">
              Lowercase a–z, digits, _ or -. 3–32 characters.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--notation-fg)] mb-1">
              Name <span className="text-[var(--notation-fg-muted)] font-normal">(optional)</span>
            </label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-[color:var(--notation-accent-30)] focus:border-[var(--notation-border)] dark:focus:border-[var(--notation-border)] transition-colors"
              placeholder="My Project"
            />
          </div>
          {err && (
            <p className="text-[var(--notation-danger)] text-sm">{err}</p>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-md text-sm font-medium text-[var(--notation-fg)] hover:bg-[var(--notation-border)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !id}
              className="flex-1 px-4 py-2 rounded-md text-sm font-semibold bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:opacity-90 disabled:opacity-40 transition-colors"
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---- Helpers ----------------------------------------------------------

// Deterministic per-id hue. Cheap string hash mod 360.
function hueFromString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return ((h % 360) + 360) % 360
}

function formatDate(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diffDays = Math.round((Date.now() - t) / (1000 * 60 * 60 * 24))
  if (diffDays < 1) return 'today'
  if (diffDays < 2) return 'yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
