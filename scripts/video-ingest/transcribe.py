#!/usr/bin/env python3

import argparse
import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path

try:
    from faster_whisper import WhisperModel
except ModuleNotFoundError:
    WhisperModel = None


SENTENCE_PATTERN = re.compile(r"[^。！？；]*[。！？；]|[^。！？；]+$")


def _value(segment, name):
    if isinstance(segment, dict):
        return segment.get(name)
    return getattr(segment, name, None)


def _split_text(text):
    if len(text) <= 80:
        return [text]
    return [part.strip() for part in SENTENCE_PATTERN.findall(text) if part.strip()]


def normalize_segments(raw, duration_sec):
    duration = float(duration_sec)
    if not math.isfinite(duration) or duration <= 0:
        return []

    normalized = []
    for segment in raw:
        text = str(_value(segment, "text") or "").strip()
        if not text:
            continue

        try:
            start = float(_value(segment, "start"))
            end = float(_value(segment, "end"))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(start) or not math.isfinite(end):
            continue

        start = min(max(start, 0.0), duration)
        end = min(max(end, 0.0), duration)
        if end <= start:
            continue

        parts = _split_text(text)
        total_chars = sum(len(part) for part in parts)
        part_start = start
        consumed_chars = 0
        for index, part in enumerate(parts):
            consumed_chars += len(part)
            part_end = (
                end
                if index == len(parts) - 1
                else start + (end - start) * consumed_chars / total_chars
            )
            if part_end > part_start:
                normalized.append(
                    {
                        "startSec": part_start,
                        "endSec": part_end,
                        "text": part,
                    }
                )
            part_start = part_end

    normalized.sort(key=lambda item: (item["startSec"], item["endSec"]))
    return normalized


def _write_checkpoint(manifest_path, manifest):
    manifest_path = manifest_path.resolve()
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=manifest_path.parent,
        prefix=f".{manifest_path.name}.",
        suffix=".tmp",
        text=True,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(manifest, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_name, manifest_path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def _safe_error(error):
    if isinstance(error, FileNotFoundError):
        return "prepared media is missing"
    if isinstance(error, PermissionError):
        return "prepared media is not readable"
    message = str(error).lower()
    if "audio" in message:
        return "audio decoding or transcription failed"
    return f"{type(error).__name__}: transcription failed"


def _media_path(manifest_path, entry):
    relative_path = entry.get("prepared", {}).get("media")
    if not isinstance(relative_path, str) or not relative_path:
        raise FileNotFoundError
    prepared_root = manifest_path.resolve().parent
    media_path = (prepared_root / relative_path).resolve()
    if not media_path.is_relative_to(prepared_root):
        raise ValueError("prepared media must remain inside prepared directory")
    if not media_path.is_file():
        raise FileNotFoundError
    return media_path


def transcribe_manifest(manifest_path, model_name, language, force=False):
    manifest_path = Path(manifest_path)
    with manifest_path.open(encoding="utf-8") as source:
        manifest = json.load(source)

    pending = [
        entry
        for entry in manifest.get("entries", [])
        if force
        or not isinstance(entry.get("transcription"), dict)
        or entry["transcription"].get("status") not in {"ready", "skipped"}
    ]
    if not pending:
        print("No entries require transcription.")
        return manifest

    model = None
    total = len(pending)
    for index, entry in enumerate(pending, start=1):
        title = entry.get("title") or entry.get("sourceKey", "")[:16] or "untitled"
        print(f"[{index}/{total}] Transcribing {title}...", flush=True)
        try:
            media = entry.get("media")
            if not isinstance(media, dict) or media.get("hasAudio") is not True:
                entry.pop("transcriptSegments", None)
                entry["transcription"] = {
                    "status": "skipped",
                    "reason": "media has no audio track",
                }
                print(f"[{index}/{total}] Skipped (no audio)", flush=True)
                continue
            if model is None:
                if WhisperModel is None:
                    raise RuntimeError(
                        "faster-whisper is unavailable; install requirements-asr.txt"
                    )
                model = WhisperModel(model_name, device="cpu", compute_type="int8")
            media_path = _media_path(manifest_path, entry)
            raw_segments, _ = model.transcribe(
                str(media_path),
                language=language,
                vad_filter=True,
            )
            segments = normalize_segments(raw_segments, entry.get("durationSec"))
            if not segments:
                raise RuntimeError("transcription produced no usable segments")
            entry["transcriptSegments"] = segments
            entry["transcription"] = {
                "status": "ready",
                "model": model_name,
                "language": language,
            }
            print(f"[{index}/{total}] Ready ({len(segments)} segments)", flush=True)
        except Exception as error:
            entry.pop("transcriptSegments", None)
            entry["transcription"] = {
                "status": "failed",
                "model": model_name,
                "language": language,
                "error": _safe_error(error),
            }
            print(
                f"[{index}/{total}] Failed: {entry['transcription']['error']}",
                file=sys.stderr,
                flush=True,
            )
        finally:
            _write_checkpoint(manifest_path, manifest)

    return manifest


def _parse_args():
    parser = argparse.ArgumentParser(
        description="Transcribe prepared videos locally with faster-whisper."
    )
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model", default="medium")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main():
    args = _parse_args()
    transcribe_manifest(
        args.manifest,
        model_name=args.model,
        language=args.language,
        force=args.force,
    )


if __name__ == "__main__":
    main()
