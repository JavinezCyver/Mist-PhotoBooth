import tempfile
import tkinter as tk
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from photobooth import PhotoBooth, compose_print, save_session, session_complete


class OutputTests(unittest.TestCase):
    def test_each_missing_slot_blocks_outputs(self):
        for missing in range(4):
            photos = [Image.new("RGB", (100, 80), "red") for _ in range(4)]
            photos[missing] = None
            with tempfile.TemporaryDirectory() as directory:
                self.assertFalse(session_complete(photos))
                with self.assertRaises(ValueError):
                    save_session(photos, Path(directory) / "output")
                with self.assertRaises(ValueError):
                    compose_print(photos)
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_complete_set_saves_four_originals_and_print_layout(self):
        colors = ["red", "green", "blue", "yellow"]
        photos = [Image.new("RGB", (640, 480), color) for color in colors]
        with tempfile.TemporaryDirectory() as directory:
            session = save_session(photos, directory)
            self.assertEqual(len(list(session.iterdir())), 5)
            for index in range(1, 5):
                with Image.open(session / f"photo_{index:02d}.jpg") as photo:
                    self.assertEqual(photo.size, (640, 480))
            with Image.open(session / "print_6x4.png") as layout:
                self.assertEqual(layout.size, (1800, 1200))
                self.assertAlmostEqual(layout.info["dpi"][0], 300, places=1)
                for index, color in enumerate(colors):
                    expected = Image.new("RGB", (1, 1), color).getpixel((0, 0))
                    self.assertEqual(layout.getpixel((400 + (index % 2) * 855, 300 + (index // 2) * 510)), expected)

    def test_failed_save_removes_partial_session(self):
        photos = [Image.new("RGB", (100, 80)) for _ in range(4)]
        with tempfile.TemporaryDirectory() as directory:
            with patch("photobooth.compose_print", side_effect=OSError("disk error")):
                with self.assertRaises(OSError):
                    save_session(photos, directory)
            self.assertEqual(list(Path(directory).iterdir()), [])


class ButtonTests(unittest.TestCase):
    def setUp(self):
        self.root = tk.Tk()
        self.root.withdraw()
        with patch.object(PhotoBooth, "connect"), patch.object(PhotoBooth, "tick"):
            self.app = PhotoBooth(self.root)

    def tearDown(self):
        self.app.close()

    def assert_outputs(self, state):
        self.assertEqual(str(self.app.save_button["state"]), state)
        self.assertEqual(str(self.app.print_button["state"]), state)

    def test_gate_tracks_capture_clear_and_reset(self):
        self.assert_outputs("disabled")
        photo = Image.new("RGB", (320, 240), "blue")
        for index in range(4):
            self.app.photos[index] = photo
            self.app.update_controls()
            self.assert_outputs("normal" if index == 3 else "disabled")
        self.app.clear_slot(2)
        self.assert_outputs("disabled")
        self.app.photos[2] = photo
        self.app.update_controls()
        self.assert_outputs("normal")
        self.app.reset()
        self.assert_outputs("disabled")

    def test_incomplete_handlers_never_start_output(self):
        with patch("photobooth.threading.Thread") as thread:
            self.app.save()
            self.app.print_photos()
            thread.assert_not_called()

    def test_capture_fills_slot_and_enables_complete_set(self):
        photo = Image.new("RGB", (320, 240), "blue")
        self.app.photos = [photo, None, photo, photo]
        self.app.remaining = 1
        self.app.countdown_active = True
        with patch.object(self.app.camera, "snapshot", return_value=photo):
            self.app.count_down()
        self.assertTrue(session_complete(self.app.photos))
        self.assert_outputs("normal")


if __name__ == "__main__":
    unittest.main()
