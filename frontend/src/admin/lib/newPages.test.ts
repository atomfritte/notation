import { describe, expect, it } from 'vitest'
import { diffNewPaths, registryMarkSeen } from './newPages'

// Signatures are opaque strings (mtime|size); tests use short stand-ins.
const snap = {
  files: { 'readme.md': 'm1', 'notes/a.md': 'm2', 'notes/b.md': 'm3' },
  forms: { survey: 3 },
}

describe('diffNewPaths — new pages', () => {
  it('flags files the registry does not know', () => {
    const reg = { files: { 'readme.md': 'm1', 'notes/a.md': 'm2' }, forms: { survey: 3 } }
    expect([...diffNewPaths(reg, snap)]).toEqual(['notes/b.md'])
  })

  it('flags nothing when everything is known and unchanged', () => {
    const reg = { files: { ...snap.files }, forms: { survey: 3 } }
    expect(diffNewPaths(reg, snap).size).toBe(0)
  })
})

describe('diffNewPaths — edited pages', () => {
  it('flags a file whose signature changed (an MCP/import edit)', () => {
    const reg = { files: { 'readme.md': 'm1', 'notes/a.md': 'OLD', 'notes/b.md': 'm3' }, forms: { survey: 3 } }
    expect([...diffNewPaths(reg, snap)]).toEqual(['notes/a.md'])
  })

  it('does not flag an edit when either signature is unknown (encrypted / legacy)', () => {
    // Registry has no signature yet (legacy '' entry): not an edit.
    const legacy = { files: { 'readme.md': '', 'notes/a.md': 'm2', 'notes/b.md': 'm3' }, forms: { survey: 3 } }
    expect(diffNewPaths(legacy, snap).has('readme.md')).toBe(false)
    // Snapshot has no signature (encrypted space): not an edit.
    const encSnap = { files: { 'readme.md': '', 'notes/a.md': '', 'notes/b.md': '' }, forms: {} }
    const encReg = { files: { 'readme.md': '', 'notes/a.md': '', 'notes/b.md': '' }, forms: {} }
    expect(diffNewPaths(encReg, encSnap).size).toBe(0)
  })
})

describe('diffNewPaths — form folders', () => {
  it('flags form folders whose entry count grew, but not shrank', () => {
    const grown = { files: { ...snap.files }, forms: { survey: 2 } }
    expect(diffNewPaths(grown, snap).has('survey')).toBe(true)
    const shrunk = { files: { ...snap.files }, forms: { survey: 5 } }
    expect(diffNewPaths(shrunk, snap).has('survey')).toBe(false)
  })

  it('flags a form folder the registry has never seen', () => {
    const reg = { files: { ...snap.files }, forms: {} }
    expect(diffNewPaths(reg, snap).has('survey')).toBe(true)
  })
})

describe('registryMarkSeen', () => {
  it('records the opened file at its current signature and keeps others badged', () => {
    const reg = { files: { 'readme.md': 'm1' }, forms: {} }
    const next = registryMarkSeen(reg, 'notes/a.md', snap)
    expect(next.files['notes/a.md']).toBe('m2')
    expect(diffNewPaths(next, snap).has('notes/b.md')).toBe(true)
  })

  it('clears an edited badge once the page is opened (adopts the new signature)', () => {
    const reg = { files: { 'readme.md': 'm1', 'notes/a.md': 'OLD', 'notes/b.md': 'm3' }, forms: { survey: 3 } }
    expect(diffNewPaths(reg, snap).has('notes/a.md')).toBe(true)
    const next = registryMarkSeen(reg, 'notes/a.md', snap)
    expect(diffNewPaths(next, snap).has('notes/a.md')).toBe(false)
  })

  it('records the current entry count when a form folder is opened', () => {
    const reg = { files: { ...snap.files }, forms: { survey: 1 } }
    const next = registryMarkSeen(reg, 'survey', snap)
    expect(next.forms.survey).toBe(3)
    expect(diffNewPaths(next, snap).size).toBe(0)
  })

  it('prunes paths that no longer exist in the tree', () => {
    const reg = { files: { 'gone.md': 'x', 'readme.md': 'm1' }, forms: { 'dead-form': 4 } }
    const next = registryMarkSeen(reg, 'readme.md', snap)
    expect('gone.md' in next.files).toBe(false)
    expect('dead-form' in next.forms).toBe(false)
  })

  it('does not add a path that is not part of the tree', () => {
    const reg = { files: {}, forms: {} }
    const next = registryMarkSeen(reg, 'phantom.md', snap)
    expect('phantom.md' in next.files).toBe(false)
  })
})
