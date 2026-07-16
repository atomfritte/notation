// Read-aloud (audiobook) core: readable-text extraction + a pluggable, fully
// on-device TTS engine. NO text ever leaves the device — the system engine is
// restricted to `localService` voices (browser "natural"/cloud voices are
// excluded), and any future engine (e.g. an in-browser neural model) must run
// locally too. See ReadAloudBar.tsx for the orchestration + UI.

export type Sentence = { text: string; range: Range; block: number }

// Block elements whose text we read; everything else (tables, code, the page-
// nav footer, the floating toolbars) is skipped so it reads like a book.
const SKIP_TAGS = new Set(['TABLE', 'PRE', 'CODE', 'SCRIPT', 'STYLE', 'BUTTON', 'SVG', 'svg'])
const SKIP_CLASSES = ['no-read', 'no-print', 'page-nav', 'selection-toolbar', 'prose-table-wrap']

// The standalone "↗" badge that remarkAutoFileLink injects after an inline-code
// file mention is its OWN text node. We can't target it by class (rehype-sanitize
// strips the badge's className), so we drop the glyph itself: it's a UI affordance,
// never prose, so it shouldn't be spoken — and dropping it keeps the off-screen
// vertonen chunker (which never runs that plugin) producing identical chunk text.
const AUTO_FILE_LINK_BADGE = '↗'

function isSkipped(el: Element | null, root: Element): boolean {
  while (el && el !== root) {
    if (SKIP_TAGS.has(el.tagName)) return true
    for (const c of SKIP_CLASSES) if (el.classList.contains(c)) return true
    el = el.parentElement
  }
  return false
}

/**
 * extractSentences walks the rendered article and returns an ordered list of
 * sentences, each mapped to a DOM Range (for highlighting + scroll). Sentences
 * never cross block boundaries (so each paragraph/heading is its own unit, with
 * natural pauses), and tables / code blocks are skipped entirely.
 */
export function extractSentences(article: HTMLElement): Sentence[] {
  const out: Sentence[] = []
  // Iterate the top-level blocks in document order; recurse only into ones we
  // read. Each block's text is split into sentences mapped back to ranges. The
  // block index is recorded on every sentence so the player can group sentences
  // back into per-paragraph synthesis chunks (see groupChunks).
  let blockIdx = 0
  for (const block of Array.from(article.children)) {
    if (isSkipped(block, article)) continue
    collectBlock(block as HTMLElement, article, out, blockIdx)
    blockIdx++
  }
  return out
}

function collectBlock(block: HTMLElement, root: HTMLElement, out: Sentence[], blockIdx: number) {
  // Gather the text nodes inside this block, skipping nested tables/code.
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const t = n.textContent ?? ''
      if (!t.trim()) return NodeFilter.FILTER_REJECT
      if (t.trim() === AUTO_FILE_LINK_BADGE) return NodeFilter.FILTER_REJECT
      return isSkipped((n as Text).parentElement, root) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    },
  })
  const nodes: { node: Text; start: number }[] = []
  let flat = ''
  let cur = walker.nextNode() as Text | null
  while (cur) {
    nodes.push({ node: cur, start: flat.length })
    flat += cur.textContent ?? ''
    cur = walker.nextNode() as Text | null
  }
  const collapsed = flat.replace(/\s+/g, ' ').trim()
  if (!collapsed) return

  // Split into sentences on terminal punctuation; fall back to the whole block.
  // Offsets are computed against the ORIGINAL flat text so ranges stay valid.
  for (const [s, e] of sentenceSpans(flat)) {
    const text = flat.slice(s, e).replace(/\s+/g, ' ').trim()
    if (text.length < 1) continue
    const range = rangeFor(nodes, s, e)
    if (range) out.push({ text, range, block: blockIdx })
  }
}

// sentenceSpans returns [start,end) offsets of sentences within `flat`.
function sentenceSpans(flat: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const re = /[^.!?…]*[.!?…]+["')\]]*\s*|[^.!?…]+$/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flat)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    if (flat.slice(start, end).trim()) spans.push([start, end])
    if (m.index === re.lastIndex) re.lastIndex++ // guard zero-width
  }
  return spans.length ? spans : [[0, flat.length]]
}

function rangeFor(nodes: { node: Text; start: number }[], start: number, end: number): Range | null {
  let startNode: Text | null = null, startOff = 0, endNode: Text | null = null, endOff = 0
  for (const { node, start: ns } of nodes) {
    const len = (node.textContent ?? '').length
    const ne = ns + len
    if (!startNode && start < ne) { startNode = node; startOff = Math.max(0, start - ns) }
    if (end <= ne) { endNode = node; endOff = Math.max(0, end - ns); break }
  }
  if (!startNode) return null
  if (!endNode) { const last = nodes[nodes.length - 1]; endNode = last.node; endOff = (last.node.textContent ?? '').length }
  try {
    const r = document.createRange()
    r.setStart(startNode, Math.min(startOff, (startNode.textContent ?? '').length))
    r.setEnd(endNode, Math.min(endOff, (endNode.textContent ?? '').length))
    return r
  } catch {
    return null
  }
}

// ---- Synthesis chunks ----------------------------------------------------

/** A chunk is what gets synthesised in ONE engine.speak() call. It carries the
 *  joined text plus the individual sentences (with ranges) so the player can
 *  still move the highlight within the chunk as it plays. */
export type Chunk = { text: string; sentences: Sentence[]; startIndex: number }

export type ChunkMode = 'sentence' | 'block'

/**
 * groupChunks turns the flat sentence list into synthesis chunks.
 *
 * - 'sentence': one chunk per sentence — for the system engine, whose synthesis
 *   is instant, so small units give the tightest highlighting + resume.
 * - 'block': roughly a paragraph per chunk (consecutive sentences, broken on a
 *   new block once the chunk is reasonably long, and hard-capped at maxChars).
 *   The neural engine reloads its model on every call, so synthesising a whole
 *   paragraph at once amortises that cost — and the player prefetches the next
 *   chunk while the current one plays, so there's no gap between paragraphs.
 */
export function groupChunks(
  sentences: Sentence[],
  mode: ChunkMode,
  { minChars = 180, maxChars = 500 }: { minChars?: number; maxChars?: number } = {},
): Chunk[] {
  if (mode === 'sentence') {
    return sentences.map((s, i) => ({ text: s.text, sentences: [s], startIndex: i }))
  }
  const chunks: Chunk[] = []
  let cur: Sentence[] = []
  let curStart = 0
  let curLen = 0
  const flush = () => {
    if (!cur.length) return
    chunks.push({ text: cur.map(s => s.text).join(' '), sentences: cur, startIndex: curStart })
    cur = []; curLen = 0
  }
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]
    if (cur.length) {
      const newBlock = cur[cur.length - 1].block !== s.block
      const tooBig = curLen + s.text.length > maxChars
      // Break at a paragraph boundary once we have enough to read, or whenever
      // the chunk would grow too large (splits a very long paragraph).
      if (tooBig || (newBlock && curLen >= minChars)) flush()
    }
    if (!cur.length) curStart = i
    cur.push(s)
    curLen += s.text.length + 1
  }
  flush()
  return chunks
}

/** Index of the chunk that contains the given flat sentence index (for resume). */
export function chunkIndexForSentence(chunks: Chunk[], sentenceIndex: number): number {
  for (let c = 0; c < chunks.length; c++) {
    const end = chunks[c].startIndex + chunks[c].sentences.length
    if (sentenceIndex < end) return c
  }
  return Math.max(0, chunks.length - 1)
}

// ---- TTS engine ----------------------------------------------------------

export type TtsVoice = { id: string; label: string; lang: string }
export type SpeakOpts = { voiceId?: string; rate: number; style?: string }
export type SpeakHandle = { cancel: () => void }

// Pages whose name/path mention "meditation" read slowly, with long pauses.
const MEDITATION_RE = /meditation/i

/**
 * ttsStyleForPath returns the synthesis style token for a page path: "meditation.v2"
 * (slow, big pauses) for meditation pages, else "v2" (normal voice with a gentle
 * inter-sentence pause). The ".v2" suffix is a synthesis REVISION — bump it (here
 * + in the backend styleFor) whenever the synthesised audio changes, so new clips
 * get fresh /tts URLs + cache keys instead of serving stale cached audio. Shared by
 * the player (ReadAloudBar) and the pre-synthesiser (vertonen) so their URLs match.
 */
export function ttsStyleForPath(path: string): string {
  return MEDITATION_RE.test(path) ? 'meditation.v2' : 'v2'
}

export interface TtsEngine {
  id: 'system' | 'neural'
  label: string
  /** How the player should group sentences per speak() call. Default 'sentence'. */
  chunking?: ChunkMode
  /** Voices that run ENTIRELY on-device (no network). */
  voices(): TtsVoice[]
  /** Speak `text`. onProgress (0..1) is optional and drives in-chunk highlight. */
  speak(
    text: string,
    opts: SpeakOpts,
    onEnd: () => void,
    onError: (msg: string) => void,
    onProgress?: (fraction: number) => void,
  ): SpeakHandle
  /** Optional: pre-synthesise upcoming chunk text so playback stays gapless. */
  prefetch?(text: string, opts: SpeakOpts): void
  /** Optional live playback-rate change without re-synthesising (server engine
   *  applies rate via the <audio> element). System engine bakes rate into the
   *  utterance, so it omits this and the player re-speaks the chunk instead. */
  setRate?(rate: number): void
  /** Optional in-place pause. If absent, the player cancels + restarts the chunk. */
  pause?(): void
  /** Optional in-place resume; returns true if it resumed where it left off.
   *  onFail is invoked if playback couldn't actually restart (e.g. autoplay
   *  blocked) so the player can park at paused rather than skip ahead. */
  resume?(onFail?: () => void): boolean
  cancelAll(): void
  /** Optional teardown: release the audio element + cached audio (neural). */
  dispose?(): void
}

/**
 * systemEngine wraps the browser's SpeechSynthesis but only ever exposes
 * `localService` voices, so the spoken text is synthesised on the device and
 * never sent to a cloud voice service.
 */
export function systemEngine(): TtsEngine | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null
  const synth = window.speechSynthesis
  const localVoices = () => synth.getVoices().filter(v => v.localService)
  return {
    id: 'system',
    label: 'System voice (on-device)',
    chunking: 'sentence',
    voices() {
      return localVoices().map(v => ({ id: v.voiceURI, label: v.name, lang: v.lang }))
    },
    speak(text, opts, onEnd, onError) {
      const u = new SpeechSynthesisUtterance(text)
      const v = localVoices().find(x => x.voiceURI === opts.voiceId)
      if (v) { u.voice = v; u.lang = v.lang }
      u.rate = opts.rate
      let done = false
      u.onend = () => { if (!done) { done = true; onEnd() } }
      u.onerror = (e) => { if (!done) { done = true; if (e.error !== 'interrupted' && e.error !== 'canceled') onError(String(e.error)); else onEnd() } }
      synth.speak(u)
      return { cancel: () => { done = true; synth.cancel() } }
    },
    cancelAll() { synth.cancel() },
  }
}

/** Resolve the list of available local engines. Neural (in-browser) slots in
 *  here as a follow-up without touching the orchestration. */
export function availableEngines(): TtsEngine[] {
  const out: TtsEngine[] = []
  const sys = systemEngine()
  if (sys) out.push(sys)
  return out
}

// ---- Persistence ---------------------------------------------------------

export type ReadPos = { file: string; sentence: number }

/** Maps a path to its opaque nodeId and back — encrypted spaces persist the
 *  read-aloud position by nodeId so no cleartext path lands in localStorage. */
export type PathCodec = { encode: (path: string) => string | undefined; decode: (id: string) => string | undefined }

export function loadReadPos(storageKey: string, codec?: PathCodec): ReadPos | null {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (typeof p?.file === 'string' && typeof p?.sentence === 'number') {
      if (!codec) return p
      const file = codec.decode(p.file) // stored as a nodeId → resolve to a path
      return file ? { file, sentence: p.sentence } : null
    }
  } catch { /* ignore */ }
  return null
}

export function saveReadPos(storageKey: string, pos: ReadPos | null, codec?: PathCodec) {
  try {
    if (!pos) { localStorage.removeItem(storageKey); return }
    let stored = pos
    if (codec) {
      const id = codec.encode(pos.file)
      if (!id) return // can't resolve → never persist a cleartext path
      stored = { file: id, sentence: pos.sentence }
    }
    localStorage.setItem(storageKey, JSON.stringify(stored))
  } catch { /* quota — non-fatal */ }
}
