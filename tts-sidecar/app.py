"""
notation Kokoro TTS sidecar.

A tiny HTTP service that wraps Kokoro (a fast, CPU-only neural TTS) so the Go
backend can offer a higher-quality German "studio voice" without pulling Python
+ PyTorch into the main image. It runs Kokoro via ONNX Runtime (no torch).

Contract (the Go side in internal/tts/runKokoro expects exactly this):
    GET  /health                         -> 200 {"ok": true}
    POST /synthesize  {voice, text, speed}
         -> 200, body = raw 16-bit signed little-endian MONO PCM at 24 kHz
            (the backend pipes this straight into opusenc, same as Piper output)

You must supply a GERMAN Kokoro model — base Kokoro has no German voice.
Recommended: Godelaune/Kokoro-82M-ONNX-German-Martin (Apache-2.0) or
semidark/kokoro-deutsch. Mount the .onnx + voices file into /models and set the
env vars below (and the internal voice name in VOICE_MAP). See README.md.
"""

import os

import numpy as np
from fastapi import FastAPI, Response
from pydantic import BaseModel

MODEL = os.environ.get("KOKORO_MODEL", "/models/kokoro.onnx")
VOICES = os.environ.get("KOKORO_VOICES", "/models/voices.bin")
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "martin")
DEFAULT_LANG = os.environ.get("KOKORO_LANG", "de")
TARGET_RATE = 24000  # the backend assumes 24 kHz (kokoroRate); keep in sync

# Map the ids the app advertises (NOTATION_TTS_KOKORO_VOICES) → the internal
# Kokoro voice name your model ships. Adjust to your model.
VOICE_MAP = {
    "de_DE-martin-kokoro": DEFAULT_VOICE,
}

# Lazy import so the container at least starts (and /health can report) even if
# kokoro-onnx / the model isn't set up yet.
_kokoro = None


def kokoro():
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro  # type: ignore

        _kokoro = Kokoro(MODEL, VOICES)
    return _kokoro


app = FastAPI()


class SynthReq(BaseModel):
    voice: str = ""
    text: str
    speed: float = 1.0


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/synthesize")
def synthesize(req: SynthReq):
    voice = VOICE_MAP.get(req.voice, DEFAULT_VOICE)
    speed = max(0.5, min(2.0, req.speed or 1.0))
    samples, rate = kokoro().create(req.text, voice=voice, speed=speed, lang=DEFAULT_LANG)
    pcm = np.asarray(samples, dtype=np.float32)
    if rate != TARGET_RATE:
        # Linear resample to the rate the backend expects.
        n = int(round(len(pcm) * TARGET_RATE / rate))
        pcm = np.interp(np.linspace(0, len(pcm), n, endpoint=False), np.arange(len(pcm)), pcm).astype(np.float32)
    pcm = np.clip(pcm, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2").tobytes()
    return Response(content=pcm16, media_type="application/octet-stream")
