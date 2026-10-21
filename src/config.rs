//! User settings from `$XDG_CONFIG_HOME/sketchnote/config.toml`, usually
//! `~/.config/sketchnote/config.toml`. Every key is optional and a missing file means
//! the defaults. It's read at the start of each build, so edits apply to the next capture.
//!
//!     [local]
//!     model = "small-q8_0"    # whisper.cpp model, see transcribe::Model

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::fix::Fix;

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub local: Local,
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
    }
}
