/**
 * commentTargets — finding the file a stranded comment used to live on.
 *
 * A comment is filed against a file (a path in a plaintext space, a CRDT node id
 * in an encrypted one). Most ways of moving a page keep that link: the app's
 * rename carries the comments along, and a folder-sync push that recognises a
 * move performs a real move. What still strands a thread is everything the app
 * can't see as a move — a page deleted here and re-created there, an MCP client
 * writing a new path and dropping the old one, a push where the file was
 * relocated *and* rewritten past recognition.
 *
 * The stranded comments are not lost — they are simply pointing at something
 * that no longer opens. Rather than dropping them silently (which is what the
 * space-wide list used to do) or dumping the user into a blank page, we say what
 * happened and offer the files it most likely became:
 *
 *   1. **a file that still contains the quoted passage** — the anchor quote is
 *      the comment's own copy of the text it was pinned to, so a file holding it
 *      verbatim is the same content wherever it now lives. Strongest signal by
 *      far, and it survives a rename that changed the filename entirely.
 *   2. **a file with the same name somewhere else** — the plain "moved to
 *      another folder" case.
 *   3. **a file with a similar name** — fuzzy, for "notes.md" → "notes-2024.md".
 *
 * Ranking is pure and unit-tested here; who runs the quote search (the server's
 * /search for a plaintext space, the in-browser index for an encrypted one) is
 * the caller's business.
 */
import type { AllCommentItem } from './api'

/** One suggested file for a stranded thread, best first. */
export interface Candidate {
  path: string
  /** 0..1. Above ~0.8 the match is quote-backed and effectively certain. */
  score: number
  reason: 'quote' | 'name' | 'similar'
}

/** A file that vanished, with the comments left behind on it. */
export interface OrphanGroup {
  /** Last known path (plaintext) or filename (encrypted, where trashed nodes have no path). */
  path: string
  /** Encrypted spaces: the node the comments hang off, needed to re-attach them. */
  nodeId?: string
  comments: AllCommentItem[]
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const stem = (p: string): string => {
  const b = basename(p).toLowerCase()
  const dot = b.lastIndexOf('.')
  return dot > 0 ? b.slice(0, dot) : b
}

/**
 * Sørensen–Dice similarity over character bigrams, 0..1. Cheap, dependency-free
 * and forgiving of the edits filenames actually take (a suffix, a date, a
 * reordered word) in a way prefix matching is not.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const bigrams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2)
    bigrams.set(g, (bigrams.get(g) ?? 0) + 1)
  }
  let hits = 0
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2)
    const n = bigrams.get(g) ?? 0
    if (n > 0) {
      bigrams.set(g, n - 1)
      hits++
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1))
}

/** Only names this close are offered as a fuzzy suggestion. */
const FUZZY_FLOOR = 0.6

/**
 * Rank existing files as possible new homes for a comment thread that lost its
 * file. A path can qualify under more than one rule; it keeps its best score.
 *
 * The bands never overlap, so a quote hit always outranks a name hit and a name
 * hit always outranks a fuzzy one — within a band the filename (resp. the
 * folder) breaks the tie, which is what makes "same name, moved one folder over"
 * come out on top of "same name, other end of the tree".
 */
export function rankCandidates(opts: {
  /** The path (or bare filename) the comments still point at. */
  missing: string
  /** Every file path that currently exists in the space. */
  paths: string[]
  /** Paths whose text contains the anchor quote, if a search was run. */
  quoteHits?: string[]
  /** How many suggestions to keep (default 4). */
  limit?: number
}): Candidate[] {
  const { missing, paths, quoteHits = [], limit = 4 } = opts
  const missName = basename(missing)
  const missStem = stem(missing)
  const missDir = dirname(missing).toLowerCase()
  const hits = new Set(quoteHits)

  const best = new Map<string, Candidate>()
  const offer = (c: Candidate) => {
    const prev = best.get(c.path)
    if (!prev || c.score > prev.score) best.set(c.path, c)
  }

  for (const path of paths) {
    if (path === missing) continue
    const nameSim = similarity(stem(path), missStem)
    if (hits.has(path)) {
      offer({ path, score: 0.8 + 0.2 * nameSim, reason: 'quote' })
      continue
    }
    if (basename(path) === missName) {
      const dirSim = similarity(dirname(path).toLowerCase(), missDir)
      offer({ path, score: 0.55 + 0.2 * dirSim, reason: 'name' })
      continue
    }
    if (nameSim >= FUZZY_FLOOR) offer({ path, score: 0.5 * nameSim, reason: 'similar' })
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
}

/**
 * The best needle to search the space for when hunting a stranded thread: the
 * longest single line among the comments' anchor quotes, clipped to something a
 * substring search can still match after light editing around it.
 *
 * Single line because both search backends match line by line; longest because a
 * longer quote is far less likely to appear in an unrelated file. Anything short
 * enough to be ambiguous ("Yes", "TODO") is refused outright — a wrong file
 * offered with confidence is worse than no suggestion.
 */
export function bestQuoteNeedle(comments: AllCommentItem[]): string | null {
  let best = ''
  for (const c of comments) {
    for (const line of (c.anchor?.quote ?? '').split('\n')) {
      const t = line.trim()
      if (t.length > best.length) best = t
    }
  }
  if (best.length < 16) return null
  return best.length > 120 ? best.slice(0, 120) : best
}

/**
 * The whole hunt for one stranded thread: derive a needle from its quotes, ask
 * the caller's search for the files that still contain it, and rank everything.
 *
 * `search` is injected because the two space kinds answer it differently — the
 * server's `/search` for a plaintext space, the in-browser index over the
 * decrypted corpus for an encrypted one — with the same substring semantics
 * either way. A failing or missing search is not fatal: it only costs the
 * strongest signal, and the name-based tiers still produce suggestions.
 */
export async function findCommentTargets(opts: {
  group: OrphanGroup
  /** Every file path the space currently holds. */
  paths: string[]
  /** Substring search over the space; only called when a usable quote exists. */
  search?: (needle: string) => Promise<{ path: string }[]>
  limit?: number
}): Promise<Candidate[]> {
  const { group, paths, search, limit } = opts
  let quoteHits: string[] = []
  const needle = bestQuoteNeedle(group.comments)
  if (needle && search) {
    try {
      quoteHits = [...new Set((await search(needle)).map((m) => m.path))]
    } catch {
      /* names still rank */
    }
  }
  return rankCandidates({ missing: group.path, paths, quoteHits, limit })
}

/**
 * Split a space-wide comment list into the groups whose file still exists and
 * the ones whose file is gone. `existing` is the set of paths the space
 * currently holds; an item may also mark itself orphaned (an encrypted space
 * knows it directly — the node is in the trash).
 */
export function findOrphanGroups(comments: AllCommentItem[], existing: Set<string>): OrphanGroup[] {
  const groups = new Map<string, OrphanGroup>()
  for (const c of comments) {
    if (!c.orphan && existing.has(c.path)) continue
    const key = c.node_id ?? c.path
    const g = groups.get(key) ?? { path: c.path, nodeId: c.node_id, comments: [] }
    g.comments.push(c)
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => a.path.localeCompare(b.path))
}
