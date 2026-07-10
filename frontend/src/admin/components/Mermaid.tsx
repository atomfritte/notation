import { useEffect, useRef, useState } from 'react'

type Props = { chart: string; theme: 'light' | 'dark' }

/**
 * Mermaid renders ```mermaid blocks as SVG. The library is loaded lazily so the
 * initial bundle stays slim — users who never view a Mermaid diagram never pay
 * the ~500KB cost. Each instance gets a unique id to allow multiple diagrams
 * per page; re-renders on chart or theme change.
 */
export function Mermaid({ chart, theme }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setErr(null)
    void import('mermaid').then(({ default: mermaid }) => {
      if (cancelled) return
      // Mermaid's colour parser can't read a raw `var(--x)` string — it throws
      // "Unsupported color format" and the whole diagram fails to render. So we
      // resolve the accent variable to its computed hex before handing it over.
      const accent =
        getComputedStyle(document.documentElement)
          .getPropertyValue('--notation-accent')
          .trim() || '#65A30D'
      mermaid.initialize({
        startOnLoad: false,
        theme: theme === 'dark' ? 'dark' : 'default',
        securityLevel: 'strict', // disallow click handlers in diagrams
        // Render labels as real SVG <text>, not HTML in <foreignObject>. Chrome
        // drops foreignObject content when printing to PDF, so html labels make
        // the whole diagram come out blank on paper; SVG text prints reliably.
        htmlLabels: false,
        flowchart: { htmlLabels: false, useMaxWidth: true },
        themeVariables:
          theme === 'dark'
            ? { primaryColor: accent, primaryTextColor: '#0a0a0a' }
            : { primaryColor: '#0a0a0a', primaryTextColor: '#ffffff' },
      })
      const id = 'mermaid-' + Math.random().toString(36).slice(2, 11)
      mermaid
        .render(id, chart)
        .then(({ svg }) => {
          if (cancelled || !ref.current) return
          ref.current.innerHTML = svg
          // Mermaid sizes the SVG with width="100%" + a max-width style. That
          // has no intrinsic pixel size, and Chrome fails to paint such an SVG
          // when printing to PDF (the diagram comes out blank). Give it explicit
          // width/height from the viewBox so it has real intrinsic dimensions,
          // then let inline max-width:100% + height:auto keep it responsive on
          // screen and scaled-to-fit on paper.
          const el = ref.current.querySelector('svg')
          const vb = el?.getAttribute('viewBox')?.split(/\s+/).map(Number)
          if (el && vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
            el.setAttribute('width', String(vb[2]))
            el.setAttribute('height', String(vb[3]))
            el.style.maxWidth = '100%'
            el.style.height = 'auto'
          }
        })
        .catch((e: unknown) => {
          if (cancelled) return
          setErr(String(e))
        })
    })
    return () => {
      cancelled = true
    }
  }, [chart, theme])

  if (err) {
    return (
      <pre className="text-xs text-[var(--notation-danger)] dark:text-[var(--notation-danger)] bg-[var(--notation-danger)]/10 dark:bg-[var(--notation-danger)]/30 border border-[var(--notation-danger)] dark:border-[var(--notation-danger)]/50 p-3 rounded-md overflow-auto">
        Mermaid error: {err}
        {'\n'}
        {chart}
      </pre>
    )
  }
  return <div ref={ref} className="mermaid-container my-4 flex justify-center not-prose" />
}
