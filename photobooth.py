"""Local Windows photo booth. Run with python photobooth.py."""
from __future__ import annotations

import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from datetime import datetime

import cv2
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageTk

ROOT = Path(__file__).resolve().parent
REQUIRED_PHOTOS = 4
BG, PANEL, INK, MUTED, ACCENT = "#101820", "#1b2834", "#f5f8fa", "#9db0bf", "#55dfbb"


def session_complete(photos):
    return len(photos) == REQUIRED_PHOTOS and all(photo is not None for photo in photos)


def compose_print(photos):
    """A 6 x 4 inch landscape layout at 300 dpi."""
    if not session_complete(photos):
        raise ValueError("Fill all four photo slots before saving or printing.")
    canvas = Image.new("RGB", (1800, 1200), "white")
    for index, photo in enumerate(photos):
        x = 60 + (index % 2) * 855
        y = 60 + (index // 2) * 510
        canvas.paste(ImageOps.fit(photo, (825, 480), method=Image.Resampling.LANCZOS), (x, y))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/seguisb.ttf", 28)
    except OSError:
        font = ImageFont.load_default(size=28)
    draw.text((900, 1130), "PHOTO BOOTH  •  " + datetime.now().strftime("%d %b %Y"),
              font=font, fill="#293743", anchor="mm")
    return canvas


def save_session(photos, destination):
    if not session_complete(photos):
        raise ValueError("Fill all four photo slots before saving or printing.")
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    session = destination / datetime.now().strftime("PhotoBooth_%Y-%m-%d_%H-%M-%S_%f")
    session.mkdir()
    try:
        for index, photo in enumerate(photos, 1):
            photo.save(session / f"photo_{index:02d}.jpg", quality=95)
        compose_print(photos).save(session / "print_6x4.png", dpi=(300, 300))
    except Exception:
        for file in session.iterdir():
            file.unlink()
        session.rmdir()
        raise
    return session


class Camera:
    def __init__(self):
        self.events = queue.Queue()
        self.lock = threading.Lock()
        self.frame = None
        self.stop_event = threading.Event()
        self.thread = None

    def start(self, index):
        if self.thread and self.thread.is_alive():
            return False
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, args=(index,), daemon=True)
        self.thread.start()
        return True

    def _run(self, index):
        cap = None
        try:
            for backend in (cv2.CAP_DSHOW, cv2.CAP_MSMF):
                if self.stop_event.is_set():
                    return
                cap = cv2.VideoCapture(index, backend)
                if cap.isOpened():
                    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
                    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                    # Some drivers open successfully but never deliver an image.
                    for _ in range(12):
                        ok, frame = cap.read()
                        if ok and frame is not None:
                            break
                        if self.stop_event.is_set():
                            return
                    if ok and frame is not None:
                        break
                cap.release()
                cap = None
            if cap is None or not cap.isOpened():
                raise RuntimeError("Cannot open this camera. Try another camera number, close other camera apps, and allow desktop camera access in Windows Settings.")
            self.events.put(("ready", "Camera connected"))
            failures = 0
            while not self.stop_event.is_set():
                ok, frame = cap.read()
                if not ok or frame is None:
                    failures += 1
                    if failures >= 20:
                        raise RuntimeError("Camera stopped responding. Reconnect it and click Connect camera.")
                    time.sleep(0.05)
                    continue
                failures = 0
                with self.lock:
                    self.frame = (time.monotonic(), cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        except Exception as error:
            self.events.put(("error", str(error)))
        finally:
            if cap is not None:
                cap.release()
            with self.lock:
                self.frame = None
            self.events.put(("stopped", ""))

    def snapshot(self):
        with self.lock:
            if self.frame is None or time.monotonic() - self.frame[0] > 2:
                return None
            return Image.fromarray(self.frame[1].copy())

    def stop(self):
        self.stop_event.set()


class PhotoBooth:
    def __init__(self, window):
        self.window = window
        window.title("Photo Booth — Capture • Save • Print")
        window.geometry("1180x820")
        window.minsize(960, 720)
        window.configure(bg=BG)
        self.photos = [None] * REQUIRED_PHOTOS
        self.camera = Camera()
        self.connected = False
        self.busy = False
        self.countdown_job = None
        self.countdown_active = False
        self.events = queue.Queue()
        self.closed = False
        self.destination = Path.home() / "Pictures" / "PhotoBooth"
        self.mirror = tk.BooleanVar(value=True)
        self.status = tk.StringVar(value="Connecting camera…")
        self.progress = tk.StringVar(value="0 / 4 photos ready")
        self.path_text = tk.StringVar(value=str(self.destination))
        self._style()
        self._build()
        self.window.protocol("WM_DELETE_WINDOW", self.close)
        self.connect()
        self.tick()

    def _style(self):
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TButton", padding=(14, 10), font=("Segoe UI", 10), background=PANEL, foreground=INK)
        style.map("TButton", background=[("active", "#344b5c"), ("disabled", "#202b34")], foreground=[("disabled", "#62727e")])
        style.configure("Accent.TButton", background=ACCENT, foreground=BG, font=("Segoe UI", 11, "bold"))
        style.map("Accent.TButton", background=[("active", "#8cf0d4"), ("disabled", "#253c38")], foreground=[("disabled", "#627a73")])

    def label(self, parent, text=None, **options):
        return tk.Label(parent, text=text, bg=options.pop("bg", BG), fg=options.pop("fg", INK), font=options.pop("font", ("Segoe UI", 11)), **options)

    def _build(self):
        header = tk.Frame(self.window, bg=BG)
        header.pack(fill="x", padx=28, pady=(22, 16))
        self.label(header, "PHOTO BOOTH", font=("Segoe UI", 25, "bold")).pack(side="left")
        self.label(header, "Make a moment. Keep a memory.", fg=MUTED).pack(side="right")
        body = tk.Frame(self.window, bg=BG)
        body.pack(fill="both", expand=True, padx=28)
        left = tk.Frame(body, bg=BG)
        left.pack(side="left", fill="both", expand=True, padx=(0, 22))
        right = tk.Frame(body, bg=PANEL, width=300)
        right.pack(side="right", fill="y")
        right.pack_propagate(False)
        self.preview = tk.Canvas(left, bg="#080e14", highlightthickness=0)
        self.preview.pack(fill="both", expand=True)
        controls = tk.Frame(left, bg=BG)
        controls.pack(fill="x", pady=(12, 8))
        self.camera_index = tk.StringVar(value="0")
        self.label(controls, "Camera", fg=MUTED).pack(side="left")
        ttk.Combobox(controls, textvariable=self.camera_index, values=list(range(6)), state="readonly", width=3).pack(side="left", padx=8)
        self.connect_button = ttk.Button(controls, text="Connect camera", command=self.connect)
        self.connect_button.pack(side="left")
        tk.Checkbutton(controls, text="Mirror photos", variable=self.mirror, bg=BG, fg=INK, selectcolor=PANEL, activebackground=BG, activeforeground=INK).pack(side="right")
        self.capture_button = ttk.Button(left, text="Capture photo 1  ·  3 sec countdown", command=self.capture, style="Accent.TButton")
        self.capture_button.pack(fill="x", pady=(2, 10))
        self.label(left, textvariable=self.status, fg=MUTED, wraplength=620, anchor="w", justify="left").pack(fill="x")
        self.label(right, "YOUR PHOTO SET", bg=PANEL, font=("Segoe UI", 14, "bold")).pack(anchor="w", padx=18, pady=(18, 2))
        self.label(right, textvariable=self.progress, bg=PANEL, fg=MUTED).pack(anchor="w", padx=18, pady=(0, 10))
        self.slot_labels = []
        self.clear_buttons = []
        for index in range(REQUIRED_PHOTOS):
            row = tk.Frame(right, bg=PANEL)
            row.pack(fill="x", padx=18, pady=5)
            thumbnail = self.label(row, f"{index + 1}   Waiting for photo", bg="#263643", fg=MUTED, width=23, height=4)
            thumbnail.pack(side="left")
            button = ttk.Button(row, text="×", width=2, command=lambda i=index: self.clear_slot(i))
            button.pack(side="right", padx=(5, 0))
            self.slot_labels.append(thumbnail)
            self.clear_buttons.append(button)
        self.label(right, "All 4 photos are required to save or print.", bg=PANEL, fg=MUTED, wraplength=255, justify="left").pack(anchor="w", padx=18, pady=12)
        self.save_button = ttk.Button(right, text="Save photo set", command=self.save, style="Accent.TButton")
        self.save_button.pack(fill="x", padx=18, pady=5)
        self.print_button = ttk.Button(right, text="Print photo set…", command=self.print_photos)
        self.print_button.pack(fill="x", padx=18, pady=5)
        self.reset_button = ttk.Button(right, text="Start a new set", command=self.reset)
        self.reset_button.pack(fill="x", padx=18, pady=(5, 18))
        footer = tk.Frame(self.window, bg=BG)
        footer.pack(fill="x", padx=28, pady=18)
        self.label(footer, "SAVE TO", fg=MUTED, font=("Segoe UI", 9, "bold")).pack(side="left")
        self.label(footer, textvariable=self.path_text, fg=MUTED).pack(side="left", padx=12)
        ttk.Button(footer, text="Choose folder…", command=self.choose_folder).pack(side="right")
        self.update_controls()

    def update_controls(self):
        complete = session_complete(self.photos)
        unlocked = not self.busy and not self.countdown_active
        # One gate controls both UI buttons; handlers also enforce the invariant.
        for button in (self.save_button, self.print_button):
            button.configure(state="normal" if complete and unlocked else "disabled")
        self.capture_button.configure(state="normal" if self.connected and not complete and unlocked else "disabled")
        missing = next((i for i, p in enumerate(self.photos) if p is None), None)
        self.capture_button.configure(text="All 4 photos captured" if missing is None else f"Capture photo {missing + 1}  ·  3 sec countdown")
        self.progress.set(f"{sum(p is not None for p in self.photos)} / 4 photos ready")
        self.reset_button.configure(state="normal" if unlocked else "disabled")
        self.connect_button.configure(state="normal" if unlocked else "disabled")
        for i, button in enumerate(self.clear_buttons):
            button.configure(state="normal" if self.photos[i] is not None and unlocked else "disabled")

    def connect(self):
        self.connected = False
        self.camera.stop()
        self.status.set("Connecting camera…")
        self.update_controls()
        self._start_when_stopped(int(self.camera_index.get()))

    def _start_when_stopped(self, index):
        if self.closed:
            return
        if self.camera.thread and self.camera.thread.is_alive():
            self.window.after(100, lambda: self._start_when_stopped(index))
            return
        # Discard notifications from the previous camera connection.
        while not self.camera.events.empty():
            self.camera.events.get_nowait()
        self.camera.start(index)

    def tick(self):
        if self.closed:
            return
        while not self.camera.events.empty():
            kind, detail = self.camera.events.get_nowait()
            if kind == "ready":
                self.connected = True
                self.status.set(detail)
            elif kind == "error":
                self.connected = False
                self.status.set(detail)
            elif kind == "stopped":
                self.connected = False
            self.update_controls()
        while not self.events.empty():
            kind, detail = self.events.get_nowait()
            self.busy = False
            if kind == "saved":
                self.status.set(f"Saved photo set to {detail}")
                messagebox.showinfo("Photos saved", f"Four original photos and a print layout saved to:\n{detail}")
            elif kind == "printed":
                self.status.set("Print job sent to Windows." if detail == 0 else "Printing cancelled.")
            else:
                self.status.set("Operation failed. Your captured photos are still available.")
                messagebox.showerror("Photo Booth", detail)
            self.update_controls()
        photo = self.camera.snapshot()
        self.preview.delete("all")
        width, height = max(self.preview.winfo_width(), 1), max(self.preview.winfo_height(), 1)
        if photo is not None:
            if self.mirror.get():
                photo = ImageOps.mirror(photo)
            photo.thumbnail((width, height), Image.Resampling.LANCZOS)
            self.preview_image = ImageTk.PhotoImage(photo)
            self.preview.create_image(width // 2, height // 2, image=self.preview_image)
        else:
            self.preview.create_text(width // 2, height // 2, text="Waiting for camera", fill=MUTED, font=("Segoe UI", 20))
        if self.countdown_active:
            self.preview.create_text(width // 2, height // 2, text=str(self.remaining), fill="white", font=("Segoe UI", 84, "bold"))
        self.window.after(40, self.tick)

    def capture(self):
        if self.busy or self.countdown_active or not self.connected or session_complete(self.photos):
            return
        self.countdown_active = True
        self.remaining = 3
        self.status.set("Look at the camera…")
        self.update_controls()
        self.countdown_job = self.window.after(1000, self.count_down)

    def count_down(self):
        self.remaining -= 1
        if self.remaining > 0:
            self.countdown_job = self.window.after(1000, self.count_down)
            return
        self.countdown_job = None
        self.countdown_active = False
        photo = self.camera.snapshot()
        if photo is None:
            self.status.set("No fresh camera image available. Reconnect the camera and try again.")
        else:
            if self.mirror.get():
                photo = ImageOps.mirror(photo)
            index = self.photos.index(None)
            self.photos[index] = photo
            self.render_slot(index)
            self.status.set("Your set is ready to save or print." if session_complete(self.photos) else "Photo captured. Get ready for the next one.")
        self.update_controls()

    def render_slot(self, index):
        label = self.slot_labels[index]
        photo = self.photos[index]
        if photo is None:
            label.configure(image="", text=f"{index + 1}   Waiting for photo", width=23, height=4)
            label.image = None
        else:
            label.image = ImageTk.PhotoImage(ImageOps.fit(photo, (208, 82), method=Image.Resampling.LANCZOS))
            label.configure(image=label.image, text="", width=208, height=82)

    def clear_slot(self, index):
        if self.busy or self.countdown_active:
            return
        self.photos[index] = None
        self.render_slot(index)
        self.status.set(f"Photo {index + 1} cleared. Fill this slot to enable saving and printing.")
        self.update_controls()

    def reset(self):
        if self.busy or self.countdown_active:
            return
        self.photos = [None] * REQUIRED_PHOTOS
        for i in range(REQUIRED_PHOTOS):
            self.render_slot(i)
        self.status.set("Ready for a new photo set.")
        self.update_controls()

    def choose_folder(self):
        folder = filedialog.askdirectory(title="Choose where to save photo sets", initialdir=str(self.destination if self.destination.exists() else Path.home()))
        if folder:
            self.destination = Path(folder)
            self.path_text.set(folder)

    def save(self):
        if self.busy or self.countdown_active or not session_complete(self.photos):
            return
        photos, destination = list(self.photos), self.destination
        self.busy = True
        self.status.set("Saving photos…")
        self.update_controls()
        def work():
            try:
                self.events.put(("saved", str(save_session(photos, destination))))
            except Exception as error:
                self.events.put(("error", f"Could not save photos: {error}"))
        threading.Thread(target=work, daemon=True).start()

    def print_photos(self):
        if self.busy or self.countdown_active or not session_complete(self.photos):
            return
        photos = list(self.photos)
        self.busy = True
        self.status.set("Choose your printer in the Windows print dialog…")
        self.update_controls()
        def work():
            try:
                with tempfile.TemporaryDirectory(prefix="photobooth_print_") as directory:
                    path = Path(directory) / "print.png"
                    compose_print(photos).save(path, dpi=(300, 300))
                    result = subprocess.run([
                        "powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
                        "-File", str(ROOT / "print_photo.ps1"), "-ImagePath", str(path),
                    ], capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
                    if result.returncode not in (0, 2):
                        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Windows could not send the print job.")
                    self.events.put(("printed", result.returncode))
            except Exception as error:
                self.events.put(("error", f"Could not print: {error}"))
        threading.Thread(target=work, daemon=True).start()

    def close(self):
        if self.busy:
            messagebox.showinfo("Please wait", "Finish saving or close the print dialog before exiting.")
            return
        self.closed = True
        if self.countdown_job:
            self.window.after_cancel(self.countdown_job)
        self.camera.stop()
        self.window.destroy()


if __name__ == "__main__":
    PhotoBooth(tk.Tk()).window.mainloop()
