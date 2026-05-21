import { useEffect, useState } from 'react'
import { Link2 } from 'lucide-react'
import * as api from '../lib/api'

type Props = {
  spaceID: string
  path: string
  onSelect: (path: string) => void
}

/**
 * BacklinksPanel — finds files that link to the current page via [[wikilink]]
 * syntax. Implementation reuses the backend search endpoint, querying for the
 * page's display name wrapped in [[ to scope hits. Results exclude the page
 * itself and are deduplicated by source file.
 */
export function BacklinksPanel({ spaceID, path, onSelect }: Props) {
  const [hits, setHits] = useState<api.SearchMatch[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const name = path.split('/').pop()?.replace(/\.md$/i, '')
    if (!name) {
      setHits([])
      return
    }
    setLoading(true)
    setErr(null)
    // Query for `[[name` which catches both [[name]] and [[name#section|alias]].
    api
      .searchSpace(spaceID, `[[${name}`)
      .then(matches => {
        const dedup = new Map<string, api.SearchMatch>()
        for (const m of matches) {
          if (m.path === path) continue
          if (!dedup.has(m.path)) dedup.set(m.path, m)
        }
        setHits([...dedup.values()])
      })
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false))
  }, [spaceID, path])

  if (loading) {
    return (
      <div className="p-4 text-xs text-zinc-500">Looking for backlinks…</div>
    )
  }

  return (
    <div className="p-3">
      <h3 className="font-semibold text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wider px-2 mb-2 flex items-center gap-1">
        <Link2 size={12} /> Linked from
      </h3>
      {err && <p className="text-xs text-red-600 mb-2 px-2">{err}</p>}
      {hits.length === 0 ? (
        <p className="text-xs text-zinc-500 italic px-2">
          No other page links here yet.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {hits.map(h => (
            <li key={h.path}>
              <button
                onClick={() => onSelect(h.path)}
                className="block w-full text-left px-2 py-1.5 rounded-md text-sm text-zinc-700 hover:bg-zinc-100/70 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100 transition-colors truncate"
              >
                {h.path.replace(/\.md$/i, '')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
