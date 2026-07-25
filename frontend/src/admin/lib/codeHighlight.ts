/**
 * codeHighlight — syntax highlighting AFTER paint, off the render path.
 *
 * Highlighting used to run as a rehype plugin, i.e. inside the markdown parse
 * that produces the page. Profiling a page open showed why that hurts:
 * highlight.js was the single biggest consumer of the navigation's main-thread
 * time, and every millisecond of it sat between the click and the first pixel of
 * text. Auto-detection is the worst part — for a fence with no language it runs
 * every registered grammar over the block and scores them.
 *
 * So: the markdown pipeline now emits plain `<pre><code>`, the reader sees the
 * text immediately, and this module colours the blocks afterwards in idle time.
 * highlight.js itself is imported dynamically, so it also leaves the critical
 * bundle. Cancellation is cooperative — navigating away abandons the remaining
 * blocks instead of highlighting a document nobody is looking at any more.
 *
 * Setting `innerHTML` here is safe and deliberate: the input is `code.textContent`
 * (plain text that already survived sanitization), and highlight.js escapes it
 * while wrapping tokens in its own spans — the same thing {@link ../components/FileViewer}
 * does for whole-file code views.
 */

/** Languages tried when a fence carries no language of its own. */
const DETECT_SUBSET = [
  'javascript', 'typescript', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp',
  'bash', 'json', 'yaml', 'sql', 'xml', 'css', 'markdown', 'php', 'ruby',
]

/** Blocks above this size are left alone — colouring them costs more than it helps. */
const MAX_CHARS = 100_000

type Hljs = typeof import('highlight.js')['default']
let hljsPromise: Promise<Hljs> | null = null

function loadHljs(): Promise<Hljs> {
  if (!hljsPromise) hljsPromise = import('highlight.js').then(m => m.default)
  return hljsPromise
}

/** A cancellable handle over one document's highlight run. */
export interface HighlightRun {
  cancel(): void
  /** Finish every remaining block right now (used before printing). */
  flush(): Promise<void>
}

const idle: (cb: () => void) => number =
  typeof requestIdleCallback === 'function'
    ? (cb) => requestIdleCallback(() => cb(), { timeout: 400 })
    : (cb) => window.setTimeout(cb, 0)
const cancelIdle: (h: number) => void =
  typeof cancelIdleCallback === 'function' ? cancelIdleCallback : window.clearTimeout

/** Highlight one `<code>` element in place. Returns false if it was skipped. */
function highlightOne(hljs: Hljs, code: HTMLElement): boolean {
  if (code.dataset.highlighted) return false
  const text = code.textContent ?? ''
  if (!text.trim() || text.length > MAX_CHARS) {
    code.dataset.highlighted = 'skipped'
    return false
  }
  const declared = [...code.classList]
    .map(c => (c.startsWith('language-') ? c.slice('language-'.length) : c.startsWith('lang-') ? c.slice('lang-'.length) : null))
    .find((c): c is string => !!c)
  try {
    const result = declared && hljs.getLanguage(declared)
      ? hljs.highlight(text, { language: declared, ignoreIllegals: true })
      : hljs.highlightAuto(text, DETECT_SUBSET)
    code.innerHTML = result.value
    code.classList.add('hljs')
    if (result.language && !declared) code.classList.add(`language-${result.language}`)
  } catch {
    // A grammar that throws must not cost the reader their code block.
  }
  code.dataset.highlighted = 'yes'
  return true
}

/**
 * Highlight every code block inside `root`, a few per idle slice so a document
 * full of code never blocks a frame. Blocks already done are skipped, so
 * re-running after a DOM change is cheap.
 */
export function highlightCodeBlocks(root: HTMLElement): HighlightRun {
  let cancelled = false
  let handle = 0
  const pending: HTMLElement[] = [...root.querySelectorAll<HTMLElement>('pre code')]
    .filter(el => !el.dataset.highlighted)

  const ready = pending.length > 0 ? loadHljs() : Promise.resolve(null)

  const pump = (hljs: Hljs) => {
    if (cancelled) return
    const started = performance.now()
    // Work in time slices rather than a fixed count: one huge block and twenty
    // tiny ones should both leave the frame budget intact.
    while (pending.length > 0 && performance.now() - started < 12) {
      highlightOne(hljs, pending.shift()!)
    }
    if (pending.length > 0) handle = idle(() => pump(hljs))
  }

  void ready.then(hljs => { if (hljs && !cancelled) handle = idle(() => pump(hljs)) })

  return {
    cancel() {
      cancelled = true
      if (handle) cancelIdle(handle)
    },
    async flush() {
      if (cancelled || pending.length === 0) return
      const hljs = await loadHljs()
      if (cancelled) return
      if (handle) cancelIdle(handle)
      while (pending.length > 0) highlightOne(hljs, pending.shift()!)
    },
  }
}
