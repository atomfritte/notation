# notation Kokoro TTS sidecar — higher-quality German read-aloud voice (CPU-only,
# ONNX Runtime, no PyTorch). Opt-in: the main app uses it only when
# NOTATION_TTS_KOKORO_URL points here; otherwise it falls back to Piper.
FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends espeak-ng \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
# Supply a GERMAN Kokoro model at /models (see README) — mount it or bake it in.
ENV KOKORO_MODEL=/models/kokoro.onnx \
    KOKORO_VOICES=/models/voices.bin \
    KOKORO_VOICE=martin \
    KOKORO_LANG=de
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
