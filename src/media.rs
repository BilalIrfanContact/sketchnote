//! External tools: ffmpeg for video, pw-record for the mic, notify-send.

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use image::RgbaImage;

/// Microseconds on CLOCK_MONOTONIC, the clock GNOME Shell's `GLib.get_monotonic_time` uses.
pub fn monotonic_us() -> f64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec as f64 * 1e6 + (ts.tv_nsec / 1000) as f64
}

/// Lowers this thread's priority. Threads and processes it starts inherit it, so heavy
/// work (encoding, transcription) can't starve GNOME Shell and make the desktop lag.
pub fn be_nice() {
    unsafe { libc::setpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t, 10) };
}

/// Seconds of recent audio checked for silence.
const MIC_CHECK_SECS: usize = 3;
/// Byte size of the WAV header pw-record writes before the samples.
const WAV_HEADER: u64 = 44;
/// Peak below this (about −60 dBFS) is a dead mic: a working one in a quiet room peaks
/// far higher just from background noise (around −22 dBFS on mine).
const SILENT_PEAK: i32 = 33;

/// No sample in `samples` is louder than `SILENT_PEAK`.
fn silent(samples: &[i16]) -> bool {
    samples.iter().all(|&s| (s as i32).abs() < SILENT_PEAK)
}

/// Records the default (or `SKETCHNOTE_MIC_TARGET`) microphone to a 16 kHz mono WAV.
pub struct Mic(Child);

impl Mic {
    pub fn start(wav: &Path) -> Result<Mic> {
        let mut cmd = Command::new("pw-record");
        cmd.args(["--rate", "16000", "--channels", "1", "--format", "s16"]);
        if let Ok(target) = std::env::var("SKETCHNOTE_MIC_TARGET") {
            cmd.args(["--target", &target]); // e.g. a test source
        }
        Ok(Mic(cmd.arg(wav).spawn().context("starting pw-record")?))
    }

    /// True if the last `MIC_CHECK_SECS` of the recording so far are near digital silence
    /// (muted mic, wrong or disconnected device). False until that much is recorded.
    pub fn is_silent(wav: &Path) -> Result<bool> {
        use std::io::{Read, Seek, SeekFrom};
        let want = (MIC_CHECK_SECS * 16000 * 2) as u64; // s16 mono at 16 kHz
        let mut f = std::fs::File::open(wav)?;
        let len = f.metadata()?.len();
        if len < WAV_HEADER + want {
            return Ok(false);
        }
        f.seek(SeekFrom::Start(len - want - (len - WAV_HEADER) % 2))?;
        let mut buf = vec![0; want as usize];
        f.read_exact(&mut buf)?;
        Ok(silent(&buf.as_chunks::<2>().0.iter().map(|&b| i16::from_le_bytes(b)).collect::<Vec<_>>()))
    }

    /// SIGINT lets pw-record finish the WAV header; kill it if it hangs.
    pub fn stop(mut self) {
        unsafe { libc::kill(self.0.id() as libc::pid_t, libc::SIGINT) };
        for _ in 0..50 {
            if let Ok(Some(_)) = self.0.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run(cmd: &mut Command) -> Result<Vec<u8>> {
    let out = cmd.stderr(Stdio::piped()).output().with_context(|| format!("running {cmd:?}"))?;
    if !out.status.success() {
        bail!("{cmd:?} failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(out.stdout)
}

fn ffmpeg() -> Command {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error"]);
    cmd
}

/// Re-encodes GNOME's screencast to 30 fps H.264 and deletes the original.
pub fn convert_video(src: &Path, dst: &Path) -> Result<()> {
    run(ffmpeg()
        .arg("-y")
        .arg("-i")
        .arg(src)
        .args([
            "-vf",
            "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-an",
        ])
        .arg(dst))?;
    std::fs::remove_file(src)?;
    Ok(())
}

pub fn probe_size(video: &Path) -> Result<(u32, u32)> {
    let out = run(Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"])
        .arg(video))?;
    let out = String::from_utf8(out)?;
    let (w, h) = out.trim().split_once(',').context("ffprobe output")?;
    Ok((w.parse()?, h.parse()?))
}

/// The frame at `t` seconds, or the last frame if `t` is past the end.
pub fn grab_frame(video: &Path, t: f64) -> Result<RgbaImage> {
    let grab = |seek: &[&str]| {
        run(ffmpeg().args(seek).arg("-i").arg(video).args(["-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"]))
    };
    let mut png = grab(&["-ss", &format!("{:.3}", t.max(0.0))])?;
    if png.is_empty() {
        png = grab(&["-sseof", "-0.1"])?;
    }
    Ok(image::load_from_memory(&png)?.to_rgba8())
}

pub fn notify(title: &str, body: &str) {
    let _ = Command::new("notify-send").args(["--app-name=Sketchnote", title, body]).status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_near_digital_silence_counts_as_silent() {
        assert!(silent(&[0, 1, -2, 32, -32]));
        // A quiet room through a working mic is far louder than the threshold.
        assert!(!silent(&[0, 0, 33, 0]));
        assert!(!silent(&[0, -2600, 0]));
    }
}
