import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import { MessageSquare } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { remarkWikiLink } from '../lib/remarkWikiLink'
import { Mermaid } from './Mermaid'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github-dark.css'

// Schema for rehype-sanitize. We start from the spec defaults (which strip
// <script>, on* handlers, javascript: hrefs, etc.) and add a small allowlist
// of inline HTML elements we actually want to render: <mark> for highlights,
// <details>/<summary> for collapsibles, <kbd>/<sub>/<sup> for typography.
// Without sanitize, rehype-raw passes raw HTML through unchanged → XSS.
const SAFE_TAGS = ['mark', 'details', 'summary', 'kbd', 'sub', 'sup'] as const
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...SAFE_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className', 'id'],
    a: [...(defaultSchema.attributes?.a ?? []), 'className', 'rel', 'target'],
    span: [...(defaultSchema.attributes?.span ?? []), 'className', 'style'],
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    div: [...(defaultSchema.attributes?.div ?? []), 'className'],
    mark: [...(defaultSchema.attributes?.mark ?? []), 'className', 'data-comment-id'],
    details: [...(defaultSchema.attributes?.details ?? []), 'open'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https', 'data'],
  },
}

export type AnchorPayload = { quote: string; prefix: string; suffix: string }

type CommentLite = {
  id: string
  anchor?: AnchorPayload
  // Optional preview metadata — when present, surfaced in the on-hover
  // tooltip over the rendered anchor mark. Existing callers can keep
  // passing the minimal id-only shape.
  text?: string
  author?: string
  created_at?: string
}

type Props = {
  content: string
  theme?: 'light' | 'dark'
  /** Comments with anchors are rendered as <mark> overlays on the matching text. */
  comments?: CommentLite[]
  /** Comment ID to flash/highlight (sidebar → viewer coordination). */
  activeCommentID?: string | null
  /** Called when the cursor enters/leaves an anchor mark in the viewer. */
  onHoverMark?: (id: string | null) => void
  /** Called when the user clicks an anchor mark — opens the matching comment. */
  onSelectAnchor?: (id: string) => void
  /** Called when the user selects text in the viewer and clicks the "Comment"
   *  toolbar. Receives a text-quote selector payload. */
  onNewAnchorComment?: (anchor: AnchorPayload) => void
}

export function MarkdownView({
  content,
  theme = 'dark',
  comments,
  activeCommentID,
  onHoverMark,
  onSelectAnchor,
  onNewAnchorComment,
}: Props) {
  const location = useLocation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const articleRef = useRef<HTMLElement>(null)
  const [tool, setTool] = useState<{ x: number; y: number; anchor: AnchorPayload } | null>(null)
  const [hoverTip, setHoverTip] = useState<
    { x: number; y: number; comment: CommentLite } | null
  >(null)

  // O(1) lookup from comment id → metadata so the hover handler doesn't scan
  // the array on every mouse move.
  const commentsByID = useRef<Map<string, CommentLite>>(new Map())
  useEffect(() => {
    const m = new Map<string, CommentLite>()
    for (const c of comments ?? []) m.set(c.id, c)
    commentsByID.current = m
  }, [comments])

  // Scroll to anchor on hash change or content load.
  useEffect(() => {
    if (!scrollRef.current) return
    if (!location.hash) {
      scrollRef.current.scrollTo({ top: 0 })
      return
    }
    const id = decodeURIComponent(location.hash.slice(1))
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)
      if (el && 'scrollIntoView' in el) {
        ;(el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [location.hash, content])

  // Apply / refresh anchor marks whenever content or comments change.
  useEffect(() => {
    const article = articleRef.current
    if (!article) return
    // Defer until react-markdown has flushed the DOM.
    const frame = requestAnimationFrame(() => {
      removeAnchorMarks(article)
      if (comments && comments.length > 0) applyAnchorMarks(article, comments)
    })
    return () => cancelAnimationFrame(frame)
  }, [content, comments])

  // Listen for selection changes inside the article and surface the toolbar.
  useEffect(() => {
    function update() {
      if (!onNewAnchorComment || !articleRef.current) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setTool(null)
        return
      }
      const range = sel.getRangeAt(0)
      const quote = sel.toString()
      if (quote.trim().length < 2) {
        setTool(null)
        return
      }
      if (!articleRef.current.contains(range.startContainer) || !articleRef.current.contains(range.endContainer)) {
        setTool(null)
        return
      }
      const rect = range.getBoundingClientRect()
      const container = scrollRef.current?.getBoundingClientRect()
      if (!container) return
      const anchor = buildAnchor(articleRef.current, range, quote)
      setTool({
        x: rect.right - container.left,
        y: rect.bottom - container.top + 6,
        anchor,
      })
    }
    function clear(e: MouseEvent) {
      const target = e.target as HTMLElement
      // Don't dismiss when the click is inside our floating toolbar.
      if (target.closest('.selection-toolbar')) return
      setTool(null)
    }
    document.addEventListener('selectionchange', update)
    document.addEventListener('mousedown', clear)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('mousedown', clear)
    }
  }, [onNewAnchorComment])

  // Hover / click interactions on rendered marks.
  useEffect(() => {
    const article = articleRef.current
    if (!article) return
    function onMouseOver(e: MouseEvent) {
      const t = e.target as HTMLElement
      const m = t.closest('mark.comment-anchor') as HTMLElement | null
      if (m?.dataset.commentId) {
        onHoverMark?.(m.dataset.commentId)
        // Show a quick preview of the comment text + author next to the mark
        // so the reader can skim threads without opening the sidebar.
        const c = commentsByID.current.get(m.dataset.commentId)
        if (c && c.text) {
          const rect = m.getBoundingClientRect()
          // Clamp x so the bubble never spills off the right edge.
          const maxX = Math.max(8, window.innerWidth - 360)
          setHoverTip({
            x: Math.min(rect.left, maxX),
            y: rect.bottom + 8,
            comment: c,
          })
        }
      }
    }
    function onMouseOut(e: MouseEvent) {
      const t = e.target as HTMLElement
      const m = t.closest('mark.comment-anchor')
      if (m) {
        onHoverMark?.(null)
        setHoverTip(null)
      }
    }
    function onClick(e: MouseEvent) {
      const t = e.target as HTMLElement
      const m = t.closest('mark.comment-anchor') as HTMLElement | null
      if (m?.dataset.commentId) {
        e.preventDefault()
        onSelectAnchor?.(m.dataset.commentId)
      }
    }
    article.addEventListener('mouseover', onMouseOver)
    article.addEventListener('mouseout', onMouseOut)
    article.addEventListener('click', onClick)
    return () => {
      article.removeEventListener('mouseover', onMouseOver)
      article.removeEventListener('mouseout', onMouseOut)
      article.removeEventListener('click', onClick)
    }
  }, [onHoverMark, onSelectAnchor])

  // React to activeCommentID changes: toggle `data-active` on matching marks,
  // scroll the first matching mark into view, and fire the blink animation.
  // Wrapped in rAF so that if `comments` and `activeCommentID` change in the
  // same render (e.g. brand-new comment freshly committed), the mark exists
  // before we try to highlight it.
  useEffect(() => {
    const article = articleRef.current
    if (!article) return
    const frame = requestAnimationFrame(() => {
      article.querySelectorAll<HTMLElement>('mark.comment-anchor').forEach(m => {
        m.dataset.active = m.dataset.commentId === activeCommentID ? 'true' : 'false'
      })
      if (!activeCommentID) return
      const marks = article.querySelectorAll<HTMLElement>(
        `mark.comment-anchor[data-comment-id="${CSS.escape(activeCommentID)}"]`,
      )
      if (marks.length === 0) return
      // Scroll the first matching mark roughly into the middle of the viewport.
      marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' })
      marks.forEach(m => {
        m.classList.add('comment-anchor-blink')
        window.setTimeout(() => m.classList.remove('comment-anchor-blink'), 1400)
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [activeCommentID])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto relative">
      <article ref={articleRef} className="prose prose-zinc dark:prose-invert max-w-3xl mx-auto p-4 md:p-8">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, remarkWikiLink]}
          rehypePlugins={[
            // Order matters: raw parses HTML into the AST, then sanitize
            // strips unsafe elements before downstream plugins see them.
            rehypeRaw,
            [rehypeSanitize, sanitizeSchema],
            rehypeSlug,
            [rehypeAutolinkHeadings, { behavior: 'wrap' }],
            rehypeKatex,
            [rehypeHighlight, { detect: true, ignoreMissing: true }],
          ]}
          components={{
            // Wrap every table in a div so wide tables can scroll horizontally
            // without breaking the page width, while short tables can stretch
            // their last column to fill the wrap (zebra striping extends all
            // the way to the right edge). Styling lives in shared/index.css
            // under `.prose-table-wrap`.
            table: ({ node, ...props }) => (
              <div className="prose-table-wrap">
                <table {...props} />
              </div>
            ),
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
                  <Link to={{ pathname: location.pathname, search: location.search, hash: href }} className={className}>
                    {children}
                  </Link>
                )
              }
              if (href.startsWith('?')) {
                const url = new URL(href, 'http://_/')
                return (
                  <Link to={{ pathname: location.pathname, search: url.search, hash: url.hash }} className={className}>
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

      {tool && onNewAnchorComment && (
        <div
          className="selection-toolbar"
          style={{ left: tool.x, top: tool.y }}
          onMouseDown={e => e.preventDefault()}
        >
          <button
            onClick={() => {
              onNewAnchorComment(tool.anchor)
              window.getSelection()?.removeAllRanges()
              setTool(null)
            }}
          >
            <MessageSquare size={12} /> Comment
          </button>
        </div>
      )}

      {/* Tooltip preview of the comment text when hovering an anchor mark.
          pointer-events-none so the tooltip itself never re-triggers mouseover
          / mouseout on the underlying mark; no-print so it never ends up on
          paper. */}
      {hoverTip && hoverTip.comment.text && (
        <div
          className="fixed z-50 pointer-events-none px-3 py-2 max-w-sm rounded-md shadow-lg bg-white dark:bg-zinc-900 border border-[var(--notation-border)] text-xs no-print"
          style={{ left: hoverTip.x, top: hoverTip.y }}
        >
          <div className="flex items-baseline gap-2 mb-1">
            <span className="font-semibold text-[var(--notation-fg)]">
              {hoverTip.comment.author || 'unknown'}
            </span>
            {hoverTip.comment.created_at && (
              <span className="text-[10px] text-[var(--notation-fg-muted)]">
                {formatRelative(hoverTip.comment.created_at)}
              </span>
            )}
          </div>
          <div className="text-[var(--notation-fg)] whitespace-pre-wrap break-words">
            {hoverTip.comment.text.length > 240
              ? hoverTip.comment.text.slice(0, 240) + '…'
              : hoverTip.comment.text}
          </div>
        </div>
      )}
    </div>
  )
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diffSec = Math.round((Date.now() - t) / 1000)
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`
  return new Date(t).toLocaleDateString()
}

/* ---- Anchor resolution & marking ----------------------------------------- */

const CONTEXT_LEN = 30

function buildAnchor(article: HTMLElement, range: Range, quote: string): AnchorPayload {
  const fullText = article.textContent ?? ''
  const offset = absoluteOffset(article, range.startContainer, range.startOffset)
  const prefix = fullText.slice(Math.max(0, offset - CONTEXT_LEN), offset)
  const suffix = fullText.slice(offset + quote.length, offset + quote.length + CONTEXT_LEN)
  return { quote, prefix, suffix }
}

function absoluteOffset(root: Node, node: Node, offsetInNode: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let abs = 0
  let cur = walker.nextNode()
  while (cur) {
    if (cur === node) return abs + offsetInNode
    abs += (cur.textContent ?? '').length
    cur = walker.nextNode()
  }
  // If the start container is an element, walk inside it to find the offset.
  if (node.nodeType !== Node.TEXT_NODE) {
    const childWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let c = childWalker.nextNode()
    let i = 0
    while (c && i < offsetInNode) {
      abs += (c.textContent ?? '').length
      c = childWalker.nextNode()
      i++
    }
  }
  return abs
}

function removeAnchorMarks(article: HTMLElement) {
  const marks = article.querySelectorAll('mark.comment-anchor')
  marks.forEach(m => {
    const parent = m.parentNode
    if (!parent) return
    while (m.firstChild) parent.insertBefore(m.firstChild, m)
    parent.removeChild(m)
    parent.normalize()
  })
}

function applyAnchorMarks(article: HTMLElement, comments: CommentLite[]) {
  for (const c of comments) {
    if (!c.anchor) continue
    const range = findAnchorRange(article, c.anchor)
    if (!range) continue
    wrapRangeWithMark(range, c.id)
  }
}

function findAnchorRange(article: HTMLElement, anchor: AnchorPayload): Range | null {
  const fullText = article.textContent ?? ''
  if (!anchor.quote) return null
  const withContext = anchor.prefix + anchor.quote + anchor.suffix
  let idx = fullText.indexOf(withContext)
  let start: number
  if (idx >= 0) {
    start = idx + anchor.prefix.length
  } else {
    // Fallback: try with only prefix or only suffix to disambiguate.
    const withPrefix = anchor.prefix + anchor.quote
    idx = anchor.prefix ? fullText.indexOf(withPrefix) : -1
    if (idx >= 0) {
      start = idx + anchor.prefix.length
    } else {
      idx = fullText.indexOf(anchor.quote)
      if (idx < 0) return null
      start = idx
    }
  }
  const end = start + anchor.quote.length
  return rangeForOffsets(article, start, end)
}

function rangeForOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let abs = 0
  let startNode: Text | null = null
  let startOff = 0
  let endNode: Text | null = null
  let endOff = 0
  let cur = walker.nextNode() as Text | null
  while (cur) {
    const len = (cur.textContent ?? '').length
    if (!startNode && abs + len > start) {
      startNode = cur
      startOff = start - abs
    }
    if (abs + len >= end) {
      endNode = cur
      endOff = end - abs
      break
    }
    abs += len
    cur = walker.nextNode() as Text | null
  }
  if (!startNode || !endNode) return null
  const r = document.createRange()
  try {
    r.setStart(startNode, startOff)
    r.setEnd(endNode, endOff)
  } catch {
    return null
  }
  return r
}

function wrapRangeWithMark(range: Range, commentID: string) {
  // Easy case: range within a single text node → surroundContents works cleanly.
  if (range.startContainer === range.endContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
    const m = document.createElement('mark')
    m.className = 'comment-anchor'
    m.dataset.commentId = commentID
    try {
      range.surroundContents(m)
    } catch {
      /* ignore — exotic node hierarchy */
    }
    return
  }
  // Multi-node: collect every text node intersecting the range and wrap each
  // sub-slice. surroundContents fails when wrapping crosses non-text elements,
  // so we slice node-by-node.
  const root = range.commonAncestorContainer
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const candidates: Text[] = []
  while (walker.nextNode()) {
    const n = walker.currentNode as Text
    if (range.intersectsNode(n)) candidates.push(n)
  }
  for (let i = 0; i < candidates.length; i++) {
    const n = candidates[i]
    if (!n.textContent) continue
    const sub = document.createRange()
    try {
      if (i === 0) {
        sub.setStart(range.startContainer, range.startOffset)
      } else {
        sub.setStart(n, 0)
      }
      if (i === candidates.length - 1) {
        sub.setEnd(range.endContainer, range.endOffset)
      } else {
        sub.setEnd(n, (n.textContent ?? '').length)
      }
      const m = document.createElement('mark')
      m.className = 'comment-anchor'
      m.dataset.commentId = commentID
      sub.surroundContents(m)
    } catch {
      /* skip slivers we can't wrap */
    }
  }
}

/* ---- Code block helpers (unchanged) -------------------------------------- */

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
