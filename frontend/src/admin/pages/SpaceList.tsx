import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Search, Moon, Sun, FolderOpen, Sparkles, LogOut, X, Palette, CloudOff, SquareKanban, LayoutGrid } from 'lucide-react'
import * as api from '../lib/api'
import { logout } from '../lib/auth'
import * as offline from '../lib/offlineSync'
import { ThemePalette } from '../components/ThemePalette'
import { SpaceCard } from '../components/SpaceCard'
import { KanbanBoard } from '../components/KanbanBoard'

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
  // null = modal closed; otherwise the column a newly created space lands in.
  const [creating, setCreating] = useState<api.BoardColumn | null>(null)
  const [themeOpen, setThemeOpen] = useState(false)
  const [view, setView] = useState<'board' | 'grid'>(
    () => (localStorage.getItem('notation_spaces_view') as 'board' | 'grid') || 'board',
  )
  useEffect(() => { localStorage.setItem('notation_spaces_view', view) }, [view])

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

  // Mirror a persisted board move into the local cache so a view switch or later
  // refresh doesn't flash the old column/order before the next listSpaces.
  function onBoardPatch(moves: api.BoardMove[]) {
    setSpaces(prev => prev.map(s => {
      const mv = moves.find(m => m.id === s.id)
      return mv ? { ...s, status: mv.status, order: mv.order } : s
    }))
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
          <div className="inline-flex rounded-md border border-[var(--notation-border)] overflow-hidden" role="group" aria-label="View">
            {([['board', SquareKanban, 'Board'], ['grid', LayoutGrid, 'Grid']] as const).map(([v, Icon, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                aria-pressed={view === v}
                title={`${label} view`}
                className={
                  'p-2 transition-colors ' +
                  (view === v
                    ? 'bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)]'
                    : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]')
                }
              >
                <Icon size={16} />
              </button>
            ))}
          </div>
          <button
            onClick={() => setCreating('inbox')}
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
          <EmptyState onCreate={() => setCreating('inbox')} />
        ) : filtered.length === 0 ? (
          <NoResults query={query} />
        ) : view === 'board' ? (
          <KanbanBoard
            spaces={filtered}
            online={online}
            voices={ttsVoices}
            onDelete={onDelete}
            onQuickCreate={col => setCreating(col)}
            onBoardPatch={onBoardPatch}
            onError={setErr}
            onRefresh={refresh}
            dragEnabled={query.trim() === ''}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(s => (
              <SpaceCard key={s.id} space={s} onDelete={() => onDelete(s.id)} online={online} voices={ttsVoices} />
            ))}
            <CreateCard onClick={() => setCreating('inbox')} />
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
          initialStatus={creating}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null)
            refresh()
          }}
        />
      )}

      {themeOpen && <ThemePalette onClose={() => setThemeOpen(false)} />}
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

function CreateModal({ initialStatus, onClose, onCreated }: { initialStatus: api.BoardColumn; onClose: () => void; onCreated: () => void }) {
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
      const created = await api.createSpace(id, name || undefined)
      // New spaces default to Inbox server-side (empty status). When created from
      // another column's "+", drop it at the top there (order 0 sorts above any
      // manually-ranked card). A failure here is non-fatal — the space exists and
      // simply stays in Inbox.
      if (initialStatus !== 'inbox') {
        try { await api.updateBoard([{ id: created.id, status: initialStatus, order: 0 }]) } catch { /* keep in inbox */ }
      }
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-space-title"
      >
        <div className="flex items-start justify-between mb-1">
          <h2 id="create-space-title" className="text-xl font-bold text-[var(--notation-fg)]">Create a new Space</h2>
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
            <p className="text-[var(--notation-danger)] text-sm" aria-live="polite">{err}</p>
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
