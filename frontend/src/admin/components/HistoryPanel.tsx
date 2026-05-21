import { useEffect, useState } from 'react'
import { GitCommit, ChevronDown, ChevronRight } from 'lucide-react'
import * as api from '../lib/api'

type Props = { spaceID: string }

/**
 * HistoryPanel — view per-Space git history. Lists commits (newest first),
 * lets the admin click a commit to expand its diff inline.
 */
export function HistoryPanel({ spaceID }: Props) {
  const [commits, setCommits] = useState<api.Commit[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [openHash, setOpenHash] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, string>>({})

  useEffect(() => {
    api.getLog(spaceID).then(setCommits).catch(e => setErr(String(e)))
  }, [spaceID])

  async function toggle(hash: string) {
    if (openHash === hash) {
      setOpenHash(null)
      return
    }
    setOpenHash(hash)
    if (!diffs[hash]) {
      try {
        const text = await api.getDiff(spaceID, hash)
        setDiffs(d => ({ ...d, [hash]: text }))
      } catch (e) {
        setErr(String(e))
      }
    }
  }

  return (
    <div className="p-3">
      <h3 className="font-semibold text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wider px-2 mb-2 flex items-center gap-1">
        <GitCommit size={12} /> History
      </h3>
      {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
      {commits.length === 0 ? (
        <p className="text-xs text-zinc-500 italic px-2">No commits yet.</p>
      ) : (
        <ul className="space-y-1">
          {commits.map(c => (
            <li key={c.hash} className="rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <button
                onClick={() => toggle(c.hash)}
                className="w-full flex items-start gap-2 px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 text-left transition-colors"
              >
                <div className="mt-0.5 text-zinc-400">
                  {openHash === c.hash ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-zinc-700 dark:text-zinc-300 truncate">{c.subject}</div>
                  <div className="text-[11px] text-zinc-500 mt-0.5 flex items-center gap-1.5">
                    <span className="font-mono">{c.hash.slice(0, 7)}</span>
                    <span>·</span>
                    <span className="truncate">{c.author}</span>
                    <span>·</span>
                    <span>{new Date(c.date).toLocaleString()}</span>
                  </div>
                </div>
              </button>
              {openHash === c.hash && (
                <pre className="text-[11px] font-mono px-3 py-2 bg-zinc-50 dark:bg-zinc-950/50 border-t border-zinc-200 dark:border-zinc-800 overflow-x-auto max-h-72 overflow-y-auto whitespace-pre-wrap">
                  {diffs[c.hash] ?? 'loading…'}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
