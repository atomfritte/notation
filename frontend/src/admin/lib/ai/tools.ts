/**
 * The assistant's tools: their definitions (sent to the API) and their
 * implementations (run here in the browser against {@link AgentFS}).
 *
 * Every call goes through {@link prepareTool} first. For a read-only tool that
 * is just validation; for a change it also computes WHAT the change would do —
 * the diff the approval card shows — without doing it. Only `run()` touches the
 * Space, and only after the user (or their auto-accept setting) said yes. An
 * invalid call (a missing match, a path that doesn't exist) therefore fails
 * before anyone is asked to approve it.
 *
 * The tool LIST is a constant: it is part of the cached prompt prefix and of the
 * prefix earlier thinking blocks are bound to, so it must not vary per chat or
 * per turn. Tools that don't apply (forms in an encrypted Space, skills in a
 * Space without any) explain that in their result instead of disappearing.
 */
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { AgentFS, AgentFsError, globToRegExp, normalizePath } from './agentFs'
import type { ToolRecord } from './chatStore'
import { unifiedDiff } from './diff'
import { FORMS_GUIDE } from './formsGuide'
import { renderSkill, type Brief } from './skills'

export class ToolInputError extends Error {}

export const TOOLS: BetaTool[] = [
  {
    name: 'list_files',
    description: 'List the files and folders of the Space (folders end with "/"). Optionally only those under a directory.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Optional folder, e.g. "notes". Defaults to the whole Space.' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file of the Space. Returns the content with line numbers ("12\\t…") — the numbers and the tab are NOT part of the file, never copy them into edit_file. Long files can be read in parts with offset/limit.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, e.g. "notes/meeting.md".' },
        offset: { type: 'integer', description: 'First line to return (1-based). Default 1.' },
        limit: { type: 'integer', description: 'Maximum number of lines. Default 2000.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description: 'Search the text of every page (and the file names) for a pattern. Returns "path:line: text" matches. Use it to find where something is mentioned before reading whole pages.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text to find. Literal unless regex=true.' },
        regex: { type: 'boolean', description: 'Treat pattern as a JavaScript regular expression. Default false.' },
        case_sensitive: { type: 'boolean', description: 'Default false.' },
        glob: { type: 'string', description: 'Only files matching this glob, e.g. "**/*.md" or "projects/**".' },
        context_lines: { type: 'integer', description: 'Lines of context around each match (0-5). Default 0.' },
        max_results: { type: 'integer', description: 'Default 100, max 500.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'space_map',
    description: 'The structure of the Space in one call: every Markdown page with its heading outline (level, text, line), no body text. Far cheaper than reading pages one by one to get an overview.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Optional folder to limit the map to.' },
        max_depth: { type: 'integer', description: 'Deepest heading level to include (1-6). Default 3.' },
      },
    },
  },
  {
    name: 'write_file',
    description: 'Create a page, or replace a page\'s entire content. Parent folders are created automatically. For changes to an existing page prefer edit_file. The user sees a diff and may reject the change.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, e.g. "projects/plan.md".' },
        content: { type: 'string', description: 'The complete new content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact passage in a text file. old_string must match the file exactly (whitespace included) and be unique, unless replace_all is true. The user sees a diff and may reject the change.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'The exact text to replace (without read_file\'s line-number prefixes).' },
        new_string: { type: 'string', description: 'The replacement text. May be empty to delete the passage.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file. Keeps its comments, reactions and history — always use this instead of write + delete. Update wiki-links that point to the old path afterwards.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string', description: 'New path. Parent folders are created automatically.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file or an empty folder. The user has to agree.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'open_page',
    description: 'Show a page of the Space to the user in the main view (next to this chat). Use it to point at a result.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'forms_guide',
    description: 'The complete guide to notation Forms (a folder with a _form.md template becomes a fillable form): template syntax, every field type, a worked example. Call it before creating or editing a form.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'load_skill',
    description: 'Load a skill listed in the system prompt: returns its SKILL.md instructions and the list of its other files. Pass `file` to read one of those other files (a template, a reference). Pass `args` to hand the skill its arguments, as a user would after /name.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name as listed.' },
        file: { type: 'string', description: 'Optional: a file inside the skill\'s folder, relative to it, e.g. "template.md".' },
        args: { type: 'string', description: 'Optional: arguments for the skill ($ARGUMENTS, $0, $1, … in its text).' },
      },
      required: ['name'],
    },
  },
]

export const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'move_file', 'delete_file'])

export interface ToolContext {
  fs: AgentFS
  brief: Brief
  openPage: (path: string) => void
}

export interface PreparedTool {
  mutating: boolean
  /** UI facts (status is filled in by the loop). */
  record: Omit<ToolRecord, 'status'>
  /** Do it. Returns the tool_result text for Claude. */
  run(): Promise<string>
  /** Reverse a completed change (mutating tools only, when possible). */
  undo?: () => Promise<void>
}

// ── input helpers ────────────────────────────────────────────────────────────

type Input = Record<string, unknown>

function asInput(raw: unknown): Input {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolInputError('input must be an object')
  return raw as Input
}

function str(i: Input, key: string, opts: { required?: boolean; allowEmpty?: boolean } = {}): string | undefined {
  const v = i[key]
  if (v === undefined || v === null) {
    if (opts.required) throw new ToolInputError(`"${key}" is required`)
    return undefined
  }
  if (typeof v !== 'string') throw new ToolInputError(`"${key}" must be a string`)
  if (!opts.allowEmpty && opts.required && v === '') throw new ToolInputError(`"${key}" must not be empty`)
  return v
}

function int(i: Input, key: string, def: number, min: number, max: number): number {
  const v = i[key]
  if (v === undefined || v === null) return def
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolInputError(`"${key}" must be a number`)
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function bool(i: Input, key: string): boolean {
  const v = i[key]
  return v === true || v === 'true'
}

function path(i: Input, key = 'path'): string {
  try {
    return normalizePath(str(i, key, { required: true }))
  } catch (e) {
    throw new ToolInputError((e as Error).message)
  }
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  let i = hay.indexOf(needle)
  while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length) }
  return n
}

const lineCount = (s: string) => (s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0))

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

/** Undo only restores a page nobody touched after the change. */
async function unchangedSince(fs: AgentFS, p: string, expected: string): Promise<void> {
  fs.refresh()
  const now = await fs.readText(p).catch(() => null)
  if (now !== expected) throw new Error(`${p} was changed after this edit — undoing would overwrite those changes`)
}

// ── implementations ──────────────────────────────────────────────────────────

export async function prepareTool(name: string, raw: unknown, ctx: ToolContext): Promise<PreparedTool> {
  const i = asInput(raw)
  const fs = ctx.fs
  switch (name) {
    case 'list_files': {
      const dirRaw = str(i, 'directory')
      const dir = dirRaw && dirRaw.trim() && dirRaw.trim() !== '/' && dirRaw.trim() !== '.' ? normalizePath(dirRaw) : ''
      return {
        mutating: false,
        record: { kind: 'list', summary: dir ? `${dir}/` : 'whole Space', path: dir || undefined },
        async run() {
          const nodes = (await fs.list()).filter(n => !dir || n.path === dir || n.path.startsWith(dir + '/'))
          const sorted = [...nodes].sort((a, b) => a.path.localeCompare(b.path))
          const files = sorted.filter(n => !n.isDir).length
          const MAX = 1500
          const lines = sorted.slice(0, MAX).map(n => (n.isDir ? `${n.path}/` : n.path))
          const head = `${files} file${files === 1 ? '' : 's'}, ${sorted.length - files} folder${sorted.length - files === 1 ? '' : 's'}${dir ? ` under ${dir}/` : ''}`
          if (sorted.length === 0) return dir ? `Nothing under ${dir}/ (it doesn't exist or is empty).` : 'The Space is empty.'
          return `${head}\n${lines.join('\n')}${sorted.length > MAX ? `\n… ${sorted.length - MAX} more (narrow with directory)` : ''}`
        },
      }
    }

    case 'read_file': {
      const p = path(i)
      const offset = int(i, 'offset', 1, 1, 10_000_000)
      const limit = int(i, 'limit', 2000, 1, 5000)
      return {
        mutating: false,
        record: { kind: 'read', summary: p, path: p },
        async run() {
          const text = await fs.readText(p)
          const lines = text.split('\n')
          if (text.endsWith('\n')) lines.pop()
          const total = lines.length
          if (total === 0) return `${p} is empty.`
          const start = Math.min(offset, total)
          const end = Math.min(total, start + limit - 1)
          const body = lines
            .slice(start - 1, end)
            .map((l, k) => `${start + k}\t${l.length > 3000 ? l.slice(0, 3000) + ' …[line truncated]' : l}`)
            .join('\n')
          const range = start === 1 && end === total ? `${total} lines` : `lines ${start}-${end} of ${total}`
          return `${p} (${range})\n${body}`
        },
      }
    }

    case 'search': {
      const pattern = str(i, 'pattern', { required: true })!
      if (pattern.length > 1000) throw new ToolInputError('pattern too long (max 1000 chars)')
      const useRegex = bool(i, 'regex')
      const flags = bool(i, 'case_sensitive') ? '' : 'i'
      let re: RegExp
      try {
        re = new RegExp(useRegex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
      } catch (e) {
        throw new ToolInputError(`invalid regular expression: ${(e as Error).message}`)
      }
      const globRaw = str(i, 'glob')
      const glob = globRaw && globRaw.trim() ? globToRegExp(globRaw) : null
      const ctxLines = int(i, 'context_lines', 0, 0, 5)
      const max = int(i, 'max_results', 100, 1, 500)
      return {
        mutating: false,
        record: { kind: 'search', summary: `“${clip(pattern, 60)}”` },
        async run() {
          const out: string[] = []
          let hits = 0
          const all = await fs.files()
          for (const p of all) {
            if (glob && !glob.test(p)) continue
            if (re.test(p)) { out.push(`${p} (file name matches)`); hits++ }
            if (hits >= max) break
          }
          const paths = await fs.textFiles(glob)
          const texts = await fs.readMany(paths)
          outer: for (const p of paths) {
            const t = texts.get(p)
            if (t === undefined) continue
            const lines = t.split('\n')
            for (let k = 0; k < lines.length; k++) {
              const line = lines[k].length > 2000 ? lines[k].slice(0, 2000) : lines[k]
              if (!re.test(line)) continue
              if (ctxLines > 0) {
                const from = Math.max(0, k - ctxLines)
                const to = Math.min(lines.length - 1, k + ctxLines)
                for (let c = from; c <= to; c++) out.push(`${p}:${c + 1}${c === k ? ':' : '-'} ${clip(lines[c], 300)}`)
                out.push('--')
              } else {
                out.push(`${p}:${k + 1}: ${clip(line.trim(), 300)}`)
              }
              if (++hits >= max) break outer
            }
          }
          if (hits === 0) return `No matches for ${useRegex ? '/' + pattern + '/' : `"${pattern}"`} in ${paths.length} text files.`
          return `${hits} match${hits === 1 ? '' : 'es'}${hits >= max ? ' (limit reached — narrow the search)' : ''}\n${out.join('\n')}`
        },
      }
    }

    case 'space_map': {
      const dirRaw = str(i, 'directory')
      const dir = dirRaw && dirRaw.trim() && dirRaw.trim() !== '/' ? normalizePath(dirRaw) : ''
      const depth = int(i, 'max_depth', 3, 1, 6)
      return {
        mutating: false,
        record: { kind: 'list', summary: dir ? `Map of ${dir}/` : 'Map of the Space' },
        async run() {
          const pages = (await fs.markdownFiles()).filter(p => !dir || p.startsWith(dir + '/'))
          const texts = await fs.readMany(pages)
          const out: string[] = []
          for (const p of pages) {
            out.push(p)
            const t = texts.get(p)
            if (!t) continue
            let fence = false
            t.split('\n').forEach((line, k) => {
              if (/^\s*(```|~~~)/.test(line)) fence = !fence
              if (fence) return
              const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
              if (m && m[1].length <= depth) out.push(`${'  '.repeat(m[1].length)}${'#'.repeat(m[1].length)} ${clip(m[2], 120)}  (L${k + 1})`)
            })
            if (out.length > 5000) { out.push('… (map truncated — pass a directory)'); break }
          }
          return pages.length === 0 ? 'No Markdown pages here.' : `${pages.length} pages\n${out.join('\n')}`
        },
      }
    }

    case 'write_file': {
      const p = path(i)
      const content = str(i, 'content', { required: true, allowEmpty: true }) ?? ''
      const kind = await fs.exists(p)
      if (kind === 'dir') throw new ToolInputError(`${p} is a folder`)
      let before = ''
      if (kind === 'file') {
        try {
          before = await fs.readText(p)
        } catch (e) {
          throw new ToolInputError(`refusing to overwrite ${p}: ${(e as Error).message}`)
        }
        if (before === content) throw new ToolInputError(`${p} already has exactly this content — nothing to change`)
      }
      const d = unifiedDiff(before, content)
      let prev: string | null = null
      return {
        mutating: true,
        record: {
          kind: 'write',
          path: p,
          summary: kind ? `Overwrite ${p}` : `Create ${p}`,
          diff: d.text + (d.truncated ? '\n… (diff truncated)' : ''),
          added: d.added,
          removed: d.removed,
        },
        async run() {
          // What is there NOW is what an undo restores (the user may have
          // edited the page while looking at the diff).
          prev = kind ? await fs.readText(p, true) : null
          await fs.writeText(p, content)
          return kind ? `Replaced ${p} (${lineCount(content)} lines, +${d.added}/-${d.removed}).` : `Created ${p} (${lineCount(content)} lines).`
        },
        async undo() {
          await unchangedSince(fs, p, content)
          if (prev === null) await fs.remove(p)
          else await fs.writeText(p, prev)
        },
      }
    }

    case 'edit_file': {
      const p = path(i)
      const oldS = str(i, 'old_string', { required: true, allowEmpty: true }) ?? ''
      const newS = str(i, 'new_string', { required: true, allowEmpty: true }) ?? ''
      const all = bool(i, 'replace_all')
      if (oldS === '') throw new ToolInputError('old_string is empty — use write_file to create a page')
      if (oldS === newS) throw new ToolInputError('old_string and new_string are identical — nothing to change')
      let before: string
      try {
        before = await fs.readText(p)
      } catch (e) {
        throw new ToolInputError((e as Error).message)
      }
      const apply = (text: string): string => {
        const n = countOccurrences(text, oldS)
        if (n === 0) {
          const hint = /^\s*\d+\t/m.test(oldS)
            ? ' It looks like it contains read_file line-number prefixes — remove them.'
            : ' Re-read the file and copy the passage exactly, whitespace included.'
          throw new ToolInputError(`old_string was not found in ${p}.${hint}`)
        }
        if (n > 1 && !all) throw new ToolInputError(`old_string occurs ${n} times in ${p}. Include more surrounding text to make it unique, or set replace_all.`)
        return all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS)
      }
      const after = apply(before)
      const d = unifiedDiff(before, after)
      let applied: { prev: string; next: string } | null = null
      return {
        mutating: true,
        record: {
          kind: 'edit',
          path: p,
          summary: `Edit ${p}`,
          diff: d.text + (d.truncated ? '\n… (diff truncated)' : ''),
          added: d.added,
          removed: d.removed,
        },
        async run() {
          // The page may have changed while the user looked at the diff:
          // re-apply the replacement to what is there now.
          const current = await fs.readText(p, true)
          const next = apply(current)
          await fs.writeText(p, next)
          applied = { prev: current, next }
          return `Edited ${p} (+${d.added}/-${d.removed} lines).`
        },
        async undo() {
          if (!applied) return
          await unchangedSince(fs, p, applied.next)
          await fs.writeText(p, applied.prev)
        },
      }
    }

    case 'move_file': {
      const from = path(i, 'from')
      const to = path(i, 'to')
      if (from === to) throw new ToolInputError('from and to are the same')
      const kind = await fs.exists(from)
      if (kind === null) throw new ToolInputError(`${from} does not exist`)
      if (kind === 'dir') throw new ToolInputError('moving whole folders is not supported — move the files one by one')
      if (await fs.exists(to)) throw new ToolInputError(`${to} already exists`)
      return {
        mutating: true,
        record: { kind: 'move', path: from, to, summary: `${from} → ${to}` },
        async run() {
          await fs.move(from, to)
          return `Moved ${from} to ${to}. Update wiki-links that pointed to the old path.`
        },
        async undo() {
          fs.refresh()
          if (await fs.exists(from)) throw new Error(`${from} exists again — undo would overwrite it`)
          await fs.move(to, from)
        },
      }
    }

    case 'delete_file': {
      const p = path(i)
      const kind = await fs.exists(p)
      if (kind === null) throw new ToolInputError(`${p} does not exist`)
      const before = kind === 'file' ? await fs.tryReadText(p) : null
      const d = before !== null ? unifiedDiff(before, '') : null
      return {
        mutating: true,
        record: {
          kind: 'delete',
          path: p,
          summary: `Delete ${p}`,
          diff: d ? d.text + (d.truncated ? '\n… (diff truncated)' : '') : undefined,
          removed: d?.removed,
        },
        async run() {
          await fs.remove(p)
          return `Deleted ${p}.`
        },
        // A binary file can't be restored from here; a folder had nothing in it.
        undo: before !== null
          ? async () => {
              fs.refresh()
              if (await fs.exists(p)) throw new Error(`${p} exists again — undo would overwrite it`)
              await fs.writeText(p, before)
            }
          : undefined,
      }
    }

    case 'open_page': {
      const p = path(i)
      return {
        mutating: false,
        record: { kind: 'other', path: p, summary: `Opened ${p}` },
        async run() {
          const kind = await fs.exists(p)
          if (kind !== 'file') throw new AgentFsError(`${p} is not a file of this Space`)
          ctx.openPage(p)
          return `Opened ${p} for the user.`
        },
      }
    }

    case 'forms_guide':
      return {
        mutating: false,
        record: { kind: 'other', summary: 'Forms guide' },
        async run() {
          return fs.encrypted
            ? 'Forms are not available in end-to-end encrypted Spaces (the server would have to read submissions). Use ordinary pages instead.'
            : FORMS_GUIDE
        },
      }

    case 'load_skill': {
      const want = (str(i, 'name', { required: true }) ?? '').trim().toLowerCase()
      const fileRaw = str(i, 'file')
      const args = str(i, 'args', { allowEmpty: true }) ?? ''
      const skill = ctx.brief.skills.find(s => s.name.toLowerCase() === want)
      if (!skill) {
        const names = ctx.brief.skills.filter(s => s.modelInvocable).map(s => s.name)
        throw new ToolInputError(names.length ? `No skill "${want}". Available: ${names.join(', ')}` : 'This Space has no skills.')
      }
      // Claude Code: `disable-model-invocation: true` — only the user runs it.
      if (!skill.modelInvocable && !fileRaw) {
        throw new ToolInputError(`The skill "${skill.name}" is run by the user only (with /${skill.name}); don't load it yourself.`)
      }
      const source = ctx.brief.sources[skill.source]
      if (!source) throw new ToolInputError(`the ${skill.source} skills are not reachable right now`)
      const dir = skill.path.includes('/') ? skill.path.slice(0, skill.path.lastIndexOf('/')) : ''
      let target = skill.path
      if (fileRaw && fileRaw.trim()) {
        let rel: string
        try { rel = normalizePath(fileRaw) } catch (e) { throw new ToolInputError((e as Error).message) }
        target = dir ? `${dir}/${rel}` : rel
      }
      return {
        mutating: false,
        record: { kind: 'read', summary: fileRaw ? `Skill ${skill.name}: ${fileRaw}` : `Skill ${skill.name}` },
        async run() {
          const text = await source.read(target)
          if (target !== skill.path) return `${target}\n\n${text}`
          // A root-level SKILL.md has no folder of its own to list.
          const others = dir ? (await source.files()).filter(f => f !== skill.path && f.startsWith(dir + '/')) : []
          const list = others.length
            ? `\n\nOther files of this skill (load with file="<relative path>"):\n${others.slice(0, 200).map(f => '- ' + (dir ? f.slice(dir.length + 1) : f)).join('\n')}`
            : ''
          return `Skill "${skill.name}" (${skill.path}${skill.source === 'library' ? ', from the skill library' : ''})\n\n${renderSkill(skill, text, args)}${list}`
        },
      }
    }

    default:
      throw new ToolInputError(`unknown tool "${name}"`)
  }
}
