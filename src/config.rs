//! User settings from `$XDG_CONFIG_HOME/sketchnote/config.toml`, usually
//! `~/.config/sketchnote/config.toml`. Every key is optional and a missing file means
//! the defaults. It's read at the start of each build, so edits apply to the next capture.
//!
//!     transcriber = "local"   # "local" (on this machine) or "api" (a transcription API)
//!
//!     [local]
//!     model = "small-q8_0"    # whisper.cpp model, see transcribe::Model
//!
//!     [api]                   # any OpenAI-compatible server, see api.rs
//!     url = "https://api.groq.com/openai/v1"
//!     model = "whisper-large-v3-turbo"

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::fix::Fix;

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub transcriber: Transcriber,
    pub local: Local,
    pub api: Api,
}

#[derive(Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transcriber {
    #[default]
    Local,
    Api,
}

/// The built-in transcriber.
#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Local {
    pub model: String,
}

impl Default for Local {
    fn default() -> Self {
        Local { model: "small-q8_0".into() }
    }
}

/// A transcription API. Groq by default: it's fast, cheap and returns word timings.
#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Api {
    pub url: String,
    pub model: String,
}

impl Default for Api {
    fn default() -> Self {
        Api { url: "https://api.groq.com/openai/v1".into(), model: "whisper-large-v3-turbo".into() }
    }
}

pub fn path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"));
    base.join("sketchnote/config.toml")
}

pub fn load() -> Result<Config> {
    let path = path();
    match std::fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
        Ok(text) => parse(&text).map_err(|e| {
            Fix(format!("{} has a mistake: {}. Fix it, then retry.", path.display(), e.message().trim())).into()
        }),
    }
}

/// Sets the top-level `transcriber` in config.toml to `value`, keeping everything else.
pub fn set_transcriber(value: &str) -> Result<()> {
    let path = path();
    let text = match std::fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        result => result.with_context(|| format!("reading {}", path.display()))?,
    };
    let text = with_transcriber(&text, value);
    parse(&text).with_context(|| format!("updating {}", path.display()))?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))
}

/// `text` with its top-level `transcriber = …` line replaced, or added at the top.
fn with_transcriber(text: &str, value: &str) -> String {
    let line = format!("transcriber = \"{value}\"");
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    let top_level = lines.iter().position(|l| l.trim_start().starts_with('[')).unwrap_or(lines.len());
    let is_key = |l: &str| l.split('=').next().is_some_and(|k| k.trim() == "transcriber");
    match lines[..top_level].iter().position(|l| is_key(l)) {
        Some(i) => lines[i] = line,
        None => lines.insert(0, line),
    }
    lines.join("\n") + "\n"
}

fn parse(text: &str) -> Result<Config, toml::de::Error> {
    toml::from_str(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_keys_use_defaults_and_typos_are_errors() {
        assert_eq!(parse("").unwrap().local.model, "small-q8_0");
        assert_eq!(parse("[local]\nmodel = \"large-v3-turbo-q8_0\"").unwrap().local.model, "large-v3-turbo-q8_0");
        assert!(parse("[local]\nmodle = \"tiny\"").is_err());
        let api = parse("transcriber = \"api\"\n[api]\nmodel = \"whisper-1\"").unwrap();
        assert_eq!(api.transcriber, Transcriber::Api);
        assert_eq!((api.api.url.as_str(), api.api.model.as_str()), ("https://api.groq.com/openai/v1", "whisper-1"));
    }

    #[test]
    fn setting_the_transcriber_keeps_the_rest_of_the_file() {
        assert_eq!(with_transcriber("", "api"), "transcriber = \"api\"\n");
        let file = "# mine\ntranscriber = \"api\"\n\n[api]\nmodel = \"whisper-large-v3\"";
        assert_eq!(
            with_transcriber(file, "local"),
            "# mine\ntranscriber = \"local\"\n\n[api]\nmodel = \"whisper-large-v3\"\n"
        );
        // Only top-level counts: a `transcriber` inside a table isn't the setting.
        assert_eq!(
            with_transcriber("[local]\nmodel = \"tiny\"", "api"),
            "transcriber = \"api\"\n[local]\nmodel = \"tiny\"\n"
        );
    }
}
