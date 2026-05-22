import { useEffect, useState, useRef, type Dispatch, type SetStateAction } from 'react'
import { ChevronRight, ChevronDown, FileText, Folder, FolderOpen } from 'lucide-react'
import type { Entry } from '../lib/api'

/**
 * MIME label for internal drag-and-drop within the FileTree. A drag whose
 * dataTransfer.types contains this string is a tree-internal move (one row
 * being dragged onto a directory). External browser drags (image files,
 * downloads, Ã¢â‚¬Â¦) won't carry it, so they're routed to the upload path
 * instead.
 */
const INTERNAL_DRAG_TYPE = 'application/x-notation-path'

type Props = {
  entries: Entry[]
  current: string
  onSelect: (path: string) => void
  /** Right-click on a file or directory row. */
  onContextMenu?: (e: React.MouseEvent, path: string, isDir: boolean) => void
  /** Right-click on the empty area / inside the tree-area background. */
  onBackgroundContextMenu?: (e: React.MouseEvent) => void
  /** Internal drag: file/folder dropped onto a directory or onto root. */
  onMove?: (fromPath: string, toDir: string) => void
  /** External drag: browser file(s) dropped onto a directory or onto root. */
  onExternalDrop?: (files: FileList, toDir: string) => void
  /** localStorage key for persisting the collapsed-folders map. Optional;
   *  if omitted the state stays in-memory only. */
  collapseStorageKey?: string
  depth?: number
}

/**
 * FileTree Ã¢â‚¬â€ Windows-Explorer-style file & folder navigator.
 *
 * Features:
 *   - Click row to open file; click chevron OR row to toggle dir
 *   - Right-click any row Ã¢â€ â€™ onContextMenu(e, path, isDir)
 *   - Right-click empty area Ã¢â€ â€™ onBackgroundContextMenu(e)
 *   - Drag a file/folder onto another directory Ã¢â€ â€™ onMove
 *   - Drop browser files onto a directory Ã¢â€ â€™ onExternalDrop
 *   - Visual highlight on the active drop target
 *
 * Drag-and-drop semantics: the dragged row sets a small JSON payload on
 * `application/x-notation-path`; directory rows that receive a dragover
 * test the dataTransfer.types list to decide between move and upload.
 * Directories refuse drops onto themselves or onto their own subtree
 * (the source-path-is-prefix-of-target-path guard).
 */
export function FileTree({
  entries,
  current,
  onSelect,
  onContextMenu,
  onBackgroundContextMenu,
  onMove,
  onExternalDrop,
  collapseStorageKey,
  depth = 0,
}: Props) {
  // Single per-tree-instance "which row is the active drop target" state.
  // Lifted here so siblings can de-highlight each other when the cursor
  // crosses between them.
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  // Collapsed-folders map. Only the root instance bothers with localStorage;
  // nested recursive instances skip the persistence wiring (they get a fresh
  // empty map and never write back), since the root already covers the whole
  // tree.
  const isRoot = depth === 0
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (!isRoot || !collapseStorageKey || typeof window === 'undefined') return {}
    try {
      const raw = localStorage.getItem(collapseStorageKey)
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })
  useEffect(() => {
    if (!isRoot || !collapseStorageKey) return
    try { localStorage.setItem(collapseStorageKey, JSON.stringify(collapsed)) }
    catch { /* quota error etc. — not fatal */ }
  }, [collapsed, collapseStorageKey, isRoot])

  function toggle(path: string) {
    setCollapsed(prev => ({ ...prev, [path]: !prev[path] }))
  }

  if (entries.length === 0 && depth === 0) {
    return (
      <div
        onContextMenu={onBackgroundContextMenu}
        onDrop={(e) => {
          e.preventDefault()
          setDropTarget(null)
          if (e.dataTransfer.files.length > 0 && onExternalDrop) {
            onExternalDrop(e.dataTransfer.files, '')
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        className="text-sm text-zinc-500 dark:text-zinc-400 px-3 py-6 italic text-center hover:bg-zinc-100/50 dark:hover:bg-zinc-800/20 rounded-md mx-2"
      >
        No pages Ã¢â‚¬â€ right-click or drop files here.
      </div>
    )
  }

  // Root-level <ul> doubles as the background drop target so external files
  // dragged onto the empty area below the last row land at the Space root.
  // Nested levels skip the background-drop wiring; bubbling lets the root
  // catch them. (isRoot already declared earlier for the collapse-storage
  // wiring — reuse here.)

  return (
    <ul
      className="text-sm select-none"
      onContextMenu={isRoot ? (e) => {
        // Only fire background-context-menu when the click really hit the
        // <ul>/<li> chrome Ã¢â‚¬â€ row buttons stopPropagation in their own
        // onContextMenu handlers, so this catches strictly the empty space.
        if (e.target === e.currentTarget) onBackgroundContextMenu?.(e)
      } : undefined}
      onDragOver={isRoot ? (e) => {
        // Allow external file drops onto the empty padding below the tree.
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      } : undefined}
      onDrop={isRoot ? (e) => {
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        if (e.dataTransfer.files.length > 0 && onExternalDrop) {
          onExternalDrop(e.dataTransfer.files, '')
        }
      } : undefined}
    >
      {entries.map(e => (
        e.is_dir
          ? <DirRow
              key={e.path}
              entry={e}
              current={current}
              depth={depth}
              collapsed={!!collapsed[e.path]}
              onToggle={() => toggle(e.path)}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              onBackgroundContextMenu={onBackgroundContextMenu}
              onMove={onMove}
              onExternalDrop={onExternalDrop}
              dropTarget={dropTarget}
              setDropTarget={setDropTarget}
            />
          : <FileRow
              key={e.path}
              entry={e}
              current={current}
              depth={depth}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
      ))}
    </ul>
  )
}

// ---- Row components ----------------------------------------------------

function FileRow({
  entry, current, depth, onSelect, onContextMenu,
}: {
  entry: Entry
  current: string
  depth: number
  onSelect: (path: string) => void
  onContextMenu?: (e: React.MouseEvent, path: string, isDir: boolean) => void
}) {
  const isActive = current === entry.path

  return (
    <li>
      <button
        onClick={() => onSelect(entry.path)}
        onContextMenu={(evt) => {
          evt.stopPropagation()
          onContextMenu?.(evt, entry.path, false)
        }}
        draggable
        onDragStart={(evt) => {
          evt.dataTransfer.setData(INTERNAL_DRAG_TYPE, entry.path)
          evt.dataTransfer.setData('text/plain', entry.path)
          evt.dataTransfer.effectAllowed = 'move'
        }}
        className={`flex items-center gap-2 w-full text-left py-1.5 px-2 rounded-md transition-colors ${
          isActive
            ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100 font-medium'
            : 'text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-200'
        }`}
        style={{ paddingLeft: depth * 12 + 28 }}
        title={entry.path}
      >
        <FileText size={14} className={isActive ? 'text-[color:var(--notation-accent)]' : 'opacity-70'} />
        <span className="truncate">{entry.name.replace(/\.md$/i, '')}</span>
      </button>
    </li>
  )
}

function DirRow({
  entry, current, depth, collapsed, onToggle,
  onSelect, onContextMenu, onBackgroundContextMenu,
  onMove, onExternalDrop,
  dropTarget, setDropTarget,
}: {
  entry: Entry
  current: string
  depth: number
  collapsed: boolean
  onToggle: () => void
  onSelect: (path: string) => void
  onContextMenu?: (e: React.MouseEvent, path: string, isDir: boolean) => void
  onBackgroundContextMenu?: (e: React.MouseEvent) => void
  onMove?: (from: string, toDir: string) => void
  onExternalDrop?: (files: FileList, toDir: string) => void
  dropTarget: string | null
  setDropTarget: Dispatch<SetStateAction<string | null>>
}) {
  const isDropTarget = dropTarget === entry.path
  const dragDepthRef = useRef(0)

  function handleDragOver(e: React.DragEvent) {
    const types = e.dataTransfer.types
    const isInternal = types.includes(INTERNAL_DRAG_TYPE)
    const isExternal = types.includes('Files')
    if (!isInternal && !isExternal) return
    if (isInternal) {
      // Block dropping a dir onto itself or its own subtree.
      const fromPath = e.dataTransfer.getData(INTERNAL_DRAG_TYPE) // empty in dragover events; we filter again on drop
      if (fromPath && (fromPath === entry.path || entry.path.startsWith(fromPath + '/'))) return
    }
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = isExternal ? 'copy' : 'move'
    setDropTarget(entry.path)
  }

  function handleDragEnter(e: React.DragEvent) {
    dragDepthRef.current++
    handleDragOver(e)
  }

  function handleDragLeave(_e: React.DragEvent) {
    dragDepthRef.current--
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0
      setDropTarget(prev => prev === entry.path ? null : prev)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = 0
    setDropTarget(null)
    const fromPath = e.dataTransfer.getData(INTERNAL_DRAG_TYPE)
    if (fromPath && onMove) {
      if (fromPath === entry.path || entry.path.startsWith(fromPath + '/')) return
      onMove(fromPath, entry.path)
      return
    }
    if (e.dataTransfer.files.length > 0 && onExternalDrop) {
      onExternalDrop(e.dataTransfer.files, entry.path)
    }
  }

  return (
    <li>
      <div
        className={`flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer transition-colors ${
          isDropTarget
            ? 'bg-[color:var(--notation-accent-15)] ring-1 ring-[color:var(--notation-accent-40)] text-zinc-900 dark:text-[color:var(--notation-accent)]'
            : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300'
        }`}
        style={{ paddingLeft: depth * 12 + 8 }}
        onClick={onToggle}
        onContextMenu={(evt) => {
          evt.stopPropagation()
          onContextMenu?.(evt, entry.path, true)
        }}
        draggable
        onDragStart={(evt) => {
          evt.dataTransfer.setData(INTERNAL_DRAG_TYPE, entry.path)
          evt.dataTransfer.setData('text/plain', entry.path)
          evt.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        title={entry.path}
      >
        <div className="w-4 h-4 flex items-center justify-center rounded hover:bg-zinc-300/40 dark:hover:bg-zinc-700/50">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </div>
        {collapsed
          ? <Folder size={14} className="opacity-70" />
          : <FolderOpen size={14} className="opacity-70" />}
        <span className="font-medium text-zinc-700 dark:text-zinc-300 truncate flex-1">{entry.name}</span>
      </div>
      {!collapsed && entry.children && (
        <FileTree
          entries={entry.children}
          current={current}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          onBackgroundContextMenu={onBackgroundContextMenu}
          onMove={onMove}
          onExternalDrop={onExternalDrop}
          depth={depth + 1}
        />
      )}
    </li>
  )
}
