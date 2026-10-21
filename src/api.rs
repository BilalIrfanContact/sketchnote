//! Transcription through an OpenAI-compatible `POST <url>/audio/transcriptions` API: Groq,
//! OpenAI's `whisper-1`, or a self-hosted Speaches. The notes need a start and end time
//! for every word, which only Whisper-based models return there; anything else is refused.
//! The API key, if the server needs one, is in the desktop keyring (see `key`).

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::capture::Word;
use crate::config::Api;
use crate::fix::Fix;
use crate::{key, transcribe};

/// The response fields we use; `words` is only there if the model has word timestamps.
#[derive(Deserialize)]
struct Transcript {
    #[serde(default)]
    text: String,
    words: Option<Vec<ApiWord>>,
}

#[derive(Deserialize)]
struct ApiWord {
    word: String,
    start: f64,
    end: f64,
}

/// Words with start/end seconds from a WAV, transcribed by `api`.
pub fn words(wav: &Path, api: &Api) -> Result<Vec<Word>> {
    let host = host(&api.url);
    let key = key::get(&api.url)?;
    let audio = std::fs::read(wav).with_context(|| format!("reading {}", wav.display()))?;
    let (content_type, body) = multipart(
        &[
            ("model", &api.model),
            ("response_format", "verbose_json"),
            ("timestamp_granularities[]", "word"),
            ("language", "en"),
            ("prompt", transcribe::PROMPT),
        ],
        &audio,
    );
    let agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(300)))
        .build()
        .new_agent();
    let mut request = agent
        .post(format!("{}/audio/transcriptions", api.url.trim_end_matches('/')))
        .header("Content-Type", &content_type);
    if let Some(key) = &key {
        request = request.header("Authorization", &format!("Bearer {key}"));
    }
    let mut response = request.send(&body[..]).map_err(|e| {
        anyhow::Error::new(e).context(Fix(format!(
            "Couldn't reach {host}. Check your internet connection and the url in {}, then retry.",
            crate::config::path().display()
        )))
    })?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().context("reading the transcription response")?;
    if status != 200 {
        return Err(
            anyhow::anyhow!("{host} returned {status}: {text}").context(Fix(explain(status, &text, &host, api)))
        );
    }
    let transcript: Transcript = serde_json::from_str(&text).with_context(|| format!("{host} returned: {text}"))?;
    let words = match transcript.words {
        Some(words) if !words.is_empty() || transcript.text.trim().is_empty() => words,
        _ => Err(Fix(format!(
            "The model {} on {host} doesn't give word timings, which Sketchnote needs. Use a Whisper model such as whisper-large-v3-turbo, then retry.",
            api.model
        )))?,
    };
    // Spaced like whisper.cpp's words, which the notes join as they are.
    Ok(transcribe::drop_sound_tags(
        words.into_iter().map(|w| Word { word: format!(" {}", w.word.trim()), start: w.start, end: w.end }).collect(),
    ))
}

/// What to tell the user about a failed request, from its status and error body.
fn explain(status: u16, body: &str, host: &str, api: &Api) -> String {
    // OpenAI-style `{"error": {"message", "code"}}`; Speaches uses `{"detail"}`.
    let json: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let code = json["error"]["code"].as_str().unwrap_or("");
    let message = json["error"]["message"].as_str().or(json["detail"].as_str()).unwrap_or(body).trim();
    let out_of_credit = [
        "insufficient_quota",
        "credit_balance_exhausted",
        "organization_spend_limit_exceeded",
        "project_spend_limit_exceeded",
        "organization_usage_limit_exceeded",
        "blocked_api_access",
    ]
    .contains(&code)
        || json["error"]["type"].as_str() == Some("insufficient_quota");
    match status {
        401 | 403 => format!("{host} didn't accept the API key. Run `sketchnote set-key` to set it again, then retry."),
        _ if out_of_credit => {
            format!("Your {host} account is out of credit or reached its spending limit. Top it up, then retry.")
        }
        429 => format!("{host} is limiting how often you can transcribe. Wait a minute, then retry."),
        413 => format!("This recording is too big for {host}'s upload limit."),
        404 => format!(
            "{host} doesn't know the model \"{}\", or the url is wrong. Check [api] in {}, then retry.",
            api.model,
            crate::config::path().display()
        ),
        _ => {
            format!("{host} couldn't transcribe the recording ({status}: {message}). Retry, or check its status page.")
        }
    }
}

/// `api.groq.com` from `https://api.groq.com/openai/v1`.
fn host(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    rest.split('/').next().unwrap_or(rest).to_string()
}

/// A `multipart/form-data` body with text `fields` and the WAV as `file`.
fn multipart(fields: &[(&str, &str)], wav: &[u8]) -> (String, Vec<u8>) {
    let boundary = "sketchnote-0b6f2a7c9d4e1f38";
    let mut body = vec![];
    for (name, value) in fields {
        body.extend(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").bytes(),
        );
    }
    body.extend(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .bytes(),
    );
    body.extend(wav);
    body.extend(format!("\r\n--{boundary}--\r\n").bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api() -> Api {
        Api { url: "https://api.groq.com/openai/v1".into(), model: "whisper-large-v3-turbo".into() }
    }

    #[test]
    fn errors_become_plain_next_steps() {
        let say = |status, body| explain(status, body, "api.groq.com", &api());
        assert!(say(401, r#"{"error":{"message":"Invalid API Key"}}"#).contains("didn't accept the API key"));
        assert!(say(403, r#"{"detail":"Invalid API key."}"#).contains("didn't accept the API key"));
        assert!(say(429, r#"{"error":{"code":"credit_balance_exhausted"}}"#).contains("out of credit"));
        assert!(say(400, r#"{"error":{"code":"blocked_api_access"}}"#).contains("out of credit"));
        assert!(say(429, r#"{"error":{"type":"rate_limit_error","code":"slow_down"}}"#).contains("Wait a minute"));
        assert!(say(500, "boom").contains("(500: boom)"));
        assert_eq!(host("http://localhost:8000/v1"), "localhost:8000");
    }

    #[test]
    fn multipart_body_has_each_field_and_the_file() {
        let (ct, body) = multipart(&[("model", "m")], b"RIFF");
        let body = String::from_utf8(body).unwrap();
        let boundary = ct.split("boundary=").nth(1).unwrap();
        assert!(body.contains("name=\"model\"\r\n\r\nm\r\n"));
        assert!(body.contains("filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n"));
        assert!(body.ends_with(&format!("--{boundary}--\r\n")));
    }
}
