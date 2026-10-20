//! Data the GNOME Shell extension sends on Finish, and what we derive from it.
//!
//! All times are seconds since the hotkey press (capture t0), except the raw
//! `t0` / `end` / `video_t0` stamps, which are microseconds on the monotonic clock.
//! All coordinates are GNOME stage coordinates (logical pixels).

use serde::{Deserialize, Serialize};

/// `[x, y, width, height]`
pub type Rect = [f64; 4];

#[derive(Debug, Clone, Deserialize)]
pub struct Capture {
    pub t0: f64,
    pub end: f64,
    pub video_t0: f64,
    /// Raw screencast file written by GNOME Shell.
    pub video: String,
    pub mode: String,
    pub area: Rect,
    /// Focused window when the capture started.
    pub window: Option<Window>,
    pub events: Vec<Event>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Window {
    pub app: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<Rect>,
}

/// A stroke, click or pin. `none` is only made up by us for captures without events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Stroke,
    Click,
    Pin,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub t: f64,
    #[serde(rename = "type")]
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t_end: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_t: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default)]
    pub window: Option<Window>,
}

impl Event {
    /// The points the mark covers: a stroke's path, or the single click/pin spot.
    pub fn spots(&self) -> Vec<[f64; 2]> {
        match (self.x, self.y) {
            _ if !self.points.is_empty() => self.points.clone(),
            (Some(x), Some(y)) => vec![[x, y]],
            _ => vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Word {
    pub word: String,
    pub start: f64,
    pub end: f64,
}

/// One numbered note: an event plus the words spoken until the next one.
#[derive(Debug, Clone, Serialize)]
pub struct Mark {
    pub n: usize,
    pub t: f64,
    #[serde(rename = "type")]
    pub kind: Kind,
    /// When to take the keyframe, in capture time.
    pub frame_t: f64,
    pub event: Event,
    pub text: String,
}
