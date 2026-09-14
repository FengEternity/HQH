import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import transcribe
from transcribe import normalize_segments


def write_manifest(root, entries):
    manifest_path = Path(root) / "manifest.json"
    manifest_path.write_text(
        json.dumps({"entries": entries}, ensure_ascii=False),
        encoding="utf-8",
    )
    return manifest_path


class NormalizeSegmentsTest(unittest.TestCase):
    def test_trims_text_and_discards_empty_segments(self):
        raw = [
            {"start": 0, "end": 1, "text": "  打开项目  "},
            {"start": 1, "end": 2, "text": " \n\t "},
        ]

        self.assertEqual(
            normalize_segments(raw, 10),
            [{"startSec": 0.0, "endSec": 1.0, "text": "打开项目"}],
        )

    def test_clamps_segments_to_video_duration_and_drops_zero_length(self):
        raw = [
            {"start": -2, "end": 2, "text": "片头"},
            {"start": 8, "end": 12, "text": "片尾"},
            {"start": 12, "end": 13, "text": "越界"},
            {"start": 4, "end": 4, "text": "零长度"},
        ]

        self.assertEqual(
            normalize_segments(raw, 10),
            [
                {"startSec": 0.0, "endSec": 2.0, "text": "片头"},
                {"startSec": 8.0, "endSec": 10.0, "text": "片尾"},
            ],
        )

    def test_splits_long_text_on_chinese_punctuation_and_allocates_time(self):
        first = "甲" * 40 + "。"
        second = "乙" * 40 + "！"
        raw = [{"start": 10, "end": 20, "text": first + second}]

        result = normalize_segments(raw, 30)

        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["text"], first)
        self.assertEqual(result[1]["text"], second)
        self.assertEqual(result[0]["startSec"], 10.0)
        self.assertAlmostEqual(result[0]["endSec"], 15.0)
        self.assertAlmostEqual(result[1]["startSec"], 15.0)
        self.assertEqual(result[1]["endSec"], 20.0)

    def test_outputs_sorted_segments_without_zero_length_ranges(self):
        raw = [
            {"start": 5, "end": 7, "text": "第二段"},
            {"start": 1, "end": 3, "text": "第一段"},
            {"start": 9, "end": 8, "text": "反向段"},
        ]

        result = normalize_segments(raw, 10)

        self.assertEqual([segment["text"] for segment in result], ["第一段", "第二段"])
        self.assertTrue(
            all(
                segment["endSec"] > segment["startSec"]
                for segment in result
            )
        )


class TranscribeManifestTest(unittest.TestCase):
    def test_empty_transcription_is_failed_without_segments(self):
        with tempfile.TemporaryDirectory() as root:
            media_path = Path(root) / "media" / "video.mp4"
            media_path.parent.mkdir()
            media_path.touch()
            manifest_path = write_manifest(
                root,
                [
                    {
                        "durationSec": 10,
                        "media": {"hasAudio": True},
                        "prepared": {"media": "media/video.mp4"},
                    }
                ],
            )
            model = unittest.mock.Mock()
            model.transcribe.return_value = (iter(()), None)

            with patch.object(transcribe, "WhisperModel", return_value=model):
                transcribe.transcribe_manifest(manifest_path, "medium", "zh")

            entry = json.loads(manifest_path.read_text(encoding="utf-8"))["entries"][0]
            self.assertEqual(entry["transcription"]["status"], "failed")
            self.assertNotIn("transcriptSegments", entry)

    def test_no_audio_is_skipped_and_subsequent_run_does_not_load_model(self):
        with tempfile.TemporaryDirectory() as root:
            manifest_path = write_manifest(
                root,
                [
                    {
                        "durationSec": 10,
                        "media": {"hasAudio": False},
                        "transcriptSegments": [
                            {"startSec": 0, "endSec": 1, "text": "旧字幕"}
                        ],
                    }
                ],
            )

            with patch.object(
                transcribe,
                "WhisperModel",
                side_effect=AssertionError("skipped entries must not load the model"),
            ):
                transcribe.transcribe_manifest(manifest_path, "medium", "zh")
                transcribe.transcribe_manifest(manifest_path, "medium", "zh")

            entry = json.loads(manifest_path.read_text(encoding="utf-8"))["entries"][0]
            self.assertEqual(
                entry["transcription"],
                {
                    "status": "skipped",
                    "reason": "media has no audio track",
                },
            )
            self.assertNotIn("transcriptSegments", entry)

    def test_ready_and_skipped_manifest_does_not_require_whisper(self):
        with tempfile.TemporaryDirectory() as root:
            manifest_path = write_manifest(
                root,
                [
                    {"transcription": {"status": "ready"}},
                    {"transcription": {"status": "skipped"}},
                ],
            )

            with patch.object(transcribe, "WhisperModel", None):
                result = transcribe.transcribe_manifest(manifest_path, "medium", "zh")

            self.assertEqual(len(result["entries"]), 2)

    def test_null_transcription_is_processed_and_checkpointed(self):
        with tempfile.TemporaryDirectory() as root:
            manifest_path = write_manifest(
                root,
                [
                    {
                        "durationSec": 10,
                        "media": {"hasAudio": True},
                        "prepared": {"media": "media/missing.mp4"},
                        "transcription": None,
                    }
                ],
            )

            with patch.object(transcribe, "WhisperModel", return_value=unittest.mock.Mock()):
                transcribe.transcribe_manifest(manifest_path, "medium", "zh")

            entry = json.loads(manifest_path.read_text(encoding="utf-8"))["entries"][0]
            self.assertEqual(entry["transcription"]["status"], "failed")
            self.assertEqual(
                entry["transcription"]["error"],
                "prepared media is missing",
            )
            self.assertNotIn("transcriptSegments", entry)


if __name__ == "__main__":
    unittest.main()
