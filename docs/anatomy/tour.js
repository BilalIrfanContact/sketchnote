// Labeled tour for the README GIF: one stop at a time, a callout pops up beside the
// prop and translates the analogy ("Camera → GNOME Screencast"), with a short leader
// from a dot on the prop to the card. Positions are in SVG units (1000 × 640).
// The exporter calls window.sketchnoteTour.seek(t) per frame; nothing reads the clock.
(() => {
  // [part, scene step, scene from, scene to, title, detail, dot on the prop, card corner]
  const stops = [
    ['director', 'start', 0.1, 1.0, 'Director → GNOME Shell extension', 'Alt+Shift+S starts a capture from any app.', [300, 196], [36, 64]],
    ['screen', 'draw', 0.1, 3.0, 'Film set → your desktop', 'Talk, and hold Shift to circle what you mean.', [470, 96], [584, 46]],
    ['camera', 'record', 0.0, 2.5, 'Camera → GNOME Screencast', 'Films the whole screen, with no sharing prompt.', [434, 214], [36, 64]],
    ['mic', 'record', 0.0, 2.5, 'Microphone → pw-record', 'Records your voice from the first second.', [352, 178], [36, 64]],
    ['dbus', 'finish', 0.0, 2.6, 'Walkie-talkie → D-Bus', 'The one line between the extension and the service.', [342, 214], [36, 330]],
    ['service', 'build', 0.0, 0.8, 'Editing room → the Rust service', 'Turns the recording into notes and frames.', [700, 262], [584, 46]],
    ['ffmpeg', 'build', 0.8, 2.2, 'Film lab → ffmpeg', 'Converts the video and pulls a frame per mark.', [652, 268], [584, 46]],
    ['whisper', 'build', 2.5, 5.7, 'Stenographer → whisper.cpp', 'Transcribes on your CPU, timing every word.', [598, 318], [300, 528]],
    ['vad', 'build', 2.2, 2.5, 'Silence marker → voice detector', 'Finds your pauses, so sentences split between marks.', [680, 348], [470, 528]],
    ['api', 'build', 3.0, 3.0, 'Outside booth → transcription API', 'Optional and faster; only the mic audio leaves.', [780, 400], [470, 528]],
    ['bundle', 'ready', 1.0, 2.8, 'Delivery box → the capture bundle', 'Numbered notes and a contact sheet of cropped frames.', [602, 384], [250, 528]],
    ['clipboard', 'paste', 0.0, 3.3, 'Clipboard → one Ctrl+V', 'Pastes the notes, then the frames, into your agent.', [333, 200], [36, 64]],
  ];
  const HOLD = 2.8;
  const duration = stops.length * HOLD;
  const svg = document.querySelector('.sn-stage svg');
  const NS = 'http://www.w3.org/2000/svg';

  // Lit parts get a red outline and a light red tint, readable at README size.
  svg.insertAdjacentHTML('afterbegin', `<defs>
    <filter id="sn-lit" x="-10%" y="-10%" width="120%" height="120%">
      <feMorphology in="SourceAlpha" operator="dilate" radius="1.4" result="grown"/>
      <feFlood flood-color="#ff3030"/><feComposite in2="grown" operator="in" result="outline"/>
      <feFlood flood-color="#ff3030" flood-opacity="0.2"/><feComposite in2="SourceAlpha" operator="in" result="tint"/>
      <feMerge><feMergeNode in="outline"/><feMergeNode in="SourceGraphic"/><feMergeNode in="tint"/></feMerge>
    </filter>
    <filter id="sn-card-shadow" x="-10%" y="-30%" width="120%" height="170%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000" flood-opacity="0.12"/>
    </filter>
  </defs>`);
  svg.insertAdjacentHTML('beforeend', `<g class="sn-callout" aria-hidden="true">
    <path class="sn-leader"/>
    <circle class="sn-ring" r="9"/><circle class="sn-dot" r="4.5"/>
    <g class="sn-card">
      <rect class="sn-card-box" rx="10" filter="url(#sn-card-shadow)"/>
      <text class="sn-card-num"/><text class="sn-card-title"/><text class="sn-card-detail"/>
    </g>
  </g>
  <g class="sn-progress" aria-hidden="true"></g>`);
  const $ = s => svg.querySelector(s);
  const progress = $('.sn-progress');
  stops.forEach((_, i) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', 500 + (i - (stops.length - 1) / 2) * 16);
    c.setAttribute('cy', 612); c.setAttribute('r', 3.2);
    progress.append(c);
  });

  const clamp = x => Math.max(0, Math.min(1, x));
  const ease = x => 1 - (1 - clamp(x)) ** 3;
  const PAD = 18, NUM_W = 38;
  let laidOut = -1, cardBox = null;

  // Sizes the card to its text once per stop and returns its box in SVG units.
  function layout(i) {
    const [, , , , title, detail, , [x, y]] = stops[i];
    $('.sn-card-num').textContent = String(i + 1).padStart(2, '0');
    $('.sn-card-title').textContent = title;
    $('.sn-card-detail').textContent = detail;
    const w = PAD * 2 + NUM_W + Math.max($('.sn-card-title').getComputedTextLength(), $('.sn-card-detail').getComputedTextLength());
    const h = 70;
    const left = Math.min(x, 1000 - w - 20);
    $('.sn-card-box').setAttribute('x', left); $('.sn-card-box').setAttribute('y', y);
    $('.sn-card-box').setAttribute('width', w); $('.sn-card-box').setAttribute('height', h);
    $('.sn-card-num').setAttribute('x', left + PAD); $('.sn-card-num').setAttribute('y', y + 30);
    for (const [cls, dy] of [['.sn-card-title', 30], ['.sn-card-detail', 53]]) {
      $(cls).setAttribute('x', left + PAD + NUM_W); $(cls).setAttribute('y', y + dy);
    }
    return { x: left, y, w, h };
  }

  // The leader runs from the dot to the card edge facing it, so it can draw outward.
  function leaderPath([dx, dy], { x, y, w, h }) {
    const ex = dx < x ? x : dx > x + w ? x + w : Math.min(Math.max(dx, x + 24), x + w - 24);
    const ey = dy < y ? y : dy > y + h ? y + h : y + h / 2;
    return `M${dx} ${dy} L${ex} ${ey}`;
  }

  function render(seconds) {
    const loop = ((seconds % duration) + duration) % duration;
    const i = Math.min(stops.length - 1, Math.floor(loop / HOLD));
    const u = loop - i * HOLD;
    const [part, step, from, to, , , dot] = stops[i];
    window.sketchnoteScene.seek(step, from + (to - from) * u / HOLD);
    svg.querySelectorAll('[data-part]').forEach(e => e.classList.toggle('is-lit', e.dataset.part === part));
    if (laidOut !== i) { cardBox = layout(i); laidOut = i; }

    // Dot lands, leader draws from the dot to the card, card slides in; all fade out together.
    const land = ease(u / 0.2), draw = ease((u - 0.12) / 0.3), show = ease((u - 0.3) / 0.3);
    const fade = clamp((HOLD - u) / 0.25);
    $('.sn-dot').setAttribute('cx', dot[0]); $('.sn-dot').setAttribute('cy', dot[1]);
    $('.sn-ring').setAttribute('cx', dot[0]); $('.sn-ring').setAttribute('cy', dot[1]);
    $('.sn-dot').style.opacity = String(land * fade);
    $('.sn-ring').style.opacity = String(0.5 * (1 - clamp((u - 0.2) / 1.2)) * fade);
    $('.sn-ring').setAttribute('r', 5 + 10 * clamp((u - 0.2) / 1.2));
    const leader = $('.sn-leader');
    leader.setAttribute('d', leaderPath(dot, cardBox));
    const len = leader.getTotalLength();
    leader.style.strokeDasharray = `${len}`;
    leader.style.strokeDashoffset = String(len * (1 - draw));   // grows from the dot outward
    leader.style.opacity = String(fade);
    const card = $('.sn-card');
    card.style.opacity = String(show * fade);
    card.setAttribute('transform', `translate(0 ${8 * (1 - show)})`);
    progress.querySelectorAll('circle').forEach((c, j) => c.setAttribute('class', j === i ? 'is-now' : j < i ? 'is-done' : ''));
  }

  window.sketchnoteTour = { duration, hold: HOLD, stops, seek(t) { manual = true; render(t); } };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let manual = false, elapsed = 0, last = null;
  function tick(now) {
    if (last !== null && !manual && !reduced.matches && !document.hidden) {
      elapsed += Math.min((now - last) / 1000, 0.1);
      render(elapsed);
    }
    last = now;
    requestAnimationFrame(tick);
  }
  render(1.4);
  requestAnimationFrame(tick);
})();
