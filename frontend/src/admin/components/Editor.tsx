import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import * as api from '../lib/api'

type Props = {
  spaceID: string
  path: string
  initial: string
  etag: string | null
  onSaved: (content: string, etag: string | null) => void
}

const customTheme = EditorView.theme({
  "&": {
    color: "#d4d4d8", // zinc-300
    backgroundColor: "transparent",
    fontSize: "15px",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  ".cm-content": {
    padding: "0",
    minHeight: "300px",
  },
  ".cm-content *": {
    lineHeight: "1.7",
  },
  "&.cm-focused": {
    outline: "none",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "#BFF355",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(191, 243, 85, 0.2)",
  },
  ".cm-gutters": {
    display: "none", // Notion-like seamless experience
  },
  // Style markdown headers to stand out slightly even in edit mode
  ".cm-header": {
    fontWeight: "bold",
    color: "#f4f4f5", // zinc-100
  },
  ".cm-header-1": { fontSize: "2em", marginTop: "1em", marginBottom: "0.5em" },
  ".cm-header-2": { fontSize: "1.5em", marginTop: "0.8em", marginBottom: "0.4em" },
  ".cm-header-3": { fontSize: "1.25em" },
  // Style links
  ".cm-link": {
    color: "#BFF355",
    textDecoration: "underline",
    textDecorationStyle: "dashed",
  },
})

export function Editor({ spaceID, path, initial, etag, onSaved }: Props) {
  const [content, setContent] = useState(initial)
  const [currentEtag, setCurrentEtag] = useState(etag)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dirty = content !== initial

  useEffect(() => {
    setContent(initial)
    setCurrentEtag(etag)
  }, [initial, path, etag])

  async function save() {
    if (!dirty) return
    setSaving(true)
    setErr(null)
    try {
      await api.writeFile(spaceID, path, content, currentEtag)
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

  // Keyboard shortcut for saving is built into the parent or we can listen globally here.
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
      <div className="max-w-3xl mx-auto p-8">
        <CodeMirror
          value={content}
          onChange={(val) => setContent(val)}
          theme={customTheme}
          extensions={[
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            EditorView.lineWrapping
          ]}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            dropCursor: false,
            allowMultipleSelections: false,
            indentOnInput: false,
          }}
          className="w-full h-full"
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
            className="flex items-center gap-2 px-4 py-2 bg-[#BFF355] text-zinc-950 hover:bg-[#a6d944] font-semibold text-sm rounded-full shadow-lg transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Save size={16} />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
