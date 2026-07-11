import { describe, expect, it } from 'vitest'
import type { Entry } from './api'
import { collectPages } from './pageOrder'

const file = (path: string): Entry => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { name, path, is_dir: false, size: 0, modified: '' }
}
const dir = (path: string, children: Entry[]): Entry => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { name, path, is_dir: true, size: 0, modified: '', children }
}

describe('collectPages', () => {
  // Mirrors the FileTree order the tree is already sorted into (files before
  // subfolders). collectPages must preserve that depth-first menu order.
  const tree: Entry[] = [
    file('readme.md'),
    file('logo.png'),           // binary — never a page
    file('notes.txt'),          // non-markdown text
    dir('docs', [
      file('docs/intro.md'),
      file('docs/data.csv'),    // non-markdown
      dir('docs/guides', [
        file('docs/guides/setup.md'),
        file('docs/guides/diagram.svg'),
      ]),
    ]),
    file('zeta.mdx'),           // .mdx counts as a page
  ]

  it('markdownOnly=true returns markdown pages in depth-first menu order, skipping non-markdown', () => {
    expect(collectPages(tree, true)).toEqual([
      'readme.md',
      'docs/intro.md',
      'docs/guides/setup.md',
      'zeta.mdx',
    ])
  })

  it('markdownOnly=false returns every file of any type, nested included', () => {
    expect(collectPages(tree, false)).toEqual([
      'readme.md',
      'logo.png',
      'notes.txt',
      'docs/intro.md',
      'docs/data.csv',
      'docs/guides/setup.md',
      'docs/guides/diagram.svg',
      'zeta.mdx',
    ])
  })

  it('returns an empty list for an empty tree', () => {
    expect(collectPages([], true)).toEqual([])
  })
})
