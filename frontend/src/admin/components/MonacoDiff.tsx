import { DiffEditor } from '@monaco-editor/react'

type Props = {
  original: string
  modified: string
  language: string
  theme: 'light' | 'dark'
}

/**
 * MonacoDiff renders a true side-by-side diff using the Monaco editor's
 * built-in DiffEditor. Heavy (~3MB) — kept in a lazy chunk and only loaded
 * when the user actually opens the History compare view.
 */
export default function MonacoDiff({ original, modified, language, theme }: Props) {
  return (
    <div className="flex-1 min-h-0">
      <DiffEditor
        height="100%"
        language={language}
        original={original}
        modified={modified}
        theme={theme === 'dark' ? 'vs-dark' : 'vs'}
        options={{
          readOnly: true,
          renderSideBySide: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          wordWrap: 'on',
          renderIndicators: true,
          ignoreTrimWhitespace: false,
          renderLineHighlight: 'none',
          guides: { indentation: false },
          lineNumbers: 'on',
          renderOverviewRuler: false,
          renderWhitespace: 'none',
          smoothScrolling: true,
          automaticLayout: true,
        }}
      />
    </div>
  )
}
