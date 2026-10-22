// Builds docs/anatomy/sketchnote.html (and -light.html with --light): an isometric model
// of how a capture becomes a paste, using a film crew as the analogy.
// Run: node docs/anatomy/build.mjs [--light] [--tour]
// Needs the anatomy skill's kit; ANATOMY_KIT overrides where it lives.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = process.env.ANATOMY_KIT || join(homedir(), ".agents/skills/anatomy");
const k = await import(pathToFileURL(join(SKILL, "kit/iso-kit.mjs")).href);
const G = await import(pathToFileURL(join(SKILL, "kit/lathe.mjs")).href);
const theme = process.argv.includes("--light") ? "light" : "dark";

const tour = process.argv.includes("--tour");
const WIDTH = 1000;
const HEIGHT = 520;

// ---- world plan (units ~ px, z up; +x runs right-down on screen, +y left-down) -------
const STUDIO = { x: 0, y: 0, w: 480, d: 240, r: 10 };
const KIOSK_BOARD = { x: 500, y: 86, w: 60, d: 62, r: 6 };
const BOARD_H = 9;
const FOOT_H = 5;

const P = k.fitProjection(
  [
    ...k.boxCorners(STUDIO, -BOARD_H - FOOT_H, 0),
    ...k.boxCorners(KIOSK_BOARD, -BOARD_H - FOOT_H, 0),
    [8, 8, 104],
    [250, 8, 74],
    [480, 8, 74],
    [528, 117, 72],
  ],
  WIDTH,
  HEIGHT,
  { pad: 22, azimuth: 45 },
);

const at = (p) => k.iso(p, P);
const depth = (p) => k.depthOf(p, P);
const S = (paths, style = {}) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const F3 = (n) => Math.round(n * 100) / 100;
const pathOf = (pts, closed = false) => k.pathOf(pts.map(at), closed);
const box = (x, y, w, d, z, h, o = {}) =>
  S(k.slabOf({ x, y, w, d, r: o.r ?? 0.8 }, z, h, P, o.steps ?? 3, o.bevel ?? 0.4), { tone: o.tone ?? "mid", crease: o.crease, inner: o.inner, lit: o.lit });
const cyl = (cx, cy, r, z, h, o = {}) => S(k.cylinder(cx, cy, r, z, h, P, o.steps ?? 24, o.bevel ?? 0), { tone: o.tone ?? "mid", crease: o.crease, inner: o.inner });
const rod = (a, b, r, o = {}) => {
  const d = G.sub3(b, a);
  return S(G.solidOf([[0, r], [G.len3(d), r]], G.frameAlong(a, G.unit3(d)), P), { tone: o.tone ?? "mid" });
};
const discAlong = (c, axis, s0, s1, r, o = {}) => S(G.disc(s0, s1, r, G.frameAlong(c, axis), P), { tone: o.tone ?? "mid", inner: o.inner });
const halo = (plan, z, h) => `<path class="iso-halo" d="${k.haloOf(plan, z, h, P)}"/>`;
// Face planes: planeY(y) maps local (x, -z) onto the vertical face at y (facing +y),
// planeX(x) maps local (-y, -z) onto the face at x (facing +x), planeZ(z) maps (x, y)
// onto a horizontal face.
const planeY = (y) => k.sideMatrix([0, y], 0, P, "left");
const planeX = (x) => k.sideMatrix([x, 0], 0, P, "right");
const planeZ = (z) => k.topMatrix([0, 0], z, P);
const rect = (u0, v0, u1, v1, r = 0.6) => k.pathOf(k.roundedPlan({ x: u0, y: v0, w: u1 - u0, d: v1 - v0, r }, 3), true);
const onY = (y, inner) => `<g transform="${planeY(y)}">${inner}</g>`;
const onX = (x, inner) => `<g transform="${planeX(x)}">${inner}</g>`;
const onZ = (z, inner) => `<g transform="${planeZ(z)}">${inner}</g>`;
// A rect on the face at y, in world x and z.
const yRect = (x0, z0, x1, z1, r) => rect(x0, -z1, x1, -z0, r);
// A rect on the face at x, in world y and z.
const xRect = (y0, z0, y1, z1, r) => rect(-y1, -z1, -y0, -z0, r);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const txt = (x, y, s, size, cls, extra = "") => `<text class="${cls}" x="${F3(x)}" y="${F3(y)}" font-size="${size}"${extra}>${esc(s)}</text>`;
const topText = (x, y, z, s, size = 2, tone = "mid") => k.faceTextSvg(k.topMatrix([x, y], z, P), s, { size, tone, anchor: "middle" });

// One hoverable part. Several groups may share a name; `when` lists the steps it shows in.
const part = (name, svg, extra = "") => `<g class="sn-part" data-part="${name}"${extra}>${svg}</g>`;
const when = (spec, svg, extra = "") => `<g data-when="${spec}"${extra}>${svg}</g>`;

// Items are sorted far to near inside each layer.
function layer() {
  const items = [];
  return {
    put(ref, svg, bias = 0) {
      items.push({ key: depth(ref) + bias, svg });
    },
    svg() {
      return items.sort((a, b) => a.key - b.key).map((i) => i.svg).join("");
    },
  };
}

function board(plan, tone = "lo", { label } = {}) {
  const out = [halo(plan, -BOARD_H - FOOT_H, BOARD_H)];
  const feet = k.corners(plan, 18).sort((a, b) => depth([...a, 0]) - depth([...b, 0]));
  for (const [x, y] of feet) {
    out.push(S(k.cylinder(x, y, 6, -BOARD_H - FOOT_H, 1.4, P, 24), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 4.6, -BOARD_H - FOOT_H + 1.4, FOOT_H - 1.4, P, 24), { tone: "mid" }));
  }
  out.push(S(k.slabOf(plan, -BOARD_H, BOARD_H, P, 8, 1.4), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(plan, 5), 0, P), { tone: "lo" }));
  const screws = k.corners(plan, 9);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
  if (label) {
    const { x, y, w } = label;
    out.push(S(k.slabOf({ x, y, w, d: 8, r: 1 }, 0, 0.7, P, 3), { tone: "lo", crease: "none" }));
    out.push(L([w - 10, w - 18].map((len, i) => k.lineOnTop([x + 3, y + 2.6 + i * 2.8], [x + 3 + len, y + 2.6 + i * 2.8], 0.7, P)).join(""), { tone: "lo", free: true }));
    out.push(D([at([x + w - 2.6, y + 4, 0.7])], { size: 0.45 }));
  }
  return out.join("");
}

// A floor cable: a thicker line with terminal dots, drawn before what stands on it.
const cable = (pts, cls = "", tone = "mid") =>
  `<g class="iso-wire sn-cable ${cls}" data-tone="${tone}">${L(pathOf(pts), { tone })}<circle class="iso-wire-end" cx="${F3(at(pts[0])[0])}" cy="${F3(at(pts[0])[1])}" r="1.1"/><circle class="iso-wire-end" cx="${F3(at(pts.at(-1))[0])}" cy="${F3(at(pts.at(-1))[1])}" r="1.1"/></g>`;

// Keycap with an engraved legend; `id` lets the live code press it.
function keycap(x, y, w, d, label, id, z = 24.5) {
  const plan = { x, y, w, d, r: 1 };
  return `<g class="sn-key" data-key="${id}">${S(k.slabOf(plan, z, 2.2, P, 3, 0.3), { tone: "hi", crease: "faint" })}${L(k.planOutline(k.insetPlan(plan, 1), z + 2.2, P, 3), { tone: "faint" })}${topText(x + w / 2, y + d / 2 + 0.7, z + 2.2, label, label.length > 3 ? 1.5 : 1.9, "mid")}</g>`;
}

// A reel standing in the plane at x (axis along x), with spokes that spin.
function reelX(cx, cy, cz, r, t, spin, tone = "hi") {
  const F = G.frameAlong([cx - t / 2, cy, cz], [1, 0, 0]);
  const holes = [0, 1, 2].map((i) => {
    const a = (i / 3) * Math.PI * 2;
    return `<circle cx="${F3(Math.cos(a) * r * 0.55)}" cy="${F3(Math.sin(a) * r * 0.55)}" r="${F3(r * 0.24)}"/>`;
  });
  const face = `<g transform="translate(${F3(-cy)} ${F3(-cz)})"><g data-spin="${spin}" class="sn-reel">${holes.join("")}<circle class="sn-hub" r="${F3(r * 0.14)}"/></g></g>`;
  return S(G.disc(0, t, r, F, P), { tone, inner: onX(cx + t / 2, `<path class="iso-line" data-tone="faint" d="${k.pathOf(Array.from({ length: 48 }, (_, i) => [-cy + Math.cos((i / 48) * 6.283) * r * 0.86, -cz + Math.sin((i / 48) * 6.283) * r * 0.86]), true)}"/>`) }) + onX(cx + t / 2, face);
}

// A reel standing in the plane at y (axis along y).
function reelY(cx, cy, cz, r, t, spin, tone = "hi") {
  const F = G.frameAlong([cx, cy - t / 2, cz], [0, 1, 0]);
  const holes = [0, 1, 2].map((i) => {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    return `<circle cx="${F3(Math.cos(a) * r * 0.55)}" cy="${F3(Math.sin(a) * r * 0.55)}" r="${F3(r * 0.24)}"/>`;
  });
  const ringD = k.pathOf(Array.from({ length: 48 }, (_, i) => [cx + Math.cos((i / 48) * 6.283) * r * 0.86, -cz + Math.sin((i / 48) * 6.283) * r * 0.86]), true);
  return S(G.disc(0, t, r, F, P), { tone, inner: onY(cy + t / 2, `<path class="iso-line" data-tone="faint" d="${ringD}"/>`) }) +
    onY(cy + t / 2, `<g transform="translate(${F3(cx)} ${F3(-cz)})"><g data-spin="${spin}" class="sn-reel">${holes.join("")}<circle class="sn-hub" r="${F3(r * 0.14)}"/></g></g>`);
}

// A reel lying face up.
function reelUp(cx, cy, z, r, h, spin) {
  const spokes = [0, 1, 2].map((i) => {
    const a = (i / 3) * Math.PI * 2;
    return `<circle cx="${F3(Math.cos(a) * r * 0.55)}" cy="${F3(Math.sin(a) * r * 0.55)}" r="${F3(r * 0.22)}"/>`;
  });
  return cyl(cx, cy, r, z, h, { tone: "hi", steps: 32 }) + L(k.ring(cx, cy, r * 0.86, z + h, P, 32), { tone: "faint" }) +
    onZ(z + h, `<g transform="translate(${F3(cx)} ${F3(cy)})"><g data-spin="${spin}" class="sn-reel">${spokes.join("")}<circle class="sn-hub" r="${F3(r * 0.14)}"/></g></g>`);
}

// A wooden crate with plank seams round its visible sides.
function crate(x, y, w, d, z, h, tone = "hi") {
  const plan = { x, y, w, d, r: 0.6 };
  const seams = [0.33, 0.66].map((f) => k.sideSeam(plan, z + h * f, P, 3)).join("");
  return S(k.slabOf(plan, z, h, P, 3, 0.4), { tone, inner: L(seams, { tone: "faint" }) }) + L(k.planOutline(k.insetPlan(plan, 1.6), z + h, P, 3), { tone: "faint" });
}

// ============================================================================
// Studio board: the set, the director, the camera, the sound recordist
// ============================================================================
const SCREEN = { x0: 16, x1: 174, y: 22, d: 8, z0: 13, z1: 103 };
const FACE_Y = SCREEN.y + SCREEN.d;
const DISP = { x0: 22, x1: 168, z0: 19, z1: 97 };

// Cables leave their owners and run into the editing room through its door (y 150..186).
const DOOR = { y0: 150, y1: 186 };
const CABLE_DBUS = [[100, 142, 22], [100, 162, 0], [180, 162, 0], [262, 162, 2.5], [271, 168, 2.5], [271, 178.5, 16]];
const CABLE_MIC = [[215, 183, 1.6], [232, 172, 0], [262, 170, 2.5], [268, 165, 2.5], [268, 160, 16]];
const CABLE_FILM = [[182, 141, 0], [212, 156, 0], [258, 176, 2.5], [262, 140, 2.5], [262, 52, 2.5], [276, 44, 2.5]];
const CABLE_API = [[340, 120, 2.5], [470, 120, 2.5], [480, 120, 0], [503, 120, 0], [508, 138, 0], [519, 138, 0], [519, 134.6, 8]];

function screenFace() {
  const o = [];
  o.push(`<path class="sn-desk" d="${yRect(DISP.x0, DISP.z0, DISP.x1, DISP.z1, 1.2)}"/>`);
  // GNOME top bar with the pencil indicator at the right.
  o.push(`<path class="sn-bar" d="${yRect(DISP.x0, DISP.z1 - 3, DISP.x1, DISP.z1, 0.3)}"/>`);
  o.push(`<g data-when="start record draw" class="sn-stopicon"><path class="sn-red-fill" d="${yRect(DISP.x1 - 6, DISP.z1 - 2.3, DISP.x1 - 4, DISP.z1 - 0.7, 0.2)}"/></g>`);
  o.push(`<g data-when="* start record draw"><path class="iso-line" data-tone="mid" d="M${DISP.x1 - 6.2} ${-(DISP.z1 - 0.8)}L${DISP.x1 - 3.8} ${-(DISP.z1 - 2.2)}"/></g>`);
  // Window 1: the coding agent, with its input box where the paste lands.
  const W1 = { x0: 27, x1: 96, z0: 23, z1: 82 };
  o.push(`<path class="sn-win" d="${yRect(W1.x0, W1.z0, W1.x1, W1.z1, 1)}"/>`);
  o.push(`<path class="sn-winbar" d="${yRect(W1.x0, W1.z1 - 4, W1.x1, W1.z1, 1)}"/>`);
  o.push(`<path class="iso-line" data-tone="lo" d="${yRect(W1.x0, W1.z0, W1.x1, W1.z1, 1)}"/>`);
  for (let i = 0; i < 3; i++) o.push(`<circle class="sn-dotbtn" cx="${W1.x0 + 3 + i * 2.6}" cy="${-(W1.z1 - 2)}" r="0.8"/>`);
  const chat = [[60, 74], [44, 70], [52, 66], [36, 60], [56, 56]];
  chat.forEach(([w, z]) => o.push(`<path class="iso-line" data-tone="faint" data-free="" d="M${W1.x0 + 4} ${-z}H${W1.x0 + 4 + w * 0.8}"/>`));
  o.push(`<path class="sn-input" d="${yRect(W1.x0 + 3, W1.z0 + 3, W1.x1 - 3, W1.z0 + 26, 1)}"/>`);
  o.push(`<path class="iso-line" data-tone="lo" d="${yRect(W1.x0 + 3, W1.z0 + 3, W1.x1 - 3, W1.z0 + 26, 1)}"/>`);
  // What the paste puts there: the notes, then the contact sheet.
  const notes = [[1, 46], [2, 40], [3, 52]];
  o.push(`<g data-when="paste@0.5">${notes.map(([n, w], i) => `<circle class="sn-num" cx="${W1.x0 + 7}" cy="${-(W1.z0 + 23 - i * 3.4)}" r="0.9"/><path class="iso-line" data-tone="hi" data-free="" d="M${W1.x0 + 9.5} ${-(W1.z0 + 23 - i * 3.4)}H${W1.x0 + 9.5 + w}"/>`).join("")}</g>`);
  o.push(`<g data-when="paste@1.4">${[0, 1, 2, 3].map((i) => { const x = W1.x0 + 7 + (i % 2) * 12; const z = W1.z0 + 12 - Math.floor(i / 2) * 7.4; return `<path class="sn-photo" d="${yRect(x, z - 6.4, x + 11, z, 0.4)}"/><path class="iso-line" data-tone="red" d="M${x + 3} ${-(z - 3.2)}a3 1.8 0 1 0 6 0a3 1.8 0 1 0 -6 0"/>`; }).join("")}</g>`);
  // Window 2: the app being talked about, with a button that gets circled.
  const W2 = { x0: 102, x1: 163, z0: 29, z1: 79 };
  o.push(`<path class="sn-win" d="${yRect(W2.x0, W2.z0, W2.x1, W2.z1, 1)}"/>`);
  o.push(`<path class="sn-winbar" d="${yRect(W2.x0, W2.z1 - 4, W2.x1, W2.z1, 1)}"/>`);
  o.push(`<path class="iso-line" data-tone="lo" d="${yRect(W2.x0, W2.z0, W2.x1, W2.z1, 1)}"/>`);
  for (let i = 0; i < 3; i++) o.push(`<circle class="sn-dotbtn" cx="${W2.x0 + 3 + i * 2.6}" cy="${-(W2.z1 - 2)}" r="0.8"/>`);
  o.push(`<path class="sn-tile" d="${yRect(W2.x0 + 4, W2.z0 + 26, W2.x1 - 4, W2.z1 - 7, 0.6)}"/>`);
  [[30, 22], [22, 18.5]].forEach(([w, z]) => o.push(`<path class="iso-line" data-tone="faint" data-free="" d="M${W2.x0 + 5} ${-(W2.z0 + z)}H${W2.x0 + 5 + w}"/>`));
  o.push(`<path class="sn-button" d="${yRect(W2.x0 + 14, W2.z0 + 6, W2.x0 + 40, W2.z0 + 13, 1.6)}"/>`);
  o.push(`<path class="iso-line" data-tone="mid" d="${yRect(W2.x0 + 14, W2.z0 + 6, W2.x0 + 40, W2.z0 + 13, 1.6)}"/>`);
  // Live ink: a loop round the button (hold Shift and drag), then a pin (Shift+click).
  const cx = W2.x0 + 27, cz = W2.z0 + 9.5;
  const loop = Array.from({ length: 60 }, (_, i) => {
    const a = -2.6 + (i / 59) * Math.PI * 2.15;
    const wob = 1 + 0.06 * Math.sin(i * 0.7);
    return [cx + Math.cos(a) * 17.5 * wob, -(cz + Math.sin(a) * 6.8 * wob)];
  });
  o.push(`<path class="sn-ink" data-ink="loop" pathLength="1" d="${k.pathOf(loop)}"/>`);
  o.push(`<circle class="sn-pin" data-ink="pin" cx="${W2.x1 - 9}" cy="${-(W2.z1 - 12)}" r="1.4"/>`);
  // The red edge glow while recording.
  o.push(`<g class="sn-glow">${[0, 1, 2, 3].map((i) => `<path class="sn-glowline" style="opacity:${[0.9, 0.5, 0.28, 0.12][i]}" d="${yRect(DISP.x0 + 0.6 + i * 1.1, DISP.z0 + 0.6 + i * 1.1, DISP.x1 - 0.6 - i * 1.1, DISP.z1 - 3.6 - i * 1.1, 1)}"/>`).join("")}</g>`);
  // The pill at top centre.
  const PX = (DISP.x0 + DISP.x1) / 2;
  o.push(`<g class="sn-pill" data-pill="">`);
  o.push(`<path class="sn-pillbody" d="${yRect(PX - 32, 86.2, PX + 32, 92.6, 3.2)}"/>`);
  o.push(`<circle class="sn-pilldot" data-pill-dot="" cx="${PX - 28.6}" cy="-89.4" r="1.1"/>`);
  o.push(`<text class="sn-pilltext" data-pill-text="" x="${PX - 26.4}" y="-88.4" font-size="2.7">Recording 0:03</text>`);
  o.push(`<g data-when="record draw"><path class="sn-meterbg" d="${yRect(PX + 14, 88.6, PX + 28, 90.2, 0.6)}"/><path class="sn-meter" data-meter="" d="${yRect(PX + 14, 88.6, PX + 28, 90.2, 0.6)}"/></g>`);
  o.push(`</g>`);
  // The notification a fallback or failure leaves, with Retry.
  o.push(`<g data-when="ready paste" data-mode-when="fail"><path class="sn-note" d="${yRect(126, 76, 166, 86, 1)}"/><path class="iso-line" data-tone="lo" d="${yRect(126, 76, 166, 86, 1)}"/><path class="iso-line" data-tone="hi" data-free="" d="M129 -83.4H156"/><path class="iso-line" data-tone="faint" data-free="" d="M129 -80.8H160"/><path class="sn-retry" d="${yRect(151, 77.2, 164, 79.6, 0.8)}"/></g>`);
  return onY(FACE_Y + 0.05, `<g clip-path="url(#sn-disp)">${o.join("")}</g>`);
}

function screen() {
  const o = [halo({ x: SCREEN.x0, y: 12, w: SCREEN.x1 - SCREEN.x0, d: 34, r: 4 }, 0, 6)];
  o.push(box(70, 12, 50, 30, 0, 3, { r: 3, steps: 6, tone: "mid", bevel: 0.6 }));
  o.push(box(88, 22, 14, 6, 3, 10, { r: 1, tone: "mid" }));
  const panel = { x: SCREEN.x0, y: SCREEN.y, w: SCREEN.x1 - SCREEN.x0, d: SCREEN.d, r: 2 };
  o.push(S(k.slabOf(panel, SCREEN.z0, SCREEN.z1 - SCREEN.z0, P, 4, 0.6), { tone: "hi" }));
  o.push(`<clipPath id="sn-disp"><path d="${yRect(DISP.x0, DISP.z0, DISP.x1, DISP.z1, 1.2)}"/></clipPath>`);
  o.push(screenFace());
  o.push(onY(FACE_Y + 0.05, `<path class="iso-line" data-tone="mid" d="${yRect(DISP.x0, DISP.z0, DISP.x1, DISP.z1, 1.2)}"/>`));
  // Vents on top and a power LED on the bezel.
  o.push(L(Array.from({ length: 10 }, (_, i) => k.planOutline({ x: 60 + i * 7, y: SCREEN.y + 2.6, w: 4.6, d: 1.2, r: 0.6 }, SCREEN.z1, P, 3)).join(""), { tone: "faint" }));
  o.push(D([at([SCREEN.x1 - 4, FACE_Y, SCREEN.z0 + 3])], { size: 0.55, tone: "hi" }));
  return part("screen", o.join(""));
}

function director() {
  const o = [];
  o.push(halo({ x: 14, y: 116, w: 92, d: 44, r: 3 }, 0, 6));
  o.push(box(16, 118, 20, 40, 0, 19, { tone: "mid" }));
  o.push(box(84, 118, 20, 40, 0, 19, { tone: "mid" }));
  o.push(L([0.4, 0.75].map((f) => k.sideSeam({ x: 16, y: 118, w: 20, d: 40, r: 0.8 }, 19 * f, P, 3)).join(""), { tone: "faint" }));
  o.push(L([0.4, 0.75].map((f) => k.sideSeam({ x: 84, y: 118, w: 20, d: 40, r: 0.8 }, 19 * f, P, 3)).join(""), { tone: "faint" }));
  o.push(D([at([26, 158, 19 * 0.57]), at([94, 158, 19 * 0.57]), at([26, 158, 19 * 0.2]), at([94, 158, 19 * 0.2])], { size: 0.55, tone: "mid" }));
  o.push(box(36, 119, 48, 2, 4, 15, { tone: "lo" }));
  o.push(box(14, 116, 92, 44, 19, 3, { r: 2, steps: 4, tone: "mid", bevel: 0.6 }));
  // Keyboard plate with the keys Sketchnote listens to.
  o.push(box(20, 125, 48, 28, 22, 2.5, { r: 1.5, tone: "mid", bevel: 0.4 }));
  const U = 6.4, X0 = 22.6, Y0 = 127.4;
  const keys = [
    [0, 0, 1, "Esc", "esc"], [1.5, 0, 1, "Z", "z"], [2.5, 0, 1, "S", "s"], [3.5, 0, 1, "V", "v"],
    [0, 1, 1.9, "Shift", "shift"],
    [0, 2, 1.3, "Ctrl", "ctrl"], [1.3, 2, 1.3, "Alt", "alt"], [2.6, 2, 4.4, "", "space"],
  ];
  o.push(`<g class="sn-keys">${keys.map(([c, r, w, label, id]) => keycap(X0 + c * U + 0.4, Y0 + r * U + 0.4, w * U - 0.8, U - 0.8, label, id)).join("")}</g>`);
  return part("director", o.join(""));
}

// The clipboard on its easel, which shows what Ctrl+V is about to paste.
function clipboard() {
  const o = [];
  o.push(box(68, 131, 24, 7, 22, 2, { tone: "mid" }));
  o.push(box(70, 135.4, 20, 1.6, 24, 24, { tone: "hi", r: 0.6 }));
  const Y = 137.05;
  const sheet = yRect(71.6, 25.6, 88.4, 44.4, 0.3);
  const notes = [0, 1, 2].map((i) => `<circle class="sn-num" cx="73.6" cy="${-(41.6 - i * 4.6)}" r="0.7"/><path class="iso-line" data-tone="mid" data-free="" d="M75.2 ${-(41.6 - i * 4.6)}H${[86, 83, 85.4][i]}"/><path class="iso-line" data-tone="faint" data-free="" d="M75.2 ${-(39.8 - i * 4.6)}H${[82, 85, 79][i]}"/>`).join("");
  const photos = [0, 1, 2, 3].map((i) => { const x = 72.6 + (i % 2) * 7.8; const z = 43.2 - Math.floor(i / 2) * 8.6; return `<path class="sn-photo" d="${yRect(x, z - 7.4, x + 7, z, 0.3)}"/><path class="iso-line" data-tone="red" d="M${x + 1.8} ${-(z - 3.7)}a1.7 1.3 0 1 0 3.4 0a1.7 1.3 0 1 0 -3.4 0"/>`; }).join("");
  o.push(onY(Y, `<path class="sn-paper" d="${sheet}"/><path class="iso-line" data-tone="lo" d="${sheet}"/><g data-clip-sheet="notes">${notes}</g><g data-clip-sheet="photo">${photos}</g>`));
  o.push(box(76, 136.4, 8, 2.2, 45, 3.6, { tone: "mid", r: 0.5 }));
  o.push(D([at([78, 138.6, 46.8]), at([82, 138.6, 46.8])], { size: 0.45 }));
  return part("clipboard", o.join(""));
}

function walkie(x, y, z, name) {
  const o = [];
  o.push(box(x, y, 6, 4, z, 13, { tone: "hi", r: 1 }));
  o.push(cyl(x + 4.4, y + 1.6, 0.6, z + 13, 11, { tone: "mid", steps: 12 }));
  o.push(cyl(x + 1.6, y + 1.6, 0.9, z + 13, 1.6, { tone: "mid", steps: 14 }));
  o.push(onY(y + 4, L(Array.from({ length: 4 }, (_, i) => rect(x + 1.2, -(z + 8 - i * 1.4), x + 4.8, -(z + 7.6 - i * 1.4), 0.2)).join(""), { tone: "lo" })));
  o.push(`<g class="sn-led" data-led="${name}">${D([at([x + 3, y + 4, z + 10.6])], { size: 0.65, tone: "hi" })}</g>`);
  return o.join("");
}

function chair() {
  const o = [halo({ x: 110, y: 150, w: 20, d: 20, r: 2 }, 0, 4)];
  const legs = [[110, 150], [128.4, 150], [110, 168.4], [128.4, 168.4]];
  legs.sort((a, b) => depth([...a, 0]) - depth([...b, 0])).slice(0, 2).forEach(([x, y]) => o.push(box(x, y, 1.6, 1.6, 0, 19, { r: 0.4, tone: "mid" })));
  o.push(box(110.4, 150.4, 19.2, 19.2, 18, 1.6, { tone: "hi", r: 0.6 }));
  legs.sort((a, b) => depth([...a, 0]) - depth([...b, 0])).slice(2).forEach(([x, y]) => o.push(box(x, y, 1.6, 1.6, 0, 19, { r: 0.4, tone: "mid" })));
  for (const x of [110, 128.4]) {
    o.push(box(x, 150, 1.6, 1.6, 19, 8, { r: 0.4, tone: "mid" }));
    o.push(box(x, 150, 1.6, 20, 27, 1.4, { r: 0.6, tone: "mid" }));
    o.push(box(x, 168.4, 1.6, 1.6, 19, 22, { r: 0.4, tone: "mid" }));
  }
  o.push(box(111.6, 168.6, 16.8, 1.2, 31, 9, { tone: "hi", r: 0.3 }));
  return part("director", o.join(""));
}

function camera() {
  const o = [];
  const head = [180, 128, 40];
  const feet = [[164, 143, 0], [197, 141, 0], [180, 108, 0]];
  o.push(halo({ x: 164, y: 108, w: 34, d: 36, r: 12 }, 0, 4));
  const back = feet.filter((f) => depth(f) < depth([180, 128, 0]));
  const front = feet.filter((f) => depth(f) >= depth([180, 128, 0]));
  back.forEach((f) => o.push(rod(f, [head[0] + (f[0] - head[0]) * 0.08, head[1] + (f[1] - head[1]) * 0.08, 39], 0.9)));
  o.push(cyl(180, 128, 1.5, 18, 22, { tone: "mid", steps: 16 }));
  front.forEach((f) => o.push(rod(f, [head[0] + (f[0] - head[0]) * 0.08, head[1] + (f[1] - head[1]) * 0.08, 39], 0.9)));
  feet.forEach(([x, y]) => o.push(cyl(x, y, 1.6, 0, 1, { tone: "lo", steps: 14 })));
  o.push(cyl(180, 128, 4.2, 39, 3.6, { tone: "mid", steps: 28 }));
  o.push(rod([182, 140, 41], [191, 154, 37], 0.6));
  // Body, lens toward the screen (−y), magazine and two reels on top.
  const body = { x: 170, y: 116, w: 20, d: 26, r: 2 };
  o.push(S(k.slabOf(body, 42.6, 18, P, 4, 0.6), { tone: "hi", inner: L(k.sideSeam(body, 50, P, 4), { tone: "faint" }) }));
  o.push(onX(190, L(xRect(122, 46, 136, 56, 1), { tone: "lo" }) + L(Array.from({ length: 5 }, (_, i) => xRect(124 + i * 2.4, 47.4, 125.2 + i * 2.4, 54.6, 0.5)).join(""), { tone: "faint" })));
  o.push(S(G.solidOf([[0, 7.4], [2.4, 7.4], [2.4, 6], [10, 6], [10, 7.6], [13, 7.6]], G.frameAlong([180, 116, 51.6], [0, -1, 0]), P), { tone: "mid" }));
  o.push(cyl(186, 142, 1.8, 54, 0.1, { tone: "mid" }));
  o.push(S(G.solidOf([[0, 1.8], [5, 1.8], [5, 2.4], [7, 2.4]], G.frameAlong([185, 142, 56], [0, 1, 0]), P), { tone: "mid" }));
  o.push(box(176.6, 118, 6.8, 22, 60.6, 4.4, { tone: "mid", r: 1 }));
  o.push(part("camera", reelX(180, 120.6, 72, 7.2, 3.2, "cam1") + reelX(180, 136.6, 72, 7.2, 3.2, "cam2"), ""));
  o.push(`<g class="sn-tally" data-tally="">${D([at([172.6, 116, 58.6])], { size: 1, tone: "hi" })}</g>`);
  return part("camera", o.join(""));
}

function boom() {
  const o = [halo({ x: 206, y: 174, w: 18, d: 18, r: 9 }, 0, 3)];
  o.push(cyl(215, 183, 8, 0, 1.6, { tone: "lo", steps: 36, bevel: 0.4 }));
  o.push(cyl(215, 183, 2.4, 1.6, 3, { tone: "mid", steps: 18 }));
  o.push(cyl(215, 183, 1.2, 4.6, 72, { tone: "mid", steps: 14 }));
  o.push(cyl(215, 183, 2.6, 58, 3.2, { tone: "mid", steps: 18, inner: L(k.knurl(215, 183, 2.6, 58, 61.2, 16, P), { tone: "lo" }) }));
  const A = [232, 189, 74.6], B = [124, 155, 92];
  o.push(box(212, 180, 6, 6, 76.6, 4, { tone: "mid", r: 1 }));
  o.push(S(G.solidOf([[0, 3.2], [7, 3.2]], G.frameAlong(G.add3(A, [3, 1, -0.4]), G.unit3(G.sub3(A, B))), P), { tone: "lo" }));
  o.push(rod(A, B, 0.85));
  // Shock mount and capsule hanging toward the director's chair.
  o.push(rod(B, [124, 155, 86], 0.6));
  const F = G.frameAlong([124, 155, 86], G.unit3([-2, 2, -10]));
  const prof = [[0, 1.6], [1, 2.5, 1], [3, 3.1, 1], [12, 3.1, 1], [14.5, 2.4, 1], [16, 1.1, 1], [16.6, 0.2]];
  o.push(part("mic", S(G.solidOf(prof, F, P), { tone: "hi", inner: L(G.arcOf(F, 3, 3.1, P) + G.arcOf(F, 12, 3.1, P), { tone: "faint" }) }), ' data-tour-mic=""'));
  return part("mic", o.join(""));
}

// ============================================================================
// Editing room (the service), its walls, lab, stenographer, recorder and box
// ============================================================================
const ROOM = { x: 250, y: 8, w: 222, d: 226, r: 3 };
const FLOOR_Z = 2.5;

function roomFloor() {
  const o = [box(ROOM.x, ROOM.y, ROOM.w, ROOM.d, 0, FLOOR_Z, { r: 3, steps: 4, tone: "lo", bevel: 0.5 })];
  const lines = [];
  for (let y = ROOM.y + 18; y < ROOM.y + ROOM.d - 4; y += 18) lines.push(k.lineOnTop([ROOM.x + 0.3, y], [ROOM.x + ROOM.w - 0.3, y], FLOOR_Z, P));
  o.push(L(lines.join(""), { tone: "faint" }));
  return part("service", o.join(""));
}

function backWall() {
  const o = [];
  const wall = { x: ROOM.x, y: ROOM.y, w: ROOM.w, d: 6, r: 0.6 };
  o.push(S(k.slabOf(wall, FLOOR_Z, 70, P, 3, 0.5), { tone: "mid", inner: L(k.sideSeam(wall, 40, P, 3), { tone: "faint" }) }));
  // Panel joints run edge to edge.
  o.push(L([316, 382, 448].map((x) => k.segment([x, ROOM.y + 6, FLOOR_Z], [x, ROOM.y + 6, FLOOR_Z + 70], P)).join(""), { tone: "faint" }));
  // The "service running" lamp: lit while the service is up (D-Bus starts it on demand).
  const F = G.frameAlong([272, 14, 58], [0, 1, 0]);
  o.push(part("service", S(G.disc(0, 1.6, 5.2, F, P), { tone: "mid" }) + `<g class="sn-lamp">${S(G.solidOf([[1.6, 3.8], [3, 3.8, 1], [4.2, 2.6, 1], [4.8, 0.4]], F, P), { tone: "hi" })}</g>`));
  return part("service", o.join(""));
}

function leftWall() {
  const o = [];
  const a = { x: ROOM.x, y: ROOM.y + 6, w: 6, d: DOOR.y0 - ROOM.y - 6, r: 0.4 };
  const b = { x: ROOM.x, y: DOOR.y1, w: 6, d: ROOM.y + ROOM.d - DOOR.y1, r: 0.4 };
  o.push(S(k.slabOf(a, FLOOR_Z, 26, P, 3, 0.4), { tone: "mid", inner: L(k.sideSeam(a, 14, P, 3), { tone: "faint" }) }));
  o.push(S(k.slabOf(b, FLOOR_Z, 26, P, 3, 0.4), { tone: "mid", inner: L(k.sideSeam(b, 14, P, 3), { tone: "faint" }) }));
  return part("service", o.join(""));
}

// The open door between the set and the editing room.
function door() {
  const o = [box(256, DOOR.y1 - 1.2, 22, 1.2, FLOOR_Z, 36, { tone: "mid", r: 0.3 })];
  o.push(onY(DOOR.y1, L(yRect(258, 6, 276, 18, 0.6) + yRect(258, 21, 276, 35, 0.6), { tone: "faint" })));
  o.push(cyl(274, DOOR.y1 + 0.6, 0.7, 20, 0.1, { tone: "mid" }));
  o.push(D([at([274, DOOR.y1, 20.6])], { size: 0.6, tone: "mid" }));
  return part("service", o.join(""));
}

function filmLab() {
  const o = [halo({ x: 268, y: 16, w: 74, d: 28, r: 2 }, FLOOR_Z, 5)];
  const M = { x: 270, y: 16, w: 70, d: 26, r: 2 };
  o.push(S(k.slabOf(M, FLOOR_Z, 26, P, 4, 0.6), { tone: "hi", inner: L(k.sideSeam(M, FLOOR_Z + 6, P, 4), { tone: "faint" }) }));
  const topZ = FLOOR_Z + 26;
  // Three tanks in the top, film running over rollers between them.
  for (let i = 0; i < 3; i++) o.push(L(k.planOutline({ x: 276 + i * 20, y: 21, w: 14, d: 16, r: 1.2 }, topZ, P, 3), { tone: "lo" }));
  o.push(onY(42, L(yRect(276, 8, 300, 20, 1), { tone: "lo" }) + L([0, 1, 2, 3].map((i) => yRect(305 + i * 7, 9, 309 + i * 7, 19, 0.6)).join(""), { tone: "faint" })));
  o.push(`<g class="sn-labled">${D([at([336, 42, 22]), at([336, 42, 18])], { size: 0.7, tone: "hi" })}</g>`);
  const rollers = [];
  for (let i = 0; i < 4; i++) rollers.push(S(G.disc(0, 18, 2, G.frameAlong([275.4 + i * 20, 20, topZ + 2], [0, 1, 0]), P), { tone: "mid" }));
  o.push(rollers.join(""));
  const strip = [];
  for (let i = 0; i < 4; i++) strip.push([275.4 + i * 20, 29, topZ + 4], [285.4 + i * 20, 29, topZ - 0.2]);
  o.push(`<path class="sn-film" d="${pathOf(strip.slice(0, 7))}"/>`);
  // Output reel at the right end.
  o.push(reelY(330, 40, topZ + 9, 7.4, 2.2, "lab"));
  o.push(box(326, 38.6, 8, 3, topZ, 2, { tone: "mid", r: 0.6 }));
  return part("ffmpeg", o.join(""));
}

function enlarger() {
  const o = [];
  o.push(box(346, 16, 24, 26, FLOOR_Z, 14, { tone: "mid" }));
  o.push(box(346.6, 17, 22.8, 24, FLOOR_Z + 14, 1.4, { tone: "lo", r: 1 }));
  o.push(onZ(FLOOR_Z + 15.45, `<path class="sn-photo" d="${rect(351, 27, 365, 37, 0.4)}"/><path class="iso-line" data-tone="red" d="M355 32a3 2 0 1 0 6 0a3 2 0 1 0 -6 0"/>`));
  o.push(cyl(350, 20.4, 1.3, FLOOR_Z + 15.4, 42, { tone: "mid", steps: 14 }));
  o.push(box(348, 19, 6, 3, 45, 3, { tone: "mid", r: 0.6 }));
  o.push(box(352, 22, 14, 14, 40, 12, { tone: "hi", r: 1.6, steps: 4 }));
  o.push(cyl(359, 29, 3.4, 36, 4, { tone: "mid", steps: 22 }));
  o.push(`<g class="sn-flash">${cyl(359, 29, 2.2, 35.6, 0.4, { tone: "hi", steps: 18 })}</g>`);
  return part("ffmpeg", o.join(""));
}

function stenographer() {
  const o = [halo({ x: 288, y: 84, w: 74, d: 38, r: 3 }, FLOOR_Z, 4)];
  const top = { x: 290, y: 84, w: 70, d: 36, r: 1.6 };
  const legs = [[291, 85], [356.6, 85], [291, 116.6], [356.6, 116.6]];
  legs.forEach(([x, y]) => o.push(box(x, y, 2.4, 2.4, FLOOR_Z, 16, { r: 0.4 })));
  o.push(box(292, 86, 66, 2, FLOOR_Z + 10, 2, { tone: "lo", r: 0.4 }));
  o.push(S(k.slabOf(top, FLOOR_Z + 16, 2.6, P, 4, 0.6), { tone: "mid" }));
  const Z = FLOOR_Z + 18.6;
  // Stenotype: base, key bank, and the paper tape folding out the back.
  o.push(box(298, 96, 26, 18, Z, 3, { tone: "mid", r: 1.4 }));
  o.push(box(300, 100, 22, 11, Z + 3, 2.6, { tone: "hi", r: 1, bevel: 0.3 }));
  const keys = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 9; c++) keys.push(k.planOutline({ x: 301.2 + c * 2.3, y: 101.4 + r * 4.6, w: 1.8, d: 3.6, r: 0.6 }, Z + 5.6, P, 2));
  o.push(`<g class="sn-stenokeys">${L(keys.join(""), { tone: "lo" })}</g>`);
  o.push(box(306, 94, 12, 1.4, Z + 3, 9, { tone: "hi", r: 0.3 }));
  o.push(onY(95.4, L([0, 1, 2].map((i) => `M307.6 ${-(Z + 10 - i * 2.2)}H${316 - i * 1.6}`).join(""), { tone: "lo", free: true })));
  for (let i = 0; i < 5; i++) o.push(box(328, 98 + i * 0.1, 12, 9, Z + i * 0.9, 0.9, { tone: i % 2 ? "mid" : "hi", r: 0.2, bevel: 0 }));
  // Stopwatch: the second each word was said.
  const sw = [347, 108];
  o.push(cyl(sw[0], sw[1] - 7.6, 1.2, Z + 1.2, 1.2, { tone: "mid" }) );
  o.push(S(G.disc(0, 2.4, 1.4, G.frameAlong([sw[0], sw[1] - 8.2, Z + 1.8], [0, -1, 0]), P), { tone: "mid" }));
  o.push(cyl(sw[0], sw[1], 7, Z, 3.6, { tone: "hi", steps: 48, bevel: 0.5 }));
  o.push(L(k.ring(sw[0], sw[1], 5.8, Z + 3.6, P, 48), { tone: "lo" }));
  const t = k.radialTicks(sw[0], sw[1], 5.6, 60, 5, Z + 3.6, [0.7, 1.5], P);
  o.push(L(t.minor, { tone: "lo" }), L(t.major, { tone: "mid" }));
  o.push(onZ(Z + 3.65, `<g transform="translate(${sw[0]} ${sw[1]})"><g data-spin="watch"><path class="sn-needle" d="M0 1.4L0 -4.8"/></g><circle class="sn-hub" r="0.6"/></g>`));
  return part("whisper", o.join(""));
}

function voiceDetector() {
  const o = [];
  const legs = [[372, 88], [394, 88], [372, 106], [394, 106]];
  legs.forEach(([x, y]) => o.push(box(x, y, 2, 2, FLOOR_Z, 14, { r: 0.3 })));
  o.push(box(371, 87, 26, 22, FLOOR_Z + 14, 2, { tone: "mid", r: 1 }));
  const Z = FLOOR_Z + 16;
  o.push(box(373, 90, 22, 15, Z, 8, { tone: "hi", r: 1, steps: 3 }));
  // The chart: speech blocks and the silences between them, scrolling under a pen.
  o.push(`<clipPath id="sn-strip"><path d="${k.pathOf([at([375, 95, Z + 8]), at([393, 95, Z + 8]), at([393, 101, Z + 8]), at([375, 101, Z + 8])], true)}"/></clipPath>`);
  o.push(`<path class="sn-paper" d="${k.pathOf([at([375, 95, Z + 8]), at([393, 95, Z + 8]), at([393, 101, Z + 8]), at([375, 101, Z + 8])], true)}"/>`);
  const blocks = [[0, 4], [5.5, 9], [10, 13.5], [16, 19], [20, 25], [27.5, 30], [31, 35.5]];
  const strip = blocks.map(([a, b]) => k.pathOf([[375 + a, 96.4], [375 + b, 96.4], [375 + b, 99.6], [375 + a, 99.6]], true)).join("");
  const strip2 = blocks.map(([a, b]) => k.pathOf([[375 + a + 36, 96.4], [375 + b + 36, 96.4], [375 + b + 36, 99.6], [375 + a + 36, 99.6]], true)).join("");
  o.push(`<g clip-path="url(#sn-strip)">${onZ(Z + 8.05, `<g data-strip=""><path class="sn-speech" d="${strip}${strip2}"/></g>`)}</g>`);
  o.push(L(k.planOutline({ x: 375, y: 95, w: 18, d: 6, r: 0.2 }, Z + 8, P, 2), { tone: "lo" }));
  o.push(box(386, 92, 1.4, 12, Z + 8, 1.4, { tone: "mid", r: 0.3 }));
  o.push(D([at([386.7, 98, Z + 8])], { size: 0.6, tone: "hi" }));
  return part("vad", o.join(""));
}

// The service table at the door: the recorder (pw-record) and the second walkie-talkie.
function serviceTable() {
  const o = [halo({ x: 262, y: 146, w: 30, d: 46, r: 2 }, FLOOR_Z, 4)];
  [[263, 147], [288.6, 147], [263, 188.6], [288.6, 188.6]].forEach(([x, y]) => o.push(box(x, y, 2.4, 2.4, FLOOR_Z, 13, { r: 0.4 })));
  o.push(box(262, 146, 30, 46, FLOOR_Z + 13, 2.4, { tone: "mid", r: 1.4, bevel: 0.5 }));
  const Z = FLOOR_Z + 15.4;
  const nagra = { x: 265, y: 150, w: 23, d: 17, r: 1.2 };
  const rec = [];
  rec.push(S(k.slabOf(nagra, Z, 7, P, 3, 0.4), { tone: "hi", inner: L(k.sideSeam(nagra, Z + 3, P, 3), { tone: "faint" }) }));
  rec.push(reelUp(270.6, 156, Z + 7, 4.2, 1, "nagra1") + reelUp(282, 156, Z + 7, 4.2, 1, "nagra2"));
  // Level meter on the front: −60 to 0 dBFS, the same reading the pill's bar shows.
  rec.push(onY(nagra.y + nagra.d, `<path class="sn-meterbg" d="${yRect(267, Z + 2.6, 286, Z + 5, 0.4)}"/><path class="sn-meter" data-meter="nagra" d="${yRect(267, Z + 2.6, 286, Z + 5, 0.4)}"/><path class="iso-line" data-tone="lo" d="${yRect(267, Z + 2.6, 286, Z + 5, 0.4)}"/>`));
  rec.push(`<g class="sn-led" data-led="nagra">${D([at([268, nagra.y + nagra.d, Z + 1.3])], { size: 0.6, tone: "hi" })}</g>`);
  o.push(part("mic", rec.join("")));
  o.push(part("dbus", walkie(268, 176.5, Z, "b")));
  return o.join("");
}

function bundleBox() {
  const o = [halo({ x: 380, y: 160, w: 76, d: 56, r: 3 }, FLOOR_Z, 4)];
  [[381, 161], [452.6, 161], [381, 212.6], [452.6, 212.6]].forEach(([x, y]) => o.push(box(x, y, 2.4, 2.4, FLOOR_Z, 13, { r: 0.4 })));
  o.push(box(380, 160, 76, 56, FLOOR_Z + 13, 2.6, { tone: "mid", r: 1.6, bevel: 0.5, steps: 4 }));
  const Z = FLOOR_Z + 15.6;
  const B = { x0: 390, y0: 170, x1: 438, y1: 205, h: 18 };
  const inside = [];
  // Floor and the two far walls, then contents, then the near walls.
  inside.push(box(B.x0, B.y0, B.x1 - B.x0, B.y1 - B.y0, Z, 0.8, { tone: "lo", r: 0.3, bevel: 0 }));
  inside.push(box(B.x0, B.y0, B.x1 - B.x0, 1, Z + 0.8, B.h, { tone: "mid", r: 0.2, bevel: 0 }));
  inside.push(box(B.x0, B.y0, 1, B.y1 - B.y0, Z + 0.8, B.h, { tone: "mid", r: 0.2, bevel: 0 }));
  inside.push(box(B.x0, B.y0 - 0.2, B.x1 - B.x0, 1, Z + 0.8 + B.h, 12, { tone: "mid", r: 0.2, bevel: 0 }));
  inside.push(box(B.x0 - 0.2, B.y0, 1, B.y1 - B.y0, Z + 0.8 + B.h, 10, { tone: "mid", r: 0.2, bevel: 0 }));
  const zz = Z + 0.8;
  const item = (name, spec, svg) => part(name, when(spec, svg));
  // finish.json: the work order Retry rebuilds from (a ticket clipped inside the back wall).
  inside.push(item("b-finish", "finish@1.7 build ready paste", box(426, 171, 9, 0.6, zz + 10, 16, { tone: "hi", r: 0.2, bevel: 0 }) + onY(171.6, L("M427.6 -" + (zz + 23) + "H433M427.6 -" + (zz + 20.6) + "H431.6M427.6 -" + (zz + 18.2) + "H432.4", { tone: "lo", free: true }))));
  // summary.md: the cover letter.
  inside.push(item("b-summary", "build@5.0 ready paste", box(393, 175, 15, 0.6, zz, 26, { tone: "hi", r: 0.2, bevel: 0 }) + onY(175.6, [0, 1, 2, 3, 4].map((i) => `<circle class="sn-num" cx="395.6" cy="${-(zz + 22.6 - i * 3.6)}" r="0.55"/><path class="iso-line" data-tone="mid" data-free="" d="M397 ${-(zz + 22.6 - i * 3.6)}H${[405, 403, 406, 401.6, 404.4][i]}"/>`).join(""))));
  // contact-sheet.png: the photo sheet.
  inside.push(item("b-sheet", "build@5.3 ready paste", box(410, 178, 15, 0.6, zz, 27, { tone: "hi", r: 0.2, bevel: 0 }) + onY(178.6, [0, 1, 2, 3, 4, 5].map((i) => { const x = 411.4 + (i % 2) * 6.4; const z = zz + 25.2 - Math.floor(i / 2) * 6; return `<path class="sn-photo" d="${yRect(x, z - 5, x + 5.6, z, 0.2)}"/>`; }).join("") + `<path class="iso-line" data-tone="red" d="M413 ${-(zz + 22.6)}a1.4 1 0 1 0 2.8 0a1.4 1 0 1 0 -2.8 0"/>`)));
  // The two raw tapes.
  inside.push(item("b-mp4", "build@1.8 ready paste", reelY(400, 192, zz + 9.6, 9, 2, "none")));
  inside.push(item("b-wav", "start@1.3 record draw finish build ready paste", reelY(422, 196, zz + 8, 7.6, 2, "none")));
  // frames/: the folder of stills.
  inside.push(item("b-frames", "build@3.0 ready paste", box(426, 186, 10, 1.6, zz, 20, { tone: "mid", r: 0.3, bevel: 0 }) + box(428, 186, 4, 1.6, zz + 20, 1.6, { tone: "mid", r: 0.3, bevel: 0 })));
  inside.push(box(B.x0, B.y1 - 1, B.x1 - B.x0, 1, Z + 0.8, B.h, { tone: "mid", r: 0.2, bevel: 0 }));
  inside.push(box(B.x1 - 1, B.y0, 1, B.y1 - B.y0, Z + 0.8, B.h, { tone: "mid", r: 0.2, bevel: 0 }));
  inside.push(onY(B.y1, L(`M${B.x0} ${-(Z + 0.8 + B.h * 0.5)}H${B.x1}`, { tone: "faint" })));
  // The tag that says when it goes: a day after it last changed.
  inside.push(onY(B.y1 + 0.05, `<path class="sn-paper" d="${yRect(426, Z + 7, 436, Z + 13, 0.5)}"/><path class="iso-line" data-tone="lo" d="${yRect(426, Z + 7, 436, Z + 13, 0.5)}"/><text class="sn-tagtext" x="431" y="${-(Z + 8.6)}" font-size="3.6" text-anchor="middle">24h</text>`));
  o.push(part("bundle", inside.join("")));
  // sketchnote.json: the production log, lying on the table.
  o.push(part("b-json", when("build@5.5 ready paste", box(442, 176, 10, 14, Z, 2.4, { tone: "hi", r: 0.4 }) + box(442, 176, 1.6, 14, Z, 2.6, { tone: "mid", r: 0.3, bevel: 0 }) + L([0, 1, 2].map((i) => k.lineOnTop([445, 180 + i * 2.6], [450, 180 + i * 2.6], Z + 2.4, P)).join(""), { tone: "lo", free: true }))));
  return o.join("");
}

// The gate post where the API cable leaves the machine, with the keyring lockbox.
function gatePost() {
  const o = [box(462, 124, 5, 5, FLOOR_Z, 40, { tone: "mid", r: 0.6 })];
  o.push(cyl(464.5, 126.5, 3, FLOOR_Z, 1.4, { tone: "lo" }));
  o.push(box(467, 121.6, 3, 10, 24, 11, { tone: "hi", r: 0.6 }));
  o.push(onX(470, `<circle class="sn-keyhole" cx="-126.6" cy="-30" r="0.8"/><path class="sn-keyhole" d="M-127 -30L-126.2 -30L-126 -27.4L-127.2 -27.4Z"/>`));
  o.push(`<g data-when="* " data-mode-when="api fail">${box(470, 125.6, 3.4, 1, 28.6, 1.4, { tone: "mid", r: 0.2, bevel: 0 })}${cyl(474.6, 126.1, 1.4, 28.6, 1.4, { tone: "mid", steps: 14 })}</g>`);
  return part("keyring", o.join(""));
}

function kiosk() {
  const o = [];
  const Z = 0;
  o.push(halo({ x: 510, y: 98, w: 38, d: 36, r: 2 }, Z, 6));
  const booth = { x: 510, y: 98, w: 36, d: 36, r: 1.4 };
  o.push(S(k.slabOf(booth, Z, 42, P, 3, 0.5), { tone: "hi", inner: L(k.sideSeam(booth, 16, P, 3), { tone: "faint" }) }));
  // Service window on the front with a counter.
  o.push(onY(134, `<path class="sn-dark" d="${yRect(522, 20, 542, 34, 1)}"/><path class="iso-line" data-tone="lo" d="${yRect(522, 20, 542, 34, 1)}"/>`));
  o.push(box(521, 134, 22, 4, 18.6, 1.4, { tone: "mid", r: 0.4 }));
  o.push(onX(546, L(xRect(103, 6, 129, 36, 1), { tone: "faint" })));
  o.push(box(507, 95, 42, 42, 42, 3, { tone: "mid", r: 1.6, bevel: 0.5, steps: 4 }));
  o.push(cyl(540, 104, 0.8, 45, 22, { tone: "mid", steps: 12 }));
  o.push(cyl(540, 104, 2.6, 45, 1.2, { tone: "lo" }));
  o.push(S(G.sphereOf([540, 104, 68.4], 1.6, P), { tone: "hi" }));
  o.push(`<g class="sn-kioskled">${D([at([536, 134, 38])], { size: 0.9, tone: "hi" })}</g>`);
  return part("api", o.join(""));
}

// ============================================================================
// Assemble
// ============================================================================
const set = layer();
set.put([95, 30, 0], screen());
set.put([60, 140, 0], director());
set.put([80, 138, 0], clipboard(), 4);
set.put([97, 143, 0], part("dbus", walkie(94, 140, 22, "a")), 6);
set.put([120, 160, 0], chair());
set.put([180, 128, 0], camera());
set.put([215, 183, 0], boom());

const room = layer();
room.put([305, 30, 0], filmLab());
room.put([358, 30, 0], enlarger());
room.put([325, 102, 0], stenographer());
room.put([384, 98, 0], voiceDetector());
room.put([277, 170, 0], serviceTable());
room.put([418, 188, 0], bundleBox());
room.put([465, 127, 0], gatePost());
room.put([267, 186, 0], door(), 30);

// Moving tokens: the D-Bus message dot and the audio tape that goes to the API.
const dbusRoute = CABLE_DBUS.map(at);
const apiRoute = CABLE_API.map(at);
const tokens = [
  `<path id="sn-dbus-path" d="${k.pathOf(dbusRoute)}" fill="none" stroke="none"/>`,
  `<path id="sn-api-path" d="${k.pathOf(apiRoute)}" fill="none" stroke="none"/>`,
  `<g class="sn-pulse" data-pulse="dbus"><circle r="3.2" class="sn-pulse-ring"/><circle r="1.5" class="sn-pulse-dot"/></g>`,
  `<g class="sn-token" data-token="api" transform="translate(-999 -999)">${(() => {
    const [ox, oy] = at([0, 0, 0]);
    const reel = reelY(0, 0, 4.6, 4.2, 1.4, "none");
    return `<g transform="translate(${F3(-ox)} ${F3(-oy)})">${reel}</g>`;
  })()}</g>`,
];

const body = [
  `<defs><filter id="sn-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.6"/></filter></defs>`,
  board(STUDIO, "lo", { label: { x: 14, y: 220, w: 44 } }),
  board(KIOSK_BOARD, "lo"),
  // Floor cables are drawn before anything that stands on them.
  roomFloor(),
  part("dbus", cable(CABLE_DBUS, "sn-dbus", "hi")),
  part("mic", cable(CABLE_MIC, "", "mid")),
  part("camera", cable(CABLE_FILM, "", "mid")),
  part("api", `<g data-mode-when="api fail" data-when="*">${cable(CABLE_API, "", "mid")}</g>`),
  backWall(),
  set.svg(),
  leftWall(),
  room.svg(),
  kiosk(),
  ...tokens,
];

const svg = k.figureSvg({
  width: WIDTH,
  height: tour ? 640 : HEIGHT,
  label:
    "An isometric model of Sketchnote. On the large studio board, a screen stands on set with a red edge glow, a status pill and a red ink loop; in front of it, the director's console (the GNOME Shell extension) with its hotkeys, a clipboard and a walkie-talkie, a director's chair, GNOME's own camera on a tripod and a boom microphone. Cables run through a door into the editing room (the sketchnote service) with a film lab and enlarger (ffmpeg), a stenographer's desk with a stopwatch (the Whisper speech model), a strip recorder marking silences (the voice detector), a tape recorder (pw-record), a walkie-talkie (D-Bus) and the delivery box (the bundle). An optional API booth stands outside on its own plinth beyond a gate post with the keyring.",
  body,
});

// ---- the words: every caption here was checked against the source ----------------
const PARTS = JSON.parse(readFileSync(join(HERE, "parts.json"), "utf8"));
const STEPS = JSON.parse(readFileSync(join(HERE, "steps.json"), "utf8"));
const live = readFileSync(join(HERE, "live.js"), "utf8");

const css = readFileSync(join(HERE, "sketchnote.css"), "utf8");
const stepButtons = STEPS.map((s, i) => `<button type="button" class="sn-step" data-go="${s.id}"><span>${String(i + 1).padStart(2, "0")}</span>${esc(s.label)}</button>`).join("");
const panel = `<div class="sn-panel">
  <div class="sn-controls">
    <div class="sn-steps" role="group" aria-label="Steps">${stepButtons}</div>
    <div class="sn-modes" role="group" aria-label="Transcription"><span class="sn-modes-label">Transcribe</span><button type="button" class="sn-mode" data-mode="local" aria-pressed="true">Local model</button><button type="button" class="sn-mode" data-mode="api" aria-pressed="false">API</button><button type="button" class="sn-mode" data-mode="fail" aria-pressed="false">API fails</button></div>
  </div>
  <div class="sn-info" aria-live="polite"><div class="sn-info-head"><span class="sn-info-name" data-info-name></span><span class="sn-info-role" data-info-role></span></div><p class="sn-info-text" data-info-text></p></div>
</div>`;

const page = css + k.plateHtml({
  fig: "Fig 1",
  title: "Sketchnote, as a film crew",
  hint: "Hover a part · pick a step",
  readout: "",
  keys: [
    { mark: "lit", label: "The part doing the work in this step" },
    { mark: "red", label: "Live ink, the edge glow and the recording lamp" },
    { mark: "edge", label: "Cables: D-Bus, mic, footage and the API line" },
  ],
  caption:
    "The GNOME Shell extension directs on set and asks GNOME Screencast to film the screen. The Rust service records the microphone with pw-record, then uses ffmpeg, Whisper and Silero to turn speech and marks into notes and annotated frames. D-Bus connects the two halves. Ctrl+V delivers the notes and contact sheet together. Only microphone audio can go to the optional API booth outside the studio.",
  body: `<div class="sn-stage" tabindex="0" role="group" aria-label="Sketchnote anatomy. Hover or focus a part to read about it; the step buttons play each stage.">${svg}</div>${panel}`,
});

const data = `const PARTS = ${JSON.stringify(PARTS)};\nconst STEPS = ${JSON.stringify(STEPS)};\n`;
const tourScript = tour ? readFileSync(join(HERE, "tour.js"), "utf8") : "";
const name = `sketchnote${tour ? "-tour" : ""}${theme === "light" ? "-light" : ""}.html`;
const output = k.pageHtml({ title: "Sketchnote anatomy", theme, body: page, script: data + live + tourScript, width: 1080 });
writeFileSync(join(HERE, name), tour ? output.replace('class="iso"', 'class="iso sn-tour-page"') : output);
console.log("wrote", name);
