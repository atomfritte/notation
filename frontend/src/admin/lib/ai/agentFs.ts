/**
 * agentFs — the file view the assistant's tools work on.
 *
 * Built on {@link SyncSpace}, the same two-backend port the local-folder sync
 * uses, so ONE tool implementation serves both kinds of Space: a plaintext
 * Space reads and writes through the server's file API (and lands in its git
 * history), a zero-knowledge Space through the unlocked EncryptedFS in this
 * browser (the server only ever sees ciphertext). Nothing here knows which.
 *
 * On top of the port it adds what an agent needs and the port doesn't have:
 * text decoding with a binary guard, a per-file text cache (search and the
 * structure map re-read the corpus), path hygiene for model-supplied paths,
 * and a change hook so the open page and the tree follow the agent's writes.
 */
import { utf8Decode, utf8Encode } from '../../../shared/crypto/bytes'
import { isMarkdownFile, isTextFile } from '../fileTypes'
import { isGeneratedGuide } from '../spaceGuide'
import type { SyncNode, SyncSpace } from '../syncSpace'

export class AgentFsError extends Error {}

/** Largest file the assistant reads or writes as text (bytes). */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

export interface AgentFsHooks {
  /** Called after every successful mutation with the affected paths. */
  onChange?: (paths: string[]) => void
  /**
   * Return a reason when `path` must not be changed right now (e.g. it is open
   * in the editor with unsaved edits), or null when it may.
   */
  writeGuard?: (path: string) => string | null
  /** Called after a successful move, so an open page can follow its file. */
  onMoved?: (from: string, to: string) => void
  /** Called after a successful delete. */
  onRemoved?: (path: string) => void
}

/**
 * Normalise a model-supplied path to a logical Space path, or throw. Paths are
 * untrusted model output: no absolute paths, no `..`, no dot-segments (dotfiles
 * are tooling on both backends and never shown in the app), NFC like the rest
 * of the app.
 */
export function normalizePath(raw: unknown): string {
  if (typeof raw !== 'string') throw new AgentFsError('path must be a string')
  let p = raw.trim().normalize('NFC').replace(/\\/g, '/')
  p = p.replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!p) throw new AgentFsError('path is empty')
  const segs = p.split('/')
  for (const s of segs) {
    if (s === '') throw new AgentFsError(`invalid path "${raw}": empty segment`)
    if (s === '..' || s === '.') throw new AgentFsError(`invalid path "${raw}": ".." and "." are not allowed`)
    if (s.startsWith('.')) throw new AgentFsError(`invalid path "${raw}": hidden (dot) files and folders are not part of a Space`)
    if (s.length > 255) throw new AgentFsError(`invalid path "${raw}": segment too long`)
  }
  return segs.join('/')
}

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

export class AgentFS {
  private nodes: SyncNode[] | null = null
  private text = new Map<string, string>()

  constructor(readonly space: SyncSpace, private readonly hooks: AgentFsHooks = {}) {}

  get encrypted(): boolean {
    return this.space.encrypted
  }

  /** Forget everything cached (the Space may have changed behind our back). */
  refresh(): void {
    this.nodes = null
    this.text.clear()
  }

  /** Every node, cached until the next mutation. */
  async list(): Promise<SyncNode[]> {
    if (!this.nodes) this.nodes = await this.space.listNodes()
    return this.nodes
  }

  async files(): Promise<string[]> {
    return (await this.list()).filter(n => !n.isDir).map(n => n.path)
  }

  async exists(path: string): Promise<'file' | 'dir' | null> {
    const hit = (await this.list()).find(n => n.path === path)
    return hit ? (hit.isDir ? 'dir' : 'file') : null
  }

  /**
   * Read a file as UTF-8 text; throws for directories, binaries, huge files.
   * `fresh` skips the cache — for the moment a change is applied, which may be
   * long after the read it was planned on (the user had a diff to look at).
   */
  async readText(path: string, fresh = false): Promise<string> {
    if (fresh) this.text.delete(path)
    const cached = this.text.get(path)
    if (cached !== undefined) return cached
    const kind = await this.exists(path)
    if (kind === 'dir') throw new AgentFsError(`${path} is a folder — use list_files`)
    if (kind === null) throw new AgentFsError(`${path} does not exist`)
    const bytes = await this.space.read(path)
    if (bytes.length > MAX_TEXT_BYTES) {
      throw new AgentFsError(`${path} is ${Math.round(bytes.length / 1024)} KB — too large to read as text`)
    }
    if (looksBinary(bytes)) {
      throw new AgentFsError(`${path} is a binary file (${bytes.length} bytes); it can't be read as text`)
    }
    const s = utf8Decode(bytes)
    this.text.set(path, s)
    return s
  }

  /** Read without throwing; null for anything that isn't readable text. */
  async tryReadText(path: string): Promise<string | null> {
    try {
      return await this.readText(path)
    } catch {
      return null
    }
  }

  private guard(path: string): void {
    const why = this.hooks.writeGuard?.(path)
    if (why) throw new AgentFsError(why)
  }

  private invalidate(paths: string[], structural: boolean): void {
    for (const p of paths) this.text.delete(p)
    if (structural) this.nodes = null
    this.hooks.onChange?.(paths)
  }

  async writeText(path: string, content: string): Promise<void> {
    this.guard(path)
    const bytes = utf8Encode(content)
    if (bytes.length > MAX_TEXT_BYTES) throw new AgentFsError('content too large (max 2 MB)')
    const existed = await this.exists(path)
    if (existed === 'dir') throw new AgentFsError(`${path} is a folder`)
    await this.space.write(path, bytes)
    await this.space.flush()
    this.invalidate([path], existed === null)
    this.text.set(path, content)
  }

  async move(from: string, to: string): Promise<void> {
    this.guard(from)
    this.guard(to)
    const kind = await this.exists(from)
    if (kind === null) throw new AgentFsError(`${from} does not exist`)
    if (kind === 'dir') throw new AgentFsError('moving whole folders is not supported — move the files one by one')
    if (await this.exists(to)) throw new AgentFsError(`${to} already exists`)
    await this.space.move(from, to)
    await this.space.flush()
    this.invalidate([from, to], true)
    this.hooks.onMoved?.(from, to)
  }

  async remove(path: string): Promise<void> {
    this.guard(path)
    const kind = await this.exists(path)
    if (kind === null) throw new AgentFsError(`${path} does not exist`)
    if (kind === 'dir') {
      const inside = (await this.list()).some(n => n.path.startsWith(path + '/'))
      if (inside) throw new AgentFsError(`${path} is not empty — delete its files first`)
    }
    await this.space.remove(path)
    await this.space.flush()
    this.invalidate([path], true)
    this.hooks.onRemoved?.(path)
  }

  /** Text files the search and map tools walk (generated agent briefings skipped). */
  async textFiles(glob?: RegExp | null): Promise<string[]> {
    return (await this.files()).filter(p => isTextFile(p) && (!glob || glob.test(p)))
  }

  /** Read many files with bounded concurrency; unreadable ones are skipped. */
  async readMany(paths: string[], concurrency = 6): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    let next = 0
    const worker = async () => {
      while (next < paths.length) {
        const p = paths[next++]
        const t = await this.tryReadText(p)
        if (t !== null && !isGeneratedGuide(utf8Encode(t.slice(0, 600)))) out.set(p, t)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker))
    return out
  }

  /** Markdown pages, in tree order. */
  async markdownFiles(): Promise<string[]> {
    return (await this.files()).filter(isMarkdownFile)
  }
}

export { globToRegExp } from './skillFormat'
