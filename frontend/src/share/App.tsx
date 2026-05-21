import { useCallback, useEffect, useState } from 'react'
import { BrowserRouter, Route, Routes, useSearchParams } from 'react-router-dom'
import * as api from './lib/api'
import { FileTree } from '../admin/components/FileTree'
import { MarkdownView } from '../admin/components/MarkdownView'
import { CommentThread } from '../admin/components/CommentThread'

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
    api.readFile(file)
      .then(c => {
        setContent(c)
        setEditBuffer(c)
      })
      .catch(e => setErr(String(e)))
    refreshComments()
  }, [file, refreshComments])

  const select = useCallback((p: string) => setSearchParams({ file: p }), [setSearchParams])

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

  async function addComment(text: string) {
    if (!file) return
    await api.postComment(file, text)
    refreshComments()
  }

  if (err && !info) {
    return (
      <div className="p-8 max-w-xl mx-auto">
        <h1 className="text-xl font-bold mb-2">Share unavailable</h1>
        <p className="text-red-600">{err}</p>
      </div>
    )
  }
  if (!info) return <div className="p-8 text-gray-500">loading…</div>

  const canEdit = info.permission === 'edit'
  const canComment = info.permission === 'comment' || info.permission === 'edit'

  return (
    <div className="flex h-full">
      <aside className="w-72 border-r overflow-y-auto p-3 bg-gray-50 flex-shrink-0">
        <h1 className="text-lg font-bold mb-1 truncate">{info.space.name}</h1>
        <p className="text-xs text-gray-500 mb-3">
          {info.permission} share{info.label ? ` · ${info.label}` : ''}
        </p>
        <FileTree entries={tree} current={file} onSelect={select} />
      </aside>
      <main className="flex-1 flex flex-col min-w-0">
        {file ? (
          <>
            <div className="px-3 py-2 border-b text-sm flex justify-between items-center flex-shrink-0">
              <span className="text-gray-600 truncate">{file}</span>
              {canEdit && (
                <button
                  onClick={() => setEditing(v => !v)}
                  className="text-blue-600 hover:underline"
                >
                  {editing ? 'Preview' : 'Edit'}
                </button>
              )}
            </div>
            {editing ? (
              <div className="flex-1 flex flex-col">
                <div className="px-3 py-2 border-b flex gap-3 items-center text-sm">
                  <button
                    onClick={save}
                    disabled={saving || editBuffer === content}
                    className="px-3 py-1 bg-blue-600 text-white rounded disabled:opacity-40"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  {editBuffer !== content && (
                    <span className="text-orange-600">unsaved changes</span>
                  )}
                </div>
                <textarea
                  value={editBuffer}
                  onChange={e => setEditBuffer(e.target.value)}
                  spellCheck={false}
                  className="flex-1 p-4 font-mono text-sm resize-none outline-none w-full"
                />
              </div>
            ) : (
              <MarkdownView content={content} />
            )}
            {!editing && (
              <CommentThread
                comments={comments}
                canAdd={canComment}
                onAdd={canComment ? addComment : undefined}
              />
            )}
          </>
        ) : (
          <div className="p-8 text-gray-500">Select a file from the tree.</div>
        )}
        {err && info && (
          <div className="p-2 text-red-600 text-sm border-t">{err}</div>
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
          element={<div className="p-8 text-red-600">Invalid share URL.</div>}
        />
      </Routes>
    </BrowserRouter>
  )
}
