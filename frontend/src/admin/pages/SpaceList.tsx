import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import * as api from '../lib/api'

export function SpaceList() {
  const [spaces, setSpaces] = useState<api.Meta[]>([])
  const [me, setMe] = useState<{ name: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [newID, setNewID] = useState('')
  const [newName, setNewName] = useState('')

  function refresh() {
    api.listSpaces().then(setSpaces).catch(e => setErr(String(e)))
  }

  useEffect(() => {
    refresh()
    api.me().then(setMe).catch(() => {})
  }, [])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      await api.createSpace(newID, newName || undefined)
      setNewID('')
      setNewName('')
      refresh()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm(`Delete space "${id}" and all its files? This cannot be undone.`)) return
    try {
      await api.deleteSpace(id)
      refresh()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <header className="flex justify-between items-center mb-8">
        <h1 className="text-2xl font-bold">notation</h1>
        {me && <span className="text-sm text-gray-500">signed in as {me.name}</span>}
      </header>

      <section className="mb-10">
        <h2 className="text-lg font-semibold mb-3">Spaces</h2>
        <ul className="divide-y border rounded">
          {spaces.length === 0 && (
            <li className="p-4 text-gray-500 italic">No spaces yet — create one below.</li>
          )}
          {spaces.map(s => (
            <li key={s.id} className="p-3 flex justify-between items-center hover:bg-gray-50">
              <Link to={`/admin/spaces/${encodeURIComponent(s.id)}`} className="flex-1">
                <span className="font-medium text-blue-700 hover:underline">{s.name}</span>
                <span className="text-sm text-gray-500 ml-2">/{s.id}</span>
              </Link>
              <button
                onClick={() => onDelete(s.id)}
                className="text-sm text-red-600 hover:underline ml-3"
              >
                delete
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">New space</h2>
        <form onSubmit={onCreate} className="flex gap-2 items-end flex-wrap">
          <div>
            <label className="block text-xs text-gray-600 mb-1">ID (a-z 0-9 _ -)</label>
            <input
              value={newID}
              onChange={e => setNewID(e.target.value)}
              required
              pattern="[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]"
              className="border px-2 py-1 rounded"
              placeholder="my-project"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Name (optional)</label>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="border px-2 py-1 rounded"
              placeholder="My Project"
            />
          </div>
          <button type="submit" className="px-4 py-1 bg-blue-600 text-white rounded">
            Create
          </button>
        </form>
        {err && <p className="text-red-600 mt-3">{err}</p>}
      </section>
    </div>
  )
}
