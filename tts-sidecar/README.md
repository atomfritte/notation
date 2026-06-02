# notation Kokoro TTS sidecar (optional, higher-quality German voice)

The main app's read-aloud uses Piper by default (fast, decent). This sidecar adds
**Kokoro** — clearly nicer German, still CPU-only and real-time-capable, Apache-2.0.
It's **opt-in**: the backend talks to it only when `NOTATION_TTS_KOKORO_URL` is set,
and if it's down the app silently falls back to Piper.

## 1. Get a German Kokoro model
Base Kokoro has **no** German voice — use a German fine-tune/export, e.g.:
- `Godelaune/Kokoro-82M-ONNX-German-Martin` (single male voice "Martin")
- `semidark/kokoro-deutsch`

Download its `.onnx` + voices file into `./kokoro-models/` as `kokoro.onnx` +
`voices.bin` (or set `KOKORO_MODEL` / `KOKORO_VOICES`). Set the internal voice
name in `app.py`'s `VOICE_MAP` / `KOKORO_VOICE` to match the model.

## 2. Run it
Either via the bundled `docker-compose.example.yml` (a `kokoro` service is wired
up), or standalone:

```sh
docker build -t notation-kokoro ./tts-sidecar
docker run -p 8881:8080 -v $PWD/kokoro-models:/models notation-kokoro
```

Then point the app at it:
```
NOTATION_TTS_KOKORO_URL=http://kokoro:8080
NOTATION_TTS_KOKORO_VOICES=de_DE-martin-kokoro   # appears in the voice picker
```

## Contract
`POST /synthesize {voice,text,speed}` → raw 16-bit LE mono PCM @ 24 kHz; the
backend encodes it to Ogg/Opus (same path as Piper) and caches it. `GET /health`
→ 200. This is a **reference** sidecar — adjust `app.py` to your chosen model's
kokoro-onnx loading/voice names.
