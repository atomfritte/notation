import { useCallback, useEffect, useState } from 'react'
import { BrowserRouter, Route, Routes, useSearchParams } from 'react-router-dom'
import { PanelLeft } from 'lucide-react'
import * as api from './lib/api'
import { FileTree } from '../admin/components/FileTree'
import { FileViewer } from '../admin/components/FileViewer'
import { MarkdownView } from '../admin/components/MarkdownView'
import { CommentThread } from '../admin/components/CommentThread'
import { isTextFile, isMarkdownFile } from '../admin/lib/fileTypes'

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
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  // Mobile drawer state Ã¢â‚¬â€ same pattern as admin SpaceView.
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
    typeof window === 'undefined'
      ? true
      : !window.matchMedia('(max-width: 767px)').matches,
  )

  // Coordinate hover/click between the viewer's anchor marks and the
  // CommentThread rows. Same pattern as the admin SpaceView.
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)
  const [pendingAnchor, setPendingAnchor] = useState<api.CommentAnchor | null>(null)
  const [pendingComment, setPendingComment] = useState<string>('')

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

  const refreshComments = useCallback(() => {
    if (!file) {
      setComments([])
      return
    }
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
      api.readFile(file)
        .then(c => {
          setContent(c)
          setEditBuffer(c)
        })
        .catch(e => setErr(String(e)))
    } else {
      setContent('')
      setEditBuffer('')
    }
    refreshComments()
  }, [file, refreshComments])

  // Scroll the comments column to whichever entry is active. Small timeout
  // so the panel has finished mounting/animating before we measure.
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

  function onNewAnchorComment(anchor: api.CommentAnchor) {
    setPendingAnchor(anchor)
    // Don't pre-fill the textarea ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â CommentRow renders the anchor quote.
  }

  if (err && !info) {
    return (
      <div className="p-8 max-w-xl mx-auto">
        <h1 className="text-xl font-bold mb-2 text-zinc-900 dark:text-zinc-100">Share unavailable</h1>
        <p className="text-red-600 dark:text-red-400">{err}</p>
      </div>
    )
  }
  if (!info) return <div className="p-8 text-zinc-500">loadingÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦</div>

  const canEdit = info.permission === 'edit'
  const canComment = info.permission === 'comment' || info.permission === 'edit'

  return (
    <div className="flex h-screen bg-[var(--notation-bg)] text-zinc-900 dark:text-zinc-300 overflow-hidden selection:bg-[color:var(--notation-accent-30)]">
      {/* Mobile backdrop: tap to close the drawer. */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
        />
      )}
      <aside
        className={
          'flex flex-col bg-[var(--notation-bg-elevated)] border-r border-zinc-200 dark:border-zinc-800/50 ' +
          'fixed inset-y-0 left-0 z-40 w-72 ' +
          'md:static md:z-auto md:w-64 md:flex-shrink-0 ' +
          'transition-transform md:transition-none duration-200 ease-in-out ' +
          (sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0')
        }
      >
        <div className="p-4 border-b border-zinc-200 dark:border-zinc-800/50">
          <div className="flex items-center gap-2 text-zinc-800 dark:text-zinc-200 font-medium">
            <div className="w-5 h-5 rounded bg-zinc-900 text-white dark:bg-[color:var(--notation-accent-20)] dark:text-[color:var(--notation-accent)] flex items-center justify-center font-bold text-xs uppercase">
              {info.space.id.charAt(0)}
            </div>
            <span className="truncate">{info.space.name}</span>
          </div>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-2 flex items-center gap-1.5">
            <span
              className={
                'px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ' +
                (info.permission === 'edit'
                  ? 'bg-[color:var(--notation-accent-20)] text-zinc-900 dark:text-[color:var(--notation-accent)]'
                  : info.permission === 'comment'
                  ? 'bg-amber-200/40 text-amber-900 dark:bg-amber-500/10 dark:text-amber-300'
                  : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400')
              }
            >
              {info.permission}
            </span>
            {info.label && <span className="truncate">{info.label}</span>}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <FileTree
            entries={tree}
            current={file}
            onSelect={select}
            collapseStorageKey={`notation_share_tree_collapsed_${info.space.id}`}
          />
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        {file ? (
          <>
            <header className="h-12 flex justify-between items-center px-4 border-b border-zinc-200 dark:border-zinc-800/50 flex-shrink-0 text-sm gap-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button
                  onClick={() => setSidebarOpen(v => !v)}
                  className="md:hidden p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 flex-shrink-0"
                  aria-label="Toggle sidebar"
                >
                  <PanelLeft size={18} />
                </button>
                <span className="text-zinc-500 dark:text-zinc-400 truncate">{file.replace(/\.md$/i, '')}</span>
              </div>
              {canEdit && isTextFile(file) && (
                <button
                  onClick={() => setEditing(v => !v)}
                  className={
                    'px-3 py-1 rounded-md transition-colors text-sm font-medium ' +
                    (editing
                      ? 'bg-zinc-100 text-zinc-900 dark:bg-[color:var(--notation-accent-10)] dark:text-[color:var(--notation-accent)]'
                      : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800')
                  }
                >
                  {editing ? 'Preview' : 'Edit'}
                </button>
              )}
            </header>
            {editing ? (
              <div className="flex-1 flex flex-col">
                <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800/50 flex gap-3 items-center text-sm">
                  <button
                    onClick={save}
                    disabled={saving || editBuffer === content}
                    className="px-3 py-1 bg-zinc-900 text-white dark:bg-[color:var(--notation-accent)] dark:text-zinc-950 rounded-md disabled:opacity-40 font-medium"
                  >
                    {saving ? 'SavingÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦' : 'Save'}
                  </button>
                  {editBuffer !== content && (
                    <span className="text-amber-600 dark:text-amber-400 text-xs">unsaved changes</span>
                  )}
                </div>
                <textarea
                  value={editBuffer}
                  onChange={e => setEditBuffer(e.target.value)}
                  spellCheck={false}
                  className="flex-1 p-6 font-mono text-sm resize-none outline-none w-full bg-[var(--notation-bg)] text-zinc-800 dark:text-zinc-200"
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
            {!editing && canComment && isMarkdownFile(file) && (
              <div
                id="share-comments-panel"
                className="border-t border-zinc-200 dark:border-zinc-800/50 bg-zinc-50 dark:bg-zinc-950/50 max-h-80 overflow-y-auto"
              >
                {pendingAnchor && (
                  <div className="px-4 pt-3 text-xs">
                    <div className="text-amber-700 dark:text-amber-300 font-semibold mb-1">Anchoring to selection</div>
                    <div className="italic text-zinc-600 dark:text-zinc-400 line-clamp-2">ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“{pendingAnchor.quote}ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â</div>
                    <button
                      onClick={() => { setPendingAnchor(null); setPendingComment('') }}
                      className="mt-1 text-amber-700 dark:text-amber-300 hover:underline"
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
              <div className="p-2 text-red-600 dark:text-red-400 text-sm border-t border-red-200 dark:border-red-900/50">{err}</div>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 gap-4 p-8 text-center">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden flex items-center gap-2 px-3 py-2 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-sm"
            >
              <PanelLeft size={16} /> Open file list
            </button>
            <span>Select a file from the tree.</span>
          </div>
        )}
      </main>
    </div>
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
          element={<div className="p-8 text-red-600 dark:text-red-400">Invalid share URL.</div>}
        />
      </Routes>
    </BrowserRouter>
  )
}
