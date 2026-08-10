// On-wall calibration marks.
//
// These MUST be drawn into the canvas, not into the DOM HUD: the wall only ever sees
// what goes out over NDI, and the whole point is for someone standing in the room to put
// their hand exactly on a mark. A DOM overlay would be invisible to them.
//
// Why this exists at all: the bridge's continuous u,v comes from its warp quad, and the
// left/right edges of that quad were eyeballed — the laser fan overshoots the room
// corners, so the baseline never actually sees where a wall ends. Zone triggering never
// used u,v (it tests world metres), so the error stayed invisible until this app, which
// is driven by u,v, put a hand's position on the wall and let people compare.

const VS = `#version 300 es
  layout(location=0) in vec2 aPos;
  layout(location=1) in vec3 aTint;
  out vec3 vTint;
  void main() {
    vTint = aTint;
    gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
  }`;

const FS = `#version 300 es
  precision highp float;
  in vec3 vTint; out vec4 o;
  void main() { o = vec4(vTint, 1.0); }`;

const FLOATS = 5;   // x, y, r, g, b

// The four points every wall is calibrated from: the corners of a generous rectangle.
// Corners rather than a line because the fit has to separate horizontal error from the
// part of it that depends on height, and 30%/70% of a 2.4 m wall is 72 cm and 168 cm —
// both comfortable to reach.
export const MARKS = [
  { fx: 0.25, fy: 0.30, col: [0.10, 1.00, 0.30] },   // green   — low left
  { fx: 0.75, fy: 0.30, col: [1.00, 0.45, 0.02] },   // orange  — low right
  { fx: 0.25, fy: 0.70, col: [0.30, 0.60, 1.00] },   // blue    — high left
  { fx: 0.75, fy: 0.70, col: [1.00, 0.20, 0.60] }    // pink    — high right
];

// Calibration marks are drawn ADDITIVELY, so over a bright stretch of water a green mark
// comes out yellow and an orange one comes out pink — useless when the whole instruction
// is "stand on the GREEN one". Dimming the scene first is not decoration: it is what
// makes the marks the only thing in the room and their colours true.
const DIM_VS = `#version 300 es
  layout(location=0) in vec2 aPos;
  void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
const DIM_FS = `#version 300 es
  precision highp float;
  uniform float uAlpha;
  out vec4 o;
  void main() { o = vec4(0.0, 0.0, 0.0, uAlpha); }`;

export class Calib {
  constructor(gl, opts) {
    this.gl = gl;
    this.walls = opts.walls;
    this.aspect = opts.aspect;
    this.on = false;

    const cap = 2048;
    this.data = new Float32Array(cap * FLOATS);
    this.cap = cap;
    this.count = 0;

    const sh = (t, src) => {
      const x = gl.createShader(t); gl.shaderSource(x, src); gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error('calib: ' + gl.getShaderInfoLog(x));
      return x;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('calib link: ' + gl.getProgramInfoLog(p));
    this.prog = p;

    const dp = gl.createProgram();
    gl.attachShader(dp, sh(gl.VERTEX_SHADER, DIM_VS));
    gl.attachShader(dp, sh(gl.FRAGMENT_SHADER, DIM_FS));
    gl.linkProgram(dp);
    if (!gl.getProgramParameter(dp, gl.LINK_STATUS)) throw new Error('calib dim link: ' + gl.getProgramInfoLog(dp));
    this.dimProg = dp;
    this.dimAlpha = opts.dimAlpha ?? 0.82;
    this.dimVao = gl.createVertexArray();
    gl.bindVertexArray(this.dimVao);
    const dvbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, dvbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const st = FLOATS * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, st, 0);
    // Offset 8, NOT 12. The particle layers put a `size` float between position and
    // tint; this vertex has no size, so copying their offset made every colour read one
    // slot late — green marks came out yellow, orange came out red. Silent, and only
    // visible as "the colours are wrong", which is easy to blame on the additive blend.
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, st, 8);
    gl.bindVertexArray(null);
  }

  _line(x, y0, y1, r, g, b) {
    if (this.count + 2 > this.cap) return;
    const d = this.data;
    let o = this.count * FLOATS;
    d[o] = x; d[o + 1] = y0; d[o + 2] = r; d[o + 3] = g; d[o + 4] = b;
    o += FLOATS;
    d[o] = x; d[o + 1] = y1; d[o + 2] = r; d[o + 3] = g; d[o + 4] = b;
    this.count += 2;
  }

  // A vertical bar a few pixels wide, built from several 1-px lines, so it is readable
  // from across a 10 m room.
  _bar(x, y0, y1, r, g, b, widthUv) {
    const n = 5;
    for (let i = 0; i < n; i++) {
      this._line(((x + (i - (n - 1) / 2) * widthUv / n) + 1) % 1, y0, y1, r, g, b);
    }
  }

  // A cross marks a POINT, which is what a 2D fit needs. Two vertical bars could only
  // ever pin down horizontal error; the quad's error mixes the axes, so the marks have to
  // say "put your hand exactly HERE", not "somewhere on this line".
  _cross(x, y, r, g, b, widthUv, sizeUv) {
    this._bar(x, y - sizeUv, y + sizeUv, r, g, b, widthUv);
    const n = 5;
    const halfX = sizeUv / this.aspect;
    for (let i = 0; i < n; i++) {
      const yy = y + (i - (n - 1) / 2) * widthUv / n;
      if (this.count + 2 > this.cap) return;
      const d = this.data;
      let o = this.count * FLOATS;
      d[o] = ((x - halfX) + 1) % 1; d[o + 1] = yy; d[o + 2] = r; d[o + 3] = g; d[o + 4] = b;
      o += FLOATS;
      d[o] = ((x + halfX) + 1) % 1; d[o + 1] = yy; d[o + 2] = r; d[o + 3] = g; d[o + 4] = b;
      this.count += 2;
    }
  }

  // hands: [{ x }] in panorama uv. `wallOf` maps a hand to its wall index for colouring.
  // `capture` is which marks have been taken on which wall; `flash` counts down after a
  // capture. Both are drawn ON THE WALL, because the person doing the calibration is
  // standing at the wall and cannot see the operator's screen — without this they have no
  // way to know whether holding still worked.
  build(hands, pxW, capture = null, flash = 0) {
    this.count = 0;
    if (!this.on) return;
    const wUv = 6 / pxW;   // ~6 px wide bars — readable from the far side of the room

    for (const w of this.walls) {
      // Wall edges — dim. Useful on their own: if these do not land on the physical
      // corners of the room, the projector mapping is off, not the sensor.
      this._bar(w.u0, 0.0, 1.0, 0.10, 0.16, 0.22, wUv);

      const taken = (capture && capture.wall === w.index) ? capture.taken : null;
      for (let i = 0; i < MARKS.length; i++) {
        const m = MARKS[i];
        const got = taken && taken[i];
        // Colour says which one to go to next: unvisited marks keep their colour, a
        // captured one turns white and grows.
        const col = got ? [1.0, 1.0, 1.0] : m.col;
        this._cross(w.u0 + m.fx * w.uw, m.fy, col[0], col[1], col[2],
          wUv * (got ? 3.0 : 2.0), 0.11);
      }
    }

    // Where the app currently believes each hand is. The gap between this and the actual
    // hand IS the error being calibrated out.
    for (const h of hands) this._bar(h.x, 0.0, 1.0, 1.0, 1.0, 1.0, wUv * 2.5);

    // Confirmation flash across the whole room, so a capture is impossible to miss.
    if (flash > 0) {
      const k = Math.min(1, flash) * 0.8;
      for (let i = 0; i < 40; i++) this._bar(i / 40, 0.0, 1.0, k, k, k, wUv);
    }
  }

  draw() {
    const gl = this.gl;
    if (!this.on || !this.count) return;

    gl.useProgram(this.dimProg);
    gl.uniform1f(gl.getUniformLocation(this.dimProg, 'uAlpha'), this.dimAlpha);
    gl.bindVertexArray(this.dimVao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, this.count * FLOATS));
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.LINES, 0, this.count);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
