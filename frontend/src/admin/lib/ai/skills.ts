/**
 * skills — the instructions and skills a chat starts with.
 *
 * Mirrors how a local CLI agent picks up its brief from a pulled folder, so the
 * same Space behaves the same whether it is worked on via folder sync + Claude
 * Code or right here in the side panel:
 *
 *   - **Space instructions**: a real (non-generated) `AGENTS.md` and/or
 *     `CLAUDE.md` in the Space root, included verbatim in the system prompt.
 *   - **Skills**: every `SKILL.md` in the Space (Claude Code's convention: a
 *     folder per skill, e.g. `skills/protokoll/SKILL.md`). Only the name and the
 *     description from its frontmatter go into the prompt; the body is loaded
 *     on demand with the `load_skill` tool — progressive disclosure, so a large
 *     skill library costs nothing until a skill is actually used.
 *   - **Skill library**: optionally, a second (plaintext) Space whose skills are
 *     available in every chat, configured in the assistant settings.
 */
import { utf8Encode } from '../../../shared/crypto/bytes'
import * as api from '../api'
import { isGeneratedGuide } from '../spaceGuide'
import type { AgentFS } from './agentFs'

/** Cap per instruction file in the system prompt (bytes of text). */
const MAX_INSTRUCTION_CHARS = 24_000

export interface Skill {
  name: string
  description: string
  /** Where it lives: this Space, or the library Space. */
  source: 'space' | 'library'
  /** Path of the SKILL.md inside its Space. */
  path: string
}

export interface SkillSource {
  /** Read a file next to (or below) a skill's SKILL.md. */
  read(path: string): Promise<string>
  /** All file paths of that Space. */
  files(): Promise<string[]>
}

export interface Brief {
  instructions: { path: string; text: string; truncated: boolean }[]
  skills: Skill[]
  /** For load_skill: how to read each source. */
  sources: Record<Skill['source'], SkillSource | null>
}

/** Parse `name:` / `description:` from a leading YAML frontmatter block. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const out: { name?: string; description?: string } = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    let value = kv[2].trim()
    // Folded/literal block scalars: take the indented lines that follow.
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim())
      value = parts.join(' ')
    }
    value = value.replace(/^["']|["']$/g, '')
    out[kv[1] as 'name' | 'description'] = value
  }
  return out
}

const isSkillFile = (p: string) => /(^|\/)SKILL\.md$/i.test(p)

function skillFromText(path: string, text: string, source: Skill['source']): Skill {
  const fm = parseSkillFrontmatter(text)
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const fallbackName = dir ? dir.slice(dir.lastIndexOf('/') + 1) : 'skill'
  let description = fm.description ?? ''
  if (!description) {
    // No frontmatter: the first paragraph that isn't a heading.
    const body = text.replace(/^---[\s\S]*?---/, '')
    description = body.split(/\n\s*\n/).map(s => s.trim()).find(s => s && !s.startsWith('#')) ?? ''
  }
  return {
    name: (fm.name || fallbackName).trim(),
    description: description.replace(/\s+/g, ' ').slice(0, 400),
    source,
    path,
  }
}

/** Collect the brief for a chat in `fs`'s Space. Never throws for a missing piece. */
export async function collectBrief(fs: AgentFS, opts: { librarySpace?: string; currentSpace: string }): Promise<Brief> {
  const files = await fs.files().catch(() => [] as string[])
  const instructions: Brief['instructions'] = []
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    if (!files.includes(name)) continue
    const text = await fs.tryReadText(name)
    if (!text || isGeneratedGuide(utf8Encode(text.slice(0, 600)))) continue
    const truncated = text.length > MAX_INSTRUCTION_CHARS
    instructions.push({ path: name, text: truncated ? text.slice(0, MAX_INSTRUCTION_CHARS) : text, truncated })
  }

  const skills: Skill[] = []
  const skillPaths = files.filter(isSkillFile)
  const texts = await fs.readMany(skillPaths)
  for (const p of skillPaths) {
    const t = texts.get(p)
    if (t !== undefined) skills.push(skillFromText(p, t, 'space'))
  }

  const sources: Brief['sources'] = {
    space: { read: (p) => fs.readText(p), files: () => fs.files() },
    library: null,
  }

  const lib = opts.librarySpace?.trim()
  if (lib && lib !== opts.currentSpace) {
    try {
      const meta = await api.getSpace(lib)
      // A zero-knowledge library would need its own unlock; plaintext only.
      if (!meta.encrypted) {
        const libFiles = await api.listFilesFlat(lib)
        const source: SkillSource = {
          read: async (p) => (await api.readFile(lib, p)).content,
          files: async () => libFiles,
        }
        sources.library = source
        const own = new Set(skills.map(s => s.name.toLowerCase()))
        for (const p of libFiles.filter(isSkillFile)) {
          try {
            const s = skillFromText(p, await source.read(p), 'library')
            // A Space's own skill of the same name wins.
            if (!own.has(s.name.toLowerCase())) skills.push(s)
          } catch { /* unreadable: skip */ }
        }
      }
    } catch { /* library missing or unreachable: chat works without it */ }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { instructions, skills, sources }
}
