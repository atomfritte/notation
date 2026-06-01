import { describe, expect, it } from 'vitest'
import {
  findDefaultFile,
  highlightLang,
  isCodeFile,
  isImageFile,
  isMarkdownFile,
  isSpreadsheetFile,
  isTextFile,
  monacoLang,
} from './fileTypes'

describe('file-extension classifiers', () => {
  it('detects markdown variants', () => {
    expect(isMarkdownFile('a.md')).toBe(true)
    expect(isMarkdownFile('NESTED/FOLDER/notes.MARKDOWN')).toBe(true)
    expect(isMarkdownFile('readme.mdx')).toBe(true)
    expect(isMarkdownFile('image.png')).toBe(false)
    expect(isMarkdownFile('no-extension')).toBe(false)
  })

  it('treats extension-less files as text but not code', () => {
    expect(isTextFile('LICENSE')).toBe(true)
    expect(isCodeFile('LICENSE')).toBe(false)
  })

  it('keeps markdown out of the code bucket', () => {
    expect(isCodeFile('readme.md')).toBe(false)
    expect(isCodeFile('main.ts')).toBe(true)
  })

  it('routes spreadsheet formats correctly', () => {
    expect(isSpreadsheetFile('data.xlsx')).toBe(true)
    expect(isSpreadsheetFile('data.csv')).toBe(true)
    expect(isImageFile('chart.csv')).toBe(false)
  })
})

describe('language id maps', () => {
  it('maps common extensions to monaco language ids', () => {
    expect(monacoLang('foo.ts')).toBe('typescript')
    expect(monacoLang('foo.tsx')).toBe('typescript')
    expect(monacoLang('foo.go')).toBe('go')
    expect(monacoLang('foo.unknown')).toBe('plaintext')
  })

  it('falls through to extension as hljs language when unmapped', () => {
    expect(highlightLang('foo.ts')).toBe('typescript')
    expect(highlightLang('foo.kotlin')).toBe('kotlin')
  })
})

describe('findDefaultFile', () => {
  const f = (name: string, path = name) => ({ name, path, is_dir: false })
  const d = (name: string, children: ReturnType<typeof f>[], path = name) => ({
    name,
    path,
    is_dir: true,
    children,
  })

  it('prefers README at root over deeper files', () => {
    const tree = [
      f('other.md'),
      f('README.md'),
      d('sub', [f('index.md', 'sub/index.md')]),
    ]
    expect(findDefaultFile(tree)?.name).toBe('README.md')
  })

  it('descends to find readme-pattern names when root has none', () => {
    const tree = [d('docs', [f('home.md', 'docs/home.md')])]
    expect(findDefaultFile(tree)?.path).toBe('docs/home.md')
  })

  it('falls back to first markdown file when no readme-like name exists', () => {
    const tree = [f('notes.md'), f('image.png')]
    expect(findDefaultFile(tree)?.name).toBe('notes.md')
  })

  it('falls back to the first file of any type when the tree has no markdown', () => {
    // A purely-binary Space (e.g. a PDF/image share) should still land the
    // visitor on content rather than an empty "select a file" screen.
    expect(findDefaultFile([f('image.png'), f('data.csv')])?.name).toBe('image.png')
  })

  it('returns null only when the tree is completely empty', () => {
    expect(findDefaultFile([])).toBeNull()
  })
})
