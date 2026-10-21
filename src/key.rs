//! Transcription API keys, kept in the desktop keyring (GNOME Keyring, KWallet, ... through
//! the Secret Service), one per API url, never in config.toml.

use std::io::{BufRead, Write};

use anyhow::Result;
use keyring_core::{Entry, Error};

use crate::fix::Fix;

fn entry(url: &str) -> Result<Entry> {
    let unavailable = |e: Error| -> anyhow::Error {
        anyhow::Error::new(e).context(Fix(
            "Couldn't open the desktop keyring, where the API key is kept. Make sure it's unlocked, then retry.".into(),
        ))
    };
    if keyring_core::get_default_store().is_none() {
        keyring_core::set_default_store(zbus_secret_service_keyring_store::Store::new().map_err(unavailable)?);
    }
    Entry::new("sketchnote", url).map_err(unavailable)
}

/// The key stored for `url`, or `None` (a server without authentication).
pub fn get(url: &str) -> Result<Option<String>> {
    match entry(url)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow::Error::new(e).context(Fix(
            "Couldn't read the API key from the desktop keyring. Make sure it's unlocked, then retry.".into(),
        ))),
    }
}

/// Asks for the key for `url` on the terminal, without echoing it, and stores it.
/// An empty answer removes the stored key.
pub fn set_interactively(url: &str) -> Result<()> {
    print!("API key for {url} (input hidden, empty to remove): ");
    std::io::stdout().flush()?;
    let key = without_echo(|| {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line).map(|_| line)
    })?;
    println!();
    let entry = entry(url)?;
    match key.trim() {
        "" => match entry.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => println!("Removed the key for {url}."),
            Err(e) => return Err(e.into()),
        },
        key => {
            entry.set_password(key)?;
            println!("Saved the key for {url} in your keyring.");
        }
    }
    Ok(())
}

/// Runs `read` with terminal echo off, if stdin is a terminal.
fn without_echo<T>(read: impl FnOnce() -> std::io::Result<T>) -> std::io::Result<T> {
    let mut term = unsafe { std::mem::zeroed::<libc::termios>() };
    let tty = unsafe { libc::tcgetattr(0, &mut term) } == 0;
    if tty {
        let mut quiet = term;
        quiet.c_lflag &= !libc::ECHO;
        unsafe { libc::tcsetattr(0, libc::TCSANOW, &quiet) };
    }
    let result = read();
    if tty {
        unsafe { libc::tcsetattr(0, libc::TCSANOW, &term) };
    }
    result
}
