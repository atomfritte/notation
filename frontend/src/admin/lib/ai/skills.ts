/**
 * skills — the instructions and skills a chat starts with.
 *
 * The same Space is worked on here and by Claude Code in a pulled folder, and
 * both get the same brief (the folder pull mirrors it — see spaceGuide.ts):
 *
 *   - **Instruction files** (instructions.ts): `CLAUDE.md` / `CLAUDE.local.md`
 *     or `AGENTS.md`, with `@imports`, loaded by Claude Code's rules.
 *   - **Skills**: every `SKILL.md` in the Space (a folder per skill, e.g.
 *     `skills/protokoll/SKILL.md`). Claude Code's frontmatter applies: only the
 *     name and `description` + `when_to_use` (cut at 1,536 characters) are
 *     listed; the body is loaded on demand with `load_skill` — progressive
 *     disclosure. `disable-model-invocation: true` keeps a skill out of the
 *     listing (the user runs it with `/name`), `user-invocable: false` hides it
 *     from the `/` menu, `paths:` lists it only once Claude works on a matching
 *     file, `arguments:` names `$name` placeholders.
 *   - **Skill library**: optionally a second (plaintext) Space whose skills are
 *     offered in every chat — the counterpart of Claude Code's personal skills
 *     (`~/.claude/skills`), and like those it wins a name clash with the
 *     Space's own ("personal over project").
 */
import * as api from '../api'
import type { AgentFS } from './agentFs'
import { isSkillFile, neutralizeShell, parseFrontmatter, skillFromText, type Skill } from './skillFormat'
import { rootInstructions, type InstructionFile, type InstructionMode } from './instructions'
import type { SkillMirrorInput } from '../spaceGuide'

export { NO_SHELL, SKILL_LISTING_CHARS, isSkillFile, parseFrontmatter, parseSkillFrontmatter, pathMatcher, skillFromText, type Skill } from './skillFormat'

export interface SkillSource {
  /** Read a file next to (or below) a skill's SKILL.md. */
  read(path: string): Promise<string>
  /** All file paths of that Space. */
  files(): Promise<string[]>
}

export interface Brief {
  /** Instruction files in force from the start, and the mode they were found in. */
  memory: { mode: InstructionMode; files: InstructionFile[] }
  skills: Skill[]
  /** For load_skill: how to read each source. */
  sources: Record<Skill['source'], SkillSource | null>
}

/**
 * Merge skills by name, Claude Code's precedence: a personal (library) skill
 * wins over the project's (this Space's) one of the same name.
 */
export function mergeSkills(own: Skill[], library: Skill[]): Skill[] {
  const lib = new Set(library.map(s => s.name.toLowerCase()))
  const out = [...library, ...own.filter(s => !lib.has(s.name.toLowerCase()))]
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Collect the brief for a chat in `fs`'s Space. Never throws for a missing piece. */
export async function collectBrief(fs: AgentFS, opts: { librarySpace?: string; currentSpace: string }): Promise<Brief> {
  const files = await fs.files().catch(() => [] as string[])
  const memory = await rootInstructions({ files, read: (p) => fs.tryReadText(p) }).catch(() => ({ mode: 'claude' as const, files: [] }))

  const own: Skill[] = []
  const skillPaths = files.filter(isSkillFile)
  const texts = await fs.readMany(skillPaths)
  for (const p of skillPaths) {
    const t = texts.get(p)
    if (t !== undefined) own.push(skillFromText(p, t, 'space'))
  }

  const sources: Brief['sources'] = {
    space: { read: (p) => fs.readText(p), files: () => fs.files() },
    library: null,
  }

  const library: Skill[] = []
  const lib = opts.librarySpace?.trim()
  if (lib && lib !== opts.currentSpace) {
    try {
      const loaded = await loadLibrary(lib)
      if (loaded) {
        sources.library = loaded.source
        library.push(...loaded.skills)
      }
    } catch { /* library missing or unreachable: chat works without it */ }
  }

  return { memory, skills: mergeSkills(own, library), sources }
}

/**
 * The skill library Space: its skills and a reader. Plaintext only — a
 * zero-knowledge library would need its own unlock. Null when not usable.
 */
export async function loadLibrary(lib: string): Promise<{ skills: Skill[]; source: SkillSource } | null> {
  const meta = await api.getSpace(lib)
  if (meta.encrypted) return null
  const libFiles = await api.listFilesFlat(lib)
  const source: SkillSource = {
    read: async (p) => (await api.readFile(lib, p)).content,
    files: async () => libFiles,
  }
  const skills: Skill[] = []
  for (const p of libFiles.filter(isSkillFile)) {
    try {
      skills.push(skillFromText(p, await source.read(p), 'library'))
    } catch { /* unreadable: skip */ }
  }
  return { skills, source }
}

/**
 * The library's skills as the folder pull mirrors them into `.claude/skills/`:
 * each SKILL.md with its folder's other files. Empty when there is no usable
 * library — the pull never fails over it.
 */
export async function librarySkillMirrors(lib: string | undefined, currentSpace: string): Promise<SkillMirrorInput[]> {
  const id = lib?.trim()
  if (!id || id === currentSpace) return []
  try {
    const loaded = await loadLibrary(id)
    if (!loaded) return []
    const files = await loaded.source.files()
    const out: SkillMirrorInput[] = []
    for (const skill of loaded.skills) {
      const dir = skill.path.includes('/') ? skill.path.slice(0, skill.path.lastIndexOf('/') + 1) : ''
      if (!dir) continue // a root SKILL.md would drag the whole library along
      const extra = new Map<string, Uint8Array>()
      for (const f of files) {
        if (!f.startsWith(dir) || f === skill.path) continue
        try { extra.set(f.slice(dir.length), await api.readFileBytes(id, f)) } catch { /* skip unreadable */ }
      }
      out.push({ name: skill.name, source: 'library', path: skill.path, text: await loaded.source.read(skill.path), extra })
    }
    return out
  } catch {
    return []
  }
}

// ── invocation ───────────────────────────────────────────────────────────────

/** Split an argument string like a shell would (quotes group words). */
export function splitArgs(args: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m; (m = re.exec(args));) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * A SKILL.md rendered for the model, as Claude Code does on invocation:
 * frontmatter removed, `$ARGUMENTS` / `$ARGUMENTS[N]` / `$N` / `$name` /
 * `${CLAUDE_SKILL_DIR}` substituted, `` !`cmd` `` and ```` ```! ```` blocks
 * replaced (there is no shell here), and `ARGUMENTS: …` appended when the
 * skill has no placeholder for arguments it was given.
 */
export function renderSkill(skill: Skill, text: string, args = ''): string {
  const { body } = parseFrontmatter(text)
  const dir = skill.path.includes('/') ? skill.path.slice(0, skill.path.lastIndexOf('/')) : ''
  const list = splitArgs(args)
  let used = false
  let out = neutralizeShell(body)
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, dir || '.')
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_m, n: string) => { used = true; return list[Number(n)] ?? '' })
    .replace(/\$ARGUMENTS\b/g, () => { used = true; return args })
    .replace(/\$(\d+)\b/g, (_m, n: string) => { used = true; return list[Number(n)] ?? '' })
  for (const [i, name] of (skill.argNames ?? []).entries()) {
    out = out.replace(new RegExp(`\\$${name.replace(/[^\w-]/g, '')}\\b`, 'g'), () => { used = true; return list[i] ?? '' })
  }
  if (args.trim() && !used) out = `${out.trimEnd()}\n\nARGUMENTS: ${args.trim()}`
  return `Base directory for this skill: ${dir || '(Space root)'}${skill.source === 'library' ? ' — in the skill library Space' : ''}\n\n${out.trim()}`
}

/** `/name args` at the start of a message → the user-invocable skill and its arguments. */
export function matchSlashCommand(text: string, skills: Skill[]): { skill: Skill; args: string } | null {
  const m = /^\/([\w:.-]+)(?:[ \t]+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  const skill = skills.find(s => s.userInvocable && s.name.toLowerCase() === m[1].toLowerCase())
  return skill ? { skill, args: (m[2] ?? '').trim() } : null
}
