# Sketchnote

Show a coding agent the problem: press a hotkey, talk, click and draw on your screen,
then paste the result into your agent. A Linux (GNOME 50, Wayland) take on
[Scrawl](https://scrawl.kitlangton.com/).

## Install

```sh
./install.sh
```

Then **log out and back in once**. GNOME on Wayland only discovers new extensions at login.

`install.sh` does three things:

- Builds the `sketchnote` binary with cargo and downloads the Whisper `small` model (264 MB) and a voice detector into `~/.local/share/sketchnote/models/`.
- Symlinks `extension/sketchnote@local` into `~/.local/share/gnome-shell/extensions/` and enables it.
- Writes a D-Bus activation file so the service starts on demand.

It is safe to re-run.

Requirements: a Rust toolchain and `cmake` to build (whisper.cpp is compiled in), plus `ffmpeg` (with libx264), `pw-record` and `notify-send`, which Ubuntu with GNOME 50 already has.

## Use

| Key | What it does |
|---|---|
| Alt+Shift+S | Start a capture, or finish the running one (the pencil icon in the top bar does the same) |
| hold Space + drag | Draw a thin red stroke. It fades on screen after about 1.5 s but is kept in the output |
| Space + click | Drop a numbered pin |
| click | Logged as a click (blue ring in the output) |
| Ctrl+Z | Undo the last stroke or pin |
| Esc | Cancel and throw the capture away |
| Ctrl+V | Right after a capture is ready: paste its notes and contact sheet together |
| Alt+Shift+V | Paste the latest capture's notes and contact sheet, any time |

Starting a capture records the whole screen and the microphone immediately. While it runs:

- A red glow outlines the screen.
- A stop icon appears in the top bar.
- A pill at top centre shows the timer and **Area / Window / Screen** for 3 seconds. Picking **Window** or **Area** restarts the capture on that target, and Area lets you drag a rectangle. The pill then switches to **Undo / Cancel / Finish**.

After Finish, the capture is transcribed locally, which takes about 10 s for 20 s of speech on CPU. A notification says when it's ready, and the notes are now on the clipboard. Press Ctrl+V in your agent's input box: the extension pastes the notes, swaps the clipboard to the contact sheet and pastes again, so you get the text and the image from one key press. Each is an ordinary paste, so this works in any app that accepts pasted text and images. Once you copy something else, Ctrl+V is normal again; Alt+Shift+V pastes the latest capture whenever you want it back.

CLI: `./sketchnote latest | service`.

## Output

Each capture is a folder `~/.local/share/sketchnote/captures/<timestamp>.bundle/`:

| File | Contents |
|---|---|
| `recording.mp4` | Screen recording, H.264, 30 fps |
| `audio.wav` | Microphone, 16 kHz mono |
| `frames/frame-NN.png` | Keyframe per mark, cropped to the activity, annotations burned in |
| `frames-full/frame-NN.png` | The same keyframes uncropped |
| `contact-sheet.png` | Cropped keyframes in a two-column grid with number badges |
| `summary.md` | The handoff text, pasted by Ctrl+V or Alt+Shift+V |
| `sketchnote.json` | Timings, strokes, clicks, pins, target window, word timestamps, marks |

`summary.md` looks like this:

```
- #1 (0:04) “This footer has too much text, let's cut it down”
- #2 (0:10) “and the model name here is out of date”
- #3 (0:11) [clicked] “this button should open the settings instead”
```

## How it's built

- **`extension/sketchnote@local/extension.js`** (GNOME Shell extension). It handles the hotkey, glow, pill, live ink, pins, click logging, undo, cancel and area picking. It records the screen through GNOME Shell's own Screencast service. Only the Shell may call that service, so there's no portal prompt and the recording code lives in the extension.
- **The `sketchnote` binary** (Rust, `src/`). `sketchnote service` is the D-Bus service `org.sketchnote.Service`, started on demand:
  - `service.rs` records the mic with `pw-record` and builds the bundle on Finish.
  - `bundle.rs` converts the video with ffmpeg and writes the bundle.
  - `notes.rs` turns events into marks, assigns speech to them and writes `summary.md`.
  - `draw.rs` draws keyframes, crops and the contact sheet.
  - `transcribe.rs` runs whisper.cpp (`small`, 8-bit) in-process, with word timestamps.

To rename, change `sketchnote`/`org.sketchnote` in those files, the extension uuid, and `install.sh`.

## Decisions where the spec says "unknown"

These are the simplest options, picked deliberately. Change them freely.

- **Hotkeys.** Scrawl's ⌥⇧S / ⌥⇧V become Alt+Shift+S / Alt+Shift+V. Hotkeys are constants at the top of `extension.js`. There's no settings UI.
- **Pasting text and image together.** A clipboard holds one thing that apps reliably paste, so the extension pastes twice: notes first, then the contact sheet, 0.4 s apart. Alt+Shift+V waits until you release Alt and Shift, otherwise the app would see Ctrl+Alt+Shift+V.
- **Mode picker.** It shows for 3 s. Picking Window uses the window that was focused when you pressed the hotkey. Picking Window or Area restarts the capture, so the timer resets. There's no iPhone mode.
- **Marks.** Every stroke, click and pin is its own mark; nothing is merged. Each mark gets the words spoken from its start until the next mark. Words spoken before the first mark go to #1. With no marks, the whole capture is one note keyed on the last frame.
- **Note tags.** Clicks are tagged `[clicked]` and pins `[pin]`.
- **Pins.** A red circle showing its mark number, fading like strokes.
- **Undo.** Removes the last stroke or pin. Clicks can't be undone.
- **Fade timing.** Strokes stay 0.5 s, then fade over 1 s.
- **Clicks on screen.** Not shown live. Clicks on the pill or the top bar aren't logged.
- **Keyframes.** Taken 0.1 s after a stroke ends (or a click or pin lands). The crop is the activity's bounding box plus 160 px, at least 640×400, clamped to the window under the activity.
- **Notes only.** `summary.md` is just the numbered notes; Scrawl's header, crop and attachment lines are left out because the image is pasted alongside. The target app and window are still in `sketchnote.json`.
- **After Finish.** A desktop notification when the bundle is ready. Scrawl shows nothing, but local transcription takes a while.
- **Esc and Ctrl+Z.** Grabbed globally, but only while a capture runs.

## Known limitations

- **Space is reserved while capturing.** Space is grabbed globally during a capture, so you can't type spaces into apps until you finish or cancel. Scrawl uses Shift; Space was chosen here so Shift keeps working in apps.
- **The recording shows Sketchnote's own UI.** GNOME's screencast records everything on screen, so `recording.mp4` and the keyframes include the pill, the glow and the live strokes. The strokes in the keyframes are redrawn on top in the same spot.
- **Pill placement.** The pill sits on the primary monitor. Screen mode records all monitors as one image.
- **Recording start lag.** GNOME's screencast takes about 0.5–2 s to start, so the first moment after the hotkey may be missing from `recording.mp4`. The mic starts within about 0.1 s, and both offsets are stored and applied. I've seen it take 14 s once. If you cancel or finish and immediately start again, the new capture waits for the previous recording to stop before it starts recording.
- **Missed clicks.** Clicks are detected by polling every 10 ms, so a press shorter than that could be missed.
- **Heavy work runs niced.** Building a bundle runs at nice 10, and transcription uses half the CPU cores, so the desktop stays responsive.
- **CPU transcription, English only.** It takes roughly 0.5× real time. The language is fixed to English, because auto-detection was slower and sometimes picked the wrong language. To try another whisper.cpp model, set `SKETCHNOTE_MODEL=/path/to/ggml-model.bin` in the D-Bus service file's environment. `sketchnote transcribe file.wav` prints a recording's words with timestamps.

## Tests

```sh
cargo test                             # bundle logic (marks, speech split, crops, layout)
tests/e2e.py speech.wav                # full run in a throwaway headless GNOME Shell
```

`e2e.py` doesn't touch your session. It starts `gnome-shell --headless` on a private bus with a private dconf, enables the extension there, and plays `speech.wav` (about 30 s of you talking, any WAV) into a virtual mic. It then drives real keyboard and pointer input through Mutter's RemoteDesktop API: strokes, clicks, a pin, undo, the Area picker and Finish. Finally it checks both bundles. Results are written to `~/.local/share/sketchnote/captures/`.

## Uninstall

```sh
gnome-extensions disable sketchnote@local
rm ~/.local/share/gnome-shell/extensions/sketchnote@local ~/.local/share/dbus-1/services/org.sketchnote.Service.service
```
