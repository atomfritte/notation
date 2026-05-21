import { useEffect, useState } from 'react'
import * as api from '../lib/api'

type Props = {
  spaceID: string
  path: string
  initial: string
  onSaved: (content: string) => void
}

/**
 * Stage 4 editor: minimal textarea + Save button. Stage 6 swaps this for a
 * CodeMirror-based editor with syntax highlighting and live preview.
 */
export function Editor({ spaceID, path, initial, onSaved }: Props) {
  const [content, setContent] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dirty = content !== initial

  useEffect(() => setContent(initial), [initial, path])

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      await api.writeFile(spaceID, path, content)
      onSaved(content)
    } catch (e) {
      setErr(String(e))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirty && !saving) void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="flex-1 flex flex-col">
      <div className="px-3 py-2 border-b flex gap-3 items-center text-sm">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="px-3 py-1 bg-blue-600 text-white rounded disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {dirty && <span className="text-orange-600">unsaved changes</span>}
        {err && <span className="text-red-600">{err}</span>}
        <span className="ml-auto text-gray-400 text-xs">⌘/Ctrl + S</span>
      </div>
      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        spellCheck={false}
        className="flex-1 p-4 font-mono text-sm resize-none outline-none w-full"
      />
    </div>
  )
}
