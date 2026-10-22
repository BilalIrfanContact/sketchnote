(() => {
  const stops = [
    ['director', 'start', 0.1, 1.0, 'Director → GNOME Shell extension', 'Alt+Shift+S starts a capture anywhere.'],
    ['screen', 'draw', 0.1, 3.0, 'Film set → your desktop', 'Talk. Hold Shift to draw or drop a pin.'],
    ['camera', 'record', 0.0, 2.5, 'Camera → GNOME Screencast', 'Records your screen and ink without portal prompts.'],
    ['mic', 'record', 0.0, 2.5, 'Microphone → pw-record', 'Records your voice alongside the screen capture.'],
    ['dbus', 'finish', 0.0, 2.6, 'Walkie-talkie → D-Bus', 'Carries marks and timestamps to the service.'],
    ['service', 'build', 0.0, 0.8, 'Editing room → Rust service', 'Queues captures and builds bundles in the background.'],
    ['ffmpeg', 'build', 0.8, 2.2, 'Film lab → ffmpeg', 'Converts video and extracts frames for your marks.'],
    ['vad', 'build', 2.2, 2.5, 'Silence marker → Silero voice detector', 'Separates speech from silence.'],
    ['whisper', 'build', 2.5, 5.7, 'Stenographer → whisper.cpp', 'Transcribes locally. Word timestamps match speech to marks.'],
    ['bundle', 'ready', 1.0, 2.8, 'Delivery box → capture bundle', 'Packages timestamped notes and cropped, annotated keyframes.'],
    ['clipboard', 'paste', 0.0, 3.3, 'Clipboard → Ctrl+V', 'Pastes notes, then the contact sheet, into your agent.'],
  ];
  const hold = 2.8;
  const duration = stops.length * hold;
  const svg = document.querySelector('.sn-stage svg');
  svg.insertAdjacentHTML('beforeend', `<g class="sn-callout" aria-hidden="true">
    <path class="sn-leader-under"/><path class="sn-leader"/>
    <circle class="sn-anchor" r="5"/>
    <g class="sn-label">
      <rect x="52" y="546" width="896" height="82" rx="6"/>
      <text class="sn-stop-number" x="76" y="579"/>
      <text class="sn-label-title" x="142" y="579"/>
      <text class="sn-label-detail" x="142" y="606"/>
    </g>
  </g>`);
  const get = s => svg.querySelector(s);
  const callout = get('.sn-callout');
  const label = get('.sn-label');
  const anchor = get('.sn-anchor');
  const leader = get('.sn-leader');
  const under = get('.sn-leader-under');
  const clamp = x => Math.max(0, Math.min(1, x));
  const ease = x => 1 - (1 - clamp(x)) ** 3;
  let manual = false, elapsed = 0, last = null, current = -1;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function render(seconds) {
    const loop = ((seconds % duration) + duration) % duration;
    const index = Math.floor(loop / hold);
    const local = loop - index * hold;
    const [part, step, from, to, title, detail] = stops[index];
    window.sketchnoteScene.seek(step, from + (to - from) * local / hold);
    svg.querySelectorAll('[data-part]').forEach(e => {
      e.classList.toggle('is-lit', e.dataset.part === part);
    });
    if (current !== index) {
      current = index;
      get('.sn-stop-number').textContent = `${String(index + 1).padStart(2, '0')}/${stops.length}`;
      get('.sn-label-title').textContent = title;
      get('.sn-label-detail').textContent = detail;
    }
    // Ignore the separate floor cable when the same part also has a physical prop.
    document.querySelector('[data-corner=readout]').textContent = 'One capture, from hotkey to paste';
    const targets = [...svg.querySelectorAll(`[data-part="${part}"]`)]
      .filter(e => e.getClientRects().length && !e.querySelector('.sn-cable'))
      .sort((a, b) => {
        const aa = a.getBBox(), bb = b.getBBox();
        return bb.width * bb.height - aa.width * aa.height;
      });
    const target = part === 'mic' ? svg.querySelector('[data-tour-mic]') : targets[0];
    if (!target) throw new Error(`Missing tour prop: ${part}`);
    const box = target.getBBox();
    const point = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2)
      .matrixTransform(svg.getScreenCTM().inverse().multiply(target.getScreenCTM()));
    anchor.setAttribute('cx', point.x);
    anchor.setAttribute('cy', point.y);
    const path = `M${point.x} ${point.y} L${point.x} 522 L110 546`;
    leader.setAttribute('d', path); under.setAttribute('d', path);
    const enter = ease(local / 0.24);
    const leave = clamp((hold - local) / 0.18);
    callout.style.opacity = String(enter * leave);
    label.setAttribute('transform', `translate(0 ${6 * (1 - enter)})`);
  }

  // Exporting uses the same timeline as playback, with no wall-clock dependence.
  window.sketchnoteTour = {
    duration, hold, stops,
    seek(seconds) { manual = true; render(seconds); },
  };
  function tick(now) {
    if (last !== null && !manual && !reduced.matches && !document.hidden) {
      elapsed += Math.min((now - last) / 1000, 0.1);
      render(elapsed);
    }
    last = now;
    requestAnimationFrame(tick);
  }
  render(0.5);
  document.querySelector('[data-corner=hint]').textContent = 'Local transcription · illustrative timing';
  requestAnimationFrame(tick);
})();
