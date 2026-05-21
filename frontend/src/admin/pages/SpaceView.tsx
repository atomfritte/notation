import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Folder, Settings, Bookmark, Plus, MessageSquare, Edit3, Eye, FileText, PanelLeft, Share2, MoreHorizontal } from 'lucide-react'
import * as api from '../lib/api'
import { FileTree } from '../components/FileTree'
import { MarkdownView } from '../components/MarkdownView'
import { Editor } from '../components/Editor'
import { SharePanel } from '../components/SharePanel'
import { MCPPanel } from '../components/MCPPanel'
import { CommentThread } from '../components/CommentThread'

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
  const [sidebarTab, setSidebarTab] = useState<'files' | 'bookmarks' | 'shares' | 'mcp'>('files')
  
  const [comments, setComments] = useState<api.CommentItem[]>([])
  const [showComments, setShowComments] = useState(false)
  
  const [bookmarks, setBookmarks] = useState<string[]>([])

  useEffect(() => {
    if (!spaceID) return
    try {
      const stored = localStorage.getItem(`notation_bookmarks_${spaceID}`)
      if (stored) setBookmarks(JSON.parse(stored))
    } catch { /* ignore */ }
  }, [spaceID])

  const toggleBookmark = useCallback((path: string) => {
    setBookmarks(prev => {
      const next = prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
      localStorage.setItem(`notation_bookmarks_${spaceID}`, JSON.stringify(next))
      return next
    })
  }, [spaceID])

  const refreshTree = useCallback(() => {
    if (!spaceID) return
    api.getTree(spaceID).then(setTree).catch(e => setErr(String(e)))
  }, [spaceID])

  useEffect(refreshTree, [refreshTree])

  const refreshComments = useCallback(() => {
    if (!spaceID || !file) {
      setComments([])
      return
    }
    api.getComments(spaceID, file).then(setComments).catch(console.error)
  }, [spaceID, file])

  useEffect(() => {
    if (!spaceID || !file) {
      setContent('')
      setEtag(null)
      return
    }
    api.readFile(spaceID, file)
      .then(res => {
        setContent(res.content)
        setEtag(res.etag)
      })
      .catch(e => setErr(String(e)))
    setEditing(false)
    refreshComments()
  }, [spaceID, file, refreshComments])

  const selectFile = useCallback(
    (p: string) => {
      setSearchParams({ file: p })
    },
    [setSearchParams],
  )

  async function onNewFile() {
    const path = window.prompt('New page path (e.g. notes/meeting):')?.trim()
    if (!path) return
    
    // Normalize path to markdown
    const mdPath = path.toLowerCase().endsWith('.md') ? path : path + '.md'
    const title = mdPath.split('/').pop()?.replace(/\.md$/i, '')
    
    try {
      await api.writeFile(spaceID, mdPath, `# ${title}\n\n`)
      refreshTree()
      setSearchParams({ file: mdPath })
      setEditing(true)
    } catch (e) {
      setErr(String(e))
    }
  }

  // Global Keyboard Shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Toggle Sidebar (Cmd/Ctrl + \)
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        setSidebarOpen(prev => !prev)
      }
      // New File (Alt + N)
      if (e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        onNewFile()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setSidebarOpen])

  async function handleAddComment(text: string) {
    if (!spaceID || !file) return
    await api.postComment(spaceID, file, text)
    refreshComments()
  }

  if (!spaceID) return <p className="p-8 text-zinc-400">missing workspace</p>

  const isBookmarked = bookmarks.includes(file)

  // Clean filename for the huge title display in Preview Mode if it doesn't already have an h1
  const displayTitle = file.split('/').pop()?.replace(/\.md$/i, '') || ''
  
  // Breadcrumb structure
  const pathParts = file ? file.split('/') : []

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-zinc-300 font-sans overflow-hidden selection:bg-[#BFF355]/30">
      
      {/* NOTION-LIKE SIDEBAR */}
      <aside className={`flex-shrink-0 flex flex-col bg-[#111111] transition-all duration-300 ease-in-out border-r border-zinc-800/50 relative ${sidebarOpen ? 'w-64' : 'w-0 border-r-0'}`}>
        <div className="w-64 h-full flex flex-col absolute top-0 left-0">
          
          {/* Workspace Switcher / Header */}
          <div className="h-12 flex items-center px-4 hover:bg-zinc-800/50 cursor-pointer transition-colors mt-2 mx-2 rounded-md">
            <div className="flex items-center gap-2 text-zinc-200 font-medium w-full">
              <div className="w-5 h-5 rounded bg-[#BFF355]/20 text-[#BFF355] flex items-center justify-center font-bold text-xs uppercase">
                 {spaceID.charAt(0)}
              </div>
              <span className="truncate">{spaceID}</span>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="px-3 mt-4 space-y-0.5">
            <button onClick={() => setSidebarTab('bookmarks')} className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${sidebarTab === 'bookmarks' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300'}`}>
              <Bookmark size={16} /> Bookmarks
            </button>
            <button onClick={() => setSidebarTab('files')} className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${sidebarTab === 'files' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300'}`}>
              <Folder size={16} /> Pages
            </button>
            <button onClick={() => setSidebarTab('shares')} className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${sidebarTab === 'shares' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300'}`}>
              <Share2 size={16} /> Sharing
            </button>
            <button onClick={() => setSidebarTab('mcp')} className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${sidebarTab === 'mcp' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300'}`}>
              <Settings size={16} /> Integration
            </button>
          </div>

          <div className="px-5 mt-6 mb-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            {sidebarTab === 'files' && 'Workspace'}
            {sidebarTab === 'bookmarks' && 'Favorites'}
            {sidebarTab === 'shares' && 'Active Shares'}
            {sidebarTab === 'mcp' && 'Settings'}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto px-2 pb-4 no-scrollbar">
            {sidebarTab === 'files' && (
              <FileTree entries={tree} current={file} onSelect={selectFile} />
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
                      className={`flex items-center gap-2 w-full text-left py-1.5 px-2 rounded-md transition-colors ${file === b ? 'bg-zinc-800 text-zinc-100 font-medium' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'}`}
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
          </div>

          {/* Bottom Action */}
          <div className="p-2 border-t border-zinc-800/50">
             <button
                onClick={onNewFile}
                className="w-full flex items-center gap-2 px-3 py-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 rounded-md transition-colors text-sm font-medium"
              >
                <Plus size={16} /> New Page
              </button>
          </div>
        </div>
      </aside>

      {/* Main Document Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-[#0a0a0a] relative">
        
        {/* TOP BAR (Notion-style Breadcrumbs & Actions) */}
        <header className="h-12 flex justify-between items-center px-4 flex-shrink-0 z-10 sticky top-0 bg-[#0a0a0a]/80 backdrop-blur-sm">
          <div className="flex items-center gap-2 overflow-hidden">
            {!sidebarOpen && (
              <button onClick={() => setSidebarOpen(true)} className="p-1.5 mr-1 text-zinc-400 hover:bg-zinc-800 rounded-md transition-colors" title="Open Sidebar (Cmd/Ctrl + \)">
                <PanelLeft size={18} />
              </button>
            )}
            {sidebarOpen && (
              <button onClick={() => setSidebarOpen(false)} className="p-1.5 mr-1 text-zinc-500 hover:bg-zinc-800 rounded-md transition-colors opacity-0 hover:opacity-100 absolute left-2 top-2 z-50 group-hover:opacity-100" title="Close Sidebar">
                <PanelLeft size={18} />
              </button>
            )}

            {/* Breadcrumbs */}
            {file && (
              <div className="flex items-center text-sm text-zinc-400">
                <span className="hover:text-zinc-200 hover:underline cursor-pointer truncate max-w-[100px]">{spaceID}</span>
                {pathParts.map((part, i) => (
                  <span key={i} className="flex items-center">
                    <span className="mx-1.5 text-zinc-600">/</span>
                    <span className={`${i === pathParts.length - 1 ? 'text-zinc-200 font-medium' : 'hover:text-zinc-200 hover:underline cursor-pointer'} truncate max-w-[150px]`}>
                      {part.replace(/\.md$/i, '')}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Right Actions */}
          {file && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setEditing(v => !v)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${editing ? 'text-[#BFF355] bg-[#BFF355]/10' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`}
              >
                {editing ? <Eye size={16} /> : <Edit3 size={16} />}
              </button>
              <button
                onClick={() => toggleBookmark(file)}
                className={`p-1.5 rounded-md transition-colors ${isBookmarked ? 'text-[#BFF355]' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`}
                title="Favorite"
              >
                <Bookmark size={18} fill={isBookmarked ? 'currentColor' : 'none'} />
              </button>
              <button
                onClick={() => setShowComments(!showComments)}
                className={`p-1.5 rounded-md transition-colors flex items-center gap-1 ${showComments ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`}
                title="Comments"
              >
                <MessageSquare size={18} />
                {comments.length > 0 && <span className="text-xs font-bold text-[#BFF355]">{comments.length}</span>}
              </button>
              <button className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-colors">
                <MoreHorizontal size={18} />
              </button>
            </div>
          )}
        </header>

        {/* Content & Comments Split */}
        <div className="flex-1 flex overflow-hidden">
          
          <div className="flex-1 overflow-y-auto relative no-scrollbar">
            {err && <div className="absolute top-0 left-0 right-0 p-3 bg-red-900/50 text-red-200 text-sm border-b border-red-900/50 z-20 flex justify-between items-center">
               {err}
               <button onClick={() => setErr(null)} className="text-red-400 hover:text-red-200">&times;</button>
            </div>}
            
            {file ? (
              <div className="pb-32 animate-in fade-in duration-300">
                {/* Visual Document Header (Only in preview if it lacks H1, or always just as a visual cue) */}
                {!editing && !content.startsWith('# ') && (
                   <div className="max-w-3xl mx-auto px-8 pt-12 pb-4">
                      <h1 className="text-4xl font-bold text-zinc-100 tracking-tight">{displayTitle}</h1>
                   </div>
                )}
                
                {editing ? (
                  <Editor
                    spaceID={spaceID}
                    path={file}
                    initial={content}
                    etag={etag}
                    onSaved={(c, newEtag) => {
                      setContent(c)
                      setEtag(newEtag)
                      refreshTree()
                      // Optional: switch back to preview after save?
                      // setEditing(false) 
                    }}
                  />
                ) : (
                  <div className={content.startsWith('# ') ? 'pt-8' : 'pt-0'}>
                    <MarkdownView content={content} />
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-zinc-500 p-8">
                <FileText size={48} className="mb-4 opacity-10" />
                <p className="text-lg">Select a page to start writing</p>
                <button onClick={onNewFile} className="mt-4 px-4 py-2 bg-[#BFF355]/10 text-[#BFF355] hover:bg-[#BFF355]/20 font-medium rounded-md transition-colors">
                  Create Page
                </button>
              </div>
            )}
          </div>

          {/* Right Sidebar Comments */}
          {showComments && file && (
            <div className="w-[320px] border-l border-zinc-800 bg-[#0a0a0a] flex flex-col flex-shrink-0 animate-in slide-in-from-right-8 duration-200 shadow-xl">
              <div className="p-3 border-b border-zinc-800 flex justify-between items-center bg-zinc-950">
                 <h3 className="font-semibold text-sm text-zinc-200 flex items-center gap-2">
                    <MessageSquare size={16} /> 
                    Updates
                 </h3>
                 <button onClick={() => setShowComments(false)} className="text-zinc-500 hover:text-zinc-300">&times;</button>
              </div>
              <div className="flex-1 overflow-y-auto bg-zinc-950/50">
                 <CommentThread comments={comments} canAdd={true} onAdd={handleAddComment} />
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
