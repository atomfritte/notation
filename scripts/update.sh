#!/usr/bin/env bash
#
# update.sh — rebuild + restart the notation containers from the current source.
#
# The frontend (npm run build) and the Go binary (go build, with the frontend
# embedded) are compiled INSIDE the Dockerfile, so rebuilding the image is a full
# recompile. This pulls the latest code (unless --no-pull), rebuilds the image(s),
# recreates the container(s), and prunes dangling images. Your data volume and the
# downloaded Kokoro model (./kokoro-models) are left untouched.
#
# Usage:
#   ./scripts/update.sh                # pull, rebuild everything, restart
#   ./scripts/update.sh notation       # only the app (skip the kokoro sidecar)
#   ./scripts/update.sh --no-pull      # rebuild the current checkout (no git pull)
#   ./scripts/update.sh --no-cache     # force a clean rebuild (ignore layer cache)
#
set -euo pipefail

# Always run from the repo root (where docker-compose.yml lives), whatever the cwd.
cd "$(dirname "$0")/.."

PULL=1
BUILD_ARGS=()
SERVICES=()
for arg in "$@"; do
  case "$arg" in
    --no-pull)  PULL=0 ;;
    --no-cache) BUILD_ARGS+=(--no-cache) ;;
    -h|--help)  sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*)        echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
    *)          SERVICES+=("$arg") ;;
  esac
done

# Prefer docker compose v2 (plugin); fall back to the legacy docker-compose binary.
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "error: neither 'docker compose' nor 'docker-compose' is installed" >&2
  exit 1
fi

if [ "$PULL" -eq 1 ] && [ -d .git ]; then
  echo "==> git pull --ff-only"
  git pull --ff-only
fi

echo "==> building image(s) ${SERVICES[*]:-(all)}"
"${DC[@]}" build "${BUILD_ARGS[@]}" "${SERVICES[@]}"

echo "==> (re)creating container(s)"
"${DC[@]}" up -d "${SERVICES[@]}"

echo "==> pruning dangling images"
docker image prune -f >/dev/null || true

echo "==> status"
"${DC[@]}" ps

echo
echo "Done. Follow logs with:  ${DC[*]} logs -f --tail=50 ${SERVICES[*]:-notation}"
