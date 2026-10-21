//! Turning events and words into numbered marks, and marks into the pasted notes.

use std::collections::HashMap;

use crate::capture::{Capture, Event, Kind, Mark, Window, Word};

/// The numbered marks, plus clicks that got no words and so no number of their own.
pub struct Notes {
    pub marks: Vec<Mark>,
    pub silent_clicks: Vec<Event>,
}

/// Turns events and words into notes.
///
/// Speech is split into sentences (at `.`, `?`, `!`), and each sentence goes to the
/// event whose span (from it until the next event) it overlaps most, so a sentence is
/// cut in two unless you paused for `PAUSE` or longer at a mark inside it (pointing
/// while saying "this part, … this part"). Unpunctuated speech is split by time instead. Speech before the first event counts toward the first. Strokes and
/// pins are always numbered; a click is numbered only if it got words, otherwise it is
/// listed without a number and gets no keyframe. If nothing would be numbered (only
/// clicks, none spoken about), every event is. With no events at all the whole capture
/// is one mark on the last frame.
pub fn make_notes(events: &[Event], words: &[Word], duration: f64) -> Notes {
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
    let span = |i: usize| {
        let start = if i == 0 { f64::NEG_INFINITY } else { events[i].t };
        (start, events.get(i + 1).map_or(f64::INFINITY, |next| next.t))
    };
    let mut texts = vec![String::new(); events.len()];
    let times: Vec<f64> = events.iter().map(|e| e.t).collect();
    for (piece, whole) in pieces(words, &times) {
        // A loose word counts only at its start, matching the old time split.
        let s = piece[0].start;
        let e = if whole { piece[piece.len() - 1].end.max(s) } else { s };
        let overlap = |i: usize| {
            let (a, b) = span(i);
            if s == e { if a <= s && s < b { 1.0 } else { 0.0 } } else { (e.min(b) - s.max(a)).max(0.0) }
        };
        // Ties go to the earlier event.
        let best = (0..events.len()).fold(0, |best, i| if overlap(i) > overlap(best) { i } else { best });
        texts[best].extend(piece.iter().map(|w| w.word.as_str()));
    }

    let numbered = |e: &Event, text: &str| e.kind != Kind::Click || !text.trim().is_empty();
    let any_numbered = events.iter().zip(&texts).any(|(e, t)| numbered(e, t));
    let mut notes = Notes { marks: vec![], silent_clicks: vec![] };
    for (e, text) in events.into_iter().zip(texts) {
        if any_numbered && !numbered(&e, &text) {
            notes.silent_clicks.push(e);
            continue;
        }
        notes.marks.push(Mark {
            n: notes.marks.len() + 1,
            t: e.t,
            kind: e.kind.clone(),
            // Keyframe right after the stroke is finished (or the click/pin landed).
            frame_t: e.frame_t.unwrap_or(e.t_end.unwrap_or(e.t) + 0.1),
            event: e,
            text: text.trim().to_string(),
        });
    }
    notes
}

/// A silence this long (seconds) at a mark splits a sentence there.
const PAUSE: f64 = 1.0;

/// Speech cut into pieces to place at marks, each flagged `true` if it is (part of) a
/// sentence. Sentences end at `.`, `?` or `!` and are cut where a pause of `PAUSE` or more
/// contains a mark's time. Trailing words with no sentence end (all of them, if the
/// transcript has no punctuation) come back one per piece, flagged `false`.
fn pieces<'a>(words: &'a [Word], marks: &[f64]) -> Vec<(&'a [Word], bool)> {
    let mut out = vec![];
    let mut start = 0;
    for (i, w) in words.iter().enumerate() {
        if ends_sentence(w) {
            let sentence = &words[start..=i];
            let mut from = 0;
            for (j, pair) in sentence.windows(2).enumerate() {
                let (a, b) = (pair[0].end, pair[1].start);
                if b - a >= PAUSE && marks.iter().any(|&t| a <= t && t <= b) {
                    out.push((&sentence[from..=j], true));
                    from = j + 1;
                }
            }
            out.push((&sentence[from..], true));
            start = i + 1;
        }
    }
    out.extend(words[start..].chunks(1).map(|w| (w, false)));
    out
}

fn ends_sentence(w: &Word) -> bool {
    w.word.trim_end().ends_with(['.', '?', '!'])
}

/// The pasted notes in time order: one line per mark, e.g. `- #1 (0:16) [clicked] “hi”`,
/// and `- (0:20) [clicked]` for a click nothing was said about.
pub fn summary(notes: &Notes) -> String {
    let mut lines: Vec<(f64, String)> =
        notes.silent_clicks.iter().map(|e| (e.t, format!("- ({}) [clicked]", clock(e.t)))).collect();
    for m in &notes.marks {
        let tag = match m.kind {
            Kind::Click => "[clicked] ",
            Kind::Pin => "[pin] ",
            _ => "",
        };
        let said = if m.text.is_empty() { String::new() } else { format!("“{}”", m.text) };
        lines.push((m.t, format!("- #{} ({}) {tag}{said}", m.n, clock(m.t)).trim_end().to_string()));
    }
    lines.sort_by(|a, b| a.0.total_cmp(&b.0));
    lines.into_iter().map(|(_, line)| line + "\n").collect()
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

    /// Words one per 0.5 s from `t`, the last carrying the punctuation.
    fn said(text: &str, t: f64) -> Vec<Word> {
        text.split(' ').enumerate().map(|(i, w)| word(w, t + i as f64 * 0.5)).collect()
    }

    fn stroke(t: f64) -> Event {
        Event { t_end: Some(t + 0.5), points: vec![[0.0, 0.0], [5.0, 5.0]], ..event(Kind::Stroke, t) }
    }

    #[test]
    fn sentences_stay_whole_and_silent_clicks_lose_their_number() {
        // Circle a button, click elsewhere mid-sentence, then circle the header.
        let events = [stroke(4.0), event(Kind::Click, 7.0), stroke(9.0)];
        let mut words = said("This button is misaligned, it should line up with the text box.", 2.0);
        words.extend(said("Then the header font is too big.", 8.0));
        let notes = make_notes(&events, &words, 12.0);
        let texts: Vec<_> = notes.marks.iter().map(|m| (m.n, m.text.as_str())).collect();
        assert_eq!(
            texts,
            [
                (1, "This button is misaligned, it should line up with the text box."),
                (2, "Then the header font is too big.")
            ]
        );
        assert_eq!(notes.silent_clicks.len(), 1);
        assert!((notes.marks[0].frame_t - 4.6).abs() < 1e-9); // just after the stroke ends
        assert_eq!(
            summary(&notes),
            "- #1 (0:04) “This button is misaligned, it should line up with the text box.”\n\
             - (0:07) [clicked]\n\
             - #2 (0:09) “Then the header font is too big.”\n"
        );
    }

    #[test]
    fn a_pause_at_a_mark_splits_a_sentence() {
        // Circling three things while saying "This part, this part and this part.",
        // pausing at each circle (timings from a real capture).
        let w = |word: &str, start: f64, end: f64| Word { word: format!(" {word}"), start, end };
        let words = [
            w("This", 3.5, 3.5),
            w("part,", 4.0, 4.0),
            w("this", 6.0, 6.0),
            w("part", 6.5, 6.5),
            w("and", 8.2, 8.2),
            w("this", 8.4, 8.4),
            w("part.", 8.8, 9.4),
            w("Done.", 9.5, 10.0),
        ];
        let notes = make_notes(&[stroke(2.3), stroke(4.9), stroke(7.3)], &words, 12.0);
        let texts: Vec<_> = notes.marks.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, ["This part,", "this part", "and this part. Done."]);
    }

    #[test]
    fn click_with_words_keeps_its_number_and_early_speech_goes_to_first() {
        let events = [event(Kind::Click, 4.0), stroke(1.0)];
        let mut words = said("Intro here.", 0.0);
        words.extend(said("Now this one.", 4.2));
        let notes = make_notes(&events, &words, 6.0);
        let marks: Vec<_> = notes.marks.iter().map(|m| (m.kind.clone(), m.text.as_str())).collect();
        assert_eq!(marks, [(Kind::Stroke, "Intro here."), (Kind::Click, "Now this one.")]);
        assert!(notes.silent_clicks.is_empty());
    }

    #[test]
    fn unpunctuated_speech_is_split_by_time() {
        let notes = make_notes(&[stroke(1.0), stroke(2.5)], &said("look here and then this one", 0.5), 6.0);
        let texts: Vec<_> = notes.marks.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, ["look here and then", "this one"]);
        // A word that starts before a silent click and runs past it stays with the stroke.
        let long = Word { word: " there".into(), start: 1.9, end: 2.4 };
        let notes = make_notes(&[stroke(1.0), event(Kind::Click, 2.0)], &[long], 5.0);
        assert_eq!((notes.marks.len(), notes.silent_clicks.len()), (1, 1));
    }

    #[test]
    fn only_silent_clicks_are_all_numbered() {
        let notes = make_notes(&[event(Kind::Click, 1.0), event(Kind::Click, 2.0)], &[], 5.0);
        assert_eq!(notes.marks.len(), 2);
        assert!(notes.silent_clicks.is_empty());
    }

    #[test]
    fn no_events_gives_one_mark_with_everything() {
        let notes = make_notes(&[], &said("All of it. And more", 1.0), 5.0);
        assert_eq!(notes.marks.len(), 1);
        assert_eq!((notes.marks[0].kind.clone(), notes.marks[0].text.as_str()), (Kind::None, "All of it. And more"));
    }

    #[test]
    fn summary_format() {
        let notes = make_notes(&[event(Kind::Click, 16.0)], &[word("hi", 16.5)], 60.0);
        assert_eq!(summary(&notes), "- #1 (0:16) [clicked] “hi”\n");
        let silent = make_notes(&[event(Kind::Pin, 75.0)], &[], 90.0);
        assert_eq!(summary(&silent), "- #1 (1:15) [pin]\n");
    }
}
