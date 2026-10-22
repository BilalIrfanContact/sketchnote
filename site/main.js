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

runDemo();
