// Motes — the drifting specks of light on the water.
//
// Deliberately a CPU particle system, not a GPU one. There are only a couple of
// thousand of them, and every force acting on them (the slow current, and a swirl round
// each hand) is already known on the CPU from the OSC tracks — pushing that to the GPU
// would mean uploading the touch list as uniforms and reading the wave texture back,
// for a saving that does not exist at this count.
//
// They exist for one reason: to make a touch have a VISIBLE, immediate consequence.
// The contour field responds beautifully but slowly; motes are pulled into orbit the
// instant a hand lands, so the wall answers the moment you touch it.

const FLOATS = 6;   // x, y, size, r, g, b

const POINT_VS = `#version 300 es
  layout(location=0) in vec2 aPos;
  layout(location=1) in float aSize;
  layout(location=2) in vec3 aTint;
  out vec3 vTint;
  void main() {
    vTint = aTint;
    gl_PointSize = max(aSize, 1.0);
    gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
  }`;

// Soft filled dot. A hard-edged square point reads as digital dirt on a 10 m projection.
const DOT_FS = `#version 300 es
  precision highp float;
  in vec3 vTint; out vec4 o;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = exp(-d * d * 3.2) * smoothstep(1.0, 0.75, d);
    o = vec4(vTint * a, 1.0);
  }`;

// Hollow ring — this is the whole difference between "a dot" and "a bubble". The rim is
// bright, the middle is nearly empty, with a small off-centre glint for the highlight
// every real bubble has.
const BUBBLE_FS = `#version 300 es
  precision highp float;
  in vec3 vTint; out vec4 o;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float d = length(q) * 2.0;
    float rim = exp(-pow((d - 0.78) * 5.2, 2.0));
    float glint = exp(-pow(length(q - vec2(-0.16, 0.16)) * 9.0, 2.0)) * 0.9;
    float a = (rim + glint) * smoothstep(1.05, 0.85, d);
    o = vec4(vTint * a, 1.0);
  }`;

function buildProgram(gl, fsSrc) {
  const sh = (t, src) => {
    const x = gl.createShader(t); gl.shaderSource(x, src); gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error('points: ' + gl.getShaderInfoLog(x));
    return x;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, POINT_VS));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('points link: ' + gl.getProgramInfoLog(p));
  return p;
}

// One dynamic vertex buffer + VAO, drawn as additive GL_POINTS.
class PointLayer {
  constructor(gl, capacity, fsSrc) {
    this.gl = gl;
    this.cap = capacity;
    this.data = new Float32Array(capacity * FLOATS);
    this.count = 0;
    this.prog = buildProgram(gl, fsSrc);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 12);
    gl.bindVertexArray(null);
  }
  draw() {
    const gl = this.gl;
    if (!this.count) return;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, this.count * FLOATS));
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}

// Bubbles rise from wherever a hand is touching, wobble on the way up, and pop at the
// surface. Unlike the motes — which are ambient and always there — a bubble exists only
// because somebody is touching the wall right now, so it is the most direct "I did that"
// feedback in the piece.
export class Bubbles {
  constructor(gl, opts) {
    this.cfg = opts.cfg;
    this.aspect = opts.aspect;
    this.height = opts.height;
    const cap = Math.max(1, Math.round(this.cfg.max));
    this.layer = new PointLayer(gl, cap, BUBBLE_FS);
    this.x = new Float32Array(cap); this.y = new Float32Array(cap);
    this.vy = new Float32Array(cap); this.age = new Float32Array(cap);
    this.life = new Float32Array(cap); this.seed = new Float32Array(cap);
    this.r = new Float32Array(cap); this.g = new Float32Array(cap); this.b = new Float32Array(cap);
    this.n = 0;
    this.spawnDebt = 0;
    this.time = 0;
  }

  spawn(x, y, color) {
    const c = this.cfg;
    const i = this.n < this.layer.cap ? this.n++ : (Math.random() * this.layer.cap) | 0;
    this.x[i] = (x + (Math.random() - 0.5) * c.spread / this.aspect + 1) % 1;
    this.y[i] = y + (Math.random() - 0.5) * c.spread;
    this.vy[i] = c.rise * (0.6 + Math.random() * 0.8);
    this.age[i] = 0;
    this.life[i] = c.life * (0.6 + Math.random() * 0.8);
    this.seed[i] = Math.random();
    this.r[i] = color[0]; this.g[i] = color[1]; this.b[i] = color[2];
  }

  update(dt, hands) {
    const c = this.cfg;
    this.time += dt;

    // Emission is per-second per hand, accumulated so a low rate still produces bubbles
    // at any framerate instead of rounding to zero every frame.
    if (hands.length) {
      this.spawnDebt += c.rate * hands.length * dt;
      while (this.spawnDebt >= 1) {
        this.spawnDebt -= 1;
        const h = hands[(Math.random() * hands.length) | 0];
        this.spawn(h.x, h.y, h.color);
      }
    } else {
      this.spawnDebt = 0;
    }

    const px = c.size * this.height;
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1 || this.y[i] > 0.99) continue;      // popped — dropped from the buffer

      const s = this.seed[i];
      this.y[i] += this.vy[i] * dt;
      // Wobble: a bubble that rises dead straight looks like a bullet.
      this.x[i] = (this.x[i] + Math.sin(this.time * (1.6 + s * 2.2) + s * 30.0) * c.wobble * dt + 1) % 1;

      // Grows a little as it rises, fades in fast and out slowly, brightest mid-life.
      const fade = Math.min(1, t * 12) * (1 - t * t);
      const k = c.brightness * fade;
      const o = w * FLOATS;
      const d = this.layer.data;
      d[o] = this.x[i];
      d[o + 1] = this.y[i];
      d[o + 2] = px * (0.55 + 0.9 * s) * (1 + t * 0.5);
      d[o + 3] = (0.45 + 0.55 * this.r[i]) * k;
      d[o + 4] = (0.55 + 0.45 * this.g[i]) * k;
      d[o + 5] = (0.75 + 0.25 * this.b[i]) * k;
      w++;

      // Compact the live set in place so dead bubbles never cost anything.
      if (w - 1 !== i) {
        const j = w - 1;
        this.x[j] = this.x[i]; this.y[j] = this.y[i]; this.vy[j] = this.vy[i];
        this.age[j] = this.age[i]; this.life[j] = this.life[i]; this.seed[j] = this.seed[i];
        this.r[j] = this.r[i]; this.g[j] = this.g[i]; this.b[j] = this.b[i];
      }
    }
    this.n = w;
    this.layer.count = w;
  }

  draw() { this.layer.draw(); }
}

export class Motes {
  constructor(gl, opts) {
    this.gl = gl;
    this.cfg = opts.cfg;
    this.aspect = opts.aspect;
    this.height = opts.height;

    const n = Math.max(0, Math.round(this.cfg.count));
    this.n = n;
    this.p = new Float32Array(n * 2);        // position, panorama uv
    this.v = new Float32Array(n * 2);        // velocity, uv/s
    this.seed = new Float32Array(n);
    this.tint = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
      this.p[i * 2] = Math.random();
      this.p[i * 2 + 1] = 0.06 + Math.random() * 0.88;
      this.seed[i] = Math.random();
      this.tint[i * 3] = 0.55; this.tint[i * 3 + 1] = 0.82; this.tint[i * 3 + 2] = 1.0;
    }

    this.layer = new PointLayer(gl, n, DOT_FS);
    this.layer.count = n;
    this.data = this.layer.data;
    this.time = 0;
  }

  // hands: [{ x, y, color }] in panorama uv
  update(dt, hands) {
    const c = this.cfg;
    this.time += dt;
    const A = this.aspect;
    const pxSize = c.size * this.height;

    for (let i = 0; i < this.n; i++) {
      const ix = i * 2, iy = ix + 1;
      let x = this.p[ix], y = this.p[iy];
      const s = this.seed[i];

      // Slow current. The x frequency is one lap of the room so the drift is continuous
      // across the pentagon seam, same rule the rest of the piece obeys.
      let ax = c.drift * (0.35 + 0.65 * s);
      let ay = c.drift * 0.35 * Math.sin(this.time * (0.2 + s * 0.5) + s * 31.0);

      let tr = 0.55, tg = 0.82, tb = 1.0, near = 0;

      for (const h of hands) {
        let dx = h.x - x; dx -= Math.round(dx);
        const dy = h.y - y;
        const dwh = Math.hypot(dx * A, dy);          // wall-heights
        if (dwh > c.reach) continue;
        const g = 1 - dwh / c.reach;
        const g2 = g * g;
        const inv = 1 / Math.max(dwh, 0.02);

        // Pull in, and swirl around: pure attraction collapses them onto the hand and
        // they vanish. The perpendicular term makes them ORBIT, which is what reads as
        // the water being stirred.
        ax += (dx * A * inv) * c.pull * g2 / A;
        ay += (dy * inv) * c.pull * g2;
        ax += (-dy * inv) * c.swirl * g2 / A;
        ay += (dx * A * inv) * c.swirl * g2;

        if (g2 > near) {
          near = g2;
          tr = h.color[0]; tg = h.color[1]; tb = h.color[2];
        }
      }

      let vx = this.v[ix] + ax * dt;
      let vy = this.v[iy] + ay * dt;
      const damp = Math.exp(-dt / c.damping);
      vx *= damp; vy *= damp;
      this.v[ix] = vx; this.v[iy] = vy;

      x += vx * dt; y += vy * dt;
      x -= Math.floor(x);                       // the room wraps
      if (y < 0.03) { y = 0.03; this.v[iy] = Math.abs(vy) * 0.4; }
      if (y > 0.97) { y = 0.97; this.v[iy] = -Math.abs(vy) * 0.4; }
      this.p[ix] = x; this.p[iy] = y;

      // Brightness: a slow twinkle, lifted hard near a hand.
      const tw = 0.45 + 0.55 * Math.sin(this.time * (0.7 + s * 1.6) + s * 47.0);
      const lift = 1 + near * c.excite;
      const k = c.brightness * tw * lift;

      const o = i * FLOATS;
      this.data[o] = x;
      this.data[o + 1] = y;
      this.data[o + 2] = pxSize * (0.6 + 0.8 * s) * (1 + near * 0.9);
      this.data[o + 3] = tr * k;
      this.data[o + 4] = tg * k;
      this.data[o + 5] = tb * k;
    }
  }

  // Additive, straight onto whatever is currently bound — called after the composite so
  // the motes sit on top of the graded image and are picked up by the NDI readback.
  draw() { this.layer.draw(); }
}
