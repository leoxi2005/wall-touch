// All GLSL for the interference wall. ES 3.00 (WebGL2).
//
// The picture is a contour map of ONE height field, built from three layers:
//
//   base   procedural swell, evaluated full-resolution, so the wall is alive when the
//          room is empty
//   wave   a real 2D wave equation — ripples that travel, reflect off floor and
//          ceiling, run right round the room, and interfere with each other
//   trail  a slowly-decaying deposit along every hand's path. A touch leaves a RIDGE in
//          the terrain, so the contour lines bend around where you swiped and stay bent
//          for several seconds after you let go
//
// Simulating the ripples rather than drawing analytic rings is what buys the good
// behaviour for free: two people's waves add up on their own, the moiré where they meet
// is real interference, and a wave still crossing the room after its owner walked away
// costs nothing extra.
//
// THE ONE GEOMETRIC FACT EVERYTHING OBEYS: the domain is PERIODIC IN X. The five walls
// close into a pentagon, so uv.x = 1 is the same physical edge as uv.x = 0. Every sim
// texture wraps on S, and any distance measured in x takes the short way round.
//
// NO BACKTICKS ANYWHERE IN THIS FILE — the GLSL lives inside JS template literals, so
// one stray backtick in a comment closes the string and the app dies at load with a
// syntax error pointing at the comment, not at the shader.

export const baseVert = /* glsl */`#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
uniform vec2 uTexel;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vL = vUv - vec2(uTexel.x, 0.0);
  vR = vUv + vec2(uTexel.x, 0.0);
  vT = vUv + vec2(0.0, uTexel.y);
  vB = vUv - vec2(0.0, uTexel.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const head = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
out vec4 fragColor;

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i),              h21(i + vec2(1, 0)), u.x),
             mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
// Noise that TILES in x with an integer period. The room is a closed pentagon, so the
// base field must come back to itself at uv.x = 1 or there is a visible seam on the
// wall-5 → wall-1 join. Octaves double the period exactly (x *= 2.0, not the usual
// 2.03) so every octave keeps tiling.
float hashP(vec2 i, float P) {
  i.x = mod(i.x, P);
  return fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoiseP(vec2 x, float P) {
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hashP(i, P),              hashP(i + vec2(1, 0), P), u.x),
             mix(hashP(i + vec2(0, 1), P), hashP(i + vec2(1, 1), P), u.x), u.y);
}
float fbmP(vec2 x, float P) {
  float s = 0.0, a = 0.5, per = P;
  for (int i = 0; i < 4; i++) { s += a * vnoiseP(x, per); x *= 2.0; per *= 2.0; a *= 0.5; }
  return s;
}
`;

// ---------------------------------------------------------------- wave equation

// u_next = 2u - u_prev + k·∇²u, damped. R holds u, G holds the previous u, so one
// texture carries both time levels and the whole simulation is a single ping-pong.
//
// k is the Courant number squared: above ~0.5 this explodes. Ripple speed therefore
// comes from running several sub-steps per frame, never from raising k.
export const waveStepFrag = head + /* glsl */`
uniform sampler2D uWave;
uniform float uK;
uniform float uDamp;
void main() {
  vec2 c = texture(uWave, vUv).rg;
  float lap = texture(uWave, vL).r + texture(uWave, vR).r
            + texture(uWave, vT).r + texture(uWave, vB).r - 4.0 * c.r;
  float next = (2.0 * c.r - c.g + uK * lap) * uDamp;
  fragColor = vec4(next, c.r, 0.0, 1.0);
}`;

// A drop displaces the surface at BOTH time levels: equal u and u_prev means zero
// initial velocity, which is what makes the ring expand symmetrically. Adding to u
// alone launches it lopsided.
export const waveSplatFrag = head + /* glsl */`
uniform sampler2D uTarget;
uniform float uAspect;
uniform vec2 uPoint;
uniform float uRadius;
uniform float uAmp;
void main() {
  vec2 p = vUv - uPoint;
  p.x -= round(p.x);              // periodic domain: short way round the pentagon
  p.x *= uAspect;
  float g = exp(-dot(p, p) / uRadius) * uAmp;
  vec2 c = texture(uTarget, vUv).rg;
  fragColor = vec4(c.r + g, c.g + g, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- trail field

// RGB carries the toucher's colour, A carries deposited height. Capped, or a hand held
// still piles up terrain forever until the contours collapse into a solid white disc.
export const trailSplatFrag = head + /* glsl */`
uniform sampler2D uTarget;
uniform float uAspect;
uniform vec3 uColor;
uniform vec2 uPoint;
uniform float uRadius;
uniform float uAmount;
uniform float uCap;
void main() {
  vec2 p = vUv - uPoint;
  p.x -= round(p.x);
  p.x *= uAspect;
  float g = exp(-dot(p, p) / uRadius) * uAmount;
  vec4 prev = texture(uTarget, vUv);
  // A carries HEIGHT, RGB carries a pure colour. Clamping colour per channel (the
  // obvious version) bleaches every trail towards white as the strong channels hit the
  // cap first — so height is capped and the colour is blended by how much of the total
  // deposit is new, which keeps a cyan trail cyan however long someone leans on it.
  float newA = min(prev.a + g, uCap);
  vec3 col = mix(prev.rgb, uColor, clamp(g / max(newA, 1e-4), 0.0, 1.0));
  fragColor = vec4(col, newA);
}`;

// Exponential decay, framerate-independent (exp(-dt/hold), computed on the CPU).
// That constant IS how long a swipe stays on the wall.
export const decayFrag = head + /* glsl */`
uniform sampler2D uTexture;
uniform float uDecay;
void main() { fragColor = texture(uTexture, vUv) * uDecay; }`;

// ---------------------------------------------------------------- contour render

export const contourFrag = head + /* glsl */`
uniform sampler2D uWave;
uniform sampler2D uTrail;
uniform vec2 uSimTexel;
uniform float uTime;
uniform float uAspect;
uniform float uContours;
uniform float uMajorEvery;
uniform float uBaseAmp;
uniform float uWaveGain;
uniform float uTrailGain;
uniform vec3 uCold;
uniform vec3 uHot;
uniform float uGlow;
uniform float uTrailGlow;
uniform float uRelief;      // slope exaggeration for the shading
uniform float uAmbient;
uniform float uShade;
uniform float uSpec;
uniform vec3 uDeep;         // hypsometric ramp: valley → mid → crest
uniform vec3 uMid;
uniform vec3 uHigh;
uniform float uSeaLevel;    // height of the waterline in field units
uniform float uSeaDrift;    // how far it breathes up and down
uniform float uSeaSpeed;
uniform vec3 uLand;         // colour of ground that has risen above the water
uniform float uCoast;       // brightness of the shoreline itself
uniform float uLightSpin;

// Four taps on the diagonals of one sim texel. The simulation runs at a fraction of the
// output size, and a plain bilinear read leaves C0 kinks that contour extraction turns
// into visible faceting along every line. Averaging four bilinear taps costs almost
// nothing and hides it completely.
vec4 smooth4(sampler2D s, vec2 uv) {
  // ±0.9 texel, not ±0.5. The tighter kernel was enough for the LINES, but the relief
  // shading takes a DERIVATIVE of this field, and a derivative magnifies exactly the C0
  // kinks bilinear upsampling leaves behind — they showed up as square glitter tiles
  // wherever the specular caught them.
  vec2 h = uSimTexel * 0.9;
  return 0.25 * (texture(s, uv + vec2( h.x,  h.y)) + texture(s, uv + vec2(-h.x,  h.y))
               + texture(s, uv + vec2( h.x, -h.y)) + texture(s, uv + vec2(-h.x, -h.y)));
}

void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);   // wall-height units: a circle is a circle

  // Resting swell — long crossing waves plus two octaves of drift. Nothing in here
  // should read as a shape; it exists so the room breathes when it is empty.
  // Every x frequency is an exact multiple of one lap of the room (TAU/uAspect) and
  // both noise layers tile on integer periods, so the field is continuous across the
  // seam. Free-hand constants here WILL show as a vertical scar on the wall.
  const float TAU = 6.28318530718;
  float lap = TAU / uAspect;               // one full cycle around all five walls
  float f = 0.0;
  f += sin(p.x * lap + uTime * 0.13) * 0.55;
  f += sin(p.y * 1.35 - uTime * 0.09 + sin(p.x * lap * 2.0) * 1.2) * 0.42;
  f += (fbmP(vec2(vUv.x * 6.0 + uTime * 0.10, vUv.y * 6.0 / uAspect + uTime * 0.05), 6.0) - 0.5) * 1.35;
  f += (fbmP(vec2(vUv.x * 18.0 - uTime * 0.30, vUv.y * 18.0 / uAspect), 18.0) - 0.5) * 0.42;
  f *= uBaseAmp;

  float wave = smooth4(uWave, vUv).r;
  vec4 trail = smooth4(uTrail, vUv);
  f += wave * uWaveGain + trail.a * uTrailGain;

  // Contour extraction. fwidth keeps every line one pixel wide however steep the field
  // gets — without it the crowded rings around a fresh touch turn into grey mush, which
  // is exactly what makes most iso-line visuals look cheap.
  float v = f * uContours;
  float w = fwidth(v);
  float minor = 1.0 - smoothstep(0.6 * w, 1.5 * w, abs(fract(v) - 0.5));

  float vm = v / uMajorEvery;
  float wm = fwidth(vm);
  float major = 1.0 - smoothstep(0.6 * wm, 1.5 * wm, abs(fract(vm) - 0.5));

  // --- relief -------------------------------------------------------------------
  // Lines alone read as a diagram. Shading the surface BETWEEN them is what turns this
  // into something with volume: a swipe stops being a set of rings and becomes a ridge
  // with a lit face and a shadowed one.
  //
  // The normal comes from screen-space derivatives of the very same field the contours
  // are cut from, so the shading and the lines can never disagree — and it costs two
  // instructions instead of extra taps.
  vec2 slope = vec2(dFdx(f), dFdy(f)) * uRelief;
  vec3 nrm = normalize(vec3(-slope.x, -slope.y, 1.0));
  // The light swings round very slowly (a full turn takes minutes). Nobody watches it
  // move, but the relief is never lit the same way twice and the room keeps changing
  // without anything "happening".
  float la = uTime * uLightSpin;
  vec3 Ldir = normalize(vec3(cos(la) * 0.62, 0.55 + sin(la) * 0.22, 0.60));
  float diff = clamp(dot(nrm, Ldir), 0.0, 1.0);
  float spec = pow(clamp(reflect(-Ldir, nrm).z, 0.0, 1.0), 26.0);

  // Hypsometric ramp — the colour convention of every printed relief map: dark cold in
  // the hollows, bright cold on the crests. It also means the wall is never flat black
  // between lines, which is what made the first version feel thin.
  float h = clamp(f * 0.5 + 0.5, 0.0, 1.0);
  vec3 ramp = h < 0.5 ? mix(uDeep, uMid, h * 2.0) : mix(uMid, uHigh, (h - 0.5) * 2.0);

  // --- waterline ----------------------------------------------------------------
  // One iso-line promoted to a COASTLINE, with everything above it treated as dry land.
  // This is what turns a field of stripes into readable shapes — islands, straits,
  // lagoons — and it costs one subtraction, because the trail a hand deposits already
  // raises the surface: a swipe literally lifts new land out of the water, which then
  // sinks again as the trail decays.
  //
  // The level itself breathes, so the coast is never the same shape twice.
  float sea = uSeaLevel + uSeaDrift * sin(uTime * uSeaSpeed);
  float above = f - sea;
  float aw = fwidth(above) * 1.2;
  float land = smoothstep(-aw, aw, above);
  float coast = 1.0 - smoothstep(0.0, aw * 3.0, abs(above));

  vec3 surface = mix(ramp, uLand * (0.55 + 0.75 * h), land);
  vec3 c = surface * (uAmbient + uShade * diff);
  c += vec3(0.80, 0.93, 1.00) * spec * uSpec * (0.35 + 0.65 * (1.0 - land));
  c += vec3(0.86, 0.97, 1.00) * coast * uCoast;

  // --- lines on top -------------------------------------------------------------
  // A trail marks itself out by COLOUR, at the same brightness as every other line.
  // The first version drew trail lines about twice as hot as normal ones, which blew the
  // stroke out to white and buried the water it was supposed to be drawn on.
  float tp = min(trail.a * 1.6, 1.0);
  vec3 tint = trail.rgb;
  vec3 colMinor = mix(uCold, tint, tp);
  vec3 colMajor = mix(uHot, mix(uHot, tint, 0.7), tp);

  c += colMinor * minor * 0.50;
  c += colMajor * major * 0.72;
  c += uHot * minor * major * 0.35;
  c += colMinor * exp(-abs(fract(v) - 0.5) * 7.0) * uGlow;
  c += tint * smoothstep(0.08, 0.8, trail.a) * uTrailGlow;

  fragColor = vec4(c, 1.0);
}`;

// ---------------------------------------------------------------- bloom + composite

export const bloomPrefilterFrag = head + /* glsl */`
uniform sampler2D uTexture;
uniform float uThreshold;
void main() {
  vec3 c = texture(uTexture, vUv).rgb;
  float br = max(c.r, max(c.g, c.b));
  fragColor = vec4(c * clamp(br - uThreshold, 0.0, 1.0) / max(br, 1e-4), 1.0);
}`;

export const blurFrag = head + /* glsl */`
uniform sampler2D uTexture;
uniform vec2 uDir;
void main() {
  vec3 c = texture(uTexture, vUv).rgb * 0.2270270270;
  c += texture(uTexture, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(uTexture, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(uTexture, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture(uTexture, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  fragColor = vec4(c, 1.0);
}`;

export const compositeFrag = head + /* glsl */`
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uTime;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uGrain;
uniform float uVignette;
uniform float uBg;

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 c = texture(uScene, vUv).rgb;
  c += texture(uBloom, vUv).rgb * uBloomStrength;
  c += uBg * vec3(0.16, 0.34, 0.62);            // never a dead black rectangle

  c = aces(c * uExposure);

  // Vertical falloff ONLY. A horizontal vignette would draw a dark band down every wall
  // join, and the room is meant to read as one continuous surface.
  float v = smoothstep(0.0, 0.12, vUv.y) * smoothstep(0.0, 0.10, 1.0 - vUv.y);
  c *= mix(1.0, v, uVignette);

  // Dither before the 8-bit NDI pack: the dark field bands visibly across a 10 m
  // projection without it.
  float g = fract(sin(dot(vUv * vec2(1920.0, 1080.0) + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  c += (g - 0.5) * uGrain;

  fragColor = vec4(c, 1.0);
}`;
