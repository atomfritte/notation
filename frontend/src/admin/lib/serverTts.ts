// Server-side "studio voice": the backend (Piper) synthesises each paragraph on
// the server CPU and streams a small Ogg/Opus clip from /tts. The browser just
// plays the URL — no in-browser model, no megabyte download, no main-thread
// freeze. Because the URLs are deterministic + immutable, the browser HTTP cache
// (and a future PWA service worker) cache them for free.
//
// The spoken text reaches only this app's own server (same origin); Piper runs
// locally in the container — it is never sent to a third party.

import type { TtsEngine, SpeakHandle, TtsVoice } from './readAloud'

export type ServerVoice = { id: string; label: string; lang: string }

// The backend caps a chunk at 4000 chars. Chunks are paragraph-sized, but a
// run-on "sentence" with no punctuation could exceed it — cap here (at a word
// boundary) so it degrades to a slightly-shortened read instead of failing. Both
// speak() and prefetch() apply it so the cached URL matches.
const MAX_TTS_CHARS = 3500
function capText(text: string): string {
  if (text.length <= MAX_TTS_CHARS) return text
  const cut = text.slice(0, MAX_TTS_CHARS)
  const sp = cut.lastIndexOf(' ')
  return (sp > MAX_TTS_CHARS * 0.6 ? cut.slice(0, sp) : cut) + '…'
}

/**
 * createServerEngine builds the studio engine. `ttsURL(voiceId, text)` is
 * provided by the host because the admin and share SPAs address the endpoint
 * differently (session vs share token).
 */
export function createServerEngine(
  voices: ServerVoice[],
  ttsURL: (voiceId: string, text: string, style?: string) => string,
): TtsEngine {
  const audio = new Audio()
  audio.preload = 'auto'
  // Keep pitch natural when the user speeds the reading up/down.
  try { (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true } catch { /* ignore */ }
  const detach = () => { try { audio.removeAttribute('src'); audio.load() } catch { /* ignore */ } }

  return {
    id: 'neural', // occupies the "Studio voice" slot in the player
    label: 'Studio voice (server)',
    chunking: 'block',
    voices(): TtsVoice[] {
      return voices.map(v => ({ id: v.id, label: v.label, lang: v.lang }))
    },
    prefetch(text, opts) {
      if (text && text.trim()) {
        // Warm the server + browser caches so the next clip plays instantly.
        void fetch(ttsURL(opts.voiceId || '', capText(text), opts.style), { credentials: 'same-origin' }).catch(() => { /* surfaced on speak */ })
      }
    },
    speak(text, opts, onEnd, onError, onProgress): SpeakHandle {
      let cancelled = false
      const cleanup = () => { audio.ontimeupdate = null; audio.onended = null; audio.onerror = null }
      audio.onended = () => { cleanup(); if (!cancelled) onEnd() }
      audio.onerror = () => { cleanup(); if (!cancelled) onError('audio failed to load') }
      if (onProgress) {
        audio.ontimeupdate = () => {
          const d = audio.duration
          if (d && isFinite(d)) onProgress(Math.min(1, audio.currentTime / d))
        }
      }
      audio.src = ttsURL(opts.voiceId || '', capText(text), opts.style)
      audio.playbackRate = opts.rate || 1
      audio.play().catch(() => { if (!cancelled) onError('autoplay blocked') })
      return { cancel: () => { cancelled = true; cleanup(); try { audio.pause() } catch { /* ignore */ } } }
    },
    // In-place pause/resume: the <audio> element holds its position.
    pause() { try { audio.pause() } catch { /* ignore */ } },
    resume(onFail) {
      if (audio.ended || !audio.src) return false
      audio.play().catch(() => onFail?.())
      return true
    },
    cancelAll() { try { audio.pause() } catch { /* ignore */ }; detach() },
    dispose() { try { audio.pause() } catch { /* ignore */ }; detach() },
  }
}
