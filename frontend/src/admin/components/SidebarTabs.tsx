import { useState } from 'react'
import {
  Bookmark, Folder, Share2, Settings, GitCommit, ShieldCheck, ChevronDown, ChevronRight,
} from 'lucide-react'

export type SidebarTabKey = 'files' | 'bookmarks' | 'shares' | 'mcp' | 'history' | 'audit'

type TabDef = { key: SidebarTabKey; icon: React.ReactNode; label: string }

const TABS: TabDef[] = [
  { key: 'bookmarks', icon: <Bookmark size={16} />,    label: 'Bookmarks' },
  { key: 'files',     icon: <Folder size={16} />,      label: 'Pages' },
  { key: 'shares',    icon: <Share2 size={16} />,      label: 'Sharing' },
  { key: 'mcp',       icon: <Settings size={16} />,    label: 'Integration' },
  { key: 'history',   icon: <GitCommit size={16} />,   label: 'History' },
  { key: 'audit',     icon: <ShieldCheck size={16} />, label: 'Audit' },
]

type Props = {
  active: SidebarTabKey
  onPick: (k: SidebarTabKey) => void
}

/**
 * SidebarTabs â€” collapsible nav for the SpaceView sidebar.
 *
 * Collapsed (default) it shows just the active tab as a row with a chevron;
 * tapping the row expands the full list. Picking a different tab in the
 * expanded view immediately collapses back to the new active row. The
 * pattern keeps vertical real-estate free for the actual tab content,
 * which matters most on phones / narrow desktop sidebar widths.
 */
export function SidebarTabs({ active, onPick }: Props) {
  const [expanded, setExpanded] = useState(false)
  const activeTab = TABS.find(t => t.key === active) || TABS[1]

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium bg-zinc-100 dark:bg-zinc-800/60 text-[var(--notation-fg)] hover:bg-[var(--notation-border)] transition-colors"
        title="Show all sections"
      >
        {activeTab.icon}
        <span className="truncate flex-1 text-left">{activeTab.label}</span>
        <ChevronRight size={14} className="opacity-60" />
      </button>
    )
  }

  return (
    <div className="space-y-0.5">
      {TABS.map(t => {
        const isActive = t.key === active
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
                ? 'bg-zinc-200 dark:bg-zinc-800 text-[var(--notation-fg)]'
                : 'text-[var(--notation-fg-muted)] hover:bg-[var(--notation-border)] hover:text-zinc-900 dark:hover:text-zinc-300')
            }
          >
            {t.icon}
            <span className="truncate flex-1 text-left">{t.label}</span>
            {isActive && <ChevronDown size={14} className="opacity-60" />}
          </button>
        )
      })}
    </div>
  )
}
