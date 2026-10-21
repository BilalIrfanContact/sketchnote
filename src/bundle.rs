//! Turns a finished capture (events from the extension + raw recordings) into a bundle.
//!
//! Bundle layout (inside the capture's directory):
//!     recording.mp4        screen recording, 30 fps H.264
//!     audio.wav            microphone, 16 kHz mono
//!     frames-full/NN.png   full keyframe per mark, annotations burned in
//!     frames/frame-NN.png  the same keyframe cropped to the activity
//!     contact-sheet.png    cropped keyframes in rows of two, in order, with number badges
//!     summary.md           the notes that Ctrl+V / Alt+Shift+V paste
//!     sketchnote.json      capture data: timings, strokes, events, target, words, marks
//!     finish.json          what the extension sent on Finish, so a failed build can be retried
//!     error.txt            why the last build failed (removed once one succeeds)

use std::fs;
use std::path::Path;

use anyhow::Result;
use image::{DynamicImage, imageops};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::capture::{Capture, Word};
use crate::draw::{Mapper, contact_sheet, crop_box, draw_mark};
use crate::fix::Fix;
use crate::{media, notes};

/// Everything `build` needs besides the recordings, saved as `finish.json` on Finish.
#[derive(Serialize, Deserialize)]
pub struct Finished {
    pub capture: Capture,
    /// When the mic started (µs, monotonic).
    pub mic_t0: f64,
}

pub fn save_finished(dir: &Path, finished: &Finished) -> Result<()> {
    fs::write(dir.join("finish.json"), serde_json::to_string(finished)?)?;
    Ok(())
}

/// Writes the full bundle into `dir` from its `finish.json` and recordings. Safe to run
/// again after a failure: steps that already finished are redone or reused.
pub fn build(dir: &Path) -> Result<()> {
    let finished: Finished = serde_json::from_slice(&fs::read(dir.join("finish.json"))?)?;
    let (capture, audio_t0) = (&finished.capture, finished.mic_t0);
    let t0 = capture.t0;
    let video_offset = (capture.video_t0 - t0) / 1e6;
    let audio_offset = (audio_t0 - t0) / 1e6;
    let duration = (capture.end - t0) / 1e6;

    let video = dir.join("recording.mp4");
    // Converting deletes GNOME's raw recording, so on a retry it may be done already.
    if Path::new(&capture.video).exists() {
        media::convert_video(Path::new(&capture.video), &video)?;
    } else if !video.exists() {
        Err(Fix("The screen recording is missing, so this capture can't be built.".into()))?;
    }
    let video_size = media::probe_size(&video)?;

    let words: Vec<Word> = crate::transcribe(&dir.join("audio.wav"))?
        .into_iter()
        .map(|w| Word { start: w.start + audio_offset, end: w.end + audio_offset, ..w })
        .collect();
    let notes = notes::make_notes(&capture.events, &words, duration);

    fs::create_dir_all(dir.join("frames"))?;
    fs::create_dir_all(dir.join("frames-full"))?;
    let map = Mapper::new(capture.area, video_size);
    let mut tiles = vec![];
    for mark in &notes.marks {
        let mut frame = media::grab_frame(&video, mark.frame_t - video_offset)?;
        draw_mark(&mut frame, mark, &map);
        let (x0, y0, x1, y1) = crop_box(mark, capture.area, capture.pill, &map, video_size);
        let tile = imageops::crop_imm(&frame, x0, y0, x1 - x0, y1 - y0).to_image();
        let name = format!("frame-{:02}.png", mark.n);
        save_rgb(&frame, &dir.join("frames-full").join(&name))?;
        save_rgb(&tile, &dir.join("frames").join(&name))?;
        tiles.push((mark.n, tile));
    }
    save_rgb(&contact_sheet(&tiles), &dir.join("contact-sheet.png"))?;

    fs::write(dir.join("summary.md"), notes::summary(&notes))?;
    let data = json!({
        "duration": duration, "area": capture.area,
        "target": notes::main_target(capture), "video_offset": video_offset,
        "audio_offset": audio_offset, "events": capture.events, "words": words, "marks": notes.marks,
    });
    fs::write(dir.join("sketchnote.json"), serde_json::to_string_pretty(&data)?)?;
    Ok(())
}

/// PNGs without an alpha channel: smaller, and every pixel is opaque anyway.
fn save_rgb(img: &image::RgbaImage, path: &Path) -> Result<()> {
    DynamicImage::ImageRgba8(img.clone()).to_rgb8().save(path)?;
    Ok(())
}
