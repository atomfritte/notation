/**
 * PrintSpaceView — renders EVERY markdown page of a Space, stacked in menu
 * order, into one printable document so the user can save the whole Space as a
 * single continuous PDF (File ▸ Print ▸ Save as PDF).
 *
 * It is a dedicated route (`/admin/spaces/:spaceID/print`) rather than a hidden
 * container inside {@link SpaceView} for two reasons:
 *   1. it renders ONLY the stacked document (no sidebar/header/editor), so the
 *      normal single-page Print — which prints whatever the reader is viewing —
 *      is left completely untouched;
 *   2. it reaches this route via in-app client navigation, so the in-memory
 *      {@link keyStore} handle survives and an ENCRYPTED space can be decrypted
 *      through the very same {@link EncryptedFS} session (a new tab / reload
 *      would wipe the key).
 *
 * Each page renders through the same {@link MarkdownView} pipeline as the app
 * (mermaid / katex / wiki-links / code all print via the shared `@media print`
 * stylesheet). A per-page title + `break-before: page` (see `.print-space-page`
 * in shared/index.css) makes the PDF read as a sequence of titled sections; a
 * cover masthead on page one names the Space + date.
 *
 * Cost note: every page is mounted at once (all mermaid/katex render eagerly).
 * That is intentional — a whole-Space PDF is inherently O(all pages); very large
 * Spaces will simply take longer to prepare (the control bar shows read progress
 * while pages stream in).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Printer, ChevronLeft, Loader2 } from 'lucide-react'
import * as api from '../lib/api'
import * as keyStore from '../lib/keyStore'
import { openEncryptedFS, fsToEntries } from '../lib/encSpace'
import type { EncryptedFS } from '../../shared/vfs/encfs'
import { utf8Decode } from '../../shared/crypto/bytes'
import { MarkdownView, stripMdExt } from '../components/MarkdownView'
import { UnlockScreen } from '../components/UnlockScreen'
import { collectPages } from '../lib/pageOrder'

interface LoadedPage {
  path: string
  content: string
}

/** basename without the markdown extension — the page's display title. */
function pageTitle(path: string): string {
  return stripMdExt(path.slice(path.lastIndexOf('/') + 1))
}

/** Folder breadcrumb ("a / b") for a page path, or '' at the root. */
function pageDir(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/').join(' / ') : ''
}

export function PrintSpaceView() {
  const { spaceID = '' } = useParams<{ spaceID: string }>()
  const [searchParams] = useSearchParams()
  // `?noprint=1` skips the automatic print dialog (used by automated PDF capture
  // + when the user just wants to preview the stacked document on screen).
  const autoPrint = searchParams.get('noprint') !== '1'

  const [meta, setMeta] = useState<api.Meta | null>(null)
  const encrypted = !!meta?.encrypted
  const ksVersion = keyStore.useKeyStoreVersion()
  const unlocked = !encrypted || keyStore.isUnlocked(spaceID)

  const [pages, setPages] = useState<LoadedPage[] | null>(null)
  const [allPaths, setAllPaths] = useState<string[]>([])
  const [status, setStatus] = useState<string>('Loading space…')
  const [err, setErr] = useState<string | null>(null)
  const printedRef = useRef(false)

  const printDate = useMemo(
    () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
    [],
  )

  // Fetch the space meta (the `encrypted` flag decides the read path).
  useEffect(() => {
    if (!spaceID) return
    let cancelled = false
    setMeta(null)
    api.getSpace(spaceID).then(m => { if (!cancelled) setMeta(m) }).catch(e => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [spaceID])

  useEffect(() => { document.title = `${spaceID} — print` }, [spaceID])

  // Force the light palette while this paper-like preview is mounted so the
  // on-screen view matches the printed PDF (the app root keeps its `.dark` class
  // from the space we came from otherwise → invisible light text on white).
  useEffect(() => {
    const root = document.documentElement
    const wasDark = root.classList.contains('dark')
    root.classList.remove('dark')
    return () => { if (wasDark) root.classList.add('dark') }
  }, [])

  // Once meta is known (and the space is unlocked, if encrypted), gather every
  // markdown page in menu order and read/decrypt each one's text.
  useEffect(() => {
    if (!spaceID || !meta) return
    if (encrypted && !unlocked) return
    let cancelled = false
    setPages(null)
    setErr(null)
    setStatus('Loading space…')

    ;(async () => {
      try {
        let entries: api.Entry[]
        let readText: (path: string) => Promise<string>

        if (encrypted) {
          const handle = keyStore.get(spaceID)
          if (!handle) return // locked — the gate below renders the unlock screen
          const fs: EncryptedFS = await openEncryptedFS(spaceID, handle)
          if (cancelled) return
          entries = fsToEntries(fs)
          readText = async (p) => utf8Decode(await fs.read(p))
        } else {
          entries = await api.getTree(spaceID)
          if (cancelled) return
          readText = async (p) => (await api.readFile(spaceID, p)).content
        }

        const pagePaths = collectPages(entries, true)
        setAllPaths(collectPages(entries, false))
        const loaded: LoadedPage[] = []
        for (let i = 0; i < pagePaths.length; i++) {
          if (cancelled) return
          setStatus(`Reading page ${i + 1} of ${pagePaths.length}…`)
          try {
            loaded.push({ path: pagePaths[i], content: await readText(pagePaths[i]) })
          } catch (e) {
            // A single unreadable page shouldn't sink the whole export — note it
            // inline and keep going.
            loaded.push({ path: pagePaths[i], content: `> _Could not read this page: ${String(e)}_` })
          }
        }
        if (!cancelled) setPages(loaded)
      } catch (e) {
        if (!cancelled) setErr(String(e))
      }
    })()

    return () => { cancelled = true }
  }, [spaceID, meta, encrypted, unlocked, ksVersion])

  // Auto-open the print dialog once the document is on the page. A short settle
  // delay lets mermaid/katex finish their async render before the snapshot.
  useEffect(() => {
    if (!pages || pages.length === 0 || printedRef.current || !autoPrint) return
    printedRef.current = true
    const t = window.setTimeout(() => window.print(), 800)
    return () => window.clearTimeout(t)
  }, [pages, autoPrint])

  if (!spaceID) return <p className="p-8 text-[var(--notation-fg-muted)]">missing workspace</p>

  // Encrypted + locked → unlock in place; storing the handle re-renders us with
  // the key available and kicks off the page-collection effect.
  if (encrypted && !unlocked) {
    return <UnlockScreen spaceID={spaceID} onUnlocked={(handle) => keyStore.set(spaceID, handle)} />
  }

  return (
    <div className="print-space min-h-[100dvh] bg-white text-[#111]">
      {/* Control bar — screen only; never printed. */}
      <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-2 bg-[var(--notation-bg-elevated)] text-[var(--notation-fg)] border-b border-[var(--notation-border)] surface-elevated">
        <Link
          to={`/admin/spaces/${encodeURIComponent(spaceID)}`}
          className="flex items-center gap-1.5 text-sm text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]"
        >
          <ChevronLeft size={16} /> Back to {spaceID}
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {pages
            ? <span className="text-[var(--notation-fg-muted)]">{pages.length} page{pages.length === 1 ? '' : 's'}</span>
            : <span className="flex items-center gap-2 text-[var(--notation-fg-muted)]"><Loader2 size={14} className="animate-spin" /> {status}</span>}
          <button
            onClick={() => window.print()}
            disabled={!pages || pages.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] disabled:opacity-40"
          >
            <Printer size={15} /> Print / Save PDF
          </button>
        </div>
      </div>

      {err && (
        <div className="no-print mx-auto max-w-3xl m-4 p-3 rounded-md bg-[var(--notation-danger)]/10 text-[var(--notation-danger)] text-sm">
          {err}
        </div>
      )}

      {/* The printable document. Cover masthead on page one, then one titled
          section per page (each break-before: page under @media print). */}
      <div className="mx-auto max-w-3xl px-6 md:px-10">
        {/* A <div>, not <header>: the print stylesheet hides every <header>. */}
        <div className="print-space-cover pt-10 pb-6">
          <div className="text-[11px] uppercase tracking-wider text-[#64748b]">Whole-space export · Printed {printDate}</div>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-[#0f172a]">{spaceID}</h1>
          {pages && (
            <div className="mt-1 text-sm text-[#64748b]">{pages.length} page{pages.length === 1 ? '' : 's'}</div>
          )}
        </div>

        {pages && pages.length === 0 && (
          <p className="py-16 text-center text-[#64748b]">This space has no markdown pages to print.</p>
        )}

        {pages && pages.map((pg) => (
          <section key={pg.path} className="print-space-page">
            <div className="print-space-page-head">
              {pageDir(pg.path) && <div className="print-space-page-dir">{pageDir(pg.path)}</div>}
              <h2 className="print-space-page-title">{pageTitle(pg.path)}</h2>
            </div>
            <MarkdownView
              content={pg.content}
              theme="light"
              files={allPaths}
              currentFile={pg.path}
            />
          </section>
        ))}
      </div>
    </div>
  )
}
