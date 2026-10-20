# AGENTS.md

## Project overview

Sketchnote is a Linux (GNOME 50, Wayland) take on [Scrawl](https://scrawl.kitlangton.com/). Press Alt+Shift+S, talk, hold Space to draw on the screen, then finish and paste the result into a coding agent. One Ctrl+V pastes timestamped notes and a contact sheet of cropped, annotated keyframes.

It has two halves that talk over D-Bus (`org.sketchnote.Service`):

- **GNOME Shell extension** (`extension/sketchnote@local/extension.js`, GJS). Hotkey, edge glow, pill, live ink, pins, click logging, screen recording through GNOME Shell's Screencast service, and the one-key paste. It has to stay JavaScript inside the Shell; that's what avoids portal prompts and lets it draw over apps and paste.
- **Rust service** (`src/`, the `sketchnote` binary). Records the mic with `pw-record`, transcribes in-process with whisper.cpp through `whisper-rs` (`small` q8_0, English, CPU, DTW word timestamps), and builds the bundle in `~/.local/share/sketchnote/captures/`. Models live in `~/.local/share/sketchnote/models/`.

`README.md` covers usage, output format, and the decisions made where Scrawl's behaviour was unknown.

## Workspace and external tools

- Default working directory: `/home/biloo0/Projects/Scrawl/sketchnote`. This folder is the git repo.
- Keep code and git changes inside this repository. Treat external dependencies and services as read-only unless the user explicitly asks for an external change.
- The Scrawl demo video and `../work/` were inspiration only. Never copy or commit anything from them (frames, transcript, audio, spec text).
- When committing, avoid very large single commits; prefer smaller commits wherever possible.

## Local development commands

```bash
./install.sh                          # cargo build, models, extension symlink, D-Bus activation file; safe to re-run
cargo test                            # bundle logic
cargo fmt && cargo clippy --release --all-targets -- -D warnings   # CI fails on either
./target/release/sketchnote transcribe audio.wav   # words + timestamps, for tuning transcription
tests/e2e.py speech.wav               # full run in a throwaway headless GNOME Shell
./target/release/sketchnote latest    # newest bundle path
```

Applying changes:

- **Rust service:** `cargo build --release`, then restart it when no capture is running (`pkill -f "/sketchnote service$"`); D-Bus starts it again on demand.
- **Extension:** GNOME on Wayland only reloads extensions at login, so the user must log out and back in. Test extension changes in the headless shell via `tests/e2e.py` first, and say clearly when a change needs a logout.

Do not run dependency installation or other expensive setup commands unless verification requires them or the user explicitly requests them. The e2e test never touches the user's real session; anything that does (clipboard, gsettings, restarting the service) should be mentioned to the user.

## Feature smoke testing

- When a feature or fix is implemented, update local `TESTING.md` with a short workflow-level smoke test for it (e.g. "Alt+Shift+S, draw a loop, finish, Ctrl+V in Brave: notes and image arrive").
- Keep tests focused on whether the real workflow works end to end on the user's desktop.
- Do not fill `TESTING.md` with tiny checks unless they are central to the workflow.
- Keep `TESTING.md` local-only. Git ignores it.

## Build journal

Sketchnote keeps an engineering journal under `docs/build-journal/`.

After completing and verifying a meaningful product or engineering milestone, create or update one journal entry. Do not create entries for minor refactors, formatting, dependency updates, file moves, or unfinished work.

Write entries from Bilal's first-person perspective. Record what he found, the previous behavior, evidence from before the change, the decision, alternatives genuinely considered, what changed, resulting behavior, evidence from after the change, tradeoffs, limitations, and lessons.

Take before-and-after screenshots or contact sheets when visible behavior changes. Inspect and redact every image before committing it. Captures record the whole screen and the mic, so never expose secrets, private windows, personal voice recordings, contact details, or PII.

Add a small Mermaid diagram when it makes a data flow, state transition, failure path, or architecture change easier to understand. Do not add diagrams for decoration.

Use exact measurements when available (e.g. transcription seconds per clip, Shell stall time). If something was not measured, write `Not measured.` Never invent metrics or claim an improvement based only on an implementation change.

Link relevant tests, source files, issues, pull requests, and commits. Do not paste full diffs or large logs into the journal.

The journal is factual source material. Polished X posts and blog articles should be written later from verified entries.
