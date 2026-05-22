import { useEffect, useState } from 'react'
import { ShieldCheck, RefreshCw } from 'lucide-react'
import * as api from '../lib/api'

type Props = { spaceID: string }

const actionColors: Record<string, string> = {
  'read': 'text-[var(--notation-info)] dark:text-[var(--notation-info)]',
  'write': 'text-[var(--notation-warning)] dark:text-[var(--notation-warning)]',
  'delete': 'text-[var(--notation-danger)] dark:text-[var(--notation-danger)]',
  'comment': 'text-[color:var(--notation-accent)]',
  'mcp': 'text-purple-600 dark:text-purple-400',
}

function colorFor(action: string): string {
  for (const k of Object.keys(actionColors)) {
    if (action.includes(k)) return actionColors[k]
  }
  return 'text-[var(--notation-fg-muted)]'
}

/**
 * AuditPanel — recent audit-log entries for the Space. Reads JSONL from
 * <space>/.notation/audit.log via the backend's /audit endpoint, newest first.
 */
export function AuditPanel({ spaceID }: Props) {
  const [entries, setEntries] = useState<api.AuditEntry[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function refresh() {
    setLoading(true)
    api
      .getAudit(spaceID)
      .then(r => setEntries(Array.isArray(r) ? r : []))
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(refresh, [spaceID])

  return (
    <div className="p-3">
      <div className="flex items-center justify-between px-2 mb-2">
        <h3 className="font-semibold text-xs text-[var(--notation-fg-muted)] uppercase tracking-wider flex items-center gap-1">
          <ShieldCheck size={12} /> Audit Log
        </h3>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:text-[var(--notation-fg)] transition-colors p-1 rounded-md hover:bg-[var(--notation-border)] disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {err && <p className="text-xs text-[var(--notation-danger)] mb-2 px-2">{err}</p>}
      {entries.length === 0 ? (
        <p className="text-xs text-[var(--notation-fg-muted)] italic px-2">No audit entries yet.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((e, i) => (
            <li
              key={i}
              className="text-xs px-2 py-1.5 hover:bg-[var(--notation-bg-alt)] hover:bg-[var(--notation-bg-alt)]/30 rounded-md transition-colors"
              title={[e.actor, e.action, e.path, e.ip, e.ua].filter(Boolean).join(' · ')}
            >
              <div className="flex items-center gap-2">
                <span className={`font-semibold ${colorFor(e.action)}`}>{e.action}</span>
                {e.path && <span className="text-[var(--notation-fg-muted)] truncate font-mono text-[10px]">{e.path}</span>}
              </div>
              <div className="text-[10px] text-[var(--notation-fg-muted)] mt-0.5 truncate">
                <span className="font-mono">{e.actor}</span>
                <span className="mx-1">·</span>
                <span>{new Date(e.ts).toLocaleString()}</span>
                {e.err && <span className="text-[var(--notation-danger)] ml-2">⚠ {e.err}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
