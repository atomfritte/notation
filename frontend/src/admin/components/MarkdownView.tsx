import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeRaw from 'rehype-raw'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import { Link, useLocation } from 'react-router-dom'
import { remarkWikiLink } from '../lib/remarkWikiLink'
import { Mermaid } from './Mermaid'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github-dark.css'

type Props = {
  content: string
  /** theme drives Mermaid + KaTeX coloring; defaults to dark since the app does too */
  theme?: 'light' | 'dark'
}

/**
 * MarkdownView renders Markdown with five deep-link/rich-content behaviors:
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
 *   4. ```mermaid code blocks render as SVG diagrams (lazy-loaded mermaid lib).
 *   5. $inline$ and $$block$$ math render via KaTeX; other code blocks get
 *      syntax-highlighted by highlight.js.
 */
export function MarkdownView({ content, theme = 'dark' }: Props) {
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
      <article className="prose prose-zinc dark:prose-invert max-w-3xl mx-auto p-8">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, remarkWikiLink]}
          rehypePlugins={[
            rehypeRaw,
            rehypeSlug,
            [rehypeAutolinkHeadings, { behavior: 'wrap' }],
            rehypeKatex,
            [rehypeHighlight, { detect: true, ignoreMissing: true }],
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
            code({ className, children, ...rest }) {
              const match = /language-(\w+)/.exec(className || '')
              const lang = match?.[1]
              // Inline `code` is detected by react-markdown via parent type; here we
              // only need to special-case block-level mermaid.
              if (lang === 'mermaid') {
                return <Mermaid chart={String(children).trimEnd()} theme={theme} />
              }
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              )
            },
            pre({ className, children, ...rest }) {
              return (
                <CodeBlockWrapper className={className} {...rest}>
                  {children}
                </CodeBlockWrapper>
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

/**
 * CodeBlockWrapper adds a hover-revealed "Copy" button to every fenced code
 * block (except mermaid, which the `code` override handles before <pre> is
 * even reached). The button copies the raw code text, which we extract by
 * walking the React child tree — react-markdown nests text inside spans for
 * syntax-highlighted tokens, so a simple String() coercion would miss content.
 */
function CodeBlockWrapper({ className, children, ...rest }: { className?: string; children?: ReactNode } & React.HTMLAttributes<HTMLPreElement>) {
  const code = useMemo(() => extractText(children), [children])
  const [copied, setCopied] = useState(false)

  function copy() {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <pre className={`group relative ${className ?? ''}`} {...rest}>
      <button
        onClick={copy}
        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition px-2 py-1 text-xs bg-zinc-800 text-zinc-200 hover:bg-zinc-700 rounded shadow"
        aria-label="Copy code"
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
      {children}
    </pre>
  )
}

function extractText(node: ReactNode): string {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode }
    return Children.toArray(props.children).map(extractText).join('')
  }
  return ''
}
