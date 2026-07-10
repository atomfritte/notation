import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserRouter, Route, Routes, useSearchParams } from 'react-router-dom'
import {
  PanelLeft, List, MessageSquare, Search, Printer, Sun, Moon, Palette,
  Bookmark, FileText, Folder, HelpCircle, X, Headphones,
} from 'lucide-react'
import * as api from './lib/api'
import { getCachedFile, setCachedFile, prefetchFile } from '../admin/lib/contentCache'
import { ShareCommentsPanel } from './ShareCommentsPanel'
import { HeaderActionBtn, HeaderOverflowMenu, useHeaderWidth, headerIsCompact, type HeaderAction } from '../admin/components/HeaderActions'
import { FileTree } from '../admin/components/FileTree'
import { FileViewer } from '../admin/components/FileViewer'
import { MarkdownView, stripMdExt } from '../admin/components/MarkdownView'
import { FormView } from '../admin/components/FormView'
import { ReadAloudBar } from '../admin/components/ReadAloudBar'
import { CommentThread } from '../admin/components/CommentThread'
import { Outline } from '../admin/components/Outline'
import { CommandPalette } from '../admin/components/CommandPalette'
import { SearchPanel } from '../admin/components/SearchPanel'
import { ThemePalette } from '../admin/components/ThemePalette'
import { HelpPanel } from '../admin/components/HelpPanel'
import { initTheme } from '../admin/lib/theme'
import { isTextFile, isMarkdownFile, findDefaultFile } from '../admin/lib/fileTypes'
import { useNewPages } from '../admin/lib/newPages'

// Cache key for a shared file's body. NUL-separated (can't appear in a token or
// path) and `s`-prefixed so the share SPA never reads the admin SPA's entries.
const shareKey = (token: string, path: string) => `s\u0000${token}\u0000${path}`

// Short non-reversible id for namespacing per-share client state (bookmarks,
// read-aloud position). The token is a bearer credential — it lives in the URL
// by design but must not additionally persist in localStorage, where it would
// outlive revocation/expiry. FNV-1a over a 256-bit random token can't be
// reversed to the token, and collisions between a user's few shares are moot.
function shareStorageId(token: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
const STORAGE_ID = shareStorageId(api.TOKEN)

// One-time migration of pre-existing raw-token keys to the hashed id (and
// removal of the credential-bearing originals).
for (const prefix of ['notation_share_bookmarks_', 'notation_readpos_']) {
  try {
    const old = localStorage.getItem(`${prefix}${api.TOKEN}`)
    if (old !== null) {
      if (localStorage.getItem(`${prefix}${STORAGE_ID}`) === null) {
        localStorage.setItem(`${prefix}${STORAGE_ID}`, old)
      }
      localStorage.removeItem(`${prefix}${api.TOKEN}`)
    }
  } catch { /* storage unavailable — nothing to migrate */ }
}

function ShareUI() {
  const [info, setInfo] = useState<api.SpaceInfo | null>(null)
  const [tree, setTree] = useState<api.Entry[]>([])
  const [content, setContent] = useState<string>('')
  const [editBuffer, setEditBuffer] = useState<string>('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [comments, setComments] = useState<api.Comment[]>([])
  // Every comment in the Space — powers the sidebar "Comments" tab + its badge
  // (only fetched for shares that allow commenting).
  const [allComments, setAllComments] = useState<api.Comment[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const file = searchParams.get('file') ?? ''

  // Until the /space response lands we don't know which features are
  // enabled — show the bare minimum (file tree + viewer) and reveal the
  // rich affordances as soon as we know.
  const features = info?.features
  const canEdit = info?.permission === 'edit'
  const canComment = info?.permission === 'comment' || info?.permission === 'edit'

  // Form folders render the FormView instead of being read as a file.
  const formEntry = useMemo(() => findFormEntry(tree, file), [tree, file])
  const isForm = !!formEntry?.form
  const [formData, setFormData] = useState<api.FormData | null>(null)
  const [readAloud, setReadAloud] = useState(false)
  const [ttsVoices, setTtsVoices] = useState<api.ServerVoice[] | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    api.ttsInfo().then(r => { if (!cancelled) setTtsVoices(r.available ? r.voices : []) }).catch(() => { if (!cancelled) setTtsVoices([]) })
    return () => { cancelled = true }
  }, [])
  const ttsURL = useCallback((voiceId: string, text: string, style?: string) => api.ttsURL(voiceId, text, style), [])

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
  // Desktop sidebar is drag-resizable; the chosen width is remembered in the
  // browser so a returning reader keeps their layout. Mobile uses the fixed
  // drawer width (w-72) and ignores this.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = parseInt(localStorage.getItem('notation_share_sidebar_width') || '', 10)
    return Number.isFinite(v) && v >= 180 && v <= 600 ? v : 256
  })
  const [resizing, setResizing] = useState(false)
  useEffect(() => {
    localStorage.setItem('notation_share_sidebar_width', String(sidebarWidth))
  }, [sidebarWidth])
  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    setResizing(true)
    function move(ev: MouseEvent) {
      setSidebarWidth(Math.max(180, Math.min(600, startW + (ev.clientX - startX))))
    }
    function up() {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setResizing(false)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // Right-side panel toggles, modals, etc.
  const [showOutline, setShowOutline] = useState(false)
  // Comments start collapsed so a first-time visitor lands on the content, not
  // a half-screen comment drawer they may not know how to dismiss. The header
  // toggle (and selecting text → Comment) opens it on demand.
  const [showComments, setShowComments] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'files' | 'bookmarks' | 'comments'>('files')

  // Responsive header: when the action icons can't fit, collapse them into a
  // single overflow ("hamburger") menu (shared with the admin header).
  const { ref: headerRef, width: headerWidth } = useHeaderWidth()

  // Comment coordination — viewer ↔ thread
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)
  const [pendingAnchor, setPendingAnchor] = useState<api.CommentAnchor | null>(null)
  const [pendingComment, setPendingComment] = useState<string>('')
  // True only while the comment panel is open *because* the user selected text
  // and clicked "Comment" — lets us auto-retract it after posting without
  // closing a panel the user deliberately opened from the header.
  const openedBySelectionRef = useRef(false)

  // Bookmarks (per-share-token) — kept client-only, never round-trips.
  const tokenKey = STORAGE_ID
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

  // A page-scoped share exposes exactly one node (file or form folder) —
  // treat it as a focused single-page reader: open it immediately and start
  // with the sidebar closed (one entry is no navigation).
  const singlePage = tree.length === 1 && (!tree[0].is_dir || !!tree[0].form)

  // "New since last visit" badges — a returning guest spots pages that were
  // added after their previous visit. Keyed by the hashed share id, so the
  // raw token never lands in localStorage.
  const { newPaths, markAllSeen } = useNewPages(
    `notation_new_pages_${STORAGE_ID}`, tree, file,
  )

  // Auto-pick a default file (readme/index/home/first-md) when the share
  // URL doesn't specify one. Same algorithm as the admin SpaceView so
  // guests land on something instead of an empty viewer. Single-page scopes
  // open their one node even when it isn't markdown.
  useEffect(() => {
    if (file) return
    if (!tree || tree.length === 0) return
    const landing = singlePage ? tree[0] : findDefaultFile(tree)
    if (landing) setSearchParams({ file: landing.path }, { replace: true })
  }, [file, tree, singlePage, setSearchParams])

  // Collapse the sidebar once when a single-page share loads (desktop too —
  // there's nothing to navigate). The guest can still reopen it manually.
  const collapsedForSinglePageRef = useRef(false)
  useEffect(() => {
    if (!singlePage || collapsedForSinglePageRef.current) return
    collapsedForSinglePageRef.current = true
    setSidebarOpen(false)
  }, [singlePage])

  const refreshComments = useCallback(() => {
    if (!file) { setComments([]); return }
    api.listComments(file).then(setComments).catch(() => setComments([]))
  }, [file])

  const refreshAllComments = useCallback(() => {
    if (!canComment) { setAllComments([]); return }
    api.listAllComments().then(setAllComments).catch(() => setAllComments([]))
  }, [canComment])
  useEffect(() => { refreshAllComments() }, [refreshAllComments])

  useEffect(() => {
    // Each navigation is a fresh attempt — drop any stale error from the
    // previous file so a one-off 404 doesn't stick in the footer forever, and
    // always return to read mode (don't carry one file's edit buffer onto the
    // next, and don't show a textarea over a binary file).
    setErr(null)
    setEditing(false)
    if (!file) {
      setContent('')
      setEditBuffer('')
      return
    }
    // A form folder is handled by the form-fetch effect — don't read the
    // directory as a file.
    if (isForm) {
      setContent('')
      setEditBuffer('')
      return
    }
    let cancelled = false
    if (isTextFile(file)) {
      // Cache-first (stale-while-revalidate): paint a previously-opened or
      // hover-prefetched body immediately so the page switch feels instant,
      // then revalidate against the server below.
      const ck = shareKey(api.TOKEN, file)
      const cached = getCachedFile(ck)
      if (cached) {
        setContent(cached.content)
        setEditBuffer(cached.content)
      }
      api.readFile(file).then(c => {
        if (cancelled) return
        setCachedFile(ck, c, null)
        // Skip the redundant state churn when the server agrees with the cached
        // body — that no-op would otherwise clobber the edit buffer mid-edit.
        if (!cached || cached.content !== c) {
          setContent(c)
          setEditBuffer(c)
        }
      // A 400 usually means the path is a directory (a form folder the tree
      // hasn't classified yet) — don't flash an error; the form effect handles it.
      }).catch(e => { if (!cancelled && (e as { status?: number })?.status !== 400) setErr(String(e)) })
    } else {
      setContent('')
      setEditBuffer('')
    }
    refreshComments()
    // Guard against out-of-order responses when navigating quickly: a late
    // resolve from the previous file must not clobber the current one.
    return () => { cancelled = true }
  }, [file, refreshComments, isForm])

  // Load a form folder's schema + entries when one is opened.
  useEffect(() => {
    if (!file || !isForm) { setFormData(null); return }
    let cancelled = false
    setFormData(null)
    api.getForm(file)
      .then(d => { if (!cancelled) setFormData(d) })
      .catch(e => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [file, isForm])

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

  const dirty = editing && editBuffer !== content
  const select = useCallback((p: string) => {
    if (editing && editBuffer !== content && !window.confirm('Discard unsaved changes?')) return
    setSearchParams({ file: p })
    if (isMobile) setSidebarOpen(false)
  }, [setSearchParams, isMobile, editing, editBuffer, content])

  // Warm a page's text into the cache on hover (tree / links / prev-next) so
  // the open that follows paints from cache instead of waiting on the network.
  const warmFile = useCallback((p: string) => {
    if (!p || !isTextFile(p)) return
    prefetchFile(shareKey(api.TOKEN, p), () => api.readFile(p).then(content => ({ content, etag: null })))
  }, [])

  // Warn before a tab close / reload would drop unsaved edits (edit-permission
  // guests). In-app navigation is guarded by `select` above.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

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

  // Ordered markdown-only list (menu order) for prev/next page navigation.
  const navFiles = useMemo(() => allFiles.filter(isMarkdownFile), [allFiles])

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
      setCachedFile(shareKey(api.TOKEN, file), editBuffer, null)
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
    // An anchored top-level comment created from a text selection: once it's
    // sent, retract the panel again so the reader returns to the content — but
    // only if the panel was opened *by* that selection, not deliberately.
    const wasAnchored = !!anchor && !opts?.parentID
    setPendingAnchor(null)
    refreshComments()
    refreshAllComments()
    if (wasAnchored && openedBySelectionRef.current) setShowComments(false)
    if (wasAnchored) openedBySelectionRef.current = false
  }
  // Selecting text and clicking "Comment" reveals the (default-collapsed)
  // comment panel and pre-anchors the new comment to the selection.
  function onNewAnchorComment(anchor: api.CommentAnchor) {
    setShowComments(prev => {
      if (!prev) openedBySelectionRef.current = true
      return true
    })
    setPendingAnchor(anchor)
  }

  if (err && !info) {
    return (
      <div className="p-8 max-w-xl mx-auto">
        <h1 className="text-xl font-bold mb-2 text-[var(--notation-fg)]">Share unavailable</h1>
        <p className="text-[var(--notation-danger)] dark:text-[var(--notation-danger)]">{err}</p>
      </div>
    )
  }
  if (!info) return <div className="p-8 text-[var(--notation-fg-muted)]">loading…</div>

  // Sidebar tabs a guest gets: Pages always, plus Comments (if they can
  // comment) and Bookmarks (if enabled) — with live badge counts, like admin.
  const sidebarTabs: { key: 'files' | 'comments' | 'bookmarks'; label: string; icon: React.ReactNode; badge?: number }[] = [
    { key: 'files', label: 'Pages', icon: <Folder size={13} /> },
  ]
  if (canComment) sidebarTabs.push({ key: 'comments', label: 'Comments', icon: <MessageSquare size={13} />, badge: allComments.length })
  if (features?.bookmarks) sidebarTabs.push({ key: 'bookmarks', label: 'Bookmarks', icon: <Bookmark size={13} />, badge: bookmarks.length })

  // Open a page from the Comments tab, focusing the clicked comment.
  const openComment = (path: string, commentID?: string) => {
    select(path)
    if (commentID) {
      setActiveCommentId(commentID)
      if (canComment) { openedBySelectionRef.current = false; setShowComments(true) }
    }
  }

  // The header's icon actions — a single list that drives both the inline
  // buttons and the overflow menu, so they never drift apart.
  const headerActions: HeaderAction[] = []
  if (features?.search) headerActions.push({ key: 'search', label: 'Search', icon: <Search size={16} />, onClick: () => setSearchOpen(true) })
  if (features?.outline && !isMobile && isMarkdownFile(file)) headerActions.push({ key: 'outline', label: 'Outline', icon: <List size={16} />, active: showOutline, onClick: () => setShowOutline(v => !v) })
  if (canComment && !isForm) headerActions.push({ key: 'comments', label: 'Comments', icon: <MessageSquare size={16} />, active: showComments, badge: comments.length, onClick: () => { openedBySelectionRef.current = false; setShowComments(v => !v) } })
  if (features?.bookmarks) headerActions.push({ key: 'bookmark', label: isBookmarked ? 'Remove bookmark' : 'Bookmark this page', icon: <Bookmark size={16} fill={isBookmarked ? 'currentColor' : 'none'} />, active: !!isBookmarked, onClick: () => toggleBookmark(file) })
  if (isMarkdownFile(file) && !editing && !isForm) headerActions.push({ key: 'read', label: 'Read aloud', icon: <Headphones size={16} />, active: readAloud, onClick: () => setReadAloud(v => !v) })
  if (features?.print && isMarkdownFile(file) && !editing) headerActions.push({ key: 'print', label: 'Print this page', icon: <Printer size={16} />, onClick: () => window.print() })
  if (features?.theme) headerActions.push({ key: 'accent', label: 'Accent colour', icon: <Palette size={16} />, onClick: () => setThemeOpen(true) })
  if (features?.theme) headerActions.push({ key: 'theme', label: theme === 'dark' ? 'Light mode' : 'Dark mode', icon: theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />, onClick: () => setTheme(theme === 'dark' ? 'light' : 'dark') })
  headerActions.push({ key: 'help', label: 'Keyboard shortcuts', icon: <HelpCircle size={16} />, onClick: () => setHelpOpen(true) })

  // Collapse to the hamburger when the icons (~34px each) would crowd the title
  // or the Edit button. Before the first measurement, fall back to isMobile.
  const editVisible = canEdit && isTextFile(file) && !isForm
  const reservedW = 40 /* sidebar toggle */ + 72 /* title min */ + (editVisible ? 76 : 0)
  const compactHeader = headerIsCompact(headerWidth, headerActions.length, reservedW, isMobile)

  return (
    <div className="flex h-[100dvh] bg-[var(--notation-bg)] text-[var(--notation-fg)] overflow-hidden selection:bg-[color:var(--notation-accent-30)]">
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-[var(--notation-backdrop)] backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
        />
      )}
      <aside
        className={
          'surface-elevated flex flex-col bg-[var(--notation-bg-elevated)] border-r border-[var(--notation-border)] overflow-hidden ' +
          'fixed inset-y-0 left-0 z-40 w-72 ' +
          'md:relative md:z-auto md:w-auto md:flex-shrink-0 ' +
          (resizing ? '' : 'transition-transform md:transition-[width] duration-200 ease-in-out') + ' ' +
          (sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0') + ' ' +
          (!sidebarOpen ? 'md:border-r-0' : '')
        }
        style={{ width: isMobile ? undefined : (sidebarOpen ? sidebarWidth : 0) }}
      >
        <div
          className="h-full flex flex-col w-72 md:w-auto"
          style={{ width: isMobile ? undefined : sidebarWidth }}
        >
        <div className="p-4 border-b border-[var(--notation-border)]">
          <div className="flex items-center gap-2 text-[var(--notation-fg)] font-medium">
            <div className="w-5 h-5 rounded bg-[var(--notation-bg-alt)] text-[var(--notation-fg)] dark:bg-[color:var(--notation-accent-20)] dark:text-[color:var(--notation-accent)] flex items-center justify-center font-bold text-xs uppercase">
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
            {info.scope && (
              <span className="truncate font-mono" title={`This link is limited to ${info.scope}`}>
                ⌖ {info.scope}
              </span>
            )}
            {info.label && <span className="truncate">{info.label}</span>}
          </p>
        </div>

        {/* Tab row appears once there's more than just Pages (comments and/or
            bookmarks), giving guests the same Pages / Comments / Bookmarks
            navigation the admin has, with badges. */}
        {sidebarTabs.length > 1 && (
          <div className="px-3 mt-3 flex gap-1">
            {sidebarTabs.map(t => (
              <button
                key={t.key}
                onClick={() => setSidebarTab(t.key)}
                className={
                  'flex-1 min-w-0 px-2 py-1.5 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 transition-colors ' +
                  (sidebarTab === t.key
                    ? 'bg-[var(--notation-border)] text-[var(--notation-fg)]'
                    : 'text-[var(--notation-fg-muted)] hover:bg-[var(--notation-border)]')
                }
                title={t.label}
              >
                {t.icon}
                <span className="truncate">{t.label}</span>
                {t.badge ? (
                  <span className="text-[9px] font-bold bg-[color:var(--notation-accent-15)] text-[color:var(--notation-accent)] px-1.5 py-0.5 rounded-full flex-shrink-0">
                    {t.badge}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2">
          {sidebarTab === 'files' && (
            <FileTree
              entries={tree}
              current={file}
              onSelect={select}
              onPrefetch={warmFile}
              collapseStorageKey={`notation_share_tree_collapsed_${info.space.id}`}
              newPaths={newPaths}
              onMarkAllSeen={markAllSeen}
            />
          )}
          {canComment && sidebarTab === 'comments' && (
            <ShareCommentsPanel
              comments={allComments}
              currentFile={file}
              onSelect={openComment}
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
                      title={b.replace(/\.md$/i, '')}
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
        </div>

        {/* Drag handle — desktop only. Lives on the aside's right edge; the
            aside is md:relative so this anchors to it. Width is persisted. */}
        {sidebarOpen && !isMobile && (
          <div
            onMouseDown={startResize}
            className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize group z-20 hidden md:block"
            title="Drag to resize"
          >
            <div className="h-full w-px ml-auto bg-transparent group-hover:bg-[var(--notation-bg-alt)] transition-colors" />
          </div>
        )}
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        {file ? (
          <>
            <header ref={headerRef} className="surface-elevated h-12 flex justify-between items-center px-4 border-b border-[var(--notation-border)] flex-shrink-0 text-sm gap-2 bg-[color:var(--notation-bg-elevated)]/90 backdrop-blur-sm">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button
                  onClick={() => setSidebarOpen(v => !v)}
                  className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-border)] flex-shrink-0"
                  aria-label="Toggle sidebar"
                >
                  <PanelLeft size={18} />
                </button>
                <span className="text-[var(--notation-fg-muted)] truncate" title={stripMdExt(file)}>{stripMdExt(file)}</span>
              </div>

              <div className="flex items-center gap-1 flex-shrink-0">
                {compactHeader
                  ? <HeaderOverflowMenu actions={headerActions} />
                  : headerActions.map(a => <HeaderActionBtn key={a.key} action={a} />)}
                {editVisible && (
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
                {isForm ? (
                  formData ? (
                    <FormView
                      data={formData}
                      onSubmit={async (values) => {
                        await api.submitForm(file, values)
                        const fresh = await api.getForm(file)
                        setFormData(fresh)
                      }}
                      uploadImage={(blob) => api.uploadFormImage(file, blob)}
                      imageURL={(path) => api.fileURLForShare(path)}
                    />
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-[var(--notation-fg-muted)] text-sm">Loading form…</div>
                  )
                ) : editing ? (
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
                    navFiles={navFiles}
                    onNavigate={select}
                    onPrefetch={warmFile}
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
                    <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-2 border-b border-[var(--notation-border)] bg-[var(--notation-bg-elevated)]">
                      <span className="text-sm font-semibold text-[var(--notation-fg)] flex items-center gap-2">
                        <MessageSquare size={14} /> Comments
                      </span>
                      <button
                        onClick={() => { setShowComments(false); openedBySelectionRef.current = false; setPendingAnchor(null); setPendingComment('') }}
                        className="text-xs text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] flex items-center gap-1 px-1.5 py-0.5 rounded-md hover:bg-[var(--notation-border)]"
                        aria-label="Close comments"
                      >
                        <X size={14} /> Cancel
                      </button>
                    </div>
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
                  <div className="p-2 pl-3 text-[var(--notation-danger)] dark:text-[var(--notation-danger)] text-sm border-t border-[var(--notation-danger)] dark:border-[var(--notation-danger)]/50 flex justify-between items-center gap-3">
                    <span className="min-w-0 truncate">{err}</span>
                    <button
                      onClick={() => setErr(null)}
                      className="flex-shrink-0 px-1.5 leading-none text-lg hover:opacity-70"
                      aria-label="Dismiss error"
                    >
                      &times;
                    </button>
                  </div>
                )}
              </div>

              {features?.outline && !isMobile && showOutline && isMarkdownFile(file) && !editing && (
                <aside className="surface-elevated w-[240px] border-l border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] flex-shrink-0 overflow-y-auto no-print">
                  <Outline content={content} />
                </aside>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-[var(--notation-fg-muted)] gap-4 p-8 text-center">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="flex items-center gap-2 px-3 py-2 rounded-md bg-[var(--notation-bg-alt)] text-[var(--notation-fg)] text-sm"
              >
                <PanelLeft size={16} /> Open file list
              </button>
            )}
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
          onSelect={(p, opts) => {
            const next: Record<string, string> = { file: p }
            if (opts?.query) next.q = opts.query
            setSearchParams(next)
            if (isMobile) setSidebarOpen(false)
          }}
          onSearch={(q) => api.searchSpace(q)}
        />
      )}
      {features?.theme && themeOpen && (
        <ThemePalette onClose={() => setThemeOpen(false)} />
      )}
      <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} scope="share" />
      {readAloud && (
        <ReadAloudBar
          navFiles={navFiles}
          currentFile={file}
          content={content}
          onNavigate={select}
          storageKey={`notation_readpos_${STORAGE_ID}`}
          onClose={() => setReadAloud(false)}
          serverVoices={ttsVoices}
          ttsURL={ttsURL}
        />
      )}
    </div>
  )
}

// Returns true when the keydown target is a text-entry element so bare-key
// shortcuts (like `?`) don't intercept real keystrokes inside the editor.
// Depth-first lookup of a tree entry (form folders are present in the tree with
// their children omitted, so this still finds the folder node).
function findFormEntry(entries: api.Entry[], path: string): api.Entry | null {
  if (!path) return null
  for (const e of entries) {
    if (e.path === path) return e
    if (e.is_dir && e.children) {
      const hit = findFormEntry(e.children, path)
      if (hit) return hit
    }
  }
  return null
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (t.isContentEditable) return true
  return false
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
