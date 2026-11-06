/**
 * The assistant must load a Space's instructions exactly the way Claude Code
 * loads the same files in a pulled folder (code.claude.com/docs/en/memory), and
 * work from the same briefing text — these tests pin both.
 */
import { describe, expect, it } from 'vitest'
import { GUIDE_MARKER, guideFiles, RULES_PATH } from '../spaceGuide'
import { annotationsSection, changelogSection, untrustedSection, workingStyleSection } from '../spaceBriefing'
import {
  folderInstructions,
  MAX_IMPORT_HOPS,
  MAX_INSTRUCTION_CHARS,
  parseImports,
  renderInstruction,
  rootInstructions,
  stripBlockComments,
  type InstructionReader,
} from './instructions'
import { matchSlashCommand, mergeSkills, renderSkill, splitArgs } from './skills'
import { pathMatcher, skillFromText, SKILL_LISTING_CHARS, type Skill } from './skillFormat'
import { buildSystemPrompt } from './systemPrompt'

const reader = (files: Record<string, string>): InstructionReader => ({
  files: Object.keys(files),
  read: async (p) => files[p] ?? null,
})

describe('instruction files at the start', () => {
  it('reads CLAUDE.md, then CLAUDE.local.md — and then not AGENTS.md', async () => {
    const r = reader({ 'CLAUDE.md': 'project', 'CLAUDE.local.md': 'mine', 'AGENTS.md': 'agents' })
    const { mode, files } = await rootInstructions(r)
    expect(mode).toBe('claude')
    expect(files.map(f => [f.path, f.kind])).toEqual([['CLAUDE.md', 'project'], ['CLAUDE.local.md', 'local']])
  })

  it('a CLAUDE.local.md alone also keeps AGENTS.md out', async () => {
    const { mode, files } = await rootInstructions(reader({ 'CLAUDE.local.md': 'mine', 'AGENTS.md': 'agents' }))
    expect(mode).toBe('claude')
    expect(files.map(f => f.path)).toEqual(['CLAUDE.local.md'])
  })

  it('reads AGENTS.md when there is no CLAUDE file', async () => {
    const { mode, files } = await rootInstructions(reader({ 'AGENTS.md': 'agents', 'notes/CLAUDE.md': 'nested' }))
    expect(mode).toBe('agents')
    expect(files.map(f => f.path)).toEqual(['AGENTS.md'])
  })

  it('ignores a briefing the folder sync generated', async () => {
    const { mode, files } = await rootInstructions(reader({ 'CLAUDE.md': `${GUIDE_MARKER} v2 -->\n@AGENTS.md`, 'AGENTS.md': 'real' }))
    expect(mode).toBe('agents')
    expect(files.map(f => f.path)).toEqual(['AGENTS.md'])
  })
})

describe('@path imports', () => {
  it('expands imports relative to the importing file, in order, once each', async () => {
    const r = reader({
      'CLAUDE.md': 'See @docs/style.md and @README.md.\nAgain @docs/style.md',
      'docs/style.md': 'Style. Also @../glossary.md',
      'README.md': 'readme',
      'glossary.md': 'terms',
    })
    const { files } = await rootInstructions(r)
    expect(files.map(f => [f.path, f.kind, f.importedBy])).toEqual([
      ['CLAUDE.md', 'project', undefined],
      ['docs/style.md', 'import', 'CLAUDE.md'],
      ['glossary.md', 'import', 'docs/style.md'],
      ['README.md', 'import', 'CLAUDE.md'],
    ])
  })

  it('skips code spans, fenced blocks, quoted, home and absolute paths, and e-mail addresses', () => {
    const text = [
      'Use `@not/this.md` inline.',
      '```',
      '@not/fenced.md',
      '```',
      'Quoted "@not/quoted.md", home @~/x.md, abs @/etc/x.md',
      'Mail me: me@example.com',
      'Real @yes.md and @with\\ space.md',
    ].join('\n')
    // Raw specs: trailing punctuation is trimmed — and home/absolute paths
    // refused — when they are resolved against the Space.
    expect(parseImports(text)).toEqual(['~/x.md,', '/etc/x.md', 'yes.md', 'with space.md'])
  })

  it(`stops after ${MAX_IMPORT_HOPS} hops`, async () => {
    const r = reader({ 'CLAUDE.md': '@a.md', 'a.md': '@b.md', 'b.md': '@c.md', 'c.md': '@d.md', 'd.md': '@e.md', 'e.md': 'too deep' })
    const { files } = await rootInstructions(r)
    expect(files.map(f => f.path)).toEqual(['CLAUDE.md', 'a.md', 'b.md', 'c.md', 'd.md'])
  })

  it('cannot climb out of the Space', async () => {
    const { files } = await rootInstructions(reader({ 'CLAUDE.md': '@../outside.md' }))
    expect(files.map(f => f.path)).toEqual(['CLAUDE.md'])
  })
})

describe('instruction text', () => {
  it('strips block HTML comments, but not inside code blocks', () => {
    const text = 'keep\n<!-- one line -->\n<!--\nmany\nlines\n-->\nafter\n```\n<!-- code -->\n```'
    expect(stripBlockComments(text)).toBe('keep\nafter\n```\n<!-- code -->\n```')
  })

  it('cuts a huge file and says how to read the rest', async () => {
    const { files } = await rootInstructions(reader({ 'CLAUDE.md': 'x'.repeat(MAX_INSTRUCTION_CHARS + 10) }))
    expect(files[0].truncated).toBe(true)
    expect(files[0].text.length).toBe(MAX_INSTRUCTION_CHARS)
    expect(renderInstruction(files[0])).toContain('read the rest of CLAUDE.md with read_file')
  })
})

describe('folder instructions on demand', () => {
  const space = {
    'CLAUDE.md': 'root',
    'notes/CLAUDE.md': 'notes rules',
    'notes/deep/CLAUDE.local.md': 'deep, private',
    'notes/deep/page.md': 'page',
    'notes/deep/AGENTS.md': 'agents deep',
    'other/AGENTS.md': 'other agents',
    'other/page.md': 'p',
  }

  it('loads every CLAUDE file from the top down to the touched file, once', async () => {
    const loaded = new Set(['CLAUDE.md'])
    const got = await folderInstructions(reader(space), [{ path: 'notes/deep/page.md', op: 'write' }], loaded, 'claude')
    expect(got.map(f => f.path)).toEqual(['notes/CLAUDE.md', 'notes/deep/CLAUDE.local.md'])
    // Second touch: nothing new.
    expect(await folderInstructions(reader(space), [{ path: 'notes/deep/page.md', op: 'read' }], loaded, 'claude')).toEqual([])
  })

  it('never loads AGENTS.md in a Space that runs on CLAUDE.md', async () => {
    const got = await folderInstructions(reader(space), [{ path: 'other/page.md', op: 'read' }], new Set(), 'claude')
    expect(got).toEqual([])
  })

  it("in AGENTS.md mode: a folder's AGENTS.md on a read, unless the folder has a CLAUDE file", async () => {
    const r = reader({ 'AGENTS.md': 'root', 'other/AGENTS.md': 'other agents', 'other/page.md': 'p', 'mixed/AGENTS.md': 'x', 'mixed/CLAUDE.md': 'c', 'mixed/p.md': 'p' })
    expect(await folderInstructions(r, [{ path: 'other/page.md', op: 'write' }], new Set(), 'agents')).toEqual([])
    expect((await folderInstructions(r, [{ path: 'other/page.md', op: 'read' }], new Set(), 'agents')).map(f => f.path)).toEqual(['other/AGENTS.md'])
    expect((await folderInstructions(r, [{ path: 'mixed/p.md', op: 'read' }], new Set(), 'agents')).map(f => f.path)).toEqual(['mixed/CLAUDE.md'])
  })

  it('reading an instruction file itself counts as loading it', async () => {
    const loaded = new Set<string>()
    const got = await folderInstructions(reader(space), [{ path: 'notes/CLAUDE.md', op: 'read' }], loaded, 'claude')
    expect(got).toEqual([])
    expect(loaded.has('notes/CLAUDE.md')).toBe(true)
  })
})

describe('skills, the Claude Code way', () => {
  const skill = (fm: string, body = 'Body') => skillFromText('skills/x/SKILL.md', `---\n${fm}\n---\n${body}`, 'space')

  it('reads the frontmatter flags', () => {
    const s = skill('name: deploy\ndescription: Ship it\nwhen_to_use: after merge\ndisable-model-invocation: true\nuser-invocable: false\npaths: ["src/**", "*.md"]\narguments: [env, tag]\nargument-hint: <env> <tag>')
    expect(s).toMatchObject({
      name: 'deploy', description: 'Ship it after merge', modelInvocable: false, userInvocable: false,
      paths: ['src/**', '*.md'], argNames: ['env', 'tag'], argumentHint: '<env> <tag>',
    })
  })

  it('falls back to the folder name and the first line, and caps the listing', () => {
    const s = skillFromText('skills/protokoll/SKILL.md', '# Write minutes\n\nmore', 'space')
    expect(s.name).toBe('protokoll')
    expect(s.description).toBe('Write minutes')
    expect(skill(`name: long\ndescription: ${'a'.repeat(3000)}`).description.length).toBe(SKILL_LISTING_CHARS)
  })

  it('matches paths like Claude Code rules', () => {
    const m = pathMatcher(['/*.md', 'src/**/*.{ts,tsx}'])
    expect(m('README.md')).toBe(true)
    expect(m('docs/README.md')).toBe(false)
    expect(m('src/a/b.tsx')).toBe(true)
    expect(m('lib/b.ts')).toBe(false)
  })

  it('substitutes arguments and appends them when there is no placeholder', () => {
    const named = skill('name: a\narguments: [who]', 'Hi $who, all: $ARGUMENTS, first: $0, second: $ARGUMENTS[1]. Dir ${CLAUDE_SKILL_DIR}')
    expect(renderSkill(named, `---\narguments: [who]\n---\nHi $who, all: $ARGUMENTS, first: $0, second: $ARGUMENTS[1]. Dir \${CLAUDE_SKILL_DIR}`, 'Ada "the second"'))
      .toBe('Base directory for this skill: skills/x\n\nHi Ada, all: Ada "the second", first: Ada, second: the second. Dir skills/x')
    const plain = skill('name: b', 'Do it.')
    expect(renderSkill(plain, '---\nname: b\n---\nDo it.', 'now')).toBe('Base directory for this skill: skills/x\n\nDo it.\n\nARGUMENTS: now')
    expect(splitArgs(`a "b c" 'd'`)).toEqual(['a', 'b c', 'd'])
  })

  it('never runs shell preprocessing', () => {
    const s = skill('name: c')
    const out = renderSkill(s, '---\nname: c\n---\nNow: !`date`\n```!\nrm -rf /\n```\n')
    expect(out).not.toContain('date`')
    expect(out).not.toContain('rm -rf')
    expect(out).toContain('shell command execution is not available')
  })

  it('/name runs only user-invocable skills', () => {
    const skills: Skill[] = [skill('name: minutes'), skill('name: hidden\nuser-invocable: false')]
    expect(matchSlashCommand('/minutes 2026-11-06', skills)).toMatchObject({ skill: { name: 'minutes' }, args: '2026-11-06' })
    expect(matchSlashCommand('/hidden', skills)).toBeNull()
    expect(matchSlashCommand('please /minutes', skills)).toBeNull()
  })

  it('a library (personal) skill wins a name clash with the Space (project) one', () => {
    const own = skillFromText('skills/a/SKILL.md', '---\nname: a\ndescription: own\n---\n', 'space')
    const lib = skillFromText('a/SKILL.md', '---\nname: A\ndescription: lib\n---\n', 'library')
    expect(mergeSkills([own], [lib]).map(s => s.description)).toEqual(['lib'])
  })
})

describe('one briefing for the panel and for Claude Code', () => {
  const brief = { memory: { mode: 'claude' as const, files: [] }, skills: [], sources: { space: null, library: null } }

  it('the panel prompt and the folder rule share the same sections word for word', () => {
    const prompt = buildSystemPrompt({ spaceId: 's', spaceName: 'Team', encrypted: false, brief, globalInstructions: 'Owner says hi.' })
    const rule = guideFiles({ spaceName: 'Team', encrypted: false, formFolders: [], fileCount: 1, ownerInstructions: 'Owner says hi.' })
      .find(g => g.name === RULES_PATH)!.content
    for (const section of [untrustedSection(), changelogSection('chat').split('\n')[0], annotationsSection('chat').split('\n')[0], workingStyleSection('chat').split('\n')[0]]) {
      expect(prompt).toContain(section)
      expect(rule).toContain(section)
    }
    expect(prompt).toContain('Owner says hi.')
    expect(rule).toContain('Owner says hi.')
  })
})
