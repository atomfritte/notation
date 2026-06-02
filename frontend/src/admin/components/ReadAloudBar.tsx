import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Headphones, Play, Pause, SkipBack, SkipForward, X, Lock, ChevronDown, Server } from 'lucide-react'
import {
  extractSentences, groupChunks, chunkIndexForSentence, systemEngine, loadReadPos, saveReadPos,
  type Sentence, type Chunk, type TtsEngine, type TtsVoice,
} from '../lib/readAloud'
import { createServerEngine, type ServerVoice } from '../lib/serverTts'

type Status = 'idle' | 'playing' | 'paused'
type EngineId = 'system' | 'neural'

const PAGE_PAUSE_MS = 1200 // beat between pages, like turning a page
const RATES = [0.75, 1, 1.25, 1.5, 1.75]

/**
 * ReadAloudBar — an audiobook player for the current Space. Reads a page's prose
 * (skipping tables/code) in synthesis chunks: one sentence at a time for the
 * on-device system voice, a paragraph at a time for the server "studio voice"
 * (Piper on the backend, which prefetches the next paragraph so playback is
 * gapless). Highlights the current sentence, pauses at the end of a page, then
 * auto-advances. Reading position is saved per Space (per-user for admin /
 * per-share-token for guests) and restored.
 *
 * The system voice runs entirely on-device. The studio voice sends each
 * paragraph to THIS app's own server (same origin) to be synthesised by Piper —
 * never to a third party.
 */
export function ReadAloudBar({
  navFiles, currentFile, content, onNavigate, storageKey, onClose, serverVoices, ttsURL,
}: {
  navFiles: string[]
  currentFile: string
  content: string
  onNavigate: (path: string) => void
  storageKey: string
  onClose: () => void
  /** Server studio voices (from /tts/info); enables the studio engine. */
  serverVoices?: ServerVoice[]
  /** Build a /tts audio URL for (voiceId, text). Must be stable (memoised). */
  ttsURL?: (voiceId: string, text: string) => string
}) {
  const [systemEng] = useState<TtsEngine | null>(() => systemEngine())
  const serverEng = useMemo<TtsEngine | null>(
    () => (serverVoices && serverVoices.length && ttsURL ? createServerEngine(serverVoices, ttsURL) : null),
    [serverVoices, ttsURL],
  )
  const studioAvailable = !!serverEng
  const [engineId, setEngineId] = useState<EngineId>(() =>
    localStorage.getItem('notation_readaloud_engine') === 'neural' ? 'neural' : 'system')
  // The engine actually used for synthesis.
  const engine = engineId === 'neural' ? serverEng : systemEng

  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [voiceId, setVoiceId] = useState<string>(() => localStorage.getItem('notation_readaloud_voice') || '')
  const [rate, setRate] = useState<number>(() => Number(localStorage.getItem('notation_readaloud_rate')) || 1)
  const [status, setStatus] = useState<Status>('idle')
  const [curText, setCurText] = useState('')
  const [progress, setProgress] = useState<{ i: number; n: number }>({ i: 0, n: 0 })

  const sentencesRef = useRef<Sentence[]>([])
  const chunksRef = useRef<Chunk[]>([])
  const chunkRef = useRef(0) // current chunk index
  const hlSentRef = useRef(-1) // currently highlighted flat-sentence index (in-chunk)
  const handleRef = useRef<{ cancel: () => void } | null>(null)
  const pendingRef = useRef<number | null>(null) // resume-at-sentence after a page change
  const statusRef = useRef<Status>('idle')
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const highlightRef = useRef<{ clear: () => void; add: (r: Range) => void } | null>(null)
  const fileRef = useRef(currentFile)
  const engineRef = useRef<TtsEngine | null>(engine)
  engineRef.current = engine
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
  useEffect(() => { localStorage.setItem('notation_readaloud_engine', engineId) }, [engineId])

  // Free the server engine's <audio> when it changes / on unmount.
  useEffect(() => () => { serverEng?.dispose?.() }, [serverEng])
  // If the studio voice was remembered but isn't available here, fall back.
  useEffect(() => { if (engineId === 'neural' && serverVoices && serverVoices.length === 0) setEngineId('system') }, [engineId, serverVoices])

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

  // Re-read the rendered page into the flat sentence list + the engine's chunks.
  const extractCurrent = useCallback((): Chunk[] => {
    const article = getArticle()
    const s = article ? extractSentences(article) : []
    sentencesRef.current = s
    hlSentRef.current = -1 // ranges are stale after a re-read
    const mode = engineRef.current?.chunking === 'block' ? 'block' : 'sentence'
    const ch = groupChunks(s, mode)
    chunksRef.current = ch
    setProgress(p => ({ ...p, n: s.length }))
    return ch
  }, [])

  // Highlight one flat-sentence (by its index within `sentencesRef`), scrolling
  // to it only when it actually changes (timeupdate fires several times/sec).
  const highlightSentence = useCallback((sentenceIndex: number) => {
    if (sentenceIndex === hlSentRef.current) return
    hlSentRef.current = sentenceIndex
    const s = sentencesRef.current[sentenceIndex]
    if (!s) { highlight(null); return }
    highlight(s.range)
    setProgress({ i: sentenceIndex + 1, n: sentencesRef.current.length })
    try { s.range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch { /* ignore */ }
  }, [highlight])

  const cancelSpeech = useCallback(() => {
    if (pauseTimer.current) { clearTimeout(pauseTimer.current); pauseTimer.current = null }
    handleRef.current?.cancel()
    handleRef.current = null
    engine?.cancelAll()
  }, [engine])

  const finish = useCallback(() => {
    cancelSpeech()
    highlight(null)
    hlSentRef.current = -1
    releaseWake()
    setStat('idle')
    setCurText('')
  }, [cancelSpeech, highlight, releaseWake])

  const switchEngine = useCallback((id: EngineId) => {
    if (id === engineId) return
    finish()
    setProgress({ i: 0, n: 0 })
    setEngineId(id)
  }, [engineId, finish])

  // Speak chunk `c` of the current page, chaining to c+1 on completion. The
  // neural engine gets the next chunk prefetched so the handoff is gapless, and
  // reports playback progress so the highlight tracks sentences within a chunk.
  const speakChunk = useCallback((c: number) => {
    const eng = engineRef.current
    if (!eng) return
    const chunks = chunksRef.current
    chunkRef.current = c
    if (c >= chunks.length) {
      // End of page → brief pause, then advance to the next page.
      highlight(null)
      hlSentRef.current = -1
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
    const chunk = chunks[c]
    setCurText(chunk.text)
    highlightSentence(chunk.startIndex)
    saveReadPos(storageKey, { file: fileRef.current, sentence: chunk.startIndex })

    // Warm the NEXT chunk so there's no gap while it synthesises (neural only),
    // but only once THIS chunk is actually playing — issuing it earlier would
    // make a seek during this chunk's own synth wait behind a now-useless
    // prefetch (predict() can't be cancelled). onProgress fires only after
    // playback starts, so triggering from there guarantees that ordering.
    let prefetched = false
    const doPrefetch = () => {
      if (prefetched) return
      prefetched = true
      if (eng.prefetch && c + 1 < chunks.length) eng.prefetch(chunks[c + 1].text, { voiceId, rate })
    }

    // chunk.text joins sentences with single spaces (see groupChunks), so the
    // synthesised audio is longer than the bare sentence chars by one space per
    // boundary — count those so the in-chunk highlight lands on time.
    const joins = Math.max(0, chunk.sentences.length - 1)
    const total = chunk.sentences.reduce((a, s) => a + s.text.length, 0) + joins || 1
    let started = false // did this chunk actually produce audio?
    const advance = () => { if (statusRef.current === 'playing') speakChunk(c + 1) }
    const onErr = () => {
      if (statusRef.current !== 'playing') return
      // A neural chunk that errors before any audio played is a blocked/failed
      // START (e.g. autoplay), not a bad chunk — park rather than racing through
      // the whole document. The system engine has no such state, so it skips.
      if (eng.id === 'neural' && !started) { cancelSpeech(); releaseWake(); setStat('paused'); return }
      advance() // skip a chunk that glitched mid-playback rather than stalling
    }
    handleRef.current?.cancel() // neutralise any still-pending prior synth (no overlap on the shared audio)
    handleRef.current = eng.speak(
      chunk.text, { voiceId, rate },
      advance,
      onErr,
      (frac) => {
        if (statusRef.current !== 'playing') return
        started = true
        doPrefetch()
        if (chunk.sentences.length <= 1) return
        // Map playback fraction → sentence within the chunk by cumulative length.
        const pos = frac * total
        let acc = 0, k = chunk.sentences.length - 1
        for (let j = 0; j < chunk.sentences.length; j++) {
          acc += chunk.sentences[j].text.length + (j > 0 ? 1 : 0) // + join space before this sentence
          if (pos <= acc) { k = j; break }
        }
        highlightSentence(chunk.startIndex + k)
      },
    )
  }, [voiceId, rate, navFiles, onNavigate, storageKey, highlight, highlightSentence, finish, cancelSpeech, releaseWake])

  // When the page changes while playing (auto-advance OR manual navigation),
  // re-extract the new page and resume from the pending sentence (0 by default).
  useEffect(() => {
    if (statusRef.current !== 'playing') {
      // If we were paused, the buffered chunk belongs to the old page — drop it
      // so pressing play starts fresh on this page rather than resuming stale audio.
      if (statusRef.current === 'paused') { cancelSpeech(); highlight(null); hlSentRef.current = -1; setStat('idle') }
      return
    }
    const resumeAt = pendingRef.current ?? 0
    pendingRef.current = null
    cancelSpeech()
    // Let the new content paint before reading from the DOM.
    const t = setTimeout(() => {
      if (statusRef.current !== 'playing') return
      const chunks = extractCurrent()
      if (chunks.length === 0) {
        // Nothing readable here (e.g. a form/binary page) — skip to next page.
        const idx = navFiles.indexOf(fileRef.current)
        const next = idx >= 0 && idx < navFiles.length - 1 ? navFiles[idx + 1] : null
        if (next) { pendingRef.current = 0; onNavigate(next) } else finish()
        return
      }
      const sentence = Math.min(resumeAt, sentencesRef.current.length - 1)
      speakChunk(chunkIndexForSentence(chunks, sentence))
    }, 120)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFile, content])

  // ---- controls ----
  const play = useCallback(() => {
    if (!engine) return
    void acquireWake()
    if (statusRef.current === 'paused') {
      setStat('playing')
      // Engines without in-place resume (system) restart the chunk: reset the
      // highlight tracker so the current sentence is re-highlighted + re-scrolled.
      if (!engine.resume) hlSentRef.current = -1
      // Resume in place if the engine supports it (neural). If its play() can't
      // restart (autoplay blocked), park back at paused so the user can re-tap —
      // never skip ahead. Engines without resume restart the chunk.
      const onResumeFail = () => { releaseWake(); setStat('paused') }
      if (!(engine.resume && engine.resume(onResumeFail))) speakChunk(chunkRef.current)
      return
    }
    // Starting fresh: resume the saved position if it points elsewhere.
    const saved = loadReadPos(storageKey)
    setStat('playing')
    if (saved && saved.file !== fileRef.current && navFiles.includes(saved.file)) {
      pendingRef.current = saved.sentence
      onNavigate(saved.file)
      return
    }
    const chunks = extractCurrent()
    const sentence = saved && saved.file === fileRef.current ? Math.min(saved.sentence, Math.max(0, sentencesRef.current.length - 1)) : 0
    speakChunk(chunkIndexForSentence(chunks, sentence))
  }, [engine, storageKey, navFiles, onNavigate, extractCurrent, speakChunk, acquireWake, releaseWake])

  const pause = useCallback(() => {
    if (pauseTimer.current) { clearTimeout(pauseTimer.current); pauseTimer.current = null }
    // In-place pause keeps the buffered audio + highlight; engines without it
    // (system) cancel and restart the chunk on resume.
    if (engine?.pause) engine.pause()
    else cancelSpeech()
    releaseWake()
    setStat('paused')
  }, [engine, cancelSpeech, releaseWake])

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
    // Tear down the GLOBAL mediaSession on unmount so the lock screen / headset
    // can't drive stale closures (re-acquiring the wake lock, restarting audio)
    // after read-aloud is closed.
    return () => {
      try {
        for (const a of ['play', 'pause', 'previoustrack', 'nexttrack']) ms.setActionHandler(a, null)
        ms.playbackState = 'none'
        ms.metadata = null
      } catch { /* ignore */ }
    }
  }, [curText, currentFile, status, play, pause, jumpPage])

  // If the browser has no system speech engine, the studio voice is the only
  // option — switch to it automatically when it's available.
  useEffect(() => { if (!systemEng && studioAvailable && engineId === 'system') setEngineId('neural') }, [engineId, systemEng, studioAvailable])

  const playing = status === 'playing'
  const sysUnsupported = engineId === 'system' && !systemEng
  const studioPending = engineId === 'neural' && !serverEng
  const noVoices = engineId === 'system' && !!systemEng && voices.length === 0
  const engineOptions = [
    ...(systemEng ? [{ value: 'system', label: 'System' }] : []),
    ...(studioAvailable ? [{ value: 'neural', label: 'Studio' }] : []),
  ]

  return (
    <div className="no-print fixed bottom-0 inset-x-0 z-40 flex justify-center px-3 pb-3 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-2xl surface-elevated bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-xl shadow-2xl px-3 py-2 flex items-center gap-2">
        <Headphones size={18} className="text-[color:var(--notation-accent)] flex-shrink-0" />

        {engineOptions.length > 1 && (
          <Dropdown value={engineId} onChange={v => switchEngine(v as EngineId)} title="Voice engine"
            options={engineOptions} />
        )}

        {sysUnsupported ? (
          <span className="flex-1 text-sm text-[var(--notation-fg-muted)]">{studioAvailable ? 'No system voice here — pick the studio voice.' : 'Read-aloud isn’t available in this browser.'}</span>
        ) : studioPending ? (
          <span className="flex-1 text-sm text-[var(--notation-fg-muted)]">Loading the studio voice…</span>
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

            {voices.length > 1 && (
              <Dropdown value={voiceId} onChange={setVoiceId} title="Voice"
                options={voices.map(v => ({ value: v.id, label: `${v.label}${v.lang ? ' · ' + v.lang : ''}` }))} compact />
            )}
            <Dropdown value={String(rate)} onChange={(v) => setRate(Number(v))} title="Speed"
              options={RATES.map(r => ({ value: String(r), label: `${r}×` }))} />

            {engineId === 'neural' ? (
              <span className="hidden sm:flex items-center gap-1 text-[10px] text-[var(--notation-fg-muted)] px-1" title="Synthesised by Piper on your own server — text only goes to this app, never a third party.">
                <Server size={11} /> your server
              </span>
            ) : (
              <span className="hidden sm:flex items-center gap-1 text-[10px] text-[var(--notation-fg-muted)] px-1" title="Audio is generated on your device — text never leaves it.">
                <Lock size={11} /> on-device
              </span>
            )}
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
