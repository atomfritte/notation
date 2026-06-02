// Neural "studio voice" engine — Piper (German Thorsten, high quality) running
// ENTIRELY in the browser via @diffusionstudio/vits-web (ONNX/WASM). The model
// is downloaded + cached on first use; synthesis runs on-device, so the read
// text never leaves the machine. Because it produces a real audio stream it
// also keeps playing with the screen off and drives the MediaSession.
//
// Loaded lazily (the package + model are heavy) so users who never pick the
// studio voice pay nothing.

import type { VoiceId } from '@diffusionstudio/vits-web'
import type { TtsEngine, SpeakHandle, TtsVoice } from './readAloud'

export const NEURAL_VOICE: VoiceId = 'de_DE-thorsten-high'
const VOICE_LABEL = 'Thorsten · Deutsch (neural)'

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
  return {
    id: 'neural',
    label: 'Studio voice (German · on-device)',
    voices(): TtsVoice[] {
      return [{ id: NEURAL_VOICE, label: VOICE_LABEL, lang: 'de-DE' }]
    },
    speak(text, opts, onEnd, onError): SpeakHandle {
      let cancelled = false
      let url: string | null = null
      const cleanup = () => { if (url) { URL.revokeObjectURL(url); url = null } }
      loadVits()
        .then(vits => vits.predict({ text, voiceId: NEURAL_VOICE }))
        .then(blob => {
          if (cancelled) return
          url = URL.createObjectURL(blob)
          audio.onended = () => { cleanup(); if (!cancelled) onEnd() }
          audio.onerror = () => { cleanup(); if (!cancelled) onError('audio playback failed') }
          audio.src = url
          audio.playbackRate = opts.rate || 1
          audio.play().catch(() => { if (!cancelled) onError('autoplay blocked') })
        })
        .catch(e => { if (!cancelled) onError(String((e as Error)?.message ?? e)) })
      return { cancel: () => { cancelled = true; cleanup(); try { audio.pause() } catch { /* ignore */ } } }
    },
    cancelAll() { try { audio.pause() } catch { /* ignore */ } },
  }
}
