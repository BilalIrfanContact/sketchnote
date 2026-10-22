# Sketchnote anatomy

The studio explains how one capture becomes a paste. The extension directs the set, GNOME Screencast is the camera, pw-record records the microphone, and the Rust service edits in the back room. Installation, setup and updates are outside this drawing.

## Browse

Open `sketchnote-light.html` or `sketchnote.html`. Both work offline. Hover or focus a part to inspect it. Seven step buttons follow Start → Record → Draw → Finish → Build → Ready → Paste. Local model, API and API fails select the transcription route. Arrow keys change steps. Reduced-motion preferences stop autoplay.

`sketchnote-tour-light.html` is the README animation's labeled version. Eleven callouts connect each prop to its real component, one at a time. Each stop lasts 2.8 seconds, including a short entrance and exit, for a 30.8-second loop. The sequence explains responsibilities, not measured processing time or strictly serial execution. The exported tour shows local transcription; the interactive page also explains the optional API route.

## Rebuild

```sh
node docs/anatomy/build.mjs
node docs/anatomy/build.mjs --light
node docs/anatomy/build.mjs --tour
node docs/anatomy/build.mjs --light --tour
node docs/anatomy/export.mjs
```

The builder uses the anatomy kit at `~/.agents/skills/anatomy`; set `ANATOMY_KIT` to override it. The generated HTML files have no runtime dependencies and are ignored by Git. The exporter requires Node 22+, Chrome or Chromium, and ffmpeg. Set `CHROME_PATH` if Chrome is outside the default paths. No npm install is needed.

The exporter seeks the browser timeline frame by frame at 25 fps, captures the drawing and callout, and encodes a looping GIF with 64 colors and rectangle differencing. It writes `docs/images/anatomy-light.gif`, refreshes the PNG fallback and saves one screenshot per stop under local-only `shots/`. Its optional first argument overrides the GIF output path. `window.sketchnoteTour.seek(seconds)` drives the same animation for inspection and export.

## Verification

Check every callout for readable text and the correct prop. Inspect the GIF at README width, its transition back to the start, both interactive themes, the API-failure route, keyboard controls and reduced motion. Verify the GIF's dimensions, duration and frame delays with ffprobe or Pillow. Capture and inspect a 390px layout for overflow.

The inherited illustration uses hand-sorted assemblies. It has not passed the anatomy kit's full 3D collision/depth audit and is not a mechanical model. The line-end check can be run with the anatomy skill's `scripts/lines.mjs`.

No capture, clipboard, keyring, installer or service operation runs from these pages.
