"""把摘要权重下载到 VIDEO_INGEST_SUMMARY_MODEL。下完并核对大小后才放入最终路径。"""

import os
import shutil
import subprocess
import sys

DEST = os.environ.get("VIDEO_INGEST_SUMMARY_MODEL", "")
EXPECTED_BYTES = 2497280736
FILENAME = "Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
REPO_ID = "bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF"


def file_ready(path):
    try:
        return os.path.isfile(path) and os.path.getsize(path) == EXPECTED_BYTES
    except OSError:
        return False


def main():
    print("summary model download started", flush=True)
    if not DEST:
        print("summary model path missing", flush=True)
        return 1
    if file_ready(DEST):
        print("summary model ready", flush=True)
        return 0
    parent = os.path.dirname(DEST) or "."
    stage = os.path.join(parent, ".fetch")
    os.makedirs(stage, exist_ok=True)
    partial = os.path.join(stage, FILENAME)
    endpoint = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")
    url = f"{endpoint}/{REPO_ID}/resolve/main/{FILENAME}"
    try:
        result = subprocess.run(
            [
                "curl",
                "-fL",
                "--retry",
                "5",
                "--retry-all-errors",
                "--retry-delay",
                "3",
                "-o",
                partial,
                url,
            ],
            check=False,
        )
        if result.returncode != 0 or not file_ready(partial):
            print(f"summary model download failed status {result.returncode}", flush=True)
            return 1
        os.replace(partial, DEST)
        if not file_ready(DEST):
            print("summary model download incomplete", flush=True)
            return 1
        print("summary model ready", flush=True)
        return 0
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("summary model download failed", flush=True)
        sys.exit(1)
