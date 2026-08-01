import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { SearchPanel, matchTitles, type SearchPanelMatch } from './SearchPanel'

const FILES = [
  'Finanzen/Rechnungen 2026.md',
  'Finanzen/Steuer.md',
  'Notizen/rechnung entwurf.md',
  'Projekte/Umbau.md',
  'assets/logo.png',
]

describe('matchTitles', () => {
  it('finds a page whose title contains the query, regardless of case', () => {
    // Both titles start with the word, so the tie falls back to menu order.
    expect(matchTitles(FILES, 'rechnung').map(h => h.path)).toEqual([
      'Finanzen/Rechnungen 2026.md',
      'Notizen/rechnung entwurf.md',
    ])
  })

  it('ranks a whole-title match above a prefix above a mere substring', () => {
    const files = ['a/Steuer beiseite.md', 'b/Vorsteuer.md', 'c/Steuer.md']
    expect(matchTitles(files, 'steuer').map(h => h.path)).toEqual([
      'c/Steuer.md',
      'a/Steuer beiseite.md',
      'b/Vorsteuer.md',
    ])
  })

  it('matches the title only — not the folder it sits in', () => {
    expect(matchTitles(FILES, 'finanzen')).toEqual([])
  })

  it('keeps the extension of a non-markdown file in its title', () => {
    expect(matchTitles(FILES, 'logo')).toEqual([{ path: 'assets/logo.png', title: 'logo.png' }])
  })

  it('caps the result list', () => {
    const many = Array.from({ length: 40 }, (_, i) => `note ${i}.md`)
    expect(matchTitles(many, 'note', 5)).toHaveLength(5)
  })

  it('ignores an empty query', () => {
    expect(matchTitles(FILES, '  ')).toEqual([])
  })
})

const render = (props: Partial<Parameters<typeof SearchPanel>[0]> = {}): string =>
  renderToStaticMarkup(
    <SearchPanel
      open
      onClose={() => {}}
      onSelect={() => {}}
      onSearch={async () => []}
      {...props}
    />,
  )

describe('SearchPanel', () => {
  it('says how to search once a file list is wired in', () => {
    expect(render({ files: FILES })).toContain('Search page titles and content…')
  })

  it('still renders content-only when no file list is passed', () => {
    const html = render()
    expect(html).toContain('Search across all pages…')
    expect(html).not.toContain('>title<')
  })

  it('renders nothing but the hint before two characters are typed', () => {
    const hits: SearchPanelMatch[] = [{ path: 'Finanzen/Steuer.md', line: 3, content: 'a line' }]
    const html = render({ files: FILES, onSearch: async () => hits })
    expect(html).toContain('Type at least 2 characters')
    expect(html).not.toContain('No matches')
  })
})

/** Mount the panel, type `query`, return the resulting DOM. */
async function typeInto(query: string, props: Partial<Parameters<typeof SearchPanel>[0]> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <SearchPanel open onClose={() => {}} onSelect={() => {}} onSearch={async () => []} {...props} />,
    )
  })
  const input = host.querySelector('input')!
  await act(async () => {
    // React tracks the last value it wrote, so poke the native setter to make
    // the change event look like real typing.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return { host, cleanup: () => act(() => root.unmount()) }
}

describe('SearchPanel with a query typed in', () => {
  it('lists a page whose title matches even when nothing in it does', async () => {
    const { host, cleanup } = await typeInto('rechnung', { files: FILES })
    const text = host.textContent ?? ''
    expect(text).toContain('Finanzen/Rechnungen 2026')
    expect(text).toContain('title') // the badge explaining a line-less hit
    expect(text).not.toContain('No matches')
    cleanup()
  })

  it('puts the title hit above a file that only matched on content', async () => {
    const hits: SearchPanelMatch[] = [{ path: 'Projekte/Umbau.md', line: 7, content: 'die Steuer' }]
    const { host, cleanup } = await typeInto('steuer', { files: FILES, onSearch: async () => hits })
    // Let the 200ms content debounce fire and its promise settle.
    await act(async () => {
      await new Promise(r => setTimeout(r, 250))
    })
    const headers = [...host.querySelectorAll('button')].map(b => b.textContent ?? '')
    expect(headers.some(h => h.includes('Finanzen/Steuer'))).toBe(true)
    const titleAt = headers.findIndex(h => h.includes('Finanzen/Steuer'))
    const contentAt = headers.findIndex(h => h.includes('Projekte/Umbau'))
    expect(contentAt).toBeGreaterThan(titleAt)
    expect(host.textContent).toContain('die Steuer')
    cleanup()
  })
})
