import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { FolderPlus, Bookmark, Plus, MessageSquare, Edit3, Eye, FileText, FilePlus, PanelLeft, Moon, Sun, Edit2, Trash, BookmarkMinus, List, Search, Upload, History, Printer, ChevronLeft, Copy, ExternalLink, Files, Palette, HelpCircle, Download, Archive, Headphones, Lock, Unlock, X as XIcon, BookOpen, FolderSync } from 'lucide-react'
import * as api from '../lib/api'
import * as keyStore from '../lib/keyStore'
import { openEncryptedFS, fsToEntries } from '../lib/encSpace'
import { downloadDecryptedSpaceZip } from '../lib/spaceZip'
import { collectPages } from '../lib/pageOrder'
import { createEncryptedSearchIndex, type EncryptedSearchIndex } from '../lib/encSearch'
import type { EncryptedFS } from '../../shared/vfs/encfs'
import { utf8Decode, utf8Encode } from '../../shared/crypto/bytes'
import { UnlockScreen } from '../components/UnlockScreen'
import { getCachedFile, setCachedFile, prefetchFile } from '../lib/contentCache'
import { isTextFile, isMarkdownFile, findDefaultFile, rendersFromBytes } from '../lib/fileTypes'
import { downloadDecryptedFile } from '../lib/decryptedFile'
import { useNewPages } from '../lib/newPages'
import { FileTree } from '../components/FileTree'
import { MarkdownView, stripMdExt } from '../components/MarkdownView'
import { FormView } from '../components/FormView'
import { ReadAloudBar } from '../components/ReadAloudBar'
import { PrepareAudioPanel } from '../components/PrepareAudioPanel'
import { HeaderActionBtn, HeaderOverflowMenu, useHeaderWidth, headerIsCompact, type HeaderAction } from '../components/HeaderActions'
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
import { EncryptedFileView } from '../components/EncryptedFileView'
import { BacklinksPanel } from '../components/BacklinksPanel'
import { HistoryView } from '../components/HistoryView'
import { ThemePalette } from '../components/ThemePalette'
import { HelpPanel } from '../components/HelpPanel'
import { getHeaderStyle, HEADER_STYLE_EVENT, type HeaderStyle } from '../lib/theme'
import { SidebarTabs, type SidebarTabKey } from '../components/SidebarTabs'
import { AllCommentsPanel } from '../components/AllCommentsPanel'
import { ConvertDialog } from '../components/ConvertDialog'
import { FolderSyncPanel } from '../components/FolderSyncPanel'
import { folderSyncSupported } from '../lib/fsAccess'

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

// Cache key for a file's text body. NUL-separated so it can't collide with a
// path that happens to contain the separator, and `a`-prefixed so the admin
// SPA never reads the share SPA's entries in the same browser.
const contentKey = (spaceID: string, path: string) => `a\u0000${spaceID}\u0000${path}`

export function SpaceView() {
  const { spaceID = '' } = useParams<{ spaceID: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const file = searchParams.get('file') ?? ''

  // ---------- Zero-knowledge encryption ----------
  // spaceMeta tells us whether this space is encrypted. When it is and the key
  // is in the session keyStore, all file ops route through an EncryptedFS
  // instead of the plaintext api.ts. Plaintext spaces never touch any of this.
  const [spaceMeta, setSpaceMeta] = useState<api.Meta | null>(null)
  const encrypted = !!spaceMeta?.encrypted
  const ksVersion = keyStore.useKeyStoreVersion()
  const unlocked = !encrypted || keyStore.isUnlocked(spaceID)
  const fsRef = useRef<EncryptedFS | null>(null)
  // Client-side full-text search index over the decrypted corpus (encrypted
  // spaces only — plaintext spaces use the server /search endpoint). Rebuilt
  // alongside the FS; its text cache is dropped on any mutation (see below).
  const searchIndexRef = useRef<EncryptedSearchIndex | null>(null)
  const [fsReady, setFsReady] = useState(false)
  // Refs the stable useCallback CRUD helpers read at call time so they branch to
  // the FS without being recreated (and without churning their identities).
  const encryptedRef = useRef(false)
  useEffect(() => { encryptedRef.current = encrypted }, [encrypted])

  const [tree, setTree] = useState<api.Entry[]>([])
  const [content, setContent] = useState<string>('')
  const [etag, setEtag] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // "New since last visit" badges in the tree — pages that appeared while
  // this client wasn't looking (MCP agents, share guests, form entries).
  const { newPaths, markAllSeen } = useNewPages(
    spaceID ? `notation_new_pages_${spaceID}` : null, tree, file,
  )
  
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
  const sidebarScrollRef = useRef<HTMLDivElement>(null)
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
  // Non-null while the encrypt/decrypt conversion dialog is open.
  const [convertDir, setConvertDir] = useState<api.ConvertDirection | null>(null)
  // Local-folder-sync panel (encrypted spaces only): decrypt the space to a
  // real folder for a local agent, then re-encrypt reviewed changes back.
  const [folderSyncOpen, setFolderSyncOpen] = useState(false)

  // Form folders: when the selected path is a folder with a _form.md template,
  // we render the FormView instead of treating it as a file.
  const formEntry = useMemo(() => findTreeEntry(tree, file), [tree, file])
  const isForm = !!formEntry?.form
  const [formData, setFormData] = useState<api.FormData | null>(null)
  const [readAloud, setReadAloud] = useState(false)
  const [prepareAudioOpen, setPrepareAudioOpen] = useState(false)
  // Server studio voices for read-aloud (undefined = still probing).
  const [ttsVoices, setTtsVoices] = useState<api.ServerVoice[] | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    api.ttsInfo().then(r => { if (!cancelled) setTtsVoices(r.available ? r.voices : []) }).catch(() => { if (!cancelled) setTtsVoices([]) })
    return () => { cancelled = true }
  }, [])
  const ttsURL = useCallback((voiceId: string, text: string, style?: string) => api.ttsURL(spaceID, voiceId, text, style), [spaceID])
  const { ref: headerRef, width: headerWidth } = useHeaderWidth()

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

  // ---------- Drag auto-scroll for the file tree ----------
  // HTML5 drag-and-drop never scrolls the container on its own, so a folder
  // below the fold can't be reached as a drop target. We watch the pointer
  // during any drag and, when it nears the top/bottom edge of the sidebar's
  // scroll area, nudge scrollTop via a rAF loop. The loop keeps running while
  // the cursor is held still at the edge — `dragover` alone wouldn't fire
  // then, so plain event-driven scrolling would stall.
  useEffect(() => {
    const EDGE = 48        // px from edge where scrolling kicks in
    const MAX_SPEED = 16   // px per frame at the very edge
    let pointerY = 0
    let dragging = false
    let raf = 0

    function step() {
      const el = sidebarScrollRef.current
      if (!dragging || !el) { raf = 0; return }
      const rect = el.getBoundingClientRect()
      let dy = 0
      if (pointerY < rect.top + EDGE) {
        dy = -MAX_SPEED * Math.min(1, (rect.top + EDGE - pointerY) / EDGE)
      } else if (pointerY > rect.bottom - EDGE) {
        dy = MAX_SPEED * Math.min(1, (pointerY - (rect.bottom - EDGE)) / EDGE)
      }
      if (dy !== 0) el.scrollTop += dy
      raf = requestAnimationFrame(step)
    }
    function onDragOver(e: DragEvent) {
      pointerY = e.clientY
      if (!dragging) {
        dragging = true
        if (!raf) raf = requestAnimationFrame(step)
      }
    }
    function stop() {
      dragging = false
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', stop)
    window.addEventListener('dragend', stop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', stop)
      window.removeEventListener('dragend', stop)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  // --- Callbacks (Declared first to avoid use-before-declaration) ---

  const refreshTree = useCallback(() => {
    if (!spaceID) return
    const fs = fsRef.current
    if (encryptedRef.current) {
      // Encrypted: pull new ops, then re-project the node set. Until the FS is
      // built (before unlock) there is nothing to show and no server tree to
      // fetch — the plaintext /tree endpoint 409s for an encrypted space.
      if (!fs) return
      fs.sync().then(() => setTree(fsToEntries(fs))).catch(e => setErr(String(e)))
      return
    }
    // A 409 means the space is actually encrypted but meta hasn't loaded yet;
    // swallow it (the encrypted path takes over once meta resolves) rather than
    // flashing an error. Plaintext /tree never 409s, so this is a no-op there.
    api.getTree(spaceID).then(setTree).catch(e => { if ((e as { status?: number })?.status !== 409) setErr(String(e)) })
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
      const body = `# ${title}\n\n`
      const fs = fsRef.current
      if (fs) { await fs.write(target, utf8Encode(body)); await fs.sync(); setTree(fsToEntries(fs)) }
      else { await api.writeFile(spaceID, target, body); refreshTree() }
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
      const fs = fsRef.current
      if (fs) { await fs.mkdir(target); await fs.sync(); setTree(fsToEntries(fs)) }
      else { await api.mkdir(spaceID, target); refreshTree() }
    } catch (err) { setErr(String(err)) }
  }, [spaceID, refreshTree])

  const renamePath = useCallback(async (oldPath: string) => {
    const newPath = window.prompt('Rename to (full path):', oldPath)
    if (!newPath || newPath === oldPath) return
    try {
      const fs = fsRef.current
      if (fs) { await fs.rename(oldPath, newPath); await fs.sync(); setTree(fsToEntries(fs)) }
      else { await api.renameFile(spaceID, oldPath, newPath); refreshTree() }
      if (file === oldPath) setSearchParams({ file: newPath })
    } catch (err) { setErr(String(err)) }
  }, [spaceID, file, refreshTree, setSearchParams])

  const duplicatePath = useCallback(async (path: string) => {
    try {
      const dot = path.lastIndexOf('.')
      const base = dot > 0 ? path.slice(0, dot) : path
      const ext = dot > 0 ? path.slice(dot) : ''
      const target = `${base}-copy${ext}`
      const fs = fsRef.current
      if (fs) {
        const bytes = await fs.read(path)
        await fs.write(target, bytes)
        await fs.sync()
        setTree(fsToEntries(fs))
      } else {
        const res = await api.readFile(spaceID, path)
        await api.writeFile(spaceID, target, res.content)
        refreshTree()
      }
    } catch (err) { setErr(String(err)) }
  }, [spaceID, refreshTree])

  const movePathToDir = useCallback(async (from: string, toDir: string) => {
    // Reject same-dir moves and source-into-self.
    const name = from.split('/').pop() || from
    const target = toDir ? `${toDir}/${name}` : name
    if (target === from) return
    try {
      const fs = fsRef.current
      if (fs) { await fs.rename(from, target); await fs.sync(); setTree(fsToEntries(fs)) }
      else { await api.renameFile(spaceID, from, target); refreshTree() }
      if (file === from) setSearchParams({ file: target })
    } catch (err) { setErr(String(err)) }
  }, [spaceID, file, refreshTree, setSearchParams])

  const deletePath = useCallback(async (path: string, isDir: boolean) => {
    const msg = isDir
      ? `Delete folder "${path}" and ALL its contents? This cannot be undone.`
      : `Delete ${path}?`
    if (!window.confirm(msg)) return
    try {
      const fs = fsRef.current
      if (fs) { await fs.remove(path); await fs.sync(); setTree(fsToEntries(fs)) }
      else { await api.deleteFile(spaceID, path); refreshTree() }
      if (file === path) setSearchParams({ file: '' })
    } catch (err) { setErr(String(err)) }
  }, [spaceID, file, refreshTree, setSearchParams])

  const copyPathToClipboard = useCallback(async (path: string) => {
    try { await navigator.clipboard.writeText(path) }
    catch (err) { setErr(String(err)) }
  }, [])

  // Whole-space PDF: hand off to the dedicated print route, which stacks every
  // page and opens the print dialog. In-app navigation keeps the in-memory
  // keyStore alive so an encrypted space can still be decrypted there.
  const printWholeSpace = useCallback(() => {
    navigate(`/admin/spaces/${encodeURIComponent(spaceID)}/print`)
  }, [navigate, spaceID])

  // "Download all": plaintext hits the server ZIP endpoint; an encrypted+unlocked
  // space builds a DECRYPTED zip client-side (the server holds only ciphertext).
  const downloadAllZip = useCallback(async () => {
    if (!encryptedRef.current) { api.downloadSpaceZip(spaceID); return }
    const fs = fsRef.current
    if (!fs) { setErr('space is locked'); return }
    try {
      setUploadStatus('Preparing decrypted ZIP…')
      await downloadDecryptedSpaceZip(fs, spaceID)
      setUploadStatus('ZIP downloaded')
      setTimeout(() => setUploadStatus(null), 3000)
    } catch (e) {
      setUploadStatus(null)
      setErr(String(e))
    }
  }, [spaceID])

  const uploadInto = useCallback(async (fileList: FileList, parentDir: string) => {
    const files = Array.from(fileList)
    if (files.length === 0) return
    setUploadStatus(`Uploading ${files.length}…`)
    let ok = 0
    const fs = fsRef.current
    for (const f of files) {
      const target = parentDir ? `${parentDir}/${f.name}` : f.name
      try {
        if (fs) await fs.write(target, new Uint8Array(await f.arrayBuffer()))
        else await api.writeFileBinary(spaceID, target, f)
        ok++
      } catch (err) {
        console.error('upload failed', target, err)
      }
    }
    if (fs) await fs.sync()
    setUploadStatus(`Uploaded ${ok}/${files.length}${parentDir ? ' to ' + parentDir : ''}`)
    setTimeout(() => setUploadStatus(null), 3000)
    refreshTree()
  }, [spaceID, refreshTree])

  // Hidden input reused by the "Upload here" context-menu action. The target
  // directory is stashed on a ref (not state) so the picker opens against the
  // exact folder that was right-clicked, with no re-render in between.
  const folderUploadInputRef = useRef<HTMLInputElement>(null)
  const folderUploadDirRef = useRef<string>('')
  const promptUploadInto = useCallback((dir: string) => {
    folderUploadDirRef.current = dir
    folderUploadInputRef.current?.click()
  }, [])

  // ---------- Context-menu builders ----------

  const handleFileContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = isDir
      ? [
          { label: 'New page in here',   icon: <FilePlus size={14} />,   onClick: () => createFileIn(path) },
          { label: 'New folder in here', icon: <FolderPlus size={14} />, onClick: () => createFolderIn(path) },
          { label: 'Upload here',        icon: <Upload size={14} />,     onClick: () => promptUploadInto(path) },
          { label: 'Rename',             icon: <Edit2 size={14} />,      onClick: () => renamePath(path) },
          { label: 'Copy path',          icon: <Copy size={14} />,       onClick: () => copyPathToClipboard(path) },
          { label: 'Delete folder',      icon: <Trash size={14} />, danger: true, onClick: () => deletePath(path, true) },
        ]
      : [
          { label: 'Open',               icon: <FileText size={14} />,   onClick: () => setSearchParams({ file: path }) },
          { label: 'Open in new tab',    icon: <ExternalLink size={14} />, onClick: () => window.open(`${window.location.pathname}?file=${encodeURIComponent(path)}`, '_blank', 'noopener') },
          { label: 'Download',           icon: <Download size={14} />,   onClick: () => {
            // Encrypted spaces have no server bytes to fetch (the /file endpoint
            // 409s) — download the client-decrypted blob instead.
            const fs = fsRef.current
            if (encryptedRef.current && fs) void downloadDecryptedFile(fs, path)
            else api.downloadFile(spaceID, path)
          } },
          { label: 'Rename',             icon: <Edit2 size={14} />,      onClick: () => renamePath(path) },
          { label: 'Duplicate',          icon: <Files size={14} />,      onClick: () => duplicatePath(path) },
          { label: 'Copy path',          icon: <Copy size={14} />,       onClick: () => copyPathToClipboard(path) },
          { label: 'Delete',             icon: <Trash size={14} />, danger: true, onClick: () => deletePath(path, false) },
        ]
    setCtxMenu({ x: e.clientX, y: e.clientY, items })
  }, [spaceID, setSearchParams, createFileIn, createFolderIn, promptUploadInto, renamePath, duplicatePath, copyPathToClipboard, deletePath])

  const handleTreeBackgroundContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'New page',   icon: <FilePlus size={14} />,   onClick: () => createFileIn('') },
        { label: 'New folder', icon: <FolderPlus size={14} />, onClick: () => createFolderIn('') },
        { label: 'Upload here', icon: <Upload size={14} />,    onClick: () => promptUploadInto('') },
        // Whole-space PDF: works for any space (plaintext + encrypted alike).
        { label: 'Print whole space (PDF)', icon: <BookOpen size={14} />, onClick: printWholeSpace },
        // Encrypted spaces build the DECRYPTED zip client-side (the server /export
        // endpoint holds only ciphertext and 409s); plaintext uses that endpoint.
        { label: encryptedRef.current ? 'Download all (decrypted ZIP)' : 'Download all (ZIP)', icon: <Archive size={14} />, onClick: () => { void downloadAllZip() } },
        // Space-level conversion: encrypt a plaintext space (or decrypt an
        // unlocked encrypted one) in place. Destructive on finalize — the dialog
        // warns clearly.
        // Zero-knowledge spaces can sync to a local plaintext folder for a local
        // agent (Claude Code). Encrypted + supported browsers only.
        ...(encryptedRef.current && folderSyncSupported()
          ? [{ label: 'Local folder sync…', icon: <FolderSync size={14} />, onClick: () => setFolderSyncOpen(true) }]
          : []),
        encryptedRef.current
          ? { label: 'Decrypt this space…', icon: <Unlock size={14} />, onClick: () => setConvertDir('to-plaintext') }
          : { label: 'Encrypt this space…', icon: <Lock size={14} />, onClick: () => setConvertDir('to-encrypted') },
      ],
    })
  }, [spaceID, createFileIn, createFolderIn, promptUploadInto, printWholeSpace, downloadAllZip])

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
    // Comments are a server feature — encrypted spaces have none (the endpoint
    // 409s), so don't even ask.
    if (!spaceID || encryptedRef.current) return
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

  // Warm a page's text into the cache on hover (file tree, in-document links,
  // prev/next) so the click that follows paints from cache instead of waiting
  // on the network. Best-effort and deduped — see contentCache.
  const warmFile = useCallback(
    (p: string) => {
      // Encrypted spaces read straight from the FS on open (no server cache
      // path), so there is nothing to prefetch — and the plaintext endpoint 409s.
      if (encryptedRef.current) return
      if (!spaceID || !p || !isTextFile(p)) return
      prefetchFile(contentKey(spaceID, p), () =>
        api.readFile(spaceID, p).then(res => ({ content: res.content, etag: res.etag })),
      )
    },
    [spaceID],
  )

  async function onNewFile() {
    const path = window.prompt('New page path (e.g. notes/meeting):')?.trim()
    if (!path) return
    const mdPath = path.toLowerCase().endsWith('.md') ? path : path + '.md'
    const title = mdPath.split('/').pop()?.replace(/\.md$/i, '')
    try {
      const body = `# ${title}\n\n`
      const fs = fsRef.current
      if (fs) { await fs.write(mdPath, utf8Encode(body)); await fs.sync(); setTree(fsToEntries(fs)) }
      else { await api.writeFile(spaceID, mdPath, body); refreshTree() }
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

  // Fetch the space's metadata (crucially the `encrypted` flag) so we know
  // whether to drive it through the plaintext API or an EncryptedFS.
  useEffect(() => {
    if (!spaceID) return
    let cancelled = false
    setSpaceMeta(null)
    api.getSpace(spaceID).then(m => { if (!cancelled) setSpaceMeta(m) }).catch(e => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [spaceID])

  // Build (and load) the EncryptedFS once the space is unlocked. Rebuilds when
  // the space or its unlocked-state changes; tears down on lock.
  useEffect(() => {
    if (!encrypted || !unlocked) {
      fsRef.current = null
      searchIndexRef.current = null
      setFsReady(false)
      return
    }
    const handle = keyStore.get(spaceID)
    if (!handle) return
    let cancelled = false
    setFsReady(false)
    openEncryptedFS(spaceID, handle)
      .then(fs => {
        if (cancelled) return
        fsRef.current = fs
        // Fresh FS → fresh (empty) search cache; the old index (if any) is
        // discarded so a re-unlock never searches a stale corpus.
        searchIndexRef.current = createEncryptedSearchIndex(fs)
        setFsReady(true)
        setTree(fsToEntries(fs))
      })
      .catch(e => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
    // ksVersion so a re-unlock after a lock rebuilds the FS with the new handle.
  }, [spaceID, encrypted, unlocked, ksVersion])

  // Any mutation (create / rename / move / delete / upload / save) replaces the
  // `tree` array with a fresh projection, so keying off it drops the encrypted
  // search index's decrypted-text cache on every structural change — a
  // re-decrypt of a personal-notes corpus is cheap; a stale hit is a bug. It
  // never fires mid-search (typing in the modal doesn't touch the tree).
  useEffect(() => { searchIndexRef.current?.clear() }, [tree])

  useEffect(refreshTree, [refreshTree])

  useEffect(() => {
    // Fresh attempt per navigation — clear any stale error so a one-off 404
    // (e.g. a stale link) doesn't pin itself to the top of every later page.
    setErr(null)
    if (!spaceID || !file) {
      setContent('')
      setEtag(null)
      return
    }
    // Form folders aren't files — the FormView fetch effect handles them; don't
    // try to read the directory as a file (it would 404).
    if (isForm) {
      setContent('')
      setEtag(null)
      setEditing(false)
      setHistoryMode(false)
      return
    }
    // Encrypted space: decrypt the file through the FS (no cache, no server
    // etag). Until the FS is built we simply show nothing.
    if (encrypted) {
      const fs = fsRef.current
      setEditing(false)
      setHistoryMode(false)
      if (!fs || !isTextFile(file)) {
        setContent('')
        setEtag(null)
        return
      }
      let cancelledEnc = false
      fs.read(file)
        .then(bytes => { if (!cancelledEnc) { setContent(utf8Decode(bytes)); setEtag(null) } })
        .catch(e => { if (!cancelledEnc) setErr(String(e)) })
      return () => { cancelledEnc = true }
    }
    let cancelled = false
    if (isTextFile(file)) {
      // Cache-first (stale-while-revalidate): if we've opened this file before
      // — or it was prefetched on hover — paint its text immediately so the
      // switch feels instant, then revalidate against the server below.
      const ck = contentKey(spaceID, file)
      const cached = getCachedFile(ck)
      if (cached) {
        setContent(cached.content)
        setEtag(cached.etag)
      }
      api.readFile(spaceID, file)
        .then(res => {
          if (cancelled) return
          setCachedFile(ck, res.content, res.etag)
          // Skip the redundant state churn when the server agrees with what we
          // already painted from cache — that no-op would otherwise reset an
          // editor the user may have just opened on the cached text.
          if (!cached || cached.content !== res.content) {
            setContent(res.content)
            setEtag(res.etag)
          }
        })
        // A 400 usually means the path is a directory — e.g. a form folder the
        // tree hasn't classified yet. A 409 means the space is actually
        // encrypted but its meta hasn't loaded yet (the encrypted branch above
        // takes over once it does). Don't flash an error for either.
        .catch(e => { if (!cancelled && ![400, 409].includes((e as { status?: number })?.status ?? 0)) setErr(String(e)) })
    } else {
      // Binary file — viewer streams via direct URL, no content fetch needed.
      setContent('')
      setEtag(null)
    }
    setEditing(false)
    setHistoryMode(false)
    refreshComments()
    // A late response from the previous file must not clobber the current one.
    return () => { cancelled = true }
  }, [spaceID, file, refreshComments, isForm, encrypted, fsReady])

  // Load a form folder's schema + entries when one is selected.
  useEffect(() => {
    if (!spaceID || !file || !isForm) { setFormData(null); return }
    let cancelled = false
    setFormData(null)
    api.getForm(spaceID, file)
      .then(d => { if (!cancelled) setFormData(d) })
      .catch(e => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [spaceID, file, isForm])

  // uploadFiles is the single ingress point for the upload UX — both the
  // drag-drop overlay AND the explicit "Upload" button call into it.
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return
    setUploadStatus(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`)
    let ok = 0
    let lastPath = ''
    const fs = fsRef.current
    for (const f of files) {
      try {
        if (fs) await fs.write(f.name, new Uint8Array(await f.arrayBuffer()))
        else await api.writeFileBinary(spaceID, f.name, f)
        ok++
        lastPath = f.name
      } catch (err) {
        console.error('upload failed', f.name, err)
      }
    }
    if (fs) await fs.sync()
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

  // Markdown-only list drives the "Jump to page" palette, wiki-link picker, and
  // prev/next nav; the full list feeds the auto-link plugin + link resolution.
  // Memoised so MarkdownView's per-file caches aren't rebuilt on every render
  // (hover, comment toggles, etc. would otherwise thrash them).
  const allFiles = useMemo(() => collectPages(tree, true), [tree])
  const allFilesAny = useMemo(() => collectPages(tree, false), [tree])

  // Backlinks for encrypted spaces: the server can't read the ciphertext, so we
  // resolve `[[wiki-links]]` over the decrypted corpus in-browser, reusing the
  // search index (and its cache/invalidation). Memoised on the file list so the
  // BacklinksPanel recomputes on a structural change / save — not per render.
  // Plaintext spaces pass undefined and keep the server-backed path.
  const backlinksCompute = useCallback(
    (p: string) => searchIndexRef.current?.backlinks(p, allFilesAny) ?? Promise.resolve([]),
    [allFilesAny],
  )

  if (!spaceID) return <p className="p-8 text-[var(--notation-fg-muted)]">missing workspace</p>

  // Encrypted + locked → gate the whole browser behind the unlock screen.
  // Storing the handle bumps the keyStore version, which re-renders us with
  // `unlocked` true and kicks off the EncryptedFS build effect.
  if (encrypted && !unlocked) {
    return <UnlockScreen spaceID={spaceID} onUnlocked={(handle) => keyStore.set(spaceID, handle)} />
  }

  const isBookmarked = bookmarks.includes(file)
  const displayTitle = stripMdExt(file.split('/').pop() || '')
  const pathParts = file ? file.split('/') : []

  // Header tools as one list driving both the inline icons and the overflow
  // ("tool") menu — so on a narrow window every tool stays reachable. Encrypted
  // spaces hide the server-backed tools (full-text search, git history,
  // comments, studio read-aloud) that 409 server-side.
  const headerActions: HeaderAction[] = []
  // Full-text search works for BOTH modes: plaintext hits the server /search
  // endpoint; encrypted searches the decrypted corpus in-browser (see below).
  headerActions.push({ key: 'search', label: 'Search', icon: <Search size={18} />, onClick: () => setSearchOpen(true) })
  if (isMarkdownFile(file) && !isForm) headerActions.push({ key: 'outline', label: 'Outline', icon: <List size={18} />, active: showOutline, onClick: () => setShowOutline(v => !v) })
  if (!isForm && !encrypted) headerActions.push({ key: 'history', label: 'Version history', icon: <History size={18} />, active: historyMode, onClick: () => { setHistoryMode(v => !v); setEditing(false) } })
  if (!isForm) headerActions.push({ key: 'bookmark', label: isBookmarked ? 'Remove favorite' : 'Add favorite', icon: <Bookmark size={18} fill={isBookmarked ? 'currentColor' : 'none'} />, active: isBookmarked, onClick: () => toggleBookmark(file) })
  if (!isForm && !encrypted) headerActions.push({ key: 'comments', label: 'Comments', icon: <MessageSquare size={18} />, active: showComments, badge: comments.length, onClick: () => setShowComments(v => !v) })
  if (isMarkdownFile(file) && !editing && !isForm) headerActions.push({ key: 'read', label: 'Read aloud', icon: <Headphones size={18} />, active: readAloud, onClick: () => setReadAloud(v => !v) })
  if (isMarkdownFile(file) && !editing) headerActions.push({ key: 'print', label: 'Print this page', icon: <Printer size={18} />, onClick: () => window.print() })
  // Whole-space PDF — sibling of the single-page print; available for any space.
  headerActions.push({ key: 'print-space', label: 'Print whole space (PDF)', icon: <BookOpen size={18} />, onClick: printWholeSpace })
  headerActions.push({ key: 'accent', label: 'Accent colour', icon: <Palette size={18} />, onClick: () => setThemeOpen(true) })
  headerActions.push({ key: 'help', label: 'Keyboard shortcuts', icon: <HelpCircle size={18} />, onClick: () => setHelpOpen(true) })
  headerActions.push({ key: 'theme', label: theme === 'dark' ? 'Light mode' : 'Dark mode', icon: theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />, onClick: () => setTheme(theme === 'dark' ? 'light' : 'dark') })
  if (encrypted && folderSyncSupported()) headerActions.push({ key: 'folder-sync', label: 'Local folder sync', icon: <FolderSync size={18} />, onClick: () => setFolderSyncOpen(true) })
  if (encrypted) headerActions.push({ key: 'lock', label: 'Lock space', icon: <Lock size={18} />, onClick: () => { setContent(''); setTree([]); keyStore.lock(spaceID) } })
  const editVisible = isTextFile(file) && !historyMode && !isForm
  const compactHeader = headerIsCompact(headerWidth, headerActions.length, 120 + (editVisible ? 64 : 0), isMobile)

  return (
    <div className="flex h-[100dvh] bg-[var(--notation-bg)] text-[var(--notation-fg)] font-sans overflow-hidden selection:bg-[color:var(--notation-accent-30)]">
      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />}
      {themeOpen && <ThemePalette onClose={() => setThemeOpen(false)} />}
      {folderSyncOpen && encrypted && fsReady && fsRef.current && (
        <FolderSyncPanel
          fs={fsRef.current}
          spaceID={spaceID}
          onClose={() => setFolderSyncOpen(false)}
          onSynced={() => { if (fsRef.current) setTree(fsToEntries(fsRef.current)) }}
        />
      )}
      {convertDir && (
        <ConvertDialog
          spaceID={spaceID}
          direction={convertDir}
          handle={keyStore.get(spaceID)}
          onClose={() => setConvertDir(null)}
          onDone={(meta) => {
            setConvertDir(null)
            setErr(null)
            setSearchParams({}, { replace: true })
            setContent('')
            setEtag(null)
            setEditing(false)
            setHistoryMode(false)
            setTree([])
            setSpaceMeta(meta)
            // Encrypted → the EncryptedFS build effect (keyed on encrypted/unlocked)
            // loads the tree once the just-stored handle is seen. Plaintext → load
            // the server tree directly now that the gate has settled.
            if (!meta.encrypted) {
              api.getTree(spaceID).then(setTree).catch(e => setErr(String(e)))
            }
          }}
        />
      )}
      
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
              <div className="w-5 h-5 rounded bg-[var(--notation-bg-alt)] text-[var(--notation-fg)] dark:bg-[color:var(--notation-accent-20)] dark:text-[color:var(--notation-accent)] flex items-center justify-center font-bold text-xs uppercase relative">
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
              // Encrypted spaces expose only the client-side tabs; comments,
              // sharing, MCP, git history and audit are all server features.
              tabs={encrypted ? ['bookmarks', 'files'] : undefined}
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

          <div ref={sidebarScrollRef} className="flex-1 overflow-y-auto px-2 pb-4 no-scrollbar">
            {sidebarTab === 'files' && (
              <FileTree
                entries={tree}
                current={file}
                onSelect={selectFile}
                onPrefetch={warmFile}
                onContextMenu={handleFileContextMenu}
                onBackgroundContextMenu={handleTreeBackgroundContextMenu}
                onMove={movePathToDir}
                onExternalDrop={uploadInto}
                collapseStorageKey={`notation_tree_collapsed_${spaceID}`}
                newPaths={newPaths}
                onMarkAllSeen={markAllSeen}
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
            {!encrypted && sidebarTab === 'comments' && (
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
            {!encrypted && sidebarTab === 'shares' && <SharePanel spaceID={spaceID} />}
            {!encrypted && sidebarTab === 'mcp' && <MCPPanel spaceID={spaceID} />}
            {!encrypted && sidebarTab === 'history' && <HistoryPanel spaceID={spaceID} />}
            {!encrypted && sidebarTab === 'audit' && <AuditPanel spaceID={spaceID} />}
          </div>

          <div className="p-2 border-t border-[var(--notation-border)] flex gap-1">
            <button
              onClick={onNewFile}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 rounded-md transition-colors text-sm font-medium"
            >
              <Plus size={16} /> New Page
            </button>
            <button
              onClick={() => createFolderIn('')}
              title="New top-level folder"
              className="px-3 py-2 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 rounded-md transition-colors"
            >
              <FolderPlus size={16} />
            </button>
            <button
              onClick={() => uploadInputRef.current?.click()}
              title="Upload files (or drag-drop anywhere)"
              className="px-3 py-2 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 rounded-md transition-colors"
            >
              <Upload size={16} />
            </button>
            <button
              onClick={() => { void downloadAllZip() }}
              title={encrypted ? 'Download decrypted ZIP of this Space' : 'Download whole Space as ZIP'}
              className="px-3 py-2 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 rounded-md transition-colors"
            >
              <Archive size={16} />
            </button>
            {encrypted && folderSyncSupported() && (
              <button
                onClick={() => setFolderSyncOpen(true)}
                title="Local folder sync (work on this Space as plain files)"
                className="px-3 py-2 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 rounded-md transition-colors"
              >
                <FolderSync size={16} />
              </button>
            )}
            {!spaceMeta?.converting && (
              <button
                onClick={() => setConvertDir(encrypted ? 'to-plaintext' : 'to-encrypted')}
                title={encrypted ? 'Decrypt this Space' : 'Encrypt this Space (zero-knowledge)'}
                className="px-3 py-2 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 rounded-md transition-colors"
              >
                {encrypted ? <Unlock size={16} /> : <Lock size={16} />}
              </button>
            )}
            {!encrypted && ttsVoices && ttsVoices.length > 0 && (
              <button
                onClick={() => setPrepareAudioOpen(true)}
                title="Audio vorbereiten (Ordner vertonen, offline hören)"
                className="px-3 py-2 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 rounded-md transition-colors"
              >
                <Headphones size={16} />
              </button>
            )}
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
            <input
              ref={folderUploadInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={async e => {
                const files = e.target.files
                if (files && files.length > 0) await uploadInto(files, folderUploadDirRef.current)
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
            <div className="bg-[var(--notation-bg-alt)] rounded-lg px-6 py-4 shadow-xl flex items-center gap-3">
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
        <header ref={headerRef} className={`h-12 flex justify-between items-center px-4 flex-shrink-0 z-10 sticky top-0 backdrop-blur-sm ${
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

            {encrypted && (
              <span
                className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[color:var(--notation-accent-15)] text-[color:var(--notation-accent)] text-[11px] font-semibold"
                title="Zero-knowledge encrypted space — content is decrypted only in your browser"
              >
                <Lock size={11} /> Encrypted
              </span>
            )}

            {file && (
              <div className="flex items-center text-sm text-[var(--notation-fg-muted)] min-w-0">
                <Link to="/admin" className="hover:text-[var(--notation-fg)] hover:underline truncate max-w-[100px] flex-shrink-0" title="Back to all Spaces">{spaceID}</Link>
                {pathParts.map((part, i) => {
                  const isLast = i === pathParts.length - 1
                  const label = stripMdExt(part)
                  // A folder segment jumps to the first page inside it; the last
                  // segment is the open page itself (no-op).
                  const folderPrefix = pathParts.slice(0, i + 1).join('/') + '/'
                  const firstInFolder = isLast ? null : allFiles.find(p => p.startsWith(folderPrefix))
                  return (
                    <span key={i} className="flex items-center min-w-0">
                      <span className="mx-1.5 text-[var(--notation-fg-muted)] flex-shrink-0">/</span>
                      {firstInFolder ? (
                        <button
                          onClick={() => selectFile(firstInFolder)}
                          title={label}
                          className="hover:text-[var(--notation-fg)] hover:underline cursor-pointer truncate max-w-[150px]"
                        >
                          {label}
                        </button>
                      ) : (
                        <span
                          title={label}
                          className={`${isLast ? 'text-[var(--notation-fg)] font-medium' : ''} truncate max-w-[150px]`}
                        >
                          {label}
                        </span>
                      )}
                    </span>
                  )
                })}
              </div>
            )}
          </div>

          {file && (
            <div className="flex items-center gap-1 flex-shrink-0">
              {compactHeader
                ? <HeaderOverflowMenu actions={headerActions} />
                : headerActions.map(act => <HeaderActionBtn key={act.key} action={act} />)}
              {editVisible && (
                <button onClick={() => setEditing(v => !v)} title={editing ? 'Preview' : 'Edit'} className={`ml-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${editing ? 'text-[var(--notation-fg)] bg-[var(--notation-bg-alt)] dark:text-[color:var(--notation-accent)] dark:bg-[color:var(--notation-accent-10)]' : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]'}`}>
                  {editing ? <Eye size={16} /> : <Edit3 size={16} />}
                </button>
              )}
            </div>
          )}
        </header>

        {/* Resume/abort banner for a conversion that was left in-flight (e.g. the
            tab was closed mid-convert). Detecting the marker and offering an
            abort keeps the user from getting stuck; the original mode is intact. */}
        {spaceMeta?.converting && !convertDir && (
          <div className="flex items-center justify-between gap-3 px-4 py-2 bg-[color:var(--notation-warning)]/15 border-b border-[color:var(--notation-warning)] text-sm">
            <span className="flex items-center gap-2 text-[var(--notation-fg)]">
              <Lock size={14} className="text-[var(--notation-warning)]" />
              A {spaceMeta.converting === 'to-encrypted' ? 'to-encrypted' : 'to-plaintext'} conversion was interrupted. Your original content is intact.
            </span>
            <button
              onClick={async () => {
                try {
                  const meta = await api.abortConvert(spaceID)
                  setSpaceMeta(meta)
                  if (!meta.encrypted) api.getTree(spaceID).then(setTree).catch(e => setErr(String(e)))
                } catch (e) { setErr(String(e)) }
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] text-[var(--notation-fg)] hover:bg-[var(--notation-border)] transition-colors flex-shrink-0"
            >
              <XIcon size={13} /> Abort conversion
            </button>
          </div>
        )}

        <div className="flex-1 flex overflow-hidden">
          <div ref={mainScrollRef} className="flex-1 overflow-y-auto relative no-scrollbar">
            {err && <div className="absolute top-0 left-0 right-0 p-3 bg-[var(--notation-danger)]/10 dark:bg-[var(--notation-danger)]/50 text-[var(--notation-danger)] dark:text-[var(--notation-danger)] text-sm border-b border-[var(--notation-danger)] dark:border-[var(--notation-danger)]/50 z-20 flex justify-between items-center">
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
                      setCachedFile(contentKey(spaceID, file), res.content, res.etag)
                      setContent(res.content)
                      setEtag(res.etag)
                    }).catch(e => setErr(String(e)))
                  }
                  refreshTree()
                }}
              />
            ) : file && isForm ? (
              <div className="absolute inset-0 flex flex-col animate-in fade-in duration-300">
                {formData ? (
                  <FormView
                    data={formData}
                    onSubmit={async (values) => {
                      await api.submitForm(spaceID, file, values)
                      const fresh = await api.getForm(spaceID, file)
                      setFormData(fresh)
                      refreshTree()
                    }}
                    onUpdate={async (entryID, values) => {
                      await api.updateForm(spaceID, file, entryID, values)
                      setFormData(await api.getForm(spaceID, file))
                    }}
                    onDelete={async (entryID) => {
                      await api.deleteFormEntry(spaceID, file, entryID)
                      setFormData(await api.getForm(spaceID, file))
                      refreshTree()
                    }}
                    uploadImage={(blob) => api.uploadFormImage(spaceID, file, blob)}
                    imageURL={(path) => api.fileURL(spaceID, path)}
                    onEditTemplate={() => setSearchParams({ file: `${file}/_form.md` })}
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-[var(--notation-fg-muted)] text-sm">Loading form…</div>
                )}
              </div>
            ) : file ? (
              // In edit mode the editor manages its own scroll, so the wrapper
              // must give it a definite height — otherwise Monaco's `height: 100%`
              // collapses to zero and the text is invisible. In read mode we
              // want the natural-flow content with bottom padding instead.
              <div
                className={
                  editing || !isMarkdownFile(file)
                    ? 'absolute inset-0 flex flex-col animate-in fade-in duration-300'
                    : 'pb-32 animate-in fade-in duration-300'
                }
              >
                {!editing && isMarkdownFile(file) && !content.startsWith('# ') && (
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
                      // Encrypted spaces persist through EncryptedFS; plaintext
                      // spaces keep the default api.writeFile path untouched.
                      saveFile={encrypted ? async (c) => {
                        const fs = fsRef.current
                        if (!fs) throw new Error('space is locked')
                        await fs.write(file, utf8Encode(c))
                        // Content overwrite reuses the path, so the tree-change
                        // effect won't necessarily see a structural diff — drop
                        // this path's cached text explicitly so a re-search
                        // reflects the just-saved body, never a stale one.
                        searchIndexRef.current?.invalidate(file)
                        await fs.sync()
                        return { etag: null }
                      } : undefined}
                      readFileText={encrypted ? async (p) => {
                        const fs = fsRef.current
                        if (!fs) return ''
                        return utf8Decode(await fs.read(p))
                      } : undefined}
                      onSaved={(c, newEtag) => {
                        // Keep the cache in step with the save so navigating away
                        // and back paints the just-saved text, not a stale body.
                        if (!encrypted) setCachedFile(contentKey(spaceID, file), c, newEtag)
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
                  <div className={isMarkdownFile(file) ? (content.startsWith('# ') ? 'pt-8' : 'pt-0') : 'flex-1 flex flex-col min-h-0'}>
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
                        navFiles={allFiles}
                        onNavigate={selectFile}
                        onPrefetch={warmFile}
                      />
                    ) : encrypted && rendersFromBytes(file) ? (
                      // Zero-knowledge space: the server /file endpoint 409s
                      // (ciphertext only), so decrypt through the EncryptedFS and
                      // feed the viewer a blob: object URL / raw bytes. Until the
                      // FS is built we show a brief "Decrypting…" placeholder.
                      fsReady && fsRef.current ? (
                        <EncryptedFileView fs={fsRef.current} spaceID={spaceID} path={file} theme={theme} />
                      ) : (
                        <div className="flex-1 flex items-center justify-center text-[var(--notation-fg-muted)] text-sm">
                          Decrypting…
                        </div>
                      )
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
              {/* Backlinks: plaintext hits the server search index; encrypted
                  resolves [[wiki-links]] over the decrypted corpus client-side. */}
              <BacklinksPanel
                spaceID={spaceID}
                path={file}
                onSelect={selectFile}
                compute={encrypted ? backlinksCompute : undefined}
              />
            </div>
          )}

          {showComments && file && !isForm && !encrypted && (
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
      {/* Full-text search. Plaintext spaces hit the server /search endpoint;
          encrypted spaces search the already-decrypted corpus entirely in the
          browser via the client index (the server can't read the ciphertext). */}
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
        onSearch={(q) =>
          encrypted
            ? searchIndexRef.current?.search(q) ?? Promise.resolve([])
            : api.searchSpace(spaceID, q)
        }
      />
      <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} scope="admin" />
      {readAloud && (
        <ReadAloudBar
          navFiles={allFiles}
          currentFile={file}
          content={content}
          onNavigate={selectFile}
          storageKey={`notation_readpos_${spaceID}`}
          onClose={() => setReadAloud(false)}
          // Encrypted spaces keep the on-device browser voice but never send
          // text to the server "studio" voice endpoint.
          serverVoices={encrypted ? [] : ttsVoices}
          ttsURL={ttsURL}
        />
      )}
      {!encrypted && ttsVoices && ttsVoices.length > 0 && (
        <PrepareAudioPanel
          key={prepareAudioOpen ? 'audio-open' : 'audio-closed'}
          open={prepareAudioOpen}
          spaceID={spaceID}
          tree={tree}
          voices={ttsVoices}
          onClose={() => setPrepareAudioOpen(false)}
        />
      )}
    </div>
  )
}

// Depth-first lookup of the tree entry at a given path (form folders are in the
// tree with their children omitted, so this still finds them).
function findTreeEntry(entries: api.Entry[], path: string): api.Entry | null {
  if (!path) return null
  for (const e of entries) {
    if (e.path === path) return e
    if (e.is_dir && e.children) {
      const hit = findTreeEntry(e.children, path)
      if (hit) return hit
    }
  }
  return null
}
