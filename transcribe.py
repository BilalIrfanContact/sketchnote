"""Print word-level timestamps for a 16 kHz mono WAV as JSON: [{word, start, end}, ...].

Runs inside the project venv (faster-whisper). The WAV is read with the stdlib
because faster-whisper's PyAV decoder breaks with current PyAV releases.
"""
import json
import os
import sys
import wave

import numpy as np
from faster_whisper import WhisperModel

MODEL = os.environ.get('SKETCHNOTE_MODEL', 'small')


def read_wav(path):
    with wave.open(path) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, \
            'expected 16 kHz mono s16 audio'
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def main(path):
    audio = read_wav(path)
    if len(audio) < 1600:  # under 0.1 s: nothing to say
        print('[]')
        return
    model = WhisperModel(MODEL, device='cpu', compute_type='int8',
                         cpu_threads=max(1, (os.cpu_count() or 2) // 2))
    segments, _ = model.transcribe(audio, word_timestamps=True, vad_filter=True)
    words = [{'word': w.word, 'start': round(w.start, 3), 'end': round(w.end, 3)}
             for s in segments for w in (s.words or [])]
    print(json.dumps(words))


if __name__ == '__main__':
    main(sys.argv[1])
