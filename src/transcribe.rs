//! Local speech-to-text with word timestamps (whisper.cpp through whisper-rs).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use whisper_rs::{
    DtwMode, DtwModelPreset, DtwParameters, FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
    WhisperVadParams,
};

use crate::capture::Word;

/// Whisper `small`, 8-bit quantized: the same model faster-whisper ran before.
pub const MODEL: &str = "ggml-small-q8_0.bin";
/// Silero voice detector; cuts silent stretches so Whisper doesn't hallucinate in them.
pub const VAD_MODEL: &str = "ggml-silero-v5.1.2.bin";

const PROMPT: &str = "Okay, so here's the bug. This button should open the settings page.";

pub fn models_dir() -> PathBuf {
    crate::data_dir().join("models")
}

/// Words with start/end seconds from a 16 kHz mono s16 WAV.
pub fn words(wav: &Path) -> Result<Vec<Word>> {
    let audio = read_wav(wav)?;
    if audio.len() < 1600 {
        return Ok(vec![]); // under 0.1 s: nothing to say
    }
    let model = std::env::var("SKETCHNOTE_MODEL").map_or_else(|_| models_dir().join(MODEL), PathBuf::from);
    let vad = models_dir().join(VAD_MODEL);
    whisper_rs::install_logging_hooks(); // keep whisper.cpp's chatter out of the journal
    // DTW timestamps: much closer to when each word was actually said than whisper's own.
    let mut cp = WhisperContextParameters::default();
    cp.dtw_parameters(DtwParameters {
        mode: DtwMode::ModelPreset { model_preset: DtwModelPreset::Small },
        ..DtwParameters::default()
    });
    let ctx = WhisperContext::new_with_params(&model, cp)
        .with_context(|| format!("loading {} (run install.sh)", model.display()))?;
    let mut state = ctx.create_state()?;

    // Greedy + English: on real captures this was faster than beam search, kept punctuation,
    // and auto-detect sometimes picked the wrong language and then looped.
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some("en"));
    // Whisper copies the style of the prompt: without one, casual speech often comes out
    // lowercase and unpunctuated, and it mishears more.
    p.set_initial_prompt(PROMPT);
    p.set_n_threads((std::thread::available_parallelism().map_or(2, |n| n.get()) / 2).max(1) as i32);
    // One segment per word gives each word its own timestamps.
    p.set_token_timestamps(true);
    p.set_max_len(1);
    p.set_split_on_word(true);
    p.set_vad_model_path(Some(vad.to_str().context("VAD model path")?));
    p.set_vad_params(WhisperVadParams::new());
    p.enable_vad(true);
    for quiet in [FullParams::set_print_progress, FullParams::set_print_realtime, FullParams::set_print_timestamps] {
        quiet(&mut p, false);
    }
    state.full(p, &audio)?;

    let mut words = vec![];
    for i in 0..state.full_n_segments() {
        let seg = state.get_segment(i).context("segment")?;
        let text = seg.to_str_lossy()?;
        if text.trim().is_empty() {
            continue;
        }
        // The word starts at its first real (non-special) token's DTW time.
        let dtw = (0..seg.n_tokens())
            .filter_map(|t| seg.get_token(t))
            .find(|t| !t.to_str_lossy().is_ok_and(|s| s.starts_with("[_") || s.starts_with("<|")))
            .map(|t| t.token_data().t_dtw)
            .filter(|&t| t >= 0);
        let secs = |cs: i64| cs as f64 / 100.0; // centiseconds -> s
        let start = secs(dtw.unwrap_or(seg.start_timestamp()));
        words.push(Word { word: text.into_owned(), start, end: secs(seg.end_timestamp()).max(start) });
    }
    Ok(drop_sound_tags(words))
}

/// Drops whisper's non-speech tags like `[BLANK_AUDIO]`, `[wind blowing]` or `(laughs)`.
/// With one segment per word, a tag can arrive split over a few words. An opening bracket
/// that isn't closed within `MAX_TAG_WORDS`, or before the next opening bracket, is kept
/// as speech.
fn drop_sound_tags(words: Vec<Word>) -> Vec<Word> {
    const MAX_TAG_WORDS: usize = 6;
    let mut kept = vec![];
    let mut i = 0;
    while i < words.len() {
        let t = words[i].word.trim();
        let closer = match t.chars().next() {
            Some('[') => Some(']'),
            Some('(') => Some(')'),
            _ => None,
        };
        let opens = |w: &Word| w.word.trim_start().starts_with(['[', '(']);
        let end = closer.and_then(|c| {
            (i..words.len().min(i + MAX_TAG_WORDS))
                .take_while(|&j| j == i || !opens(&words[j]))
                .find(|&j| words[j].word.trim().ends_with(c))
        });
        match end {
            Some(j) => i = j + 1,
            None => {
                kept.push(words[i].clone());
                i += 1;
            }
        }
    }
    kept
}

fn read_wav(path: &Path) -> Result<Vec<f32>> {
    let mut wav = hound::WavReader::open(path).with_context(|| format!("reading {}", path.display()))?;
    let spec = wav.spec();
    ensure!(
        spec.sample_rate == 16000 && spec.channels == 1 && spec.bits_per_sample == 16,
        "expected 16 kHz mono s16 audio"
    );
    wav.samples::<i16>().map(|s| Ok(s? as f32 / 32768.0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sound_tags_are_dropped_even_when_split_over_words() {
        let words: Vec<Word> = [
            " [wind",
            " blowing]",
            " This",
            " is",
            " [MUSIC]",
            " fine",
            " (laughs)",
            " ok",
            " [so",
            " use",
            " [MUSIC]",
            " it",
            " [so",
        ]
        .iter()
        .map(|w| Word { word: w.to_string(), start: 0.0, end: 0.0 })
        .collect();
        let kept: Vec<_> = drop_sound_tags(words).into_iter().map(|w| w.word).collect();
        // An unclosed bracket stays, and doesn't swallow speech up to a later tag.
        assert_eq!(kept, [" This", " is", " fine", " ok", " [so", " use", " it", " [so"]);
    }
}
