//! sketchnote: show a coding agent the problem by talking and drawing on screen.
//!
//!     sketchnote service           run the D-Bus service (normally started by D-Bus activation)
//!     sketchnote latest            print the latest finished bundle's path
//!     sketchnote transcribe WAV    print a 16 kHz mono WAV's words with timestamps, as JSON
//!     sketchnote download-model    download the speech model set in config.toml, if missing
//!     sketchnote set-key           store the API key for the [api] url in config.toml

mod api;
mod bundle;
mod capture;
mod config;
mod draw;
mod fix;
mod key;
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

fn configured_model() -> Result<transcribe::Model> {
    transcribe::Model::parse(&config::load()?.local.model)
}

/// A WAV's words with timestamps, from the transcriber set in config.toml.
pub fn transcribe(wav: &std::path::Path) -> Result<Vec<capture::Word>> {
    let config = config::load()?;
    match config.transcriber {
        config::Transcriber::Local => transcribe::words(wav, &transcribe::Model::parse(&config.local.model)?),
        config::Transcriber::Api => api::words(wav, &config.api),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result: Result<()> = match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["service"] => service::run(),
        ["latest"] => {
            println!("{}", latest().map(|p| p.display().to_string()).unwrap_or_default());
            Ok(())
        }
        ["transcribe", wav] => {
            transcribe(wav.as_ref()).and_then(|w| Ok(serde_json::to_string_pretty(&w)?)).map(|json| println!("{json}"))
        }
        ["download-model"] => configured_model().and_then(|model| transcribe::download(&model)),
        ["set-key"] => config::load().and_then(|config| key::set_interactively(&config.api.url)),
        _ => {
            eprintln!("usage: sketchnote service | latest | transcribe WAV | download-model | set-key");
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
