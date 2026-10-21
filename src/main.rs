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

/// A WAV's words with timestamps, from the transcriber set in config.toml. If the API
/// fails, the local model transcribes it instead, and the second value says why.
pub fn transcribe(wav: &std::path::Path) -> Result<(Vec<capture::Word>, Option<String>)> {
    let config = config::load()?;
    let local = || transcribe::words(wav, &transcribe::Model::parse(&config.local.model)?);
    match config.transcriber {
        config::Transcriber::Local => Ok((local()?, None)),
        config::Transcriber::Api => or_local(api::words(wav, &config.api), local),
    }
}

/// `api`'s words, else `local`'s with a sentence for the user saying why the API wasn't
/// used. If both fail, the API's error: fixing it is what the user set out to do.
fn or_local<W>(api: Result<W>, local: impl FnOnce() -> Result<W>) -> Result<(W, Option<String>)> {
    let e = match api {
        Ok(words) => return Ok((words, None)),
        Err(e) => e,
    };
    eprintln!("transcription API failed, using the local model: {e:#}");
    let reason =
        fix::known(&e).unwrap_or_else(|| "Something unexpected went wrong; the details are in the journal.".into());
    match local() {
        Ok(words) => Ok((
            words,
            Some(format!("The transcription API failed, so this capture was transcribed on this computer. {reason}")),
        )),
        Err(local_e) => Err(e.context(format!("the local model failed too: {local_e:#}"))),
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
        ["transcribe", wav] => transcribe(wav.as_ref()).and_then(|(words, warning)| {
            if let Some(warning) = warning {
                eprintln!("sketchnote: {warning}");
            }
            println!("{}", serde_json::to_string_pretty(&words)?);
            Ok(())
        }),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fix::Fix;

    #[test]
    fn a_failed_api_falls_back_to_the_local_model_and_says_why() {
        let offline = || Err(anyhow::anyhow!("dns error").context(Fix("Couldn't reach api.groq.com.".into())));
        assert_eq!(or_local(Ok(1), || panic!("local model used")).unwrap(), (1, None));

        let (words, warning) = or_local(offline(), || Ok(2)).unwrap();
        assert_eq!(words, 2);
        assert!(warning.unwrap().ends_with("transcribed on this computer. Couldn't reach api.groq.com."));

        // Both failed: the user sees the API's fix, and error.txt gets both errors.
        let e = or_local::<i32>(offline(), || Err(anyhow::anyhow!("model missing"))).unwrap_err();
        assert_eq!(fix::explain(&e, "error.txt"), "Couldn't reach api.groq.com.");
        assert!(format!("{e:#}").contains("the local model failed too: model missing"));
    }
}
