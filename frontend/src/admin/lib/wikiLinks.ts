/**
 * wikiLinks — the shared, framework-free core of `[[wiki-link]]` handling.
 *
 * The exact same parsing + resolution rules power three call sites, so they
 * MUST agree byte-for-byte:
 *   1. {@link remarkWikiLink} — rewrites `[[target]]` into `?file=…` links in
 *      the rendered markdown;
 *   2. {@link MarkdownView}'s link resolver — turns a `?file=` / relative target
 *      into a real Space path (vault + relative semantics);
 *   3. the encrypted-space **backlinks** computation — the inverse: which pages
 *      link *to* the open one (see {@link EncryptedSearchIndex.backlinks}).
 *
 * Keeping the logic here (rather than duplicated inside each component) is what
 * lets an encrypted space's client-computed backlinks match a plaintext space's
 * link rendering exactly — same syntax, same `.md` inference, same basename vs
 * path resolution, same slug for `[[page#section]]`.
 */

/**
 * Matches `[[target]]` / `[[target|display]]` (target may carry `#anchor`).
 * Newlines and nested brackets are rejected, so a link never spans lines —
 * which is why per-line scanning in {@link extractWikiTargets} is sound.
 * Global so it can drive `matchAll`; `matchAll` clones the regex, so sharing
 * this single instance across calls is safe (no lastIndex bleed).
 */
export const WIKI_LINK_RE = /\[\[([^[\]\n]+?)\]\]/g

/** Parsed pieces of one `[[…]]` payload (the text captured between brackets). */
export interface WikiTarget {
  /** Resolvable path with a `.md` inferred when the target has no extension. */
  path: string
  /** Slugified `#section` (matches rehype-slug's heading id), or '' if none. */
  anchor: string
  /** Display label (after `|`, else the target itself). */
  display: string
}

/**
 * Parse the inside of a `[[…]]` (the capture group) into its path / anchor /
 * display parts. This is the SINGLE source of truth for wiki-target syntax —
 * {@link remarkWikiLink} and the backlinks scanner both call it, so the two
 * can never drift. Mirrors the original inline logic exactly, including the
 * NFC normalisation and the `.md` extension inference.
 */
export function parseWikiTarget(inner: string): WikiTarget {
  // NFC unifies combining-mark variants so "Übersicht.md" matches `[[Übersicht]]`
  // regardless of the editor's/filesystem's normalisation form.
  let target = inner.trim().normalize('NFC')
  let display = target
  const pipe = target.indexOf('|')
  if (pipe >= 0) {
    display = target.slice(pipe + 1).trim() || target.slice(0, pipe).trim()
    target = target.slice(0, pipe).trim()
  }
  let anchor = ''
  const hash = target.indexOf('#')
  if (hash >= 0) {
    anchor = slugifyHeading(target.slice(hash + 1))
    target = target.slice(0, hash)
  }
  let path = target
  if (!/\.[a-z0-9]+$/i.test(path)) path += '.md'
  return { path, anchor, display }
}

/**
 * Every wiki-link *target path* mentioned in a chunk of text, in document
 * order (duplicates preserved). Feed it a single line to keep line numbers
 * meaningful — links can't span newlines, so a line is a complete unit.
 */
export function extractWikiTargets(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(WIKI_LINK_RE)) {
    out.push(parseWikiTarget(m[1]).path)
  }
  return out
}

/**
 * slugifyHeading approximates github-slugger / rehype-slug's default algorithm
 * so `[[file#My Heading!]]` becomes a hash that matches the rendered `<h2 id>`.
 * Normalise to NFC, lower-case, drop punctuation but keep Unicode letters /
 * digits / spaces / hyphens, collapse whitespace runs to "-".
 */
export function slugifyHeading(s: string): string {
  return s
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * A lookup over a Space's file list: exact paths plus basename buckets. Built
 * once per file set and shared by every resolution in that render — see
 * {@link resolveTarget}.
 */
export interface FileIndex {
  /** Every full path, verbatim. */
  set: Set<string>
  /** Lower-cased basename → the full paths sharing it (basename resolution). */
  byBase: Map<string, string[]>
}

/** Build a {@link FileIndex} from a Space's flat path list. */
export function buildFileIndex(files: Iterable<string>): FileIndex {
  const set = new Set<string>()
  const byBase = new Map<string, string[]>()
  for (const f of files) {
    if (!f) continue
    set.add(f)
    const base = f.slice(f.lastIndexOf('/') + 1).toLowerCase()
    const bucket = byBase.get(base)
    if (bucket) bucket.push(f)
    else byBase.set(base, [f])
  }
  return { set, byBase }
}

/** Directory portion of a path ('' for a root-level file). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i) : ''
}

/**
 * Resolve a link target to a real Space path.
 *
 * `preferDir=true` → markdown-relative semantics (resolve against `currentDir`
 * first); `false` → wiki-link / vault semantics (exact + basename first).
 * Returns the best-guess path plus whether it actually exists in the Space, so
 * a caller can render a dead link inert (or, for backlinks, ignore a miss)
 * instead of pointing at a 404.
 *
 * This is the resolver MarkdownView uses for every intra-Space link; the
 * backlinks scanner runs the same function per source file so "does B link to
 * A?" is decided by identical rules to "where does B's link to A navigate?".
 */
export function resolveTarget(
  index: FileIndex,
  currentDir: string,
  rawIn: string,
  preferDir: boolean,
): { path: string; exists: boolean } {
  if (!rawIn) return { path: rawIn, exists: false }
  // Authors may percent-encode spaces etc. (`My%20Note.md`); decode so it
  // matches the plain paths in the index.
  let raw = rawIn
  try { raw = decodeURIComponent(rawIn) } catch { /* leave as-is on bad escape */ }
  const rel = normJoin(currentDir, raw)
  const root = raw.replace(/^\.?\/+/, '')
  const tries = preferDir ? [rel, raw, root] : [raw, root, rel]
  for (const t of tries) if (index.set.has(t)) return { path: t, exists: true }
  const base = raw.slice(raw.lastIndexOf('/') + 1).toLowerCase()
  const matches = index.byBase.get(base)
  if (matches && matches.length === 1) return { path: matches[0], exists: true }
  if (matches && matches.length > 1) {
    const sameDir = matches.find(p => p.slice(0, Math.max(0, p.lastIndexOf('/'))) === currentDir)
    if (sameDir) return { path: sameDir, exists: true }
    return { path: [...matches].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0], exists: true }
  }
  return { path: /^\.\.?\//.test(raw) ? rel : (preferDir ? rel : root), exists: false }
}

/**
 * Join a base directory with a (possibly `./` / `../`-laden) relative target
 * and collapse the navigation segments, yielding a clean Space-relative path.
 */
export function normJoin(dir: string, rel: string): string {
  const parts = dir ? dir.split('/') : []
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  return parts.join('/')
}
