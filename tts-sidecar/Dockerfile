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
COPY app.py download_model.py ./
ENV KOKORO_MODELS_DIR=/models \
    KOKORO_HF_REPO=Godelaune/Kokoro-82M-ONNX-German-Martin \
    KOKORO_VOICE=martin \
    KOKORO_LANG=de
EXPOSE 8080
# Download the model on first start (skipped if /models already has one), then serve.
CMD ["sh", "-c", "python download_model.py && exec uvicorn app:app --host 0.0.0.0 --port 8080"]
