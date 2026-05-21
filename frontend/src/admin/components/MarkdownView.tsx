import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeRaw from 'rehype-raw'
import { Link, useLocation } from 'react-router-dom'
import { remarkWikiLink } from '../lib/remarkWikiLink'

type Props = { content: string }

/**
 * MarkdownView renders Markdown with three deep-link behaviors:
 *
 *   1. Headings get id="slug" via rehype-slug, then rehype-autolink-headings
 *      wraps each heading in <a href="#slug"> so visitors can copy a permalink
 *      by clicking the heading.
 *   2. Wiki-style [[file]] and [[file#section]] links are rewritten by
 *      remarkWikiLink into ?file=<path>#<anchor> hrefs.
 *   3. The custom `a` component intercepts every link click and routes it
 *      through React Router, preserving the SPA pathname while updating the
 *      ?file and #hash parts. After a navigation, the effect below scrolls the
 *      pane to the new anchor (smooth) or to the top (instant) on file change.
 */
export function MarkdownView({ content }: Props) {
  const location = useLocation()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    if (!location.hash) {
      ref.current.scrollTo({ top: 0 })
      return
    }
    const id = decodeURIComponent(location.hash.slice(1))
    // requestAnimationFrame waits for the markdown to be in the DOM.
    const frame = requestAnimationFrame(() => {
      const el = ref.current?.querySelector(`[id="${CSS.escape(id)}"]`)
      if (el && 'scrollIntoView' in el) {
        ;(el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [location.hash, content])

  return (
    <div ref={ref} className="flex-1 overflow-y-auto">
      <article className="prose prose-slate max-w-3xl mx-auto p-8">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkWikiLink]}
          rehypePlugins={[
            rehypeRaw,
            rehypeSlug,
            [rehypeAutolinkHeadings, { behavior: 'wrap' }],
          ]}
          components={{
            a: ({ href, children, className, ...rest }) => {
              if (!href) {
                return (
                  <a className={className} {...rest}>
                    {children}
                  </a>
                )
              }
              if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
                return (
                  <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
                    {children}
                  </a>
                )
              }
              if (href.startsWith('#')) {
                return (
                  <Link
                    to={{ pathname: location.pathname, search: location.search, hash: href }}
                    className={className}
                  >
                    {children}
                  </Link>
                )
              }
              if (href.startsWith('?')) {
                const url = new URL(href, 'http://_/')
                return (
                  <Link
                    to={{ pathname: location.pathname, search: url.search, hash: url.hash }}
                    className={className}
                  >
                    {children}
                  </Link>
                )
              }
              if (href.startsWith('/')) {
                return (
                  <Link to={href} className={className}>
                    {children}
                  </Link>
                )
              }
              // Relative path → treat as a file reference inside the current Space.
              const cleaned = href.replace(/^\.\//, '')
              const [path, anchor] = cleaned.split('#')
              return (
                <Link
                  to={{
                    pathname: location.pathname,
                    search: `?file=${encodeURIComponent(path)}`,
                    hash: anchor ? '#' + anchor : '',
                  }}
                  className={className}
                >
                  {children}
                </Link>
              )
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </article>
    </div>
  )
}
