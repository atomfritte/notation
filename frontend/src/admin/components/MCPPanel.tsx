import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Plug, Plus } from 'lucide-react'
import { MCPIntegrationModal } from './MCPIntegrationModal'
import * as api from '../lib/api'

type Props = { spaceID: string }

/**
 * MCPPanel — sidebar tab for managing Bearer tokens that grant MCP access to
 * this Space. Clicking a token (or finishing creation) opens
 * MCPIntegrationModal with paste-ready Claude Code / Cursor / HTTP snippets.
 *
 * Every state-changing call routes through api.* so the X-CSRF-Token header
 * gets attached — raw fetch() bypasses the attachCSRF wrapper and the
 * backend rejects the request with "csrf token mismatch".
 */
export function MCPPanel({ spaceID }: Props) {
  const [tokens, setTokens] = useState<api.MCPToken[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [modal, setModal] = useState<{ url: string; rawToken?: string } | null>(null)

  // The MCP path is configurable server-side (NOTATION_MCP_PATH) but defaults
  // to /mcp. We compute the URL client-side for existing tokens since the
  // server only includes it in the creation response.
  const inferredURL = `${window.location.origin}/mcp/${spaceID}`

  const refresh = useCallback(() => {
    api.listMCPTokens(spaceID).then(setTokens).catch(e => setErr(String(e)))
  }, [spaceID])

  useEffect(refresh, [refresh])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      const data = await api.createMCPToken(spaceID, label)
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
    try {
      await api.deleteMCPToken(spaceID, id)
      refresh()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <>
      <div className="p-3">
        <h3 className="font-semibold text-xs text-[var(--notation-fg-muted)] uppercase tracking-wider px-2 mb-2 flex items-center gap-1">
          <Plug size={12} /> MCP Tokens
        </h3>
        <p className="text-xs text-[var(--notation-fg-muted)] px-2 mb-3 leading-relaxed">
          Connect Claude Code, Cursor or any MCP client to read & edit this Space.
        </p>

        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:bg-[var(--notation-bg-alt)] dark:hover:bg-[#a6d944] rounded-md transition-colors mb-3"
          >
            <Plus size={12} /> New token
          </button>
        )}

        {showForm && (
          <form onSubmit={onCreate} className="space-y-2 mb-3 px-1">
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              className="border border-[var(--notation-border)] bg-[var(--notation-bg-alt)] px-2 py-1.5 rounded-md text-xs w-full text-[var(--notation-fg)] placeholder-zinc-400"
              placeholder="Label (e.g. claude-laptop)"
              autoFocus
            />
            <div className="flex gap-1">
              <button
                type="submit"
                className="flex-1 px-2 py-1 bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] text-xs font-medium rounded-md hover:bg-[var(--notation-bg-alt)] dark:hover:bg-[#a6d944]"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false)
                  setLabel('')
                }}
                className="px-2 py-1 text-xs text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {tokens.length === 0 ? (
          <p className="text-xs text-[var(--notation-fg-muted)] italic px-2">No tokens yet.</p>
        ) : (
          <ul className="space-y-1">
            {tokens.map(t => (
              <li
                key={t.id}
                onClick={() => setModal({ url: inferredURL })}
                className="p-2 bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] rounded-md hover:border-[var(--notation-border)] dark:hover:border-[var(--notation-border)] cursor-pointer transition-colors"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs text-[var(--notation-fg)]">{t.id}</div>
                    {t.label && (
                      <div className="text-xs text-[var(--notation-fg-muted)] mt-0.5 truncate">{t.label}</div>
                    )}
                    <div className="text-[10px] text-[var(--notation-fg-muted)] mt-0.5">
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
                    className="text-xs text-[var(--notation-danger)] dark:text-[var(--notation-danger)] hover:underline flex-shrink-0"
                  >
                    revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {err && <p className="text-[var(--notation-danger)] dark:text-[var(--notation-danger)] mt-2 text-xs px-2">{err}</p>}
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
