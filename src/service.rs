//! Session D-Bus service the GNOME Shell extension talks to.
//!
//!     Start()        -> new bundle dir; starts recording the microphone into it
//!     Finish(json)   -> bundle dir; stops the mic and queues the bundle to be built
//!     Cancel()       -> stops the mic and deletes the bundle dir
//!     signal BundleReady(path) when a bundle is finished (also a desktop notification)
//!
//! Started on demand by D-Bus activation (see install.sh).

use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};

use anyhow::Result;
use futures_util::StreamExt;
use zbus::{Connection, fdo, interface};

use crate::capture::Capture;
use crate::media::{self, Mic};
use crate::{bundle, captures_dir};

const NAME: &str = "org.sketchnote.Service";
const PATH: &str = "/org/sketchnote/Service";

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

/// A finished capture waiting to be built: its dir, the extension's data, mic start.
type Build = (PathBuf, Capture, f64);

struct Service {
    rec: Arc<Mutex<Recording>>,
    builds: mpsc::Sender<Build>,
}

#[interface(name = "org.sketchnote.Service")]
impl Service {
    fn start(&self) -> fdo::Result<String> {
        let mut rec = self.rec.lock().unwrap();
        rec.cancel();
        let dir = new_bundle_dir().map_err(failed)?;
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
        self.builds.send((dir, capture, rec.mic_t0)).map_err(failed)?;
        Ok(path)
    }

    fn cancel(&self) {
        self.rec.lock().unwrap().cancel();
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
fn build_all(conn: Connection, queue: mpsc::Receiver<Build>) {
    media::be_nice();
    for (dir, capture, mic_t0) in queue {
        match bundle::build(&dir, &capture, mic_t0) {
            Ok(()) => {
                let n = std::fs::read_dir(dir.join("frames")).map_or(0, |d| d.count());
                media::notify("Sketchnote ready", &format!("{n} notes · Ctrl+V pastes them with the contact sheet"));
                let path = dir.display().to_string();
                let sent = zbus::block_on(conn.emit_signal(None::<&str>, PATH, NAME, "BundleReady", &(path,)));
                if let Err(e) = sent {
                    eprintln!("BundleReady: {e}");
                }
            }
            Err(e) => {
                eprintln!("building {}: {e:#}", dir.display());
                media::notify("Sketchnote failed", &format!("Could not build {}; see the journal", dir.display()));
            }
        }
    }
}

fn failed(e: impl std::fmt::Display) -> fdo::Error {
    eprintln!("{e:#}");
    fdo::Error::Failed(format!("{e:#}"))
}

/// Serves until killed. Never leaves the mic running if we're stopped or GNOME Shell
/// (and so the capture UI) goes away.
pub fn run() -> Result<()> {
    zbus::block_on(async {
        let conn = Connection::session().await?;
        let rec = Arc::new(Mutex::new(Recording::default()));
        let (builds, queue) = mpsc::channel();
        let worker = conn.clone();
        std::thread::spawn(move || build_all(worker, queue));
        conn.object_server().at(PATH, Service { rec: rec.clone(), builds }).await?;
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
