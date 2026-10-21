# Keeping sentences whole in the notes

**Date:** 2026-10-21 · **Source:** [`src/notes.rs`](../../src/notes.rs)

## What I found

Each mark got the words spoken from its own start until the next mark, cut purely by time. I talk while I draw, so a click or stroke usually lands mid-sentence and the sentence gets split across two notes:

```
- #1 (0:04) “This button is misaligned, it should line up”
- #2 (0:07) [clicked] “with the text box. Then”
- #3 (0:09) “the header font is too big.”
```

Clicks I made just to move between apps became numbered notes with one word or nothing in them, each with its own keyframe. GPT-6-Astra's product review flagged this as "the notes describe input events, not what you meant".

## Decision

whisper.cpp now punctuates (see [the Rust service entry](2026-10-21-rust-service.md)), so sentence ends are a signal I can trust. Speech is split into sentences at `.`, `?` and `!`, and each whole sentence goes to the mark whose span (from it until the next mark) it overlaps most. Strokes and pins are always numbered. A click is numbered only if a sentence lands on it. Otherwise it stays in the notes as an unnumbered `- (0:07) [clicked]` line, with no keyframe. The exception is a capture with only clicks and no speech on any of them: then every click keeps its number, since otherwise there would be no images at all.

```mermaid
flowchart LR
    W[words] --> S[sentences at . ? !]
    S --> P[cut at a mark inside a ≥1 s pause]
    P --> A[each piece to the mark it overlaps most]
    A --> N{click with no words?}
    N -- yes --> U["unnumbered line, no keyframe"]
    N -- no --> M[numbered mark + keyframe]
```

Alternatives considered:

- **Split at pauses.** I measured the gaps on two older unpunctuated captures. One had a single pause (1.9 s) in 20 s of speech, so pauses aren't a reliable boundary.
- **Never split a sentence.** My first version did exactly that, and my first real test broke it. I circled three things while saying "This part, this part and this part.", and the whole sentence went to the middle circle, leaving #1 empty. Pointing while talking is a natural way to use this. The timings separated the two cases cleanly: I'd paused 2.0 s and 1.7 s at the second and third circles, while the e2e speaker's mid-sentence marks had gaps of at most 0.4 s. So a sentence is now also split at a mark where there's a silence of 1 s or more.
- **Drop silent clicks entirely.** I chose to keep them as unnumbered lines, so the agent still sees the sequence of clicks.

## What changed

The same example now reads:

```
- #1 (0:04) “This button is misaligned, it should line up with the text box.”
- (0:07) [clicked]
- #2 (0:09) “Then the header font is too big.”
```

Words with no sentence end after them fall back to the old time split, each word going to the mark it starts in. That covers older transcripts without punctuation and an unfinished sentence at the end of a capture.

## Evidence

- Replaying the e2e speech capture's saved words and events through both versions: before, 5 of 6 notes started or ended mid-sentence. After, 0 of 6.
- Replaying my three-circle test: before the pause rule, #1 was empty and #2 had the whole sentence. After it: #1 “This part,” #2 “this part” #3 “and this part. All of these need to be updated.”
- Replaying two of my older unpunctuated captures: the notes match the old time split, except that one click nobody spoke about lost its number.
- `cargo test`: 10 tests pass, including the example above, the three-circle timings, the unpunctuated fallback, and a clicks-only capture (every click stays numbered).
- `tests/e2e.py` passes.

## Tradeoffs and limitations

- A long sentence spanning several marks without a 1 s pause at them goes wholly to one mark, and the others can end up with no text.
- The 1 s threshold comes from three captures, not a broad sample.
- Sentence ends depend on whisper's punctuation. Unpunctuated speech gets the old behaviour.
- Abbreviations like "e.g." count as sentence ends.
- Not measured in my real session yet.
