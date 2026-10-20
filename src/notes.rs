//! Turning events and words into numbered marks, and marks into the pasted notes.

use std::collections::HashMap;

use crate::capture::{Capture, Event, Kind, Mark, Window, Word};

/// One mark per stroke, click or pin, in time order.
///
/// Each mark gets the words spoken from its own start until the next mark starts;
/// words spoken before the first mark belong to the first mark. With no events at
/// all the whole capture becomes a single mark keyed on the last frame.
pub fn make_marks(events: &[Event], words: &[Word], duration: f64) -> Vec<Mark> {
    let mut events = events.to_vec();
    events.sort_by(|a, b| a.t.total_cmp(&b.t));
    if events.is_empty() {
        events.push(Event {
            t: 0.0,
            kind: Kind::None,
            t_end: None,
            frame_t: Some((duration - 0.2).max(0.0)),
            points: vec![],
            x: None,
            y: None,
            window: None,
        });
    }
    (0..events.len())
        .map(|i| {
            let e = &events[i];
            let start = if i == 0 { 0.0 } else { e.t };
            let end = events.get(i + 1).map_or(f64::INFINITY, |next| next.t);
            let text: String =
                words.iter().filter(|w| start <= w.start && w.start < end).map(|w| w.word.as_str()).collect();
            Mark {
                n: i + 1,
                t: e.t,
                kind: e.kind.clone(),
                // Keyframe right after the stroke is finished (or the click/pin landed).
                frame_t: e.frame_t.unwrap_or(e.t_end.unwrap_or(e.t) + 0.1),
                event: e.clone(),
                text: text.trim().to_string(),
            }
        })
        .collect()
}

/// The pasted notes: one line per mark, e.g. `- #1 (0:16) [clicked] “hi”`.
pub fn summary(marks: &[Mark]) -> String {
    let mut out = String::new();
    for m in marks {
        let tag = match m.kind {
            Kind::Click => "[clicked] ",
            Kind::Pin => "[pin] ",
            _ => "",
        };
        let said = if m.text.is_empty() { String::new() } else { format!("“{}”", m.text) };
        let line = format!("- #{} ({}) {tag}{said}", m.n, clock(m.t));
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

/// The window most marks happened in, falling back to the focused window at start.
pub fn main_target(capture: &Capture) -> Option<Window> {
    let mut counts: HashMap<(&str, &str), usize> = HashMap::new();
    let mut order = vec![]; // first-seen order, so ties go to the earliest window
    for w in capture.events.iter().filter_map(|e| e.window.as_ref()) {
        let key = (w.app.as_str(), w.title.as_str());
        if !counts.contains_key(&key) {
            order.push(key);
        }
        *counts.entry(key).or_default() += 1;
    }
    let best = order.iter().copied().reduce(|a, b| if counts[&b] > counts[&a] { b } else { a });
    let (app, title) = match best {
        Some(key) => key,
        None => {
            let w = capture.window.as_ref()?;
            (w.app.as_str(), w.title.as_str())
        }
    };
    Some(Window { app: app.into(), title: title.into(), rect: None })
}

/// `m:ss`
pub fn clock(seconds: f64) -> String {
    let s = seconds as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(w: &str, t: f64) -> Word {
        Word { word: format!(" {w}"), start: t, end: t + 0.2 }
    }

    fn event(kind: Kind, t: f64) -> Event {
        Event { t, kind, t_end: None, frame_t: None, points: vec![], x: Some(1.0), y: Some(1.0), window: None }
    }

    #[test]
    fn speech_is_split_at_marks_and_early_speech_goes_to_first() {
        let stroke = Event { t_end: Some(3.0), points: vec![[0.0, 0.0], [5.0, 5.0]], ..event(Kind::Stroke, 2.0) };
        let events = [event(Kind::Click, 4.0), stroke];
        let words = [word("intro", 0.5), word("look", 2.5), word("here", 3.9), word("clicked", 4.1)];
        let marks = make_marks(&events, &words, 6.0);
        assert_eq!(marks.iter().map(|m| m.kind.clone()).collect::<Vec<_>>(), [Kind::Stroke, Kind::Click]);
        assert_eq!(marks[0].text, "intro look here");
        assert_eq!(marks[1].text, "clicked");
        assert!((marks[0].frame_t - 3.1).abs() < 1e-9); // just after the stroke ends
    }

    #[test]
    fn no_events_gives_one_mark_with_everything() {
        let marks = make_marks(&[], &[word("all", 1.0)], 5.0);
        assert_eq!(marks.len(), 1);
        assert_eq!((marks[0].kind.clone(), marks[0].text.as_str()), (Kind::None, "all"));
    }

    #[test]
    fn summary_format() {
        let marks = make_marks(&[event(Kind::Click, 16.0)], &[word("hi", 16.5)], 60.0);
        assert_eq!(summary(&marks), "- #1 (0:16) [clicked] “hi”\n");
        let silent = make_marks(&[event(Kind::Pin, 75.0)], &[], 90.0);
        assert_eq!(summary(&silent), "- #1 (1:15) [pin]\n");
    }
}
