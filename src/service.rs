//! Session D-Bus service the GNOME Shell extension talks to.
//!
//!     Start()        -> new bundle dir; starts recording the microphone into it
//!     Finish(json)   -> bundle dir; stops the mic and queues the bundle to be built
//!     Retry(dir)     -> queues a bundle whose build failed to be built again
//!     Cancel()       -> stops the mic and deletes the bundle dir
//!     MicSilent()    -> true if the mic has recorded only near-silence for 3 s
//!     MicLevel()     -> how loud the mic was over the last 0.1 s, 0 to 1
//!     signal BundleReady(path) when a bundle is finished
//!     signal BundleFailed(path, reason) when building it failed; `reason` is one
//!            sentence for the user, the full error is in the bundle's error.txt
//!
//! Started on demand by D-Bus activation (see install.sh). While running, it deletes
//! captures older than `KEEP_CAPTURES`, checking once an hour.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, SystemTime};

use anyhow::Result;
use futures_util::StreamExt;
use zbus::{Connection, fdo, interface};

use crate::bundle::Finished;
use crate::capture::Capture;
use crate::fix;
use crate::media::{self, Mic};
use crate::{bundle, captures_dir};

const NAME: &str = "org.sketchnote.Service";
const PATH: &str = "/org/sketchnote/Service";
/// Captures hold full-screen video and mic audio, and are pasted within minutes, so
/// they're only kept this long after they last changed.
const KEEP_CAPTURES: Duration = Duration::from_secs(24 * 60 * 60);

/// The capture in progress, if any.
#[derive(Default)]
struct Recording {
    dir: Option<PathBuf>,
    mic: Option<Mic>,
    mic_t0: f64,
}

impl Recording {
    fn stop_mic(&mut self) {
        if let Some(mic) = self.mic.take() {
            mic.stop();
        }
    }

    fn cancel(&mut self) {
        self.stop_mic();
        if let Some(dir) = self.dir.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// Bundle dirs cleanup must not touch: the one being recorded, and every one queued or
/// being built. A dir is added on Start or Retry and removed once its build is done.
/// (A cancelled recording's dir stays listed, harmlessly: it's already deleted.)
type InUse = Arc<Mutex<HashSet<PathBuf>>>;

struct Service {
    rec: Arc<Mutex<Recording>>,
    /// Bundle dirs waiting to be built (each has its finish.json).
    builds: mpsc::Sender<PathBuf>,
    in_use: InUse,
}

#[interface(name = "org.sketchnote.Service")]
impl Service {
    fn start(&self) -> fdo::Result<String> {
        let mut rec = self.rec.lock().unwrap();
        rec.cancel();
        let dir = new_bundle_dir().map_err(failed)?;
        self.in_use.lock().unwrap().insert(dir.clone());
        rec.mic = Some(Mic::start(&dir.join("audio.wav")).map_err(failed)?);
        rec.mic_t0 = media::monotonic_us();
        rec.dir = Some(dir.clone());
        Ok(dir.display().to_string())
    }

    fn finish(&self, capture: &str) -> fdo::Result<String> {
        let capture: Capture = serde_json::from_str(capture).map_err(failed)?;
        let mut rec = self.rec.lock().unwrap();
        let dir = rec.dir.take().ok_or_else(|| fdo::Error::Failed("no capture in progress".into()))?;
        rec.stop_mic();
        let path = dir.display().to_string();
        let queued = bundle::save_finished(&dir, &Finished { capture, mic_t0: rec.mic_t0 })
            .and_then(|()| Ok(self.builds.send(dir.clone())?));
        if queued.is_err() {
            self.in_use.lock().unwrap().remove(&dir); // never built, so cleanup may have it
        }
        queued.map_err(failed)?;
        Ok(path)
    }

    fn retry(&self, dir: &str) -> fdo::Result<()> {
        let dir = PathBuf::from(dir);
        // Checked and claimed under the lock cleanup deletes under, so it can't slip in between.
        let mut in_use = self.in_use.lock().unwrap();
        if in_use.contains(&dir) {
            return Ok(()); // already queued or building
        }
        if dir.parent() != Some(&captures_dir()) || !dir.join("finish.json").exists() {
            return Err(fdo::Error::Failed(format!("{} isn't a finished capture", dir.display())));
        }
        // Retrying counts as a change, so the capture gets another day.
        std::fs::File::open(&dir).and_then(|d| d.set_modified(SystemTime::now())).map_err(failed)?;
        in_use.insert(dir.clone());
        self.builds.send(dir).map_err(failed)
    }

    fn cancel(&self) {
        self.rec.lock().unwrap().cancel();
    }

    fn mic_silent(&self) -> bool {
        let dir = self.rec.lock().unwrap().dir.clone();
        dir.is_some_and(|d| Mic::is_silent(&d.join("audio.wav")).unwrap_or(false))
    }

    fn mic_level(&self) -> f64 {
        let dir = self.rec.lock().unwrap().dir.clone();
        dir.map_or(0.0, |d| Mic::level(&d.join("audio.wav")).unwrap_or(0.0))
    }
}

/// A fresh `<timestamp>.bundle` dir. Never reuses one: two captures in the same second
/// get `_2`, `_3`, ... (which sort after the first, so `latest` stays right).
fn new_bundle_dir() -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(captures_dir())?;
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    for n in 1.. {
        let name = if n == 1 { format!("{stamp}.bundle") } else { format!("{stamp}_{n}.bundle") };
        let dir = captures_dir().join(name);
        match std::fs::create_dir(&dir) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            result => return result.map(|()| dir),
        }
    }
    unreachable!()
}

/// Builds bundles one at a time, in the order they were finished. So the newest capture
/// is always the last BundleReady (the one the extension pastes), and transcriptions
/// don't compete for the CPU.
fn build_all(conn: Connection, queue: mpsc::Receiver<PathBuf>, in_use: InUse) {
    media::be_nice();
    for dir in queue {
        let path = dir.display().to_string();
        let error_file = dir.join("error.txt");
        match bundle::build(&dir) {
            Ok(()) => {
                let _ = std::fs::remove_file(&error_file);
                emit(&conn, "BundleReady", &(path,));
            }
            Err(e) => {
                eprintln!("building {path}: {e:#}");
                let _ = std::fs::write(&error_file, format!("{e:#}\n"));
                let reason = fix::explain(&e, &error_file.display().to_string());
                emit(&conn, "BundleFailed", &(path, reason));
            }
        }
        in_use.lock().unwrap().remove(&dir);
    }
}

/// Deletes the `*.bundle` dirs in `captures` that last changed more than `keep` ago and
/// aren't `in_use`.
fn delete_old_captures(captures: &Path, keep: Duration, in_use: &Mutex<HashSet<PathBuf>>) {
    let Ok(entries) = std::fs::read_dir(captures) else { return };
    for dir in entries.flatten().map(|e| e.path()) {
        let in_use = in_use.lock().unwrap(); // held until this dir is decided and deleted
        let age = dir.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
        if dir.extension().is_some_and(|x| x == "bundle")
            && !in_use.contains(&dir)
            && age.is_some_and(|a| a > keep)
            && let Err(e) = std::fs::remove_dir_all(&dir)
        {
            eprintln!("deleting {}: {e}", dir.display());
        }
    }
}

/// Sends `signal` once; the extension updates its pill and notifications from it.
fn emit<B: serde::Serialize + zbus::zvariant::DynamicType>(conn: &Connection, signal: &str, body: &B) {
    if let Err(e) = zbus::block_on(conn.emit_signal(None::<&str>, PATH, NAME, signal, body)) {
        eprintln!("{signal}: {e}");
    }
}

/// A D-Bus error for the extension to show: a known cause's sentence, else the error.
fn failed(e: impl Into<anyhow::Error>) -> fdo::Error {
    let e = e.into();
    eprintln!("{e:#}");
    fdo::Error::Failed(fix::known(&e).unwrap_or_else(|| format!("{e:#}")))
}

/// Serves until killed. Never leaves the mic running if we're stopped or GNOME Shell
/// (and so the capture UI) goes away.
pub fn run() -> Result<()> {
    zbus::block_on(async {
        let conn = Connection::session().await?;
        let rec = Arc::new(Mutex::new(Recording::default()));
        let (builds, queue) = mpsc::channel();
        let in_use = InUse::default();
        let (worker, building) = (conn.clone(), in_use.clone());
        std::thread::spawn(move || build_all(worker, queue, building));
        let cleaning = in_use.clone();
        std::thread::spawn(move || {
            loop {
                delete_old_captures(&captures_dir(), KEEP_CAPTURES, &cleaning);
                std::thread::sleep(Duration::from_secs(60 * 60));
            }
        });
        conn.object_server().at(PATH, Service { rec: rec.clone(), builds, in_use }).await?;
        conn.request_name(NAME).await?;

        let on_term = rec.clone();
        ctrlc::set_handler(move || {
            on_term.lock().unwrap().cancel();
            std::process::exit(0);
        })?;

        let bus = fdo::DBusProxy::new(&conn).await?;
        let mut shell = bus.receive_name_owner_changed_with_args(&[(0, "org.gnome.Shell")]).await?;
        while let Some(change) = shell.next().await {
            if change.args()?.new_owner.is_none() {
                rec.lock().unwrap().cancel();
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_old_bundles_not_in_use_are_deleted() {
        let captures = std::env::temp_dir().join(format!("sketchnote-cleanup-{}", std::process::id()));
        let day_ago = SystemTime::now() - Duration::from_secs(25 * 60 * 60);
        for name in ["old.bundle", "old-building.bundle", "new.bundle", "old-other"] {
            std::fs::create_dir_all(captures.join(name)).unwrap();
        }
        for name in ["old.bundle", "old-building.bundle", "old-other"] {
            std::fs::File::open(captures.join(name)).unwrap().set_modified(day_ago).unwrap();
        }
        let in_use = Mutex::new(HashSet::from([captures.join("old-building.bundle")]));
        delete_old_captures(&captures, KEEP_CAPTURES, &in_use);
        let mut left: Vec<_> =
            std::fs::read_dir(&captures).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        std::fs::remove_dir_all(&captures).unwrap();
        assert_eq!(left, ["new.bundle", "old-building.bundle", "old-other"]);
    }
}
