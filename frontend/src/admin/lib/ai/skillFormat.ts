/**
 * skillFormat — reading a SKILL.md the way Claude Code does (frontmatter
 * fields, listing text, `paths:` globs). Dependency-free, so both the chat
 * (skills.ts) and the folder sync (spaceGuide.ts) use the same rules.
 */
/** Claude Code: description + when_to_use are "truncated at 1,536 characters in the skill listing". */
export const SKILL_LISTING_CHARS = 1536

export interface Skill {
  name: string
  /** description + when_to_use, as listed. */
  description: string
  /** Where it lives: this Space, or the library Space. */
  source: 'space' | 'library'
  /** Path of the SKILL.md inside its Space. */
  path: string
  /** Claude may load it by itself (false: `disable-model-invocation: true`). */
  modelInvocable: boolean
  /** Offered as `/name` to the user (false: `user-invocable: false`). */
  userInvocable: boolean
  /** Glob patterns (`paths:`): listed only once Claude works on a matching file. */
  paths?: string[]
  /** Named arguments (`arguments:`), for `$name` placeholders. */
  argNames?: string[]
  argumentHint?: string
}

type FmValue = string | string[]

/**
 * A small YAML-frontmatter reader for the fields skills use: `key: value`,
 * quoted values, block scalars (`>`/`|`), lists (`- a` lines or `[a, b]`).
 * Keys are lower-cased. Malformed frontmatter yields what parsed.
 */
export function parseFrontmatter(text: string): { data: Record<string, FmValue>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { data: {}, body: text }
  const data: Record<string, FmValue> = {}
  const lines = m[1].split(/\r?\n/)
  const unquote = (v: string) => v.trim().replace(/^(["'])([\s\S]*)\1$/, '$2')
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    const key = kv[1].toLowerCase()
    let value = kv[2].trim()
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) parts.push(lines[++i].trim())
      data[key] = value.startsWith('|') ? parts.join('\n').trim() : parts.filter(Boolean).join(' ')
    } else if (value === '') {
      const items: string[] = []
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s*-\s+/, '')))
      data[key] = items.length ? items : ''
    } else if (/^\[.*\]$/.test(value)) {
      data[key] = value.slice(1, -1).split(',').map(unquote).filter(Boolean)
    } else {
      data[key] = unquote(value)
    }
  }
  return { data, body: text.slice(m[0].length) }
}

/** Kept for callers that only need the two classic fields. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const { data } = parseFrontmatter(text)
  const s = (v: FmValue | undefined) => (typeof v === 'string' && v ? v : undefined)
  return { name: s(data.name), description: s(data.description) }
}

const asList = (v: FmValue | undefined): string[] | undefined => {
  if (v === undefined || v === '') return undefined
  const list = Array.isArray(v) ? v : v.split(',')
  const out = list.map(s => s.trim()).filter(Boolean)
  return out.length ? out : undefined
}
const asBool = (v: FmValue | undefined, def: boolean) =>
  typeof v === 'string' && /^(true|false)$/i.test(v.trim()) ? v.trim().toLowerCase() === 'true' : def

export const isSkillFile = (p: string) => /(^|\/)SKILL\.md$/i.test(p)

/** What stands in for shell preprocessing: notation runs no commands from a skill. */
export const NO_SHELL = '[shell command execution is not available in notation]'

/**
 * Replace Claude Code's shell preprocessing — `` !`cmd` `` and ```` ```! ````
 * blocks — with {@link NO_SHELL}. A skill is Space content, which other people
 * may have written; its commands must never run, not in the panel and not in
 * a Claude Code session the folder sync set up.
 */
export function neutralizeShell(body: string): string {
  return body
    .replace(/^```!.*\n[\s\S]*?^```[ \t]*$/gm, NO_SHELL)
    .replace(/!`[^`\n]+`/g, NO_SHELL)
}

/**
 * The frontmatter of a skill as the panel understands it, for Claude Code:
 * only these fields, re-serialised from what was parsed. Everything else a
 * SKILL.md might carry — `allowed-tools` (pre-approved tool use), `hooks`,
 * `model`, `context`, `agent`, … — is dropped, so a mirrored skill can do in
 * Claude Code exactly what it can do in the panel and no more.
 */
export function mirrorFrontmatter(skill: Skill, name: string): string {
  const q = (v: string) => JSON.stringify(v) // a JSON string is a valid YAML double-quoted scalar
  const lines = [`name: ${q(name)}`, `description: ${q(skill.description)}`]
  if (!skill.modelInvocable) lines.push('disable-model-invocation: true')
  if (!skill.userInvocable) lines.push('user-invocable: false')
  if (skill.paths) lines.push(`paths: ${JSON.stringify(skill.paths)}`)
  if (skill.argNames) lines.push(`arguments: ${JSON.stringify(skill.argNames)}`)
  if (skill.argumentHint) lines.push(`argument-hint: ${q(skill.argumentHint)}`)
  return `---\n${lines.join('\n')}\n---\n`
}

export function skillFromText(path: string, text: string, source: Skill['source']): Skill {
  const { data, body } = parseFrontmatter(text)
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const fallbackName = dir ? dir.slice(dir.lastIndexOf('/') + 1) : 'skill'
  const str = (v: FmValue | undefined) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : '')
  // Claude Code: "If omitted, uses the first non-empty line of the markdown content."
  let description = str(data.description).trim()
  if (!description) description = body.split('\n').map(s => s.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''
  const when = str(data.when_to_use).trim()
  const listed = (when ? `${description} ${when}` : description).replace(/\s+/g, ' ').trim()
  return {
    name: (str(data.name) || fallbackName).trim(),
    description: listed.length > SKILL_LISTING_CHARS ? listed.slice(0, SKILL_LISTING_CHARS - 1) + '…' : listed,
    source,
    path,
    modelInvocable: !asBool(data['disable-model-invocation'], false),
    userInvocable: asBool(data['user-invocable'], true),
    paths: asList(data.paths),
    argNames: asList(data.arguments),
    argumentHint: str(data['argument-hint']).trim() || undefined,
  }
}

/** Expand `{a,b}` groups (bounded, like Claude Code's 1,000-pattern budget). */
function expandBraces(p: string, budget = { n: 1000 }): string[] {
  const m = /\{([^{}]*)\}/.exec(p)
  if (!m) return [p]
  const out: string[] = []
  for (const alt of m[1].split(',')) {
    if (--budget.n < 0) return [p]
    out.push(...expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length), budget))
  }
  return out
}

/**
 * Matcher for `paths:` globs, relative to the Space root, in Claude Code's
 * rule-glob format: `**` any depth, `*.md` any depth, `/*.md` the root only.
 */
export function pathMatcher(patterns: string[]): (path: string) => boolean {
  const res: RegExp[] = []
  for (const raw of patterns) {
    for (const p of expandBraces(raw.trim())) {
      if (!p) continue
      res.push(globToRegExp(p, { anchored: p.startsWith('/') }))
    }
  }
  return (path) => res.some(r => r.test(path))
}

/**
 * Translate a shell-style glob to an anchored RegExp: `**` any depth, `*` one
 * segment, `?` one character. A pattern without a slash matches the basename
 * at any depth, which is what people mean by `*.md`.
 */
export function globToRegExp(glob: string, opts: { anchored?: boolean } = {}): RegExp {
  let g = glob.trim().replace(/^\.\/+/, '').replace(/^\/+/, '')
  // `anchored`: a slash-less pattern means the root only (Claude Code's `/*.md`).
  if (!g.includes('/') && !opts.anchored) g = '**/' + g
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` matches zero or more whole segments.
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i++ }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}
