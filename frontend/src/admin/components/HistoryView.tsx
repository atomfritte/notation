import { lazy, Suspense, useEffect, useState } from 'react'
import { X, RotateCcw, GitCommit, Check, GitCompareArrows } from 'lucide-react'
import * as api from '../lib/api'
import { isTextFile, monacoLang } from '../lib/fileTypes'
import { FileViewer } from './FileViewer'

const MonacoDiff = lazy(() => import('./MonacoDiff'))

type Props = {
  spaceID: string
  path: string
  theme: 'light' | 'dark'
  onClose: () => void
  /** Fired after a successful restore ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â parent should refresh tree + content. */
  onRestored: () => void
}

/**
 * HistoryView ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â full-pane per-file history. Left rail lists commits that
 * touched this file (newest first). Click rows to select up to two: with one
 * selected, the right pane previews that version (Restore enabled); with two
 * selected, the right pane shows a colored unified diff between them.
 *
 * Restore writes the chosen version back to the current file and triggers an
 * auto-commit labeled "restore <short-hash>" so the history stays linear.
 */
export function HistoryView({ spaceID, path, theme, onClose, onRestored }: Props) {
  const [commits, setCommits] = useState<api.Commit[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<string>('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)
  // Side-by-side compare uses both versions' content fed into Monaco DiffEditor.
  const [compareFrom, setCompareFrom] = useState<string>('')
  const [compareTo, setCompareTo] = useState<string>('')

  useEffect(() => {
    api
      .getFileHistory(spaceID, path)
      .then(r => setCommits(Array.isArray(r) ? r : []))
      .catch(e => setErr(String(e)))
  }, [spaceID, path])

  // Compute the preview state from the selection
  useEffect(() => {
    setErr(null)
    if (selected.length === 0) {
      setPreviewContent('')
      setCompareFrom('')
      setCompareTo('')
      return
    }
    if (selected.length === 1) {
      setCompareFrom('')
      setCompareTo('')
      if (isTextFile(path)) {
        setPreviewLoading(true)
        api.getFileAtCommit(spaceID, selected[0], path)
          .then(setPreviewContent)
          .catch(e => setErr(String(e)))
          .finally(() => setPreviewLoading(false))
      } else {
        setPreviewContent('')
      }
      return
    }
    // 2 selected ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ side-by-side diff. Commits list is newest-first so the
    // entry with the higher index is the older commit; that's our "from".
    const [a, b] = selected
    const ia = commits.findIndex(c => c.hash === a)
    const ib = commits.findIndex(c => c.hash === b)
    const [from, to] = ia > ib ? [a, b] : [b, a]
    setPreviewLoading(true)
    Promise.all([
      api.getFileAtCommit(spaceID, from, path),
      api.getFileAtCommit(spaceID, to, path),
    ])
      .then(([f, t]) => {
        setCompareFrom(f)
        setCompareTo(t)
      })
      .catch(e => setErr(String(e)))
      .finally(() => setPreviewLoading(false))
  }, [selected, spaceID, path, commits])

  function toggle(hash: string) {
    setSelected(prev => {
      if (prev.includes(hash)) return prev.filter(h => h !== hash)
      if (prev.length >= 2) return [prev[1], hash]
      return [...prev, hash]
    })
  }

  async function doRestore() {
    if (selected.length !== 1) return
    const hash = selected[0]
    const short = hash.slice(0, 7)
    if (!window.confirm(`Restore this file to version ${short}? Current content will be overwritten (and a new commit will be made).`)) return
    setRestoring(true)
    setErr(null)
    try {
      await api.restoreFile(spaceID, path, hash)
      onRestored()
      onClose()
    } catch (e) {
      setErr(String(e))
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[var(--notation-bg)]">
      <header className="h-12 flex items-center px-4 border-b border-[var(--notation-border)] flex-shrink-0 gap-3">
        <GitCommit size={16} className="text-zinc-500" />
        <div className="text-sm font-medium text-[var(--notation-fg)]">History</div>
        <div className="text-sm text-zinc-500 truncate">{path.replace(/\.md$/i, '')}</div>
        <div className="ml-auto flex items-center gap-2">
          {selected.length === 1 && (
            <button
              onClick={doRestore}
              disabled={restoring}
              className="px-3 py-1.5 text-sm font-medium bg-zinc-900 text-white dark:bg-[color:var(--notation-accent)] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-[#a6d944] rounded-md transition-colors disabled:opacity-40 flex items-center gap-1.5"
            >
              <RotateCcw size={14} /> {restoring ? 'RestoringÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦' : 'Restore this version'}
            </button>
          )}
          {selected.length > 0 && (
            <button
              onClick={() => setSelected([])}
              className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Clear
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 rounded-md"
            title="Close history"
          >
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-72 flex-shrink-0 border-r border-[var(--notation-border)] overflow-y-auto bg-zinc-50/30 dark:bg-zinc-950/30">
          <div className="px-3 py-2 text-xs text-zinc-500 border-b border-[var(--notation-border)] sticky top-0 bg-zinc-50 dark:bg-zinc-950">
            {commits.length} version{commits.length === 1 ? '' : 's'} ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· select 1 to preview, 2 to compare
          </div>
          {commits.length === 0 ? (
            <p className="p-4 text-sm text-zinc-500 italic">No history for this file yet.</p>
          ) : (
            <ul>
              {commits.map((c, i) => {
                const idx = selected.indexOf(c.hash)
                const sel = idx >= 0
                return (
                  <li key={c.hash}>
                    <button
                      onClick={() => toggle(c.hash)}
                      className={
                        'w-full text-left px-3 py-2 flex items-start gap-2 border-b border-zinc-100 dark:border-zinc-900/50 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors ' +
                        (sel ? 'bg-[color:var(--notation-accent-10)] dark:bg-[color:var(--notation-accent-10)]' : '')
                      }
                    >
                      <div
                        className={
                          'mt-1 flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center text-zinc-50 ' +
                          (sel
                            ? 'border-zinc-900 dark:border-[color:var(--notation-accent)] bg-zinc-900 dark:bg-[color:var(--notation-accent)]'
                            : 'border-[var(--notation-border)]')
                        }
                      >
                        {sel && <Check size={10} className="text-white dark:text-zinc-950" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-[var(--notation-fg)] truncate">{c.subject || '(no message)'}</div>
                        <div className="text-[11px] text-zinc-500 mt-0.5 flex items-center gap-1.5">
                          <span className="font-mono">{c.hash.slice(0, 7)}</span>
                          <span>ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â·</span>
                          <span className="truncate">{c.author}</span>
                        </div>
                        <div className="text-[10px] text-zinc-400 mt-0.5">{new Date(c.date).toLocaleString()}</div>
                        {i === 0 && (
                          <span className="inline-block mt-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-zinc-200 dark:bg-zinc-800 text-[var(--notation-fg)] rounded">
                            current
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {err && (
            <div className="px-4 py-2 text-sm text-red-600 dark:text-red-400 border-b border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30">
              {err}
            </div>
          )}
          {selected.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-[var(--notation-fg-muted)] text-sm">
              Select a version from the left to preview.
            </div>
          )}
          {selected.length === 1 && previewLoading && (
            <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">LoadingÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦</div>
          )}
          {selected.length === 1 && !previewLoading && (
            <FileViewer
              spaceID={spaceID}
              path={path}
              content={previewContent}
              theme={theme}
              urlFor={p => api.fileAtURL(spaceID, selected[0], p)}
            />
          )}
          {selected.length === 2 && (
            previewLoading ? (
              <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">LoadingÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦</div>
            ) : compareFrom === compareTo ? (
              <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm flex-col gap-2">
                <GitCompareArrows size={20} className="opacity-50" />
                No differences between the selected versions.
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
                    Loading diff editorÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦
                  </div>
                }
              >
                <MonacoDiff
                  original={compareFrom}
                  modified={compareTo}
                  language={monacoLang(path)}
                  theme={theme}
                />
              </Suspense>
            )
          )}
        </div>
      </div>
    </div>
  )
}
