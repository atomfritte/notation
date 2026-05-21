import type { Entry } from '../lib/api'

type Props = {
  entries: Entry[]
  current: string
  onSelect: (path: string) => void
  depth?: number
}

export function FileTree({ entries, current, onSelect, depth = 0 }: Props) {
  if (entries.length === 0 && depth === 0) {
    return <p className="text-sm text-gray-500 italic">(empty)</p>
  }
  return (
    <ul className="text-sm">
      {entries.map(e => (
        <li key={e.path}>
          {e.is_dir ? (
            <>
              <div className="text-gray-600 py-0.5" style={{ paddingLeft: depth * 12 }}>
                <span className="opacity-60">📁</span> {e.name}
              </div>
              {e.children && (
                <FileTree entries={e.children} current={current} onSelect={onSelect} depth={depth + 1} />
              )}
            </>
          ) : (
            <button
              onClick={() => onSelect(e.path)}
              className={
                'text-left w-full hover:bg-gray-100 py-0.5 rounded ' +
                (current === e.path ? 'bg-blue-100 text-blue-900' : '')
              }
              style={{ paddingLeft: depth * 12 + 4 }}
            >
              <span className="opacity-60">📄</span> {e.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
