import { useState } from 'react'
import { ChevronRight, ChevronDown, FileText } from 'lucide-react'
import type { Entry } from '../lib/api'

type Props = {
  entries: Entry[]
  current: string
  onSelect: (path: string) => void
  onContextMenu?: (e: React.MouseEvent, path: string, isDir: boolean) => void
  depth?: number
}

export function FileTree({ entries, current, onSelect, onContextMenu, depth = 0 }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const toggle = (path: string) => {
    setCollapsed(prev => ({ ...prev, [path]: !prev[path] }))
  }

  if (entries.length === 0 && depth === 0) {
    return <p className="text-sm text-zinc-600 px-3 py-2">No pages inside</p>
  }

  return (
    <ul className="text-sm select-none">
      {entries.map(e => {
        const isCollapsed = collapsed[e.path]
        const isActive = current === e.path

        if (e.is_dir) {
          return (
            <li key={e.path}>
              <div 
                className="flex items-center gap-1.5 text-zinc-400 py-1 px-2 hover:bg-zinc-800/50 rounded-md cursor-pointer transition-colors"
                style={{ paddingLeft: depth * 12 + 8 }}
                onClick={() => toggle(e.path)}
              >
                <div className="w-4 h-4 flex items-center justify-center rounded hover:bg-zinc-700/50">
                   {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </div>
                <span className="font-medium text-zinc-300 truncate">{e.name}</span>
              </div>
              {!isCollapsed && e.children && (
                <FileTree entries={e.children} current={current} onSelect={onSelect} depth={depth + 1} />
              )}
            </li>
          )
        }

        return (
          <li key={e.path}>
            <button
              onClick={() => onSelect(e.path)}
              onContextMenu={(evt) => onContextMenu?.(evt, e.path, false)}
              className={`flex items-center gap-2 w-full text-left py-1.5 px-2 rounded-md transition-colors ${
                isActive 
                  ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100 font-medium' 
                  : 'text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-200'
              }`}
              style={{ paddingLeft: depth * 12 + (e.is_dir ? 8 : 28) }}
            >
              <FileText size={14} className={isActive ? 'text-[#BFF355]' : 'opacity-70'} />
              <span className="truncate">{e.name.replace(/\.md$/i, '')}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
