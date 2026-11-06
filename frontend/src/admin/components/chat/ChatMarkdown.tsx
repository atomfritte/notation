import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { remarkWikiLink } from '../../lib/remarkWikiLink'
import { buildFileIndex, resolveTarget } from '../../lib/wikiLinks'

/**
 * Markdown for the assistant's replies.
 *
 * Deliberately stricter than the page renderer: no raw HTML at all (no
 * rehype-raw, so a reply can't smuggle markup in), the default sanitize schema,
 * and links that either open a page of this Space in the main view or go to an
 * http(s) site in a new tab. Anything else renders as plain text.
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  files,
  onOpenPage,
}: {
  text: string
  files: string[]
  onOpenPage: (path: string) => void
}) {
  const index = useMemo(() => buildFileIndex(files), [files])
  return (
    <div className="chat-md prose prose-sm prose-zinc dark:prose-invert max-w-none break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikiLink]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) => {
            if (href && /^https?:\/\//i.test(href)) {
              return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
            }
            let target: string | null = null
            if (href?.startsWith('?')) {
              const f = new URL(href, 'http://_/').searchParams.get('file')
              if (f) {
                const r = resolveTarget(index, '', f, false)
                if (r.exists) target = r.path
              }
            } else if (href && !href.includes(':') && !href.startsWith('#') && !href.startsWith('//')) {
              // A plain relative link to a Space file: `[x](notes/a.md)`.
              const r = resolveTarget(index, '', href.split('#')[0], true)
              if (r.exists) target = r.path
            }
            if (!target) return <span className="wiki-link-broken" title="Not a page in this Space">{children}</span>
            const t = target
            return (
              <a
                href={`?file=${encodeURIComponent(t)}`}
                className="wiki-link"
                title={t}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                  e.preventDefault()
                  onOpenPage(t)
                }}
              >
                {children}
              </a>
            )
          },
          // Tables scroll inside the narrow panel instead of overflowing it.
          table: ({ children }) => (
            <div className="overflow-x-auto"><table>{children}</table></div>
          ),
          img: ({ alt }) => <span className="text-[var(--notation-fg-muted)]">[{alt || 'image'}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
