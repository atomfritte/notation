import { useEffect, useRef, useState } from 'react'
import {
  Check, ChevronRight, CircleAlert, CircleSlash, FileText, FolderTree, Loader2, MoveRight,
  PencilLine, Search, Sparkles, Trash2, Undo2, X, FilePlus2, BookOpen,
} from 'lucide-react'
import type { ToolRecord } from '../../lib/ai/chatStore'

type Kind = ToolRecord['kind']

function KindIcon({ kind, size = 13 }: { kind: Kind; size?: number }) {
  switch (kind) {
    case 'read': return <FileText size={size} />
    case 'list': return <FolderTree size={size} />
    case 'search': return <Search size={size} />
    case 'write': return <FilePlus2 size={size} />
    case 'edit': return <PencilLine size={size} />
    case 'move': return <MoveRight size={size} />
    case 'delete': return <Trash2 size={size} />
    default: return <BookOpen size={size} />
  }
}

const isChange = (k: Kind) => k === 'write' || k === 'edit' || k === 'move' || k === 'delete'

/** A unified diff, coloured per line. */
export function DiffBlock({ diff, maxHeight = 320 }: { diff: string; maxHeight?: number }) {
  return (
    <pre
      className="chat-diff text-[11.5px] leading-[1.45] font-mono overflow-auto rounded-md border border-[var(--notation-border)] bg-[var(--notation-code-bg,var(--notation-bg-alt))] py-1"
      style={{ maxHeight }}
    >
      {diff.split('\n').map((line, i) => {
        const c = line[0]
        const cls =
          c === '+' ? 'chat-diff-add' :
          c === '-' ? 'chat-diff-del' :
          c === '@' ? 'chat-diff-hunk' : ''
        return <div key={i} className={`px-2 whitespace-pre-wrap break-all ${cls}`}>{line || ' '}</div>
      })}
    </pre>
  )
}

function Counts({ r }: { r: Pick<ToolRecord, 'added' | 'removed'> }) {
  if (!r.added && !r.removed) return null
  return (
    <span className="ml-auto pl-2 flex-shrink-0 font-mono text-[10.5px]">
      {r.added ? <span className="text-[var(--notation-success)]">+{r.added}</span> : null}
      {r.added && r.removed ? ' ' : null}
      {r.removed ? <span className="text-[var(--notation-danger)]">−{r.removed}</span> : null}
    </span>
  )
}

/** A finished (or running) tool call. Reads are one quiet line; changes expand to their diff. */
export function ToolCard({
  record,
  running,
  name,
  canUndo,
  onUndo,
  onOpen,
}: {
  record?: ToolRecord
  running: boolean
  name: string
  canUndo: boolean
  onUndo: () => Promise<void>
  onOpen?: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [undoErr, setUndoErr] = useState<string | null>(null)

  if (!record) {
    return (
      <div className="flex items-center gap-1.5 text-[12px] text-[var(--notation-fg-muted)] py-0.5">
        {running ? <Loader2 size={13} className="animate-spin" /> : <CircleSlash size={13} />}
        <span className="truncate">{running ? toolVerb(name) : `${name} (not run)`}</span>
      </div>
    )
  }

  const change = isChange(record.kind)
  const failed = record.status === 'error'
  const rejected = record.status === 'rejected'
  const cancelled = record.status === 'cancelled'

  if (!change) {
    return (
      <div
        className={`flex items-center gap-1.5 text-[12px] py-0.5 min-w-0 ${failed ? 'text-[var(--notation-danger)]' : 'text-[var(--notation-fg-muted)]'}`}
        title={record.summary}
      >
        {failed ? <CircleAlert size={13} className="flex-shrink-0" /> : <KindIcon kind={record.kind} />}
        {record.path && onOpen && !failed && record.kind === 'read' ? (
          <button className="truncate hover:underline text-left" onClick={() => onOpen(record.path!)}>{record.summary}</button>
        ) : (
          <span className="truncate">{record.summary}</span>
        )}
      </div>
    )
  }

  const tone = failed || rejected || cancelled || record.undone
    ? 'border-[var(--notation-border)] opacity-80'
    : 'border-[color:var(--notation-accent-30)]'

  return (
    <div className={`rounded-lg border ${tone} bg-[var(--notation-bg)] my-1 overflow-hidden`}>
      <button
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] text-left hover:bg-[var(--notation-bg-alt)]"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <ChevronRight size={13} className={`flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <KindIcon kind={record.kind} />
        <span className={`truncate ${record.undone || rejected ? 'line-through' : ''}`}>{record.summary}</span>
        <Counts r={record} />
      </button>
      <div className="flex items-center gap-2 px-2.5 pb-1.5 text-[11px] text-[var(--notation-fg-muted)]">
        {record.undone ? <span>Undone</span>
          : failed ? <span className="text-[var(--notation-danger)]">Failed</span>
          : rejected ? <span>Rejected{record.note ? ` — “${record.note}”` : ''}</span>
          : cancelled ? <span>Not applied (stopped)</span>
          : <span className="flex items-center gap-1 text-[var(--notation-success)]"><Check size={11} /> Applied{record.auto ? ' automatically' : ''}</span>}
        {record.status === 'done' && !record.undone && record.kind !== 'delete' && record.path && onOpen && (
          <button className="hover:text-[var(--notation-fg)] hover:underline" onClick={() => onOpen(record.to ?? record.path!)}>Open</button>
        )}
        {canUndo && !record.undone && (
          <button
            className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--notation-bg-alt)] hover:text-[var(--notation-fg)] disabled:opacity-50"
            disabled={undoing}
            onClick={async () => {
              setUndoing(true)
              setUndoErr(null)
              try { await onUndo() } catch (e) { setUndoErr((e as Error).message) } finally { setUndoing(false) }
            }}
          >
            {undoing ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />} Undo
          </button>
        )}
      </div>
      {undoErr && <div className="px-2.5 pb-1.5 text-[11px] text-[var(--notation-danger)]">Undo failed: {undoErr}</div>}
      {open && record.diff && <div className="px-2 pb-2"><DiffBlock diff={record.diff} /></div>}
    </div>
  )
}

function toolVerb(name: string): string {
  switch (name) {
    case 'read_file': return 'Reading…'
    case 'list_files': case 'space_map': return 'Looking around…'
    case 'search': return 'Searching…'
    case 'write_file': case 'edit_file': return 'Preparing a change…'
    case 'move_file': return 'Preparing a move…'
    case 'delete_file': return 'Preparing a deletion…'
    case 'load_skill': return 'Loading a skill…'
    default: return 'Working…'
  }
}

/** The change Claude wants to make, waiting for the user's decision. */
export function ApprovalCard({
  record,
  onDecide,
}: {
  record: Omit<ToolRecord, 'status'>
  onDecide: (d: { approve: true; always?: boolean } | { approve: false; note?: string }) => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const applyRef = useRef<HTMLButtonElement>(null)
  const noteRef = useRef<HTMLInputElement>(null)
  useEffect(() => { applyRef.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => { if (rejecting) noteRef.current?.focus() }, [rejecting])

  const danger = record.kind === 'delete'
  return (
    <div
      className="rounded-lg border-2 border-[color:var(--notation-accent-50)] bg-[var(--notation-bg)] my-1.5 overflow-hidden shadow-sm animate-in fade-in duration-150"
      role="group"
      aria-label="Change waiting for your approval"
    >
      <div className="flex items-center gap-1.5 px-2.5 py-2 text-[12.5px] font-medium">
        <Sparkles size={13} className="text-[color:var(--notation-accent)] flex-shrink-0" />
        <KindIcon kind={record.kind} />
        <span className="truncate">{record.summary}</span>
        <Counts r={record} />
      </div>
      {record.diff && <div className="px-2"><DiffBlock diff={record.diff} maxHeight={360} /></div>}
      {!rejecting ? (
        <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2">
          <button
            ref={applyRef}
            onClick={() => onDecide({ approve: true })}
            className={`px-3 py-1 rounded-md text-[12.5px] font-medium text-[var(--notation-fg-on-accent,#fff)] ${danger ? 'bg-[var(--notation-danger)]' : 'bg-[color:var(--notation-accent)]'} hover:opacity-90`}
          >
            {danger ? 'Delete' : 'Apply'}
          </button>
          <button
            onClick={() => setRejecting(true)}
            className="px-3 py-1 rounded-md text-[12.5px] border border-[var(--notation-border)] hover:bg-[var(--notation-bg-alt)]"
          >
            Reject…
          </button>
          <button
            onClick={() => onDecide({ approve: true, always: true })}
            className="ml-auto px-2 py-1 rounded-md text-[11.5px] text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)]"
            title="Apply this and every further change in this chat without asking (until you reload)"
          >
            Apply all in this chat
          </button>
        </div>
      ) : (
        <form
          className="flex items-center gap-1.5 px-2.5 py-2"
          onSubmit={(e) => { e.preventDefault(); onDecide({ approve: false, note }) }}
        >
          <input
            ref={noteRef}
            value={note}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setRejecting(false) } }}
            placeholder="What should Claude do instead? (optional)"
            className="flex-1 min-w-0 px-2 py-1 text-[12.5px] rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)] outline-none focus:border-[color:var(--notation-accent)]"
          />
          <button type="submit" className="px-2.5 py-1 rounded-md text-[12.5px] border border-[var(--notation-border)] hover:bg-[var(--notation-bg-alt)] flex items-center gap-1">
            <X size={12} /> Reject
          </button>
        </form>
      )}
    </div>
  )
}
