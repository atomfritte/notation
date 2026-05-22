import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { Folder, FolderPlus, Settings, Bookmark, Plus, MessageSquare, Edit3, Eye, FileText, FilePlus, PanelLeft, Share2, Moon, Sun, Edit2, Trash, BookmarkMinus, GitCommit, ShieldCheck, List, Search, Upload, History, Printer, ChevronLeft, Copy, ExternalLink, Files } from 'lucide-react'
import * as api from '../lib/api'
import { isTextFile, isMarkdownFile } from '../lib/fileTypes'
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

export function SpaceView() {
  const { spaceID = '' } = useParams<{ spaceID: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const file = searchParams.get('file') ?? ''
  
  const [tree, setTree] = useState<api.Entry[]>([])
  const [content, setContent] = useState<string>('')
  const [etag, setEtag] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  
  const [sidebarOpen, setSidebarOpen] = useState(true)
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
  const [sidebarTab, setSidebarTab] = useState<'files' | 'bookmarks' | 'shares' | 'mcp' | 'history' | 'audit'>('files')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [showOutline, setShowOutline] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const [historyMode, setHistoryMode] = useState(false)
  
  const [comments, setComments] = useState<api.CommentItem[]>([])
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
  // When the user opens a Space without a ?file= query param we want to land
  // on README.md (case-insensitive, top-level) if it exists. This runs once
  // the tree has loaded; subsequent navigations are user-driven via
  // setSearchParams, so the condition `!file` stops this from clobbering
  // anything the user picks.
  useEffect(() => {
    if (file) return
    if (!tree || tree.length === 0) return
    const readme = tree.find(e => !e.is_dir && /^readme\.(md|markdown|txt)$/i.test(e.name))
    if (readme) setSearchParams({ file: readme.path }, { replace: true })
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
    const saved = localStorage.getItem(`notation_scroll_${spaceID}__${file}`)
    const target = saved ? parseInt(saved, 10) || 0 : 0
    const frame = requestAnimationFrame(() => {
      setTimeout(() => {
        if (mainScrollRef.current) mainScrollRef.current.scrollTop = target
      }, 30)
    })
    return () => cancelAnimationFrame(frame)
  }, [spaceID, file, content, location.hash])

  // ---------- Sidebar drag-resize ----------
  // Manual implementation rather than a library Ã¢â‚¬â€ the handle is a vertical
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
    setUploadStatus(`Uploading ${files.length}Ã¢â‚¬Â¦`)
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

  const selectFile = useCallback(
    (p: string) => {
      setSearchParams({ file: p })
    },
    [setSearchParams],
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
  }

  function onNewAnchorComment(anchor: api.CommentAnchor) {
    setPendingAnchor(anchor)
    setShowComments(true)
    // Don't pre-fill the textarea with the quote Ã¢â‚¬â€ the anchor metadata renders
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
      // Binary file Ã¢â‚¬â€ viewer streams via direct URL, no content fetch needed.
      setContent('')
      setEtag(null)
    }
    setEditing(false)
    setHistoryMode(false)
    refreshComments()
  }, [spaceID, file, refreshComments])

  // uploadFiles is the single ingress point for the upload UX Ã¢â‚¬â€ both the
  // drag-drop overlay AND the explicit "Upload" button call into it.
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return
    setUploadStatus(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}Ã¢â‚¬Â¦`)
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
      // Cmd/Ctrl+K Ã¢â‚¬â€ file palette
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      }
      // Cmd/Ctrl+Shift+F Ã¢â‚¬â€ full-text search
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setSidebarOpen])

  if (!spaceID) return <p className="p-8 text-zinc-400">missing workspace</p>

  const isBookmarked = bookmarks.includes(file)
  const displayTitle = file.split('/').pop()?.replace(/\.md$/i, '') || ''
  const pathParts = file ? file.split('/') : []

  const flattenTree = (entries: api.Entry[]): string[] => {
    let result: string[] = []
    for (const e of entries) {
      if (e.is_dir && e.children) {
        result = result.concat(flattenTree(e.children))
      } else if (!e.is_dir && e.name.endsWith('.md')) {
        result.push(e.path)
      }
    }
    return result
  }
  const allFiles = flattenTree(tree)

  return (
    <div className="flex h-screen bg-white dark:bg-[#0a0a0a] text-zinc-900 dark:text-zinc-300 font-sans overflow-hidden selection:bg-[color:var(--notation-accent-30)]">
      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />}
      
      <aside
        className={`flex-shrink-0 flex flex-col bg-zinc-50 dark:bg-[#111111] ${resizing ? '' : 'transition-[width] duration-200 ease-in-out'} border-r border-zinc-200 dark:border-zinc-800/50 relative ${sidebarOpen ? '' : 'border-r-0'}`}
        style={{ width: sidebarOpen ? sidebarWidth : 0 }}
      >
        <div
          className="h-full flex flex-col absolute top-0 left-0"
          style={{ width: sidebarWidth }}
        >
          {/* Clickable header takes you back to the Spaces overview. The
             avatar swaps to a left-chevron on hover so the action is obvious. */}
          <Link
            to="/admin"
            className="h-12 flex items-center px-4 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 transition-colors mt-2 mx-2 rounded-md group"
            title="Back to all Spaces"
          >
            <div className="flex items-center gap-2 text-zinc-800 dark:text-zinc-200 font-medium w-full">
              <div className="w-5 h-5 rounded bg-zinc-900 text-white dark:bg-[color:var(--notation-accent-20)] dark:text-[color:var(--notation-accent)] flex items-center justify-center font-bold text-xs uppercase relative">
                <span className="group-hover:opacity-0 transition-opacity">{spaceID.charAt(0)}</span>
                <ChevronLeft size={12} className="absolute inset-0 m-auto opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <span className="truncate">{spaceID}</span>
            </div>
          </Link>

          <div className="px-3 mt-4 space-y-0.5">
            <button onClick={() => setSidebarTab('bookmarks')} className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${sidebarTab === 'bookmarks' ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-200' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300'}`}>
              <Bookmark size={16} /> Bookmarks
            </button>
            <button onClick={() => setSidebarTab('files')} className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${sidebarTab === 'files' ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-200' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300'}`}>
              <Folder size={16} /> Pages
            </button>
            <button onClick={() => setSidebarTab('shares')} className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${sidebarTab === 'shares' ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-200' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300'}`}>
              <Share2 size={16} /> Sharing
            </button>
            <button onClick={() => setSidebarTab('mcp')} className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${sidebarTab === 'mcp' ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-200' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300'}`}>
              <Settings size={16} /> Integration
            </button>
            <button onClick={() => setSidebarTab('history')} className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${sidebarTab === 'history' ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-200' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300'}`}>
              <GitCommit size={16} /> History
            </button>
            <button onClick={() => setSidebarTab('audit')} className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${sidebarTab === 'audit' ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-200' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300'}`}>
              <ShieldCheck size={16} /> Audit
            </button>
          </div>

          <div className="px-5 mt-6 mb-2 text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
            {sidebarTab === 'files' && 'Workspace'}
            {sidebarTab === 'bookmarks' && 'Favorites'}
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
              />
            )}
            
            {sidebarTab === 'bookmarks' && (
              <div className="flex flex-col gap-0.5">
                {bookmarks.length === 0 ? (
                  <p className="text-xs text-zinc-500 p-2 italic">No favorites yet.</p>
                ) : (
                  bookmarks.map(b => (
                    <button
                      key={b}
                      onClick={() => selectFile(b)}
                      onContextMenu={(e) => handleBookmarkContextMenu(e, b)}
                      className={`flex items-center gap-2 w-full text-left py-1.5 px-2 rounded-md transition-colors ${file === b ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100 font-medium' : 'text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-200'}`}
                    >
                      <FileText size={14} className="opacity-70" />
                      <span className="truncate">{b.replace(/\.md$/i, '')}</span>
                    </button>
                  ))
                )}
              </div>
            )}
            {sidebarTab === 'shares' && <SharePanel spaceID={spaceID} />}
            {sidebarTab === 'mcp' && <MCPPanel spaceID={spaceID} />}
            {sidebarTab === 'history' && <HistoryPanel spaceID={spaceID} />}
            {sidebarTab === 'audit' && <AuditPanel spaceID={spaceID} />}
          </div>

          <div className="p-2 border-t border-zinc-200 dark:border-zinc-800/50 flex gap-1">
            <button
              onClick={onNewFile}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/50 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800/50 rounded-md transition-colors text-sm font-medium"
            >
              <Plus size={16} /> New Page
            </button>
            <button
              onClick={() => uploadInputRef.current?.click()}
              title="Upload files (or drag-drop anywhere)"
              className="px-3 py-2 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/50 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800/50 rounded-md transition-colors"
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
            collapsed; a 6px hit area with a thinner visible indicator on
            hover keeps it discoverable without intruding on the layout. */}
        {sidebarOpen && (
          <div
            onMouseDown={startResize}
            className="absolute top-0 right-0 h-full w-1.5 -mr-0.5 cursor-col-resize group z-20"
            title="Drag to resize"
          >
            <div className="h-full w-px ml-auto bg-transparent group-hover:bg-zinc-300 dark:group-hover:bg-zinc-700 transition-colors" />
          </div>
        )}
      </aside>

      <main
        className="flex-1 flex flex-col min-w-0 bg-white dark:bg-[#0a0a0a] relative"
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
            <div className="bg-white dark:bg-zinc-900 rounded-lg px-6 py-4 shadow-xl flex items-center gap-3">
              <Upload size={24} className="text-zinc-900 dark:text-[color:var(--notation-accent)]" />
              <div>
                <div className="text-zinc-900 dark:text-zinc-100 font-semibold">Drop to upload</div>
                <div className="text-xs text-zinc-500">Files land in this Space's root</div>
              </div>
            </div>
          </div>
        )}
        {uploadStatus && (
          <div className="absolute top-3 right-3 z-30 bg-zinc-900 text-white dark:bg-[color:var(--notation-accent)] dark:text-zinc-950 px-3 py-1.5 text-xs font-medium rounded-md shadow-lg animate-in slide-in-from-top-2 duration-200">
            {uploadStatus}
          </div>
        )}
        <header className="h-12 flex justify-between items-center px-4 flex-shrink-0 z-10 sticky top-0 bg-white/80 dark:bg-[#0a0a0a]/80 backdrop-blur-sm">
          <div className="flex items-center gap-2 overflow-hidden">
            {!sidebarOpen && (
              <button onClick={() => setSidebarOpen(true)} className="p-1.5 mr-1 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 rounded-md transition-colors" title="Open Sidebar (Cmd/Ctrl + \)">
                <PanelLeft size={18} />
              </button>
            )}
            {sidebarOpen && (
              <button onClick={() => setSidebarOpen(false)} className="p-1.5 mr-1 text-zinc-400 hover:bg-zinc-100 dark:text-zinc-500 dark:hover:bg-zinc-800 rounded-md transition-colors opacity-0 hover:opacity-100 absolute left-2 top-2 z-50 group-hover:opacity-100" title="Close Sidebar (Cmd/Ctrl + \)">
                <PanelLeft size={18} />
              </button>
            )}

            {file && (
              <div className="flex items-center text-sm text-zinc-500 dark:text-zinc-400">
                <Link to="/admin" className="hover:text-zinc-800 dark:hover:text-zinc-200 hover:underline truncate max-w-[100px]" title="Back to all Spaces">{spaceID}</Link>
                {pathParts.map((part, i) => (
                  <span key={i} className="flex items-center">
                    <span className="mx-1.5 text-zinc-300 dark:text-zinc-600">/</span>
                    <span className={`${i === pathParts.length - 1 ? 'text-zinc-900 dark:text-zinc-200 font-medium' : 'hover:text-zinc-800 dark:hover:text-zinc-200 hover:underline cursor-pointer'} truncate max-w-[150px]`}>
                      {part.replace(/\.md$/i, '')}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {file && (
            <div className="flex items-center gap-1">
              <button onClick={() => setSearchOpen(true)} className="p-1.5 rounded-md transition-colors text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800" title="Search (Cmd/Ctrl + Shift + F)">
                <Search size={18} />
              </button>
              {isMarkdownFile(file) && (
                <button onClick={() => setShowOutline(v => !v)} className={`p-1.5 rounded-md transition-colors ${showOutline ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-[color:var(--notation-accent)]' : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800'}`} title="Outline">
                  <List size={18} />
                </button>
              )}
              <button
                onClick={() => { setHistoryMode(v => !v); setEditing(false) }}
                className={`p-1.5 rounded-md transition-colors ${historyMode ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-[color:var(--notation-accent)]' : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800'}`}
                title="Version history"
              >
                <History size={18} />
              </button>
              {isTextFile(file) && !historyMode && (
                <button onClick={() => setEditing(v => !v)} className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${editing ? 'text-zinc-900 bg-zinc-100 dark:text-[color:var(--notation-accent)] dark:bg-[color:var(--notation-accent-10)]' : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800'}`}>
                  {editing ? <Eye size={16} /> : <Edit3 size={16} />}
                </button>
              )}
              <button onClick={() => toggleBookmark(file)} className={`p-1.5 rounded-md transition-colors ${isBookmarked ? 'text-zinc-900 dark:text-[color:var(--notation-accent)]' : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800'}`} title="Favorite">
                <Bookmark size={18} fill={isBookmarked ? 'currentColor' : 'none'} />
              </button>
              <button onClick={() => setShowComments(!showComments)} className={`p-1.5 rounded-md transition-colors flex items-center gap-1 ${showComments ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-200' : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800'}`} title="Comments">
                <MessageSquare size={18} />
                {comments.length > 0 && <span className="text-xs font-bold text-zinc-900 dark:text-[color:var(--notation-accent)]">{comments.length}</span>}
              </button>
              
              {isMarkdownFile(file) && !editing && (
                <button
                  onClick={() => window.print()}
                  className="p-1.5 rounded-md transition-colors text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800"
                  title="Print this page"
                >
                  <Printer size={18} />
                </button>
              )}

              <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className="p-1.5 rounded-md transition-colors text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800"
                title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
              >
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </button>
            </div>
          )}
        </header>

        <div className="flex-1 flex overflow-hidden">
          <div ref={mainScrollRef} className="flex-1 overflow-y-auto relative no-scrollbar">
            {err && <div className="absolute top-0 left-0 right-0 p-3 bg-red-50 dark:bg-red-900/50 text-red-600 dark:text-red-200 text-sm border-b border-red-200 dark:border-red-900/50 z-20 flex justify-between items-center">
               {err}
               <button onClick={() => setErr(null)} className="text-red-400 hover:text-red-600 dark:hover:text-red-200">&times;</button>
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
              // must give it a definite height Ã¢â‚¬â€ otherwise Monaco's `height: 100%`
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
                      <h1 className="text-4xl font-bold text-zinc-900 dark:text-zinc-100 tracking-tight">{displayTitle}</h1>
                   </div>
                )}

                {editing ? (
                  <Suspense
                    fallback={
                      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
                        Loading editorÃ¢â‚¬Â¦
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
                        // Drop back to read mode after a successful save Ã¢â‚¬â€ the
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
                      />
                    ) : (
                      <FileViewer spaceID={spaceID} path={file} content={content} theme={theme} />
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500 p-8">
                <FileText size={48} className="mb-4 opacity-20 dark:opacity-10" />
                <p className="text-lg">Select a page to start writing</p>
                <button onClick={onNewFile} className="mt-4 px-4 py-2 bg-zinc-100 text-zinc-900 dark:bg-[color:var(--notation-accent-10)] dark:text-[color:var(--notation-accent)] hover:bg-zinc-200 dark:hover:bg-[color:var(--notation-accent-20)] font-medium rounded-md transition-colors">
                  Create Page
                </button>
              </div>
            )}
          </div>

          {showOutline && file && !editing && isMarkdownFile(file) && (
            <div className="w-[240px] border-l border-zinc-200 dark:border-zinc-800 bg-zinc-50/30 dark:bg-[#0a0a0a] flex flex-col flex-shrink-0 animate-in slide-in-from-right-4 duration-200 overflow-y-auto">
              <Outline content={content} />
              <BacklinksPanel spaceID={spaceID} path={file} onSelect={selectFile} />
            </div>
          )}

          {showComments && file && (
            <div id="comments-panel" className="w-[320px] border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#0a0a0a] flex flex-col flex-shrink-0 animate-in slide-in-from-right-8 duration-200 shadow-xl">
              <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 flex justify-between items-center bg-zinc-50 dark:bg-zinc-950">
                 <h3 className="font-semibold text-sm text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                    <MessageSquare size={16} /> Comments
                 </h3>
                 <button onClick={() => { setShowComments(false); setPendingAnchor(null); setPendingComment('') }} className="text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300">&times;</button>
              </div>
              {pendingAnchor && (
                <div className="px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50 text-xs">
                  <div className="text-amber-900 dark:text-amber-300 font-semibold mb-1">Anchoring to selection</div>
                  <div className="text-amber-800 dark:text-amber-400/80 italic line-clamp-2">Ã¢â‚¬Å“{pendingAnchor.quote}Ã¢â‚¬Â</div>
                  <button
                    onClick={() => { setPendingAnchor(null); setPendingComment('') }}
                    className="mt-1 text-amber-700 dark:text-amber-300 hover:underline"
                  >
                    drop anchor
                  </button>
                </div>
              )}
              <div className="flex-1 overflow-y-auto bg-zinc-50 dark:bg-zinc-950/50">
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
        spaceID={spaceID}
        onClose={() => setSearchOpen(false)}
        onSelect={(p) => selectFile(p)}
      />
    </div>
  )
}
