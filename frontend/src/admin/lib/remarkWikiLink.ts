import type { Plugin } from 'unified'
import type { Root, Text, PhrasingContent, Parent } from 'mdast'
import { visit, SKIP } from 'unist-util-visit'

// Match [[target]] or [[target|display]], target can contain #anchor.
// We deliberately reject newlines inside the brackets and unmatched [/].
const wikiLinkRe = /\[\[([^\[\]\n]+?)\]\]/g

/**
 * remarkWikiLink transforms `[[target]]` and `[[target|display]]` syntax inside
 * text nodes into Markdown link nodes whose href is `?file=<target>#<anchor>`.
 * The MarkdownView component intercepts that href via its `a` component and
 * routes it through React Router so navigation stays inside the SPA.
 *
 * Forms accepted:
 *   [[file]]               → href ?file=file.md
 *   [[file.md]]            → href ?file=file.md
 *   [[file|display text]]  → display text rendered, same href
 *   [[file#section]]       → href ?file=file.md#section
 *   [[notes/foo|bar]]      → href ?file=notes/foo.md
 */
export const remarkWikiLink: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'text', (node: Text, index, parent) => {
    if (!parent || index == null) return
    const value = node.value
    const matches = [...value.matchAll(wikiLinkRe)]
    if (matches.length === 0) return

    const out: PhrasingContent[] = []
    let cursor = 0
    for (const m of matches) {
      const start = m.index ?? 0
      const end = start + m[0].length
      if (start > cursor) {
        out.push({ type: 'text', value: value.slice(cursor, start) } as Text)
      }
      let target = m[1].trim()
      let display = target
      const pipe = target.indexOf('|')
      if (pipe >= 0) {
        display = target.slice(pipe + 1).trim() || target.slice(0, pipe).trim()
        target = target.slice(0, pipe).trim()
      }
      let anchor = ''
      const hash = target.indexOf('#')
      if (hash >= 0) {
        // Slugify so `[[file#My Heading]]` matches rehype-slug's id="my-heading".
        anchor = slugifyHeading(target.slice(hash + 1))
        target = target.slice(0, hash)
      }
      let path = target
      if (!/\.[a-z0-9]+$/i.test(path)) path += '.md'
      const href = `?file=${encodeURIComponent(path)}${anchor ? '#' + anchor : ''}`
      out.push({
        type: 'link',
        url: href,
        title: null,
        children: [{ type: 'text', value: display } as Text],
        data: { hProperties: { className: 'wiki-link' } },
      } as PhrasingContent)
      cursor = end
    }
    if (cursor < value.length) {
      out.push({ type: 'text', value: value.slice(cursor) } as Text)
    }
    ;(parent as Parent).children.splice(index, 1, ...out)
    return [SKIP, index + out.length]
  })
}

/**
 * slugifyHeading approximates github-slugger / rehype-slug's default algorithm
 * so `[[file#My Heading!]]` becomes a hash that matches the rendered <h2 id>.
 * Doesn't handle the +1 numeric suffix that rehype-slug appends to duplicate
 * headings on the same page (rare in practice, can be addressed if it bites).
 */
function slugifyHeading(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}
