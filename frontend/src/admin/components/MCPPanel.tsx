import { useCallback, useEffect, useState, type FormEvent } from 'react'

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

export function MCPPanel({ spaceID }: Props) {
  const [tokens, setTokens] = useState<MCPToken[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [created, setCreated] = useState<CreateResp | null>(null)

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
    setCreated(null)
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
      setCreated(data)
      setLabel('')
      refresh()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm(`Revoke MCP token ${id}?`)) return
    const r = await fetch(
      `/api/admin/spaces/${encodeURIComponent(spaceID)}/mcp-tokens/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
    if (r.ok) refresh()
    else setErr(`HTTP ${r.status}`)
  }

  function copy(text: string) {
    void navigator.clipboard?.writeText(text).catch(() => {})
  }

  const claudeConfig = created
    ? `{
  "mcpServers": {
    "notation-${spaceID}": {
      "type": "http",
      "url": "${created.url}",
      "headers": {
        "Authorization": "Bearer ${created.raw}"
      }
    }
  }
}`
    : ''

  return (
    <div className="mt-4 pt-4 border-t">
      <h3 className="font-semibold text-sm mb-3">MCP Tokens</h3>
      <p className="text-xs text-gray-600 mb-3">
        Connect Claude Code (or any MCP client) to this Space. Each token grants
        full read+write access to <span className="font-mono">{spaceID}</span>.
      </p>

      <form onSubmit={onCreate} className="space-y-2 mb-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Label (e.g. laptop)</label>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            className="border px-2 py-1 rounded text-sm w-full"
            placeholder="optional"
          />
        </div>
        <button
          type="submit"
          className="px-3 py-1 bg-purple-600 text-white text-sm rounded w-full"
        >
          Create MCP token
        </button>
      </form>

      {created && (
        <div className="mb-3 p-2 bg-yellow-50 border border-yellow-300 rounded text-xs">
          <p className="font-semibold text-yellow-900 mb-1">
            Save this token now — it cannot be recovered:
          </p>
          <div className="space-y-1">
            <div>
              <div className="text-gray-700">URL:</div>
              <code className="block break-all bg-white p-1 rounded select-all">{created.url}</code>
            </div>
            <div>
              <div className="text-gray-700">Token:</div>
              <code className="block break-all bg-white p-1 rounded select-all">{created.raw}</code>
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-blue-700">Claude Code config snippet</summary>
              <pre className="mt-1 bg-white p-2 rounded overflow-auto text-xs select-all">{claudeConfig}</pre>
              <button
                onClick={() => copy(claudeConfig)}
                className="text-blue-600 hover:underline mt-1"
              >
                copy snippet
              </button>
            </details>
          </div>
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => copy(created.raw)}
              className="text-blue-600 hover:underline"
            >
              copy token
            </button>
            <button
              onClick={() => setCreated(null)}
              className="text-gray-600 hover:underline"
            >
              dismiss
            </button>
          </div>
        </div>
      )}

      {tokens.length === 0 ? (
        <p className="text-xs text-gray-500 italic">No MCP tokens yet.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {tokens.map(t => (
            <li key={t.id} className="p-2 bg-white border rounded">
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-mono">{t.id}</div>
                  {t.label && <div className="text-gray-700 mt-0.5">{t.label}</div>}
                  <div className="text-gray-500 mt-0.5">
                    created {new Date(t.created_at).toLocaleString()}
                  </div>
                  {t.last_used && (
                    <div className="text-gray-500 mt-0.5">
                      last used {new Date(t.last_used).toLocaleString()}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => onDelete(t.id)}
                  className="text-red-600 hover:underline flex-shrink-0"
                >
                  revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {err && <p className="text-red-600 mt-2 text-xs">{err}</p>}
    </div>
  )
}
