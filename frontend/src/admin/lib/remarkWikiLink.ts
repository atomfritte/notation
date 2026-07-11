import type { Plugin } from 'unified'
import type { Root, Text, PhrasingContent, Parent } from 'mdast'
import { visit, SKIP } from 'unist-util-visit'
import { WIKI_LINK_RE, parseWikiTarget } from './wikiLinks'

/**
 * remarkWikiLink transforms `[[target]]` and `[[target|display]]` syntax inside
 * text nodes into Markdown link nodes whose href is `?file=<target>#<anchor>`.
 * The MarkdownView component intercepts that href via its `a` component and
 * routes it through React Router so navigation stays inside the SPA.
 *
 * The syntax parsing (pipe/anchor split, NFC, `.md` inference, slug) lives in
 * {@link parseWikiTarget} so the encrypted-space backlinks scanner extracts the
 * exact same targets this plugin renders — see `wikiLinks.ts`.
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
    const matches = [...value.matchAll(WIKI_LINK_RE)]
    if (matches.length === 0) return

    const out: PhrasingContent[] = []
    let cursor = 0
    for (const m of matches) {
      const start = m.index ?? 0
      const end = start + m[0].length
      if (start > cursor) {
        out.push({ type: 'text', value: value.slice(cursor, start) } as Text)
      }
      const { path, anchor, display } = parseWikiTarget(m[1])
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
