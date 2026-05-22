import { useEffect, useRef, useState } from 'react'

type Props = { chart: string; theme: 'light' | 'dark' }

/**
 * Mermaid renders ```mermaid blocks as SVG. The library is loaded lazily so the
 * initial bundle stays slim â€” users who never view a Mermaid diagram never pay
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
      mermaid.initialize({
        startOnLoad: false,
        theme: theme === 'dark' ? 'dark' : 'default',
        securityLevel: 'strict', // disallow click handlers in diagrams
        themeVariables:
          theme === 'dark'
            ? { primaryColor: 'var(--notation-accent)', primaryTextColor: '#0a0a0a' }
            : { primaryColor: '#0a0a0a', primaryTextColor: '#ffffff' },
      })
      const id = 'mermaid-' + Math.random().toString(36).slice(2, 11)
      mermaid
        .render(id, chart)
        .then(({ svg }) => {
          if (cancelled || !ref.current) return
          ref.current.innerHTML = svg
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
      <pre className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 p-3 rounded-md overflow-auto">
        Mermaid error: {err}
        {'\n'}
        {chart}
      </pre>
    )
  }
  return <div ref={ref} className="mermaid-container my-4 flex justify-center not-prose" />
}
