# syntax=docker/dockerfile:1

# --- Stage 1: build the React frontend --------------------------------------
FROM node:20-alpine AS frontend
WORKDIR /work/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- Stage 2: build the Go binary with embedded frontend --------------------
FROM golang:1.22-alpine AS backend
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

# --- Stage 3: minimal runtime -----------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates git tini \
 && addgroup -S notation && adduser -S -G notation -u 10001 notation \
 && mkdir -p /data && chown notation:notation /data
WORKDIR /app
COPY --from=backend /out/notation /app/notation
USER notation
ENV NOTATION_BIND=:8080 \
    NOTATION_DATA_DIR=/data \
    NOTATION_SHARE_PATH=/s \
    NOTATION_MCP_PATH=/mcp
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--", "/app/notation"]
