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
import { buildFileIndex, resolveTarget as resolveWikiTarget } from '../lib/wikiLinks'
import { buildAutoFileLink } from '../lib/remarkAutoFileLink'
import { Mermaid } from './Mermaid'
import 'katex/dist/katex.min.css'
// Load the light-mode hljs palette globally; dark-mode overrides live in
// shared/index.css as hand-rolled `.dark .hljs-*` rules. This avoids the
// fragile selector-rewrite hack we tried first (which missed base rules
// like `pre code.hljs` and let the dark palette bleed into light mode).
import 'highlight.js/styles/github.css'

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
    // No 'style' here: KaTeX's style-carrying spans are generated AFTER this
    // sanitize pass, so only user-supplied raw HTML would benefit — and
    // guest-authored inline CSS in the admin's full-width viewer is a UI
    // spoofing surface we don't need.
    span: [...(defaultSchema.attributes?.span ?? []), 'className'],
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
  /** All paths in the Space — when present, prose mentions of any of these
   *  filenames get a small `[File]` link badge appended next to them. Also
   *  powers link resolution: relative / wiki-link targets are matched against
   *  this list so a link to a file in another folder resolves instead of 404ing. */
  files?: string[]
  /** Path of the file currently being rendered — used by the auto-link plugin
   *  to disambiguate same-basename matches by preferring the same directory. */
  currentFile?: string
  /** Ordered list of navigable pages (markdown, in menu order). When present
   *  alongside onNavigate, renders prev/next page links at the end of the
   *  article and enables left/right swipe navigation on touch devices. */
  navFiles?: string[]
  /** Navigate to another page (prev/next links + swipe). */
  onNavigate?: (path: string) => void
  /** Warm a linked page's content into the cache before it's opened — wired to
   *  hover on the prev/next buttons and on resolved in-document links so the
   *  click that follows paints instantly. Best-effort. */
  onPrefetch?: (path: string) => void
  /** Build the URL search string for an in-document link to `path`. Defaults to
   *  `?file=<path>`. Encrypted spaces pass a variant that emits `?n=<nodeId>`
   *  so a resolved link never carries a cleartext path in the URL. */
  fileSearch?: (path: string) => string
}

export function MarkdownView({
  content,
  theme = 'dark',
  comments,
  activeCommentID,
  onHoverMark,
  onSelectAnchor,
  onNewAnchorComment,
  files,
  currentFile,
  navFiles,
  onNavigate,
  onPrefetch,
  fileSearch = (path: string) => `?file=${encodeURIComponent(path)}`,
}: Props) {
  const location = useLocation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const articleRef = useRef<HTMLElement>(null)

  // ---- Link resolution ----------------------------------------------------
  // Wiki-links (`[[Page]]`) and relative markdown links (`[x](page.md)`) carry
  // a bare target that may live in a different folder than the current file.
  // Without resolving it against the real file list the resulting `?file=` URL
  // 404s. We build a lookup (exact paths + basename buckets) and resolve every
  // intra-Space link to an actual path before handing it to the router.
  const fileIndex = useMemo(() => buildFileIndex(files ?? []), [files])
  const currentDir = useMemo(() => {
    if (!currentFile) return ''
    const i = currentFile.lastIndexOf('/')
    return i >= 0 ? currentFile.slice(0, i) : ''
  }, [currentFile])

  // Bind the shared wiki-link resolver to this document's file index + folder.
  // preferDir=true → markdown-relative semantics (resolve against the current
  // folder first); false → wiki-link / vault semantics (exact + basename first).
  // The encrypted-space backlinks scanner runs the very same resolver so its
  // "who links here" answer matches where these rendered links navigate.
  const resolveTarget = (rawIn: string, preferDir: boolean) =>
    resolveWikiTarget(fileIndex, currentDir, rawIn, preferDir)
  const haveFileList = (files?.length ?? 0) > 0

  // ---- Prev / next page navigation ---------------------------------------
  const navInfo = useMemo(() => {
    if (!navFiles || !currentFile || !onNavigate) return null
    const idx = navFiles.indexOf(currentFile)
    if (idx < 0) return null
    return {
      prev: idx > 0 ? navFiles[idx - 1] : null,
      next: idx < navFiles.length - 1 ? navFiles[idx + 1] : null,
    }
  }, [navFiles, currentFile, onNavigate])
  // Rebuild the auto-link plugin only when the underlying inputs change —
  // its regex + index can be expensive for large Spaces, and we don't want
  // to recompute on every keystroke-triggered re-render of the viewer.
  const autoFileLinkPlugin = useMemo(() => {
    if (!files || files.length === 0) return null
    return buildAutoFileLink({ files, currentFile })
  }, [files, currentFile])
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

  // Refresh anchor marks AND search-hit marks whenever the document, the
  // comments list, or the `?q=...` URL parameter changes. Running both in
  // one pass guarantees a stable insertion order: we always strip both
  // mark types first, then reapply anchors, then apply search hits — so
  // neither type ever ends up wrapping the other.
  useEffect(() => {
    const article = articleRef.current
    if (!article) return
    const params = new URLSearchParams(location.search)
    const q = (params.get('q') ?? '').trim()
    const frame = requestAnimationFrame(() => {
      removeSearchHits(article)
      removeAnchorMarks(article)
      if (comments && comments.length > 0) applyAnchorMarks(article, comments)
      if (q.length >= 2) {
        const first = applySearchHits(article, q)
        if (first) {
          // requestAnimationFrame nest: the marks were just inserted; let
          // layout settle before asking the browser to scroll.
          requestAnimationFrame(() => {
            first.scrollIntoView({ behavior: 'smooth', block: 'center' })
          })
        }
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [content, comments, location.search])

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
      // Clamp x so the toolbar never spills past the right edge of the viewer.
      const x = Math.min(rect.right - container.left, container.width - 110)
      setTool({
        x: Math.max(8, x),
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
    // Keyboard parity: Enter/Space on a focused anchor opens its thread.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Enter' && e.key !== ' ') return
      const m = (e.target as HTMLElement)?.closest?.('mark.comment-anchor') as HTMLElement | null
      if (m?.dataset.commentId) {
        e.preventDefault()
        onSelectAnchor?.(m.dataset.commentId)
      }
    }
    article.addEventListener('mouseover', onMouseOver)
    article.addEventListener('mouseout', onMouseOut)
    article.addEventListener('click', onClick)
    article.addEventListener('keydown', onKeyDown)
    return () => {
      article.removeEventListener('mouseover', onMouseOver)
      article.removeEventListener('mouseout', onMouseOut)
      article.removeEventListener('click', onClick)
      article.removeEventListener('keydown', onKeyDown)
    }
  }, [onHoverMark, onSelectAnchor])

  // React to activeCommentID changes: toggle `data-active` on matching marks,
  // scroll the first matching mark into view, and fire the blink animation.
  // ALSO re-runs when `content`/`comments` change: clicking a comment in the
  // "all comments" panel navigates to a DIFFERENT page, so the target mark
  // doesn't exist yet when activeCommentID is set — the document has to load
  // (and, for encrypted spaces, decrypt) and the marks be re-applied first.
  // Depending on the same inputs as applyAnchorMarks makes the scroll retry
  // once the mark is finally in the DOM. The applyAnchorMarks effect is
  // registered earlier, so its rAF (which inserts the marks) runs before this
  // one (which finds and scrolls to them) in the same frame.
  useEffect(() => {
    const setActive = () => {
      articleRef.current?.querySelectorAll<HTMLElement>('mark.comment-anchor').forEach(m => {
        m.dataset.active = m.dataset.commentId === activeCommentID ? 'true' : 'false'
      })
    }
    setActive()
    if (!activeCommentID) return
    // Retry until the target mark is in the DOM: opening a comment from the
    // panel navigates to another page whose document must load, render, and —
    // for encrypted spaces — decrypt before applyAnchorMarks runs, so the mark
    // often isn't there on the first frame. Poll briefly (a few hundred ms of
    // async decode is well within reach) instead of relying on effect timing.
    let cancelled = false
    let tries = 0
    const attempt = () => {
      if (cancelled) return
      const article = articleRef.current
      if (!article) return
      setActive()
      const marks = article.querySelectorAll<HTMLElement>(
        `mark.comment-anchor[data-comment-id="${CSS.escape(activeCommentID)}"]`,
      )
      if (marks.length > 0) {
        marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' })
        marks.forEach(m => {
          m.classList.add('comment-anchor-blink')
          window.setTimeout(() => m.classList.remove('comment-anchor-blink'), 1400)
        })
        return
      }
      if (tries++ < 40) window.setTimeout(attempt, 50) // up to ~2s, then give up
    }
    const frame = requestAnimationFrame(attempt)
    return () => { cancelled = true; cancelAnimationFrame(frame) }
  }, [activeCommentID, comments, content])

  // Horizontal swipe (touch only) flips to the prev/next page. Guards keep it
  // from firing on vertical scrolls, on sideways scrolls inside wide code
  // blocks / tables, on the OS back/forward edge gesture, or when the swipe was
  // actually a drag-to-select.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !onNavigate || !navInfo) return
    const EDGE = 28 // px reserved at each screen edge for the browser's own swipe
    let startX = 0, startY = 0, t0 = 0, tracking = false
    function onStart(e: TouchEvent) {
      if (e.touches.length !== 1) { tracking = false; return }
      const t = e.touches[0]
      // Don't hijack a gesture that begins inside a horizontally-scrollable
      // child (a wide table or code block the reader is panning).
      if (startsInHorizontalScroller(t.target as Node | null, el)) { tracking = false; return }
      if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE) { tracking = false; return }
      startX = t.clientX; startY = t.clientY; t0 = Date.now(); tracking = true
    }
    function onEnd(e: TouchEvent) {
      if (!tracking) return
      tracking = false
      const t = e.changedTouches[0]
      const dx = t.clientX - startX
      const dy = t.clientY - startY
      if (Date.now() - t0 > 600) return
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return
      // A drag that selected text was a comment gesture, not a page flip.
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.toString().trim()) return
      if (dx < 0 && navInfo!.next) onNavigate!(navInfo!.next)
      else if (dx > 0 && navInfo!.prev) onNavigate!(navInfo!.prev)
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchend', onEnd)
    }
  }, [onNavigate, navInfo])

  // The unified parse re-runs on every render of <ReactMarkdown>; memoise the
  // element so hover / active-comment / selection state changes (which re-render
  // this component constantly) don't re-parse the whole document each time.
  const renderedMarkdown = useMemo(() => (
        // key={content}: on a page change React replaces this whole subtree rather
        // than diffing across the imperatively-inserted <mark>s (see the article
        // comment) — avoiding the removeChild crash. content is reference-stable
        // between non-navigation re-renders, so it only remounts on a real change.
        <ReactMarkdown
          key={content}
          remarkPlugins={[
            remarkGfm,
            remarkMath,
            remarkWikiLink,
            ...(autoFileLinkPlugin ? [autoFileLinkPlugin] : []),
          ]}
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
            // Wrap every table in a div + thin sortable shim. The wrap div
            // handles horizontal scroll on overflow + outer border / radius;
            // SortableTable below attaches click-to-sort handlers to each
            // <th> after mount. Styling for both lives in shared/index.css
            // under `.prose-table-wrap`.
            table: ({ node, ...props }) => (
              <div className="prose-table-wrap">
                <SortableTable {...props} />
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
                // Wiki-links + `?file=` links — resolve the file param against
                // the real tree (vault semantics) so a target in another folder
                // doesn't 404.
                const url = new URL(href, 'http://_/')
                const f = url.searchParams.get('file')
                let target: string | undefined
                if (f) {
                  const r = resolveTarget(f, false)
                  // Known-missing target: render inert so the reader isn't sent
                  // to a guaranteed 404. Only when we have a tree to check against.
                  if (haveFileList && !r.exists) return <BrokenLink>{children}</BrokenLink>
                  target = r.path
                }
                return (
                  <Link
                    to={{ pathname: location.pathname, search: target ? fileSearch(target) : url.search, hash: url.hash }}
                    className={className}
                    onMouseEnter={target ? () => onPrefetch?.(target!) : undefined}
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
              const [rawPath, anchor] = href.split('#')
              // Relative markdown link — resolve against the current folder
              // first, then fall back to basename match across the Space.
              const r = resolveTarget(rawPath, true)
              if (haveFileList && !r.exists) return <BrokenLink>{children}</BrokenLink>
              return (
                <Link
                  to={{
                    pathname: location.pathname,
                    search: fileSearch(r.path),
                    hash: anchor ? '#' + anchor : '',
                  }}
                  className={className}
                  onMouseEnter={() => onPrefetch?.(r.path)}
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
  ), [content, theme, autoFileLinkPlugin, fileIndex, currentDir, haveFileList, location.pathname, location.search, onPrefetch])

  // For long documents, let the browser skip rendering the off-screen blocks
  // (content-visibility: auto) so the first paint only costs the visible text.
  // Short/medium docs render eagerly — there the optimisation buys nothing and
  // would only risk scrollbar jitter. See `.cv-auto` in shared/index.css.
  const longDoc = content.length > 12000

  // ---- Print document header ----------------------------------------------
  // A `.print-only` masthead rendered above the article: folder breadcrumb +
  // print date, and — unless the body already opens with its own H1 — a serif
  // title derived from the file name. Hidden on screen (display:none), revealed
  // only under `@media print` (see shared/index.css). Keeps the title logic in
  // the DOM where we actually have the file name, rather than in CSS ::before.
  const docTitle = currentFile ? pageLabel(currentFile) : ''
  const docDir = currentFile && currentFile.includes('/')
    ? currentFile.slice(0, currentFile.lastIndexOf('/')).split('/').join(' / ')
    : ''
  // Does the markdown open with a single-`#` H1? If so it IS the title, so we
  // don't repeat the file name — the masthead is just the breadcrumb + date.
  const bodyHasLeadingH1 = /^\uFEFF?\s*#\s+\S/.test(content)
  const printDate = useMemo(
    () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
    [],
  )

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto relative">
      {/* Print-only document masthead: breadcrumb + date, plus a serif title
          when the body has no leading H1 of its own. Sits above the article so
          it lands at the very top of page one; display:none on screen so it
          never touches the reading view (and stays out of the article's
          nth-child page-reveal animation). See `.print-doc-*` in shared/index.css. */}
      {docTitle && (
        <div className="print-doc-header print-only" aria-hidden="true">
          <div className="print-doc-meta">
            <span className="print-doc-path">{docDir || ' '}</span>
            <span className="print-doc-date">Printed {printDate}</span>
          </div>
          {!bodyHasLeadingH1 && <h1 className="print-doc-title">{docTitle}</h1>}
        </div>
      )}
      {/* The article element stays stable (its hover/click/keydown listeners are
          bound to it directly), but renderedMarkdown is keyed on content so React
          REPLACES the whole prose subtree on a page change instead of diffing it.
          The comment/search marks imperatively wrap text in <mark> (splitText +
          surroundContents); diffing across that re-parents text nodes and makes
          React do `parent.removeChild(textNode)` on a node whose parent is now a
          <mark> → "node is not a child" crash. Replacing instead removes whole
          block elements (each still a direct child of the article), so it's safe. */}
      <article ref={articleRef} className={`prose prose-zinc dark:prose-invert max-w-3xl mx-auto p-4 md:p-8${longDoc ? ' cv-auto' : ''}`}>
        {renderedMarkdown}
      </article>

      {navInfo && (navInfo.prev || navInfo.next) && onNavigate && (
        <nav className="page-nav max-w-3xl mx-auto px-4 md:px-8 pb-16 no-print">
          {navInfo.prev ? (
            <button onClick={() => onNavigate(navInfo.prev!)} onMouseEnter={() => onPrefetch?.(navInfo.prev!)} className="page-nav-btn group" title={navInfo.prev}>
              <span className="page-nav-dir">← Previous</span>
              <span className="page-nav-title">{pageLabel(navInfo.prev)}</span>
            </button>
          ) : <span className="flex-1" />}
          {navInfo.next ? (
            <button onClick={() => onNavigate(navInfo.next!)} onMouseEnter={() => onPrefetch?.(navInfo.next!)} className="page-nav-btn page-nav-btn-next group" title={navInfo.next}>
              <span className="page-nav-dir">Next →</span>
              <span className="page-nav-title">{pageLabel(navInfo.next)}</span>
            </button>
          ) : <span className="flex-1" />}
        </nav>
      )}

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
          className="fixed z-50 pointer-events-none px-3 py-2 max-w-sm rounded-md shadow-lg bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] text-xs no-print"
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

// Walk up from the touch target to the scroll root; true if any ancestor is
// actually horizontally scrollable (wide table / code block), so a sideways
// drag there pans the child instead of flipping the page.
function startsInHorizontalScroller(node: Node | null, root: HTMLElement | null): boolean {
  let el = node instanceof HTMLElement ? node : node?.parentElement ?? null
  while (el && el !== root) {
    if (el.scrollWidth > el.clientWidth + 2) {
      const ox = getComputedStyle(el).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
    el = el.parentElement
  }
  return false
}

// Display label for a page link: basename without the markdown extension.
function pageLabel(path: string): string {
  return stripMdExt(path.slice(path.lastIndexOf('/') + 1))
}

// Strip a trailing markdown extension (.md / .mdx / .markdown) for display.
export function stripMdExt(name: string): string {
  return name.replace(/\.(md|mdx|markdown)$/i, '')
}

// A link whose target doesn't exist in the Space — rendered as styled,
// non-navigating text so a stale `[[wiki]]` ref never lands on a 404.
function BrokenLink({ children }: { children: ReactNode }) {
  return (
    <span className="wiki-link-broken" title="Page not found in this Space">
      {children}
    </span>
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

/**
 * SortableTable — drops sort-by-column behaviour onto any `<table>` rendered
 * from markdown. After mount, every `thead th` gets a click handler that
 * reorders the `tbody` rows by that column's text content. Repeated clicks
 * toggle ascending / descending; clicking a different column resets to
 * ascending. The sort algorithm tries numeric, then ISO-date, then
 * locale-aware string compare so number columns and date columns just work.
 *
 * Implemented at the DOM level via a ref + useEffect because react-markdown
 * hands us opaque children — there's no clean way to extract row data from
 * the children prop, and walking the DOM after render is the same
 * complexity but works for any cell content.
 */
function SortableTable(props: React.HTMLAttributes<HTMLTableElement>) {
  const ref = useRef<HTMLTableElement>(null)

  useEffect(() => {
    const table = ref.current
    if (!table) return
    const ths = table.querySelectorAll<HTMLTableCellElement>('thead th')
    const tbody = table.querySelector('tbody')
    if (!tbody || ths.length === 0) return

    let activeCol: number | null = null
    let asc = true
    const disposers: Array<() => void> = []

    ths.forEach((th, idx) => {
      th.classList.add('sortable-th')
      const onClick = () => {
        if (activeCol === idx) asc = !asc
        else { activeCol = idx; asc = true }
        sortByColumn(tbody, idx, asc)
        ths.forEach((other, i) => {
          if (i === activeCol) other.dataset.sort = asc ? 'asc' : 'desc'
          else delete other.dataset.sort
        })
      }
      th.addEventListener('click', onClick)
      disposers.push(() => {
        th.removeEventListener('click', onClick)
        th.classList.remove('sortable-th')
        delete th.dataset.sort
      })
    })

    return () => { disposers.forEach(d => d()) }
    // Children include the data — re-run when content changes (file switch,
    // editor save) so handlers point at the fresh DOM.
  }, [props.children])

  return <table ref={ref} {...props} />
}

function sortByColumn(tbody: HTMLTableSectionElement, col: number, asc: boolean) {
  const rows = Array.from(tbody.querySelectorAll(':scope > tr'))
  rows.sort((a, b) => {
    const aText = (a.children[col]?.textContent ?? '').trim()
    const bText = (b.children[col]?.textContent ?? '').trim()
    const cmp = compareCells(aText, bText)
    return asc ? cmp : -cmp
  })
  // Re-append in new order. Browsers move existing nodes rather than
  // re-create, so event listeners on cells survive.
  for (const row of rows) tbody.appendChild(row)
}

function compareCells(a: string, b: string): number {
  // Empty values sort to the end regardless of direction.
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  // Numbers first — allow common separators like "1,234.5" or "€ 605".
  const aNum = parseNumericish(a)
  const bNum = parseNumericish(b)
  if (aNum !== null && bNum !== null) return aNum - bNum
  // ISO-ish dates.
  const aDate = Date.parse(a)
  const bDate = Date.parse(b)
  if (!Number.isNaN(aDate) && !Number.isNaN(bDate)) return aDate - bDate
  // Locale-aware string fallback handles umlauts / accents naturally.
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function parseNumericish(s: string): number | null {
  // Strip currency symbols and trailing units, keep digits + decimal sep.
  const cleaned = s
    .replace(/[€$£¥%]/g, '')
    .replace(/[a-zA-Z\s]/g, '')
    .replace(/(\d),(\d{3})/g, '$1$2')   // 1,234 → 1234
    .replace(/,(?=\d)/g, '.')            // 1,5 → 1.5 (German decimals)
    .replace(/[~+]/g, '')                // ~605, +40 → 605, 40
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
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

/* ---- Search highlight --------------------------------------------------- */

/** Strip every <mark class="search-hit"> wrapper, leaving the inner text in
 *  place. Mirrors removeAnchorMarks so the rendered prose returns to its
 *  pristine state before the next round of highlighting. */
function removeSearchHits(article: HTMLElement) {
  const marks = article.querySelectorAll('mark.search-hit')
  marks.forEach(m => {
    const parent = m.parentNode
    if (!parent) return
    while (m.firstChild) parent.insertBefore(m.firstChild, m)
    parent.removeChild(m)
    parent.normalize()
  })
}

/** Wraps every case-insensitive occurrence of `query` inside the article in
 *  a <mark class="search-hit">. Returns the FIRST inserted mark so the caller
 *  can scroll it into view. Matches that span multiple text nodes are not
 *  handled — they'd require joining adjacent text nodes first, and in
 *  practice users search for short tokens that live inside a single node. */
function applySearchHits(article: HTMLElement, query: string): HTMLElement | null {
  const needle = query.toLowerCase()
  if (!needle) return null
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const parent = (n as Text).parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      // Don't decorate the floating selection toolbar / hover bubble; they
      // live outside `article`, but in case anything similar shows up
      // inside, skip nodes inside our own wrappers.
      if (parent.closest('mark.search-hit')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  const texts: Text[] = []
  let cur: Node | null = walker.nextNode()
  while (cur) {
    texts.push(cur as Text)
    cur = walker.nextNode()
  }

  let firstHit: HTMLElement | null = null
  for (const t of texts) {
    let working: Text = t
    // `working` is always the next un-wrapped suffix. After each match we
    // re-scan its text from offset 0, so the loop terminates as soon as the
    // needle no longer appears in the suffix.
    while (true) {
      const value = working.textContent ?? ''
      const lower = value.toLowerCase()
      const i = lower.indexOf(needle)
      if (i < 0) break
      const right = working.splitText(i)
      const rest = right.splitText(needle.length)
      const mark = document.createElement('mark')
      mark.className = 'search-hit'
      right.parentNode?.insertBefore(mark, right)
      mark.appendChild(right)
      if (!firstHit) firstHit = mark
      working = rest
    }
  }
  return firstHit
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

// Make a comment-anchor mark focusable + semantic so keyboard / screen-reader
// users can reach it (Enter/Space opens its thread — see the interaction effect).
function newAnchorMark(commentID: string): HTMLElement {
  const m = document.createElement('mark')
  m.className = 'comment-anchor'
  m.dataset.commentId = commentID
  m.tabIndex = 0
  m.setAttribute('role', 'button')
  m.setAttribute('aria-label', 'Open comment on this passage')
  return m
}

function wrapRangeWithMark(range: Range, commentID: string) {
  // Easy case: range within a single text node → surroundContents works cleanly.
  if (range.startContainer === range.endContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
    const m = newAnchorMark(commentID)
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
      sub.surroundContents(newAnchorMark(commentID))
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
        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition px-2 py-1 text-xs bg-[var(--notation-bg-alt)] text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] rounded shadow"
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
