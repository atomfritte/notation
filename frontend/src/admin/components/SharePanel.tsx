import { useCallback, useEffect, useState, type FormEvent } from 'react'
import * as api from '../lib/api'

type Permission = api.SharePermission

type Props = { spaceID: string }

/**
 * SharePanel — listing + creation + revocation of Magic-Link shares for the
 * current Space. Every state-changing call goes through the api.* helpers
 * so the X-CSRF-Token header (read from /api/auth/state into module-local
 * storage in lib/auth.ts) gets attached automatically. Raw fetch() would
 * bypass that and the backend's requireCSRF middleware would 403 us.
 */
export function SharePanel({ spaceID }: Props) {
  const [shares, setShares] = useState<api.Share[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [perm, setPerm] = useState<Permission>('read')
  const [label, setLabel] = useState('')
  const [expiresIn, setExpiresIn] = useState('')
  const [created, setCreated] = useState<api.ShareCreated | null>(null)

  const refresh = useCallback(() => {
    api.listShares(spaceID).then(setShares).catch(e => setErr(String(e)))
  }, [spaceID])

  useEffect(refresh, [refresh])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setCreated(null)
    try {
      const data = await api.createShare(spaceID, {
        permission: perm,
        label,
        expires_in: expiresIn || undefined,
      })
      setCreated(data)
      setLabel('')
      setExpiresIn('')
      refresh()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm(`Revoke share ${id}?`)) return
    try {
      await api.deleteShare(spaceID, id)
      refresh()
    } catch (e) {
      setErr(String(e))
    }
  }

  function copy(text: string) {
    void navigator.clipboard?.writeText(text).catch(() => {})
  }

  return (
    <div className="mt-4 pt-4 border-t">
      <h3 className="font-semibold text-sm mb-3">Magic Links</h3>

      <form onSubmit={onCreate} className="space-y-2 mb-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Permission</label>
          <select
            value={perm}
            onChange={e => setPerm(e.target.value as Permission)}
            className="border px-2 py-1 rounded text-sm w-full"
          >
            <option value="read">read</option>
            <option value="comment">comment</option>
            <option value="edit">edit</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Label</label>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            className="border px-2 py-1 rounded text-sm w-full"
            placeholder="optional"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Expires in</label>
          <input
            value={expiresIn}
            onChange={e => setExpiresIn(e.target.value)}
            className="border px-2 py-1 rounded text-sm w-full"
            placeholder="e.g. 168h"
          />
        </div>
        <button
          type="submit"
          className="px-3 py-1 bg-blue-600 text-white text-sm rounded w-full"
        >
          Create link
        </button>
      </form>

      {created && (
        <div className="mb-3 p-2 bg-yellow-50 border border-yellow-300 rounded text-xs">
          <p className="font-semibold text-yellow-900 mb-1">
            Save this URL now — token cannot be recovered:
          </p>
          <code className="block break-all bg-white p-2 rounded mb-2 select-all">
            {created.url}
          </code>
          <div className="flex gap-2">
            <button onClick={() => copy(created.url)} className="text-blue-600 hover:underline">
              copy
            </button>
            <button onClick={() => setCreated(null)} className="text-gray-600 hover:underline">
              dismiss
            </button>
          </div>
        </div>
      )}

      {shares.length === 0 ? (
        <p className="text-xs text-gray-500 italic">No active shares.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {shares.map(s => (
            <li key={s.id} className="p-2 bg-white border rounded">
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono">{s.id}</span>
                    <span className="px-1.5 py-0.5 bg-gray-200 rounded">{s.permission}</span>
                  </div>
                  {s.label && <div className="text-gray-700 mt-0.5">{s.label}</div>}
                  {s.expires_at && (
                    <div className="text-gray-500 mt-0.5">
                      expires {new Date(s.expires_at).toLocaleString()}
                    </div>
                  )}
                  {s.last_used && (
                    <div className="text-gray-500 mt-0.5">
                      last used {new Date(s.last_used).toLocaleString()}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => onDelete(s.id)}
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
