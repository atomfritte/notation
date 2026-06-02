// Neural "studio voice" engine — Piper (German Thorsten, high quality) running
// ENTIRELY in the browser via @diffusionstudio/vits-web (ONNX/WASM). The model
// is downloaded + cached on first use; synthesis runs on-device, so the read
// text never leaves the machine. Because it produces a real audio stream it
// also keeps playing with the screen off and drives the MediaSession.
//
// Cost model (important): vits-web's predict() reloads the model + rebuilds an
// ONNX InferenceSession on EVERY call, so the per-call overhead is large and
// roughly fixed regardless of text length. The player therefore feeds us whole
// paragraphs (chunking: 'block') to amortise that cost, and PREFETCHES the next
// paragraph while the current one plays — synthesis is cached so the handoff is
// gapless. Loaded lazily so users who never pick the studio voice pay nothing.

import type { VoiceId } from '@diffusionstudio/vits-web'
import type { TtsEngine, SpeakHandle, TtsVoice } from './readAloud'

export const NEURAL_VOICE: VoiceId = 'de_DE-thorsten-high'
const VOICE_LABEL = 'Thorsten · Deutsch (neural)'
const MAX_CACHE = 4 // paragraph WAVs are a few MB each; keep a small ring

type VitsModule = typeof import('@diffusionstudio/vits-web')
let vitsPromise: Promise<VitsModule> | null = null
function loadVits(): Promise<VitsModule> {
  if (!vitsPromise) vitsPromise = import('@diffusionstudio/vits-web')
  return vitsPromise
}

/** Whether the German voice model is already downloaded + cached on this device. */
export async function neuralModelReady(): Promise<boolean> {
  try {
    const vits = await loadVits()
    return (await vits.stored()).includes(NEURAL_VOICE)
  } catch {
    return false
  }
}

/** Download + cache the voice model, reporting 0–100% progress. */
export async function downloadNeuralModel(onProgress: (pct: number) => void): Promise<void> {
  const vits = await loadVits()
  await vits.download(NEURAL_VOICE, p => {
    if (p.total > 0) onProgress(Math.min(100, Math.round((p.loaded / p.total) * 100)))
  })
}

/**
 * createNeuralEngine builds the TtsEngine. The model must already be downloaded
 * (see neuralModelReady / downloadNeuralModel). Audio plays through a single
 * <Audio> element so playback survives the screen turning off.
 */
export function createNeuralEngine(): TtsEngine {
  const audio = new Audio()
  audio.preload = 'auto'

  // text -> Promise<WAV Blob>. prefetch() fills this so speak() plays instantly.
  const cache = new Map<string, Promise<Blob>>()
  // Serialise synthesis: predict() reloads the model each call, so running two
  // at once just slows the one we need now. A promise chain orders them.
  let queue: Promise<unknown> = Promise.resolve()
  // Synthesis is async (seconds on a cold start). If the user pauses while a
  // chunk is still synthesising, this flag stops it from auto-playing when the
  // blob finally arrives.
  let paused = false
  const detachSource = () => { try { audio.removeAttribute('src'); audio.load() } catch { /* ignore */ } }

  function synth(text: string): Promise<Blob> {
    const key = text.trim()
    const hit = cache.get(key)
    if (hit) return hit
    const p = queue.then(() => loadVits().then(vits => vits.predict({ text: key, voiceId: NEURAL_VOICE })))
    queue = p.catch(() => undefined) // a failure must not break the chain
    cache.set(key, p)
    // Evict oldest (Map keeps insertion order), but never the entry we just added.
    while (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value
      if (oldest === undefined || oldest === key) break
      cache.delete(oldest)
    }
    return p
  }

  return {
    id: 'neural',
    label: 'Studio voice (German · on-device)',
    chunking: 'block',
    voices(): TtsVoice[] {
      return [{ id: NEURAL_VOICE, label: VOICE_LABEL, lang: 'de-DE' }]
    },
    prefetch(text) {
      if (text && text.trim()) void synth(text).catch(() => { /* surfaced on speak */ })
    },
    speak(text, opts, onEnd, onError, onProgress): SpeakHandle {
      paused = false
      let cancelled = false
      let url: string | null = null
      const cleanup = () => {
        if (url) { URL.revokeObjectURL(url); url = null }
        audio.ontimeupdate = null
        audio.onended = null
        audio.onerror = null
      }
      synth(text).then(blob => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        audio.onended = () => { cleanup(); if (!cancelled) onEnd() }
        audio.onerror = () => { cleanup(); if (!cancelled) onError('audio playback failed') }
        if (onProgress) {
          audio.ontimeupdate = () => {
            const d = audio.duration
            if (d && isFinite(d)) onProgress(Math.min(1, audio.currentTime / d))
          }
        }
        audio.src = url
        audio.playbackRate = opts.rate || 1
        // If the user paused while this was synthesising, hold here — resume()
        // will start playback from the loaded source.
        if (!paused) audio.play().catch(() => { if (!cancelled) onError('autoplay blocked') })
      }).catch(e => { if (!cancelled) onError(String((e as Error)?.message ?? e)) })
      return { cancel: () => { cancelled = true; cleanup(); try { audio.pause() } catch { /* ignore */ } } }
    },
    // In-place pause/resume: the <audio> element holds its position, so resuming
    // a long paragraph continues from where it stopped rather than restarting.
    pause() { paused = true; try { audio.pause() } catch { /* ignore */ } },
    resume(onFail) {
      paused = false
      if (audio.ended || !audio.src) return false // still synthesising → player restarts the chunk
      // If play() rejects (e.g. autoplay blocked from a lock-screen 'play' with no
      // fresh gesture), park at paused via onFail — never skip ahead.
      audio.play().catch(() => onFail?.())
      return true
    },
    cancelAll() { paused = false; try { audio.pause() } catch { /* ignore */ }; detachSource() },
    dispose() {
      paused = false
      try { audio.pause() } catch { /* ignore */ }
      detachSource()
      cache.clear()
    },
  }
}
