import { describe, expect, it } from 'vitest'
import { fileParams, fileSearchString, resolveFileParam } from './fileParam'

// A tiny bidirectional path<->nodeId map standing in for an EncryptedFS.
const tree: Record<string, string> = { 'notes/secret.md': 'a1b2c3', 'readme.md': 'deadbeef' }
const idAt = (p: string) => tree[p]
const pathOf = (n: string) => Object.keys(tree).find((p) => tree[p] === n)

describe('fileParam — plaintext spaces', () => {
  it('carries the path in ?file=', () => {
    expect(fileParams(false, 'notes/secret.md', idAt)).toEqual({ file: 'notes/secret.md' })
    expect(fileSearchString(false, 'notes/secret.md', idAt)).toBe('?file=notes%2Fsecret.md')
  })
  it('reads the path back from ?file=', () => {
    const params = new URLSearchParams('file=notes/secret.md')
    expect(resolveFileParam(false, params, pathOf)).toBe('notes/secret.md')
  })
})

describe('fileParam — encrypted spaces', () => {
  it('addresses by opaque nodeId, never a cleartext path', () => {
    const params = fileParams(true, 'notes/secret.md', idAt)
    expect(params).toEqual({ n: 'a1b2c3' })
    const search = fileSearchString(true, 'notes/secret.md', idAt)
    expect(search).toBe('?n=a1b2c3')
    // The secret path must not appear anywhere in the URL the server sees.
    expect(search).not.toContain('secret')
    expect(search).not.toContain('notes')
  })
  it('resolves ?n= back to the path via the FS', () => {
    const params = new URLSearchParams('n=a1b2c3')
    expect(resolveFileParam(true, params, pathOf)).toBe('notes/secret.md')
  })
  it('round-trips path -> ?n= -> path', () => {
    const search = fileSearchString(true, 'readme.md', idAt)
    const params = new URLSearchParams(search.slice(1))
    expect(resolveFileParam(true, params, pathOf)).toBe('readme.md')
  })
  it('emits nothing when the path has no node yet (unresolved)', () => {
    expect(fileParams(true, 'ghost.md', idAt)).toEqual({})
    expect(fileSearchString(true, 'ghost.md', idAt)).toBe('')
  })
  it('resolves to empty when the nodeId is gone (deleted file)', () => {
    const params = new URLSearchParams('n=00000000')
    expect(resolveFileParam(true, params, pathOf)).toBe('')
  })
  it('empty path yields no params', () => {
    expect(fileParams(true, '', idAt)).toEqual({})
    expect(fileParams(false, '', idAt)).toEqual({})
  })
})
