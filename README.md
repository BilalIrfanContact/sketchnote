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

- Builds the `sketchnote` binary with cargo and downloads the speech model (Whisper `small`, 264 MB, unless you've picked another) and a voice detector into `~/.local/share/sketchnote/models/`.
- Symlinks `extension/sketchnote@local` into `~/.local/share/gnome-shell/extensions/` and enables it.
- Writes a D-Bus activation file so the service starts on demand.

It is safe to re-run.

### Choosing the speech model

Transcription runs on your CPU with a whisper.cpp model. To use another one, create `~/.config/sketchnote/config.toml`:

```toml
[local]
model = "large-v3-turbo-q8_0"
```

then run `./target/release/sketchnote download-model` (or `./install.sh` again) to download it. The next capture uses it; nothing needs restarting. Names are a size (`tiny`, `base`, `small`, `medium`, `large-v3`, `large-v3-turbo`), optionally `.en` for an English-only model and `-q5_0`/`-q5_1`/`-q8_0` for a smaller file, as listed on [Hugging Face](https://huggingface.co/ggerganov/whisper.cpp/tree/main). Bigger models hear you better and take longer: on a laptop CPU, 30 s of speech took 2 s with `tiny-q8_0` and 26 s with the default `small-q8_0`.

### Transcribing through an API instead

A transcription API runs a bigger model in about a second, so you get better notes without waiting on your CPU. It sends the **microphone recording** (never the screen recording) to that provider. Any OpenAI-compatible server works if its model returns word timings, which the notes need:

| Provider | `url` | `model` | Price |
|---|---|---|---|
| [Groq](https://console.groq.com) (default) | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo`, or `whisper-large-v3` for a little more accuracy | about $0.04 per hour of audio |
| OpenAI | `https://api.openai.com/v1` | `whisper-1` (OpenAI shuts it down on 2027-02-26; its newer models give no word timings) | $0.36 per hour |
| [Speaches](https://github.com/speaches-ai/speaches) on your own machine | e.g. `http://localhost:8000/v1` | e.g. `Systran/faster-whisper-large-v3` | free |

```toml
transcriber = "api"

[api]
url = "https://api.groq.com/openai/v1"
model = "whisper-large-v3-turbo"
```

Then run `./target/release/sketchnote set-key` and paste your API key. It's stored in your desktop keyring (GNOME Keyring), one per `url`, never in the config file; leave it empty to remove it. If the provider rejects the key, runs out of credit or can't be reached, the notification says so, and Retry tries again once you've fixed it. `transcriber = "local"` (or no line at all) goes back to the model on your machine.

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

Starting a capture starts the microphone at once and the screen recorder within a second or two. The pill at top centre always says which state it's in:

- **Starting…** with a grey dot: the screen recorder isn't running yet.
- **Recording**: a red dot, the timer and a green mic level bar that follows your voice, a red glow around the screen, and a stop icon in the top bar. The bar uses a fixed −60 to 0 dBFS scale like system sound meters, so if it sits high while you're quiet, your input is noisy or its gain is too high.
- **Mic is silent** in amber next to the timer: the mic has recorded only digital silence for the last 3 seconds (muted, or the wrong or a disconnected input). It clears as soon as sound comes in.
- The pill has **Undo / Cancel / Finish**.

After Finish, the pill stays up with an amber dot: **Saving…**, then **Transcribing…** (about 10 s for 20 s of speech on CPU). It turns green with **Ready · Ctrl+V to paste** when the notes are on the clipboard, then hides after a few seconds. If building fails, the pill says so and a notification gives the reason in plain words (say, the speech model is missing) with a **Retry** button. The recordings are kept, so Retry builds the same capture again once you've fixed the cause. The notification stays in the message tray until you dismiss it. Press Ctrl+V in your agent's input box: the extension pastes the notes, swaps the clipboard to the contact sheet and pastes again, so you get the text and the image from one key press. Each is an ordinary paste, so this works in any app that accepts pasted text and images. Once you copy something else, Ctrl+V is normal again; Alt+Shift+V pastes the latest capture whenever you want it back.

CLI: `target/release/sketchnote latest | service | transcribe file.wav`.

## Output

Each capture is a folder `~/.local/share/sketchnote/captures/<timestamp>.bundle/`:

| File | Contents |
|---|---|
| `recording.mp4` | Screen recording, H.264, 30 fps |
| `audio.wav` | Microphone, 16 kHz mono |
| `frames/frame-NN.png` | Keyframe per mark, cropped to the activity, annotations burned in |
| `frames-full/frame-NN.png` | The same keyframes uncropped |
| `contact-sheet.png` | Cropped keyframes in rows of two, in note order, with number badges |
| `summary.md` | The handoff text, pasted by Ctrl+V or Alt+Shift+V |
| `sketchnote.json` | Timings, strokes, clicks, pins, target window, word timestamps, marks |
| `finish.json` | What the extension sent on Finish, so a failed build can be retried |
| `error.txt` | Only after a failed build: the full error behind the notification |

`summary.md` looks like this:

```
- #1 (0:04) “This footer has too much text, let's cut it down.”
- (0:08) [clicked]
- #2 (0:10) “And the model name here is out of date.”
- #3 (0:11) [clicked] “This button should open the settings instead.”
```

## Privacy

A capture records your **whole screen** (every monitor, whatever is on it) and your **microphone**, from Alt+Shift+S until you finish or cancel. By default everything stays on your machine: transcription runs locally, and nothing is uploaded. Only what you paste leaves, and only to wherever you paste it. If you [switch to a transcription API](#transcribing-through-an-api-instead), each capture's microphone recording is sent to that provider to be transcribed, under its own data policy; the screen recording and images still never leave.

Captures are kept for **one day**. The service deletes any capture folder that hasn't changed in 24 hours, checking when it starts and every hour after. Cancelling a capture deletes it straight away. To delete everything sooner, remove `~/.local/share/sketchnote/captures/`. The retention period is `KEEP_CAPTURES` in `src/service.rs`; there's no settings UI.

## How it's built

- **`extension/sketchnote@local/extension.js`** (GNOME Shell extension). It handles the hotkey, glow, pill, live ink, pins, click logging, undo and cancel. It records the screen through GNOME Shell's own Screencast service. Only the Shell may call that service, so there's no portal prompt and the recording code lives in the extension.
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
- **Whole screen only.** A capture always records the whole screen, all monitors as one image, so you can switch apps freely. There's no Area or Window mode; the contact sheet already crops each keyframe around your marks. There's no iPhone mode.
- **Marks.** Every stroke and pin is a numbered mark. A click is numbered only if something you said lands on it; otherwise it's listed as an unnumbered `- (0:07) [clicked]` line with no keyframe, unless the capture has only clicks and none were spoken about, in which case they're all numbered. Speech is kept as whole sentences: each sentence goes to the mark it overlaps most in time, counting from that mark until the next. A sentence is split at a mark only where you paused for 1 s or more, as when you circle three things saying "this part, … this part, … and this part". Words spoken before the first mark go to #1. If the transcript has no punctuation, words are split at marks by time. With no marks, the whole capture is one note keyed on the last frame.
- **Note tags.** Clicks are tagged `[clicked]` and pins `[pin]`.
- **Pins.** A red dot that fades like strokes. It shows no number while you record, because numbers are only final once the notes are built (a click nobody spoke about loses its number); the keyframes show the real number.
- **Undo.** Removes the last stroke or pin. Clicks can't be undone.
- **Fade timing.** Strokes stay 0.5 s, then fade over 1 s.
- **Clicks on screen.** Not shown live. Clicks on the pill or the top bar aren't logged.
- **Keyframes.** Taken 0.1 s after a stroke ends (or a click or pin lands). The crop is the activity's bounding box plus 160 px, at least 640×400, clamped to the window under the activity.
- **Notes only.** `summary.md` is just the numbered notes; Scrawl's header, crop and attachment lines are left out because the image is pasted alongside. The target app and window are still in `sketchnote.json`.
- **After Finish.** A status pill (Saving… / Transcribing… / Ready) instead of a notification. Scrawl shows nothing, but local transcription takes a while.
- **Esc and Ctrl+Z.** Grabbed globally, but only while a capture runs.

## Known limitations

- **Space is reserved while capturing.** Space is grabbed globally during a capture, so you can't type spaces into apps until you finish or cancel. Scrawl uses Shift; Space was chosen here so Shift keeps working in apps.
- **The recording shows Sketchnote's own UI.** GNOME's screencast records everything on screen, and GNOME Shell can't hide one of its actors from it, so `recording.mp4` includes the pill, the glow and the live strokes. Keyframe crops start below the pill when the mark is below it, and are trimmed off the red edge glow up to the mark's own edge; a mark right next to the pill keeps it in view. The strokes in the keyframes are redrawn on top in the same spot.
- **Pill placement.** The pill sits on the primary monitor.
- **Recording start lag.** GNOME's screencast takes about 0.5–2 s to start, so the first moment after the hotkey may be missing from `recording.mp4`; the pill says **Starting…** until it's running. The mic starts within about 0.1 s, and both offsets are stored and applied. I've seen it take 14 s once. If you cancel or finish and immediately start again, the new capture waits for the previous recording to stop before it starts recording.
- **Missed clicks.** Clicks are detected by polling every 10 ms, so a press shorter than that could be missed.
- **Heavy work runs niced.** Building a bundle runs at nice 10, and transcription uses half the CPU cores, so the desktop stays responsive.
- **CPU transcription, English only.** It takes roughly 0.5× real time. The language is fixed to English, because auto-detection was slower and sometimes picked the wrong language. See [Choosing the speech model](#choosing-the-speech-model) to trade speed for accuracy. `sketchnote transcribe file.wav` prints a recording's words with timestamps.

## Tests

```sh
cargo test                             # bundle logic (marks, speech split, crops, layout)
tests/e2e.py speech.wav                # full run in a throwaway headless GNOME Shell
```

CI (`.github/workflows/ci.yml`) runs `cargo fmt --check`, clippy with warnings as errors and `cargo test` on every PR, and syntax-checks the extension and scripts. `e2e.py` needs GNOME Shell, so run it locally before merging extension changes.

`e2e.py` doesn't touch your session. It starts `gnome-shell --headless` on a private bus with a private dconf, enables the extension there, and plays `speech.wav` (about 30 s of you talking, any WAV) into a virtual mic. It then drives real keyboard and pointer input through Mutter's RemoteDesktop API: strokes, clicks, a pin, undo, cancel-and-restart and Finish. Finally it checks the bundles and the paste. Results are written to `~/.local/share/sketchnote/captures/`.

## Uninstall

```sh
gnome-extensions disable sketchnote@local
rm ~/.local/share/gnome-shell/extensions/sketchnote@local ~/.local/share/dbus-1/services/org.sketchnote.Service.service
```
