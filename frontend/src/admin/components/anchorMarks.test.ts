import { describe, expect, it } from 'vitest'
import { applyAnchorMarks, badgeFor, groupByAnchor } from './MarkdownView'

// The anchoring layer wraps rendered prose in <mark> elements imperatively.
// These tests drive it against a plain jsdom article — no React, no markdown
// parse — so the grouping / badge / id bookkeeping is verified directly.

const article = (html: string): HTMLElement => {
  const el = document.createElement('article')
  el.innerHTML = html
  return el
}

const anchor = (quote: string, prefix = '', suffix = '') => ({ quote, prefix, suffix })

describe('groupByAnchor', () => {
  it('collapses several annotations on the same passage into one group', () => {
    const groups = groupByAnchor([
      { id: 'a', anchor: anchor('the quote') },
      { id: 'b', anchor: anchor('the quote'), emoji: '❤️' },
      { id: 'c', anchor: anchor('another') },
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].items.map(i => i.id)).toEqual(['a', 'b'])
    expect(groups[1].items.map(i => i.id)).toEqual(['c'])
  })

  it('ignores replies (they inherit the parent anchor) and unanchored comments', () => {
    const groups = groupByAnchor([
      { id: 'a', anchor: anchor('quote') },
      { id: 'r', anchor: anchor('quote'), parent_id: 'a' },
      { id: 'plain' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].items.map(i => i.id)).toEqual(['a'])
  })

  it('treats identical quotes in different contexts as different passages', () => {
    const groups = groupByAnchor([
      { id: 'a', anchor: anchor('run', 'first ', ' here') },
      { id: 'b', anchor: anchor('run', 'second ', ' there') },
    ])
    expect(groups).toHaveLength(2)
  })
})

describe('badgeFor', () => {
  it('shows a speech bubble for comments and counts repeats', () => {
    expect(badgeFor([{ id: '1' }])).toBe('💬')
    expect(badgeFor([{ id: '1' }, { id: '2' }])).toBe('💬2')
  })

  it('lists each distinct emoji, with a count when repeated', () => {
    expect(badgeFor([
      { id: '1', emoji: '❤️' },
      { id: '2', emoji: '❤️' },
      { id: '3', emoji: '👍' },
    ])).toBe('❤️2👍')
  })

  it('combines reactions and comments on the same passage', () => {
    expect(badgeFor([{ id: '1', emoji: '🔥' }, { id: '2' }])).toBe('🔥💬')
  })
})

describe('applyAnchorMarks', () => {
  it('wraps the quoted passage once and records every comment id', () => {
    const el = article('<p>alpha beta gamma</p>')
    applyAnchorMarks(el, [
      { id: 'c1', anchor: anchor('beta', 'alpha ', ' gamma'), text: 'hi' },
      { id: 'c2', anchor: anchor('beta', 'alpha ', ' gamma'), emoji: '👍' },
    ])

    const marks = el.querySelectorAll('mark.comment-anchor')
    // One mark — NOT one per comment. Wrapping the same range twice would nest
    // the second mark inside the first and mis-attribute the text.
    expect(marks).toHaveLength(1)
    const m = marks[0] as HTMLElement
    expect(m.textContent).toBe('beta')
    expect(m.dataset.commentId).toBe('c1')
    expect(m.dataset.commentIds).toBe('c1,c2')
    expect(m.dataset.badge).toBe('👍💬')
    // A passage carrying a real comment keeps the comment (amber) styling.
    expect(m.classList.contains('comment-reaction')).toBe(false)
    // The prose itself is untouched apart from the wrapper.
    expect(el.textContent).toBe('alpha beta gamma')
  })

  it('marks a reaction-only passage as a reaction', () => {
    const el = article('<p>alpha beta gamma</p>')
    applyAnchorMarks(el, [{ id: 'r1', anchor: anchor('gamma'), emoji: '🎉' }])
    const m = el.querySelector('mark.comment-anchor') as HTMLElement
    expect(m.classList.contains('comment-reaction')).toBe(true)
    expect(m.dataset.badge).toBe('🎉')
  })

  it('spans inline elements, badging only the final slice', () => {
    const el = article('<p>see <em>the</em> whole thing</p>')
    applyAnchorMarks(el, [{ id: 'c1', anchor: anchor('the whole') }])
    const marks = [...el.querySelectorAll('mark.comment-anchor')] as HTMLElement[]
    expect(marks.length).toBeGreaterThan(1)
    expect(marks.map(m => m.textContent).join('')).toBe('the whole')
    // Exactly one badge for the passage, on the last slice.
    expect(marks.filter(m => m.dataset.badge).length).toBe(1)
    expect(marks[marks.length - 1].dataset.badge).toBe('💬')
    // Every slice answers for the same comment, so hover/click work anywhere.
    expect(marks.every(m => m.dataset.commentIds === 'c1')).toBe(true)
  })

  it('skips an anchor whose text no longer exists (edited page)', () => {
    const el = article('<p>alpha beta gamma</p>')
    applyAnchorMarks(el, [{ id: 'gone', anchor: anchor('deleted sentence') }])
    expect(el.querySelectorAll('mark.comment-anchor')).toHaveLength(0)
    expect(el.textContent).toBe('alpha beta gamma')
  })

  it('disambiguates a repeated quote using its surrounding context', () => {
    const el = article('<p>run here and run there</p>')
    applyAnchorMarks(el, [{ id: 'c1', anchor: anchor('run', 'and ', ' there') }])
    const m = el.querySelector('mark.comment-anchor') as HTMLElement
    expect(m.textContent).toBe('run')
    // The SECOND "run" is the one that got marked.
    expect(el.innerHTML.indexOf('<mark')).toBeGreaterThan('<p>run here and '.length - 1)
  })
})
