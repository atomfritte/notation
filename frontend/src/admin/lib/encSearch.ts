/**
 * encSearch — client-side full-text search for zero-knowledge encrypted spaces.
 *
 * The server can't read an encrypted space's ciphertext, so its `/search`
 * endpoint 409s and there is no server index to hit. Instead we search entirely
 * in the browser over the already-decrypted corpus behind an {@link EncryptedFS}.
 *
 * ── Matching parity with the server ─────────────────────────────────────────
 * We reproduce what the admin `/search` route does (backend
 * `internal/space/search.go` `Store.Search`, the same code the plaintext UI
 * hits) so results render identically to a plaintext space:
 *
 *   - **case-insensitive substring** match, line by line
 *     (`strings.Contains(strings.ToLower(line), strings.ToLower(query))`);
 *   - **1-indexed** line numbers;
 *   - each hit's `content` is the whole line, **clipped to 240 chars** + "…";
 *   - results **capped** (default 200, ceiling 1000 — the server's clamp);
 *   - dotfiles / dot-directories are skipped (the server prunes `.`-prefixed
 *     names in its `fs.WalkDir`);
 *   - files are visited in the server's walk order (each directory's children
 *     sorted by name, pre-order) so the cap drops the same tail of matches.
 *
 * We additionally skip **binary / non-text** nodes (via {@link isTextFile}) —
 * the server line-scans every file, but for a decrypted personal corpus a
 * binary "match" is noise, and the task asks us to skip them.
 *
 * ── Caching / freshness ─────────────────────────────────────────────────────
 * Decrypting every file on every keystroke would be wasteful, so each file's
 * decrypted text is cached lazily, keyed by path. The cache MUST never serve
 * stale text, so callers invalidate it on mutation:
 *   - {@link invalidate} drops one path (a content overwrite reuses the path);
 *   - {@link clear} drops everything (any structural change — the corpus is
 *     personal-note sized, so a full re-decrypt is cheap and a stale hit a bug).
 * The cache lives only in memory for the unlocked session; it is never
 * persisted (the plaintext is already visible to the unlocked user, so holding
 * it in memory is not a new exposure).
 */
import { ROOT_ID, type Node } from '../../shared/vfs/nodes'
import type { EncryptedFS } from '../../shared/vfs/encfs'
import { utf8Decode } from '../../shared/crypto/bytes'
import { isTextFile } from './fileTypes'
import type { SearchMatch } from './api'

/** Content clip length — mirrors `search.go`'s `len(snippet) > 240` gate. */
const CLIP = 240
/** Default + ceiling result caps — mirror `search.go`'s `maxResults` clamp. */
const DEFAULT_MAX = 200
const MAX_CEILING = 1000

export interface EncSearchOpts {
  /** Optional shell glob (`*`, `?`, `[…]`) matched against the full path,
   *  mirroring the server's `path.Match` (single-segment `*`, no `/`). */
  glob?: string
  /** Result cap; clamped to (0, 1000], default 200 — same as the server. */
  maxResults?: number
}

/**
 * A lazily-decrypting, cache-backed search index over one {@link EncryptedFS}.
 * One instance is bound to one unlocked FS; rebuild it when the FS is rebuilt
 * (unlock / relock / convert) so a fresh session starts with an empty cache.
 */
export class EncryptedSearchIndex {
  /** path → decrypted UTF-8 text. Populated on demand; dropped on mutation. */
  private readonly cache = new Map<string, string>()

  constructor(private readonly fs: EncryptedFS) {}

  /** Forget one path's cached text (call after a content overwrite of it). */
  invalidate(path: string): void {
    this.cache.delete(path)
  }

  /** Forget all cached text (call after any structural change). */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Search the decrypted corpus. Returns matches in the exact
   * {@link SearchMatch} shape the SearchPanel renders — identical to what
   * `api.searchSpace` returns for a plaintext space.
   */
  async search(query: string, opts: EncSearchOpts = {}): Promise<SearchMatch[]> {
    const out: SearchMatch[] = []
    const q = query
    if (q === '') return out

    let max = opts.maxResults ?? DEFAULT_MAX
    if (max <= 0 || max > MAX_CEILING) max = DEFAULT_MAX

    const needle = q.toLowerCase()
    const globRe = opts.glob ? globToRegExp(opts.glob) : null

    for (const path of this.walkPaths()) {
      // Client-only: skip binaries; the plaintext corpus is what we search.
      if (!isTextFile(path)) continue
      if (globRe && !globRe.test(path)) continue

      const text = await this.textAt(path)
      if (text === null) continue // unreadable file — the server silently skips too

      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        // Strip a trailing CR so \r\n files match the server's ScanLines.
        let line = lines[i]
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.toLowerCase().includes(needle)) {
          out.push({ path, line: i + 1, content: clip(line) })
          if (out.length >= max) return out
        }
      }
    }
    return out
  }

  /**
   * Decrypted text for a path, cached. Returns null if the file can't be read
   * (missing blob / not a file) — the caller skips it, matching the server
   * quietly skipping files it can't open.
   */
  private async textAt(path: string): Promise<string | null> {
    const hit = this.cache.get(path)
    if (hit !== undefined) return hit
    try {
      const text = utf8Decode(await this.fs.read(path))
      this.cache.set(path, text)
      return text
    } catch {
      return null
    }
  }

  /**
   * Visible file paths in the server's walk order: each directory's children
   * sorted by name, pre-order, dot-prefixed names pruned. Yielding in this
   * order makes the result cap drop the same trailing matches the server would.
   */
  private *walkPaths(): Generator<string> {
    const childrenOf = new Map<string, Node[]>()
    for (const n of this.fs.tree()) {
      const arr = childrenOf.get(n.parentId)
      if (arr) arr.push(n)
      else childrenOf.set(n.parentId, [n])
    }
    function* dfs(parentId: string, parentPath: string): Generator<string> {
      const kids = (childrenOf.get(parentId) ?? [])
        .slice()
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const n of kids) {
        // Dotfiles/dot-dirs are pruned by the server's walk; mirror that.
        if (n.name.startsWith('.')) continue
        const path = parentPath ? `${parentPath}/${n.name}` : n.name
        if (n.type === 'dir') yield* dfs(n.nodeId, path)
        else yield path
      }
    }
    yield* dfs(ROOT_ID, '')
  }
}

/** Build (and load nothing else) an index over an already-open FS. */
export function createEncryptedSearchIndex(fs: EncryptedFS): EncryptedSearchIndex {
  return new EncryptedSearchIndex(fs)
}

/** Clip a line to {@link CLIP} chars + ellipsis, matching `search.go`'s snippet. */
function clip(s: string): string {
  return s.length > CLIP ? s.slice(0, CLIP) + '…' : s
}

/**
 * Translate a shell glob into an anchored RegExp with Go `path.Match`
 * semantics: `*` matches any run of non-`/` chars, `?` one non-`/` char,
 * `[…]` a character class (`[!…]` negates). Everything else is literal.
 */
function globToRegExp(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      // Copy the class verbatim to the next ']'; map a leading ! to ^.
      let j = i + 1
      let cls = ''
      if (glob[j] === '!') { cls += '^'; j++ }
      for (; j < glob.length && glob[j] !== ']'; j++) cls += glob[j]
      re += `[${cls}]`
      i = j // land on ']'; loop's i++ steps past it
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&')
  }
  return new RegExp(re + '$')
}
