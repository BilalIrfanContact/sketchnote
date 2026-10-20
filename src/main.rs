//! sketchnote: show a coding agent the problem by talking and drawing on screen.
//!
//!     sketchnote service           run the D-Bus service (normally started by D-Bus activation)
//!     sketchnote latest            print the latest finished bundle's path
//!     sketchnote transcribe WAV    print a 16 kHz mono WAV's words with timestamps, as JSON

mod bundle;
mod capture;
mod draw;
mod media;
mod notes;
mod service;
mod transcribe;

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Result;

/// `$XDG_DATA_HOME/sketchnote`, i.e. usually `~/.local/share/sketchnote`.
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share"));
    base.join("sketchnote")
}

pub fn captures_dir() -> PathBuf {
    data_dir().join("captures")
}

/// Newest bundle that has finished building.
fn latest() -> Option<PathBuf> {
    let mut dirs: Vec<_> = std::fs::read_dir(captures_dir()).ok()?.flatten().map(|e| e.path()).collect();
    dirs.sort();
    dirs.into_iter().rev().find(|d| d.join("summary.md").exists())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result: Result<()> = match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["service"] => service::run(),
        ["latest"] => {
            println!("{}", latest().map(|p| p.display().to_string()).unwrap_or_default());
            Ok(())
        }
        ["transcribe", wav] => transcribe::words(wav.as_ref())
            .and_then(|w| Ok(serde_json::to_string_pretty(&w)?))
            .map(|json| println!("{json}")),
        _ => {
            eprintln!("usage: sketchnote service | latest | transcribe WAV");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("sketchnote: {e:#}");
            ExitCode::FAILURE
        }
    }
}
