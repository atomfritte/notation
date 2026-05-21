// Monaco loader configuration: bundle Monaco locally (Vite handles the
// module graph + workers) instead of pulling it from a CDN. Keeps our CSP
// `script-src 'self'` strict — no third-party origins required.
//
// Importing this module has the side-effect of registering MonacoEnvironment
// + telling @monaco-editor/react to use our bundled monaco instance. Import
// it once from each lazy chunk that mounts a Monaco editor (Editor.tsx,
// MonacoDiff.tsx); ES-module singleton semantics dedupe the setup.

import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'

// The editor.worker bundle handles syntax tokenisation, find-in-file, and
// other features Monaco does off the main thread. We don't load the JS / TS
// / HTML / CSS language workers — they're for IntelliSense in those
// languages, which we don't need for markdown editing.
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

// `self` here is the browser global; we live in Web-Workers-via-blob
// territory, allowed by our CSP `worker-src 'self' blob:`.
;(self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker() {
    return new editorWorker()
  },
}

loader.config({ monaco })

// ---- shared themes --------------------------------------------------------
//
// Define once, before any editor renders. notation-dark uses the lime
// accent for cursor + selection so the editor matches the rest of the app.
monaco.editor.defineTheme('notation-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0a0a0a',
    'editor.foreground': '#e4e4e7',
    'editorLineNumber.foreground': '#3f3f46',
    'editorLineNumber.activeForeground': '#a1a1aa',
    'editor.lineHighlightBackground': '#18181b',
    'editor.lineHighlightBorder': '#1a1a1a',
    'editorCursor.foreground': '#BFF355',
    'editor.selectionBackground': '#BFF35530',
    'editor.selectionHighlightBackground': '#BFF35515',
    'editor.wordHighlightBackground': '#BFF35515',
    'editor.findMatchBackground': '#BFF35540',
    'editor.findMatchHighlightBackground': '#BFF35520',
    'editorIndentGuide.background': '#27272a',
    'editorIndentGuide.activeBackground': '#3f3f46',
    'editorBracketMatch.background': '#BFF35520',
    'editorBracketMatch.border': '#BFF35580',
    'scrollbarSlider.background': '#27272a80',
    'scrollbarSlider.hoverBackground': '#3f3f46c0',
    'scrollbarSlider.activeBackground': '#52525bc0',
    'editorWidget.background': '#18181b',
    'editorWidget.border': '#27272a',
    'editorSuggestWidget.background': '#18181b',
    'editorSuggestWidget.border': '#27272a',
    'editorSuggestWidget.selectedBackground': '#BFF35520',
    'editorGutter.background': '#0a0a0a',
  },
})

monaco.editor.defineTheme('notation-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.lineHighlightBackground': '#f4f4f5',
    'editorCursor.foreground': '#7c9b1f',
    'editor.selectionBackground': '#BFF35540',
  },
})

export { monaco }
