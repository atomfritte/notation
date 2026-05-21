import { useEffect, useState, useRef } from 'react'
import { Save } from 'lucide-react'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { keymap } from '@codemirror/view'
import { EditorSelection, StateField } from '@codemirror/state'
import { autocompletion, CompletionContext } from '@codemirror/autocomplete'
import { Tooltip, showTooltip } from '@codemirror/view'
import * as api from '../lib/api'

const selectionTooltip = StateField.define<readonly Tooltip[]>({
  create: getTooltip,
  update(tooltips, tr) {
    if (!tr.docChanged && !tr.selection) return tooltips
    return getTooltip(tr.state)
  },
  provide: f => showTooltip.computeN([f], state => state.field(f))
})

function getTooltip(state: any): readonly Tooltip[] {
  const ranges = state.selection.ranges
  if (ranges.length === 0) return []
  const range = ranges[0]
  if (range.empty) return []
  
  const text = state.sliceDoc(range.from, range.to)
  
  return [{
    pos: range.from,
    above: true,
    strictSide: true,
    arrow: true,
    create: (view: EditorView) => {
      const dom = document.createElement("div")
      dom.className = "flex items-center gap-1 bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 rounded-md shadow-xl px-1 py-1 text-xs font-medium"
      
      const btnMark = document.createElement("button")
      btnMark.textContent = "Highlight"
      btnMark.className = "px-2 py-1 hover:bg-zinc-700 dark:hover:bg-zinc-300 rounded cursor-pointer transition-colors"
      btnMark.onclick = () => {
        toggleHTMLTag("mark")(view)
      }
      
      const btnComment = document.createElement("button")
      btnComment.textContent = "Comment"
      btnComment.className = "px-2 py-1 hover:bg-zinc-700 dark:hover:bg-zinc-300 rounded cursor-pointer transition-colors text-[#BFF355] dark:text-lime-700"
      btnComment.onclick = () => {
        toggleHTMLTag("mark")(view)
        view.dom.dispatchEvent(new CustomEvent('editor-comment-request', { detail: text, bubbles: true }))
      }
      
      dom.appendChild(btnMark)
      dom.appendChild(btnComment)
      return { dom }
    }
  }]
}

type Props = {
  spaceID: string
  path: string
  initial: string
  etag: string | null
  theme: 'light' | 'dark'
  allFiles: string[]
  onSaved: (content: string, etag: string | null) => void
  onCommentRequest?: (text: string) => void
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

const toggleHTMLTag = (tag: string) => (view: EditorView) => {
  const { state } = view;
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  const tr = state.changeByRange(range => {
    const lenOpen = openTag.length;
    const lenClose = closeTag.length;
    const isMarked = range.from >= lenOpen && range.to <= state.doc.length - lenClose &&
                     state.sliceDoc(range.from - lenOpen, range.from) === openTag &&
                     state.sliceDoc(range.to, range.to + lenClose) === closeTag;
    if (isMarked) {
      return {
        changes: [
          { from: range.from - lenOpen, to: range.from, insert: "" },
          { from: range.to, to: range.to + lenClose, insert: "" }
        ],
        range: EditorSelection.range(range.from - lenOpen, range.to - lenOpen)
      }
    } else {
      return {
        changes: [
          { from: range.from, insert: openTag },
          { from: range.to, insert: closeTag }
        ],
        range: EditorSelection.range(range.from + lenOpen, range.to + lenOpen)
      }
    }
  });
  view.dispatch(tr);
  return true;
};

const markdownKeybindings = keymap.of([
  { key: "Enter", run: insertNewlineContinueMarkup },
  { key: "Mod-b", run: toggleFormat("**") },
  { key: "Mod-i", run: toggleFormat("*") },
  { key: "Mod-e", run: toggleHTMLTag("mark") } // Cmd+E for Bookmark/Highlight
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

export function Editor({ spaceID, path, initial, etag, theme, allFiles, onSaved, onCommentRequest }: Props) {
  const [content, setContent] = useState(initial)
  const [currentEtag, setCurrentEtag] = useState(etag)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fileCache = useRef<Record<string, string>>({})
  const dirty = content !== initial

  useEffect(() => {
    setContent(initial)
    setCurrentEtag(etag)
  }, [initial, path, etag])

  const wikiLinkCompletion = async (context: CompletionContext) => {
    const word = context.matchBefore(/\[\[([^\]]*)/)
    if (!word) return null
    if (word.from === word.to && !context.explicit) return null

    const query = word.text.slice(2)
    const hashIdx = query.indexOf('#')
    let options = []

    if (hashIdx === -1) {
      // Suggest Files
      options = allFiles
        .filter(f => f.toLowerCase().includes(query.toLowerCase()))
        .map(f => {
           const clean = f.replace(/\.md$/i, '')
           return { label: clean, type: 'text', detail: 'Page', apply: `[[${clean}]]` }
        })
    } else {
      // Suggest Headings
      const filePart = query.slice(0, hashIdx)
      const headingQuery = query.slice(hashIdx + 1).toLowerCase()
      
      let targetContent = ''
      if (filePart === '' || filePart + '.md' === path) {
         targetContent = context.state.doc.toString()
      } else {
         const targetPath = filePart.endsWith('.md') ? filePart : filePart + '.md'
         if (allFiles.includes(targetPath)) {
           if (fileCache.current[targetPath]) {
             targetContent = fileCache.current[targetPath]
           } else {
             try {
               const res = await api.readFile(spaceID, targetPath)
               targetContent = res.content
               fileCache.current[targetPath] = targetContent
             } catch (e) {
               // ignore
             }
           }
         }
      }

      const headings: string[] = []
      const regex = /^#+\s+(.*)$/gm
      let match;
      while ((match = regex.exec(targetContent)) !== null) {
        headings.push(match[1].trim())
      }

      options = headings
        .filter(h => h.toLowerCase().includes(headingQuery))
        .map(h => ({
           label: h, type: 'property', detail: 'Heading', apply: `[[${filePart}#${h}]]`
        }))
    }

    return {
      from: word.from,
      options,
      validFor: /^\[\[([^\]]*)$/
    }
  }

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

  useEffect(() => {
    function handleCommentRequest(e: Event) {
      const customEvent = e as CustomEvent<string>
      if (onCommentRequest) {
        onCommentRequest(customEvent.detail)
      }
    }
    const editorNode = document.getElementById('cm-container')
    if (editorNode) {
      editorNode.addEventListener('editor-comment-request', handleCommentRequest)
      return () => editorNode.removeEventListener('editor-comment-request', handleCommentRequest)
    }
  }, [onCommentRequest])

  return (
    <div className="relative min-h-full pb-20" id="cm-container">
      <div className="max-w-3xl mx-auto p-8">
        <CodeMirror
          value={content}
          onChange={(val) => setContent(val)}
          theme={theme}
          extensions={[
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            EditorView.lineWrapping,
            markdownKeybindings,
            customTheme,
            autocompletion({ override: [wikiLinkCompletion] }),
            selectionTooltip
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
