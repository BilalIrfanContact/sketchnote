// Landing page behaviour: the demo loop, copy buttons and scroll reveals.

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Demo: each step is a CSS state on .stage[data-step]; durations in ms.
// 0 idle, 1 recording, 2 first mark, 3 second mark, 4 transcribing, 5 ready, 6 pasted, 7 reset.
const STEPS = [900, 1200, 2600, 2400, 1700, 1300, 5200, 900];

const stage = document.querySelector(".stage");
const timer = stage?.querySelector(".timer");

function runDemo() {
  if (!stage) return;
  if (reduceMotion) {
    stage.dataset.step = "6"; // show the result, without motion
    return;
  }
  let step = 0;
  let seconds = 0;
  let ticker = null;
  const advance = () => {
    stage.dataset.step = String(step);
    if (step === 1) {
      seconds = 0;
      timer.textContent = "0:00";
      ticker = setInterval(() => {
        seconds += 1;
        timer.textContent = `0:${String(seconds).padStart(2, "0")}`;
      }, 1000);
    }
    if (step === 4) clearInterval(ticker);
    const wait = STEPS[step];
    step = (step + 1) % STEPS.length;
    setTimeout(advance, wait);
  };
  advance();
}

// Copy buttons copy the command text next to them.
for (const box of document.querySelectorAll("[data-copy]")) {
  const button = box.querySelector(".copy");
  const text = box.querySelector(".cmd-text").textContent;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
      button.classList.add("done");
    } catch {
      button.textContent = "Select and copy";
    }
    setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove("done");
    }, 1800);
  });
}

// Sections fade in once as they enter the viewport.
if (!reduceMotion && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15 },
  );
  for (const el of document.querySelectorAll("main > section:not(.hero)")) {
    el.classList.add("reveal");
    observer.observe(el);
  }
}

// Hero logo: a red pen line follows the loop's centreline the way a hand would draw it,
// then the exact logo shape replaces it. A click draws it again. Browsers mute audio until
// the visitor interacts, so the first, automatic draw is usually silent.
const DRAW_MS = 1150;
const DRAW_EASE = "cubic-bezier(0.55, 0.1, 0.3, 1)";
const mark = document.querySelector(".hero-mark");
const pen = mark?.querySelector(".pen");
let audio = null;

function drawLogo(delayMs = 0) {
  if (!pen || reduceMotion) return;
  pen.getAnimations().forEach((a) => a.cancel());
  mark.classList.add("drawing");
  // fill "both" keeps the line hidden during the delay, so the logo never flashes first.
  const draw = pen.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
    { duration: DRAW_MS, delay: delayMs, easing: DRAW_EASE, fill: "both" });
  draw.finished.then(() => mark.classList.remove("drawing"), () => {});  // cancelled: a redraw took over
  pencilSound(DRAW_MS / 1000, delayMs / 1000);
}

// Pencil on paper: band-passed noise whose loudness follows the pen's speed (slow start,
// quick middle, a flick at the end), with random grain so it doesn't sound like hiss.
function pencilSound(seconds, delay) {
  audio ??= new AudioContext();
  if (audio.state === "suspended") audio.resume().catch(() => {});
  const t0 = audio.currentTime + delay + 0.02;
  const length = Math.ceil(audio.sampleRate * seconds);
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

  const noise = audio.createBufferSource();
  noise.buffer = buffer;
  const band = new BiquadFilterNode(audio, { type: "bandpass", frequency: 3200, Q: 0.8 });
  const low = new BiquadFilterNode(audio, { type: "highpass", frequency: 900 });
  const gain = new GainNode(audio, { gain: 0 });
  noise.connect(band).connect(low).connect(gain).connect(audio.destination);

  const steps = 60;
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    const speed = Math.sin(Math.PI * p) ** 0.7;    // matches the ease-in-out of the draw
    const grain = 0.55 + 0.45 * Math.random();
    gain.gain.linearRampToValueAtTime(0.32 * speed * grain, t0 + p * seconds);
  }
  noise.start(t0);
  noise.stop(t0 + seconds + 0.05);
}

if (mark) {
  mark.addEventListener("click", () => drawLogo());
  drawLogo(300);
}

runDemo();
