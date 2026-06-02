import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeKatex from 'rehype-katex'
import { remarkWikiLink } from './remarkWikiLink'
import { buildAutoFileLink } from './remarkAutoFileLink'
import { extractSentences, groupChunks } from './readAloud'
import { chunksFromMarkdown } from './markdownChunks'

// Mirror the part of MarkdownView's sanitize schema that matters for extraction:
// it allows `className` on every element, so the `auto-file-link-icon` class on
// the ↗ badge survives sanitisation and extractSentences can skip it. (The default
// schema strips className — which is exactly why the skip must rely on a schema
// that keeps it, as both real render paths do.)
const liveSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className', 'id'],
  },
}

// The "live" read-aloud path: ReadAloudBar runs extractSentences + groupChunks
// over MarkdownView's rendered <article.prose>, which INCLUDES the autoFileLink
// plugin. The vertonen pre-synthesiser (chunksFromMarkdown) renders OFF-SCREEN
// WITHOUT that plugin. For the offline audio cache to hit, the two must produce
// byte-identical chunk text. This is the invariant that broke (the ↗ badge) and
// the regression guard for it.
function liveChunks(md: string, files: string[]): string[] {
  const html = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkWikiLink, buildAutoFileLink({ files })]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, liveSchema], rehypeKatex]}
    >
      {md}
    </ReactMarkdown>,
  )
  const article = document.createElement('article')
  article.className = 'prose'
  article.innerHTML = html
  return groupChunks(extractSentences(article), 'block').map(c => c.text)
}

describe('chunksFromMarkdown ↔ live read-aloud chunking', () => {
  it('matches the live render for an inline-code file mention (the ↗ badge case)', async () => {
    // `notes/foo.md` resolves against the file list → autoFileLink injects a
    // standalone "↗" badge after the <code> in the LIVE render. The off-screen
    // render never runs that plugin. extractSentences must skip the badge so the
    // two agree.
    const md = 'See `notes/foo.md` for the details that explain the whole thing properly.'
    const files = ['notes/foo.md', 'notes/bar.md']
    const live = liveChunks(md, files)
    const offscreen = await chunksFromMarkdown(md)
    expect(offscreen).toEqual(live)
    // And neither should contain the badge glyph.
    expect(live.join(' ')).not.toContain('↗')
    expect(offscreen!.join(' ')).not.toContain('↗')
  })

  it('matches for ordinary prose with wiki-links + multiple paragraphs', async () => {
    const md = [
      '# Heading one',
      '',
      'This is the first paragraph. It has two sentences that are both reasonably long so the block grouping keeps them together.',
      '',
      'A second paragraph references [[Some Page]] and keeps going for a while to make a separate chunk of decent size here.',
    ].join('\n')
    const live = liveChunks(md, [])
    const offscreen = await chunksFromMarkdown(md)
    expect(offscreen).toEqual(live)
  })

  it('returns [] for a page with no readable prose (code/table only)', async () => {
    const md = ['```js', 'const x = 1', '```', '', '| a | b |', '| - | - |', '| 1 | 2 |'].join('\n')
    const offscreen = await chunksFromMarkdown(md)
    expect(offscreen).toEqual([])
  })
})
