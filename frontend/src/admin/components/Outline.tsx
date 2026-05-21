import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { List } from 'lucide-react'

type Heading = { level: number; text: string; id: string }

type Props = { content: string }

/**
 * Outline / table-of-contents for the current Markdown file. Headings are
 * parsed from the source (skipping fenced code blocks). Slugging mirrors
 * github-slugger / rehype-slug's default so clicking an entry navigates to
 * the matching anchor that rehype-slug generated in the rendered DOM.
 *
 * Active highlight: an IntersectionObserver watches the rendered heading
 * elements; whichever heading is closest to the top of the viewport is
 * marked active. URL-hash changes (from clicking an entry) take precedence.
 */
export function Outline({ content }: Props) {
  const headings = useMemo(() => extractHeadings(content), [content])
  const navigate = useNavigate()
  const location = useLocation()
  const [activeFromScroll, setActiveFromScroll] = useState<string>('')

  useEffect(() => {
    if (headings.length === 0) return
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.filter(e => e.isIntersecting)
        if (visible.length === 0) return
        // Pick the topmost intersecting heading.
        const top = visible.reduce((a, b) =>
          a.boundingClientRect.top < b.boundingClientRect.top ? a : b,
        )
        setActiveFromScroll(top.target.id)
      },
      // The intersection band sits ~20%-25% from the top: feels like Notion.
      { rootMargin: '-15% 0px -75% 0px', threshold: 0 },
    )
    // The DOM nodes are mounted asynchronously after content change; give it a tick.
    const t = setTimeout(() => {
      for (const h of headings) {
        const el = document.getElementById(h.id)
        if (el) observer.observe(el)
      }
    }, 50)
    return () => {
      clearTimeout(t)
      observer.disconnect()
    }
  }, [headings])

  function jump(id: string) {
    navigate({ pathname: location.pathname, search: location.search, hash: '#' + id })
  }

  if (headings.length === 0) {
    return <div className="p-4 text-xs text-zinc-500 italic">No headings in this page yet.</div>
  }

  const minLevel = Math.min(...headings.map(h => h.level))
  const hashId = decodeURIComponent(location.hash.slice(1))
  const active = hashId || activeFromScroll

  return (
    <div className="p-3 sticky top-0">
      <h3 className="font-semibold text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wider px-2 mb-2 flex items-center gap-1">
        <List size={12} /> Outline
      </h3>
      <ul className="space-y-0.5 text-sm">
        {headings.map((h, i) => (
          <li key={i}>
            <button
              onClick={() => jump(h.id)}
              className={
                'block w-full text-left px-2 py-1 rounded-md truncate transition-colors ' +
                (active === h.id
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-[#BFF355] font-medium border-l-2 border-zinc-900 dark:border-[#BFF355] -ml-0.5 pl-[6px]'
                  : 'text-zinc-600 hover:bg-zinc-100/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-200')
              }
              style={{ paddingLeft: (h.level - minLevel) * 12 + 8 }}
              title={h.text}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function extractHeadings(md: string): Heading[] {
  const stripped = md.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '')
  const re = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm
  const counts = new Map<string, number>()
  const out: Heading[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    const level = m[1].length
    const text = m[2].replace(/`/g, '').replace(/\*+/g, '').trim()
    let slug = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/--+/g, '-')
      .replace(/^-+|-+$/g, '')
    const n = counts.get(slug) ?? 0
    counts.set(slug, n + 1)
    if (n > 0) slug = `${slug}-${n}`
    out.push({ level, text, id: slug })
  }
  return out
}
