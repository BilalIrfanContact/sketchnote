"""Unit tests for the pure parts of bundle.py. Run: python3 -m unittest discover tests"""
import os
import sys
import unittest

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import bundle  # noqa: E402

W = lambda word, t: {'word': ' ' + word, 'start': t, 'end': t + 0.2}  # noqa: E731


class Marks(unittest.TestCase):
    def test_speech_is_split_at_marks_and_early_speech_goes_to_first(self):
        events = [{'type': 'click', 't': 4.0, 'x': 1, 'y': 1},
                  {'type': 'stroke', 't': 2.0, 't_end': 3.0, 'points': [[0, 0], [5, 5]]}]
        words = [W('intro', 0.5), W('look', 2.5), W('here', 3.9), W('clicked', 4.1)]
        marks = bundle.make_marks(events, words, duration=6)
        self.assertEqual([m['type'] for m in marks], ['stroke', 'click'])
        self.assertEqual(marks[0]['text'], 'intro look here')
        self.assertEqual(marks[1]['text'], 'clicked')
        self.assertAlmostEqual(marks[0]['frame_t'], 3.1)   # just after the stroke ends

    def test_no_events_gives_one_mark_with_everything(self):
        marks = bundle.make_marks([], [W('all', 1.0)], duration=5)
        self.assertEqual(len(marks), 1)
        self.assertEqual((marks[0]['type'], marks[0]['text']), ('none', 'all'))

    def test_summary_format(self):
        marks = bundle.make_marks([{'type': 'click', 't': 16, 'x': 0, 'y': 0}], [W('hi', 16.5)], 60)
        text = bundle.summary('/b', 60, {'app': 'Firefox', 'title': 'Docs'}, marks, 'screen')
        self.assertTrue(text.startswith('[sketchnote 1:00 · Firefox "Docs" · /b]\n'
                                        'Cropped to: the activity in Firefox (full frames in frames-full/)\n'
                                        '- #1 (0:16) [clicked] “hi”\n'))
        self.assertIn('/b/contact-sheet.png', text)


class Geometry(unittest.TestCase):
    def test_mapper_handles_area_offset_and_scale(self):
        to_px = bundle.mapper([100, 50, 400, 300], (800, 600))
        self.assertEqual(to_px(100, 50), (0, 0))
        self.assertEqual(to_px(300, 200), (400, 300))

    def test_crop_is_padded_and_clamped_to_window(self):
        to_px = bundle.mapper([0, 0, 1920, 1080], (1920, 1080))
        e = {'type': 'click', 'x': 50, 'y': 50, 'window': {'rect': [0, 0, 1000, 700]}}
        box = bundle.crop_box({'event': e}, [0, 0, 1920, 1080], to_px, (1920, 1080))
        self.assertEqual(box, (0, 0, 370, 250))   # min size 640x400 centred, clamped at 0

    def test_contact_sheet_two_columns(self):
        tiles = [(i, Image.new('RGB', (100, 50 * i))) for i in (1, 2, 3)]
        sheet = bundle.contact_sheet(tiles)
        self.assertEqual(sheet.width, bundle.GAP + 2 * (bundle.COLUMN_WIDTH + bundle.GAP))


if __name__ == '__main__':
    unittest.main()
