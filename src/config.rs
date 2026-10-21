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
}
