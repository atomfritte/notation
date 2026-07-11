import { useEffect, useState } from 'react'
import { Link2 } from 'lucide-react'
import * as api from '../lib/api'

type Props = {
  spaceID: string
  path: string
  onSelect: (path: string) => void
  /**
   * Client-side backlink computation for zero-knowledge encrypted spaces, where
   * the server can't read the ciphertext so its search index returns nothing.
   * When provided it replaces the server query; the decrypted corpus is scanned
   * in-browser (see {@link EncryptedSearchIndex.backlinks}). Plaintext spaces
   * leave this undefined and keep the server path. Must be referentially stable
   * (memoise it) — the panel recomputes whenever its identity changes.
   */
  compute?: (path: string) => Promise<api.SearchMatch[]>
}

/**
 * BacklinksPanel — finds files that link to the current page via [[wikilink]]
 * syntax. Plaintext spaces reuse the backend search endpoint, querying for the
 * page's display name wrapped in [[ to scope hits. Encrypted spaces pass a
 * `compute` function that resolves the same links entirely client-side. Either
 * way results exclude the page itself and are deduplicated by source file.
 */
export function BacklinksPanel({ spaceID, path, onSelect, compute }: Props) {
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
    let cancelled = false
    // Encrypted: scan the decrypted corpus client-side. Plaintext: query for
    // `[[name` which catches both [[name]] and [[name#section|alias]].
    const source = compute
      ? compute(path)
      : api.searchSpace(spaceID, `[[${name}`)
    source
      .then(matches => {
        if (cancelled) return
        const safe = Array.isArray(matches) ? matches : []
        const dedup = new Map<string, api.SearchMatch>()
        for (const m of safe) {
          if (m.path === path) continue
          if (!dedup.has(m.path)) dedup.set(m.path, m)
        }
        setHits([...dedup.values()])
      })
      .catch(e => { if (!cancelled) setErr(String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [spaceID, path, compute])

  if (loading) {
    return (
      <div className="p-4 text-xs text-[var(--notation-fg-muted)]">Looking for backlinks…</div>
    )
  }

  return (
    <div className="p-3">
      <h3 className="font-semibold text-xs text-[var(--notation-fg-muted)] uppercase tracking-wider px-2 mb-2 flex items-center gap-1">
        <Link2 size={12} /> Linked from
      </h3>
      {err && <p className="text-xs text-[var(--notation-danger)] mb-2 px-2">{err}</p>}
      {hits.length === 0 ? (
        <p className="text-xs text-[var(--notation-fg-muted)] italic px-2">
          No other page links here yet.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {hits.map(h => (
            <li key={h.path}>
              <button
                onClick={() => onSelect(h.path)}
                className="block w-full text-left px-2 py-1.5 rounded-md text-sm text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/70 hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]/50 hover:text-[var(--notation-fg)] transition-colors truncate"
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
