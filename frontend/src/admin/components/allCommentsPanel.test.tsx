import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AllCommentsPanel } from './AllCommentsPanel'
import type { AllCommentItem } from '../lib/api'

const item = (over: Partial<AllCommentItem> = {}): AllCommentItem => ({
  id: 'c_1',
  path: 'notes/page.md',
  created_at: '2026-07-20T10:00:00Z',
  author: 'ada',
  text: 'a note',
  ...over,
})

const render = (props: Partial<Parameters<typeof AllCommentsPanel>[0]> = {}): string =>
  renderToStaticMarkup(
    <AllCommentsPanel
      spaceID="alpha"
      currentFile=""
      onSelectFile={() => {}}
      items={[item()]}
      {...props}
    />,
  )

describe('AllCommentsPanel and a vanished page', () => {
  it('links normally while the file is still there', () => {
    const html = render({ existingPaths: new Set(['notes/page.md']) })
    expect(html).toContain('notes/page')
    expect(html).not.toContain('moved or deleted')
  })

  it('says the page is gone instead of offering a dead link', () => {
    const html = render({ existingPaths: new Set(['notes/other.md']) })
    expect(html).toContain('moved or deleted')
    // The thread itself is still listed — the comments are not lost.
    expect(html).toContain('a note')
  })

  it('raises no alarm before the file set is known', () => {
    // The tree loads after the comments; an empty set must not paint every
    // group as broken for a frame.
    expect(render({ existingPaths: new Set() })).not.toContain('moved or deleted')
    expect(render()).not.toContain('moved or deleted')
  })

  it('trusts an encrypted space’s own orphan flag', () => {
    const html = render({
      items: [item({ path: 'page.md', orphan: true, node_id: 'n1' })],
      existingPaths: new Set(['page.md']),
    })
    expect(html).toContain('moved or deleted')
  })
})

describe('AllCommentsPanel and folders the tree cannot see into', () => {
  it('does not call a comment inside a Form folder stranded', () => {
    // The tree sends a submission count instead of a Form folder's files, so
    // those paths are absent from the file set while very much existing.
    const html = renderToStaticMarkup(
      <AllCommentsPanel
        spaceID="alpha"
        currentFile=""
        onSelectFile={() => {}}
        items={[item({ path: 'survey/entry-7.md' })]}
        existingPaths={new Set(['index.md'])}
        opaqueDirs={['survey']}
      />,
    )
    expect(html).not.toContain('moved or deleted')
  })
})
