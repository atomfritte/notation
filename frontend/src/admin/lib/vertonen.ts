// "Vertonen" (pre-synthesise) — generate + cache the read-aloud audio for whole
// pages without the user opening + playing them, so a synced space can be heard
// in airplane mode. For each page we reproduce the player's exact chunks
// (chunksFromMarkdown → groupChunks 'block') and fetch each /tts URL; the service
// worker caches those clips (cache-first on /tts, see public/sw.js), so the next
// time the player requests the byte-identical URL it's served from cache offline.
//
// The spoken text only ever reaches this app's own server (Piper runs locally in
// the container) — never a third party. Shared by the in-space "prepare audio"
// panel and the space-manager "include voice" offline option.

import * as api from './api'
import { chunksFromMarkdown } from './markdownChunks'
import { capText } from './serverTts'

// Same trigger the player uses (ReadAloudBar): a page whose PATH contains
// "meditation" is voiced in the slow, emphasised meditation style. The style is
// part of the cache key, so it must match the player's URL exactly.
const MEDITATION_RE = /meditation/i

const PER_PAGE_CONCURRENCY = 3

/**
 * defaultVoice picks the studio voice the read-aloud player would default to
 * (ReadAloudBar's neural path): the saved voice if it's a valid server voice,
 * else one matching the document language, else the first. Used by BOTH the
 * in-space panel and the space-manager so the pre-generated URLs match playback.
 */
export function defaultVoice(voices: api.ServerVoice[]): string {
  const saved = (() => { try { return localStorage.getItem('notation_readaloud_voice') || '' } catch { return '' } })()
  if (voices.some(v => v.id === saved)) return saved
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase()
  return voices.find(v => v.lang.toLowerCase().startsWith(lang))?.id ?? voices[0]?.id ?? ''
}

/** All directory paths (excluding form folders) — the folder picker's options. */
export function folderList(tree: api.Entry[]): string[] {
  const out: string[] = []
  const walk = (entries: api.Entry[]) => {
    for (const e of entries) {
      if (e.is_dir && !e.form) {
        out.push(e.path)
        if (e.children) walk(e.children)
      }
    }
  }
  walk(tree)
  return out.sort((a, b) => a.localeCompare(b))
}

/**
 * markdownPagesUnder returns every markdown page at or below `folder` (recursing
 * into all subfolders, skipping form folders). folder === '' means the whole
 * space.
 */
export function markdownPagesUnder(tree: api.Entry[], folder: string): string[] {
  const all: string[] = []
  const walk = (entries: api.Entry[]) => {
    for (const e of entries) {
      if (e.is_dir) {
        if (!e.form && e.children) walk(e.children)
      } else if (e.path.toLowerCase().endsWith('.md')) {
        all.push(e.path)
      }
    }
  }
  walk(tree)
  if (!folder) return all
  const prefix = folder.endsWith('/') ? folder : folder + '/'
  return all.filter(p => p.startsWith(prefix))
}

export type VertonenProgress = {
  /** Pages fully processed so far. */ done: number
  /** Total pages to process. */ total: number
  /** Path currently being voiced (for the UI). */ current: string
  /** Audio clips successfully cached so far. */ clips: number
}

export type VertonenResult = {
  pages: number
  clips: number
  /** Individual /tts clips that failed to fetch. */ clipFailed: number
  /** Pages that failed to load/render entirely. */ pageFailed: number
  /** Pages with no readable prose (nothing to voice). */ emptyPages: number
  cancelled: boolean
}

/** A mutable flag the caller flips to abort between pages/chunks. */
export type Cancel = { cancelled: boolean }

// Per-space audio cache name — must match sw.js's derivation for
// /api/admin/spaces/<id>/tts. Audio is isolated per space (never a shared
// cache), so it's removed with the space and can't be served for another. We
// peek it to skip clips already cached, so re-runs don't re-hit Piper.
const audioCacheFor = (spaceID: string) => `notation-audio-${spaceID}`

/**
 * vertonenPages synthesises + caches the audio for each page. Pages are voiced
 * sequentially (renderToStaticMarkup is main-thread + CPU-heavy, and we yield
 * between pages to keep the UI responsive); chunks within a page fetch in small
 * parallel batches. A page that fails to render/fetch is skipped, never aborting
 * the run. Returns counts for the summary.
 */
export async function vertonenPages(
  spaceID: string,
  paths: string[],
  voiceId: string,
  onProgress?: (p: VertonenProgress) => void,
  cancel?: Cancel,
  // cacheOnly: send X-TTS-Cache-Only so the server returns only ALREADY-synthesised
  // clips (404 otherwise, counted as skipped not failed). The URL stays identical
  // to the player's, so a served clip caches under the key the player requests.
  // Used by the space-manager "include voice" option — it pulls existing audio
  // without triggering synthesis (that's the in-space manager's job).
  cacheOnly = false,
): Promise<VertonenResult> {
  // Ask the browser to make the origin's storage persistent so a big batch of
  // audio doesn't get evicted (and doesn't pressure the shell/offline caches).
  try { await navigator.storage?.persist?.() } catch { /* best-effort */ }
  const audioCache = typeof caches !== 'undefined'
    ? await caches.open(audioCacheFor(spaceID)).catch(() => null)
    : null

  let clips = 0
  let clipFailed = 0
  let pageFailed = 0
  let emptyPages = 0
  const result = (pages: number, cancelled: boolean): VertonenResult =>
    ({ pages, clips, clipFailed, pageFailed, emptyPages, cancelled })
  const emit = (done: number, current: string) =>
    onProgress?.({ done, total: paths.length, current, clips })
  emit(0, paths[0] ?? '')

  for (let i = 0; i < paths.length; i++) {
    if (cancel?.cancelled) return result(i, true)
    const path = paths[i]
    emit(i, path)
    let texts: string[] | null
    try {
      const { content } = await api.readFile(spaceID, path)
      texts = await chunksFromMarkdown(content)
    } catch {
      pageFailed++
      continue
    }
    if (texts === null) { pageFailed++; continue } // render threw
    if (texts.length === 0) { emptyPages++; continue } // nothing readable to voice
    const style = MEDITATION_RE.test(path) ? 'meditation' : ''
    for (let j = 0; j < texts.length; j += PER_PAGE_CONCURRENCY) {
      if (cancel?.cancelled) return result(i, true)
      const batch = texts.slice(j, j + PER_PAGE_CONCURRENCY)
      await Promise.all(batch.map(async (t) => {
        if (cancel?.cancelled) return // tighten Stoppen: skip not-yet-started fetches
        const text = capText(t)
        if (!text.trim()) return
        const url = api.ttsURL(spaceID, voiceId, text, style)
        // Already cached as a full clip (prior run/playback) → nothing to do; bounds
        // re-runs. Only a 200 counts — a stale 206 (from before the SW range fix)
        // must be re-fetched so it gets overwritten with a complete body.
        if (audioCache) {
          const hit = await audioCache.match(url)
          if (hit && hit.status === 200) { clips++; return }
        }
        try {
          // GET the same URL the player will request → SW caches it (cache-first
          // on /tts). We read the body so the fetch fully completes before the
          // SW stores it.
          const r = await fetch(url, {
            credentials: 'same-origin',
            headers: cacheOnly ? { 'X-TTS-Cache-Only': '1' } : undefined,
          })
          if (r.ok) { await r.arrayBuffer(); clips++ }
          else if (cacheOnly && r.status === 404) { /* not prepared yet — skip */ }
          else { clipFailed++ }
        } catch {
          clipFailed++
        }
      }))
      emit(i, path)
    }
    // Yield so the main thread can paint progress between heavy pages.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  emit(paths.length, '')
  return result(paths.length, false)
}
