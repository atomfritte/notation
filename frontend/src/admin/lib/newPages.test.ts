import { describe, expect, it } from 'vitest'
import { diffNewPaths, registryMarkSeen } from './newPages'

const snap = {
  files: ['readme.md', 'notes/a.md', 'notes/b.md'],
  forms: { survey: 3 },
}

describe('diffNewPaths', () => {
  it('flags files the registry does not know', () => {
    const reg = { files: ['readme.md', 'notes/a.md'], forms: { survey: 3 } }
    expect([...diffNewPaths(reg, snap)]).toEqual(['notes/b.md'])
  })

  it('flags nothing when everything is known', () => {
    const reg = { files: snap.files, forms: { survey: 3 } }
    expect(diffNewPaths(reg, snap).size).toBe(0)
  })

  it('flags form folders whose entry count grew, but not shrank', () => {
    const grown = { files: snap.files, forms: { survey: 2 } }
    expect(diffNewPaths(grown, snap).has('survey')).toBe(true)
    const shrunk = { files: snap.files, forms: { survey: 5 } }
    expect(diffNewPaths(shrunk, snap).has('survey')).toBe(false)
  })

  it('flags a form folder the registry has never seen', () => {
    const reg = { files: snap.files, forms: {} }
    expect(diffNewPaths(reg, snap).has('survey')).toBe(true)
  })
})

describe('registryMarkSeen', () => {
  it('adds the opened file and keeps others unseen', () => {
    const reg = { files: ['readme.md'], forms: {} }
    const next = registryMarkSeen(reg, 'notes/a.md', snap)
    expect(next.files).toContain('notes/a.md')
    expect(diffNewPaths(next, snap).has('notes/b.md')).toBe(true)
  })

  it('records the current entry count when a form folder is opened', () => {
    const reg = { files: snap.files, forms: { survey: 1 } }
    const next = registryMarkSeen(reg, 'survey', snap)
    expect(next.forms.survey).toBe(3)
    expect(diffNewPaths(next, snap).size).toBe(0)
  })

  it('prunes paths that no longer exist in the tree', () => {
    const reg = { files: ['gone.md', 'readme.md'], forms: { 'dead-form': 4 } }
    const next = registryMarkSeen(reg, 'readme.md', snap)
    expect(next.files).not.toContain('gone.md')
    expect('dead-form' in next.forms).toBe(false)
  })

  it('does not add a path that is not part of the tree', () => {
    const reg = { files: [], forms: {} }
    const next = registryMarkSeen(reg, 'phantom.md', snap)
    expect(next.files).not.toContain('phantom.md')
  })
})
