import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, KeyboardSensor,
  useSensor, useSensors, closestCorners, pointerWithin,
  type DragStartEvent, type DragOverEvent, type DragEndEvent, type CollisionDetection,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates,
  verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useDroppable } from '@dnd-kit/core'
import { Inbox, ListTodo, Zap, Archive, Plus, GripHorizontal, ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react'
import * as api from '../lib/api'
import { SpaceCard } from './SpaceCard'

/**
 * KanbanBoard — the landing page's primary organising view. Spaces live in four
 * columns (Inbox → Backlog → Active → Archive). Drag a card by its grip handle
 * to reorder within a column or move it to another; the new column + ordering is
 * persisted to the backend (meta.json) so the board is identical on every device.
 *
 * Ordering rule: cards sort by their manual `order` ascending, tie-broken by
 * `created_at` descending. Never-dragged spaces all have order 0, so they fall
 * back to newest-first and freshly created ones float to the top of their column
 * ("alte wandern nach unten"). The moment you drag, your explicit order wins.
 *
 * The board keeps a local optimistic copy of the column→ids mapping so drags feel
 * instant; it re-syncs from the `spaces` prop whenever the server truth changes,
 * and reverts (via onRefresh) if a persist call fails.
 */

type ColumnDef = { id: api.BoardColumn; label: string; icon: LucideIcon }

const COLUMNS: ColumnDef[] = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'backlog', label: 'Backlog', icon: ListTodo },
  { id: 'active', label: 'Active', icon: Zap },
  { id: 'archive', label: 'Archive', icon: Archive },
]

const COLLAPSE_KEY = 'notation_board_collapsed'

function columnOf(s: api.Meta): api.BoardColumn {
  const st = s.status
  return st === 'backlog' || st === 'active' || st === 'archive' ? st : 'inbox'
}

// Ascending by manual order, then newest-first so untriaged (order 0) spaces and
// brand-new arrivals sit at the top of their column.
function sortCards(a: api.Meta, b: api.Meta): number {
  const oa = a.order ?? 0, ob = b.order ?? 0
  if (oa !== ob) return oa - ob
  return Date.parse(b.created_at) - Date.parse(a.created_at)
}

type Items = Record<api.BoardColumn, string[]>

function groupAndSort(list: api.Meta[]): Items {
  const out: Items = { inbox: [], backlog: [], active: [], archive: [] }
  for (const s of [...list].sort(sortCards)) out[columnOf(s)].push(s.id)
  return out
}

export function KanbanBoard({
  spaces, online, voices, onDelete, onQuickCreate, onBoardPatch, onError, onRefresh, dragEnabled = true,
}: {
  spaces: api.Meta[]
  online: boolean
  voices: api.ServerVoice[]
  onDelete: (id: string) => void
  onQuickCreate: (col: api.BoardColumn) => void
  onBoardPatch: (moves: api.BoardMove[]) => void
  onError: (msg: string) => void
  onRefresh: () => void
  dragEnabled?: boolean
}) {
  const byId = useMemo(() => {
    const m = new Map<string, api.Meta>()
    for (const s of spaces) m.set(s.id, s)
    return m
  }, [spaces])

  // Content hash of the server truth: rebuild the local mapping only when a
  // space's column/order/identity actually changes — not on every parent render
  // (which would clobber an in-flight drag).
  const signature = useMemo(
    () => spaces.map(s => `${s.id}:${s.status ?? ''}:${s.order ?? 0}:${s.created_at}`).sort().join('|'),
    [spaces],
  )
  const spacesRef = useRef(spaces)
  spacesRef.current = spaces

  const [items, setItems] = useState<Items>(() => groupAndSort(spaces))
  useEffect(() => { setItems(groupAndSort(spacesRef.current)) }, [signature])

  const [activeId, setActiveId] = useState<string | null>(null)
  const fromCol = useRef<api.BoardColumn | null>(null)

  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')) } catch { return new Set() }
  })
  function toggleCollapse(col: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(col) ? next.delete(col) : next.add(col)
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])) } catch { /* quota — ephemeral is fine */ }
      return next
    })
  }

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 12 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // Prefer pointer-within (precise for the small grip target); fall back to
  // closest-corners so dropping into an empty column still registers.
  const collision: CollisionDetection = (args) => {
    const within = pointerWithin(args)
    return within.length ? within : closestCorners(args)
  }

  function findContainer(id: string): api.BoardColumn | undefined {
    if (id in items) return id as api.BoardColumn
    return (Object.keys(items) as api.BoardColumn[]).find(col => items[col].includes(id))
  }

  function onDragStart(e: DragStartEvent) {
    const id = String(e.active.id)
    setActiveId(id)
    fromCol.current = findContainer(id) ?? null
  }

  // Live cross-column move while dragging, so the card visibly hops columns.
  function onDragOver(e: DragOverEvent) {
    const { active, over } = e
    if (!over) return
    const activeCol = findContainer(String(active.id))
    const overCol = findContainer(String(over.id))
    if (!activeCol || !overCol || activeCol === overCol) return
    setItems(prev => {
      const activeItems = prev[activeCol]
      const overItems = prev[overCol]
      const overIndex = overItems.indexOf(String(over.id))
      let newIndex: number
      if (String(over.id) in prev) {
        newIndex = overItems.length // hovering the empty column body → append
      } else {
        const translated = active.rect.current.translated
        const isBelow = translated && over.rect && translated.top > over.rect.top + over.rect.height / 2
        newIndex = overIndex >= 0 ? overIndex + (isBelow ? 1 : 0) : overItems.length
      }
      return {
        ...prev,
        [activeCol]: activeItems.filter(id => id !== String(active.id)),
        [overCol]: [...overItems.slice(0, newIndex), String(active.id), ...overItems.slice(newIndex)],
      }
    })
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    const src = fromCol.current
    setActiveId(null)
    fromCol.current = null
    if (!over) {
      // Dropped outside any target — onDragOver may already have rehomed it.
      // Persist whatever the user now sees rather than snapping back.
      if (src) persist(items, new Set([src]))
      return
    }
    const overCol = findContainer(String(over.id))
    const activeCol = findContainer(String(active.id))
    if (!activeCol || !overCol) return

    let next = items
    // True within-column reorder — only when the drag started AND ended in the
    // same column. For a cross-column move, onDragOver has already placed the card
    // in the target; running arrayMove here would double-move it to the wrong slot.
    if (src && src === overCol) {
      const list = items[overCol]
      const oldIndex = list.indexOf(String(active.id))
      const newIndex = String(over.id) in items ? list.length - 1 : list.indexOf(String(over.id))
      if (oldIndex !== -1 && newIndex >= 0 && oldIndex !== newIndex) {
        next = { ...items, [overCol]: arrayMove(list, oldIndex, newIndex) }
        setItems(next)
      }
    }
    const touched = new Set<api.BoardColumn>([overCol])
    if (src) touched.add(src)
    persist(next, touched)
  }

  async function persist(state: Items, cols: Set<api.BoardColumn>) {
    const moves: api.BoardMove[] = []
    for (const col of cols) {
      state[col].forEach((id, idx) => moves.push({ id, status: col, order: idx + 1 }))
    }
    if (!moves.length) return
    onBoardPatch(moves) // keep parent's cache in sync so view switches don't flicker
    try {
      await api.updateBoard(moves)
    } catch (err) {
      onError(String((err as Error)?.message ?? err))
      onRefresh() // re-pull server truth to undo the optimistic move
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => { setActiveId(null); fromCol.current = null }}
    >
      <div className="flex gap-4 overflow-x-auto overscroll-x-contain pb-4 snap-x snap-mandatory lg:grid lg:grid-cols-4 lg:overflow-visible lg:snap-none">
        {COLUMNS.map(col => (
          <Column
            key={col.id}
            def={col}
            ids={items[col.id]}
            byId={byId}
            online={online}
            voices={voices}
            onDelete={onDelete}
            onQuickCreate={onQuickCreate}
            collapsed={collapsed.has(col.id)}
            onToggleCollapse={() => toggleCollapse(col.id)}
            dragEnabled={dragEnabled}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeId && byId.get(activeId)
          ? <div className="w-[300px] rotate-2 opacity-90"><SpaceCard space={byId.get(activeId)!} online={online} voices={voices} onDelete={() => {}} /></div>
          : null}
      </DragOverlay>
    </DndContext>
  )
}

function Column({
  def, ids, byId, online, voices, onDelete, onQuickCreate, collapsed, onToggleCollapse, dragEnabled,
}: {
  def: ColumnDef
  ids: string[]
  byId: Map<string, api.Meta>
  online: boolean
  voices: api.ServerVoice[]
  onDelete: (id: string) => void
  onQuickCreate: (col: api.BoardColumn) => void
  collapsed: boolean
  onToggleCollapse: () => void
  dragEnabled: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: def.id })
  const Icon = def.icon
  const Chevron = collapsed ? ChevronRight : ChevronDown

  return (
    <section className="flex flex-col shrink-0 w-[82vw] max-w-[340px] snap-start lg:w-auto lg:max-w-none">
      <div className="flex items-center gap-2 px-1 mb-2">
        <button
          onClick={onToggleCollapse}
          className="p-0.5 -ml-0.5 rounded text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] transition-colors"
          aria-label={collapsed ? `Expand ${def.label}` : `Collapse ${def.label}`}
        >
          <Chevron size={16} />
        </button>
        <Icon size={15} className="text-[var(--notation-fg-muted)]" />
        <h2 className="text-sm font-semibold text-[var(--notation-fg)]">{def.label}</h2>
        <span className="text-xs font-medium text-[var(--notation-fg-muted)] tabular-nums">{ids.length}</span>
        <button
          onClick={() => onQuickCreate(def.id)}
          className="ml-auto p-1 rounded text-[var(--notation-fg-muted)] hover:text-[color:var(--notation-accent)] hover:bg-[color:var(--notation-accent-10)] transition-colors"
          title={`New space in ${def.label}`}
          aria-label={`New space in ${def.label}`}
        >
          <Plus size={15} />
        </button>
      </div>

      {!collapsed && (
        <div
          ref={setNodeRef}
          className={
            'flex flex-col gap-3 rounded-xl p-2 min-h-[120px] flex-1 border border-dashed transition-colors ' +
            (isOver
              ? 'border-[color:var(--notation-accent-40)] bg-[color:var(--notation-accent-10)]'
              : ids.length === 0 ? 'border-[var(--notation-border)]' : 'border-transparent')
          }
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {ids.map(id => {
              const space = byId.get(id)
              if (!space) return null
              return (
                <SortableSpaceCard
                  key={id}
                  space={space}
                  online={online}
                  voices={voices}
                  onDelete={() => onDelete(id)}
                  dragEnabled={dragEnabled}
                />
              )
            })}
          </SortableContext>
          {ids.length === 0 && (
            <div className="flex-1 flex items-center justify-center py-6 text-xs text-[var(--notation-fg-muted)] select-none">
              {def.id === 'inbox' ? 'New spaces land here' : 'Drop here'}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function SortableSpaceCard({
  space, online, voices, onDelete, dragEnabled,
}: {
  space: api.Meta
  online: boolean
  voices: api.ServerVoice[]
  onDelete: () => void
  dragEnabled: boolean
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: space.id,
    disabled: !dragEnabled,
  })
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }
  return (
    <div ref={setNodeRef} style={style} className="relative group/drag touch-manipulation">
      <SpaceCard space={space} online={online} voices={voices} onDelete={onDelete} />
      {dragEnabled && (
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="absolute top-1 left-1/2 -translate-x-1/2 z-30 flex items-center justify-center min-w-11 px-3 py-2 rounded-md bg-black/40 backdrop-blur-sm text-white cursor-grab active:cursor-grabbing opacity-0 group-hover/drag:opacity-100 [@media(hover:none)]:opacity-90 transition-opacity touch-none"
          title="Drag to move"
          aria-label={`Move ${space.name || space.id} — press Space, then arrow keys`}
          onClick={e => { e.preventDefault(); e.stopPropagation() }}
        >
          <GripHorizontal size={16} />
        </button>
      )}
    </div>
  )
}
