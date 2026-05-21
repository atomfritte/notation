import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { keymap } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import * as api from '../lib/api'

type Props = {
  spaceID: string
  path: string
  initial: string
  etag: string | null
  theme: 'light' | 'dark'
  onSaved: (content: string, etag: string | null) => void
}

// Custom Markdown Bold/Italic shortcuts
const toggleFormat = (mark: string) => (view: EditorView) => {
  const { state } = view;
  const tr = state.changeByRange(range => {
    const len = mark.length;
    const isMarked = range.from >= len && range.to <= state.doc.length - len &&
                     state.sliceDoc(range.from - len, range.from) === mark &&
                     state.sliceDoc(range.to, range.to + len) === mark;
    if (isMarked) {
      return {
        changes: [
          { from: range.from - len, to: range.from, insert: "" },
          { from: range.to, to: range.to + len, insert: "" }
        ],
        range: EditorSelection.range(range.from - len, range.to - len)
      }
    } else {
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark }
        ],
        range: EditorSelection.range(range.from + len, range.to + len)
      }
    }
  });
  view.dispatch(tr);
  return true;
};

const markdownKeybindings = keymap.of([
  { key: "Enter", run: insertNewlineContinueMarkup },
  { key: "Mod-b", run: toggleFormat("**") },
  { key: "Mod-i", run: toggleFormat("*") }
]);

const customTheme = EditorView.theme({
  "&": {
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
    borderLeftColor: "#BFF355", // Accent cursor
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(191, 243, 85, 0.2)",
  },
  ".cm-gutters": {
    display: "none", // Hide line numbers for Notion-like feel
  },
  ".cm-header": {
    fontWeight: "bold",
  },
  ".cm-header-1": { fontSize: "2.2em", marginTop: "1em", marginBottom: "0.5em" },
  ".cm-header-2": { fontSize: "1.8em", marginTop: "0.8em", marginBottom: "0.4em" },
  ".cm-header-3": { fontSize: "1.4em", marginTop: "0.6em", marginBottom: "0.3em" },
})

export function Editor({ spaceID, path, initial, etag, theme, onSaved }: Props) {
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
          theme={theme}
          extensions={[
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            EditorView.lineWrapping,
            markdownKeybindings,
            customTheme
          ]}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            dropCursor: true,
            allowMultipleSelections: true,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            history: true,
            searchKeymap: true,
          }}
          className="w-full h-full"
        />
      </div>

      {/* Floating Save Actions */}
      <div className="fixed bottom-6 right-6 flex flex-col items-end gap-2 z-50">
        {err && <div className="bg-red-50 dark:bg-red-950/90 text-red-600 dark:text-red-200 px-3 py-1.5 rounded-md text-xs border border-red-200 dark:border-red-900/50 backdrop-blur-sm shadow-xl">{err}</div>}
        <div className={`transition-all duration-300 flex items-center gap-3 ${dirty ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
          <span className="text-zinc-500 text-xs bg-white/80 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 px-2 py-1 rounded-md backdrop-blur-md shadow-sm">⌘/Ctrl + S</span>
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white dark:bg-[#BFF355] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-[#a6d944] font-semibold text-sm rounded-full shadow-lg transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Save size={16} />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
