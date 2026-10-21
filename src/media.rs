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
const MIC_CHECK_SECS: f64 = 3.0;
/// Seconds of recent audio the level meter measures.
const LEVEL_SECS: f64 = 0.1;
/// The level meter's floor: this much below full scale reads as empty. A fixed scale,
/// like system sound meters, so every mic setup reads truthfully.
const LEVEL_FLOOR_DB: f64 = 60.0;
/// Byte size of the WAV header pw-record writes before the samples.
const WAV_HEADER: u64 = 44;
/// Peak below this (about −60 dBFS) means a dead input: muted, wrong or unplugged. Any
/// live mic picks up enough room and circuit noise to peak well above it, even in silence.
const SILENT_PEAK: i32 = 33;

/// No sample in `samples` is louder than `SILENT_PEAK`.
fn silent(samples: &[i16]) -> bool {
    samples.iter().all(|&s| (s as i32).abs() < SILENT_PEAK)
}

/// Loudness of `samples` from 0 (−60 dBFS RMS or quieter) to 1 (full scale).
fn level(samples: &[i16]) -> f64 {
    let mean_sq = samples.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / samples.len().max(1) as f64;
    let db = 20.0 * (mean_sq.sqrt().max(1.0) / 32768.0).log10();
    ((db + LEVEL_FLOOR_DB) / LEVEL_FLOOR_DB).clamp(0.0, 1.0)
}

/// The last `secs` of a WAV that pw-record is still writing (16 kHz mono s16), or
/// `None` if less than that has been recorded.
fn recent_samples(wav: &Path, secs: f64) -> Result<Option<Vec<i16>>> {
    use std::io::{Read, Seek, SeekFrom};
    let want = (secs * 16000.0) as u64 * 2;
    let mut f = std::fs::File::open(wav)?;
    let len = f.metadata()?.len();
    if len < WAV_HEADER + want {
        return Ok(None);
    }
    f.seek(SeekFrom::Start(len - want - (len - WAV_HEADER) % 2))?;
    let mut buf = vec![0; want as usize];
    f.read_exact(&mut buf)?;
    Ok(Some(buf.as_chunks::<2>().0.iter().map(|&b| i16::from_le_bytes(b)).collect()))
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
        Ok(recent_samples(wav, MIC_CHECK_SECS)?.is_some_and(|s| silent(&s)))
    }

    /// How loud the last `LEVEL_SECS` of the recording were, 0 to 1, for the level meter.
    pub fn level(wav: &Path) -> Result<f64> {
        Ok(recent_samples(wav, LEVEL_SECS)?.map_or(0.0, |s| level(&s)))
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

    #[test]
    fn level_maps_minus_60_to_0_dbfs_onto_0_to_1() {
        assert_eq!(level(&[0; 160]), 0.0);
        assert_eq!(level(&[]), 0.0);
        assert!((level(&[i16::MAX, i16::MIN]) - 1.0).abs() < 1e-3);
        // A steady −30 dBFS (amplitude ~1036) is half way.
        assert!((level(&[1036, -1036]) - 0.5).abs() < 0.01);
    }
}
