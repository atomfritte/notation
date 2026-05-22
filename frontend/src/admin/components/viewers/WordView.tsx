import { useEffect, useState } from 'react'
import { FileText, AlertTriangle } from 'lucide-react'

type Props = { url: string; path: string }

/**
 * WordView renders .docx files via mammoth.js + DOMPurify.
 *
 * Security model: same pattern as SpreadsheetView. Mammoth runs entirely in
 * the browser and produces semantic HTML (paragraphs, lists, tables, images
 * inlined as data URLs). The output is run through DOMPurify with a generous
 * but explicit allowlist before injection. Even if a hostile DOCX coerces
 * mammoth into emitting tags we don't expect, DOMPurify drops everything
 * outside the list, plus all script-bearing attributes by default.
 *
 * Lazy-imported so the ~1MB mammoth bundle only loads on first DOCX open.
 */
export default function WordView({ url, path }: Props) {
  const [html, setHtml] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    ;(async () => {
      try {
        const [mammothMod, purifyMod, res] = await Promise.all([
          import('mammoth'),
          import('dompurify'),
          fetch(url),
        ])
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        const mammoth: any = (mammothMod as any).default ?? mammothMod
        const DOMPurify: any = (purifyMod as any).default ?? purifyMod
        const result = await mammoth.convertToHtml({ arrayBuffer: buf })
        if (cancelled) return
        const clean = DOMPurify.sanitize(result.value, {
          ALLOWED_TAGS: [
            'p', 'br', 'span', 'div', 'em', 'strong', 'i', 'b', 'u', 's',
            'sub', 'sup', 'mark', 'small',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'ul', 'ol', 'li', 'dl', 'dt', 'dd',
            'blockquote', 'pre', 'code',
            'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup',
            'hr',
            'a', 'img',
          ],
          ALLOWED_ATTR: [
            'colspan', 'rowspan', 'align', 'valign',
            'href', 'rel', 'target',
            // data: URIs only — see ALLOWED_URI_REGEXP below.
            'src', 'alt', 'title',
            'id',
          ],
          FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base', 'form', 'input'],
          FORBID_ATTR: ['style', 'onclick', 'onerror', 'onload', 'onmouseover'],
          // Images mammoth emits are base64-encoded data: URIs; external
          // hrefs are allowed but only http(s) / mailto.
          ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
        })
        // Force external anchors to open safely.
        const final = clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ')
        setHtml(final)
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
      <div className="flex-1 flex items-center justify-center text-[var(--notation-fg-muted)] text-sm gap-2">
        <FileText size={16} /> Converting document…
      </div>
    )
  }
  if (err) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-[var(--notation-fg)] p-8 gap-3">
        <AlertTriangle size={32} className="text-[var(--notation-danger)]" />
        <div className="text-sm">Could not open document</div>
        <div className="text-xs text-[var(--notation-fg-muted)] font-mono">{err}</div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <article
        className="prose prose-zinc dark:prose-invert max-w-3xl mx-auto p-8"
        aria-label={path}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
