/**
 * sanitizeSchema — the single rehype-sanitize allowlist for rendered documents.
 *
 * Every place that turns document markdown into HTML shares it: the live viewer
 * ({@link ../components/MarkdownView}) and the read-aloud chunker
 * ({@link ./markdownChunks}). One definition, so a hardening change can't land
 * in one pipeline and be forgotten in the other.
 *
 * Threat model: a document's HTML is NOT trusted. A share guest with `edit`
 * permission, an MCP agent, or a form submission can all put raw HTML into a
 * page that the ADMIN later opens in the full-privilege admin app. `rehype-raw`
 * parses it, so this schema is the boundary.
 *
 * The two rules that carry the weight:
 *
 *   - **No `style`.** Inline CSS in the admin's viewer is a UI-spoofing surface.
 *   - **No blanket `className`.** In a Tailwind app that is equivalent to
 *     allowing `style`: every utility class the app ships is reachable, so
 *     `<div class="fixed inset-0 z-50 …">` would let authored content paint a
 *     pixel-accurate fake dialog (e.g. "session expired, re-enter your space
 *     password") over the whole viewport at the trusted origin. Instead only the
 *     specific class VALUES our own remark plugins emit are allowed — the
 *     sanitizer filters class lists token by token, so a smuggled
 *     `class="wiki-link fixed inset-0"` keeps `wiki-link` and drops the rest.
 *
 * Nothing else needs a class through this gate: rehype-slug, -autolink-headings,
 * -katex and -highlight all run AFTER sanitize, so the classes they add are
 * never subject to it (and `code` keeps `language-*` via the spec default, which
 * is what rehype-highlight reads).
 */
import { defaultSchema } from 'rehype-sanitize'

/** Inline elements we render beyond the spec defaults. */
const SAFE_TAGS = ['mark', 'details', 'summary', 'kbd', 'sub', 'sup'] as const

/** Class values emitted by our own remark plugins, before sanitize runs. */
const LINK_CLASSES = /^(wiki-link|wiki-link-broken|auto-file-link)$/
const ICON_CLASSES = /^auto-file-link-icon$/

/**
 * Per property, hast-util-sanitize honours the FIRST matching entry — so an
 * extra `['className', …]` appended after the spec's own would be ignored. Drop
 * the inherited entry and re-state its allowed values alongside ours.
 */
function withClassValues(
  inherited: readonly unknown[] | undefined,
  ...values: (string | RegExp)[]
): unknown[] {
  const rest = (inherited ?? []).filter(
    (e) => e !== 'className' && !(Array.isArray(e) && e[0] === 'className'),
  )
  const inheritedClassValues = (inherited ?? [])
    .filter((e): e is unknown[] => Array.isArray(e) && e[0] === 'className')
    .flatMap((e) => e.slice(1))
  return [...rest, ['className', ...inheritedClassValues, ...values]]
}

export const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...SAFE_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    // `id` is already in the spec's '*' list and is neutralised by the retained
    // clobber prefix (`user-content-`), so it needs no entry of its own.
    a: [...withClassValues(defaultSchema.attributes?.a, LINK_CLASSES), 'rel', 'target'],
    span: withClassValues(defaultSchema.attributes?.span, ICON_CLASSES),
    details: [...(defaultSchema.attributes?.details ?? []), 'open'],
    // No data-comment-id on <mark>: comment anchors are applied by us,
    // imperatively, after render. Letting document HTML declare one would let
    // authored content paint a fake (and interactive) comment anchor anywhere.
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https', 'data'],
  },
}
