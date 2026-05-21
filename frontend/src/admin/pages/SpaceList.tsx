import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Search, Moon, Sun, Trash2, FolderOpen, Sparkles, LogOut, X } from 'lucide-react'
import * as api from '../lib/api'
import { logout } from '../lib/auth'

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

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('notation_theme') as 'light' | 'dark') || 'dark'
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('notation_theme', theme)
  }, [theme])

  function refresh() {
    api.listSpaces().then(setSpaces).catch(e => setErr(String(e)))
  }

  useEffect(() => {
    refresh()
    api.me().then(setMe).catch(() => {})
  }, [])

  async function onDelete(id: string) {
    if (!window.confirm(`Delete space "${id}" and all its files? This cannot be undone.`)) return
    try {
      await api.deleteSpace(id)
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
    <div className="min-h-screen bg-gradient-to-br from-zinc-50 to-white dark:from-[#0a0a0a] dark:to-[#0d0d0d] text-zinc-900 dark:text-zinc-200 selection:bg-[#BFF355]/30">
      <header className="sticky top-0 z-30 border-b border-zinc-200 dark:border-zinc-800/50 bg-white/70 dark:bg-zinc-950/70 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link to="/admin" className="flex items-center gap-2 group">
            <div className="w-7 h-7 rounded-md bg-zinc-900 dark:bg-[#BFF355] flex items-center justify-center transition-transform group-hover:scale-105">
              <FolderOpen size={14} className="text-white dark:text-zinc-900" strokeWidth={2.5} />
            </div>
            <span className="font-bold text-base tracking-tight">notation</span>
          </Link>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors"
              title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            {me && (
              <div className="flex items-center gap-2 pl-3 ml-1 border-l border-zinc-200 dark:border-zinc-800">
                <span className="text-sm text-zinc-600 dark:text-zinc-400 hidden sm:inline">
                  {me.name}
                </span>
                <button
                  onClick={async () => {
                    try { await logout() } catch {/* best-effort */}
                    window.location.href = '/'
                  }}
                  className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors"
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
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            Your Spaces
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400 mt-2">
            Self-hosted workspaces for notes, files, and AI sessions.
          </p>
        </div>

        <div className="flex items-center gap-3 mb-6">
          <div className="relative flex-1 max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search spaces…"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-[#BFF355]/30 focus:border-zinc-300 dark:focus:border-zinc-700 transition-colors"
            />
          </div>
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-md bg-zinc-900 text-white dark:bg-[#BFF355] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-[#a6d944] transition-colors whitespace-nowrap"
          >
            <Plus size={15} /> New Space
          </button>
        </div>

        {err && (
          <div className="mb-6 p-3 rounded-md bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 text-sm border border-red-100 dark:border-red-900/30 flex items-start justify-between gap-3">
            <span>{err}</span>
            <button onClick={() => setErr(null)} className="text-red-400 hover:text-red-600">
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
              <SpaceCard key={s.id} space={s} onDelete={() => onDelete(s.id)} />
            ))}
            <CreateCard onClick={() => setCreating(true)} />
          </div>
        )}
      </main>

      {creating && (
        <CreateModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}

// ---- Card --------------------------------------------------------------

function SpaceCard({ space, onDelete }: { space: api.Meta; onDelete: () => void }) {
  const hue = useMemo(() => hueFromString(space.id), [space.id])
  const hue2 = (hue + 40) % 360
  const initial = (space.name || space.id).charAt(0).toUpperCase()

  return (
    <div className="group relative">
      <Link
        to={`/admin/spaces/${encodeURIComponent(space.id)}`}
        className="block rounded-xl border border-zinc-200 dark:border-zinc-800/60 bg-white dark:bg-zinc-900/40 overflow-hidden hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow-lg dark:hover:shadow-black/20 hover:-translate-y-0.5 transition-all duration-200"
      >
        <div
          className="h-20 flex items-center justify-center relative"
          style={{
            background: `linear-gradient(135deg, hsl(${hue}, 70%, 55%) 0%, hsl(${hue2}, 70%, 45%) 100%)`,
          }}
        >
          <span className="text-3xl font-bold text-white drop-shadow-sm select-none">
            {initial}
          </span>
          {/* subtle vignette */}
          <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-black/10 pointer-events-none" />
        </div>
        <div className="p-4">
          <div className="font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            {space.name || space.id}
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-500 mt-0.5 font-mono truncate">
            /{space.id}
          </div>
          <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-3 flex items-center gap-1">
            {space.created_at && <span>Created {formatDate(space.created_at)}</span>}
          </div>
        </div>
      </Link>
      <button
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onDelete()
        }}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-black/30 backdrop-blur-sm text-white/80 hover:bg-red-500/90 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
        title="Delete space"
        aria-label={`Delete ${space.id}`}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

function CreateCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border-2 border-dashed border-zinc-300 dark:border-zinc-700/60 hover:border-zinc-900/40 dark:hover:border-[#BFF355]/40 hover:bg-zinc-50 dark:hover:bg-[#BFF355]/5 transition-colors flex flex-col items-center justify-center min-h-[12rem] text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-[#BFF355] group"
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
        <FolderOpen size={28} className="text-zinc-400 dark:text-zinc-600" strokeWidth={1.5} />
      </div>
      <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
        No spaces yet
      </h3>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6 max-w-sm mx-auto">
        Create your first workspace to start writing notes, sharing pages, and connecting an MCP client.
      </p>
      <button
        onClick={onCreate}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-md bg-zinc-900 text-white dark:bg-[#BFF355] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-[#a6d944] transition-colors"
      >
        <Sparkles size={14} /> Create your first Space
      </button>
    </div>
  )
}

function NoResults({ query }: { query: string }) {
  return (
    <div className="text-center py-16 text-zinc-500 dark:text-zinc-400 text-sm">
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl max-w-md w-full p-6 animate-in zoom-in-95 duration-150"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Create a new Space</h2>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 rounded -mr-1"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-5">
          A new workspace for notes, files, and AI sessions.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              ID
            </label>
            <input
              value={id}
              onChange={e => setId(e.target.value)}
              required
              pattern="[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]"
              autoFocus
              className="w-full px-3 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-[#BFF355]/30 focus:border-zinc-300 dark:focus:border-zinc-700 transition-colors"
              placeholder="my-project"
            />
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">
              Lowercase a–z, digits, _ or -. 3–32 characters.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Name <span className="text-zinc-400 font-normal">(optional)</span>
            </label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-[#BFF355]/30 focus:border-zinc-300 dark:focus:border-zinc-700 transition-colors"
              placeholder="My Project"
            />
          </div>
          {err && (
            <p className="text-red-500 text-sm">{err}</p>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-md text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !id}
              className="flex-1 px-4 py-2 rounded-md text-sm font-semibold bg-zinc-900 text-white dark:bg-[#BFF355] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-[#a6d944] disabled:opacity-40 transition-colors"
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
