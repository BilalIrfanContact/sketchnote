# Moving the service from Python to Rust

**Date:** 2026-10-21 · **Commits:** `ef7224d`, `74c505e`, `af89ece`, `a07ae42`

## What I found

The background service (mic recording, transcription, bundle building) was Python: PyGObject for D-Bus, Pillow for images and faster-whisper in a 463 MB venv. That works on my machine but can't be shipped to other Linux users as one download. The GNOME extension stays JavaScript; only the service moved.

## Decision

Rewrite the service in Rust with the same D-Bus interface (`org.sketchnote.Service`: Start, Finish, Cancel, BundleReady), so the extension didn't change. Transcription runs in-process through whisper.cpp (`whisper-rs`), images through `tiny-skia` and `image`, D-Bus through `zbus`. ffmpeg, `pw-record` and `notify-send` are still called as subprocesses.

## What changed beyond a straight port

Measured on two of my real captures (about 23 s and 21 s of audio), CPU only:

| Setting | Clip A | Clip B |
|---|---|---|
| whisper.cpp, auto language, beam search | 19.2 s, no punctuation | 30.2 s, Urdu text looping |
| whisper.cpp, English, greedy | 11.2 s, correct and punctuated | 10.3 s, correct English |
| more threads (8) or OpenMP | no faster | no faster |

- **English only.** Auto-detection added ~8 s and picked Urdu on clip B, then repeated one phrase. Forcing English fixed both.
- **DTW word timestamps.** whisper.cpp's default word times were up to ~2 s off (e.g. the first word at 0.0 s instead of 2.2 s), which would put words in the wrong note. DTW timing lands within ~0.3 s of faster-whisper's.
- **Prompt.** Without one, the e2e speech came out lowercase and unpunctuated ("entire Xbox"). With "Okay, so here's the bug. This button should open the settings page." it came out as "entire text box basically. I don't like this."
- **`[BLANK_AUDIO]` filtered.** whisper.cpp emits it for silence; it used to appear as a quoted note.
- **One build at a time.** The e2e test showed that a long capture finishing after a short one replaced the newest capture on the clipboard. Builds now run in finish order.

## Result

- `tests/e2e.py` passes against the Rust service: three captures, the cancel-and-restart case, and Ctrl+V / Alt+Shift+V pasting.
- `cargo test`: the 6 ported unit tests pass.
- The service is one binary plus a 264 MB model and an 885 KB voice-activity model. Building needs Rust and `cmake`.

## Tradeoffs and limitations

- Transcription is about 2× slower than faster-whisper with English forced (~10 s vs ~4.6 s for clip B), because whisper.cpp's CPU path is slower than CTranslate2's int8 path here.
- English only until there's a language setting.
- DTW word starts run ~0.3 s late; fine for splitting speech between marks seconds apart.
- Not yet tested in my real session with my real mic.
