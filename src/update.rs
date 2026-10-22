//! `sketchnote update`: replaces this install with the latest GitHub release, where
//! install.sh put it. Everything is downloaded before anything is replaced, and the
//! binary goes last, so a failed update leaves the old install whole. Models already on
//! disk are kept, and the D-Bus file is left alone (it never changes).

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, ensure};

use crate::fix::Fix;
use crate::{config, setup, transcribe};

/// The release this binary was built from (the tag without its `v`), or "dev" when built
/// from source.
pub const VERSION: &str = match option_env!("SKETCHNOTE_VERSION") {
    Some(v) => v,
    None => "dev",
};
const REPO: &str = "BilalIrfanContact/sketchnote";

pub fn run() -> Result<()> {
    if VERSION == "dev" {
        Err(Fix(
            "This sketchnote was built from source, so it updates from git: git pull, then ./build-from-source.sh."
                .into(),
        ))?;
    }
    let tag = latest_tag()?;
    let latest = tag.trim_start_matches('v');
    if !newer(latest, VERSION) {
        println!("Already up to date ({VERSION}).");
        return Ok(());
    }
    println!("Updating {VERSION} → {latest}");
    let url = |name: &str| format!("https://github.com/{REPO}/releases/download/{tag}/{name}");

    let exe = std::env::current_exe().context("finding this binary")?;
    let new_exe = exe.with_file_name("sketchnote.new");
    download(&url("sketchnote"), &new_exe)?;
    fs::set_permissions(&new_exe, fs::Permissions::from_mode(0o755))?;

    let staging = crate::data_dir().join("update");
    let _ = fs::remove_dir_all(&staging);
    let new_ext = staging.join(setup::UUID);
    fs::create_dir_all(&new_ext)?;
    let tarball = staging.join("extension.tar.gz");
    download(&url("sketchnote-extension.tar.gz"), &tarball)?;
    let unpacked = Command::new("tar").arg("-xzf").arg(&tarball).arg("-C").arg(&new_ext).status()?;
    ensure!(unpacked.success(), "unpacking the extension failed");

    let ext = extension_dir();
    let relogin = files(&new_ext) != files(&ext);
    if relogin {
        let _ = fs::remove_dir_all(&ext);
        fs::create_dir_all(ext.parent().unwrap())?;
        fs::rename(&new_ext, &ext).with_context(|| format!("installing the extension in {}", ext.display()))?;
    }
    let _ = fs::remove_dir_all(&staging);
    // A rename, so the running service keeps its old copy until it's restarted below.
    fs::rename(&new_exe, &exe).with_context(|| format!("replacing {}", exe.display()))?;

    // Only models missing on disk are downloaded (say, if a release changed the default).
    if let Err(e) = config::load().and_then(|c| transcribe::download(&transcribe::Model::parse(&c.local.model)?)) {
        eprintln!("Couldn't check the speech models ({e:#}). Run `sketchnote setup` to fix it.");
    }
    restart_service();
    println!("Updated to {latest}.");
    if relogin {
        println!("The extension changed: log out and back in once to load it.");
    }
    Ok(())
}

/// The latest release's tag, e.g. "v0.0.2", from GitHub's API.
fn latest_tag() -> Result<String> {
    let out = Command::new("curl")
        .args(["-fsSL", &format!("https://api.github.com/repos/{REPO}/releases/latest")])
        .output()
        .context("running curl")?;
    if !out.status.success() {
        Err(anyhow::anyhow!("{}", String::from_utf8_lossy(&out.stderr).trim()).context(Fix(
            "Couldn't ask GitHub for the latest release. Check your internet connection, then run `sketchnote update` again.".into(),
        )))?;
    }
    let release: serde_json::Value = serde_json::from_slice(&out.stdout).context("reading GitHub's answer")?;
    Ok(release["tag_name"].as_str().context("GitHub's answer has no tag_name")?.to_string())
}

fn download(url: &str, to: &Path) -> Result<()> {
    eprintln!("Downloading {url}");
    let ok = Command::new("curl").args(["-fL", "--progress-bar", "-o"]).arg(to).arg(url).status()?.success();
    ensure!(ok, "downloading {url} failed");
    Ok(())
}

/// True if version `a` (like "0.0.2") is newer than `b`.
fn newer(a: &str, b: &str) -> bool {
    let parts = |v: &str| v.split('.').map(|n| n.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parts(a) > parts(b)
}

fn extension_dir() -> PathBuf {
    crate::data_dir().parent().unwrap().join("gnome-shell/extensions").join(setup::UUID)
}

/// The files directly in `dir` with their contents; empty if it doesn't exist.
fn files(dir: &Path) -> BTreeMap<std::ffi::OsString, Vec<u8>> {
    let Ok(entries) = fs::read_dir(dir) else { return BTreeMap::new() };
    entries.flatten().filter_map(|e| Some((e.file_name(), fs::read(e.path()).ok()?))).collect()
}

/// Stops the service so D-Bus starts the new binary on demand, unless it's recording.
fn restart_service() {
    let recording = Command::new("pgrep").args(["-x", "pw-record"]).status().is_ok_and(|s| s.success());
    if !recording {
        let _ = Command::new("pkill").args(["-f", "/sketchnote service$"]).status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_number() {
        assert!(newer("0.0.2", "0.0.1"));
        assert!(newer("0.10.0", "0.9.9"));
        assert!(!newer("0.0.2", "0.0.2"));
        assert!(!newer("0.0.1", "0.0.2"));
    }
}
