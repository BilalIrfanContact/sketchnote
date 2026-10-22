//! `sketchnote setup`: the first-run steps after install.sh, on the terminal. Checks the
//! extension, downloads the speech models, checks the mic, asks local or API (and takes
//! the key), and says what gets recorded. Safe to re-run; advanced settings stay in
//! config.toml.

use std::io::{BufRead, Write};
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, Result};

use crate::config::{self, Transcriber};
use crate::media::Mic;
use crate::{key, transcribe};

const UUID: &str = "sketchnote@local";

pub fn run() -> Result<()> {
    println!("== GNOME Shell extension");
    let active = extension_active();
    if active {
        println!("Active.");
    } else {
        println!("Not active yet. Log out and back in once: GNOME on Wayland only loads new extensions at login.");
    }

    println!("\n== Speech models");
    let config = config::load()?;
    transcribe::download(&transcribe::Model::parse(&config.local.model)?)?;
    println!("Ready.");

    println!("\n== Microphone");
    check_mic()?;

    println!("\n== Transcription");
    let api = choose_transcriber(&config)?;

    println!("\n== What Sketchnote records");
    println!(
        "A capture records your whole screen (every monitor) and your microphone, from Alt+Shift+S until you finish or cancel."
    );
    match api {
        Some(host) => println!(
            "The microphone recording is sent to {host} to be transcribed, under its data policy. The screen recording and images never leave this computer."
        ),
        None => println!("Transcription runs on this computer, so nothing is uploaded."),
    }
    println!(
        "Only what you paste leaves, wherever you paste it. Captures are deleted after a day, from {}.",
        crate::captures_dir().display()
    );

    println!();
    if active {
        println!("All set. Press Alt+Shift+S to start a capture.");
    } else {
        println!("All set. Log out and back in once, then press Alt+Shift+S to start a capture.");
    }
    Ok(())
}

fn extension_active() -> bool {
    Command::new("gnome-extensions")
        .args(["info", UUID])
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).lines().any(|l| l.trim() == "State: ACTIVE"))
}

/// Records 3 s with a live level bar, then says whether anything was heard.
fn check_mic() -> Result<()> {
    let dir = tempfile_dir()?;
    let wav = dir.join("mic-check.wav");
    println!("Say something for 3 seconds…");
    let mic = Mic::start(&wav)?;
    for _ in 0..30 {
        std::thread::sleep(Duration::from_millis(100));
        let bars = (Mic::level(&wav).unwrap_or(0.0) * 30.0).round() as usize;
        print!("\r  [{:<30}]", "#".repeat(bars.min(30)));
        std::io::stdout().flush()?;
    }
    println!();
    mic.stop();
    let silent = Mic::is_silent(&wav).unwrap_or(true);
    let _ = std::fs::remove_dir_all(&dir);
    if silent {
        println!(
            "The mic only recorded silence. Check the input device and its volume in Settings → Sound, then run setup again."
        );
    } else {
        println!("Heard you.");
    }
    Ok(())
}

fn tempfile_dir() -> Result<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!("sketchnote-setup-{}", std::process::id()));
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir)
}

/// Asks local or API, saves the choice, and takes the API key. Returns the API's host
/// if the API was chosen.
fn choose_transcriber(config: &config::Config) -> Result<Option<String>> {
    let api_now = config.transcriber == Transcriber::Api;
    let host = crate::api::host(&config.api.url);
    println!("Transcribe on this computer (local), or through a transcription API ({host}, faster and more accurate)?");
    print!("{}", if api_now { "[local/API]: " } else { "[LOCAL/api]: " });
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    let api = match answer.trim().to_lowercase().as_str() {
        "" => api_now,
        "api" | "a" => true,
        "local" | "l" => false,
        other => anyhow::bail!("\"{other}\" isn't local or api. Run setup again."),
    };
    if api != api_now {
        config::set_transcriber(if api { "api" } else { "local" })?;
        println!("Saved in {}.", config::path().display());
    }
    if !api {
        return Ok(None);
    }
    println!("The API's url and model are in {}; the default is Groq.", config::path().display());
    if key::get(&config.api.url)?.is_some() {
        println!("A key for {} is already in your keyring. To change it, run `sketchnote set-key`.", config.api.url);
    } else {
        key::set_interactively(&config.api.url)?;
    }
    Ok(Some(host))
}
