import { describe, expect, it } from 'vitest'
import {
  findDefaultFile,
  highlightLang,
  isCodeFile,
  isImageFile,
  isMarkdownFile,
  isSpreadsheetFile,
  isTextFile,
  mimeForPath,
  monacoLang,
  rendersFromBytes,
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

describe('mimeForPath', () => {
  it('maps the common preview extensions to their MIME type', () => {
    expect(mimeForPath('a/b/pic.png')).toBe('image/png')
    expect(mimeForPath('PHOTO.JPG')).toBe('image/jpeg')
    expect(mimeForPath('x.jpeg')).toBe('image/jpeg')
    expect(mimeForPath('anim.gif')).toBe('image/gif')
    expect(mimeForPath('m.webp')).toBe('image/webp')
    expect(mimeForPath('m.avif')).toBe('image/avif')
    expect(mimeForPath('logo.svg')).toBe('image/svg+xml')
    expect(mimeForPath('doc.pdf')).toBe('application/pdf')
    expect(mimeForPath('clip.mp4')).toBe('video/mp4')
    expect(mimeForPath('clip.webm')).toBe('video/webm')
    expect(mimeForPath('clip.mov')).toBe('video/quicktime')
    expect(mimeForPath('song.mp3')).toBe('audio/mpeg')
    expect(mimeForPath('song.ogg')).toBe('audio/ogg')
    expect(mimeForPath('song.wav')).toBe('audio/wav')
    expect(mimeForPath('song.m4a')).toBe('audio/mp4')
    expect(mimeForPath('sheet.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(mimeForPath('letter.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
  })

  it('defaults unknown / extension-less files to a generic binary stream', () => {
    expect(mimeForPath('mystery.bin')).toBe('application/octet-stream')
    expect(mimeForPath('LICENSE')).toBe('application/octet-stream')
  })
})

describe('rendersFromBytes (encrypted-preview branch selection)', () => {
  it('is true for URL/byte viewers', () => {
    for (const p of ['pic.png', 'logo.svg', 'doc.pdf', 'clip.mp4', 'song.mp3', 'a.docx', 'a.xlsx', 'data.csv']) {
      expect(rendersFromBytes(p)).toBe(true)
    }
  })

  it('is true for unknown / extension-less types (they fall through to the download view)', () => {
    expect(rendersFromBytes('archive.zip')).toBe(true)
    expect(rendersFromBytes('mystery.bin')).toBe(true)
    // Mirrors FileViewer: an extension-less file is NOT code, so it downloads.
    expect(rendersFromBytes('LICENSE')).toBe(true)
  })

  it('is false for text rendered from a decoded string (markdown / code)', () => {
    for (const p of ['readme.md', 'notes.markdown', 'main.ts', 'app.py', 'config.yml']) {
      expect(rendersFromBytes(p)).toBe(false)
    }
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
