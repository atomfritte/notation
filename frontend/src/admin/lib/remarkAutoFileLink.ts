import type { Plugin } from 'unified'
import type { Root, Text, InlineCode, PhrasingContent, Parent } from 'mdast'
import { visit, SKIP } from 'unist-util-visit'

export type AutoFileLinkOptions = {
  /** Every file in the Space (relative paths, including non-markdown). */
  files: string[]
  /** Path of the file being rendered — used to break ties on ambiguous basenames. */
  currentFile?: string
}

/**
 * remarkAutoFileLink scans the rendered prose for mentions of any file in the
 * Space and appends a small `[File]` link badge right after the mention so the
 * reader can jump to that file without leaving the page.
 *
 *   "see Project Plan"        → "see Project Plan [File]"
 *   "MarkdownView.tsx renders" → "MarkdownView.tsx [File] renders"
 *
 * Each file is indexed under TWO keys: its full basename (with extension) and
 * its basename minus extension. Matching is case-insensitive and constrained by
 * Unicode word boundaries so substrings inside larger words don't trigger.
 *
 * Ambiguity resolution when the same basename exists in multiple folders:
 *   1. Pick the file in the same directory as `currentFile`, if any.
 *   2. Pick the file at the highest nesting level (shortest path).
 *   3. Pick deterministically by lexicographic path order.
 *
 * The text is NEVER replaced — only a sibling link is inserted — so the prose
 * reads exactly as the author wrote it.
 */
export function buildAutoFileLink(opts: AutoFileLinkOptions): Plugin<[], Root> {
  const index = new Map<string, string[]>()
  for (const path of opts.files) {
    if (!path) continue
    // Full path — covers code-fenced references like
    // `02_ELEKTRONIK/00_Systemueberblick.md` and prose mentions of the same.
    addToIndex(index, path, path)
    const name = basename(path)
    if (name !== path) addToIndex(index, name, path)
    const dot = name.lastIndexOf('.')
    if (dot > 0) addToIndex(index, name.slice(0, dot), path)
  }

  // Drop the obvious noise: super-short tokens and common prose words that
  // collide with generic basenames. Add to STOP_WORDS as false positives crop
  // up in real notes.
  for (const key of [...index.keys()]) {
    if (key.length < 3 || STOP_WORDS.has(key)) index.delete(key)
  }

  const keys = [...index.keys()].sort((a, b) => b.length - a.length)
  if (keys.length === 0) {
    return () => () => {}
  }

  // Greedy match: regex alternations are tried left-to-right so the longest-
  // first ordering means "Meeting Notes" wins over "Meeting" on the same span.
  // Word boundaries use Unicode-aware look-arounds so accented filenames work.
  const pattern = keys.map(escapeRegex).join('|')
  const re = new RegExp(
    `(?:^|(?<=[^\\p{L}\\p{N}_]))(${pattern})(?=$|[^\\p{L}\\p{N}_])`,
    'giu',
  )

  const currentDir = opts.currentFile ? dirname(opts.currentFile) : ''
  const currentPath = opts.currentFile ?? ''

  function makeBadge(resolved: string): PhrasingContent {
    return {
      type: 'link',
      url: `?file=${encodeURIComponent(resolved)}`,
      title: resolved,
      children: [{ type: 'text', value: 'File' } as Text],
      data: {
        hProperties: {
          className: 'auto-file-link',
          title: resolved,
        },
      },
    } as PhrasingContent
  }

  return () => (tree) => {
    // Pass 1 — regular prose. Walk text nodes, locate mentions, splice in a
    // sibling `[File]` link after each match without touching the original
    // wording.
    visit(tree, 'text', (node: Text, idx, parent) => {
      if (!parent || idx == null) return
      const ptype = (parent as { type: string }).type
      if (
        ptype === 'link' ||
        ptype === 'linkReference' ||
        ptype === 'inlineCode' ||
        ptype === 'code'
      ) {
        return
      }

      const value = node.value
      re.lastIndex = 0
      const matches: RegExpMatchArray[] = []
      let m: RegExpExecArray | null
      while ((m = re.exec(value)) !== null) matches.push(m)
      if (matches.length === 0) return

      const out: PhrasingContent[] = []
      let cursor = 0
      let produced = false
      for (const match of matches) {
        const token = match[1]
        const start = match.index ?? 0
        const end = start + token.length
        const candidates = index.get(token.toLowerCase()) ?? []
        const resolved = resolve(candidates, currentDir, currentPath)
        if (!resolved) continue
        if (end > cursor) {
          out.push({ type: 'text', value: value.slice(cursor, end) } as Text)
        }
        out.push(makeBadge(resolved))
        cursor = end
        produced = true
      }
      if (!produced) return
      if (cursor < value.length) {
        out.push({ type: 'text', value: value.slice(cursor) } as Text)
      }
      ;(parent as Parent).children.splice(idx, 1, ...out)
      return [SKIP, idx + out.length]
    })

    // Pass 2 — inline-code references. People commonly write file paths in
    // backticks (e.g. `02_ELEKTRONIK/00_Systemueberblick.md`); the basic text
    // pass skips them because the text is wrapped in an `inlineCode` node.
    // Here we treat the whole code value as a single key — only an exact
    // match against the index produces a sibling badge.
    visit(tree, 'inlineCode', (node: InlineCode, idx, parent) => {
      if (!parent || idx == null) return
      const ptype = (parent as { type: string }).type
      if (ptype === 'link' || ptype === 'linkReference') return
      const value = node.value.trim()
      if (!value) return
      const candidates = index.get(value.toLowerCase()) ?? []
      const resolved = resolve(candidates, currentDir, currentPath)
      if (!resolved) return
      ;(parent as Parent).children.splice(idx + 1, 0, makeBadge(resolved))
      return [SKIP, idx + 2]
    })
  }
}

function addToIndex(idx: Map<string, string[]>, key: string, path: string) {
  const k = key.toLowerCase()
  let bucket = idx.get(k)
  if (!bucket) {
    bucket = []
    idx.set(k, bucket)
  }
  bucket.push(path)
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i) : ''
}

function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

function resolve(paths: string[], currentDir: string, currentPath: string): string | null {
  if (paths.length === 0) return null
  // Never auto-link to the file we're currently rendering.
  const usable = paths.filter(p => p !== currentPath)
  if (usable.length === 0) return null
  if (usable.length === 1) return usable[0]
  const inDir = usable.filter(p => dirname(p) === currentDir)
  if (inDir.length === 1) return inDir[0]
  const pool = inDir.length > 1 ? inDir : usable
  pool.sort((a, b) => {
    const ad = a.split('/').length
    const bd = b.split('/').length
    if (ad !== bd) return ad - bd
    return a.localeCompare(b)
  })
  return pool[0]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Generic words that frequently collide with terse basenames like "Index.md"
// or "Notes.md" — left lowercase since the index keys are lowercased.
const STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'this', 'that', 'into', 'over',
  'index', 'notes', 'todo', 'tasks', 'log', 'logs', 'main', 'home',
])
