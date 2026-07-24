import { describe, expect, it } from 'vitest'
import { tableToRows, toCSV } from './tableExport'

function makeTable(html: string): HTMLTableElement {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.querySelector('table')!
}

describe('tableToRows', () => {
  it('extracts header + body cells row-major, trimmed', () => {
    const t = makeTable(
      '<table><thead><tr><th> Name </th><th>Age</th></tr></thead>' +
        '<tbody><tr><td>Ada</td><td>36</td></tr><tr><td>Alan</td><td>41</td></tr></tbody></table>',
    )
    expect(tableToRows(t)).toEqual([['Name', 'Age'], ['Ada', '36'], ['Alan', '41']])
  })
})

describe('toCSV', () => {
  it('joins cells with commas and rows with CRLF', () => {
    expect(toCSV([['a', 'b'], ['1', '2']])).toBe('a,b\r\n1,2')
  })

  it('quotes fields containing a comma, quote, or newline (RFC-4180)', () => {
    expect(toCSV([['x,y', 'he said "hi"', 'line\nbreak']])).toBe('"x,y","he said ""hi""","line\nbreak"')
  })
})
