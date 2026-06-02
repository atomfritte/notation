"""
notation Kokoro TTS sidecar.

A tiny HTTP service that wraps Kokoro (a fast, CPU-only neural TTS) so the Go
backend can offer a higher-quality German "studio voice" without pulling Python
+ PyTorch into the main image. It runs Kokoro via ONNX Runtime (no torch).

Contract (the Go side in internal/tts/runKokoro expects exactly this):
    GET  /health                         -> 200 {"ok": true}
    POST /synthesize  {voice, text, speed, sentence_silence}
         -> 200, body = raw 16-bit signed little-endian MONO PCM at 24 kHz
            (the backend pipes this straight into opusenc, same as Piper output)
    sentence_silence (seconds) inserts a pause between sentences — Kokoro renders a
    paragraph as one continuous utterance otherwise, so without this it never
    breathes. Piper does this natively via --sentence_silence; this mirrors it.

You must supply a GERMAN Kokoro model — base Kokoro has no German voice.
Recommended: Godelaune/Kokoro-82M-ONNX-German-Martin (Apache-2.0) or
semidark/kokoro-deutsch. Mount the .onnx + voices file into /models and set the
env vars below (and the internal voice name in VOICE_MAP). See README.md.
"""

import glob
import os
import re

import numpy as np
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel

# Sentence splitter — kept in sync with the frontend's extractSentences regex
# (frontend/src/admin/lib/readAloud.ts) so the pauses land at the same boundaries
# the reader highlights.
_SENT_RE = re.compile(r"[^.!?…]*[.!?…]+[\"')\]]*\s*|[^.!?…]+$")

MODELS_DIR = os.environ.get("KOKORO_MODELS_DIR", "/models")
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "martin")
DEFAULT_LANG = os.environ.get("KOKORO_LANG", "de")
TARGET_RATE = 24000  # the backend assumes 24 kHz (kokoroRate); keep in sync

# Map the ids the app advertises (NOTATION_TTS_KOKORO_VOICES) → the internal
# Kokoro voice name your model ships. Adjust to your model.
VOICE_MAP = {
    "de_DE-martin-kokoro": DEFAULT_VOICE,
}


def _find(*globs):
    for g in globs:
        m = sorted(glob.glob(os.path.join(MODELS_DIR, g)))
        if m:
            return m[0]
    return None


# Lazy init so the container starts (and /health works) even before the model is
# downloaded; the model + voices files are auto-detected in the models dir.
_kokoro = None


def kokoro():
    global _kokoro
    if _kokoro is None:
        model = _find("*.onnx")
        voices = _find("*voices*", "*.bin", "*.npz", "voices*.json")
        if not model or not voices:
            raise HTTPException(status_code=503, detail=f"no Kokoro model/voices in {MODELS_DIR}")
        from kokoro_onnx import Kokoro  # type: ignore

        _kokoro = Kokoro(model, voices)
    return _kokoro


app = FastAPI()


class SynthReq(BaseModel):
    voice: str = ""
    text: str
    speed: float = 1.0
    sentence_silence: float = 0.0  # seconds of silence inserted between sentences


@app.get("/health")
def health():
    return {"ok": True}


def _synth_float(text: str, voice: str, speed: float) -> np.ndarray:
    """Synthesise one piece of text → float32 mono PCM at TARGET_RATE."""
    samples, rate = kokoro().create(text, voice=voice, speed=speed, lang=DEFAULT_LANG)
    pcm = np.asarray(samples, dtype=np.float32)
    if rate != TARGET_RATE:
        # Linear resample to the rate the backend expects.
        n = int(round(len(pcm) * TARGET_RATE / rate))
        pcm = np.interp(np.linspace(0, len(pcm), n, endpoint=False), np.arange(len(pcm)), pcm).astype(np.float32)
    return pcm


@app.post("/synthesize")
def synthesize(req: SynthReq):
    voice = VOICE_MAP.get(req.voice, DEFAULT_VOICE)
    speed = max(0.5, min(2.0, req.speed or 1.0))
    sil = max(0.0, min(3.0, req.sentence_silence or 0.0))

    # Split into sentences and pad each with silence so the speech breathes;
    # Kokoro renders a whole paragraph as one continuous utterance otherwise. Only
    # fragments with an actual word char are spoken — lone punctuation / quote marks
    # ("”", "...") would otherwise be fed to the model as their own utterance, which
    # can choke its phonemizer. A fragment that still fails is skipped, not fatal.
    parts = [p.strip() for p in _SENT_RE.findall(req.text)] if sil > 0 else []
    parts = [p for p in parts if re.search(r"\w", p, re.UNICODE)]
    if len(parts) > 1:
        gap = np.zeros(int(TARGET_RATE * sil), dtype=np.float32)
        chunks = []
        for sent in parts:
            try:
                voiced = _synth_float(sent, voice, speed)
            except Exception:
                continue  # skip a fragment the model can't render rather than 500 the whole chunk
            if chunks:
                chunks.append(gap)
            chunks.append(voiced)
        pcm = np.concatenate(chunks) if chunks else _synth_float(req.text, voice, speed)
    else:
        pcm = _synth_float(req.text, voice, speed)

    pcm = np.clip(pcm, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2").tobytes()
    return Response(content=pcm16, media_type="application/octet-stream")
