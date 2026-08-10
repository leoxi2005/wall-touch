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

// Per-track state the tracker has no business knowing about: where this hand was on the
// previous sample, when it last sent out a ring, and which colour it owns.
const lastPos = new Map();
const ringClock = new Map();
const colorId = new Map();

// Tracks that vanished a moment ago, kept just long enough to stitch a stroke back
// together. See stitchGhost() — this is what stops one continuous hand movement from
// being drawn as several differently-coloured strokes.
let ghosts = [];

function applyTouches(dt) {
  const tracks = tracker.update(dt);
  for (const [, t] of tracks) applyTrack(t, dt);

  // Retire state whose track is gone, remembering where it ended.
  if (ringClock.size > tracks.size) {
    for (const k of [...ringClock.keys()]) {
      if (tracks.has(k)) continue;
      const p = lastPos.get(k);
      if (p) ghosts.push({ x: p.x, y: p.y, cid: colorId.get(k), t: clock });
      ringClock.delete(k); lastPos.delete(k); colorId.delete(k);
    }
  }
  const keep = (cfg.osc?.stitchSeconds ?? 0.7);
  if (ghosts.length) ghosts = ghosts.filter(g => clock - g.t < keep);

  return tracks.size;
}

// A hand sliding along the wall does NOT always keep one identity: the bridge can drop
// and re-acquire it, and crossing a corner hands it to a different sensor entirely,
// which means a different track id under a different wall prefix. Untreated, one long
// swipe comes out as several strokes in several colours, each restarting with its own
// splash.
//
// So when a "new" touch appears right where one just disappeared, treat it as the same
// hand: inherit the colour and carry the stroke on from the old position, so the trail
// joins up instead of breaking.
function stitchGhost(x, y) {
  const rad = cfg.osc?.stitchRadius ?? 0.30;      // wall-heights
  let best = null, bestD = rad;
  for (const g of ghosts) {
    let dx = x - g.x; dx -= Math.round(dx);
    const d = Math.hypot(dx * ASPECT, y - g.y);
    if (d < bestD) { bestD = d; best = g; }
  }
  if (best) ghosts = ghosts.filter(g => g !== best);
  return best;
}

function pointerUv(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height };
}

// Paint one stroke segment: everything a hand did between the previous sample and this
// one. TWO things here are load-bearing, and the first version got both wrong so that a
// quick swipe left nothing on the wall at all:
//
//  1. Deposit is proportional to DISTANCE, not to time. Time-based deposit means a hand
//     that lingers builds a mountain while a hand that sweeps past deposits almost
//     nothing — because it spends almost no time anywhere. A stroke should weigh the
//     same per metre however fast it was drawn.
//  2. It STAMPS ALONG the segment. At 30 Hz a hand moving 2 m/s jumps further than the
//     stamp radius, so one stamp per sample lands as a dotted line instead of a stroke.
function paintStroke(key, x, y, color, dt) {
  const prev = lastPos.get(key);
  lastPos.set(key, { x, y });
  if (!prev) return 0;

  let dx = x - prev.x; dx -= Math.round(dx);        // pentagon: take the short way round
  const dy = y - prev.y;
  const dist = Math.hypot(dx * ASPECT, dy);         // wall-heights

  const step = W.trailRadius * 0.5;
  const n = Math.min(W.maxStamps ?? 14, Math.max(1, Math.ceil(dist / step)));
  const perStamp = W.trailInk * (dist / step) / n;
  if (perStamp > 1e-4) {
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      waves.deposit((prev.x + dx * f + 1) % 1, prev.y + dy * f, color, perStamp, 1);
    }
  }

  // Dwell is what is left of the old behaviour: a hand held still does still sink into
  // the surface, just slowly, and only where it actually rests.
  waves.deposit(x, y, color, W.trailDwell * dt, 1);

  // The wake is per-distance as well — dragging across the room throws real wave, a
  // resting hand throws none. Capped so a single jumpy LiDAR sample cannot detonate it.
  if (dist > 1e-4) waves.impulse(x, y, Math.min(W.wakeAmp * dist, W.wakeMax ?? 0.45), 0.8);

  return dist;
}

function applyTrack(t, dt) {
  if (t.fresh) {
    const g = stitchGhost(t.x, t.y);
    const cid = g ? g.cid : t.id;
    colorId.set(t.key, cid);
    const color = colorFor(cid);

    if (g) {
      // Same hand, new id: continue the stroke from where it stopped, and no splash —
      // a hand that never left the wall must not look like a fresh touch.
      lastPos.set(t.key, { x: g.x, y: g.y });
      paintStroke(t.key, t.x, t.y, color, dt);
    } else {
      waves.impulse(t.x, t.y, W.dropAmp, 1.0);
      waves.deposit(t.x, t.y, color, W.trailInk, 1.2);
      lastPos.set(t.key, { x: t.x, y: t.y });
    }
    ringClock.set(t.key, 0);
    t.fresh = false;
    return;
  }

  const color = colorFor(colorId.get(t.key) ?? t.id);
  paintStroke(t.key, t.x, t.y, color, dt);

  // A hand resting on the wall keeps emitting concentric rings, but on a rhythm — every
  // frame would just be a permanent bulge.
  const c = (ringClock.get(t.key) ?? 0) + dt;
  if (c >= W.ringInterval) {
    ringClock.set(t.key, 0);
    waves.impulse(t.x, t.y, W.ringAmp, 1.0);
  } else {
    ringClock.set(t.key, c);
  }
}

// Mouse drag = one fake touch, for developing without the sensors. It goes through the
// SAME paintStroke as a real hand, so if it feels wrong here it is wrong on the wall.
let mouse = null;
canvas.addEventListener('pointerdown', (e) => {
  const p = pointerUv(e);
  mouse = { id: (Math.random() * 1e6) | 0 };
  waves.impulse(p.x, p.y, W.dropAmp, 1.0);
  waves.deposit(p.x, p.y, colorFor(mouse.id), W.trailInk, 1.2);
  lastPos.set('mouse', { x: p.x, y: p.y });
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* not fatal */ }
});
canvas.addEventListener('pointermove', (e) => {
  if (!mouse) return;
  const p = pointerUv(e);
  paintStroke('mouse', p.x, p.y, colorFor(mouse.id), 1 / 60);
});
window.addEventListener('pointerup', () => { mouse = null; lastPos.delete('mouse'); });

// DEMO=1 npm start → synthetic hands drawing across the walls. Lets the look be tuned
// (and snapshots taken) without the five sensors, and doubles as an on-site smoke test
// that the render/NDI path is alive before the bridge is connected.
const DEMO = typeof process !== 'undefined' && process.env?.DEMO === '1';
const demoHands = DEMO ? [
  { id: 901, key: 'd1', cx: 0.12, cy: 0.55, ax: 0.055, ay: 0.15, sx: 0.42, sy: 0.71, ph: 0.0, x: 0, y: 0, fresh: true },
  { id: 902, key: 'd2', cx: 0.45, cy: 0.48, ax: 0.090, ay: 0.20, sx: 0.31, sy: 0.53, ph: 2.1, x: 0, y: 0, fresh: true },
  { id: 903, key: 'd3', cx: 0.82, cy: 0.60, ax: 0.070, ay: 0.14, sx: 0.55, sy: 0.37, ph: 4.3, x: 0, y: 0, fresh: true },
  // A FAST sweeper (~2 m/s, the speed of someone actually swiping). The first three
  // hands all drift slowly, which is exactly why the original time-based trail looked
  // fine in testing and left nothing at all when a real hand swept past.
  { id: 904, key: 'd4', cx: 0.62, cy: 0.50, ax: 0.120, ay: 0.05, sx: 0.72, sy: 0.29, ph: 1.1, x: 0, y: 0, fresh: true }
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
