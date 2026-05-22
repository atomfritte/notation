import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { FolderPlus, Bookmark, Plus, MessageSquare, Edit3, Eye, FileText, FilePlus, PanelLeft, Moon, Sun, Edit2, Trash, BookmarkMinus, List, Search, Upload, History, Printer, ChevronLeft, Copy, ExternalLink, Files, Palette, HelpCircle } from 'lucide-react'
import * as api from '../lib/api'
import { isTextFile, isMarkdownFile, findDefaultFile } from '../lib/fileTypes'
import { FileTree } from '../components/FileTree'
import { MarkdownView } from '../components/MarkdownView'
// Monaco is heavy (~3MB). Load it only when the user actually starts editing.
const Editor = lazy(() => import('../components/Editor'))
import { SharePanel } from '../components/SharePanel'
import { MCPPanel } from '../components/MCPPanel'
import { CommentThread } from '../components/CommentThread'
import { ContextMenu, type MenuItem } from '../components/ui/ContextMenu'
import { CommandPalette } from '../components/CommandPalette'
import { SearchPanel } from '../components/SearchPanel'
import { Outline } from '../components/Outline'
import { HistoryPanel } from '../components/HistoryPanel'
import { AuditPanel } from '../components/AuditPanel'
import { FileViewer } from '../components/FileViewer'
import { BacklinksPanel } from '../components/BacklinksPanel'
import { HistoryView } from '../components/HistoryView'
import { ThemePalette } from '../components/ThemePalette'
import { HelpPanel } from '../components/HelpPanel'
import { getHeaderStyle, HEADER_STYLE_EVENT, type HeaderStyle } from '../lib/theme'
import { SidebarTabs, type SidebarTabKey } from '../components/SidebarTabs'
import { AllCommentsPanel } from '../components/AllCommentsPanel'

// Returns true when the keydown target is an element where the user is
// composing text — keeps single-key shortcuts like "?" from intercepting
// real keystrokes inside the editor / a comment textarea / a search box.
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (t.isContentEditable) return true
  // Monaco renders its caret inside .monaco-editor; treat any descendant as
  // a typing context so editor shortcuts win the conflict.
  if (t.closest('.monaco-editor')) return true
  return false
}

export function SpaceView() {
  const { spaceID = '' } = useParams<{ spaceID: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const file = searchParams.get('file') ?? ''
  
  const [tree, setTree] = useState<api.Entry[]>([])
  const [content, setContent] = useState<string>('')
  const [etag, setEtag] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  
  // Mobile detection drives the sidebar UX: on mobile the aside slides in
  // as a drawer (off-screen by default) instead of taking up document
  // width. matchMedia + listener keeps state in sync with viewport resize.
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(max-width: 767px)').matches
  })
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    // Default closed on phones — give the user the content first. On desktop
    // the sidebar is the workspace navigator, default-open is the right call.
    if (typeof window === 'undefined') return true
    return !window.matchMedia('(max-width: 767px)').matches
  })
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = parseInt(localStorage.getItem('notation_sidebar_width') || '', 10)
    return Number.isFinite(v) && v >= 180 && v <= 600 ? v : 256
  })
  const [resizing, setResizing] = useState(false)
  useEffect(() => {
    localStorage.setItem('notation_sidebar_width', String(sidebarWidth))
  }, [sidebarWidth])
  const mainScrollRef = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const [sidebarTab, setSidebarTab] = useState<SidebarTabKey>('files')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [showOutline, setShowOutline] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const [historyMode, setHistoryMode] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  // Mirror the header-style preference into local state so the header
  // re-renders when ThemePalette toggles it. The dispatched custom event
  // carries the new value as detail.
  const [headerStyle, setHeaderStyle] = useState<HeaderStyle>(() => getHeaderStyle())
  useEffect(() => {
    const onChange = (e: Event) => setHeaderStyle((e as CustomEvent).detail as HeaderStyle)
    window.addEventListener(HEADER_STYLE_EVENT, onChange)
    return () => window.removeEventListener(HEADER_STYLE_EVENT, onChange)
  }, [])
  
  const [comments, setComments] = useState<api.CommentItem[]>([])
  const [allComments, setAllComments] = useState<api.AllCommentItem[]>([])
  // Bumping this triggers re-fetch in AllCommentsPanel (after add/delete).
  const [allCommentsRefresh, setAllCommentsRefresh] = useState(0)
  const [showComments, setShowComments] = useState(false)
  const [pendingComment, setPendingComment] = useState<string>('')
  const [pendingAnchor, setPendingAnchor] = useState<api.CommentAnchor | null>(null)
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)
  const [bookmarks, setBookmarks] = useState<string[]>([])
  
  const [ctxMenu, setCtxMenu] = useState<{ x: number, y: number, items: MenuItem[] } | null>(null)

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('notation_theme') as 'light' | 'dark') || 'dark'
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('notation_theme', theme)
  }, [theme])

  // ---------- Default landing file ----------
  // When the user opens a Space without a ?file= query param we try to land
  // on a sensible default: readme.md / index.md / home.md / start.md at the
  // root, then the same names anywhere in the tree, then any markdown file.
  // The condition `!file` stops this from clobbering whatever the user
  // navigates to next.
  useEffect(() => {
    if (file) return
    if (!tree || tree.length === 0) return
    const landing = findDefaultFile(tree)
    if (landing) setSearchParams({ file: landing.path }, { replace: true })
  }, [file, tree, setSearchParams])

  // ---------- Per-file scroll-position memory ----------
  // We persist the outer scroll's top to localStorage keyed by space+path so
  // returning to a long doc lands you back where you were. Saving is
  // debounced (~250ms) to keep storage churn down during a scroll burst.
  // Restore deliberately waits one rAF + a short timeout so MarkdownView /
  // FileViewer have actually rendered their content before we move the
  // scroll, otherwise the layout shifts the value back to 0.
  useEffect(() => {
    const el = mainScrollRef.current
    if (!el || !file) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const key = `notation_scroll_${spaceID}__${file}`
    function onScroll() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (el && el.scrollTop > 0) localStorage.setItem(key, String(el.scrollTop))
        else localStorage.removeItem(key)
      }, 250)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (timer) clearTimeout(timer)
      el.removeEventListener('scroll', onScroll)
    }
  }, [spaceID, file])

  useEffect(() => {
    const el = mainScrollRef.current
    if (!el || !file) return
    // If the URL has a hash (Outline click / wiki-link with #section), let
    // MarkdownView's anchor-scroll do its thing; don't fight it.
    if (location.hash) return
    // Similarly, the user arrived from a search result — MarkdownView will
    // scroll to the first match — don't yank them back to the saved offset.
    if (searchParams.get('q')) return
    const saved = localStorage.getItem(`notation_scroll_${spaceID}__${file}`)
    const target = saved ? parseInt(saved, 10) || 0 : 0
    const frame = requestAnimationFrame(() => {
      setTimeout(() => {
        if (mainScrollRef.current) mainScrollRef.current.scrollTop = target
      }, 30)
    })
    return () => cancelAnimationFrame(frame)
  }, [spaceID, file, content, location.hash, searchParams])

  // ---------- Sidebar drag-resize ----------
  // Manual implementation rather than a library — the handle is a vertical
  // strip on the aside's right edge; mousedown registers global mousemove +
  // mouseup so the cursor keeps dragging even if it briefly leaves the
  // handle. The body cursor + select-none make the gesture feel native.
  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    setResizing(true)
    function move(ev: MouseEvent) {
      const dx = ev.clientX - startX
      setSidebarWidth(Math.max(180, Math.min(600, startW + dx)))
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

  // --- Callbacks (Declared first to avoid use-before-declaration) ---

  const refreshTree = useCallback(() => {
    if (!spaceID) return
    api.getTree(spaceID).then(setTree).catch(e => setErr(String(e)))
  }, [spaceID])

  const toggleBookmark = useCallback((path: string) => {
    setBookmarks(prev => {
      const next = prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
      localStorage.setItem(`notation_bookmarks_${spaceID}`, JSON.stringify(next))
      return next
    })
  }, [spaceID])

  // ---------- File-tree CRUD helpers ----------
  // Each helper does its bit of API + tree-refresh + navigation; the context
  // menu wires the user-visible labels to these. Keep them stable identities
  // for useCallback so the menu builders below don't recreate every render.

  const createFileIn = useCallback(async (parentDir: string) => {
    const raw = window.prompt(parentDir ? `New page name in ${parentDir}:` : 'New page name:')
    if (!raw) return
    const name = raw.trim()
    if (!name) return
    const withExt = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`
    const target = parentDir ? `${parentDir}/${withExt}` : withExt
    try {
      const title = withExt.replace(/\.md$/i, '').split('/').pop()
      await api.writeFile(spaceID, target, `# ${title}\n\n`)
      refreshTree()
      setSearchParams({ file: target })
      setEditing(true)
    } catch (err) { setErr(String(err)) }
  }, [spaceID, refreshTree, setSearchParams])

  const createFolderIn = useCallback(async (parentDir: string) => {
    const raw = window.prompt(parentDir ? `New folder name in ${parentDir}:` : 'New folder name:')
    if (!raw) return
    const name = raw.trim().replace(/^\/+|\/+$/g, '')
    if (!name) return
    const target = parentDir ? `${parentDir}/${name}` : name
    try {
      await api.mkdir(spaceID, target)
      refreshTree()
    } catch (err) { setErr(String(err)) }
  }, [spaceID, refreshTree])

  const renamePath = useCallback(async (oldPath: string) => {
    const newPath = window.prompt('Rename to (full path):', oldPath)
    if (!newPath || newPath === oldPath) return
    try {
      await api.renameFile(spaceID, oldPath, newPath)
      refreshTree()
      if (file === oldPath) setSearchParams({ file: newPath })
    } catch (err) { setErr(String(err)) }
  }, [spaceID, file, refreshTree, setSearchParams])

  const duplicatePath = useCallback(async (path: string) => {
    try {
      const dot = path.lastIndexOf('.')
      const base = dot > 0 ? path.slice(0, dot) : path
      const ext = dot > 0 ? path.slice(dot) : ''
      const target = `${base}-copy${ext}`
      const res = await api.readFile(spaceID, path)
      await api.writeFile(spaceID, target, res.content)
      refreshTree()
    } catch (err) { setErr(String(err)) }
  }, [spaceID, refreshTree])

  const movePathToDir = useCallback(async (from: string, toDir: string) => {
    // Reject same-dir moves and source-into-self.
    const name = from.split('/').pop() || from
    const target = toDir ? `${toDir}/${name}` : name
    if (target === from) return
    try {
      await api.renameFile(spaceID, from, target)
      refreshTree()
      if (file === from) setSearchParams({ file: target })
    } catch (err) { setErr(String(err)) }
  }, [spaceID, file, refreshTree, setSearchParams])

  const deletePath = useCallback(async (path: string, isDir: boolean) => {
    const msg = isDir
      ? `Delete folder "${path}" and ALL its contents? This cannot be undone.`
      : `Delete ${path}?`
    if (!window.confirm(msg)) return
    try {
      await api.deleteFile(spaceID, path)
      refreshTree()
      if (file === path) setSearchParams({ file: '' })
    } catch (err) { setErr(String(err)) }
  }, [spaceID, file, refreshTree, setSearchParams])

  const copyPathToClipboard = useCallback(async (path: string) => {
    try { await navigator.clipboard.writeText(path) }
    catch (err) { setErr(String(err)) }
  }, [])

  const uploadInto = useCallback(async (fileList: FileList, parentDir: string) => {
    const files = Array.from(fileList)
    if (files.length === 0) return
    setUploadStatus(`Uploading ${files.length}…`)
    let ok = 0
    for (const f of files) {
      const target = parentDir ? `${parentDir}/${f.name}` : f.name
      try {
        await api.writeFileBinary(spaceID, target, f)
        ok++
      } catch (err) {
        console.error('upload failed', target, err)
      }
    }
    setUploadStatus(`Uploaded ${ok}/${files.length}${parentDir ? ' to ' + parentDir : ''}`)
    setTimeout(() => setUploadStatus(null), 3000)
    refreshTree()
  }, [spaceID, refreshTree])

  // ---------- Context-menu builders ----------

  const handleFileContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = isDir
      ? [
          { label: 'New page in here',   icon: <FilePlus size={14} />,   onClick: () => createFileIn(path) },
          { label: 'New folder in here', icon: <FolderPlus size={14} />, onClick: () => createFolderIn(path) },
          { label: 'Rename',             icon: <Edit2 size={14} />,      onClick: () => renamePath(path) },
          { label: 'Copy path',          icon: <Copy size={14} />,       onClick: () => copyPathToClipboard(path) },
          { label: 'Delete folder',      icon: <Trash size={14} />, danger: true, onClick: () => deletePath(path, true) },
        ]
      : [
          { label: 'Open',               icon: <FileText size={14} />,   onClick: () => setSearchParams({ file: path }) },
          { label: 'Open in new tab',    icon: <ExternalLink size={14} />, onClick: () => window.open(`${window.location.pathname}?file=${encodeURIComponent(path)}`, '_blank', 'noopener') },
          { label: 'Rename',             icon: <Edit2 size={14} />,      onClick: () => renamePath(path) },
          { label: 'Duplicate',          icon: <Files size={14} />,      onClick: () => duplicatePath(path) },
          { label: 'Copy path',          icon: <Copy size={14} />,       onClick: () => copyPathToClipboard(path) },
          { label: 'Delete',             icon: <Trash size={14} />, danger: true, onClick: () => deletePath(path, false) },
        ]
    setCtxMenu({ x: e.clientX, y: e.clientY, items })
  }, [setSearchParams, createFileIn, createFolderIn, renamePath, duplicatePath, copyPathToClipboard, deletePath])

  const handleTreeBackgroundContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'New page',   icon: <FilePlus size={14} />,   onClick: () => createFileIn('') },
        { label: 'New folder', icon: <FolderPlus size={14} />, onClick: () => createFolderIn('') },
      ],
    })
  }, [createFileIn, createFolderIn])

  const handleBookmarkContextMenu = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'Remove Bookmark',
          icon: <BookmarkMinus size={14} />,
          danger: true,
          onClick: () => toggleBookmark(path)
        }
      ]
    })
  }, [toggleBookmark])

  const refreshComments = useCallback(() => {
    if (!spaceID || !file) {
      setComments([])
      return
    }
    api.getComments(spaceID, file).then(setComments).catch(console.error)
  }, [spaceID, file])

  // Space-wide listing — drives the badge count on the Comments tab + the
  // grouped view in AllCommentsPanel. Re-fetched whenever a comment is
  // added/deleted via allCommentsRefresh.
  const refreshAllComments = useCallback(() => {
    if (!spaceID) return
    api.getAllComments(spaceID).then(setAllComments).catch(console.error)
  }, [spaceID])
  useEffect(() => { refreshAllComments() }, [refreshAllComments, allCommentsRefresh])

  const handleDeleteComment = useCallback(async (commentID: string) => {
    if (!spaceID) return
    try {
      await api.deleteComment(spaceID, commentID)
      refreshComments()
      setAllCommentsRefresh(v => v + 1)
    } catch (e) {
      setErr(String(e))
    }
  }, [spaceID, refreshComments])

  const selectFile = useCallback(
    (p: string) => {
      setSearchParams({ file: p })
      // On mobile, after picking a file we want the content full-screen
      // immediately — keep the drawer behaviour explorer-like.
      if (isMobile) setSidebarOpen(false)
    },
    [setSearchParams, isMobile],
  )

  async function onNewFile() {
    const path = window.prompt('New page path (e.g. notes/meeting):')?.trim()
    if (!path) return
    const mdPath = path.toLowerCase().endsWith('.md') ? path : path + '.md'
    const title = mdPath.split('/').pop()?.replace(/\.md$/i, '')
    try {
      await api.writeFile(spaceID, mdPath, `# ${title}\n\n`)
      refreshTree()
      setSearchParams({ file: mdPath })
      setEditing(true)
    } catch (e) { setErr(String(e)) }
  }

  const handleAddComment = async (
    text: string,
    opts?: { parentID?: string; anchor?: api.CommentAnchor },
  ) => {
    if (!spaceID || !file) return
    // pendingAnchor was captured from the viewer's selection toolbar. We only
    // attach it to top-level comments (replies inherit position from parent).
    const anchor = opts?.anchor ?? (opts?.parentID ? undefined : pendingAnchor ?? undefined)
    await api.postComment(spaceID, file, text, { parentID: opts?.parentID, anchor })
    setPendingAnchor(null)
    refreshComments()
    setAllCommentsRefresh(v => v + 1)
  }

  function onNewAnchorComment(anchor: api.CommentAnchor) {
    setPendingAnchor(anchor)
    setShowComments(true)
    // Don't pre-fill the textarea with the quote — the anchor metadata renders
    // the quote in the CommentRow already, double-display looked wrong.
  }

  // When the viewer asks us to focus a comment (mark click) or hover-blink it
  // (mark hover), make sure the comments panel is visible and scroll to it.
  // requestAnimationFrame gives the panel a tick to mount + finish animating.
  useEffect(() => {
    if (!activeCommentId) return
    const t = window.setTimeout(() => {
      const panel = document.getElementById('comments-panel')
      if (!panel) return
      const el = panel.querySelector(`[data-comment-id="${CSS.escape(activeCommentId)}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
    return () => window.clearTimeout(t)
  }, [activeCommentId])

  // --- Effects ---

  useEffect(() => {
    if (!spaceID) return
    try {
      const stored = localStorage.getItem(`notation_bookmarks_${spaceID}`)
      if (stored) setBookmarks(JSON.parse(stored))
    } catch { /* ignore */ }
  }, [spaceID])

  useEffect(refreshTree, [refreshTree])

  useEffect(() => {
    if (!spaceID || !file) {
      setContent('')
      setEtag(null)
      return
    }
    if (isTextFile(file)) {
      api.readFile(spaceID, file)
        .then(res => {
          setContent(res.content)
          setEtag(res.etag)
        })
        .catch(e => setErr(String(e)))
    } else {
      // Binary file — viewer streams via direct URL, no content fetch needed.
      setContent('')
      setEtag(null)
    }
    setEditing(false)
    setHistoryMode(false)
    refreshComments()
  }, [spaceID, file, refreshComments])

  // uploadFiles is the single ingress point for the upload UX — both the
  // drag-drop overlay AND the explicit "Upload" button call into it.
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return
    setUploadStatus(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`)
    let ok = 0
    let lastPath = ''
    for (const f of files) {
      try {
        await api.writeFileBinary(spaceID, f.name, f)
        ok++
        lastPath = f.name
      } catch (err) {
        console.error('upload failed', f.name, err)
      }
    }
    setUploadStatus(
      ok === files.length
        ? `Uploaded ${ok} file${ok === 1 ? '' : 's'}`
        : `Uploaded ${ok}/${files.length} (some failed)`,
    )
    setTimeout(() => setUploadStatus(null), 3000)
    refreshTree()
    if (files.length === 1 && ok === 1) setSearchParams({ file: lastPath })
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    await uploadFiles(Array.from(e.dataTransfer?.files ?? []))
  }

  const uploadInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === '\\') {
        e.preventDefault()
        setSidebarOpen(prev => !prev)
      }
      if (e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        onNewFile()
      }
      // Cmd/Ctrl+K — file palette
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      }
      // Cmd/Ctrl+Shift+F — full-text search
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
      // `?` opens the shortcut help. Guarded so it doesn't fire while typing
      // inside the editor, comment textarea, or any other text-input element.
      if (!mod && !e.altKey && e.key === '?' && !isTypingTarget(e.target)) {
        e.preventDefault()
        setHelpOpen(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setSidebarOpen])

  if (!spaceID) return <p className="p-8 text-[var(--notation-fg-muted)]">missing workspace</p>

  const isBookmarked = bookmarks.includes(file)
  const displayTitle = file.split('/').pop()?.replace(/\.md$/i, '') || ''
  const pathParts = file ? file.split('/') : []

  // Markdown-only list drives the "Jump to page" palette + the wiki-link
  // picker — both are page-oriented and would only confuse users by listing
  // images / PDFs. The full list (below) feeds the auto-link plugin so any
  // file in the Space gets a sidecar `[File]` badge when mentioned in prose.
  const flattenTree = (entries: api.Entry[], onlyMd = true): string[] => {
    let result: string[] = []
    for (const e of entries) {
      if (e.is_dir && e.children) {
        result = result.concat(flattenTree(e.children, onlyMd))
      } else if (!e.is_dir) {
        if (!onlyMd || e.name.endsWith('.md')) result.push(e.path)
      }
    }
    return result
  }
  const allFiles = flattenTree(tree)
  const allFilesAny = flattenTree(tree, false)

  return (
    <div className="flex h-screen bg-[var(--notation-bg)] text-[var(--notation-fg)] font-sans overflow-hidden selection:bg-[color:var(--notation-accent-30)]">
      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />}
      {themeOpen && <ThemePalette onClose={() => setThemeOpen(false)} />}
      
      {/* Mobile backdrop: dim + tap-to-close the drawer. Only rendered on
         small viewports so desktop never sees it. */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-[var(--notation-backdrop)] backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
        />
      )}

      <aside
        className={`surface-elevated flex flex-col bg-[var(--notation-bg-elevated)] border-r border-[var(--notation-border)]
          fixed inset-y-0 left-0 z-40 w-72
          md:static md:z-auto md:w-auto md:flex-shrink-0
          ${resizing ? '' : 'transition-transform md:transition-[width] duration-200 ease-in-out'}
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
          ${!sidebarOpen ? 'md:border-r-0' : ''}`}
        style={{
          // Inline width is desktop-only — mobile uses the static w-72 class.
          width: isMobile ? undefined : (sidebarOpen ? sidebarWidth : 0),
        }}
      >
        <div
          className="h-full flex flex-col absolute top-0 left-0 w-full md:w-auto"
          style={{ width: isMobile ? undefined : sidebarWidth }}
        >
          {/* Clickable header takes you back to the Spaces overview. The
             avatar swaps to a left-chevron on hover so the action is obvious. */}
          <Link
            to="/admin"
            className="h-12 flex items-center px-4 hover:bg-[var(--notation-border)] transition-colors mt-2 mx-2 rounded-md group"
            title="Back to all Spaces"
          >
            <div className="flex items-center gap-2 text-[var(--notation-fg)] font-medium w-full">
              <div className="w-5 h-5 rounded bg-[var(--notation-bg-alt)] text-white dark:bg-[color:var(--notation-accent-20)] dark:text-[color:var(--notation-accent)] flex items-center justify-center font-bold text-xs uppercase relative">
                <span className="group-hover:opacity-0 transition-opacity">{spaceID.charAt(0)}</span>
                <ChevronLeft size={12} className="absolute inset-0 m-auto opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <span className="truncate">{spaceID}</span>
            </div>
          </Link>

          <div className="px-3 mt-4">
            <SidebarTabs
              active={sidebarTab}
              onPick={setSidebarTab}
              badges={{
                comments: allComments.length,
                bookmarks: bookmarks.length,
              }}
            />
          </div>

          <div className="px-5 mt-6 mb-2 text-xs font-semibold text-[var(--notation-fg-muted)] uppercase tracking-wider">
            {sidebarTab === 'files' && 'Workspace'}
            {sidebarTab === 'bookmarks' && 'Favorites'}
            {sidebarTab === 'comments' && 'All Comments'}
            {sidebarTab === 'shares' && 'Active Shares'}
            {sidebarTab === 'mcp' && 'Settings'}
            {sidebarTab === 'history' && 'Recent Commits'}
            {sidebarTab === 'audit' && 'Activity'}
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-4 no-scrollbar">
            {sidebarTab === 'files' && (
              <FileTree
                entries={tree}
                current={file}
                onSelect={selectFile}
                onContextMenu={handleFileContextMenu}
                onBackgroundContextMenu={handleTreeBackgroundContextMenu}
                onMove={movePathToDir}
                onExternalDrop={uploadInto}
                collapseStorageKey={`notation_tree_collapsed_${spaceID}`}
              />
            )}
            
            {sidebarTab === 'bookmarks' && (
              <div className="flex flex-col gap-0.5">
                {bookmarks.length === 0 ? (
                  <p className="text-xs text-[var(--notation-fg-muted)] p-2 italic">No favorites yet.</p>
                ) : (
                  bookmarks.map(b => (
                    <button
                      key={b}
                      onClick={() => selectFile(b)}
                      onContextMenu={(e) => handleBookmarkContextMenu(e, b)}
                      className={`flex items-center gap-2 w-full text-left py-1.5 px-2 rounded-md transition-colors ${file === b ? 'bg-[var(--notation-border)] text-[var(--notation-fg)] font-medium' : 'text-[var(--notation-fg-muted)] hover:bg-[var(--notation-bg-alt)]/50 hover:text-[var(--notation-fg)] dark:text-[var(--notation-fg-muted)] hover:bg-[var(--notation-bg-alt)]/50 hover:text-[var(--notation-fg)]'}`}
                    >
                      <FileText size={14} className="opacity-70" />
                      <span className="truncate">{b.replace(/\.md$/i, '')}</span>
                    </button>
                  ))
                )}
              </div>
            )}
            {sidebarTab === 'comments' && (
              <AllCommentsPanel
                spaceID={spaceID}
                currentFile={file}
                onSelectFile={(p, commentID) => {
                  selectFile(p)
                  setShowComments(true)
                  if (commentID) setActiveCommentId(commentID)
                }}
                refreshKey={allCommentsRefresh}
              />
            )}
            {sidebarTab === 'shares' && <SharePanel spaceID={spaceID} />}
            {sidebarTab === 'mcp' && <MCPPanel spaceID={spaceID} />}
            {sidebarTab === 'history' && <HistoryPanel spaceID={spaceID} />}
            {sidebarTab === 'audit' && <AuditPanel spaceID={spaceID} />}
          </div>

          <div className="p-2 border-t border-[var(--notation-border)] flex gap-1">
            <button
              onClick={onNewFile}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 rounded-md transition-colors text-sm font-medium"
            >
              <Plus size={16} /> New Page
            </button>
            <button
              onClick={() => uploadInputRef.current?.click()}
              title="Upload files (or drag-drop anywhere)"
              className="px-3 py-2 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 rounded-md transition-colors"
            >
              <Upload size={16} />
            </button>
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={async e => {
                await uploadFiles(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
          </div>
        </div>

        {/* Drag handle for resizing the sidebar. Hidden when the sidebar is
            collapsed AND on mobile (drawer width is fixed there). A 6px hit
            area with a thinner visible indicator on hover keeps it
            discoverable without intruding on the layout. */}
        {sidebarOpen && !isMobile && (
          <div
            onMouseDown={startResize}
            className="absolute top-0 right-0 h-full w-1.5 -mr-0.5 cursor-col-resize group z-20 hidden md:block"
            title="Drag to resize"
          >
            <div className="h-full w-px ml-auto bg-transparent group-hover:bg-[var(--notation-bg-alt)] dark:group-hover:bg-[var(--notation-bg-alt)] transition-colors" />
          </div>
        )}
      </aside>

      <main
        className="flex-1 flex flex-col min-w-0 bg-[var(--notation-bg)] relative"
        onDragEnter={e => {
          if (e.dataTransfer.types.includes('Files')) setDragOver(true)
        }}
        onDragOver={e => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDragLeave={e => {
          // Only clear when leaving the main container itself, not on bubbling from children.
          if (e.currentTarget === e.target) setDragOver(false)
        }}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div className="absolute inset-0 z-30 bg-[color:var(--notation-accent-10)] dark:bg-[color:var(--notation-accent-15)] border-4 border-dashed border-[color:var(--notation-accent)] flex items-center justify-center pointer-events-none">
            <div className="bg-white bg-[var(--notation-bg-alt)] rounded-lg px-6 py-4 shadow-xl flex items-center gap-3">
              <Upload size={24} className="text-[var(--notation-fg)] dark:text-[color:var(--notation-accent)]" />
              <div>
                <div className="text-[var(--notation-fg)] font-semibold">Drop to upload</div>
                <div className="text-xs text-[var(--notation-fg-muted)]">Files land in this Space's root</div>
              </div>
            </div>
          </div>
        )}
        {uploadStatus && (
          <div className="absolute top-3 right-3 z-30 bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] px-3 py-1.5 text-xs font-medium rounded-md shadow-lg animate-in slide-in-from-top-2 duration-200">
            {uploadStatus}
          </div>
        )}
        <header className={`h-12 flex justify-between items-center px-4 flex-shrink-0 z-10 sticky top-0 backdrop-blur-sm ${
          headerStyle === 'chrome'
            ? 'surface-elevated bg-[color:var(--notation-bg-elevated)]/90 border-b border-[var(--notation-border)]'
            : 'bg-[color:var(--notation-bg)]/90'
        }`}>
          <div className="flex items-center gap-2 overflow-hidden">
            {/* Single always-visible toggle for the left sidebar. The previous
                "hover to reveal" close button was undiscoverable; one explicit
                button at the start of the header reads better and works the
                same on desktop + mobile (drawer mode). */}
            <button
              onClick={() => setSidebarOpen(v => !v)}
              className={
                'p-1.5 mr-1 rounded-md transition-colors flex-shrink-0 ' +
                (sidebarOpen
                  ? 'text-[var(--notation-fg)] hover:bg-[var(--notation-border)]'
                  : 'text-[var(--notation-fg-muted)] hover:bg-[var(--notation-border)]')
              }
              title={sidebarOpen ? 'Hide sidebar (Cmd/Ctrl+\\)' : 'Show sidebar (Cmd/Ctrl+\\)'}
              aria-pressed={sidebarOpen}
            >
              <PanelLeft size={18} />
            </button>

            {file && (
              <div className="flex items-center text-sm text-[var(--notation-fg-muted)]">
                <Link to="/admin" className="hover:text-[var(--notation-fg)] hover:underline truncate max-w-[100px]" title="Back to all Spaces">{spaceID}</Link>
                {pathParts.map((part, i) => (
                  <span key={i} className="flex items-center">
                    <span className="mx-1.5 text-[var(--notation-fg-muted)] text-[var(--notation-fg-muted)]">/</span>
                    <span className={`${i === pathParts.length - 1 ? 'text-[var(--notation-fg)] font-medium' : 'hover:text-[var(--notation-fg)] hover:underline cursor-pointer'} truncate max-w-[150px]`}>
                      {part.replace(/\.md$/i, '')}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {file && (
            <div className="flex items-center gap-1">
              <button onClick={() => setSearchOpen(true)} className="p-1.5 rounded-md transition-colors text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]" title="Search (Cmd/Ctrl + Shift + F)">
                <Search size={18} />
              </button>
              {isMarkdownFile(file) && (
                <button onClick={() => setShowOutline(v => !v)} className={`hidden md:inline-flex p-1.5 rounded-md transition-colors ${showOutline ? 'bg-[var(--notation-bg-alt)] text-[var(--notation-fg)] bg-[var(--notation-bg-alt)] dark:text-[color:var(--notation-accent)]' : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]'}`} title="Outline">
                  <List size={18} />
                </button>
              )}
              <button
                onClick={() => { setHistoryMode(v => !v); setEditing(false) }}
                className={`hidden md:inline-flex p-1.5 rounded-md transition-colors ${historyMode ? 'bg-[var(--notation-bg-alt)] text-[var(--notation-fg)] bg-[var(--notation-bg-alt)] dark:text-[color:var(--notation-accent)]' : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]'}`}
                title="Version history"
              >
                <History size={18} />
              </button>
              {isTextFile(file) && !historyMode && (
                <button onClick={() => setEditing(v => !v)} className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${editing ? 'text-[var(--notation-fg)] bg-[var(--notation-bg-alt)] dark:text-[color:var(--notation-accent)] dark:bg-[color:var(--notation-accent-10)]' : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]'}`}>
                  {editing ? <Eye size={16} /> : <Edit3 size={16} />}
                </button>
              )}
              <button onClick={() => toggleBookmark(file)} className={`hidden md:inline-flex p-1.5 rounded-md transition-colors ${isBookmarked ? 'text-[var(--notation-fg)] dark:text-[color:var(--notation-accent)]' : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]'}`} title="Favorite">
                <Bookmark size={18} fill={isBookmarked ? 'currentColor' : 'none'} />
              </button>
              <button onClick={() => setShowComments(!showComments)} className={`p-1.5 rounded-md transition-colors flex items-center gap-1 ${showComments ? 'bg-[var(--notation-border)] text-[var(--notation-fg)]' : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]'}`} title="Comments">
                <MessageSquare size={18} />
                {comments.length > 0 && <span className="text-xs font-bold text-[var(--notation-fg)] dark:text-[color:var(--notation-accent)]">{comments.length}</span>}
              </button>
              
              {isMarkdownFile(file) && !editing && (
                <button
                  onClick={() => window.print()}
                  className="hidden md:inline-flex p-1.5 rounded-md transition-colors text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]"
                  title="Print this page"
                >
                  <Printer size={18} />
                </button>
              )}

              <button
                onClick={() => setThemeOpen(true)}
                className="hidden md:inline-flex p-1.5 rounded-md transition-colors text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]"
                title="Accent colour"
              >
                <Palette size={18} />
              </button>

              <button
                onClick={() => setHelpOpen(true)}
                className="p-1.5 rounded-md transition-colors text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]"
                title="Keyboard shortcuts (?)"
                aria-label="Keyboard shortcuts"
              >
                <HelpCircle size={18} />
              </button>

              <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className="p-1.5 rounded-md transition-colors text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]"
                title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
              >
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </button>
            </div>
          )}
        </header>

        <div className="flex-1 flex overflow-hidden">
          <div ref={mainScrollRef} className="flex-1 overflow-y-auto relative no-scrollbar">
            {err && <div className="absolute top-0 left-0 right-0 p-3 bg-[var(--notation-danger)] dark:bg-[var(--notation-danger)]/50 text-[var(--notation-danger)] dark:text-[var(--notation-danger)] text-sm border-b border-[var(--notation-danger)] dark:border-[var(--notation-danger)]/50 z-20 flex justify-between items-center">
               {err}
               <button onClick={() => setErr(null)} className="text-[var(--notation-danger)] hover:text-[var(--notation-danger)] dark:hover:text-[var(--notation-danger)]">&times;</button>
            </div>}
            
            {file && historyMode ? (
              <HistoryView
                spaceID={spaceID}
                path={file}
                theme={theme}
                onClose={() => setHistoryMode(false)}
                onRestored={() => {
                  // Refresh content + tree after a restore.
                  if (isTextFile(file)) {
                    api.readFile(spaceID, file).then(res => {
                      setContent(res.content)
                      setEtag(res.etag)
                    }).catch(e => setErr(String(e)))
                  }
                  refreshTree()
                }}
              />
            ) : file ? (
              // In edit mode the editor manages its own scroll, so the wrapper
              // must give it a definite height — otherwise Monaco's `height: 100%`
              // collapses to zero and the text is invisible. In read mode we
              // want the natural-flow content with bottom padding instead.
              <div
                className={
                  editing
                    ? 'absolute inset-0 flex flex-col animate-in fade-in duration-300'
                    : 'pb-32 animate-in fade-in duration-300'
                }
              >
                {!editing && !content.startsWith('# ') && (
                   <div className="max-w-3xl mx-auto px-8 pt-12 pb-4">
                      <h1 className="text-4xl font-bold text-[var(--notation-fg)] tracking-tight">{displayTitle}</h1>
                   </div>
                )}

                {editing ? (
                  <Suspense
                    fallback={
                      <div className="flex-1 flex items-center justify-center text-[var(--notation-fg-muted)] text-sm">
                        Loading editor…
                      </div>
                    }
                  >
                    <Editor
                      spaceID={spaceID}
                      path={file}
                      initial={content}
                      etag={etag}
                      theme={theme}
                      allFiles={allFiles}
                      onSaved={(c, newEtag) => {
                        setContent(c)
                        setEtag(newEtag)
                        refreshTree()
                        // Drop back to read mode after a successful save — the
                        // user can re-enter edit via the Eye/Edit toggle in
                        // the header.
                        setEditing(false)
                      }}
                      onCommentRequest={(selectedText) => {
                        setShowComments(true)
                        setPendingComment(`> ${selectedText.split('\n').join('\n> ')}\n\n`)
                      }}
                    />
                  </Suspense>
                ) : (
                  <div className={isMarkdownFile(file) && content.startsWith('# ') ? 'pt-8' : 'pt-0'}>
                    {isMarkdownFile(file) ? (
                      <MarkdownView
                        content={content}
                        theme={theme}
                        comments={comments}
                        activeCommentID={activeCommentId}
                        onHoverMark={setActiveCommentId}
                        onSelectAnchor={(id) => {
                          setShowComments(true)
                          setActiveCommentId(id)
                        }}
                        onNewAnchorComment={onNewAnchorComment}
                        files={allFilesAny}
                        currentFile={file}
                      />
                    ) : (
                      <FileViewer spaceID={spaceID} path={file} content={content} theme={theme} />
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-[var(--notation-fg-muted)] p-8">
                <FileText size={48} className="mb-4 opacity-20 dark:opacity-10" />
                <p className="text-lg">Select a page to start writing</p>
                <button onClick={onNewFile} className="mt-4 px-4 py-2 bg-[var(--notation-bg-alt)] text-[var(--notation-fg)] dark:bg-[color:var(--notation-accent-10)] dark:text-[color:var(--notation-accent)] hover:bg-[var(--notation-bg-alt)] dark:hover:bg-[color:var(--notation-accent-20)] font-medium rounded-md transition-colors">
                  Create Page
                </button>
              </div>
            )}
          </div>

          {showOutline && file && !editing && isMarkdownFile(file) && (
            <div className="surface-elevated w-[240px] border-l border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] flex flex-col flex-shrink-0 animate-in slide-in-from-right-4 duration-200 overflow-y-auto">
              <Outline content={content} />
              <BacklinksPanel spaceID={spaceID} path={file} onSelect={selectFile} />
            </div>
          )}

          {showComments && file && (
            <div id="comments-panel" className="surface-elevated w-[320px] border-l border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] flex flex-col flex-shrink-0 animate-in slide-in-from-right-8 duration-200 shadow-xl">
              <div className="p-3 border-b border-[var(--notation-border)] flex justify-between items-center bg-[var(--notation-bg-elevated)]">
                 <h3 className="font-semibold text-sm text-[var(--notation-fg)] flex items-center gap-2">
                    <MessageSquare size={16} /> Comments
                 </h3>
                 <button onClick={() => { setShowComments(false); setPendingAnchor(null); setPendingComment('') }} className="text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]">&times;</button>
              </div>
              {pendingAnchor && (
                <div className="px-3 py-2 bg-[var(--notation-warning)] dark:bg-[var(--notation-warning)]/30 border-b border-[var(--notation-warning)] dark:border-[var(--notation-warning)]/50 text-xs">
                  <div className="text-[var(--notation-warning)] dark:text-[var(--notation-warning)] font-semibold mb-1">Anchoring to selection</div>
                  <div className="text-[var(--notation-warning)] dark:text-[var(--notation-warning)]/80 italic line-clamp-2">“{pendingAnchor.quote}”</div>
                  <button
                    onClick={() => { setPendingAnchor(null); setPendingComment('') }}
                    className="mt-1 text-[var(--notation-warning)] dark:text-[var(--notation-warning)] hover:underline"
                  >
                    drop anchor
                  </button>
                </div>
              )}
              <div className="flex-1 overflow-y-auto bg-[var(--notation-bg-elevated)] bg-[var(--notation-bg-elevated)]/50">
                 <CommentThread
                   comments={comments}
                   canAdd={true}
                   initialText={pendingComment}
                   activeID={activeCommentId}
                   onHoverComment={setActiveCommentId}
                   onAdd={async (text, opts) => {
                     await handleAddComment(text, opts)
                     setPendingComment('')
                   }}
                   onDelete={handleDeleteComment}
                 />
              </div>
            </div>
          )}
        </div>
      </main>

      <CommandPalette
        open={paletteOpen}
        files={allFiles}
        onClose={() => setPaletteOpen(false)}
        onSelect={(p) => selectFile(p)}
      />
      <SearchPanel
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(p, opts) => {
          // Carry the query into the URL so the viewer can highlight and
          // scroll to the first match once the file content loads.
          const next: Record<string, string> = { file: p }
          if (opts?.query) next.q = opts.query
          setSearchParams(next)
          if (isMobile) setSidebarOpen(false)
        }}
        onSearch={(q) => api.searchSpace(spaceID, q)}
      />
      <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} scope="admin" />
    </div>
  )
}
