import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { remarkWikiLink } from './remarkWikiLink'
import { sanitizeSchema } from './sanitizeSchema'

// A document's HTML is untrusted: a share guest with edit rights, an MCP agent
// or a form submission can put raw HTML into a page the ADMIN later opens with
// full privileges. These tests pin what survives that boundary.

const render = (md: string): string =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkWikiLink]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
    >
      {md}
    </ReactMarkdown>,
  )

describe('document sanitize schema', () => {
  it('strips script, event handlers and javascript: urls', () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[x](javascript:alert(1))',
    )
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('javascript:')
  })

  it('strips inline style', () => {
    expect(render('<div style="position:fixed;inset:0">hi</div>')).not.toContain('style=')
  })

  it('refuses the utility classes a fake full-screen dialog is built from', () => {
    // In a Tailwind app an arbitrary class list is as good as arbitrary CSS:
    // every utility the app ships is in the stylesheet. Allowing it would let a
    // page paint a pixel-accurate "session expired — re-enter your password"
    // overlay at the trusted origin.
    const html = render(
      '<div class="fixed inset-0 z-50 bg-[var(--notation-backdrop)]">' +
        '<a href="https://evil.example/login">Sign in</a></div>',
    )
    expect(html).not.toContain('fixed')
    expect(html).not.toContain('inset-0')
    expect(html).not.toContain('z-50')
    // The prose itself still renders — we strip the weapon, not the content.
    expect(html).toContain('Sign in')
  })

  it('strips a smuggled class list down to the allowed token', () => {
    const html = render('<a href="/x" class="wiki-link fixed inset-0 z-50">t</a>')
    expect(html).toContain('wiki-link')
    expect(html).not.toContain('fixed')
    expect(html).not.toContain('z-50')
  })

  it('keeps the classes our own remark plugins emit', () => {
    // Wiki-links are turned into <a class="wiki-link"> BEFORE sanitize runs, so
    // the schema has to let that exact value through or intra-space links lose
    // their styling.
    expect(render('see [[other-page]] here')).toContain('wiki-link')
  })

  it('keeps language-* on code so the highlighter (which runs later) can read it', () => {
    expect(render('```js\nconst a = 1\n```')).toContain('language-js')
  })

  it('does not let a document declare a comment anchor', () => {
    const html = render('<mark class="comment-anchor" data-comment-id="c1">x</mark>')
    expect(html).toContain('<mark')
    expect(html).not.toContain('data-comment-id')
    expect(html).not.toContain('comment-anchor')
  })
})
