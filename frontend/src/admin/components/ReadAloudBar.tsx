import { useCallback, useEffect, useRef, useState } from 'react'
import { Headphones, Play, Pause, SkipBack, SkipForward, X, Lock, ChevronDown } from 'lucide-react'
import {
  extractSentences, availableEngines, loadReadPos, saveReadPos,
  type Sentence, type TtsEngine, type TtsVoice,
} from '../lib/readAloud'

type Status = 'idle' | 'playing' | 'paused'

const PAGE_PAUSE_MS = 1200 // beat between pages, like turning a page
const RATES = [0.75, 1, 1.25, 1.5, 1.75]

/**
 * ReadAloudBar — a fully on-device audiobook player for the current Space.
 * Reads a page's prose sentence-by-sentence (skipping tables/code), highlights
 * the current sentence, pauses at the end of a page, then auto-advances to the
 * next page in menu order. The reading position is saved per Space (the
 * storageKey is per-user for admin / per-share-token for guests) and restored.
 *
 * No text ever leaves the device: the engine is restricted to on-device voices.
 */
export function ReadAloudBar({
  navFiles, currentFile, content, onNavigate, storageKey, onClose,
}: {
  navFiles: string[]
  currentFile: string
  content: string
  onNavigate: (path: string) => void
  storageKey: string
  onClose: () => void
}) {
  const [engine] = useState<TtsEngine | null>(() => availableEngines()[0] ?? null)
  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [voiceId, setVoiceId] = useState<string>(() => localStorage.getItem('notation_readaloud_voice') || '')
  const [rate, setRate] = useState<number>(() => Number(localStorage.getItem('notation_readaloud_rate')) || 1)
  const [status, setStatus] = useState<Status>('idle')
  const [curText, setCurText] = useState('')
  const [progress, setProgress] = useState<{ i: number; n: number }>({ i: 0, n: 0 })

  const sentencesRef = useRef<Sentence[]>([])
  const indexRef = useRef(0)
  const handleRef = useRef<{ cancel: () => void } | null>(null)
  const pendingRef = useRef<number | null>(null) // resume-at-sentence after a page change
  const statusRef = useRef<Status>('idle')
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const highlightRef = useRef<{ clear: () => void; add: (r: Range) => void } | null>(null)
  const fileRef = useRef(currentFile)
  fileRef.current = currentFile

  const setStat = (s: Status) => { statusRef.current = s; setStatus(s) }

  // ---- keep playing when the screen would sleep ----
  // The system speech engine is suspended by the browser once the page is
  // backgrounded, so the reliable way to keep an audiobook going on a phone is
  // to hold a Screen Wake Lock while reading (the display stays awake). Wake
  // locks auto-release when the tab is hidden, so we re-acquire on return.
  const wakeRef = useRef<{ release: () => Promise<void> } | null>(null)
  const acquireWake = useCallback(async () => {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock
      if (wl && !wakeRef.current) wakeRef.current = await wl.request('screen')
    } catch { /* not supported / denied — best effort */ }
  }, [])
  const releaseWake = useCallback(() => {
    try { wakeRef.current?.release() } catch { /* ignore */ }
    wakeRef.current = null
  }, [])
  useEffect(() => {
    function onVis() { if (document.visibilityState === 'visible' && statusRef.current === 'playing') void acquireWake() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [acquireWake])

  // ---- voices (on-device only) ----
  useEffect(() => {
    if (!engine) return
    const load = () => {
      const vs = engine.voices()
      setVoices(vs)
      setVoiceId(prev => {
        if (prev && vs.some(v => v.id === prev)) return prev
        // Prefer a voice matching the document language, else the first.
        const lang = document.documentElement.lang || navigator.language || ''
        const match = vs.find(v => v.lang && lang && v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()))
        return (match ?? vs[0])?.id ?? ''
      })
    }
    load()
    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = load
      return () => { window.speechSynthesis.onvoiceschanged = null }
    }
  }, [engine])

  useEffect(() => { if (voiceId) localStorage.setItem('notation_readaloud_voice', voiceId) }, [voiceId])
  useEffect(() => { localStorage.setItem('notation_readaloud_rate', String(rate)) }, [rate])

  // ---- highlight (CSS Custom Highlight API; degrades to scroll-only) ----
  const highlight = useCallback((range: Range | null) => {
    // CSS Custom Highlight API — referenced via `any` so the build doesn't
    // depend on the (newer) Highlight/HighlightRegistry lib types being present.
    const HL = (window as unknown as { Highlight?: new () => { clear(): void; add(r: Range): void } }).Highlight
    const reg = (CSS as unknown as { highlights?: { set(name: string, h: unknown): void } }).highlights
    if (!HL || !reg) return
    if (!highlightRef.current) {
      highlightRef.current = new HL()
      reg.set('readaloud', highlightRef.current)
    }
    highlightRef.current.clear()
    if (range) highlightRef.current.add(range)
  }, [])

  const getArticle = () => document.querySelector<HTMLElement>('article.prose')

  const extractCurrent = useCallback((): Sentence[] => {
    const article = getArticle()
    const s = article ? extractSentences(article) : []
    sentencesRef.current = s
    setProgress(p => ({ ...p, n: s.length }))
    return s
  }, [])

  const cancelSpeech = useCallback(() => {
    if (pauseTimer.current) { clearTimeout(pauseTimer.current); pauseTimer.current = null }
    handleRef.current?.cancel()
    handleRef.current = null
    engine?.cancelAll()
  }, [engine])

  const finish = useCallback(() => {
    cancelSpeech()
    highlight(null)
    releaseWake()
    setStat('idle')
    setCurText('')
  }, [cancelSpeech, highlight, releaseWake])

  // Speak sentence i of the current page, chaining to i+1 on completion.
  const speakFrom = useCallback((i: number) => {
    if (!engine) return
    const list = sentencesRef.current
    if (i >= list.length) {
      // End of page → brief pause, then advance to the next page.
      highlight(null)
      const idx = navFiles.indexOf(fileRef.current)
      const next = idx >= 0 && idx < navFiles.length - 1 ? navFiles[idx + 1] : null
      if (!next) { finish(); saveReadPos(storageKey, null); return }
      setCurText('— next page —')
      pauseTimer.current = setTimeout(() => {
        if (statusRef.current !== 'playing') return
        pendingRef.current = 0
        onNavigate(next)
      }, PAGE_PAUSE_MS)
      return
    }
    indexRef.current = i
    const s = list[i]
    setProgress({ i: i + 1, n: list.length })
    setCurText(s.text)
    highlight(s.range)
    try { s.range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch { /* ignore */ }
    saveReadPos(storageKey, { file: fileRef.current, sentence: i })
    handleRef.current = engine.speak(s.text, { voiceId, rate }, () => {
      if (statusRef.current === 'playing') speakFrom(i + 1)
    }, () => { /* skip unreadable chunk */ if (statusRef.current === 'playing') speakFrom(i + 1) })
  }, [engine, voiceId, rate, navFiles, onNavigate, storageKey, highlight, finish])

  // When the page changes while playing (auto-advance OR manual navigation),
  // re-extract the new page and resume from the pending sentence (0 by default).
  useEffect(() => {
    if (statusRef.current !== 'playing') return
    const resumeAt = pendingRef.current ?? 0
    pendingRef.current = null
    cancelSpeech()
    // Let the new content paint before reading from the DOM.
    const t = setTimeout(() => {
      if (statusRef.current !== 'playing') return
      const list = extractCurrent()
      if (list.length === 0) {
        // Nothing readable here (e.g. a form/binary page) — skip to next page.
        const idx = navFiles.indexOf(fileRef.current)
        const next = idx >= 0 && idx < navFiles.length - 1 ? navFiles[idx + 1] : null
        if (next) { pendingRef.current = 0; onNavigate(next) } else finish()
        return
      }
      speakFrom(Math.min(resumeAt, list.length - 1))
    }, 120)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFile, content])

  // ---- controls ----
  const play = useCallback(() => {
    if (!engine) return
    void acquireWake()
    if (statusRef.current === 'paused') { setStat('playing'); speakFrom(indexRef.current); return }
    // Starting fresh: resume the saved position if it points elsewhere.
    const saved = loadReadPos(storageKey)
    setStat('playing')
    if (saved && saved.file !== fileRef.current && navFiles.includes(saved.file)) {
      pendingRef.current = saved.sentence
      onNavigate(saved.file)
      return
    }
    const list = extractCurrent()
    speakFrom(saved && saved.file === fileRef.current ? Math.min(saved.sentence, Math.max(0, list.length - 1)) : 0)
  }, [engine, storageKey, navFiles, onNavigate, extractCurrent, speakFrom, acquireWake])

  const pause = useCallback(() => { cancelSpeech(); releaseWake(); setStat('paused') }, [cancelSpeech, releaseWake])

  const jumpPage = useCallback((dir: -1 | 1) => {
    const idx = navFiles.indexOf(fileRef.current)
    const target = idx + dir
    if (target < 0 || target >= navFiles.length) return
    if (statusRef.current === 'playing') pendingRef.current = 0
    onNavigate(navFiles[target])
  }, [navFiles, onNavigate])

  // Cleanup on unmount.
  useEffect(() => () => { cancelSpeech(); highlight(null); releaseWake() }, [cancelSpeech, highlight, releaseWake])

  // MediaSession: surface play/pause + page skip on the lock screen / headset,
  // and reflect what's being read. (Lock-screen controls only appear once the
  // engine plays through a real audio element — i.e. the neural voice — but the
  // metadata + handlers are harmless and ready for it.)
  useEffect(() => {
    const ms = (navigator as { mediaSession?: { metadata: unknown; playbackState: string; setActionHandler: (a: string, h: (() => void) | null) => void } }).mediaSession
    const MM = (window as { MediaMetadata?: new (init: { title?: string; artist?: string }) => unknown }).MediaMetadata
    if (!ms || !MM) return
    try {
      ms.metadata = new MM({ title: curText || 'Reading…', artist: stripPath(currentFile) })
      ms.playbackState = status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'none'
      ms.setActionHandler('play', () => play())
      ms.setActionHandler('pause', () => pause())
      ms.setActionHandler('previoustrack', () => jumpPage(-1))
      ms.setActionHandler('nexttrack', () => jumpPage(1))
    } catch { /* unsupported handler — ignore */ }
  }, [curText, currentFile, status, play, pause, jumpPage])

  const playing = status === 'playing'
  const unsupported = !engine
  const noVoices = !!engine && voices.length === 0

  return (
    <div className="no-print fixed bottom-0 inset-x-0 z-40 flex justify-center px-3 pb-3 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-2xl surface-elevated bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-xl shadow-2xl px-3 py-2 flex items-center gap-2">
        <Headphones size={18} className="text-[color:var(--notation-accent)] flex-shrink-0" />

        {unsupported ? (
          <span className="flex-1 text-sm text-[var(--notation-fg-muted)]">Read-aloud isn’t available in this browser.</span>
        ) : noVoices ? (
          <span className="flex-1 text-sm text-[var(--notation-fg-muted)]">No on-device voices installed. Add a system voice to listen.</span>
        ) : (
          <>
            <button
              onClick={() => jumpPage(-1)}
              className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-border)] disabled:opacity-30"
              disabled={navFiles.indexOf(currentFile) <= 0}
              title="Previous page"
            >
              <SkipBack size={16} />
            </button>
            <button
              onClick={() => (playing ? pause() : play())}
              className="p-2 rounded-full bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] hover:opacity-90 flex-shrink-0"
              title={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button
              onClick={() => jumpPage(1)}
              className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-border)] disabled:opacity-30"
              disabled={navFiles.indexOf(currentFile) >= navFiles.length - 1}
              title="Next page"
            >
              <SkipForward size={16} />
            </button>

            <div className="flex-1 min-w-0 px-1">
              <div className="text-xs text-[var(--notation-fg)] truncate">
                {curText || (status === 'idle' ? 'Ready to read this page aloud.' : '')}
              </div>
              {progress.n > 0 && (
                <div className="text-[10px] text-[var(--notation-fg-muted)]">{progress.i}/{progress.n}</div>
              )}
            </div>

            <Dropdown value={voiceId} onChange={setVoiceId} title="Voice"
              options={voices.map(v => ({ value: v.id, label: `${v.label}${v.lang ? ' · ' + v.lang : ''}` }))} compact />
            <Dropdown value={String(rate)} onChange={(v) => setRate(Number(v))} title="Speed"
              options={RATES.map(r => ({ value: String(r), label: `${r}×` }))} />

            <span className="hidden sm:flex items-center gap-1 text-[10px] text-[var(--notation-fg-muted)] px-1" title="Audio is generated on your device — text never leaves it.">
              <Lock size={11} /> on-device
            </span>
          </>
        )}

        <button
          onClick={() => { cancelSpeech(); highlight(null); onClose() }}
          className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-border)] flex-shrink-0"
          title="Close read-aloud"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}

function Dropdown({
  value, onChange, options, title, compact,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  title: string
  compact?: boolean
}) {
  return (
    <div className="relative flex-shrink-0">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        title={title}
        className={
          'appearance-none bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] rounded-md text-xs text-[var(--notation-fg)] pl-2 pr-5 py-1 outline-none focus:border-[color:var(--notation-accent-40)] ' +
          (compact ? 'max-w-[7rem] truncate' : '')
        }
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown size={12} className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--notation-fg-muted)]" />
    </div>
  )
}

function stripPath(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1).replace(/\.(md|mdx|markdown)$/i, '')
}
