import { useCallback, useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Route, Routes, useSearchParams } from 'react-router-dom'
import {
  PanelLeft, List, MessageSquare, Search, Printer, Sun, Moon, Palette,
  Bookmark, FileText, Folder, HelpCircle,
} from 'lucide-react'
import * as api from './lib/api'
import { FileTree } from '../admin/components/FileTree'
import { FileViewer } from '../admin/components/FileViewer'
import { MarkdownView } from '../admin/components/MarkdownView'
import { CommentThread } from '../admin/components/CommentThread'
import { Outline } from '../admin/components/Outline'
import { CommandPalette } from '../admin/components/CommandPalette'
import { SearchPanel } from '../admin/components/SearchPanel'
import { ThemePalette } from '../admin/components/ThemePalette'
import { HelpPanel } from '../admin/components/HelpPanel'
import { initTheme } from '../admin/lib/theme'
import { isTextFile, isMarkdownFile, findDefaultFile } from '../admin/lib/fileTypes'

function ShareUI() {
  const [info, setInfo] = useState<api.SpaceInfo | null>(null)
  const [tree, setTree] = useState<api.Entry[]>([])
  const [content, setContent] = useState<string>('')
  const [editBuffer, setEditBuffer] = useState<string>('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [comments, setComments] = useState<api.Comment[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const file = searchParams.get('file') ?? ''

  // Until the /space response lands we don't know which features are
  // enabled — show the bare minimum (file tree + viewer) and reveal the
  // rich affordances as soon as we know.
  const features = info?.features

  // Theme: we still seed from prefers-color-scheme but only allow the user
  // to override it when features.theme is on. initTheme() repaints the
  // ThemePalette-managed accent / surface vars on every load.
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  useEffect(() => { initTheme() }, [])

  // Mobile drawer
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(max-width: 767px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : !window.matchMedia('(max-width: 767px)').matches,
  )

  // Right-side panel toggles, modals, etc.
  const [showOutline, setShowOutline] = useState(false)
  const [showComments, setShowComments] = useState(true)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'files' | 'bookmarks'>('files')

  // Comment coordination — viewer ↔ thread
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)
  const [pendingAnchor, setPendingAnchor] = useState<api.CommentAnchor | null>(null)
  const [pendingComment, setPendingComment] = useState<string>('')

  // Bookmarks (per-share-token) — kept client-only, never round-trips.
  const tokenKey = api.TOKEN
  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(`notation_share_bookmarks_${tokenKey}`)
      return raw ? JSON.parse(raw) : []
    } catch { return [] }
  })
  const toggleBookmark = useCallback((path: string) => {
    setBookmarks(prev => {
      const next = prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
      localStorage.setItem(`notation_share_bookmarks_${tokenKey}`, JSON.stringify(next))
      return next
    })
  }, [tokenKey])
  const isBookmarked = file && bookmarks.includes(file)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  useEffect(() => {
    api.getSpace().then(setInfo).catch(e => setErr(String(e)))
    api.getTree().then(setTree).catch(e => setErr(String(e)))
  }, [])

  // Auto-pick a default file (readme/index/home/first-md) when the share
  // URL doesn't specify one. Same algorithm as the admin SpaceView so
  // guests land on something instead of an empty viewer.
  useEffect(() => {
    if (file) return
    if (!tree || tree.length === 0) return
    const landing = findDefaultFile(tree)
    if (landing) setSearchParams({ file: landing.path }, { replace: true })
  }, [file, tree, setSearchParams])

  const refreshComments = useCallback(() => {
    if (!file) { setComments([]); return }
    api.listComments(file).then(setComments).catch(() => setComments([]))
  }, [file])

  useEffect(() => {
    if (!file) {
      setContent('')
      setEditBuffer('')
      setEditing(false)
      return
    }
    if (isTextFile(file)) {
      api.readFile(file).then(c => {
        setContent(c)
        setEditBuffer(c)
      }).catch(e => setErr(String(e)))
    } else {
      setContent('')
      setEditBuffer('')
    }
    refreshComments()
  }, [file, refreshComments])

  useEffect(() => {
    if (!activeCommentId) return
    const t = window.setTimeout(() => {
      const panel = document.getElementById('share-comments-panel')
      if (!panel) return
      const el = panel.querySelector(`[data-comment-id="${CSS.escape(activeCommentId)}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
    return () => window.clearTimeout(t)
  }, [activeCommentId])

  const select = useCallback((p: string) => {
    setSearchParams({ file: p })
    if (isMobile) setSidebarOpen(false)
  }, [setSearchParams, isMobile])

  // Build a flat file list for the command palette. Walks the tree once
  // per render of `tree` and filters to markdown / text leaf nodes.
  const allFiles = useMemo(() => {
    const out: string[] = []
    function walk(es: api.Entry[]) {
      for (const e of es) {
        if (e.is_dir && e.children) walk(e.children)
        else if (!e.is_dir) out.push(e.path)
      }
    }
    walk(tree)
    return out
  }, [tree])

  // Global keyboard shortcuts — only register the gated ones when the
  // matching feature is on, otherwise the shortcut is dead (intentional).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === '\\') {
        e.preventDefault()
        setSidebarOpen(v => !v)
        return
      }
      if (features?.palette && mod && e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault()
        setPaletteOpen(true)
      }
      if (features?.search && mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
      // `?` opens the shortcut help. Bare key — only trigger when no input
      // element has focus so it doesn't swallow real `?` keystrokes inside
      // the textarea editor or the search box.
      if (!mod && !e.altKey && e.key === '?' && !isTypingTarget(e.target)) {
        e.preventDefault()
        setHelpOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [features?.palette, features?.search])

  async function save() {
    if (!file) return
    setSaving(true)
    setErr(null)
    try {
      await api.writeFile(file, editBuffer)
      setContent(editBuffer)
      setEditing(false)
    } catch (e) {
      setErr(String(e))
    } finally {
      setSaving(false)
    }
  }

  async function addComment(text: string, opts?: { parentID?: string; anchor?: api.CommentAnchor }) {
    if (!file) return
    const anchor = opts?.anchor ?? (opts?.parentID ? undefined : pendingAnchor ?? undefined)
    await api.postComment(file, text, { parentID: opts?.parentID, anchor })
    setPendingAnchor(null)
    refreshComments()
  }
  function onNewAnchorComment(anchor: api.CommentAnchor) { setPendingAnchor(anchor) }

  if (err && !info) {
    return (
      <div className="p-8 max-w-xl mx-auto">
        <h1 className="text-xl font-bold mb-2 text-[var(--notation-fg)]">Share unavailable</h1>
        <p className="text-[var(--notation-danger)] dark:text-[var(--notation-danger)]">{err}</p>
      </div>
    )
  }
  if (!info) return <div className="p-8 text-[var(--notation-fg-muted)]">loading…</div>

  const canEdit = info.permission === 'edit'
  const canComment = info.permission === 'comment' || info.permission === 'edit'

  return (
    <div className="flex h-screen bg-[var(--notation-bg)] text-[var(--notation-fg)] overflow-hidden selection:bg-[color:var(--notation-accent-30)]">
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-[var(--notation-backdrop)] backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
        />
      )}
      <aside
        className={
          'surface-elevated flex flex-col bg-[var(--notation-bg-elevated)] border-r border-[var(--notation-border)] ' +
          'fixed inset-y-0 left-0 z-40 w-72 ' +
          'md:static md:z-auto md:w-64 md:flex-shrink-0 ' +
          'transition-transform md:transition-none duration-200 ease-in-out ' +
          (sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0')
        }
      >
        <div className="p-4 border-b border-[var(--notation-border)]">
          <div className="flex items-center gap-2 text-[var(--notation-fg)] font-medium">
            <div className="w-5 h-5 rounded bg-[var(--notation-bg-alt)] text-white dark:bg-[color:var(--notation-accent-20)] dark:text-[color:var(--notation-accent)] flex items-center justify-center font-bold text-xs uppercase">
              {info.space.id.charAt(0)}
            </div>
            <span className="truncate">{info.space.name}</span>
          </div>
          <p className="text-[11px] text-[var(--notation-fg-muted)] mt-2 flex items-center gap-1.5">
            <span
              className={
                'px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ' +
                (info.permission === 'edit'
                  ? 'bg-[color:var(--notation-accent-20)] text-[var(--notation-fg)] dark:text-[color:var(--notation-accent)]'
                  : info.permission === 'comment'
                  ? 'bg-[var(--notation-warning)]/40 text-[var(--notation-warning)] dark:bg-[var(--notation-warning)]/10 dark:text-[var(--notation-warning)]'
                  : 'bg-[var(--notation-bg-alt)] text-[var(--notation-fg)] bg-[var(--notation-bg-alt)] text-[var(--notation-fg-muted)]')
              }
            >
              {info.permission}
            </span>
            {info.label && <span className="truncate">{info.label}</span>}
          </p>
        </div>

        {/* Tab row only appears when bookmarks are on — otherwise the
            sidebar is files-only. */}
        {features?.bookmarks && (
          <div className="px-3 mt-3 flex gap-1">
            <button
              onClick={() => setSidebarTab('files')}
              className={
                'flex-1 px-2 py-1.5 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 transition-colors ' +
                (sidebarTab === 'files'
                  ? 'bg-[var(--notation-border)] text-[var(--notation-fg)]'
                  : 'text-[var(--notation-fg-muted)] hover:bg-[var(--notation-border)]')
              }
            >
              <Folder size={13} /> Pages
            </button>
            <button
              onClick={() => setSidebarTab('bookmarks')}
              className={
                'flex-1 px-2 py-1.5 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 transition-colors ' +
                (sidebarTab === 'bookmarks'
                  ? 'bg-[var(--notation-border)] text-[var(--notation-fg)]'
                  : 'text-[var(--notation-fg-muted)] hover:bg-[var(--notation-border)]')
              }
            >
              <Bookmark size={13} /> Bookmarks
              {bookmarks.length > 0 && (
                <span className="text-[9px] font-bold bg-[color:var(--notation-accent-15)] text-[color:var(--notation-accent)] px-1.5 py-0.5 rounded-full">
                  {bookmarks.length}
                </span>
              )}
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2">
          {sidebarTab === 'files' && (
            <FileTree
              entries={tree}
              current={file}
              onSelect={select}
              collapseStorageKey={`notation_share_tree_collapsed_${info.space.id}`}
            />
          )}
          {features?.bookmarks && sidebarTab === 'bookmarks' && (
            bookmarks.length === 0 ? (
              <p className="text-xs text-[var(--notation-fg-muted)] italic px-2 py-3">
                No bookmarks yet. Star a page from the header above the viewer.
              </p>
            ) : (
              <ul className="space-y-0.5 text-sm">
                {bookmarks.map(b => (
                  <li key={b}>
                    <button
                      onClick={() => select(b)}
                      className={
                        'w-full flex items-center gap-2 text-left py-1.5 px-2 rounded-md text-xs transition-colors ' +
                        (file === b
                          ? 'bg-[var(--notation-border)] text-[var(--notation-fg)] font-medium'
                          : 'text-[var(--notation-fg-muted)] hover:bg-[var(--notation-border)] hover:text-[var(--notation-fg)]')
                      }
                    >
                      <FileText size={12} className="opacity-70" />
                      <span className="truncate">{b.replace(/\.md$/i, '')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        {file ? (
          <>
            <header className="surface-elevated h-12 flex justify-between items-center px-4 border-b border-[var(--notation-border)] flex-shrink-0 text-sm gap-2 bg-[color:var(--notation-bg-elevated)]/90 backdrop-blur-sm">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button
                  onClick={() => setSidebarOpen(v => !v)}
                  className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-border)] flex-shrink-0"
                  aria-label="Toggle sidebar"
                >
                  <PanelLeft size={18} />
                </button>
                <span className="text-[var(--notation-fg-muted)] truncate">{file.replace(/\.md$/i, '')}</span>
              </div>

              <div className="flex items-center gap-1">
                {features?.search && (
                  <HeaderBtn title="Search (⌘⇧F)" onClick={() => setSearchOpen(true)}>
                    <Search size={16} />
                  </HeaderBtn>
                )}
                {features?.outline && isMarkdownFile(file) && (
                  <HeaderBtn
                    title="Outline"
                    active={showOutline}
                    onClick={() => setShowOutline(v => !v)}
                  >
                    <List size={16} />
                  </HeaderBtn>
                )}
                {canComment && (
                  <HeaderBtn
                    title="Comments"
                    active={showComments}
                    onClick={() => setShowComments(v => !v)}
                  >
                    <MessageSquare size={16} />
                    {comments.length > 0 && (
                      <span className="ml-1 text-[10px] font-bold">{comments.length}</span>
                    )}
                  </HeaderBtn>
                )}
                {features?.bookmarks && (
                  <HeaderBtn
                    title={isBookmarked ? 'Remove bookmark' : 'Bookmark this page'}
                    active={!!isBookmarked}
                    onClick={() => toggleBookmark(file)}
                  >
                    <Bookmark size={16} fill={isBookmarked ? 'currentColor' : 'none'} />
                  </HeaderBtn>
                )}
                {features?.print && isMarkdownFile(file) && !editing && (
                  <HeaderBtn title="Print this page" onClick={() => window.print()}>
                    <Printer size={16} />
                  </HeaderBtn>
                )}
                {features?.theme && (
                  <HeaderBtn title="Accent colour" onClick={() => setThemeOpen(true)}>
                    <Palette size={16} />
                  </HeaderBtn>
                )}
                {features?.theme && (
                  <HeaderBtn
                    title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
                    onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                  >
                    {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
                  </HeaderBtn>
                )}
                <HeaderBtn title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}>
                  <HelpCircle size={16} />
                </HeaderBtn>
                {canEdit && isTextFile(file) && (
                  <button
                    onClick={() => setEditing(v => !v)}
                    className={
                      'ml-1 px-3 py-1 rounded-md transition-colors text-sm font-medium ' +
                      (editing
                        ? 'bg-[var(--notation-border)] text-[var(--notation-fg)]'
                        : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-border)]')
                    }
                  >
                    {editing ? 'Preview' : 'Edit'}
                  </button>
                )}
              </div>
            </header>

            <div className="flex-1 flex min-h-0">
              <div className="flex-1 flex flex-col min-w-0">
                {editing ? (
                  <div className="flex-1 flex flex-col">
                    <div className="px-3 py-2 border-b border-[var(--notation-border)] flex gap-3 items-center text-sm">
                      <button
                        onClick={save}
                        disabled={saving || editBuffer === content}
                        className="px-3 py-1 bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] rounded-md disabled:opacity-40 font-medium"
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      {editBuffer !== content && (
                        <span className="text-[var(--notation-warning)] dark:text-[var(--notation-warning)] text-xs">unsaved changes</span>
                      )}
                    </div>
                    <textarea
                      value={editBuffer}
                      onChange={e => setEditBuffer(e.target.value)}
                      spellCheck={false}
                      className="flex-1 p-6 font-mono text-sm resize-none outline-none w-full bg-[var(--notation-bg)] text-[var(--notation-fg)]"
                    />
                  </div>
                ) : isMarkdownFile(file) ? (
                  <MarkdownView
                    content={content}
                    theme={theme}
                    comments={comments}
                    activeCommentID={activeCommentId}
                    onHoverMark={setActiveCommentId}
                    onSelectAnchor={setActiveCommentId}
                    onNewAnchorComment={canComment ? onNewAnchorComment : undefined}
                    files={allFiles}
                    currentFile={file}
                  />
                ) : (
                  <FileViewer
                    spaceID={info.space.id}
                    path={file}
                    content={content}
                    theme={theme}
                    urlFor={(p) => api.fileURLForShare(p)}
                  />
                )}
                {!editing && canComment && showComments && isMarkdownFile(file) && (
                  <div
                    id="share-comments-panel"
                    className="border-t border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] max-h-80 overflow-y-auto no-print"
                  >
                    {pendingAnchor && (
                      <div className="px-4 pt-3 text-xs">
                        <div className="text-[var(--notation-warning)] dark:text-[var(--notation-warning)] font-semibold mb-1">Anchoring to selection</div>
                        <div className="italic text-[var(--notation-fg-muted)] line-clamp-2">“{pendingAnchor.quote}”</div>
                        <button
                          onClick={() => { setPendingAnchor(null); setPendingComment('') }}
                          className="mt-1 text-[var(--notation-warning)] dark:text-[var(--notation-warning)] hover:underline"
                        >
                          drop anchor
                        </button>
                      </div>
                    )}
                    <CommentThread
                      comments={comments}
                      canAdd={canComment}
                      initialText={pendingComment}
                      activeID={activeCommentId}
                      onHoverComment={setActiveCommentId}
                      onAdd={canComment ? async (text, opts) => {
                        await addComment(text, opts)
                        setPendingComment('')
                      } : undefined}
                    />
                  </div>
                )}
                {err && info && (
                  <div className="p-2 text-[var(--notation-danger)] dark:text-[var(--notation-danger)] text-sm border-t border-[var(--notation-danger)] dark:border-[var(--notation-danger)]/50">{err}</div>
                )}
              </div>

              {features?.outline && showOutline && isMarkdownFile(file) && !editing && (
                <aside className="surface-elevated w-[240px] border-l border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] flex-shrink-0 overflow-y-auto no-print">
                  <Outline content={content} />
                </aside>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-[var(--notation-fg-muted)] gap-4 p-8 text-center">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden flex items-center gap-2 px-3 py-2 rounded-md bg-[var(--notation-bg-alt)] text-[var(--notation-fg)] text-sm"
            >
              <PanelLeft size={16} /> Open file list
            </button>
            <span>Select a file from the tree.</span>
          </div>
        )}
      </main>

      {/* Modals — each only mounted when its feature is on. */}
      {features?.palette && (
        <CommandPalette
          open={paletteOpen}
          files={allFiles}
          onClose={() => setPaletteOpen(false)}
          onSelect={(p) => select(p)}
        />
      )}
      {features?.search && (
        <SearchPanel
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          onSelect={(p) => select(p)}
          onSearch={(q) => api.searchSpace(q)}
        />
      )}
      {features?.theme && themeOpen && (
        <ThemePalette onClose={() => setThemeOpen(false)} />
      )}
      <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} scope="share" />
    </div>
  )
}

// Returns true when the keydown target is a text-entry element so bare-key
// shortcuts (like `?`) don't intercept real keystrokes inside the editor.
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (t.isContentEditable) return true
  return false
}

function HeaderBtn({
  children, title, onClick, active,
}: {
  children: React.ReactNode
  title: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={
        'p-1.5 rounded-md transition-colors flex items-center ' +
        (active
          ? 'bg-[var(--notation-border)] text-[color:var(--notation-accent)]'
          : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-border)]')
      }
    >
      {children}
    </button>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/s/:token" element={<ShareUI />} />
        <Route path="/s/:token/*" element={<ShareUI />} />
        <Route
          path="*"
          element={<div className="p-8 text-[var(--notation-danger)] dark:text-[var(--notation-danger)]">Invalid share URL.</div>}
        />
      </Routes>
    </BrowserRouter>
  )
}
