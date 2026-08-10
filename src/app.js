// WALL TOUCH — main renderer.
//
// One continuous water surface spanning all five walls (10350×1080), drawn as a contour
// map, sliced into five NDI senders named DOOR-WALL-1..5 — the SAME names Door Portals
// publishes, so MadMapper's existing warp for this room applies unchanged. Run one app
// or the other, never both.

import { createGL, makeBlitter } from './glutil.js';
import { Waves } from './waves.js';
import { TouchTracker } from './touch.js';

const cfg = await window.api.getConfig();
document.getElementById('boot')?.remove();

const PX_W = cfg.output.width;
const PX_H = cfg.output.height;
const FPS = cfg.output.fps ?? 30;
const scale = cfg.output.renderScale ?? 1;
const W = cfg.waves, L = cfg.look;

const canvas = document.getElementById('gl');
// Even dimensions: NDI wants an even width per stream, and the crop maths below then
// never lands on a half pixel.
const dw = Math.max(2, Math.round(PX_W * scale) & ~1);
const dh = Math.max(2, Math.round(PX_H * scale) & ~1);
canvas.width = dw;
canvas.height = dh;
canvas.style.aspectRatio = `${PX_W} / ${PX_H}`;

const gl = createGL(canvas);
const blit = makeBlitter(gl);

// ---------------------------------------------------------------- walls

// Two different slicings of the same panorama, and they must not be conflated:
//   · u0/uw  — exact fractions of the true 10350 px layout, used to place touches.
//   · cropX0/cropW — integer columns of the (possibly downscaled) framebuffer, used to
//     cut NDI frames. Rounded, so they only coincide with u0/uw at renderScale 1.
const walls = [];
{
  let accPx = 0, accCrop = 0;
  cfg.walls.forEach((w, i) => {
    const last = i === cfg.walls.length - 1;
    let bnd = last ? dw : Math.round(((accPx + w.px) / PX_W) * dw);
    bnd -= bnd % 2;
    walls.push({
      index: i,
      u0: accPx / PX_W,
      uw: w.px / PX_W,
      cropX0: accCrop,
      cropW: Math.max(2, bnd - accCrop),
      ndiName: `DOOR-WALL-${i + 1}`,
      ndiBuf: null
    });
    accPx += w.px;
    accCrop = bnd;
  });
  for (const w of walls) w.ndiBuf = new Uint8Array(w.cropW * dh * 4);
}

const ASPECT = PX_W / PX_H;

const waves = new Waves(gl, blit, {
  cfg: W,
  look: L,
  aspect: ASPECT,
  width: dw,
  height: dh,
  // The sim follows RENDER_SCALE so a Mac preview is cheap end to end. Ripple
  // wavelength is set in grid cells, so a smaller grid also means proportionally bigger
  // ripples — the preview stays a fair picture of the wall.
  simScale: Math.max(0.35, Math.min(1, scale))
});

// ---------------------------------------------------------------- touch colours

// One colour per person, so a room with five hands in it stays readable — you can see
// which trail belongs to whom. Cool base, saturated accents, all bright enough to
// survive a projector.
const PALETTE = [
  [0.24, 0.86, 0.95],   // cyan
  [0.45, 0.42, 1.00],   // periwinkle
  [0.95, 0.35, 0.72],   // magenta
  [1.00, 0.72, 0.32],   // amber
  [0.36, 0.68, 1.00],   // sky
  [0.34, 0.95, 0.68]    // mint
];

// Deterministic per identity: the same person keeps one colour for the whole stroke,
// and two people never silently share one.
function colorFor(id) {
  return PALETTE[Math.abs(Math.imul(id | 0, 2654435761)) % PALETTE.length];
}

// ---------------------------------------------------------------- input

const tracker = new TouchTracker(walls, cfg.osc ?? {});
window.api.onOsc((msg) => tracker.handle(msg));

// Per-track state the tracker has no business knowing about: when this hand last sent
// out a ring. A hand resting on the wall should keep emitting concentric rings, but on
// a rhythm — every frame would just make a permanent bulge.
const ringClock = new Map();

function applyTouches(dt) {
  const tracks = tracker.update(dt);
  for (const [, t] of tracks) applyTrack(t, dt);
  // Drop ring clocks whose track is gone, or the map grows all night.
  if (ringClock.size > tracks.size) {
    for (const k of ringClock.keys()) if (!tracks.has(k)) ringClock.delete(k);
  }
  return tracks.size;
}

function applyTrack(t, dt) {
  const color = colorFor(t.id);

  // Speed in wall-heights per second. The x component is multiplied by ASPECT because
  // uv.x spans 9.58 wall-heights — without it a horizontal swipe would read as 9×
  // slower than the identical vertical one.
  const speed = Math.hypot(t.vx * ASPECT, t.vy);

  if (t.fresh) {
    waves.impulse(t.x, t.y, W.dropAmp, 1.0);
    waves.deposit(t.x, t.y, color, W.trailRate * 0.25, 1.2);
    ringClock.set(t.key, 0);
    t.fresh = false;
    return;
  }

  // The trail: deposited as rate × dt, so ridge height depends on how long the hand
  // dwelt there and not on the framerate.
  waves.deposit(t.x, t.y, color, W.trailRate * dt, 1);

  // A moving hand drags a wake; a still hand pulses. Both feed the same wave field, so
  // they interfere with everyone else's for free.
  if (speed > 0.02) waves.impulse(t.x, t.y, W.wakeAmp * Math.min(speed, 3.0) * dt, 0.8);

  const c = (ringClock.get(t.key) ?? 0) + dt;
  if (c >= W.ringInterval) {
    ringClock.set(t.key, 0);
    waves.impulse(t.x, t.y, W.ringAmp, 1.0);
  } else {
    ringClock.set(t.key, c);
  }
}

// Mouse drag = one fake touch, for developing without the sensors. It goes through the
// same panorama uv space the bridge feeds, so what happens here is what the wall does.
let mouse = null;
canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = 1 - (e.clientY - r.top) / r.height;
  mouse = { x, y, id: (Math.random() * 1e6) | 0 };
  waves.impulse(x, y, W.dropAmp, 1.0);
  waves.deposit(x, y, colorFor(mouse.id), W.trailRate * 0.25, 1.2);
});
canvas.addEventListener('pointermove', (e) => {
  if (!mouse) return;
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = 1 - (e.clientY - r.top) / r.height;
  let dx = x - mouse.x; dx -= Math.round(dx);
  const speed = Math.hypot(dx * ASPECT, y - mouse.y) * 60;
  waves.deposit(x, y, colorFor(mouse.id), W.trailRate / 60, 1);
  if (speed > 0.02) waves.impulse(x, y, W.wakeAmp * Math.min(speed, 3.0) / 60, 0.8);
  mouse.x = x; mouse.y = y;
});
window.addEventListener('pointerup', () => { mouse = null; });

// DEMO=1 npm start → synthetic hands drawing across the walls. Lets the look be tuned
// (and snapshots taken) without the five sensors, and doubles as an on-site smoke test
// that the render/NDI path is alive before the bridge is connected.
const DEMO = typeof process !== 'undefined' && process.env?.DEMO === '1';
const demoHands = DEMO ? [
  { id: 901, key: 'd1', cx: 0.12, cy: 0.55, ax: 0.055, ay: 0.15, sx: 0.42, sy: 0.71, ph: 0.0, x: 0, y: 0, fresh: true },
  { id: 902, key: 'd2', cx: 0.45, cy: 0.48, ax: 0.090, ay: 0.20, sx: 0.31, sy: 0.53, ph: 2.1, x: 0, y: 0, fresh: true },
  { id: 903, key: 'd3', cx: 0.82, cy: 0.60, ax: 0.070, ay: 0.14, sx: 0.55, sy: 0.37, ph: 4.3, x: 0, y: 0, fresh: true }
] : [];

function demoUpdate(dt, t) {
  for (const h of demoHands) {
    const x = (h.cx + h.ax * Math.sin(t * h.sx + h.ph) + 1) % 1;
    const y = h.cy + h.ay * Math.sin(t * h.sy + h.ph * 1.7);
    let dx = x - h.x; dx -= Math.round(dx);
    applyTrack({
      id: h.id, key: h.key, x, y,
      vx: h.fresh ? 0 : dx / dt,
      vy: h.fresh ? 0 : (y - h.y) / dt,
      fresh: h.fresh
    }, dt);
    h.fresh = false;
    h.x = x; h.y = y;
  }
  return demoHands.length;
}

// ---------------------------------------------------------------- idle attract

// An untouched surface still breathes, but faintly. Every so often something drops on
// it — enough movement across a dark room to say "this is alive, come and touch it".
let idleT = 0, lastTouchT = 0;
function idleUpdate(dt, t, touching) {
  if (touching) { lastTouchT = t; idleT = 0; return; }
  if (t - lastTouchT < (cfg.idle?.afterSeconds ?? 20)) return;
  idleT += dt;
  if (idleT < (cfg.idle?.intervalSeconds ?? 5)) return;
  idleT = 0;
  waves.impulse(Math.random(), 0.25 + Math.random() * 0.5,
    W.dropAmp * (cfg.idle?.strength ?? 0.5), 1.0);
}

// ---------------------------------------------------------------- NDI out

const pixelBuf = new Uint8Array(dw * dh * 4);
let ndiRunning = false, ndiError = null;

// Ring of pixel-pack buffers — same design as Door Portals, where a single PBO
// throttled NDI to a third of the render rate because the loop had to wait on its fence
// before starting the next readback. 4 measured as the sweet spot there.
const PBO_COUNT = cfg.ndi?.pbo ?? 4;
const pbos = [];
for (let i = 0; i < PBO_COUNT; i++) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, dw * dh * 4, gl.STREAM_READ);
  pbos.push({ buf, fence: null });
}
gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
let pboHead = 0, pboTail = 0, pboInFlight = 0;
const stage = { n: 0, readback: 0, pack: 0, ipc: 0 };

async function startNdi() {
  if (!(cfg.ndi?.enabled ?? true)) return;
  for (const w of walls) {
    const res = await window.api.ndi.start({
      name: w.ndiName, width: w.cropW, height: dh, fps: FPS, bgra: cfg.ndi?.bgra !== false
    });
    if (res.ok) ndiRunning = true;
    else { ndiError = res.error; console.warn('[ndi]', w.ndiName, res.error); }
  }
  if (ndiRunning) console.log('[ndi] senders started:', walls.map(w => `${w.ndiName} ${w.cropW}x${dh}`).join(', '));
}
startNdi();

function captureStart() {
  if (pboInFlight >= PBO_COUNT) return;
  const slot = pbos[pboHead];
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buf);
  gl.readPixels(0, 0, dw, dh, gl.RGBA, gl.UNSIGNED_BYTE, 0);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  pboHead = (pboHead + 1) % PBO_COUNT;
  pboInFlight++;
}

// Drains EVERY landed readback, not just one: a fence typically needs ~2 frames to
// signal, so collecting once per frame caps NDI at half the render rate no matter how
// big the ring is.
function captureCollect() {
  for (let i = 0; i < PBO_COUNT; i++) if (!collectOne()) return;
}

function collectOne() {
  if (!pboInFlight) return false;
  const slot = pbos[pboTail];
  if (!slot.fence) return false;
  const status = gl.clientWaitSync(slot.fence, 0, 0);
  if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) return false;
  gl.deleteSync(slot.fence);
  slot.fence = null;
  pboTail = (pboTail + 1) % PBO_COUNT;
  pboInFlight--;

  const t0 = performance.now();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buf);
  gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixelBuf);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  const t1 = performance.now();

  // Vertical flip (GL reads bottom-up, NDI wants top-down) AND the per-wall column
  // slice in ONE pass — a separate flip buffer would touch ~45 MB twice per frame.
  const srcRow = dw * 4;
  let packMs = 0, ipcMs = 0;
  for (const w of walls) {
    const crow = w.cropW * 4, srcX = w.cropX0 * 4, buf = w.ndiBuf;
    const a = performance.now();
    for (let y = 0; y < dh; y++) {
      const s = (dh - 1 - y) * srcRow + srcX;
      buf.set(pixelBuf.subarray(s, s + crow), y * crow);
    }
    const b = performance.now();
    window.api.ndi.frame({ name: w.ndiName, width: w.cropW, height: dh, fps: FPS }, buf);
    packMs += b - a; ipcMs += performance.now() - b;
  }
  stage.n++; stage.readback += t1 - t0; stage.pack += packMs; stage.ipc += ipcMs;
  return true;
}

// ---------------------------------------------------------------- HUD

const hudEl = document.getElementById('hud');
let hudOn = true, fps = 0;

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'h') { hudOn = !hudOn; hudEl.classList.toggle('off', !hudOn); }
  if (k === 'c') waves.clear();
  if (k === 'b') waves.impulse(Math.random(), 0.3 + Math.random() * 0.4, W.dropAmp, 1.0);
});

setInterval(() => {
  if (!hudOn) return;
  hudEl.textContent =
    `WALL TOUCH  ${PX_W}x${PX_H}@${FPS}  render:${dw}x${dh}  fps:${fps.toFixed(0)}\n` +
    `${waves.stats}  wrap-x:on\n` +
    `NDI ${ndiRunning ? 'ON 5×[' + walls.map(w => w.cropW + 'x' + dh).join(' ') + ']' : 'OFF' + (ndiError ? ' (' + ndiError + ')' : '')}\n` +
    `OSC :${cfg.osc?.port ?? '—'}  pkts:${tracker.packets}  last:${tracker.lastAddress}\n` +
    `touches/wall: ${tracker.counts.join(' ')}   tracked:${tracker.active}\n` +
    `[h]=hud  [c]=xoá mặt nước  [b]=thả 1 giọt  ·  kéo chuột = 1 chạm giả`;
}, 250);

// Health line every 5 s — on the show machine the HUD is on a projector nobody can
// read, so this is the only place fps and NDI drops ever surface.
setInterval(async () => {
  let drops = '';
  try {
    const st = await window.api.ndi.status();
    drops = (st.senders || []).map(s => `${s.name}=${s.frames}/${s.dropped}`).join(' ');
  } catch (_) { /* NDI off */ }
  const k = stage.n || 1;
  const ms = stage.n
    ? `  ms/frame: readback:${(stage.readback / k).toFixed(1)} pack:${(stage.pack / k).toFixed(1)} ipc:${(stage.ipc / k).toFixed(1)}`
    : '';
  stage.n = stage.readback = stage.pack = stage.ipc = 0;
  console.log(`[perf] fps:${fps.toFixed(1)}  render:${dw}x${dh}  touches:${tracker.active}  ndi sent/dropped: ${drops || 'off'}${ms}`);
}, 5000);

// ---------------------------------------------------------------- main loop

const maxFps = cfg.output.maxFps ?? 60;
const minFrameTime = 1 / maxFps - 0.0015;
let lastT = performance.now() / 1000;
let lastFrameT = 0, ndiAccum = 0, fpsAccum = 0, fpsFrames = 0, clock = 0;

function frame() {
  requestAnimationFrame(frame);
  const nowT = performance.now() / 1000;
  if (nowT - lastFrameT < minFrameTime) return;
  lastFrameT = nowT;

  // Clamped: after a stall (window drag, GC) a huge dt would push the wave solver past
  // its stability limit and the field would detonate into white noise.
  const dt = Math.min(Math.max(nowT - lastT, 1 / 240), 1 / 20);
  lastT = nowT;
  clock += dt;

  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 0.5) { fps = fpsFrames / fpsAccum; fpsAccum = 0; fpsFrames = 0; }

  captureCollect();

  const touching = applyTouches(dt) + demoUpdate(dt, clock);
  idleUpdate(dt, clock, touching > 0);

  waves.step(dt);
  waves.render();

  if (ndiRunning) {
    ndiAccum += dt;
    const interval = 1 / FPS;
    if (ndiAccum >= interval) { ndiAccum %= interval; captureStart(); }
  }
}
frame();

console.log(`[wall-touch] ${PX_W}x${PX_H} render ${dw}x${dh} · ${waves.stats} · walls ${walls.map(w => w.cropW).join('/')}`);
