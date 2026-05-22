import { lazy, Suspense, useEffect, useState } from 'react'
import { Download, FileQuestion } from 'lucide-react'
import * as api from '../lib/api'
import {
  isMarkdownFile,
  isImageFile,
  isCodeFile,
  isPDFFile,
  isAudioFile,
  isVideoFile,
  isWordFile,
  isSpreadsheetFile,
  highlightLang,
} from '../lib/fileTypes'
import { MarkdownView } from './MarkdownView'
import { AudioView } from './viewers/AudioView'
import { VideoView } from './viewers/VideoView'

// Heavy viewers go in their own lazy chunks: SheetJS ~700KB, Mammoth ~1MB.
// Loaded only when the user opens a spreadsheet / DOCX.
const SpreadsheetView = lazy(() => import('./viewers/SpreadsheetView'))
const WordView = lazy(() => import('./viewers/WordView'))

type Props = {
  spaceID: string
  path: string
  content: string
  theme: 'light' | 'dark'
  /** Override the URL builder. Admin defaults to api.fileURL; share SPA can
   * pass a share-token aware variant so the same component renders for both. */
  urlFor?: (path: string) => string
}

/**
 * FileViewer is the read-only dispatcher for any file in the Space. The
 * extension determines the rendering path:
 *
 *   .md / .markdown        → MarkdownView (rehype pipeline + comments)
 *   .png .jpg .gif .webp … → ImageView (direct backend URL)
 *   .pdf                   → PDFView (iframe)
 *   .mp4 .webm .mov        → VideoView (native <video> with Range support)
 *   .mp3 .wav .ogg .flac   → AudioView (native <audio>)
 *   .docx                  → WordView (mammoth + DOMPurify, lazy)
 *   .xlsx .ods .csv .tsv   → SpreadsheetView (SheetJS + DOMPurify, lazy)
 *   .json .ts .py .go .yml → CodeView (highlight.js by language guess)
 *   anything else          → DownloadView (offers a download link)
 *
 * For binary types the caller can pass an empty `content` — the viewer
 * fetches via the file URL directly.
 */
export function FileViewer({ spaceID, path, content, theme, urlFor }: Props) {
  const resolveURL = urlFor ?? ((p: string) => api.fileURL(spaceID, p))

  if (isMarkdownFile(path)) {
    return <MarkdownView content={content} theme={theme} />
  }
  if (isImageFile(path)) {
    return <ImageView url={resolveURL(path)} path={path} />
  }
  if (isPDFFile(path)) {
    return <PDFView url={resolveURL(path)} path={path} />
  }
  if (isAudioFile(path)) {
    return <AudioView url={resolveURL(path)} path={path} />
  }
  if (isVideoFile(path)) {
    return <VideoView url={resolveURL(path)} path={path} />
  }
  if (isWordFile(path)) {
    return (
      <Suspense fallback={<LazyLoading />}>
        <WordView url={resolveURL(path)} path={path} />
      </Suspense>
    )
  }
  if (isSpreadsheetFile(path)) {
    return (
      <Suspense fallback={<LazyLoading />}>
        <SpreadsheetView url={resolveURL(path)} path={path} />
      </Suspense>
    )
  }
  if (isCodeFile(path)) {
    return <CodeView content={content} path={path} />
  }
  return <DownloadView url={resolveURL(path)} path={path} />
}

function LazyLoading() {
  return (
    <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
      Loading viewer…
    </div>
  )
}

function ImageView({ url, path }: { url: string; path: string }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-zinc-50/50 dark:bg-zinc-950/30 p-8 overflow-auto">
      <img
        src={url}
        alt={path}
        className="max-w-full max-h-full object-contain rounded-md shadow-md"
      />
    </div>
  )
}

function PDFView({ url, path }: { url: string; path: string }) {
  return (
    <iframe
      src={url}
      title={path}
      className="flex-1 w-full border-0 bg-zinc-100 dark:bg-zinc-950"
    />
  )
}

function CodeView({ content, path }: { content: string; path: string }) {
  const [html, setHtml] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    const lang = highlightLang(path)
    void import('highlight.js').then(({ default: hljs }) => {
      if (cancelled) return
      try {
        const target = hljs.getLanguage(lang) ? lang : 'plaintext'
        const result = hljs.highlight(content, { language: target, ignoreIllegals: true })
        setHtml(result.value)
      } catch {
        setHtml(escapeHtml(content))
      }
    })
    return () => {
      cancelled = true
    }
  }, [content, path])

  return (
    <div className="flex-1 overflow-auto bg-zinc-50/50 dark:bg-zinc-950/30">
      <pre className="hljs p-6 text-sm leading-relaxed max-w-5xl mx-auto rounded-md my-4">
        <code dangerouslySetInnerHTML={{ __html: html || escapeHtml(content) }} />
      </pre>
    </div>
  )
}

function DownloadView({ url, path }: { url: string; path: string }) {
  const filename = path.split('/').pop() ?? path
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <FileQuestion size={48} className="text-zinc-300 dark:text-zinc-700 mb-4" />
      <p className="text-[var(--notation-fg)] font-medium mb-1">{filename}</p>
      <p className="text-sm text-zinc-500 mb-6">No inline preview available for this file type.</p>
      <a
        href={url}
        download={filename}
        className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white dark:bg-[color:var(--notation-accent)] dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-[#a6d944] font-medium text-sm rounded-md transition-colors"
      >
        <Download size={14} /> Download
      </a>
    </div>
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
