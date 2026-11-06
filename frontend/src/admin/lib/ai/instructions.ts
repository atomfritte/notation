/**
 * instructions — a Space's instruction files, loaded the way Claude Code
 * loads them.
 *
 * A Space is worked on two ways: in this side panel, and by Claude Code in a
 * folder the Space was pulled into (folder sync). Both must see the same
 * instructions, so this follows Claude Code's memory rules
 * (code.claude.com/docs/en/memory) for the files a Space can hold — dotfiles
 * never exist in a Space, so `.claude/CLAUDE.md` and `.claude/rules/` don't
 * apply here:
 *
 *   - **At the start**: `CLAUDE.md`, then `CLAUDE.local.md`, in the Space root.
 *     `AGENTS.md` is read INSTEAD only when the root has neither of them
 *     (Claude Code's default "CLAUDE.md or AGENTS.md").
 *   - **On demand**: a folder's own `CLAUDE.md` / `CLAUDE.local.md` the first
 *     time Claude reads, writes or edits a file in that folder (or below it);
 *     its `AGENTS.md` when the Space runs on AGENTS.md and the folder has no
 *     CLAUDE file — on a read, like Claude Code.
 *   - **`@path` imports** are expanded (relative to the importing file, up to
 *     four hops; not inside code spans or fenced blocks; `\ ` escapes a space;
 *     quoted, `~` and absolute paths — outside the Space — are not imported).
 *   - **Block HTML comments** are stripped (outside code blocks).
 *   - **Size**: a file over 40,000 characters is cut there, with a note to read
 *     the rest — Claude Code's per-file limit for a 200K context window.
 */
import { utf8Encode } from '../../../shared/crypto/bytes'
import { isGeneratedGuide } from '../spaceGuide'

export const MAX_INSTRUCTION_CHARS = 40_000
/** Claude Code: "Imported files can recursively import other files, with a maximum depth of four hops." */
export const MAX_IMPORT_HOPS = 4

export type InstructionKind = 'project' | 'local' | 'agents' | 'import'

export interface InstructionFile {
  path: string
  kind: InstructionKind
  /** For an import: the file whose `@path` pulled it in. */
  importedBy?: string
  text: string
  truncated: boolean
}

/** 'claude': the Space has a root CLAUDE.md/CLAUDE.local.md; 'agents': it runs on AGENTS.md. */
export type InstructionMode = 'claude' | 'agents'

export interface InstructionReader {
  /** Every file path of the Space. */
  files: readonly string[]
  /** The file as text, or null when unreadable/binary. */
  read(path: string): Promise<string | null>
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

/** Collapse `.` / `..` inside a Space path; null when it climbs out of the Space. */
function normalize(p: string): string | null {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(seg)
  }
  return out.length ? out.join('/') : null
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Remove block-level HTML comments (`<!-- … -->` starting a line), as Claude
 * Code does before the text reaches the model. Comments inside fenced code
 * blocks stay.
 */
export function stripBlockComments(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: string | null = null
  let inComment = false
  for (const line of lines) {
    if (inComment) {
      const end = line.indexOf('-->')
      if (end >= 0) {
        inComment = false
        const rest = line.slice(end + 3)
        if (rest.trim()) out.push(rest)
      }
      continue
    }
    const f = FENCE.exec(line)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      out.push(line)
      continue
    }
    if (f) {
      fence = f[1]
      out.push(line)
      continue
    }
    if (/^\s*<!--/.test(line)) {
      const start = line.indexOf('<!--')
      const end = line.indexOf('-->', start + 4)
      if (end < 0) { inComment = true; continue }
      const rest = line.slice(end + 3)
      if (rest.trim()) out.push(rest)
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * The `@path` imports of a text, in order: outside fenced code blocks and
 * inline code spans, `\ ` for a space, quoted paths ignored.
 */
export function parseImports(text: string): string[] {
  const out: string[] = []
  let fence: string | null = null
  for (const raw of text.split('\n')) {
    const f = FENCE.exec(raw)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      continue
    }
    if (f) { fence = f[1]; continue }
    const line = raw.replace(/(`+)[^`]*?\1/g, ' ')
    const re = /(^|[\s(\[])@((?:\\ |[^\s])+)/g
    for (let m; (m = re.exec(line));) {
      const p = m[2]
      if (/^["'`]/.test(p)) continue
      out.push(p.replace(/\\ /g, ' '))
    }
  }
  return out
}

/** Resolve an import against the importing file; null when it can't be in the Space. */
function resolveImport(spec: string, from: string, exists: (p: string) => boolean): string | null {
  if (spec.startsWith('~') || spec.startsWith('/') || /^[a-z]+:/i.test(spec)) return null
  const tries = [spec]
  // "See @README." — the sentence's punctuation isn't part of the path.
  const trimmed = spec.replace(/[.,;:!?)\]'"]+$/, '')
  if (trimmed !== spec) tries.push(trimmed)
  for (const t of tries) {
    const p = normalize(join(dirOf(from), t))
    if (p && exists(p)) return p
  }
  return null
}

function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_INSTRUCTION_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_INSTRUCTION_CHARS), truncated: true }
}

/**
 * Load `path` and everything it imports (depth-first, in import order). Files
 * already in `seen` are skipped, so nothing reaches the model twice.
 */
async function loadWithImports(
  r: InstructionReader,
  path: string,
  kind: InstructionKind,
  seen: Set<string>,
  importedBy?: string,
  hop = 0,
): Promise<InstructionFile[]> {
  if (seen.has(path)) return []
  const raw = await r.read(path)
  if (raw == null) return []
  // A briefing the folder sync generated is tooling, never Space content.
  if (isGeneratedGuide(utf8Encode(raw.slice(0, 600)))) return []
  seen.add(path)
  const clean = stripBlockComments(raw)
  const out: InstructionFile[] = [{ path, kind, importedBy, ...cap(clean) }]
  if (hop >= MAX_IMPORT_HOPS) return out
  const exists = (p: string) => r.files.includes(p)
  for (const spec of parseImports(clean)) {
    const target = resolveImport(spec, path, exists)
    if (target) out.push(...(await loadWithImports(r, target, 'import', seen, path, hop + 1)))
  }
  return out
}

/** Whether a folder has a CLAUDE file of its own (which also keeps its AGENTS.md out). */
function hasClaudeFile(files: readonly string[], dir: string): boolean {
  return files.includes(join(dir, 'CLAUDE.md')) || files.includes(join(dir, 'CLAUDE.local.md'))
}

/** The instructions in the Space root — what Claude Code reads at launch. */
export async function rootInstructions(
  r: InstructionReader,
  seen: Set<string> = new Set(),
): Promise<{ mode: InstructionMode; files: InstructionFile[] }> {
  const files: InstructionFile[] = []
  if (r.files.includes('CLAUDE.md')) files.push(...(await loadWithImports(r, 'CLAUDE.md', 'project', seen)))
  if (r.files.includes('CLAUDE.local.md')) files.push(...(await loadWithImports(r, 'CLAUDE.local.md', 'local', seen)))
  // A CLAUDE file counts — and keeps AGENTS.md out — unless it is a briefing
  // the folder sync generated (those never belong to the Space).
  if (files.some(f => f.kind !== 'import')) return { mode: 'claude', files }
  if (r.files.includes('AGENTS.md')) files.push(...(await loadWithImports(r, 'AGENTS.md', 'agents', seen)))
  return { mode: 'agents', files }
}

/**
 * The folder instructions that `touched` brings into play and that aren't
 * loaded yet — every folder from the top down to each touched file's own.
 * `loaded` is updated in place.
 */
export async function folderInstructions(
  r: InstructionReader,
  touched: { path: string; op: 'read' | 'write' }[],
  loaded: Set<string>,
  mode: InstructionMode,
): Promise<InstructionFile[]> {
  const out: InstructionFile[] = []
  for (const t of touched) {
    // Reading an instruction file directly puts it in context already.
    if (/(^|\/)(CLAUDE|CLAUDE\.local|AGENTS)\.md$/.test(t.path)) loaded.add(t.path)
    const segs = dirOf(t.path).split('/').filter(Boolean)
    for (let i = 1; i <= segs.length; i++) {
      const dir = segs.slice(0, i).join('/')
      for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
        const p = join(dir, name)
        if (r.files.includes(p) && p !== t.path) {
          out.push(...(await loadWithImports(r, p, name === 'CLAUDE.md' ? 'project' : 'local', loaded)))
        }
      }
      const agents = join(dir, 'AGENTS.md')
      if (mode === 'agents' && t.op === 'read' && agents !== t.path && r.files.includes(agents) && !hasClaudeFile(r.files, dir)) {
        out.push(...(await loadWithImports(r, agents, 'agents', loaded)))
      }
    }
  }
  return out
}

const LABEL: Record<InstructionKind, string> = {
  project: 'project instructions, stored in the Space',
  local: "the owner's private instructions for this Space",
  agents: 'project instructions (AGENTS.md), stored in the Space',
  import: 'imported',
}

/** One file as the model sees it — Claude Code's "Contents of …" framing. */
export function renderInstruction(f: InstructionFile): string {
  const what = f.kind === 'import' ? `imported by ${f.importedBy}` : LABEL[f.kind]
  const tail = f.truncated
    ? `\n[… cut at ${MAX_INSTRUCTION_CHARS.toLocaleString('en')} characters — read the rest of ${f.path} with read_file]`
    : ''
  return `Contents of ${f.path} (${what}):\n\n${f.text.trimEnd()}${tail}`
}
