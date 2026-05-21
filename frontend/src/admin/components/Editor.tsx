import { useEffect, useState, useRef } from 'react'
import { Save } from 'lucide-react'
import * as api from '../lib/api'

type Props = {
  spaceID: string
  path: string
  initial: string
  etag: string | null
  onSaved: (content: string, etag: string | null) => void
}

export function Editor({ spaceID, path, initial, etag, onSaved }: Props) {
  const [content, setContent] = useState(initial)
  const [currentEtag, setCurrentEtag] = useState(etag)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dirty = content !== initial

  useEffect(() => {
    setContent(initial)
    setCurrentEtag(etag)
  }, [initial, path, etag])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
    }
  }, [content])

  async function save() {
    if (!dirty) return
    setSaving(true)
    setErr(null)
    try {
      await api.writeFile(spaceID, path, content, currentEtag)
      // Optimistically update, but ideally we'd fetch the new ETag.
      // For now, setting it to null ensures the next save might pass or fail based on backend state.
      setCurrentEtag(null)
      onSaved(content, null)
    } catch (e: any) {
      if (String(e).includes('412')) {
        setErr('Conflict: Someone else modified this file. Please copy your changes and refresh.')
      } else {
        setErr(String(e))
      }
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
    <div className="relative min-h-full pb-20">
      {/* Seamless Notion-like editor area */}
      <div className="max-w-3xl mx-auto p-8">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={e => setContent(e.target.value)}
          spellCheck={false}
          placeholder="Start typing..."
          className="w-full bg-transparent font-mono text-zinc-300 resize-none outline-none overflow-hidden leading-relaxed"
          style={{ minHeight: '300px' }}
        />
      </div>

      {/* Floating Save Actions */}
      <div className="fixed bottom-6 right-6 flex flex-col items-end gap-2 z-50">
        {err && <div className="bg-red-950/90 text-red-200 px-3 py-1.5 rounded-md text-xs border border-red-900/50 backdrop-blur-sm shadow-xl">{err}</div>}
        <div className={`transition-all duration-300 flex items-center gap-3 ${dirty ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
          <span className="text-zinc-500 text-xs bg-zinc-900/80 px-2 py-1 rounded-md backdrop-blur-md">⌘/Ctrl + S</span>
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="flex items-center gap-2 px-4 py-2 bg-[#BFF355] text-zinc-950 hover:bg-[#a6d944] font-semibold text-sm rounded-full shadow-lg transition-colors disabled:opacity-50"
          >
            <Save size={16} />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
