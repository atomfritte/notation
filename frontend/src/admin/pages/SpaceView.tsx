import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import * as api from '../lib/api'
import { FileTree } from '../components/FileTree'
import { MarkdownView } from '../components/MarkdownView'
import { Editor } from '../components/Editor'
import { SharePanel } from '../components/SharePanel'
import { MCPPanel } from '../components/MCPPanel'

export function SpaceView() {
  const { spaceID = '' } = useParams<{ spaceID: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const file = searchParams.get('file') ?? ''
  const [tree, setTree] = useState<api.Entry[]>([])
  const [content, setContent] = useState<string>('')
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [sidebar, setSidebar] = useState<'files' | 'shares' | 'mcp'>('files')

  const refreshTree = useCallback(() => {
    if (!spaceID) return
    api.getTree(spaceID).then(setTree).catch(e => setErr(String(e)))
  }, [spaceID])

  useEffect(refreshTree, [refreshTree])

  useEffect(() => {
    if (!spaceID || !file) {
      setContent('')
      return
    }
    api.readFile(spaceID, file).then(setContent).catch(e => setErr(String(e)))
    setEditing(false)
  }, [spaceID, file])

  const selectFile = useCallback(
    (p: string) => {
      setSearchParams({ file: p })
    },
    [setSearchParams],
  )

  async function onNewFile() {
    const path = window.prompt('New file path (e.g. notes/today.md):')?.trim()
    if (!path) return
    try {
      await api.writeFile(spaceID, path, '# ' + path.split('/').pop()?.replace(/\.md$/i, '') + '\n')
      refreshTree()
      setSearchParams({ file: path })
    } catch (e) {
      setErr(String(e))
    } finally {
      setCreating(false)
    }
  }

  if (!spaceID) return <p className="p-8">missing space id</p>

  return (
    <div className="flex h-full">
      <aside className="w-72 border-r overflow-y-auto p-3 flex-shrink-0 bg-gray-50">
        <Link to="/" className="text-xs text-gray-500 hover:underline">
          ← spaces
        </Link>
        <h1 className="text-lg font-bold mt-2 mb-3 truncate">{spaceID}</h1>
        <div className="flex gap-1 mb-3 text-xs">
          <button
            onClick={() => setSidebar('files')}
            className={
              'px-2 py-1 rounded ' +
              (sidebar === 'files' ? 'bg-blue-600 text-white' : 'bg-white border')
            }
          >
            files
          </button>
          <button
            onClick={() => setSidebar('shares')}
            className={
              'px-2 py-1 rounded ' +
              (sidebar === 'shares' ? 'bg-blue-600 text-white' : 'bg-white border')
            }
          >
            shares
          </button>
          <button
            onClick={() => setSidebar('mcp')}
            className={
              'px-2 py-1 rounded ' +
              (sidebar === 'mcp' ? 'bg-blue-600 text-white' : 'bg-white border')
            }
          >
            mcp
          </button>
          {sidebar === 'files' && (
            <button
              onClick={onNewFile}
              disabled={creating}
              className="ml-auto px-2 py-1 bg-green-600 text-white rounded"
            >
              + file
            </button>
          )}
        </div>
        {sidebar === 'files' && (
          <FileTree entries={tree} current={file} onSelect={selectFile} />
        )}
        {sidebar === 'shares' && <SharePanel spaceID={spaceID} />}
        {sidebar === 'mcp' && <MCPPanel spaceID={spaceID} />}
      </aside>
      <main className="flex-1 flex flex-col min-w-0">
        {file ? (
          <>
            <div className="px-3 py-2 border-b flex justify-between items-center text-sm flex-shrink-0">
              <span className="text-gray-600 truncate">{file}</span>
              <button
                onClick={() => setEditing(v => !v)}
                className="px-2 py-1 text-blue-600 hover:underline"
              >
                {editing ? 'Preview' : 'Edit'}
              </button>
            </div>
            {editing ? (
              <Editor
                spaceID={spaceID}
                path={file}
                initial={content}
                onSaved={c => {
                  setContent(c)
                  setEditing(false)
                  refreshTree()
                }}
              />
            ) : (
              <MarkdownView content={content} />
            )}
          </>
        ) : (
          <div className="p-8 text-gray-500">Select a file from the tree, or create a new one.</div>
        )}
        {err && <div className="p-2 text-red-600 text-sm border-t">{err}</div>}
      </main>
    </div>
  )
}
