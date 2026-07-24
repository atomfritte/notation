/**
 * Extract a rendered markdown <table> to a row-major string matrix, and format
 * it as CSV — used by the per-table copy/download tools in MarkdownView.
 */

/** Cells of a table as `rows[r][c]`, header row(s) included, whitespace-trimmed. */
export function tableToRows(table: HTMLTableElement): string[][] {
  const rows: string[][] = []
  table.querySelectorAll('tr').forEach((tr) => {
    const cells: string[] = []
    tr.querySelectorAll('th,td').forEach((c) => cells.push((c.textContent ?? '').trim()))
    if (cells.length) rows.push(cells)
  })
  return rows
}

/** RFC-4180-ish CSV: quote a field that contains a comma, quote or newline. */
export function toCSV(rows: string[][]): string {
  const field = (s: string) => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s)
  return rows.map((r) => r.map(field).join(',')).join('\r\n')
}
