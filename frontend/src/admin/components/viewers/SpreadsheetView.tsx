import { useEffect, useState } from 'react'
import { Sheet, AlertTriangle } from 'lucide-react'

type Props = { url: string; path: string }

/**
 * SpreadsheetView renders .xlsx / .xls / .ods / .csv / .tsv files.
 *
 * Security model: the file is fetched as an ArrayBuffer and parsed
 * entirely on the client (SheetJS is a pure-JS parser). The HTML SheetJS
 * emits via `sheet_to_html` is then run through DOMPurify with a tight
 * allowlist before we drop it into the DOM via dangerouslySetInnerHTML ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
 * so even if a hostile workbook smuggles markup through the parser, it
 * can't execute scripts, load remote resources, or set on* handlers.
 *
 * Both SheetJS and DOMPurify are lazy-imported via this default-export
 * module so the (~700KB combined) bundle only loads when a user opens a
 * spreadsheet.
 */
export default function SpreadsheetView({ url }: Props) {
  const [workbook, setWorkbook] = useState<any | null>(null)
  const [activeSheet, setActiveSheet] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    setWorkbook(null)
    ;(async () => {
      try {
        const [{ default: XLSX }, res] = await Promise.all([
          import('xlsx'),
          fetch(url),
        ])
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        const wb = (XLSX as any).read(buf, { type: 'array' })
        if (cancelled) return
        setWorkbook(wb)
        setActiveSheet(wb.SheetNames[0] ?? '')
      } catch (e) {
        if (!cancelled) setErr(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm gap-2">
        <Sheet size={16} /> Parsing spreadsheetÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦
      </div>
    )
  }
  if (err) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-zinc-700 dark:text-zinc-300 p-8 gap-3">
        <AlertTriangle size={32} className="text-red-500" />
        <div className="text-sm">Could not open spreadsheet</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{err}</div>
      </div>
    )
  }
  if (!workbook) return null

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {workbook.SheetNames.length > 1 && (
        <div className="flex gap-1 px-2 py-1 border-b border-zinc-200 dark:border-zinc-800 overflow-x-auto bg-zinc-50 dark:bg-zinc-950/30 flex-shrink-0">
          {workbook.SheetNames.map((name: string) => (
            <button
              key={name}
              onClick={() => setActiveSheet(name)}
              className={
                'px-3 py-1 text-xs rounded transition-colors whitespace-nowrap ' +
                (name === activeSheet
                  ? 'bg-zinc-900 text-white dark:bg-[color:var(--notation-accent)] dark:text-zinc-950 font-medium'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800')
              }
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <SheetTable workbook={workbook} sheetName={activeSheet} />
    </div>
  )
}

function SheetTable({ workbook, sheetName }: { workbook: any; sheetName: string }) {
  const [html, setHtml] = useState<string>('')
  const [purifyReady, setPurifyReady] = useState(false)

  // Lazy-load DOMPurify with the parsed sheet. Could be hoisted into the
  // outer effect, but kept here so a sheet switch never has to re-fetch.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [{ default: XLSX }, { default: DOMPurify }] = await Promise.all([
        import('xlsx'),
        import('dompurify'),
      ])
      if (cancelled) return
      const ws = workbook.Sheets[sheetName]
      if (!ws) {
        setHtml('')
        return
      }
      const raw = (XLSX as any).utils.sheet_to_html(ws)
      // Tight allowlist: only table-structure tags + the cell-content tags
      // SheetJS emits. No href, no src, no style ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the inline styles SheetJS
      // adds for borders are nice-to-have, not security-relevant.
      const clean = DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: [
          'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
          'col', 'colgroup', 'caption', 'br', 'span', 'b', 'i', 'u', 'sub', 'sup',
        ],
        ALLOWED_ATTR: ['colspan', 'rowspan', 'align', 'valign'],
        FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'a', 'img', 'form', 'input'],
        FORBID_ATTR: ['style', 'href', 'src', 'onclick', 'onerror', 'onload'],
      })
      setHtml(clean)
      setPurifyReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [workbook, sheetName])

  if (!purifyReady) {
    return <div className="flex-1 flex items-center justify-center text-zinc-500 text-xs">RenderingÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦</div>
  }
  return (
    <div className="flex-1 overflow-auto p-4 bg-[var(--notation-bg)]">
      <div className="sheetjs-table" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

