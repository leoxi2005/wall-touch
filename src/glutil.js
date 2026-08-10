// Minimal WebGL2 helpers for the fluid sim: programs, ping-pong render targets and a
// fullscreen blit. Deliberately dependency-free — the whole renderer is fullscreen
// quads, so pulling in three.js would only add the asar packaging trap for nothing.

export function createGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    depth: false,
    stencil: false,
    antialias: false,
    preserveDrawingBuffer: false,   // readPixels happens in the same frame as the draw
    powerPreference: 'high-performance',
    desynchronized: true
  });
  if (!gl) throw new Error('WebGL2 not available');
  // Half-float is the whole point: RGBA16F is colour-renderable only with this
  // extension, and unlike full float it is filterable in core WebGL2 (bilinear
  // sampling is what makes semi-Lagrangian advection smooth).
  const extCBF = gl.getExtension('EXT_color_buffer_float');
  if (!extCBF) throw new Error('EXT_color_buffer_float missing — cannot render to RGBA16F');
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  return gl;
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
    throw new Error(`shader compile failed:\n${log}\n${numbered}`);
  }
  return sh;
}

// A linked program plus a lazily-filled uniform-location cache. Missing uniforms
// return null and the setters below no-op, so an unused uniform that the GLSL
// optimiser stripped never throws.
export class Program {
  constructor(gl, vs, fs) {
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('program link failed: ' + gl.getProgramInfoLog(p));
    }
    this.program = p;
    this.uniforms = new Map();
  }
  loc(name) {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name);
  }
  use() { this.gl.useProgram(this.program); return this; }
  f(n, v) { const l = this.loc(n); if (l) this.gl.uniform1f(l, v); return this; }
  i(n, v) { const l = this.loc(n); if (l) this.gl.uniform1i(l, v); return this; }
  v2(n, x, y) { const l = this.loc(n); if (l) this.gl.uniform2f(l, x, y); return this; }
  v3(n, x, y, z) { const l = this.loc(n); if (l) this.gl.uniform3f(l, x, y, z); return this; }
  v4(n, x, y, z, w) { const l = this.loc(n); if (l) this.gl.uniform4f(l, x, y, z, w); return this; }
  tex(n, target, unit) {
    const l = this.loc(n);
    if (!l) return this;
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, target.texture ?? target);
    this.gl.uniform1i(l, unit);
    return this;
  }
}

// wrapS is REPEAT on every sim target: the five walls form a CLOSED pentagon, so the
// panorama's right edge physically touches its left edge. Ink drifting off wall 5
// reappearing on wall 1 is not a trick — it is the room's real topology.
export function createFBO(gl, w, h, { filter = gl.LINEAR, wrapS = gl.REPEAT, wrapT = gl.CLAMP_TO_EDGE } = {}) {
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { texture, fbo, width: w, height: h, texelX: 1 / w, texelY: 1 / h };
}

export function createDoubleFBO(gl, w, h, opts) {
  let a = createFBO(gl, w, h, opts);
  let b = createFBO(gl, w, h, opts);
  return {
    width: w, height: h, texelX: 1 / w, texelY: 1 / h,
    get read() { return a; },
    get write() { return b; },
    swap() { const t = a; a = b; b = t; }
  };
}

// One fullscreen triangle, bound once for the whole app. (A triangle rather than a
// quad: no diagonal seam, one less vertex, and the rasteriser likes it better.)
export function makeBlitter(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  return function blit(target) {
    gl.bindVertexArray(vao);
    if (target) {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    } else {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}
