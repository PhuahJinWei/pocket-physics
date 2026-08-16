// WebGL renderer. Prefers a WebGL2 context but every shader is ES 1.00, so a
// WebGL1 fallback is identical in output.
//
// Both materials are drawn as a *field* rather than as particles: each pass
// accumulates soft blobs into an offscreen buffer and a full-screen composite
// turns that field into a surface. Water needs it because a liquid has no
// visible particles; sand needs it because the physics grain is ten times the
// size of a grain of sand, and drawing it as anything at all makes gravel. Sand
// then adds a pass of tiny speck particles on top for the grain texture. See
// src/shaders.js for the reasoning.

import { CONFIG } from './config.js';
// One line: tools/bundle.py resolves imports by matching single-line statements.
import { SAND_FIELD_VERTEX, SAND_FIELD_FRAGMENT, SAND_COMPOSITE_VERTEX, SAND_COMPOSITE_FRAGMENT, SPECK_VERTEX, SPECK_FRAGMENT, WALL_VERTEX_SHADER, WALL_FRAGMENT_SHADER } from './shaders.js';
import { WATER_FIELD_VERTEX, WATER_FIELD_FRAGMENT, WATER_COMPOSITE_VERTEX, WATER_COMPOSITE_FRAGMENT } from './water-shaders.js';
import { makeRandom } from './util.js';

const FLOATS_PER_GRAIN = 8; // x,y,z | light, speed, loose | sizeJitter, airborne
const STRIDE = FLOATS_PER_GRAIN * 4;
const FLOATS_PER_SPECK = 9; // x,y,z | light, tone, size, phase | speed, airborne
const SPECK_STRIDE = FLOATS_PER_SPECK * 4;
const FLOATS_PER_DROP = 5; // x, y, z, speed, weight
const DROP_STRIDE = FLOATS_PER_DROP * 4;

// Speck layouts are drawn from a fixed table rather than hashed per frame:
// SPECK_SEEDS layouts of speckMax specks each, indexed by a per-grain random.
// Plenty of variety, and the pack loop stays a handful of multiplies per speck.
const SPECK_SEEDS = 256;
const SPECK_FIELDS = 5; // ox, oy, tone, size, phase

export class Renderer {
  /**
   * @param {boolean} preserve Keep the drawing buffer after presentation. Off
   *   by default (it costs a copy on some drivers); on it makes screenshots and
   *   canvas.toDataURL() reliable instead of returning whatever survived the
   *   last buffer swap.
   */
  constructor(canvas, capacity, preserve = false) {
    this.canvas = canvas;
    this.capacity = capacity;
    this.cpu = new Float32Array(capacity * FLOATS_PER_GRAIN);
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    // Parallax offset for the projection eye, in CSS px; set from the tilt.
    this.eyeX = 0;
    this.eyeY = 0;
    this.t0 = performance.now();
    // 5 quads (four interior walls + back plane), 6 vertices each, xyz + shade.
    this.wallData = new Float32Array(5 * 6 * 4);
    this.wallKey = '';
    this.contextLost = false;

    // Speck buffer grows on demand: count depends on grain size.
    this.speckCpu = new Float32Array(0);
    this.speckTable = buildSpeckTable();
    this.specksPerGrain = 0;
    this.speckCount = 0;

    // Offscreen field shared by both materials, at reduced size.
    this.fieldTex = null;
    this.fieldFbo = null;
    this.fieldW = 0;
    this.fieldH = 0;

    // Water pass: its own interleaved buffer. Sized at 3x the particle count
    // to leave room for the wall images packWater adds; a particle in a corner
    // can contribute three of them.
    this.waterCpu = new Float32Array(CONFIG.fluid.maxParticles * 3 * FLOATS_PER_DROP);
    this.waterGhosts = 0;

    const opts = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: preserve,
    };
    this.gl = canvas.getContext('webgl2', opts);
    this.isWebGL2 = !!this.gl;
    if (!this.gl) this.gl = canvas.getContext('webgl', opts);
    if (!this.gl) throw new Error('WebGL is not available in this browser.');

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.initGL();
      this.contextLost = false;
    });

    this.initGL();
  }

  get backend() {
    return this.isWebGL2 ? 'webgl2' : 'webgl1';
  }

  initGL() {
    const gl = this.gl;

    // Wall program: its own tiny pipeline, sharing the projection maths.
    this.wallProgram = buildProgram(gl, WALL_VERTEX_SHADER, WALL_FRAGMENT_SHADER);
    this.wallAttrib = {
      pos: gl.getAttribLocation(this.wallProgram, 'aPos'),
      shade: gl.getAttribLocation(this.wallProgram, 'aShade'),
    };
    this.wallUniform = {
      viewport: gl.getUniformLocation(this.wallProgram, 'uViewport'),
      focal: gl.getUniformLocation(this.wallProgram, 'uFocal'),
      eye: gl.getUniformLocation(this.wallProgram, 'uEye'),
      color: gl.getUniformLocation(this.wallProgram, 'uWallColor'),
    };
    this.wallBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.wallBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.wallData.byteLength, gl.DYNAMIC_DRAW);
    this.wallKey = '';

    // One oversized triangle rather than a quad for the composites: same
    // coverage, no seam down the diagonal, one fewer vertex.
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const bg = CONFIG.render.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);

    this.fieldTex = null;
    this.fieldFbo = null;
    this.fieldW = 0;
    this.fieldH = 0;

    this.setupSandPrograms();
    this.setupWaterPrograms();
  }

  setupSandPrograms() {
    const gl = this.gl;

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.cpu.byteLength, gl.DYNAMIC_DRAW);

    this.sandFieldProgram = buildProgram(gl, SAND_FIELD_VERTEX, SAND_FIELD_FRAGMENT);
    this.sandFieldAttrib = {
      pos: gl.getAttribLocation(this.sandFieldProgram, 'aPos'),
      shade: gl.getAttribLocation(this.sandFieldProgram, 'aShade'),
      jitter: gl.getAttribLocation(this.sandFieldProgram, 'aJitter'),
    };
    this.sandFieldUniform = uniforms(gl, this.sandFieldProgram, [
      'uViewport', 'uFocal', 'uEye', 'uPointSize', 'uDepthRange',
      'uLooseShrink', 'uBlob', 'uThreshold', 'uBulkSize', 'uSoloSize', 'uAirPow', 'uAirLight',
    ]);

    this.sandCompositeProgram = buildProgram(gl, SAND_COMPOSITE_VERTEX, SAND_COMPOSITE_FRAGMENT);
    this.sandCompositeAttrib = { corner: gl.getAttribLocation(this.sandCompositeProgram, 'aCorner') };
    this.sandCompositeUniform = uniforms(gl, this.sandCompositeProgram, [
      'uField', 'uTexel', 'uDpr', 'uDeep', 'uMid', 'uLit', 'uSurface', 'uSoft', 'uDither', 'uDitherPx',
      'uRelief', 'uForm', 'uFormRadius', 'uEdgeRadius', 'uEdgeSmooth',
      'uPale', 'uPatchScale', 'uPatchAmp', 'uFog', 'uDepthDim', 'uFogStart',
    ]);

    this.speckBuffer = gl.createBuffer();
    this.speckBufferBytes = 0;
    this.speckProgram = buildProgram(gl, SPECK_VERTEX, SPECK_FRAGMENT);
    this.speckAttrib = {
      pos: gl.getAttribLocation(this.speckProgram, 'aPos'),
      data: gl.getAttribLocation(this.speckProgram, 'aData'),
      motion: gl.getAttribLocation(this.speckProgram, 'aMotion'),
    };
    this.speckUniform = uniforms(gl, this.speckProgram, [
      'uViewport', 'uFocal', 'uEye', 'uPointSize', 'uDepthRange',
      'uDeep', 'uMid', 'uLit', 'uAlpha', 'uDepthFade', 'uFog', 'uDepthDim', 'uFogStart',
      'uSpeckRelief', 'uSpeckRound', 'uGlint', 'uGlintRate', 'uTime',
      'uField', 'uInvCanvas', 'uSurface', 'uAirLight',
    ]);
  }

  setupWaterPrograms() {
    const gl = this.gl;

    this.fieldProgram = buildProgram(gl, WATER_FIELD_VERTEX, WATER_FIELD_FRAGMENT);
    this.fieldAttrib = {
      pos: gl.getAttribLocation(this.fieldProgram, 'aPos'),
      speed: gl.getAttribLocation(this.fieldProgram, 'aSpeed'),
      weight: gl.getAttribLocation(this.fieldProgram, 'aWeight'),
    };
    this.fieldUniform = {
      viewport: gl.getUniformLocation(this.fieldProgram, 'uViewport'),
      focal: gl.getUniformLocation(this.fieldProgram, 'uFocal'),
      eye: gl.getUniformLocation(this.fieldProgram, 'uEye'),
      pointSize: gl.getUniformLocation(this.fieldProgram, 'uPointSize'),
      depthRange: gl.getUniformLocation(this.fieldProgram, 'uDepthRange'),
      gain: gl.getUniformLocation(this.fieldProgram, 'uGain'),
    };
    this.waterBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.waterBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.waterCpu.byteLength, gl.DYNAMIC_DRAW);

    this.compositeProgram = buildProgram(gl, WATER_COMPOSITE_VERTEX, WATER_COMPOSITE_FRAGMENT);
    this.compositeAttrib = { corner: gl.getAttribLocation(this.compositeProgram, 'aCorner') };
    this.compositeUniform = {
      field: gl.getUniformLocation(this.compositeProgram, 'uField'),
      texel: gl.getUniformLocation(this.compositeProgram, 'uTexel'),
      shallow: gl.getUniformLocation(this.compositeProgram, 'uShallow'),
      deep: gl.getUniformLocation(this.compositeProgram, 'uDeep'),
      foamColor: gl.getUniformLocation(this.compositeProgram, 'uFoamColor'),
      surface: gl.getUniformLocation(this.compositeProgram, 'uSurface'),
      soft: gl.getUniformLocation(this.compositeProgram, 'uSoft'),
      absorb: gl.getUniformLocation(this.compositeProgram, 'uAbsorb'),
      relief: gl.getUniformLocation(this.compositeProgram, 'uRelief'),
      specular: gl.getUniformLocation(this.compositeProgram, 'uSpecular'),
      fresnel: gl.getUniformLocation(this.compositeProgram, 'uFresnel'),
      foamAmount: gl.getUniformLocation(this.compositeProgram, 'uFoamAmount'),
      foamBias: gl.getUniformLocation(this.compositeProgram, 'uFoamBias'),
      alphaMin: gl.getUniformLocation(this.compositeProgram, 'uAlphaMin'),
      opacify: gl.getUniformLocation(this.compositeProgram, 'uOpacify'),
      calmRipple: gl.getUniformLocation(this.compositeProgram, 'uCalmRipple'),
      rippleGain: gl.getUniformLocation(this.compositeProgram, 'uRippleGain'),
    };
  }

  /** Offscreen buffer the fields accumulate into, at reduced size. */
  ensureField(deviceW, deviceH, scale) {
    const w = Math.max(1, Math.round(deviceW * scale));
    const h = Math.max(1, Math.round(deviceH * scale));
    if (w === this.fieldW && h === this.fieldH && this.fieldTex) return;
    const gl = this.gl;

    if (this.fieldTex) gl.deleteTexture(this.fieldTex);
    if (this.fieldFbo) gl.deleteFramebuffer(this.fieldFbo);

    this.fieldW = w;
    this.fieldH = h;
    this.fieldTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // Linear sampling is doing real work here: it is the second half of the
    // blur that turns discrete blobs into a continuous surface.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.fieldFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fieldTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Box interior: four walls running from the viewport edge (z=0) back to an
   * inset rectangle (z=depth), plus the back plane. Shaded by facing — the
   * floor catches the light, the ceiling is in shadow — and darkened toward the
   * back so each wall carries a recession gradient of its own.
   */
  buildWalls(w, h, depth) {
    const key = `${w}|${h}|${depth}`;
    if (key === this.wallKey) return;
    this.wallKey = key;

    const L = CONFIG.render.wallShade;
    const back = CONFIG.render.wallBackFalloff;
    const d = this.wallData;
    let o = 0;
    // Each quad: front-left, front-right, back-right, back-left (in its plane).
    const quad = (ax, ay, bx, by, shade) => {
      const f = shade;
      const b = shade * back;
      const v = [
        ax, ay, 0, f,
        bx, by, 0, f,
        bx, by, depth, b,
        ax, ay, 0, f,
        bx, by, depth, b,
        ax, ay, depth, b,
      ];
      for (let i = 0; i < v.length; i++) d[o++] = v[i];
    };

    quad(0, 0, w, 0, L.ceiling);   // top
    quad(w, 0, w, h, L.right);     // right
    quad(w, h, 0, h, L.floor);     // bottom
    quad(0, h, 0, 0, L.left);      // left
    // Back plane, flat at z = depth.
    const bp = L.back * back;
    const v = [
      0, 0, depth, bp,
      w, 0, depth, bp,
      w, h, depth, bp,
      0, 0, depth, bp,
      w, h, depth, bp,
      0, h, depth, bp,
    ];
    for (let i = 0; i < v.length; i++) d[o++] = v[i];

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.wallBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d);
  }

  drawWalls(depth, focal, eyeX, eyeY) {
    const gl = this.gl;
    this.buildWalls(this.width, this.height, depth);

    gl.useProgram(this.wallProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.wallBuffer);
    gl.enableVertexAttribArray(this.wallAttrib.pos);
    gl.enableVertexAttribArray(this.wallAttrib.shade);
    gl.vertexAttribPointer(this.wallAttrib.pos, 3, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(this.wallAttrib.shade, 1, gl.FLOAT, false, 16, 12);

    gl.uniform2f(this.wallUniform.viewport, this.width, this.height);
    gl.uniform1f(this.wallUniform.focal, focal);
    gl.uniform2f(this.wallUniform.eye, this.width * 0.5 + eyeX, this.height * 0.5 + eyeY);
    gl.uniform3fv(this.wallUniform.color, CONFIG.render.wallColor);
    gl.drawArrays(gl.TRIANGLES, 0, 30);

    // Leave nothing enabled behind us. Attribute arrays are global state in
    // WebGL1, so a location left on from one program points a later program's
    // draw at a stale buffer.
    gl.disableVertexAttribArray(this.wallAttrib.pos);
    gl.disableVertexAttribArray(this.wallAttrib.shade);
  }

  /** Returns true when the backing store changed size. */
  resize(cssWidth, cssHeight) {
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.render.maxDpr);
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    this.width = cssWidth;
    this.height = cssHeight;
    this.dpr = dpr;
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
    return true;
  }

  /**
   * One entry point for every material. The box is shared; what fills it is
   * not, so each material owns its own passes from here down.
   */
  draw(material) {
    const gl = this.gl;
    if (this.contextLost) return;

    gl.clear(gl.COLOR_BUFFER_BIT);
    const focal = CONFIG.render.focal * Math.min(this.width, this.height);
    // Box first: the contents always live inside it, so no depth test is needed.
    this.drawWalls(material.depth, focal, this.eyeX, this.eyeY);

    if (material.n === 0) return;
    if (material.kind === 'water') this.drawWater(material, focal);
    else this.drawSand(material, focal);
  }

  // ------------------------------------------------------------------ sand

  /**
   * Grain data for the field pass, in sim order — the sum does not care.
   *
   * `loose` and `airborne` are both here and mean different things to the
   * shader: looseness narrows the blob (so a barely attached grain cannot be
   * bridged into a drip), while only a genuinely isolated grain gets the peak
   * that lets it clear the threshold alone. hueJitter never reaches the GPU —
   * the speck pass reads it straight from the sim.
   */
  packGrains(sand) {
    const cpu = this.cpu;
    const n = Math.min(sand.n, this.capacity);
    const { x, y, z, light, speed01, loose, airborne, sizeJitter } = sand;
    for (let i = 0; i < n; i++) {
      const o = i * FLOATS_PER_GRAIN;
      cpu[o] = x[i];
      cpu[o + 1] = y[i];
      cpu[o + 2] = z[i];
      cpu[o + 3] = light[i];
      cpu[o + 4] = speed01[i];
      cpu[o + 5] = loose[i];
      cpu[o + 6] = sizeJitter[i];
      cpu[o + 7] = airborne[i];
    }
    return n;
  }

  /**
   * Specks per grain follows from grain size: each grain's own specks should
   * cover a fixed fraction of its projected disc, so a coarse grain (big
   * screen, or a coarsened tuner) carries more of them and the sand keeps the
   * same fineness on screen.
   */
  speckCountFor(radius) {
    const s = CONFIG.sand;
    const speckArea = (s.speckPx * 0.5) ** 2;
    const want = s.speckCoverage * (radius * radius) / Math.max(speckArea, 1e-3);
    return Math.max(1, Math.min(s.speckMax, Math.round(want)));
  }

  /**
   * Scatter each grain's specks around it. Offsets live in sim space (CSS px,
   * pre-projection) so perspective carries them with the grain exactly; the
   * layout for a grain comes from the table row picked by its own random.
   */
  packSpecks(sand) {
    const s = CONFIG.sand;
    const n = Math.min(sand.n, this.capacity);
    const per = this.speckCountFor(sand.radius);
    this.specksPerGrain = per;
    // Sand in flight is drawn by its specks alone, so it gets more of them —
    // a splash wants to read as spray, and a handful of specks spread over a
    // whole grain is a puff rather than a scatter of grains. Only genuinely
    // airborne grains pay for it, and there are a few dozen of those against
    // thousands in the bed, so the extra costs nothing measurable.
    const perAir = Math.min(s.speckMax, Math.round(per * s.speckAirMul));
    const cap = n * per + Math.min(n, 512) * (perAir - per);
    if (this.speckCpu.length < cap * FLOATS_PER_SPECK) {
      this.speckCpu = new Float32Array(Math.ceil(cap * FLOATS_PER_SPECK * 1.5));
    }
    const limit = (this.speckCpu.length / FLOATS_PER_SPECK) | 0;
    const cpu = this.speckCpu;
    const table = this.speckTable;
    const spread = s.speckSpread;
    const airSpread = s.speckAirSpread;
    const airSize = s.speckAirSize;
    const { x, y, z, light, speed01, airborne, rad, hueJitter } = sand;
    let o = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const yi = y[i];
      const zi = z[i];
      const li = light[i];
      const si = speed01[i];
      const ai = airborne[i];
      // Inside the mass the specks only have to texture a surface, so they sit
      // well within the grain. A grain in flight is drawn BY its specks, so
      // they spread to its true size — the clump has to be as big as the sand
      // it stands for or a splash turns into dust.
      const reach = rad[i] * (spread + (airSpread - spread) * ai);
      const size = 1 + (airSize - 1) * ai;
      const flying = ai > 0.02;
      const cnt = flying ? perAir : per;
      if (count + cnt > limit) break;
      let t = ((hueJitter[i] * SPECK_SEEDS) | 0) * (s.speckMax * SPECK_FIELDS);
      for (let k = 0; k < cnt; k++) {
        // The specks past the bed's own count fade in with `airborne` instead
        // of appearing the instant a grain loses its last contact — a jump in
        // COUNT cannot be blended, but a size of zero draws nothing.
        const extra = k < per ? 1 : Math.min(1, ai * 4);
        cpu[o] = xi + table[t] * reach;
        cpu[o + 1] = yi + table[t + 1] * reach;
        cpu[o + 2] = zi;
        cpu[o + 3] = li;
        cpu[o + 4] = table[t + 2];
        cpu[o + 5] = table[t + 3] * size * extra;
        cpu[o + 6] = table[t + 4];
        cpu[o + 7] = si;
        cpu[o + 8] = ai;
        o += FLOATS_PER_SPECK;
        t += SPECK_FIELDS;
        count++;
      }
    }
    this.speckCount = count;
    return count;
  }

  drawSand(sand, focal) {
    const gl = this.gl;
    const s = CONFIG.sand;
    const r = CONFIG.render;
    const deviceW = this.canvas.width;
    const deviceH = this.canvas.height;
    const eyeX = this.width * 0.5 + this.eyeX;
    const eyeY = this.height * 0.5 + this.eyeY;
    this.ensureField(deviceW, deviceH, s.fieldScale);

    // ---- pass 1: coverage field, offscreen, additive
    const n = this.packGrains(sand);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFbo);
    gl.viewport(0, 0, this.fieldW, this.fieldH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(this.sandFieldProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const floats = n * FLOATS_PER_GRAIN;
    if (this.isWebGL2) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cpu, 0, floats);
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cpu.subarray(0, floats));
    }
    const fa = this.sandFieldAttrib;
    gl.enableVertexAttribArray(fa.pos);
    gl.enableVertexAttribArray(fa.shade);
    gl.enableVertexAttribArray(fa.jitter);
    gl.vertexAttribPointer(fa.pos, 3, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribPointer(fa.shade, 3, gl.FLOAT, false, STRIDE, 12);
    gl.vertexAttribPointer(fa.jitter, 2, gl.FLOAT, false, STRIDE, 24);

    const fu = this.sandFieldUniform;
    gl.uniform2f(fu.uViewport, this.width, this.height);
    gl.uniform1f(fu.uFocal, focal);
    gl.uniform2f(fu.uEye, eyeX, eyeY);
    // Blob diameter in field pixels: carries the device ratio and the field's
    // own downscale.
    gl.uniform1f(fu.uPointSize, sand.diameter * s.blob * this.dpr * s.fieldScale);
    gl.uniform1f(fu.uDepthRange, sand.depth);
    gl.uniform1f(fu.uLooseShrink, s.looseShrink);
    gl.uniform1f(fu.uBlob, s.blob);
    // Worst case of the dithered threshold, so a grain clears it wherever the
    // noise happens to land rather than flickering along with it.
    gl.uniform1f(fu.uThreshold, s.surface + s.dither * 0.5);
    gl.uniform1f(fu.uBulkSize, s.bulkSize);
    gl.uniform1f(fu.uSoloSize, s.soloSize);
    gl.uniform1f(fu.uAirPow, s.airPow);
    gl.uniform1f(fu.uAirLight, s.airLight);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.disableVertexAttribArray(fa.pos);
    gl.disableVertexAttribArray(fa.shade);
    gl.disableVertexAttribArray(fa.jitter);

    // ---- pass 2: the mass, composited over the box
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, deviceW, deviceH);
    const bg = r.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.sandCompositeProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.sandCompositeAttrib.corner);
    gl.vertexAttribPointer(this.sandCompositeAttrib.corner, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    const cu = this.sandCompositeUniform;
    gl.uniform1i(cu.uField, 0);
    gl.uniform2f(cu.uTexel, 1 / this.fieldW, 1 / this.fieldH);
    gl.uniform1f(cu.uDpr, this.dpr);
    gl.uniform3fv(cu.uDeep, r.deep);
    gl.uniform3fv(cu.uMid, r.mid);
    gl.uniform3fv(cu.uLit, r.lit);
    gl.uniform1f(cu.uSurface, s.surface);
    gl.uniform1f(cu.uSoft, s.soft);
    gl.uniform1f(cu.uDither, s.dither);
    gl.uniform1f(cu.uDitherPx, s.ditherPx);
    gl.uniform1f(cu.uRelief, s.relief);
    gl.uniform1f(cu.uForm, s.form);
    gl.uniform1f(cu.uPale, s.pale);
    gl.uniform1f(cu.uPatchScale, s.patchScale);
    gl.uniform1f(cu.uPatchAmp, s.patchAmp);
    gl.uniform1f(cu.uFormRadius, s.formRadius);
    gl.uniform1f(cu.uEdgeRadius, s.edgeRadius);
    gl.uniform1f(cu.uEdgeSmooth, s.edgeSmooth);
    gl.uniform3fv(cu.uFog, r.fog);
    gl.uniform1f(cu.uDepthDim, r.depthDim);
    gl.uniform1f(cu.uFogStart, r.fogStart);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(this.sandCompositeAttrib.corner);

    // ---- pass 3: specks — the grain of the sand
    const total = this.packSpecks(sand);
    if (total === 0) return;
    gl.useProgram(this.speckProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.speckBuffer);
    const bytes = total * SPECK_STRIDE;
    if (bytes > this.speckBufferBytes) {
      this.speckBufferBytes = Math.ceil(bytes * 1.5);
      gl.bufferData(gl.ARRAY_BUFFER, this.speckBufferBytes, gl.DYNAMIC_DRAW);
    }
    const sfloats = total * FLOATS_PER_SPECK;
    if (this.isWebGL2) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.speckCpu, 0, sfloats);
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.speckCpu.subarray(0, sfloats));
    }
    const sa = this.speckAttrib;
    gl.enableVertexAttribArray(sa.pos);
    gl.enableVertexAttribArray(sa.data);
    gl.enableVertexAttribArray(sa.motion);
    gl.vertexAttribPointer(sa.pos, 3, gl.FLOAT, false, SPECK_STRIDE, 0);
    gl.vertexAttribPointer(sa.data, 4, gl.FLOAT, false, SPECK_STRIDE, 12);
    gl.vertexAttribPointer(sa.motion, 2, gl.FLOAT, false, SPECK_STRIDE, 28);

    const su = this.speckUniform;
    gl.uniform2f(su.uViewport, this.width, this.height);
    gl.uniform1f(su.uFocal, focal);
    gl.uniform2f(su.uEye, eyeX, eyeY);
    gl.uniform1f(su.uPointSize, s.speckPx * this.dpr);
    gl.uniform1f(su.uDepthRange, sand.depth);
    gl.uniform3fv(su.uDeep, r.deep);
    gl.uniform3fv(su.uMid, r.mid);
    gl.uniform3fv(su.uLit, r.lit);
    gl.uniform1f(su.uAlpha, s.speckAlpha);
    gl.uniform1f(su.uDepthFade, s.speckDepthFade);
    gl.uniform3fv(su.uFog, r.fog);
    gl.uniform1f(su.uDepthDim, r.depthDim);
    gl.uniform1f(su.uFogStart, r.fogStart);
    gl.uniform1f(su.uSpeckRelief, s.speckRelief);
    gl.uniform1f(su.uSpeckRound, s.speckRound);
    gl.uniform1f(su.uGlint, s.glintStrength);
    gl.uniform1f(su.uGlintRate, s.glintRate);
    gl.uniform1f(su.uTime, (performance.now() - this.t0) * 0.001);
    // The field is still bound to unit 0 from the composite.
    gl.uniform1i(su.uField, 0);
    gl.uniform2f(su.uInvCanvas, 1 / deviceW, 1 / deviceH);
    gl.uniform1f(su.uSurface, s.surface);
    gl.uniform1f(su.uAirLight, s.airLight);
    gl.drawArrays(gl.POINTS, 0, total);
    gl.disableVertexAttribArray(sa.pos);
    gl.disableVertexAttribArray(sa.data);
    gl.disableVertexAttribArray(sa.motion);
  }

  // ----------------------------------------------------------------- water

  /**
   * Pack the water into the field buffer, mirroring anything close to the
   * glass back across it.
   *
   * Without this the water visibly shrinks away from its container: a blob
   * reaching past the wall spends half its mass outside the box, so the
   * thickness field sags to roughly half strength within one blob radius of
   * every wall, drops under the surface threshold, and the level set retreats.
   * The result reads as a slab of jelly sitting in the middle of the tank
   * rather than water filling it — pale margins down both sides and rounded-off
   * corners.
   *
   * It is the same half-space truncation the solver hits (see Fluid.solveDensity),
   * on a different field, and it takes the same answer: method of images. A
   * mirrored particle contributes exactly what the water on the far side would
   * have, so the gradient across the wall goes to zero and the field stays flat
   * right up to the glass. Reflecting in *sim* space rather than screen space
   * means perspective carries the ghosts to the right place on its own — which
   * matters here, because the box walls converge with depth and are not a fixed
   * line on screen.
   *
   * Only the four lateral walls get ghosts. Depth needs none: thickness is the
   * count of particles along a view ray, and that ray genuinely does end at the
   * front and back glass — nothing is missing to add back.
   *
   * Each image is weighted by how buried the particle it mirrors is, which is
   * what stops the correction overreaching. An image asserts "there is matching
   * water on the far side of this wall" — true for bulk filling the tank, false
   * for the thin film left clinging to the glass after a wave drains down it.
   * Applied flat it thickened near-wall water by 1.8x and drew those films as
   * solid rounded pillars standing against the glass, which is not something
   * water does.
   *
   * The weight is raw neighbour count, deliberately not density. Density cannot
   * tell the two apart and never will: an incompressible solver drives it to
   * rest density *everywhere* it can, and measured, film and bulk-at-wall both
   * sit at about 1.1. Neighbour count is geometry rather than a solved
   * quantity, and it separates them cleanly — median 14 in a film against 26
   * for bulk against the same wall.
   */
  packWater(fluid, w) {
    const cpu = this.waterCpu;
    const limit = (cpu.length / FLOATS_PER_DROP) | 0;
    const n = Math.min(fluid.n, CONFIG.fluid.maxParticles);
    const { x, y, z, speed01, nbrCount } = fluid;
    const wallX = fluid.bounds.x1;
    const wallY = fluid.bounds.y1;
    // A ghost only matters while its blob still overlaps the box.
    const reach = fluid.diameter * w.blobSize * 0.5;
    const floor = CONFIG.water.imageFloor;
    const lo = CONFIG.water.imageBuriedLo;
    const span = Math.max(1, CONFIG.water.imageBuriedHi - lo);

    let count = 0;
    const put = (px, py, pz, sp, weight) => {
      if (count >= limit) return;
      const o = count * FLOATS_PER_DROP;
      cpu[o] = px;
      cpu[o + 1] = py;
      cpu[o + 2] = pz;
      cpu[o + 3] = sp;
      cpu[o + 4] = weight;
      count++;
    };

    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const yi = y[i];
      const zi = z[i];
      const si = speed01[i];
      put(xi, yi, zi, si, 1);

      const left = xi < reach;
      const right = wallX - xi < reach;
      const above = yi < reach;
      const below = wallY - yi < reach;
      if (!left && !right && !above && !below) continue;

      // How much of an image this particle has earned.
      let solid = nbrCount ? (nbrCount[i] - lo) / span : 1;
      if (solid > 1) solid = 1;
      else if (solid < floor) solid = floor;

      const mx = left ? -xi : 2 * wallX - xi;
      const my = above ? -yi : 2 * wallY - yi;
      if (left || right) put(mx, yi, zi, si, solid);
      if (above || below) put(xi, my, zi, si, solid);
      // Corners lose a quadrant, not just a half-space, so they need the
      // diagonal image too or they stay pinched.
      if ((left || right) && (above || below)) put(mx, my, zi, si, solid);
    }
    this.waterGhosts = count - n;
    return count;
  }

  drawWater(fluid, focal) {
    const gl = this.gl;
    const w = CONFIG.water;
    const deviceW = this.canvas.width;
    const deviceH = this.canvas.height;
    this.ensureField(deviceW, deviceH, w.fieldScale);

    const n = this.packWater(fluid, w);
    const cpu = this.waterCpu;

    // ---- pass 1: accumulate thickness offscreen
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFbo);
    gl.viewport(0, 0, this.fieldW, this.fieldH);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(this.fieldProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.waterBuffer);
    const floats = n * FLOATS_PER_DROP;
    if (this.isWebGL2) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, cpu, 0, floats);
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, cpu.subarray(0, floats));
    }
    gl.enableVertexAttribArray(this.fieldAttrib.pos);
    gl.enableVertexAttribArray(this.fieldAttrib.speed);
    gl.enableVertexAttribArray(this.fieldAttrib.weight);
    gl.vertexAttribPointer(this.fieldAttrib.pos, 3, gl.FLOAT, false, DROP_STRIDE, 0);
    gl.vertexAttribPointer(this.fieldAttrib.speed, 1, gl.FLOAT, false, DROP_STRIDE, 12);
    gl.vertexAttribPointer(this.fieldAttrib.weight, 1, gl.FLOAT, false, DROP_STRIDE, 16);

    gl.uniform2f(this.fieldUniform.viewport, this.width, this.height);
    gl.uniform1f(this.fieldUniform.focal, focal);
    gl.uniform2f(this.fieldUniform.eye, this.width * 0.5 + this.eyeX, this.height * 0.5 + this.eyeY);
    gl.uniform1f(this.fieldUniform.depthRange, fluid.depth);
    gl.uniform1f(this.fieldUniform.gain, w.gain);
    // Sprite size is in field pixels, so it carries both the device ratio and
    // the field's own downscale.
    gl.uniform1f(
      this.fieldUniform.pointSize,
      fluid.diameter * w.blobSize * this.dpr * w.fieldScale,
    );
    gl.drawArrays(gl.POINTS, 0, n);
    gl.disableVertexAttribArray(this.fieldAttrib.pos);
    gl.disableVertexAttribArray(this.fieldAttrib.speed);
    gl.disableVertexAttribArray(this.fieldAttrib.weight);

    // ---- pass 2: shade the field as a surface, over the box
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, deviceW, deviceH);
    const bg = CONFIG.render.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.compositeProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.compositeAttrib.corner);
    gl.vertexAttribPointer(this.compositeAttrib.corner, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.uniform1i(this.compositeUniform.field, 0);
    gl.uniform2f(this.compositeUniform.texel, 1 / this.fieldW, 1 / this.fieldH);
    gl.uniform3fv(this.compositeUniform.shallow, w.shallow);
    gl.uniform3fv(this.compositeUniform.deep, w.deep);
    gl.uniform3fv(this.compositeUniform.foamColor, w.foam);
    gl.uniform1f(this.compositeUniform.surface, w.surface);
    gl.uniform1f(this.compositeUniform.soft, w.soft);
    gl.uniform1f(this.compositeUniform.absorb, w.absorb);
    gl.uniform1f(this.compositeUniform.relief, w.relief);
    gl.uniform1f(this.compositeUniform.specular, w.specular);
    gl.uniform1f(this.compositeUniform.fresnel, w.fresnel);
    gl.uniform1f(this.compositeUniform.foamAmount, w.foamAmount);
    gl.uniform1f(this.compositeUniform.foamBias, w.foamBias);
    gl.uniform1f(this.compositeUniform.alphaMin, w.alphaMin);
    gl.uniform1f(this.compositeUniform.opacify, w.opacify);
    gl.uniform1f(this.compositeUniform.calmRipple, w.calmRipple);
    gl.uniform1f(this.compositeUniform.rippleGain, w.rippleGain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(this.compositeAttrib.corner);
  }
}

/**
 * The speck layout table: SPECK_SEEDS rows of speckMax specks, each with an
 * offset inside the unit disc, a tone (mineral class), a size ratio and a
 * glint phase. Deterministic, so a reload lays the same specks on the same
 * grains.
 */
function buildSpeckTable() {
  const s = CONFIG.sand;
  const rand = makeRandom(0x5eed);
  const table = new Float32Array(SPECK_SEEDS * s.speckMax * SPECK_FIELDS);
  let o = 0;
  for (let row = 0; row < SPECK_SEEDS; row++) {
    for (let k = 0; k < s.speckMax; k++) {
      // Uniform over the disc.
      const a = rand() * Math.PI * 2;
      const rr = Math.sqrt(rand());
      table[o] = Math.cos(a) * rr;
      table[o + 1] = Math.sin(a) * rr;
      const h = rand();
      let tone;
      if (h < s.speckDark) tone = s.speckDarkTone;
      else if (h > 1 - s.speckBright) tone = s.speckBrightTone;
      else tone = 1 - s.speckVary + 2 * s.speckVary * rand();
      table[o + 2] = tone;
      table[o + 3] = 0.75 + 0.5 * rand();
      table[o + 4] = rand();
      o += SPECK_FIELDS;
    }
  }
  return table;
}

function uniforms(gl, program, names) {
  const out = {};
  for (const name of names) out[name] = gl.getUniformLocation(program, name);
  return out;
}

function buildProgram(gl, vsSource, fsSource) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('Shader link failed: ' + gl.getProgramInfoLog(program));
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(shader));
  }
  return shader;
}
