import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from transcribe import normalize_segments


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


if __name__ == "__main__":
    unittest.main()
