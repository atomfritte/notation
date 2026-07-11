import { useState } from 'react'
import {
  Bookmark, Folder, Share2, Settings, GitCommit, ShieldCheck, MessageSquare,
  ChevronDown, ChevronRight,
} from 'lucide-react'

export type SidebarTabKey = 'files' | 'bookmarks' | 'comments' | 'shares' | 'mcp' | 'history' | 'audit'

type TabDef = { key: SidebarTabKey; icon: React.ReactNode; label: string }

const TABS: TabDef[] = [
  { key: 'bookmarks', icon: <Bookmark size={16} />,      label: 'Bookmarks' },
  { key: 'files',     icon: <Folder size={16} />,        label: 'Pages' },
  { key: 'comments',  icon: <MessageSquare size={16} />, label: 'Comments' },
  { key: 'shares',    icon: <Share2 size={16} />,        label: 'Sharing' },
  { key: 'mcp',       icon: <Settings size={16} />,      label: 'Integration' },
  { key: 'history',   icon: <GitCommit size={16} />,     label: 'History' },
  { key: 'audit',     icon: <ShieldCheck size={16} />,   label: 'Audit' },
]

type Props = {
  active: SidebarTabKey
  onPick: (k: SidebarTabKey) => void
  /** Counts shown as small badges next to tabs that have content. Missing
   *  or zero entries hide the badge. */
  badges?: Partial<Record<SidebarTabKey, number>>
  /** Whitelist of tabs to show. Encrypted spaces pass a reduced set (the
   *  server-backed tabs — comments, sharing, integration, history, audit —
   *  don't apply). Omit to show all. */
  tabs?: SidebarTabKey[]
}

/**
 * SidebarTabs — collapsible nav for the SpaceView sidebar.
 *
 * Collapsed (default) it shows just the active tab as a row with a chevron;
 * tapping the row expands the full list. Picking a different tab in the
 * expanded view immediately collapses back to the new active row. The
 * pattern keeps vertical real-estate free for the actual tab content,
 * which matters most on phones / narrow desktop sidebar widths.
 *
 * Badge counts (Comments, Bookmarks) ride alongside the label in both the
 * collapsed-single-row and the expanded-full-list states.
 */
export function SidebarTabs({ active, onPick, badges, tabs }: Props) {
  const [expanded, setExpanded] = useState(false)
  const visibleTabs = tabs ? TABS.filter(t => tabs.includes(t.key)) : TABS
  const activeTab = visibleTabs.find(t => t.key === active) || visibleTabs[0] || TABS[1]
  const activeBadge = badges?.[active] ?? 0

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium bg-[var(--notation-border)] text-[var(--notation-fg)] hover:opacity-90 transition-opacity"
        title="Show all sections"
      >
        {activeTab.icon}
        <span className="truncate flex-1 text-left">{activeTab.label}</span>
        {activeBadge > 0 && <Badge count={activeBadge} />}
        <ChevronRight size={14} className="opacity-60" />
      </button>
    )
  }

  return (
    <div className="space-y-0.5">
      {visibleTabs.map(t => {
        const isActive = t.key === active
        const count = badges?.[t.key] ?? 0
        return (
          <button
            key={t.key}
            onClick={() => {
              onPick(t.key)
              setExpanded(false)
            }}
            className={
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ' +
              (isActive
                ? 'bg-[var(--notation-border)] text-[var(--notation-fg)]'
                : 'text-[var(--notation-fg-muted)] hover:bg-[var(--notation-border)] hover:text-[var(--notation-fg)]')
            }
          >
            {t.icon}
            <span className="truncate flex-1 text-left">{t.label}</span>
            {count > 0 && <Badge count={count} />}
            {isActive && <ChevronDown size={14} className="opacity-60" />}
          </button>
        )
      })}
    </div>
  )
}

function Badge({ count }: { count: number }) {
  return (
    <span
      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[color:var(--notation-accent-15)] text-[color:var(--notation-accent)] min-w-[1.25rem] text-center"
      aria-label={`${count} item${count === 1 ? '' : 's'}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
