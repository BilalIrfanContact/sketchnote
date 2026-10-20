//! sketchnote: show a coding agent the problem by talking and drawing on screen.
//!
//!     sketchnote transcribe WAV    print a 16 kHz mono WAV's words with timestamps, as JSON

#![allow(dead_code)] // the service that uses these lands next

mod capture;
mod draw;
mod notes;
mod transcribe;

use std::path::PathBuf;

/// `$XDG_DATA_HOME/sketchnote`, i.e. usually `~/.local/share/sketchnote`.
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share"));
    base.join("sketchnote")
}

fn main() -> anyhow::Result<()> {
    let wav = std::env::args().nth(2).expect("usage: sketchnote transcribe WAV");
    println!("{}", serde_json::to_string_pretty(&transcribe::words(wav.as_ref())?)?);
    Ok(())
}
