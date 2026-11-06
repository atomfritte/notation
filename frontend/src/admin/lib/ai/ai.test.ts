import { describe, expect, it } from 'vitest'
import { generateDEK, importContentKey } from '../../../shared/crypto/keys'
import { utf8Decode, utf8Encode } from '../../../shared/crypto/bytes'
import type { SyncNode, SyncSpace } from '../syncSpace'
import { GUIDE_MARKER } from '../spaceGuide'
import { AgentFS, AgentFsError, globToRegExp, normalizePath } from './agentFs'
import { buildParams } from './agent'
import { plainCodec, sealedCodec, newChatId, type Chat } from './chatStore'
import { unifiedDiff } from './diff'
import { addUsage, emptyUsage } from './models'
import { collectBrief, parseSkillFrontmatter, type Brief } from './skills'
import { buildSystemPrompt } from './systemPrompt'
import { TOOLS, ToolInputError, prepareTool, type ToolContext } from './tools'

/** An in-memory Space behind the SyncSpace port, like either real backend. */
class MemSpace implements SyncSpace {
  readonly encrypted = false
  files = new Map<string, Uint8Array>()
  constructor(init: Record<string, string> = {}) {
    for (const [p, t] of Object.entries(init)) this.files.set(p, utf8Encode(t))
  }
  text(p: string) {
    const b = this.files.get(p)
    return b ? utf8Decode(b) : undefined
  }
  async listNodes(): Promise<SyncNode[]> {
    const dirs = new Set<string>()
    for (const p of this.files.keys()) {
      const segs = p.split('/')
      for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'))
    }
    return [
      ...[...dirs].map(path => ({ path, isDir: true })),
      ...[...this.files.keys()].map(path => ({ path, isDir: false })),
    ]
  }
  async read(p: string) {
    const b = this.files.get(p)
    if (!b) throw new Error(`${p} does not exist`)
    return b
  }
  async write(p: string, bytes: Uint8Array) { this.files.set(p, bytes) }
  async move(from: string, to: string) {
    const b = this.files.get(from)
    if (!b) throw new Error('missing')
    this.files.delete(from)
    this.files.set(to, b)
  }
  async remove(p: string) { this.files.delete(p) }
  async flush() {}
  async pruneEmptyDirs() { return [] }
}

const noBrief: Brief = { instructions: [], skills: [], sources: { space: null, library: null } }

function ctxFor(space: MemSpace, hooks = {}): ToolContext {
  return { fs: new AgentFS(space, hooks), brief: noBrief, openPage: () => {} }
}

describe('normalizePath', () => {
  it('accepts ordinary Space paths and tidies them', () => {
    expect(normalizePath('notes/a.md')).toBe('notes/a.md')
    expect(normalizePath(' /notes/a.md ')).toBe('notes/a.md')
    expect(normalizePath('./notes\\a.md')).toBe('notes/a.md')
    expect(normalizePath('notes/')).toBe('notes')
  })
  it('rejects traversal, dot-segments, hidden files and junk', () => {
    for (const bad of ['../x.md', 'a/../b.md', 'a/./b.md', '.notation/chats/x.json', 'a/.git/config', '', '   ', 'a//b.md']) {
      expect(() => normalizePath(bad), bad).toThrow(AgentFsError)
    }
    expect(() => normalizePath(42)).toThrow(AgentFsError)
  })
  it('NFC-normalises so a decomposed umlaut finds the stored page', () => {
    expect(normalizePath('Müller.md')).toBe('Müller.md')
  })
})

describe('globToRegExp', () => {
  it('matches basenames at any depth when the glob has no slash', () => {
    const re = globToRegExp('*.md')
    expect(re.test('a.md')).toBe(true)
    expect(re.test('x/y/a.md')).toBe(true)
    expect(re.test('a.txt')).toBe(false)
  })
  it('anchors globs with a slash at the root', () => {
    const re = globToRegExp('notes/*.md')
    expect(re.test('notes/a.md')).toBe(true)
    expect(re.test('notes/sub/a.md')).toBe(false)
    expect(globToRegExp('notes/**/*.md').test('notes/sub/a.md')).toBe(true)
  })
})

describe('unifiedDiff', () => {
  it('counts added and removed lines', () => {
    const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\nd\n')
    expect(d.added).toBe(2)
    expect(d.removed).toBe(1)
    expect(d.text).toContain('-b')
    expect(d.text).toContain('+B')
    expect(d.text).toContain('+d')
  })
  it('is empty for identical text', () => {
    const d = unifiedDiff('same\n', 'same\n')
    expect(d.added).toBe(0)
    expect(d.removed).toBe(0)
  })
  it('handles a new file', () => {
    const d = unifiedDiff('', 'one\ntwo\n')
    expect(d.added).toBe(2)
    expect(d.removed).toBe(0)
  })
})

describe('parseSkillFrontmatter', () => {
  it('reads name and description', () => {
    expect(parseSkillFrontmatter('---\nname: protokoll\ndescription: "Writes meeting minutes"\n---\n# x')).toEqual({ name: 'protokoll', description: 'Writes meeting minutes' })
  })
  it('folds block scalars', () => {
    const fm = parseSkillFrontmatter('---\nname: a\ndescription: >\n  first line\n  second line\n---\nbody')
    expect(fm.description).toBe('first line second line')
  })
  it('returns nothing without frontmatter', () => {
    expect(parseSkillFrontmatter('# Just a page')).toEqual({})
  })
})

describe('chat record codecs', () => {
  it('plain codec round-trips JSON', async () => {
    const v = { a: 1, s: 'ä' }
    expect(await plainCodec.decode('meta', 'x', await plainCodec.encode('meta', 'x', v))).toEqual(v)
  })
  it('sealed codec round-trips and is not readable as plaintext', async () => {
    const handle = await importContentKey(generateDEK())
    const codec = sealedCodec(handle)
    const id = newChatId()
    const secret = { title: 'Gehaltsverhandlung mit Anna' }
    const bytes = await codec.encode('meta', id, secret)
    expect(utf8Decode(bytes)).not.toContain('Anna')
    expect(bytes[0]).toBe(1) // framed like every other sealed blob
    expect(bytes[1]).toBe(1)
    expect(await codec.decode('meta', id, bytes)).toEqual(secret)
  })
  it('binds a record to its chat id and its role', async () => {
    const handle = await importContentKey(generateDEK())
    const codec = sealedCodec(handle)
    const id = newChatId()
    const bytes = await codec.encode('meta', id, { t: 1 })
    await expect(codec.decode('body', id, bytes)).rejects.toThrow()
    await expect(codec.decode('meta', newChatId(), bytes)).rejects.toThrow()
  })
  it('a different key cannot open a chat', async () => {
    const a = sealedCodec(await importContentKey(generateDEK()))
    const b = sealedCodec(await importContentKey(generateDEK()))
    const id = newChatId()
    await expect(b.decode('meta', id, await a.encode('meta', id, { t: 1 }))).rejects.toThrow()
  })
  it('chat ids are 32 lowercase hex chars (what the server accepts)', () => {
    expect(newChatId()).toMatch(/^[a-f0-9]{32}$/)
  })
})

describe('tools', () => {
  it('read_file numbers lines and honours offset/limit', async () => {
    const space = new MemSpace({ 'a.md': 'one\ntwo\nthree\n' })
    const t = await prepareTool('read_file', { path: 'a.md', offset: 2, limit: 1 }, ctxFor(space))
    expect(t.mutating).toBe(false)
    expect(await t.run()).toBe('a.md (lines 2-2 of 3)\n2\ttwo')
  })

  it('edit_file insists on a unique match', async () => {
    const space = new MemSpace({ 'a.md': 'x\nx\n' })
    await expect(prepareTool('edit_file', { path: 'a.md', old_string: 'x', new_string: 'y' }, ctxFor(space))).rejects.toThrow(/2 times/)
    await expect(prepareTool('edit_file', { path: 'a.md', old_string: 'nope', new_string: 'y' }, ctxFor(space))).rejects.toThrow(ToolInputError)
  })

  it('edit_file shows the diff before running, applies, and undoes', async () => {
    const space = new MemSpace({ 'a.md': '# Title\n\nold text\n' })
    const changed: string[][] = []
    const t = await prepareTool('edit_file', { path: 'a.md', old_string: 'old text', new_string: 'new text' }, ctxFor(space, { onChange: (p: string[]) => changed.push(p) }))
    expect(t.mutating).toBe(true)
    expect(t.record.added).toBe(1)
    expect(t.record.removed).toBe(1)
    expect(space.text('a.md')).toContain('old text') // nothing happens before approval
    await t.run()
    expect(space.text('a.md')).toBe('# Title\n\nnew text\n')
    expect(changed).toEqual([['a.md']])
    await t.undo!()
    expect(space.text('a.md')).toBe('# Title\n\nold text\n')
  })

  it('edit_file applies against the page as it is when approved', async () => {
    const space = new MemSpace({ 'a.md': 'alpha\nbeta\n' })
    const t = await prepareTool('edit_file', { path: 'a.md', old_string: 'beta', new_string: 'BETA' }, ctxFor(space))
    space.files.set('a.md', utf8Encode('alpha (edited meanwhile)\nbeta\n'))
    await t.run()
    expect(space.text('a.md')).toBe('alpha (edited meanwhile)\nBETA\n')
  })

  it('write_file creates with a diff and undo deletes the new page', async () => {
    const space = new MemSpace({})
    const t = await prepareTool('write_file', { path: 'new/page.md', content: 'a\nb\n' }, ctxFor(space))
    expect(t.record.summary).toBe('Create new/page.md')
    expect(t.record.added).toBe(2)
    await t.run()
    expect(space.text('new/page.md')).toBe('a\nb\n')
    await t.undo!()
    expect(space.files.has('new/page.md')).toBe(false)
  })

  it('write_file refuses to overwrite a binary file', async () => {
    const space = new MemSpace({})
    space.files.set('pic.png', new Uint8Array([0x89, 0x50, 0, 0, 1, 2]))
    await expect(prepareTool('write_file', { path: 'pic.png', content: 'x' }, ctxFor(space))).rejects.toThrow(/refusing to overwrite/)
  })

  it('move_file keeps the file and undo moves it back', async () => {
    const space = new MemSpace({ 'a.md': 'x' })
    const moved: string[] = []
    const t = await prepareTool('move_file', { from: 'a.md', to: 'b/a.md' }, ctxFor(space, { onMoved: (f: string, to: string) => moved.push(`${f}>${to}`) }))
    await t.run()
    expect(space.files.has('b/a.md')).toBe(true)
    expect(moved).toEqual(['a.md>b/a.md'])
    await t.undo!()
    expect(space.files.has('a.md')).toBe(true)
  })

  it('delete_file can be undone for text pages', async () => {
    const space = new MemSpace({ 'a.md': 'keep me\n' })
    const t = await prepareTool('delete_file', { path: 'a.md' }, ctxFor(space))
    expect(t.record.removed).toBe(1)
    await t.run()
    expect(space.files.has('a.md')).toBe(false)
    await t.undo!()
    expect(space.text('a.md')).toBe('keep me\n')
  })

  it('never touches hidden server metadata', async () => {
    const space = new MemSpace({})
    await expect(prepareTool('write_file', { path: '.notation/ai.json', content: '{}' }, ctxFor(space))).rejects.toThrow(/hidden/)
    await expect(prepareTool('read_file', { path: '../etc/passwd' }, ctxFor(space))).rejects.toThrow()
  })

  it('the write guard blocks a page with unsaved edits', async () => {
    const space = new MemSpace({ 'a.md': 'x\n' })
    const t = await prepareTool('edit_file', { path: 'a.md', old_string: 'x', new_string: 'y' }, ctxFor(space, { writeGuard: (p: string) => (p === 'a.md' ? 'unsaved' : null) }))
    await expect(t.run()).rejects.toThrow('unsaved')
    expect(space.text('a.md')).toBe('x\n')
  })

  it('search finds lines and skips generated agent guides', async () => {
    const space = new MemSpace({
      'notes/a.md': 'first\nthe Budget line\n',
      'AGENTS.md': `${GUIDE_MARKER} -->\nBudget mention in a generated guide\n`,
    })
    const out = await (await prepareTool('search', { pattern: 'budget' }, ctxFor(space))).run()
    expect(out).toContain('notes/a.md')
    expect(out).toContain('the Budget line')
    expect(out).not.toContain('generated guide')
  })

  it('rejects unknown tools and non-object input', async () => {
    const space = new MemSpace({})
    await expect(prepareTool('rm_rf', {}, ctxFor(space))).rejects.toThrow()
    await expect(prepareTool('read_file', 'a.md', ctxFor(space))).rejects.toThrow(ToolInputError)
  })
})

describe('brief and system prompt', () => {
  it('picks up Space instructions and skills, not generated guides', async () => {
    const space = new MemSpace({
      'AGENTS.md': 'Always write in German.',
      'CLAUDE.md': `${GUIDE_MARKER} -->\ngenerated`,
      'skills/protokoll/SKILL.md': '---\nname: protokoll\ndescription: Meeting minutes\n---\nSteps…',
    })
    const brief = await collectBrief(new AgentFS(space), { currentSpace: 'spc' })
    expect(brief.instructions.map(i => i.path)).toEqual(['AGENTS.md'])
    expect(brief.skills).toEqual([{ name: 'protokoll', description: 'Meeting minutes', source: 'space', path: 'skills/protokoll/SKILL.md' }])

    const prompt = buildSystemPrompt({ spaceId: 'spc', spaceName: 'Team', encrypted: true, brief, globalInstructions: 'Be brief.' })
    expect(prompt).toContain('Always write in German.')
    expect(prompt).toContain('protokoll')
    expect(prompt).toContain('Be brief.')
    expect(prompt).toContain('end-to-end encrypted')
    expect(prompt).not.toContain('forms_guide') // forms are plaintext-only
    // Deterministic: the same inputs give byte-identical prompts (prompt cache,
    // preserved thinking) and nothing volatile like today's date is in it.
    expect(buildSystemPrompt({ spaceId: 'spc', spaceName: 'Team', encrypted: true, brief, globalInstructions: 'Be brief.' })).toBe(prompt)
    expect(prompt).not.toMatch(/20\d\d-\d\d-\d\d/)
  })
})

describe('request shape', () => {
  const chat = (): Chat => ({
    meta: { v: 1, id: newChatId(), title: '', createdAt: '', updatedAt: '', model: 'claude-opus-5-5', effort: 'high', usage: emptyUsage(), contextTokens: 0, messageCount: 0 },
    body: { v: 1, system: 'SYSTEM', messages: [{ role: 'user', content: 'hi' }], tools: {}, notices: [] },
  })

  it('caches the static prefix, streams tool input, and sets effort', () => {
    const p = buildParams(chat(), 'claude-opus-5-5', 'high')
    expect(p.system).toEqual([{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }])
    expect(p.cache_control).toEqual({ type: 'ephemeral' })
    expect(p.output_config).toEqual({ effort: 'high' })
    expect(p.thinking).toMatchObject({ type: 'adaptive' })
    expect(p.tools?.length).toBe(TOOLS.length)
    expect(p.tools?.every(t => (t as { eager_input_streaming?: boolean }).eager_input_streaming === true)).toBe(true)
    expect(p.fallbacks).toBe('default')
    expect(p.tool_choice).toBeUndefined() // forced tool_choice is a 400 on these models
  })

  it('does not ask for fallbacks on a model without them', () => {
    const p = buildParams(chat(), 'claude-haiku-5-5', 'low')
    expect(p.fallbacks).toBeUndefined()
  })

  it('tool definitions are stable between requests (prompt cache)', () => {
    expect(JSON.stringify(buildParams(chat(), 'claude-opus-5-5', 'high').tools)).toBe(JSON.stringify(buildParams(chat(), 'claude-opus-5-5', 'max').tools))
  })
})

describe('usage', () => {
  it('prices a request at its model rate', () => {
    const u = addUsage(emptyUsage(), { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'claude-opus-5-5')
    expect(u.cost).toBeCloseTo(4 + 2, 6)
    expect(u.input).toBe(1_000_000)
  })
})

describe('undo safety', () => {
  it('refuses to undo over edits made after the change', async () => {
    const space = new MemSpace({ 'a.md': 'one\n' })
    const t = await prepareTool('edit_file', { path: 'a.md', old_string: 'one', new_string: 'two' }, ctxFor(space))
    await t.run()
    space.files.set('a.md', utf8Encode('two\nuser added this\n'))
    await expect(t.undo!()).rejects.toThrow(/changed after/)
    expect(space.text('a.md')).toBe('two\nuser added this\n')
  })

  it('restores what was there when the change was applied, not when it was planned', async () => {
    const space = new MemSpace({ 'a.md': 'v1\n' })
    const t = await prepareTool('write_file', { path: 'a.md', content: 'claude\n' }, ctxFor(space))
    space.files.set('a.md', utf8Encode('v2 by user\n'))
    await t.run()
    await t.undo!()
    expect(space.text('a.md')).toBe('v2 by user\n')
  })

  it('does not resurrect a deleted page over a new one of the same name', async () => {
    const space = new MemSpace({ 'a.md': 'old\n' })
    const t = await prepareTool('delete_file', { path: 'a.md' }, ctxFor(space))
    await t.run()
    space.files.set('a.md', utf8Encode('new page\n'))
    await expect(t.undo!()).rejects.toThrow(/exists again/)
    expect(space.text('a.md')).toBe('new page\n')
  })
})
