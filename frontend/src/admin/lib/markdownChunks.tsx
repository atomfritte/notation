// Off-screen chunk extraction for the "vertonen" (pre-synthesise) manager.
//
// The read-aloud player chunks audio from the *rendered* article DOM
// (extractSentences + groupChunks, see readAloud.ts). To pre-generate a page's
// audio so the cached /tts clips byte-match what the player later requests, we
// must reproduce that exact chunking for pages the user hasn't opened.
//
// We render the markdown the same way MarkdownView does — react-markdown with
// the same remark/rehype plugins — into a detached <article class="prose">, then
// run the *identical* extractSentences + groupChunks('block') pipeline. Crucially
// extractSentences SKIPS tables / code / mermaid (by tag + class), so the custom
// MarkdownView components (SortableTable, Mermaid, the react-router <Link>) don't
// affect the extracted prose text — only the plugins (which transform visible
// text: wiki-links, math) matter. That's why renderToStaticMarkup with default
// components is enough and needs no Router context.
//
// KEEP THE PLUGIN SET IN SYNC with MarkdownView.tsx's remark/rehype config for
// any plugin that changes *visible text* (currently: gfm, math+katex, wikiLink).
// Plugins that only add ids/anchors (slug, autolinkHeadings) or restructure
// skipped nodes (highlight) are omitted — they don't change the chunk text.
// autoFileLink IS omitted here even though it CAN inject a stray "↗" text node
// (its inline-code icon badge) in the live view: extractSentences drops that "↗"
// glyph (see readAloud.ts), so the live and off-screen chunk texts stay identical
// without needing the Space file list here.

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeKatex from 'rehype-katex'
import { remarkWikiLink } from './remarkWikiLink'
import { extractSentences, groupChunks } from './readAloud'

// Mirror of MarkdownView's sanitize schema (the prose-affecting parts). Raw HTML
// in a doc is parsed by rehype-raw then sanitised — same as the live view — so
// its text is extracted the same way.
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'mark', 'details', 'summary', 'kbd', 'sub', 'sup'],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className', 'id'],
    span: [...(defaultSchema.attributes?.span ?? []), 'className'],
    details: [...(defaultSchema.attributes?.details ?? []), 'open'],
  },
}

// react-dom/server is heavy + only needed for the (opt-in) vertonen flow, so it's
// loaded lazily the first time a page is voiced rather than shipped in the main
// bundle.
let render: ((el: React.ReactElement) => string) | null = null
async function getRenderer() {
  if (!render) {
    const mod = await import('react-dom/server')
    render = mod.renderToStaticMarkup
  }
  return render
}

/**
 * chunksFromMarkdown renders the markdown off-screen and returns the SAME chunk
 * texts the read-aloud player would synthesise for this page ('block' mode), so
 * pre-generated /tts URLs match the ones requested at play time. Returns `null` if
 * rendering THREW (a genuine failure the caller counts), versus `[]` for a page
 * that simply has no readable prose (e.g. only tables/code/images) — so the
 * "vertonen" summary can tell "failed" apart from "nothing to voice".
 */
export async function chunksFromMarkdown(content: string): Promise<string[] | null> {
  let html = ''
  try {
    const toStaticMarkup = await getRenderer()
    html = toStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkWikiLink]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]}
      >
        {content}
      </ReactMarkdown>,
    )
  } catch {
    return null
  }
  // A detached element is fine — extractSentences uses TreeWalker + Range, which
  // work off-document; we only need each chunk's text (the ranges go unused).
  const article = document.createElement('article')
  article.className = 'prose'
  article.innerHTML = html
  return groupChunks(extractSentences(article), 'block').map(c => c.text)
}
