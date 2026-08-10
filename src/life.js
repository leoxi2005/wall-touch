// Life in the water: a shoal of fish that scatters from your hand, and coral that grows
// where a hand stays put.
//
// Both are CPU-side for the same reason the motes are: the forces acting on them come
// from the OSC track list, which lives here, and the counts are small enough that moving
// them to the GPU would buy nothing.

const FISH_FLOATS = 7;   // x, y, size, angle, r, g, b

const FISH_VS = `#version 300 es
  layout(location=0) in vec2 aPos;
  layout(location=1) in float aSize;
  layout(location=2) in float aAngle;
  layout(location=3) in vec3 aTint;
  out vec3 vTint;
  out float vAngle;
  void main() {
    vTint = aTint;
    vAngle = aAngle;
    gl_PointSize = max(aSize, 2.0);
    gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
  }`;

// A point sprite is a square, so the fish shape is cut inside it and rotated to the
// heading. Without the rotation a shoal reads as drifting dust; with it, the whole thing
// suddenly has intent — you can see which way they are going.
const FISH_FS = `#version 300 es
  precision highp float;
  in vec3 vTint; in float vAngle; out vec4 o;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float c = cos(vAngle), s = sin(vAngle);
    q = vec2(q.x * c + q.y * s, -q.x * s + q.y * c);
    // Body: an ellipse stretched along the heading. Tail: a second, smaller lobe behind.
    float body = exp(-dot(vec2(q.x / 0.52, q.y / 0.22), vec2(q.x / 0.52, q.y / 0.22)) * 2.6);
    vec2 t = q - vec2(-0.30, 0.0);
    float tail = exp(-dot(vec2(t.x / 0.22, t.y / 0.30), vec2(t.x / 0.22, t.y / 0.30)) * 3.4) * 0.55;
    float a = clamp(body + tail, 0.0, 1.0) * smoothstep(0.75, 0.45, length(gl_PointCoord - 0.5));
    o = vec4(vTint * a, 1.0);
  }`;

function buildProgram(gl, vsSrc, fsSrc) {
  const sh = (t, src) => {
    const x = gl.createShader(t); gl.shaderSource(x, src); gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error('life: ' + gl.getShaderInfoLog(x));
    return x;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('life link: ' + gl.getProgramInfoLog(p));
  return p;
}

export class Fish {
  constructor(gl, opts) {
    this.gl = gl;
    this.cfg = opts.cfg;
    this.aspect = opts.aspect;
    this.height = opts.height;

    const n = Math.max(0, Math.round(this.cfg.count));
    const shoals = Math.max(1, Math.round(this.cfg.shoals));
    this.n = n;
    this.shoals = shoals;

    this.x = new Float32Array(n); this.y = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n);
    this.grp = new Int32Array(n);
    this.seed = new Float32Array(n);
    this.flee = new Float32Array(n);

    // Each shoal has its own slowly wandering destination. Real flocking (every fish
    // steering off every other) is O(n²) and, at this scale on a wall, indistinguishable
    // from everyone chasing the same drifting point.
    this.sx = new Float32Array(shoals); this.sy = new Float32Array(shoals);
    this.sph = new Float32Array(shoals);
    for (let g = 0; g < shoals; g++) {
      this.sx[g] = Math.random();
      this.sy[g] = 0.25 + Math.random() * 0.5;
      this.sph[g] = Math.random() * 100;
    }
    for (let i = 0; i < n; i++) {
      const g = i % shoals;
      this.grp[i] = g;
      this.x[i] = (this.sx[g] + (Math.random() - 0.5) * 0.03 + 1) % 1;
      this.y[i] = this.sy[g] + (Math.random() - 0.5) * 0.12;
      this.seed[i] = Math.random();
    }

    this.data = new Float32Array(n * FISH_FLOATS);
    this.prog = buildProgram(gl, FISH_VS, FISH_FS);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const st = FISH_FLOATS * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, st, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, st, 12);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, st, 16);
    gl.bindVertexArray(null);

    this.time = 0;
  }

  update(dt, hands) {
    const c = this.cfg, A = this.aspect;
    this.time += dt;

    for (let g = 0; g < this.shoals; g++) {
      const p = this.sph[g];
      this.sx[g] = (this.sx[g] + c.wander * Math.sin(this.time * 0.11 + p) * dt + 1) % 1;
      this.sy[g] = Math.min(0.88, Math.max(0.14,
        this.sy[g] + c.wander * 0.5 * Math.sin(this.time * 0.17 + p * 1.7) * dt));
    }

    const px = c.size * this.height;
    for (let i = 0; i < this.n; i++) {
      const g = this.grp[i], s = this.seed[i];
      let x = this.x[i], y = this.y[i];

      // Steer towards the shoal, with a personal offset so they do not all pile onto one
      // point.
      let tx = this.sx[g] + Math.sin(this.time * (0.5 + s) + s * 19.0) * 0.020;
      let ty = this.sy[g] + Math.cos(this.time * (0.4 + s) + s * 23.0) * 0.055;
      let dx = tx - x; dx -= Math.round(dx);
      let ax = dx * A * c.cohesion;
      let ay = (ty - y) * c.cohesion;

      // Flee. This is the whole point of the shoal: a hand arriving must visibly scatter
      // it, and the panic has to persist a moment after the hand has gone or they look
      // like iron filings snapping back.
      let panic = 0;
      for (const h of hands) {
        let hx = x - h.x; hx -= Math.round(hx);
        const hy = y - h.y;
        const d = Math.hypot(hx * A, hy);
        if (d > c.fearRadius) continue;
        const f = 1 - d / c.fearRadius;
        const inv = 1 / Math.max(d, 0.03);
        ax += hx * A * inv * c.fear * f * f;
        ay += hy * inv * c.fear * f * f;
        panic = Math.max(panic, f);
      }
      this.flee[i] = Math.max(panic, this.flee[i] - dt / c.calmSeconds);

      let vx = this.vx[i] + (ax / A) * dt;
      let vy = this.vy[i] + ay * dt;

      // Speed limit, measured in wall-heights so it is the same physical speed whichever
      // axis they swim along.
      const spd = Math.hypot(vx * A, vy);
      const max = c.speed * (0.75 + 0.5 * s) * (1 + this.flee[i] * c.burst);
      if (spd > max) { const k = max / spd; vx *= k; vy *= k; }
      vx *= Math.exp(-dt / c.damping); vy *= Math.exp(-dt / c.damping);
      this.vx[i] = vx; this.vy[i] = vy;

      x += vx * dt; y += vy * dt;
      x -= Math.floor(x);
      if (y < 0.06) { y = 0.06; this.vy[i] = Math.abs(vy); }
      if (y > 0.94) { y = 0.94; this.vy[i] = -Math.abs(vy); }
      this.x[i] = x; this.y[i] = y;

      const k = c.brightness * (0.6 + 0.4 * Math.sin(this.time * 2.0 + s * 30.0)) * (1 + this.flee[i] * 1.6);
      const o = i * FISH_FLOATS;
      this.data[o] = x;
      this.data[o + 1] = y;
      this.data[o + 2] = px * (0.7 + 0.6 * s);
      this.data[o + 3] = Math.atan2(vy, vx * A);
      this.data[o + 4] = c.color[0] * k;
      this.data[o + 5] = c.color[1] * k;
      this.data[o + 6] = c.color[2] * k;
    }
  }

  draw() {
    const gl = this.gl;
    if (!this.n) return;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data);
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, this.n);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}

// Coral — what a hand that STOPS gets, instead of a longer smear.
//
// A stroke rewards movement; without this, standing still and pressing does nothing but
// pile up a round lump. Here a resting hand seeds growth tips that crawl outward and
// branch, depositing into the same trail field the strokes use — so the contour lines
// wrap the branches exactly as they wrap a ridge, and the structure dissolves on the
// same decay as everything else.
export class Coral {
  constructor(opts) {
    this.cfg = opts.cfg;
    this.aspect = opts.aspect;
    this.tips = [];
  }

  seed(x, y, color) {
    const c = this.cfg;
    if (this.tips.length >= c.maxTips) return;
    const n = 2 + ((Math.random() * 2) | 0);
    for (let i = 0; i < n; i++) {
      this.tips.push({
        x, y,
        dir: Math.random() * Math.PI * 2,
        life: c.tipLife * (0.6 + Math.random() * 0.8),
        gen: 0,
        color
      });
    }
  }

  // waves.deposit is passed in rather than imported: coral has no business knowing what
  // the field is, only that it can add material to it.
  update(dt, deposit) {
    const c = this.cfg;
    if (!this.tips.length) return;
    const next = [];
    for (const t of this.tips) {
      t.life -= dt;
      if (t.life <= 0) continue;

      // Wander, but with a bias that grows with generation, so the branches curl rather
      // than radiating like a starburst.
      t.dir += (Math.random() - 0.5) * c.wander * dt * 60 * 0.016;
      const step = c.speed * dt;
      t.x = (t.x + Math.cos(t.dir) * step / this.aspect + 1) % 1;
      t.y = Math.min(0.97, Math.max(0.03, t.y + Math.sin(t.dir) * step));

      deposit(t.x, t.y, t.color, c.ink * dt, c.thickness);

      if (t.gen < c.maxGen && Math.random() < c.branchChance * dt && this.tips.length + next.length < c.maxTips) {
        next.push({
          x: t.x, y: t.y,
          dir: t.dir + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.7),
          life: t.life * 0.75,
          gen: t.gen + 1,
          color: t.color
        });
      }
      next.push(t);
    }
    this.tips = next;
  }

  get count() { return this.tips.length; }
}
