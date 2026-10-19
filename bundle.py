"""Turn a finished capture (events from the extension + raw recordings) into a bundle.

Bundle layout (inside the capture's directory):
    recording.mp4        screen recording, 30 fps H.264
    audio.wav            microphone, 16 kHz mono
    frames-full/NN.png   full keyframe per mark, annotations burned in
    frames/frame-NN.png  the same keyframe cropped to the activity
    contact-sheet.png    cropped keyframes in a two-column grid with number badges
    summary.md           agent handoff text (what `sketchnote paste-text` copies)
    sketchnote.json      capture data: timings, strokes, events, target, words, marks

All times in the capture are seconds since the hotkey press (capture t0), and all
coordinates are GNOME stage coordinates (logical pixels).
"""
import json
import os
import subprocess

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
VENV_PYTHON = os.path.join(HERE, '.venv', 'bin', 'python')
NICE = ['nice', '-n', '10']   # heavy work must not starve GNOME Shell (the desktop lags)

RED = (255, 48, 48)
BLUE = (64, 140, 255)
SHEET_BG = (17, 17, 19)
COLUMN_WIDTH = 720
GAP = 16
PAD = 160            # logical px of context around a mark's activity
MIN_CROP = (640, 400)  # logical px; small marks still get readable context


def build(bundle_dir, capture, audio_t0_us):
    """Write the full bundle. `capture` is the dict sent by the extension."""
    t0 = capture['t0']
    video_offset = (capture['video_t0'] - t0) / 1e6
    audio_offset = (audio_t0_us - t0) / 1e6
    duration = (capture['end'] - t0) / 1e6

    video = os.path.join(bundle_dir, 'recording.mp4')
    convert_video(capture['video'], video)
    video_size = probe_size(video)

    words = [dict(w, start=w['start'] + audio_offset, end=w['end'] + audio_offset)
             for w in transcribe(os.path.join(bundle_dir, 'audio.wav'))]
    marks = make_marks(capture['events'], words, duration)

    os.makedirs(os.path.join(bundle_dir, 'frames'), exist_ok=True)
    os.makedirs(os.path.join(bundle_dir, 'frames-full'), exist_ok=True)
    tiles = []
    for mark in marks:
        frame = grab_frame(video, mark['frame_t'] - video_offset)
        to_px = mapper(capture['area'], video_size)
        draw_mark(frame, mark, to_px)
        crop = crop_box(mark, capture['area'], to_px, video_size)
        name = f"frame-{mark['n']:02d}.png"
        frame.save(os.path.join(bundle_dir, 'frames-full', name))
        tile = frame.crop(crop)
        tile.save(os.path.join(bundle_dir, 'frames', name))
        tiles.append((mark['n'], tile))
    contact_sheet(tiles).save(os.path.join(bundle_dir, 'contact-sheet.png'))

    target = main_target(capture)
    with open(os.path.join(bundle_dir, 'summary.md'), 'w') as f:
        f.write(summary(marks))
    with open(os.path.join(bundle_dir, 'sketchnote.json'), 'w') as f:
        json.dump({'duration': duration, 'mode': capture['mode'], 'area': capture['area'],
                   'target': target, 'video_offset': video_offset,
                   'audio_offset': audio_offset, 'events': capture['events'],
                   'words': words, 'marks': marks}, f, indent=1)


# --- marks -----------------------------------------------------------------

def make_marks(events, words, duration):
    """One mark per stroke, click or pin, in time order.

    Each mark gets the words spoken from its own start until the next mark starts;
    words spoken before the first mark belong to the first mark. With no events at
    all the whole capture becomes a single mark keyed on the last frame.
    """
    events = sorted(events, key=lambda e: e['t'])
    if not events:
        events = [{'type': 'none', 't': 0.0, 'frame_t': max(0.0, duration - 0.2)}]
    marks = []
    for i, e in enumerate(events):
        start = 0.0 if i == 0 else e['t']
        end = events[i + 1]['t'] if i + 1 < len(events) else float('inf')
        text = ''.join(w['word'] for w in words if start <= w['start'] < end).strip()
        marks.append({
            'n': i + 1,
            't': e['t'],
            'type': e['type'],
            # Keyframe right after the stroke is finished (or the click/pin landed).
            'frame_t': e.get('frame_t', e.get('t_end', e['t']) + 0.1),
            'event': e,
            'text': text,
        })
    return marks


def summary(marks):
    tags = {'click': '[clicked] ', 'pin': '[pin] '}
    lines = []
    for m in marks:
        said = f'“{m["text"]}”' if m['text'] else ''
        lines.append(f'- #{m["n"]} ({clock(m["t"])}) {tags.get(m["type"], "")}{said}'.rstrip())
    return '\n'.join(lines) + '\n'


def main_target(capture):
    """The window most marks happened in, falling back to the focused window at start."""
    counts = {}
    for e in capture['events']:
        w = e.get('window')
        if w:
            key = (w['app'], w['title'])
            counts[key] = counts.get(key, 0) + 1
    if counts:
        app, title = max(counts, key=counts.get)
        return {'app': app, 'title': title}
    w = capture.get('window')
    return {'app': w['app'], 'title': w['title']} if w else None


def clock(seconds):
    s = int(seconds)
    return f'{s // 60}:{s % 60:02d}'


# --- images ----------------------------------------------------------------

def mapper(area, video_size):
    """Map stage coordinates to pixels of the recording (handles area offset + scale)."""
    ax, ay, aw, ah = area
    sx, sy = video_size[0] / aw, video_size[1] / ah
    return lambda x, y: ((x - ax) * sx, (y - ay) * sy)


def draw_mark(img, mark, to_px):
    d = ImageDraw.Draw(img)
    scale = to_px(1, 0)[0] - to_px(0, 0)[0]
    e = mark['event']
    if e['type'] == 'stroke':
        pts = [to_px(x, y) for x, y in e['points']]
        if len(pts) > 1:
            d.line(pts, fill=RED, width=max(2, round(3 * scale)), joint='curve')
    elif e['type'] == 'click':
        x, y = to_px(e['x'], e['y'])
        r = 14 * scale
        d.ellipse([x - r, y - r, x + r, y + r], outline=BLUE, width=max(2, round(3 * scale)))
    elif e['type'] == 'pin':
        x, y = to_px(e['x'], e['y'])
        r = 13 * scale
        d.ellipse([x - r, y - r, x + r, y + r], fill=RED)
        font = ImageFont.load_default(size=round(15 * scale))
        d.text((x, y), str(mark['n']), fill='white', font=font, anchor='mm')


def crop_box(mark, area, to_px, video_size):
    """Box around the mark's activity, padded, clamped to its window and the recording."""
    e = mark['event']
    if e['type'] == 'none':
        return (0, 0, *video_size)
    pts = e['points'] if e['type'] == 'stroke' else [(e['x'], e['y'])]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    x0, y0, x1, y1 = min(xs) - PAD, min(ys) - PAD, max(xs) + PAD, max(ys) + PAD
    x0, x1 = grow(x0, x1, MIN_CROP[0])
    y0, y1 = grow(y0, y1, MIN_CROP[1])
    bounds = area[:]
    if e.get('window'):
        wx, wy, ww, wh = e['window']['rect']
        bounds = [max(area[0], wx), max(area[1], wy),
                  min(area[0] + area[2], wx + ww) - max(area[0], wx),
                  min(area[1] + area[3], wy + wh) - max(area[1], wy)]
    bx0, by0, bx1, by1 = bounds[0], bounds[1], bounds[0] + bounds[2], bounds[1] + bounds[3]
    x0, y0, x1, y1 = max(x0, bx0), max(y0, by0), min(x1, bx1), min(y1, by1)
    if x1 - x0 < 8 or y1 - y0 < 8:      # activity outside its window/area: use the area
        x0, y0, x1, y1 = area[0], area[1], area[0] + area[2], area[1] + area[3]
    (px0, py0), (px1, py1) = to_px(x0, y0), to_px(x1, y1)
    w, h = video_size
    return (max(0, round(px0)), max(0, round(py0)), min(w, round(px1)), min(h, round(py1)))


def grow(a, b, size):
    if b - a >= size:
        return a, b
    mid = (a + b) / 2
    return mid - size / 2, mid + size / 2


def contact_sheet(tiles):
    """Two-column masonry: each tile goes into the currently shorter column."""
    cols = [GAP, GAP]
    placed = []
    for n, tile in tiles:
        tw = COLUMN_WIDTH
        th = max(1, round(tile.height * tw / tile.width))
        c = 0 if cols[0] <= cols[1] else 1
        placed.append((n, tile.resize((tw, th), Image.LANCZOS), GAP + c * (tw + GAP), cols[c]))
        cols[c] += th + GAP
    ncols = 2 if len(tiles) > 1 else 1
    sheet = Image.new('RGB', (GAP + ncols * (COLUMN_WIDTH + GAP), max(cols)), SHEET_BG)
    d = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=17)
    for n, tile, x, y in placed:
        sheet.paste(tile, (x, y))
        cx, cy, r = x + COLUMN_WIDTH - 22, y + 22, 14
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(24, 24, 27), outline='white', width=2)
        d.text((cx, cy), str(n), fill='white', font=font, anchor='mm')
    return sheet


# --- external tools ----------------------------------------------------------

def convert_video(src, dst):
    subprocess.run([*NICE, 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
                    '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264',
                    '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-an', dst],
                   check=True)
    os.remove(src)


def probe_size(video):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=width,height', '-of', 'csv=p=0', video],
                         capture_output=True, text=True, check=True).stdout
    w, h = out.strip().split(',')
    return int(w), int(h)


def grab_frame(video, t):
    out = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-ss', f'{max(0, t):.3f}',
                          '-i', video, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'],
                         capture_output=True, check=True).stdout
    if not out:  # asked past the end: take the last frame
        out = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-sseof', '-0.1',
                              '-i', video, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png',
                              '-'], capture_output=True, check=True).stdout
    from io import BytesIO
    return Image.open(BytesIO(out)).convert('RGB')


def transcribe(wav):
    """Word timestamps from faster-whisper, run in the project venv."""
    out = subprocess.run([*NICE, VENV_PYTHON, os.path.join(HERE, 'transcribe.py'), wav],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)
