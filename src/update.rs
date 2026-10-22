//! `sketchnote update`: replaces this install with the latest GitHub release, where
//! install.sh put it. The binary and extension are both downloaded before either is
//! replaced; the old extension is kept aside until the new binary is in place, and put
//! back if that fails. Then the new binary fetches any speech model it needs that isn't
//! on disk yet, and the service is asked to quit once idle. The D-Bus file never changes.

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, ensure};

use crate::fix::Fix;
use crate::setup;

/// The release this binary was built from (the tag without its `v`), or "dev" when built
/// from source.
pub const VERSION: &str = match option_env!("SKETCHNOTE_VERSION") {
    Some(v) => v,
    None => "dev",
};
const REPO: &str = "BilalIrfanContact/sketchnote";

pub fn run() -> Result<()> {
    let Some(current) = parse_version(VERSION) else {
        Err(Fix(
            "This sketchnote was built from source, so it updates from git: git pull, then ./build-from-source.sh."
                .into(),
        ))?
    };
    let tag = latest_tag()?;
    let latest = parse_version(tag.trim_start_matches('v'))
        .with_context(|| format!("the latest release's tag {tag} isn't a version like v1.2.3"))?;
    if latest <= current {
        println!("Already up to date ({VERSION}).");
        return Ok(());
    }
    let new_version = tag.trim_start_matches('v');
    println!("Updating {VERSION} → {new_version}");
    let url = |name: &str| format!("https://github.com/{REPO}/releases/download/{tag}/{name}");

    let exe = std::env::current_exe().context("finding this binary")?;
    let new_exe = exe.with_file_name("sketchnote.new");
    download("the new sketchnote", &url("sketchnote"), &new_exe)?;
    fs::set_permissions(&new_exe, fs::Permissions::from_mode(0o755))?;

    // Staged and swapped beside the installed extension, so the renames stay on one disk.
    let ext = extension_dir();
    let (new_ext, old_ext) = (ext.with_file_name(".sketchnote-new"), ext.with_file_name(".sketchnote-old"));
    let _ = fs::remove_dir_all(&new_ext);
    fs::create_dir_all(&new_ext)?;
    let tarball = new_ext.join("extension.tar.gz");
    download("the new extension", &url("sketchnote-extension.tar.gz"), &tarball)?;
    let unpacked = Command::new("tar").arg("-xzf").arg(&tarball).arg("-C").arg(&new_ext).status()?;
    fs::remove_file(&tarball)?;
    ensure!(unpacked.success(), "unpacking the extension failed");

    let relogin = files(&new_ext) != files(&ext);
    if relogin {
        let _ = fs::remove_dir_all(&old_ext);
        if ext.exists() {
            fs::rename(&ext, &old_ext)?;
        }
        if let Err(e) = fs::rename(&new_ext, &ext) {
            let _ = fs::rename(&old_ext, &ext);
            return Err(e).with_context(|| format!("installing the extension in {}", ext.display()));
        }
    }
    // A rename, so the running service keeps its old copy until it quits.
    if let Err(e) = fs::rename(&new_exe, &exe) {
        if relogin {
            let _ = fs::remove_dir_all(&ext);
            let _ = fs::rename(&old_ext, &ext);
        }
        return Err(e).with_context(|| format!("replacing {}", exe.display()));
    }
    let _ = fs::remove_dir_all(&old_ext);
    let _ = fs::remove_dir_all(&new_ext);

    let models = Command::new(&exe).arg("download-model").status().is_ok_and(|s| s.success());
    quit_service_when_idle();
    println!("Updated to {new_version}.");
    if relogin {
        println!("The extension changed: log out and back in once to load it.");
    }
    ensure!(models, "the speech model couldn't be downloaded. Run `sketchnote download-model` to try again.");
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

/// Downloads `url` with a progress bar, naming it `what` rather than printing the URL,
/// which only shows up if the download fails.
fn download(what: &str, url: &str, to: &Path) -> Result<()> {
    eprintln!("Downloading {what}");
    let ok = Command::new("curl").args(["-fL", "--progress-bar", "-o"]).arg(to).arg(url).status()?.success();
    ensure!(ok, "downloading {url} failed");
    Ok(())
}

/// `[1, 2, 3]` from "1.2.3"; None for anything else (like "dev" or "1.2.3-rc1").
fn parse_version(v: &str) -> Option<[u64; 3]> {
    let parts: Vec<u64> = v.split('.').map(|n| n.parse().ok()).collect::<Option<_>>()?;
    parts.try_into().ok()
}

fn extension_dir() -> PathBuf {
    crate::data_dir().parent().unwrap().join("gnome-shell/extensions").join(setup::UUID)
}

/// The files directly in `dir` with their contents; empty if it doesn't exist.
fn files(dir: &Path) -> BTreeMap<std::ffi::OsString, Vec<u8>> {
    let Ok(entries) = fs::read_dir(dir) else { return BTreeMap::new() };
    entries.flatten().filter_map(|e| Some((e.file_name(), fs::read(e.path()).ok()?))).collect()
}

/// Asks the running service to quit once nothing is recording or building, so D-Bus
/// starts the new binary on its next use. (If none is running, this starts the new one,
/// which quits at once.)
fn quit_service_when_idle() {
    let _ = Command::new("gdbus")
        .args(["call", "--session", "--dest", "org.sketchnote.Service", "--object-path", "/org/sketchnote/Service"])
        .args(["--method", "org.sketchnote.Service.QuitWhenIdle"])
        .output();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_versions_compare_and_by_number() {
        let v = |s| parse_version(s).unwrap();
        assert!(v("0.0.2") > v("0.0.1"));
        assert!(v("0.10.0") > v("0.9.9"));
        assert!(v("0.0.2") <= v("0.0.2"));
        for odd in ["dev", "0.0.2+build.1", "1.2.3-rc1", "1.2", "1.2.3.4"] {
            assert_eq!(parse_version(odd), None, "{odd}");
        }
    }
}
