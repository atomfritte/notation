"""
Download the Kokoro German model into the models dir on first start — unless
it's already there. Run by the container entrypoint before the server starts.

It introspects the configured HuggingFace repo and grabs the model (*.onnx) plus
any voices file, so it adapts to whatever the repo is named. If you'd rather
supply the model yourself, just drop the files into ./kokoro-models on the host
(mounted at /models) and this becomes a no-op.
"""

import glob
import os
import sys

MODELS_DIR = os.environ.get("KOKORO_MODELS_DIR", "/models")
REPO = os.environ.get("KOKORO_HF_REPO", "Godelaune/Kokoro-82M-ONNX-German-Martin")


def have_model() -> bool:
    return bool(glob.glob(os.path.join(MODELS_DIR, "*.onnx")))


def main() -> None:
    os.makedirs(MODELS_DIR, exist_ok=True)
    if have_model():
        print(f"[kokoro] model already present in {MODELS_DIR} — skipping download", flush=True)
        return
    if not REPO:
        print("[kokoro] no KOKORO_HF_REPO and no local model — Kokoro will be unavailable", flush=True)
        return
    try:
        from huggingface_hub import hf_hub_download, list_repo_files
    except Exception as e:  # pragma: no cover
        print(f"[kokoro] huggingface_hub missing: {e}", flush=True)
        return
    print(f"[kokoro] downloading model from {REPO} into {MODELS_DIR} …", flush=True)
    try:
        files = list_repo_files(REPO)
    except Exception as e:
        print(f"[kokoro] could not list {REPO}: {e}", flush=True)
        return
    onnx = [f for f in files if f.endswith(".onnx")]
    voices = [f for f in files if ("voice" in f.lower()) or f.endswith((".bin", ".npz")) or f == "voices.json"]
    wanted = onnx[:1] + voices
    if not wanted:
        print(f"[kokoro] no .onnx found in {REPO}", flush=True)
        return
    for f in wanted:
        try:
            hf_hub_download(REPO, f, local_dir=MODELS_DIR)
            print(f"[kokoro]   ✓ {f}", flush=True)
        except Exception as e:
            print(f"[kokoro]   ✗ {f}: {e}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never block startup — sidecar just stays unavailable
        print(f"[kokoro] download error: {e}", file=sys.stderr, flush=True)
