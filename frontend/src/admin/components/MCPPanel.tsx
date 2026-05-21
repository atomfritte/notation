import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Plug, Plus } from 'lucide-react'
import { MCPIntegrationModal } from './MCPIntegrationModal'

type MCPToken = {
  id: string
  label: string
  created_at: string
  created_by: string
  last_used?: string
}

type CreateResp = {
  token: MCPToken
  raw: string
  url: string
}

type Props = { spaceID: string }

/**
 * MCPPanel — sidebar tab for managing Bearer tokens that grant MCP access to
 * this Space. Clicking a token (or finishing creation) opens
 * MCPIntegrationModal with paste-ready Claude Code / Cursor / HTTP snippets.
 */
export function MCPPanel({ spaceID }: Props) {
  const [tokens, setTokens] = useState<MCPToken[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [modal, setModal] = useState<{ url: string; rawToken?: string } | null>(null)

  // The MCP path is configurable server-side (NOTATION_MCP_PATH) but defaults
  // to /mcp. We compute the URL client-side for existing tokens since the
  // server only includes it in the creation response.
  const inferredURL = `${window.location.origin}/mcp/${spaceID}`

  const refresh = useCallback(() => {
    fetch(`/api/admin/spaces/${encodeURIComponent(spaceID)}/mcp-tokens`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<MCPToken[]>
      })
      .then(setTokens)
      .catch(e => setErr(String(e)))
  }, [spaceID])

  useEffect(refresh, [refresh])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      const r = await fetch(`/api/admin/spaces/${encodeURIComponent(spaceID)}/mcp-tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      const data: CreateResp = await r.json()
      setLabel('')
      setShowForm(false)
      refresh()
      setModal({ url: data.url, rawToken: data.raw })
    } catch (e) {
      setErr(String(e))
    }
  }

  async function onDelete(id: string, ev: React.MouseEvent) {
    ev.stopPropagation()
    if (!window.confirm(`Revoke MCP token ${id}?`)) return
    const r = await fetch(
      `/api/admin/spaces/${encodeURIComponent(spaceID)}/mcp-tokens/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
    if (r.ok) refresh()
    else setErr(`HTTP ${r.status}`)
  }

  return (
    <>
      <div className="p-3">
        <h3 className="font-semibold text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wider px-2 mb-2 flex items-center gap-1">
          <Plug size={12} /> MCP Tokens
        </h3>
        <p className="text-xs text-zinc-500 px-2 mb-3 leading-relaxed">
          Connect Claude Code, Cursor or any MCP client to read & edit this Space.
        </p>

        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium bg-zinc-900 text-white dark:bg-[#BFF355] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-[#a6d944] rounded-md transition-colors mb-3"
          >
            <Plus size={12} /> New token
          </button>
        )}

        {showForm && (
          <form onSubmit={onCreate} className="space-y-2 mb-3 px-1">
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              className="border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2 py-1.5 rounded-md text-xs w-full text-zinc-900 dark:text-zinc-100 placeholder-zinc-400"
              placeholder="Label (e.g. claude-laptop)"
              autoFocus
            />
            <div className="flex gap-1">
              <button
                type="submit"
                className="flex-1 px-2 py-1 bg-zinc-900 text-white dark:bg-[#BFF355] dark:text-zinc-950 text-xs font-medium rounded-md hover:bg-zinc-800 dark:hover:bg-[#a6d944]"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false)
                  setLabel('')
                }}
                className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {tokens.length === 0 ? (
          <p className="text-xs text-zinc-500 italic px-2">No tokens yet.</p>
        ) : (
          <ul className="space-y-1">
            {tokens.map(t => (
              <li
                key={t.id}
                onClick={() => setModal({ url: inferredURL })}
                className="p-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md hover:border-zinc-300 dark:hover:border-zinc-700 cursor-pointer transition-colors"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{t.id}</div>
                    {t.label && (
                      <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5 truncate">{t.label}</div>
                    )}
                    <div className="text-[10px] text-zinc-500 mt-0.5">
                      created {new Date(t.created_at).toLocaleString()}
                      {t.last_used && (
                        <>
                          {' · '}last used {new Date(t.last_used).toLocaleString()}
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={(e) => onDelete(t.id, e)}
                    className="text-xs text-red-600 dark:text-red-400 hover:underline flex-shrink-0"
                  >
                    revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {err && <p className="text-red-600 dark:text-red-400 mt-2 text-xs px-2">{err}</p>}
      </div>

      <MCPIntegrationModal
        open={modal !== null}
        spaceID={spaceID}
        url={modal?.url ?? ''}
        rawToken={modal?.rawToken}
        onClose={() => setModal(null)}
      />
    </>
  )
}
