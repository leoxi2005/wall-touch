// The interference renderer: wave simulation + trail field + contour pass + bloom.
//
// Three resolutions, each sized for what it actually carries:
//   · wave  — ripples. Needs enough grid to resolve a wavelength (~20 texels), but it
//     is a smooth field, so a fraction of the output is plenty.
//   · trail — the deposited ridge. Even smoother; a quarter of the wave grid is fine.
//   · scene — full output resolution. The contour lines ARE the image; anything less
//     and they alias into dashed noise the moment they get steep.

import { Program, createFBO, createDoubleFBO } from './glutil.js';
import * as S from './shaders.js';

// Must match MAXPTS in the trail splat shader.
const MAX_STAMPS = 16;

export class Waves {
  constructor(gl, blit, opts) {
    this.gl = gl;
    this.blit = blit;
    this.cfg = opts.cfg;
    this.look = opts.look;
    this.aspect = opts.aspect;
    this.width = opts.width;
    this.height = opts.height;

    const simH = Math.max(64, Math.round(this.cfg.simHeight * opts.simScale));
    const simW = Math.round(simH * this.aspect);
    this.simW = simW; this.simH = simH;
    this.wave = createDoubleFBO(gl, simW, simH);

    // Full sim resolution, not a fraction of it. The trail is not the smooth field it
    // looks like: the COASTLINE is cut from it with a hard threshold, so any texel
    // structure in the trail turns into visible stair-steps along the shore of an
    // island a hand just drew. Coral branches (a couple of centimetres wide on the
    // wall) need the resolution too.
    const trH = simH;
    this.trail = createDoubleFBO(gl, Math.round(trH * this.aspect), trH);

    this.scene = createFBO(gl, this.width, this.height, { wrapS: gl.REPEAT });

    const bloomH = Math.max(16, Math.round(this.height / 4));
    this.bloomA = createFBO(gl, Math.round(bloomH * this.aspect), bloomH);
    this.bloomB = createFBO(gl, Math.round(bloomH * this.aspect), bloomH);

    const P = (frag) => new Program(gl, S.baseVert, frag);
    this.pWaveStep = P(S.waveStepFrag);
    this.pWaveSplat = P(S.waveSplatFrag);
    this.pTrailSplat = P(S.trailSplatFrag);
    this.pDecay = P(S.decayFrag);
    this.pContour = P(S.contourFrag);
    this.pPrefilter = P(S.bloomPrefilterFrag);
    this.pBlur = P(S.blurFrag);
    this.pComposite = P(S.compositeFrag);

    this.qPts = new Float32Array(MAX_STAMPS * 4);
    this.qCols = new Float32Array(MAX_STAMPS * 3);
    this.queued = 0;

    this.time = 0;
  }

  get stats() {
    return `wave ${this.simW}x${this.simH}  trail ${this.trail.width}x${this.trail.height}  ` +
           `×${this.cfg.substeps} steps`;
  }

  // A drop on the surface. x, y in [0,1] over the whole panorama (y: 0 = floor).
  impulse(x, y, amp, radiusMul = 1) {
    const r = this.cfg.impulseRadius * radiusMul;
    this.pWaveSplat.use()
      .v2('uTexel', this.wave.texelX, this.wave.texelY)
      .tex('uTarget', this.wave.read, 0)
      .f('uAspect', this.aspect)
      .v2('uPoint', x, y)
      .f('uRadius', r * r)
      .f('uAmp', amp);
    this.blit(this.wave.write);
    this.wave.swap();
  }

  // Terrain deposited under a hand — this is the trail that outlives the touch.
  // Stamps are queued and flushed 16 at a time (see flushDeposits): every flush is a
  // full-screen pass over the trail target, so batching is the difference between one
  // pass and ninety when the coral is growing.
  deposit(x, y, color, amount, radiusMul = 1) {
    if (amount <= 0) return;
    const r = this.cfg.trailRadius * radiusMul;
    const i = this.queued;
    this.qPts[i * 4] = x;
    this.qPts[i * 4 + 1] = y;
    this.qPts[i * 4 + 2] = amount;
    this.qPts[i * 4 + 3] = r * r;
    this.qCols[i * 3] = color[0];
    this.qCols[i * 3 + 1] = color[1];
    this.qCols[i * 3 + 2] = color[2];
    this.queued++;
    if (this.queued === MAX_STAMPS) this.flushDeposits();
  }

  flushDeposits() {
    if (!this.queued) return;
    this.pTrailSplat.use()
      .v2('uTexel', this.trail.texelX, this.trail.texelY)
      .tex('uTarget', this.trail.read, 0)
      .f('uAspect', this.aspect)
      .f('uCap', this.cfg.trailCap)
      .i('uCount', this.queued)
      .v4v('uPts', this.qPts)
      .v3v('uCols', this.qCols);
    this.blit(this.trail.write);
    this.trail.swap();
    this.queued = 0;
  }

  step(dt) {
    // Anything still queued from this frame's hands, coral and bridges must land BEFORE
    // the decay pass, or it would be written on top of an already-decayed buffer and
    // silently lost on the swap.
    this.flushDeposits();
    this.time += dt;
    const c = this.cfg;

    // Sub-stepping rather than a bigger k: the explicit scheme is only stable up to a
    // Courant number of ~0.7 (k ≈ 0.5), so this is the ONLY way to make ripples travel
    // faster without the whole field detonating.
    for (let i = 0; i < c.substeps; i++) {
      this.pWaveStep.use()
        .v2('uTexel', this.wave.texelX, this.wave.texelY)
        .tex('uWave', this.wave.read, 0)
        .f('uK', Math.min(0.48, c.k))
        .f('uDamp', c.damping);
      this.blit(this.wave.write);
      this.wave.swap();
    }

    this.pDecay.use()
      .v2('uTexel', this.trail.texelX, this.trail.texelY)
      .tex('uTexture', this.trail.read, 0)
      .f('uDecay', Math.exp(-dt / Math.max(0.1, c.trailHold)));
    this.blit(this.trail.write);
    this.trail.swap();
  }

  render() {
    const c = this.cfg, L = this.look;

    this.pContour.use()
      .v2('uTexel', 1 / this.width, 1 / this.height)
      .v2('uSimTexel', this.wave.texelX, this.wave.texelY)
      .tex('uWave', this.wave.read, 0)
      .tex('uTrail', this.trail.read, 1)
      .f('uTime', this.time)
      .f('uAspect', this.aspect)
      .f('uContours', c.contours)
      .f('uMajorEvery', c.majorEvery)
      .f('uBaseAmp', c.baseAmp)
      .f('uWaveGain', c.waveGain)
      .f('uTrailGain', c.trailGain)
      .v3('uCold', L.lineCold[0], L.lineCold[1], L.lineCold[2])
      .v3('uHot', L.lineHot[0], L.lineHot[1], L.lineHot[2])
      .f('uGlow', L.lineGlow)
      .f('uTrailGlow', L.trailGlow)
      // Relief must scale with the framebuffer: dFdx is a PER-PIXEL derivative, so the
      // same surface looks progressively flatter as the render gets wider. Multiplying by
      // the height converts it to "per wall-height", and a 0.35-scale preview then shows
      // exactly the relief the 10350×1080 wall will.
      .f('uRelief', L.relief * this.height)
      .f('uAmbient', L.ambient)
      .f('uShade', L.shade)
      .f('uSpec', L.specular)
      .v3('uDeep', L.rampDeep[0], L.rampDeep[1], L.rampDeep[2])
      .v3('uMid', L.rampMid[0], L.rampMid[1], L.rampMid[2])
      .v3('uHigh', L.rampHigh[0], L.rampHigh[1], L.rampHigh[2])
      .f('uSeaLevel', L.seaLevel)
      .f('uSeaDrift', L.seaDrift)
      .f('uSeaSpeed', L.seaSpeed)
      .v3('uLand', L.landColor[0], L.landColor[1], L.landColor[2])
      .f('uCoast', L.coastGlow)
      .f('uFoam', L.foam)
      .f('uCurrent', L.shoreCurrent)
      .f('uCurrentSpeed', L.shoreCurrentSpeed)
      .f('uLightSpin', L.lightSpin);
    this.blit(this.scene);

    this.pPrefilter.use()
      .v2('uTexel', this.bloomA.texelX, this.bloomA.texelY)
      .tex('uTexture', this.scene, 0)
      .f('uThreshold', L.bloomThreshold);
    this.blit(this.bloomA);

    const iters = L.bloomIters ?? 4;
    for (let i = 0; i < iters; i++) {
      const rad = 1 + i * 1.5;
      this.pBlur.use()
        .v2('uTexel', this.bloomA.texelX, this.bloomA.texelY)
        .tex('uTexture', this.bloomA, 0)
        .v2('uDir', this.bloomA.texelX * rad, 0);
      this.blit(this.bloomB);
      this.pBlur.use()
        .tex('uTexture', this.bloomB, 0)
        .v2('uDir', 0, this.bloomA.texelY * rad);
      this.blit(this.bloomA);
    }

    this.pComposite.use()
      .v2('uTexel', 1 / this.width, 1 / this.height)
      .tex('uScene', this.scene, 0)
      .tex('uBloom', this.bloomA, 1)
      .f('uTime', this.time)
      .f('uExposure', L.exposure)
      .f('uBloomStrength', L.bloomStrength)
      .f('uGrain', L.grain)
      .f('uVignette', L.vignette)
      .f('uBg', L.backgroundLevel);
    this.blit(null);
  }

  clear() {
    const gl = this.gl;
    for (const t of [this.wave.read, this.wave.write, this.trail.read, this.trail.write]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
