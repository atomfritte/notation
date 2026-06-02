// Monaco-based Markdown editor with a sticky toolbar, floating selection
// actions, wiki-link picker, custom context-menu items, and full keyboard
// shortcuts. Replaces the older CodeMirror editor so both edit-mode and
// the diff-view (HistoryView) use the same engine.

import '../lib/monaco-setup'

import { useEffect, useRef, useState, useCallback } from 'react'
import type * as MonacoNS from 'monaco-editor'
import MonacoEditor, { type OnMount } from '@monaco-editor/react'
import {
  Save, Bold, Italic, Strikethrough, Code, Code2, Heading1, Heading2, Heading3,
  List, ListOrdered, Quote, Highlighter, Link as LinkIcon, Brackets, MessageSquare,
} from 'lucide-react'
import { WikiLinkPicker } from './WikiLinkPicker'
import * as api from '../lib/api'

type IEditor = MonacoNS.editor.IStandaloneCodeEditor
type IMonaco = typeof MonacoNS

// Static editor options. Hoisted to module scope so the object identity is
// stable across renders — @monaco-editor/react re-runs editor.updateOptions()
// whenever this prop's identity changes, so an inline literal would fire it on
// every keystroke. Nothing here depends on props/state (theme is a separate
// prop), so a module constant is the right home.
const EDITOR_OPTIONS: MonacoNS.editor.IStandaloneEditorConstructionOptions = {
  fontSize: 14,
  // Use the same monospace stack as the markdown viewer's code blocks — keeps
  // fenced code legible inside the editor and matches the look of what the
  // reader will eventually see. Monaco doesn't read CSS vars, so the stack is
  // duplicated here (kept in sync with --notation-code-font in shared/index.css).
  fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', 'Courier New', monospace",
  lineNumbers: 'on',
  lineNumbersMinChars: 3,
  renderLineHighlight: 'all',
  wordWrap: 'on',
  wrappingIndent: 'same',
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  padding: { top: 12, bottom: 80 },
  automaticLayout: true,
  renderWhitespace: 'none',
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  cursorSmoothCaretAnimation: 'on',
  mouseWheelZoom: false,
  stickyScroll: { enabled: false },
  tabSize: 2,
  insertSpaces: true,
  quickSuggestions: { other: true, comments: false, strings: true },
  suggestOnTriggerCharacters: true,
  acceptSuggestionOnEnter: 'on',
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
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

export default function Editor({
  spaceID, path, initial, etag, theme, allFiles, onSaved, onCommentRequest,
}: Props) {
  const editorRef = useRef<IEditor | null>(null)
  const monacoRef = useRef<IMonaco | null>(null)

  const [content, setContent] = useState(initial)
  const [currentEtag, setCurrentEtag] = useState(etag)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dirty = content !== initial

  // ---- refs that the editor-command closures dereference at call time so
  // they always see the latest React state without re-registering commands.
  const contentRef = useRef(content)
  const etagRef = useRef(currentEtag)
  const allFilesRef = useRef(allFiles)
  const pathRef = useRef(path)
  const onCommentRequestRef = useRef(onCommentRequest)
  useEffect(() => { contentRef.current = content }, [content])
  useEffect(() => { etagRef.current = currentEtag }, [currentEtag])
  useEffect(() => { allFilesRef.current = allFiles }, [allFiles])
  useEffect(() => { pathRef.current = path }, [path])
  useEffect(() => { onCommentRequestRef.current = onCommentRequest }, [onCommentRequest])

  // Adopt the parent's `initial` as the editor buffer on a genuine file switch,
  // or while the buffer is still pristine (so a late first load can fill an
  // untouched editor). We deliberately do NOT re-apply `initial` once the user
  // has unsaved edits: SpaceView paints from the content cache and then
  // revalidates against the server (stale-while-revalidate), so a background
  // fetch can hand us a fresh `initial` mid-edit. Re-feeding Monaco's
  // controlled `value` runs a full-range executeEdits with forceMoveMarkers,
  // which snaps the caret to the document end (and discards the in-flight
  // edit) — that was the "cursor jumps to the end while typing" bug.
  const baselineRef = useRef(initial)
  const syncedPathRef = useRef(path)
  useEffect(() => {
    const fileSwitched = syncedPathRef.current !== path
    const pristine = content === baselineRef.current
    baselineRef.current = initial
    syncedPathRef.current = path
    if (fileSwitched || pristine) {
      setContent(initial)
      setCurrentEtag(etag)
    }
  }, [content, initial, path, etag])

  // ---- save ----------------------------------------------------------------
  const save = useCallback(async () => {
    if (contentRef.current === initial && !dirty) return
    setSaving(true)
    setErr(null)
    try {
      await api.writeFile(spaceID, pathRef.current, contentRef.current, etagRef.current)
      setCurrentEtag(null)
      onSaved(contentRef.current, null)
    } catch (e) {
      if (String(e).includes('412')) {
        setErr('Conflict: another writer modified this file. Copy your changes and reload.')
      } else {
        setErr(String(e))
      }
    } finally {
      setSaving(false)
    }
  }, [spaceID, initial, dirty, onSaved])

  // Stash the latest save() in a ref too so Monaco commands always invoke
  // the current version.
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save }, [save])

  // ---- selection toolbar + wiki-link picker state -------------------------
  const [selTool, setSelTool] = useState<
    { x: number; y: number; text: string } | null
  >(null)
  const [picker, setPicker] = useState<
    { x: number; y: number; openLine: number; openCol: number } | null
  >(null)

  // ---- markdown edit helpers ----------------------------------------------
  function wrapSelection(prefix: string, suffix: string = prefix) {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    const sel = editor.getSelection()
    if (!sel) return
    const model = editor.getModel()
    if (!model) return
    const text = model.getValueInRange(sel)
    // If the surrounding chars already match, strip — toggle semantics.
    const startLine = sel.startLineNumber
    const startCol = sel.startColumn
    const endLine = sel.endLineNumber
    const endCol = sel.endColumn
    const lenP = prefix.length
    const lenS = suffix.length
    const before = startCol > lenP
      ? model.getValueInRange(new monaco.Range(startLine, startCol - lenP, startLine, startCol))
      : ''
    const after = model.getValueInRange(new monaco.Range(endLine, endCol, endLine, endCol + lenS))
    if (before === prefix && after === suffix) {
      editor.executeEdits('toggle-wrap-off', [
        { range: new monaco.Range(endLine, endCol, endLine, endCol + lenS), text: '' },
        { range: new monaco.Range(startLine, startCol - lenP, startLine, startCol), text: '' },
      ])
    } else {
      editor.executeEdits('toggle-wrap-on', [{ range: sel, text: `${prefix}${text}${suffix}` }])
    }
    editor.focus()
  }

  function prependLines(prefix: string) {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    const sel = editor.getSelection()
    if (!sel) return
    const edits: MonacoNS.editor.IIdentifiedSingleEditOperation[] = []
    for (let l = sel.startLineNumber; l <= sel.endLineNumber; l++) {
      edits.push({ range: new monaco.Range(l, 1, l, 1), text: prefix, forceMoveMarkers: false })
    }
    editor.executeEdits('prepend-lines', edits)
    editor.focus()
  }

  function numberLines() {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    const sel = editor.getSelection()
    if (!sel) return
    const edits: MonacoNS.editor.IIdentifiedSingleEditOperation[] = []
    let n = 1
    for (let l = sel.startLineNumber; l <= sel.endLineNumber; l++) {
      edits.push({ range: new monaco.Range(l, 1, l, 1), text: `${n}. `, forceMoveMarkers: false })
      n++
    }
    editor.executeEdits('number-lines', edits)
    editor.focus()
  }

  function insertCodeBlock() {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    const sel = editor.getSelection()
    if (!sel) return
    const model = editor.getModel()
    if (!model) return
    const text = model.getValueInRange(sel)
    editor.executeEdits('codeblock', [{ range: sel, text: `\`\`\`\n${text || ''}\n\`\`\`` }])
    editor.focus()
  }

  function insertLink() {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    const sel = editor.getSelection()
    if (!sel) return
    const model = editor.getModel()
    if (!model) return
    const label = model.getValueInRange(sel) || 'link'
    const inserted = `[${label}](url)`
    editor.executeEdits('link', [{ range: sel, text: inserted }])
    // Place the caret inside the (url) placeholder so the user can type.
    const offset = inserted.length - 4
    const start = sel.getStartPosition()
    editor.setPosition({ lineNumber: start.lineNumber, column: start.column + offset })
    editor.focus()
  }

  function startWikiLink() {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    const sel = editor.getSelection()
    if (!sel) return
    editor.executeEdits('wikilink', [{ range: sel, text: '[[' }])
    editor.focus()
    // The model-change listener below will see the new "[[" and open the picker.
  }

  function commentOnSelection() {
    const editor = editorRef.current
    if (!editor) return
    const sel = editor.getSelection()
    if (!sel) return
    const text = editor.getModel()?.getValueInRange(sel) ?? ''
    if (text.trim().length === 0) return
    onCommentRequestRef.current?.(text)
  }

  // ---- onMount: wire Monaco extension points ------------------------------
  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco

    // Disable auto-pairing — we own [[]] / ()/etc via toolbar + commands.
    editor.updateOptions({ autoClosingBrackets: 'never', autoClosingQuotes: 'never' })

    // ---- commands (keyboard shortcuts) ----
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void saveRef.current() })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => wrapSelection('**'))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => wrapSelection('*'))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () => wrapSelection('<mark>', '</mark>'))

    // ---- context-menu actions ----
    editor.addAction({
      id: 'notation.highlight',
      label: 'Highlight selection',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE],
      contextMenuGroupId: 'notation',
      contextMenuOrder: 1,
      run: () => wrapSelection('<mark>', '</mark>'),
    })
    editor.addAction({
      id: 'notation.comment',
      label: 'Comment on selection',
      contextMenuGroupId: 'notation',
      contextMenuOrder: 2,
      run: () => commentOnSelection(),
    })
    editor.addAction({
      id: 'notation.wikilink',
      label: 'Insert wiki-link…',
      contextMenuGroupId: 'notation',
      contextMenuOrder: 3,
      run: () => startWikiLink(),
    })

    // ---- wiki-link auto-completion (files + headings) ----
    const completionDisposable = monaco.languages.registerCompletionItemProvider('markdown', {
      triggerCharacters: ['[', '#'],
      provideCompletionItems(model: MonacoNS.editor.ITextModel, position: MonacoNS.Position) {
        const lineText = model.getLineContent(position.lineNumber)
        const before = lineText.slice(0, position.column - 1)
        const m = before.match(/\[\[([^\]\n]*)$/)
        if (!m) return { suggestions: [] }
        const query = m[1]
        const replaceRange = new monaco.Range(
          position.lineNumber, position.column - query.length,
          position.lineNumber, position.column,
        )
        const hash = query.indexOf('#')
        if (hash === -1) {
          // File suggestions
          const needle = query.toLowerCase()
          const files = allFilesRef.current
            .filter(f => /\.(md|markdown)$/i.test(f))
            .filter(f => f.toLowerCase().includes(needle))
            .slice(0, 50)
          return {
            suggestions: files.map(f => {
              const clean = f.replace(/\.md$/i, '')
              return {
                label: clean,
                kind: monaco.languages.CompletionItemKind.File,
                detail: 'Page',
                insertText: `${clean}]]`,
                range: replaceRange,
              }
            }),
          }
        }
        // Heading suggestions — pull from the current buffer or fetch.
        const filePart = query.slice(0, hash)
        const headingQuery = query.slice(hash + 1).toLowerCase()
        const targetPath = filePart === '' || `${filePart}.md` === pathRef.current
          ? pathRef.current
          : (filePart.endsWith('.md') ? filePart : `${filePart}.md`)
        const docContent = targetPath === pathRef.current
          ? model.getValue()
          : null
        // For other files, suggest async via api.readFile (cached by browser anyway).
        const fileContentPromise: Promise<string> = docContent != null
          ? Promise.resolve(docContent)
          : api.readFile(spaceID, targetPath).then(r => r.content).catch(() => '')
        return fileContentPromise.then(text => {
          const headings: string[] = []
          const re = /^#+\s+(.+)$/gm
          let mm: RegExpExecArray | null
          while ((mm = re.exec(text)) !== null) headings.push(mm[1].trim())
          return {
            suggestions: headings
              .filter(h => h.toLowerCase().includes(headingQuery))
              .map(h => ({
                label: h,
                kind: monaco.languages.CompletionItemKind.Reference,
                detail: 'Heading',
                insertText: `${filePart}#${h}]]`,
                range: replaceRange,
              })),
          }
        })
      },
    })

    // ---- selection toolbar updater ----
    const updateSelTool = () => {
      const sel = editor.getSelection()
      if (!sel || sel.isEmpty()) { setSelTool(null); return }
      const text = editor.getModel()?.getValueInRange(sel) ?? ''
      if (text.trim().length < 2) { setSelTool(null); return }
      const visible = editor.getScrolledVisiblePosition(sel.getStartPosition())
      const dom = editor.getDomNode()
      if (!visible || !dom) return
      const rect = dom.getBoundingClientRect()
      setSelTool({
        x: rect.left + visible.left,
        y: rect.top + visible.top - 38,
        text,
      })
    }
    const selDisp = editor.onDidChangeCursorSelection(updateSelTool)
    const scrollDisp = editor.onDidScrollChange(updateSelTool)
    const blurDisp = editor.onDidBlurEditorWidget(() => {
      // Don't tear down the toolbar on blur — the user is likely about to
      // click one of the floating buttons, which steals focus from Monaco.
    })

    // ---- wiki-link trigger ([[) ----
    const changeDisp = editor.onDidChangeModelContent((e) => {
      // Only react to actual `[` insertions, not large paste events etc.
      if (!e.changes.some(c => c.text === '[' || c.text === '[[')) return
      const pos = editor.getPosition()
      const model = editor.getModel()
      if (!pos || !model) return
      const startCol = Math.max(1, pos.column - 2)
      const before = model.getValueInRange(new monaco.Range(pos.lineNumber, startCol, pos.lineNumber, pos.column))
      if (before !== '[[') return
      const visible = editor.getScrolledVisiblePosition(pos)
      const dom = editor.getDomNode()
      if (!visible || !dom) return
      const rect = dom.getBoundingClientRect()
      setPicker({
        x: rect.left + visible.left,
        y: rect.top + visible.top + (visible.height || 20) + 4,
        openLine: pos.lineNumber,
        openCol: pos.column,
      })
    })

    return () => {
      completionDisposable.dispose()
      selDisp.dispose()
      scrollDisp.dispose()
      blurDisp.dispose()
      changeDisp.dispose()
    }
  }, [spaceID])

  function insertAtPicker(text: string) {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco || !picker) return
    const model = editor.getModel()
    if (!model) return
    const pos = editor.getPosition()
    if (!pos) return

    // Replace from picker.openCol (right after `[[`) to current cursor with `text`.
    const range = new monaco.Range(picker.openLine, picker.openCol, pos.lineNumber, pos.column)

    // closeBrackets isn't on, but defensive: if `]]` already follows, drop ours.
    const after = model.getValueInRange(new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column + 2))
    let insert = text
    let extra = 0
    if (after.startsWith(']]') && insert.endsWith(']]')) {
      insert = insert.slice(0, -2)
      extra = 2
    } else if (after.startsWith(']') && insert.endsWith(']]')) {
      insert = insert.slice(0, -1)
      extra = 1
    }

    editor.executeEdits('wiki-link-pick', [{ range, text: insert }])
    editor.setPosition({
      lineNumber: picker.openLine,
      column: picker.openCol + insert.length + extra,
    })
    editor.focus()
    setPicker(null)
  }

  // ---- render -------------------------------------------------------------

  return (
    <div className="relative flex flex-col h-full min-h-0 bg-[var(--notation-bg)]">
      <Toolbar
        dirty={dirty}
        saving={saving}
        err={err}
        onSave={() => void save()}
        onAction={(a) => {
          switch (a) {
            case 'h1': prependLines('# '); break
            case 'h2': prependLines('## '); break
            case 'h3': prependLines('### '); break
            case 'bold': wrapSelection('**'); break
            case 'italic': wrapSelection('*'); break
            case 'strike': wrapSelection('~~'); break
            case 'highlight': wrapSelection('<mark>', '</mark>'); break
            case 'code': wrapSelection('`'); break
            case 'codeblock': insertCodeBlock(); break
            case 'ul': prependLines('- '); break
            case 'ol': numberLines(); break
            case 'quote': prependLines('> '); break
            case 'link': insertLink(); break
            case 'wikilink': startWikiLink(); break
          }
        }}
      />

      <div className="flex-1 min-h-0">
        <MonacoEditor
          height="100%"
          defaultLanguage="markdown"
          value={content}
          onChange={(v) => setContent(v ?? '')}
          onMount={handleMount}
          theme={theme === 'dark' ? 'notation-dark' : 'notation-light'}
          options={EDITOR_OPTIONS}
        />
      </div>

      {selTool && (
        <div
          className="selection-toolbar"
          style={{ left: selTool.x, top: selTool.y, position: 'fixed' }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            onClick={() => {
              wrapSelection('<mark>', '</mark>')
              setSelTool(null)
            }}
          >
            <Highlighter size={12} /> Highlight
          </button>
          <button
            onClick={() => {
              onCommentRequestRef.current?.(selTool.text)
              setSelTool(null)
            }}
          >
            <MessageSquare size={12} /> Comment
          </button>
        </div>
      )}

      <WikiLinkPicker
        open={picker !== null}
        anchor={picker ? { x: picker.x, y: picker.y } : null}
        spaceID={spaceID}
        allFiles={allFiles}
        currentPath={path}
        currentContent={content}
        onSelect={insertAtPicker}
        onClose={() => setPicker(null)}
      />
    </div>
  )
}

// ---- Toolbar -------------------------------------------------------------

type ToolbarProps = {
  dirty: boolean
  saving: boolean
  err: string | null
  onSave: () => void
  onAction: (a:
    | 'h1' | 'h2' | 'h3'
    | 'bold' | 'italic' | 'strike' | 'highlight' | 'code' | 'codeblock'
    | 'ul' | 'ol' | 'quote' | 'link' | 'wikilink'
  ) => void
}

function Toolbar({ dirty, saving, err, onSave, onAction }: ToolbarProps) {
  return (
    <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-[var(--notation-border)]/60 bg-[var(--notation-bg-elevated)]/80 bg-[var(--notation-bg-alt)]/40 backdrop-blur-sm flex-shrink-0 sticky top-0 z-20">
      <ToolGroup>
        <ToolBtn icon={Heading1} title="Heading 1" onClick={() => onAction('h1')} />
        <ToolBtn icon={Heading2} title="Heading 2" onClick={() => onAction('h2')} />
        <ToolBtn icon={Heading3} title="Heading 3" onClick={() => onAction('h3')} />
      </ToolGroup>
      <Divider />
      <ToolGroup>
        <ToolBtn icon={Bold} title="Bold (⌘B)" onClick={() => onAction('bold')} />
        <ToolBtn icon={Italic} title="Italic (⌘I)" onClick={() => onAction('italic')} />
        <ToolBtn icon={Strikethrough} title="Strikethrough" onClick={() => onAction('strike')} />
        <ToolBtn icon={Highlighter} title="Highlight (⌘E)" onClick={() => onAction('highlight')} />
        <ToolBtn icon={Code} title="Inline code" onClick={() => onAction('code')} />
      </ToolGroup>
      <Divider />
      <ToolGroup>
        <ToolBtn icon={List} title="Bullet list" onClick={() => onAction('ul')} />
        <ToolBtn icon={ListOrdered} title="Numbered list" onClick={() => onAction('ol')} />
        <ToolBtn icon={Quote} title="Quote" onClick={() => onAction('quote')} />
        <ToolBtn icon={Code2} title="Code block" onClick={() => onAction('codeblock')} />
      </ToolGroup>
      <Divider />
      <ToolGroup>
        <ToolBtn icon={LinkIcon} title="Insert link" onClick={() => onAction('link')} />
        <ToolBtn icon={Brackets} title="Wiki-link [[" onClick={() => onAction('wikilink')} />
      </ToolGroup>

      <div className="ml-auto flex items-center gap-2 pl-2">
        {err && (
          <span className="text-xs text-[var(--notation-danger)] dark:text-[var(--notation-danger)] truncate max-w-xs" title={err}>
            {err}
          </span>
        )}
        {dirty && !saving && (
          <span className="text-[11px] text-[var(--notation-warning)] dark:text-[var(--notation-warning)]">unsaved</span>
        )}
        <button
          onClick={onSave}
          disabled={!dirty || saving}
          className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:bg-[var(--notation-bg-alt)] dark:hover:bg-[#a6d944] rounded-md transition-colors disabled:opacity-40"
          title="Save (⌘S)"
        >
          <Save size={13} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function ToolGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>
}

function Divider() {
  return <div className="w-px h-5 bg-[var(--notation-bg-alt)] dark:bg-[var(--notation-bg-alt)]/60 mx-1" />
}

function ToolBtn({
  icon: Icon, title, onClick,
}: {
  icon: typeof Bold
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="p-1.5 rounded text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/60 dark:text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/60 transition-colors"
    >
      <Icon size={14} />
    </button>
  )
}
