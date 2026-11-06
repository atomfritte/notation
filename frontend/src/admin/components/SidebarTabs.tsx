import {
  Bookmark, Folder, Share2, Plug, GitCommit, ShieldCheck, MessageSquare, X,
} from 'lucide-react'

export type SidebarTabKey = 'files' | 'bookmarks' | 'comments' | 'shares' | 'mcp' | 'history' | 'audit'

type TabDef = { key: SidebarTabKey; icon: React.ReactNode; label: string; title: string }

/** The everyday sections: always visible as tabs. */
export const PRIMARY_TABS: TabDef[] = [
  { key: 'files',     icon: <Folder size={14} />,        label: 'Pages',     title: 'Pages' },
  { key: 'bookmarks', icon: <Bookmark size={14} />,      label: 'Favorites', title: 'Favorites' },
  { key: 'comments',  icon: <MessageSquare size={14} />, label: 'Comments',  title: 'All comments' },
]

/** Space administration: opened from the Space menu ("Manage"), shown with a way back. */
export const MANAGE_TABS: TabDef[] = [
  { key: 'shares',  icon: <Share2 size={16} />,      label: 'Sharing',       title: 'Sharing & guest links' },
  { key: 'mcp',     icon: <Plug size={16} />,        label: 'Integration',   title: 'Integration (MCP)' },
  { key: 'history', icon: <GitCommit size={16} />,   label: 'Space history', title: 'Space history' },
  { key: 'audit',   icon: <ShieldCheck size={16} />, label: 'Activity log',  title: 'Activity log' },
]

type Props = {
  active: SidebarTabKey
  onPick: (k: SidebarTabKey) => void
  /** Counts shown as small badges on the tabs. Missing or zero hide the badge. */
  badges?: Partial<Record<SidebarTabKey, number>>
  /** Room for every label; otherwise only the active tab is spelled out. */
  wide?: boolean
}

/**
 * The sidebar's section switcher.
 *
 * Pages, Favorites and Comments are a visible segmented control — no hidden
 * list to discover. The administrative sections (sharing, integration, space
 * history, activity) live in the Space menu; while one is open, this row shows
 * its title and a button back to the pages.
 */
export function SidebarTabs({ active, onPick, badges, wide = false }: Props) {
  const manage = MANAGE_TABS.find(t => t.key === active)
  if (manage) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[var(--notation-bg-alt)] text-sm font-medium">
        <span className="text-[var(--notation-fg-muted)] flex-shrink-0">{manage.icon}</span>
        <span className="flex-1 min-w-0 truncate">{manage.title}</span>
        <button
          onClick={() => onPick('files')}
          className="p-1 -mr-1 rounded text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-border)]"
          title="Back to pages"
          aria-label="Back to pages"
        >
          <X size={14} />
        </button>
      </div>
    )
  }
  return (
    <div role="tablist" aria-label="Sidebar" className="flex gap-0.5 p-0.5 rounded-lg bg-[var(--notation-bg-alt)]">
      {PRIMARY_TABS.map(t => {
        const sel = t.key === active
        const count = badges?.[t.key] ?? 0
        const showLabel = wide || sel
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={sel}
            aria-label={count > 0 ? `${t.label} (${count})` : t.label}
            onClick={() => onPick(t.key)}
            title={t.title}
            className={
              `${showLabel ? 'flex-[2]' : 'flex-1'} min-w-0 flex items-center justify-center gap-1.5 px-1.5 py-1 rounded-md text-[12.5px] font-medium transition-colors ` +
              (sel
                ? 'bg-[var(--notation-bg-elevated)] text-[var(--notation-fg)] shadow-sm'
                : 'text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]')
            }
          >
            <span className="flex-shrink-0">{t.icon}</span>
            {showLabel && <span className="truncate">{t.label}</span>}
            {count > 0 && (
              <span
                className="flex-shrink-0 text-[10px] font-bold px-1 rounded-full bg-[color:var(--notation-accent-15)] text-[color:var(--notation-accent-text)]"
                aria-label={`${count} item${count === 1 ? '' : 's'}`}
              >
                {count > 99 ? '99+' : count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
