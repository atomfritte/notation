# syntax=docker/dockerfile:1

# --- Stage 1: build the React frontend --------------------------------------
FROM node:26-alpine AS frontend
WORKDIR /work/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- Stage 2: build the Go binary with embedded frontend --------------------
FROM golang:1.26-alpine AS backend
RUN apk add --no-cache git
WORKDIR /work
COPY backend/go.mod backend/go.sum* ./backend/
RUN cd backend && go mod download
COPY backend/ ./backend/
# Overlay the built frontend into the embed path before compiling.
COPY --from=frontend /work/backend/web/dist ./backend/web/dist
RUN cd backend \
 && go mod tidy \
 && CGO_ENABLED=0 GOOS=linux go build \
      -trimpath -ldflags="-s -w" \
      -o /out/notation \
      ./cmd/notation

# --- Stage 3: fetch Piper (server-side neural TTS) + voice models -----------
# Piper runs the read-aloud "studio voice" on the server CPU (no GPU). Voices
# are auto-discovered from /opt/piper/models, so override TTS_VOICES (or mount
# more *.onnx + *.onnx.json) to add languages/voices. Model paths on HuggingFace
# are derived from each voice key (locale-name-quality).
FROM alpine:3.23 AS piper
ARG TARGETARCH
ARG PIPER_VERSION=2023.11.14-2
ARG TTS_VOICES="de_DE-thorsten-high en_US-lessac-medium"
RUN apk add --no-cache curl tar
WORKDIR /opt
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      ""|amd64) P=x86_64 ;; \
      arm64)    P=aarch64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${P}.tar.gz" -o piper.tgz; \
    tar -xzf piper.tgz; \
    rm piper.tgz
RUN set -eux; \
    mkdir -p /opt/piper/models; \
    base="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0"; \
    for key in ${TTS_VOICES}; do \
      locale="${key%%-*}"; rest="${key#*-}"; name="${rest%-*}"; quality="${rest##*-}"; \
      lang="$(printf '%s' "$locale" | cut -c1-2 | tr 'A-Z' 'a-z')"; \
      url="${base}/${lang}/${locale}/${name}/${quality}/${key}"; \
      curl -fsSL "${url}.onnx"      -o "/opt/piper/models/${key}.onnx"; \
      curl -fsSL "${url}.onnx.json" -o "/opt/piper/models/${key}.onnx.json"; \
    done

# --- Stage 4: minimal runtime -----------------------------------------------
# Debian (glibc) so the prebuilt Piper binary runs; opus-tools provides opusenc
# for encoding the synthesised audio to small Ogg/Opus clips.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git tini opus-tools libstdc++6 libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -r notation && useradd -r -g notation -u 10001 -d /app notation \
 && mkdir -p /data/tts-cache && chown -R notation:notation /data && chmod 750 /data/tts-cache
WORKDIR /app
COPY --from=backend /out/notation /app/notation
COPY --from=piper /opt/piper /opt/piper
USER notation
ENV NOTATION_BIND=:8080 \
    NOTATION_DATA_DIR=/data \
    NOTATION_SHARE_PATH=/s \
    NOTATION_MCP_PATH=/mcp \
    NOTATION_TTS_PIPER_BIN=/opt/piper/piper \
    NOTATION_TTS_MODEL_DIR=/opt/piper/models \
    NOTATION_TTS_ESPEAK_DATA=/opt/piper/espeak-ng-data \
    LD_LIBRARY_PATH=/opt/piper
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/app/notation"]
