// WebGL point-sprite renderer: one interleaved buffer, one draw call for the
// sand plus a tiny one for the box. Prefers a WebGL2 context but the shaders
// are ES 1.00 so a WebGL1 fallback is identical in output.
//
// Grains are packed back-to-front (a 32-bucket counting sort on z), so nearer
// grains paint over deeper ones and no depth buffer is needed — point sprites
// with blending and a depth buffer fight over the alpha edges anyway.

import { CONFIG } from './config.js';
import { VERTEX_SHADER, buildFragmentShader, WALL_VERTEX_SHADER, WALL_FRAGMENT_SHADER } from './shaders.js';
import { WATER_FIELD_VERTEX, WATER_FIELD_FRAGMENT, WATER_COMPOSITE_VERTEX, WATER_COMPOSITE_FRAGMENT } from './water-shaders.js';

const FLOATS_PER_GRAIN = 8; // x,y,z | light, speed, airborne | sizeJitter, hueJitter
const STRIDE = FLOATS_PER_GRAIN * 4;
const FLOATS_PER_DROP = 5; // x, y, z, speed, weight
const DROP_STRIDE = FLOATS_PER_DROP * 4;
const BUCKETS = 32;

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
    this.bucketOf = new Uint8Array(capacity);
    this.drawOrder = new Int32Array(capacity);
    this.bucketStart = new Int32Array(BUCKETS + 1);
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
    // Speck styling, derived from the on-screen sprite size (see
    // ensureGrainStyle). The program is rebuilt when the count changes.
    this.speckCount = 0;
    this.speckRadius = 0.28;
    this._styleKey = '';
    this.contextLost = false;

    // Water pass: its own interleaved buffer, and the offscreen thickness field
    // it accumulates into. No z-sort here — the field is built with additive
    // blending, which does not care what order the particles arrive in.
    //
    // Sized at 3x the particle count to leave room for the wall images packWater
    // adds; a particle in a corner can contribute three of them.
    this.waterCpu = new Float32Array(CONFIG.fluid.maxParticles * 3 * FLOATS_PER_DROP);
    this.waterGhosts = 0;
    this.fieldTex = null;
    this.fieldFbo = null;
    this.fieldW = 0;
    this.fieldH = 0;

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

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.cpu.byteLength, gl.DYNAMIC_DRAW);

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

    const bg = CONFIG.render.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);

    this.setupWaterPrograms();

    // Grain program is built lazily by ensureGrainStyle on the first draw,
    // because the speck count depends on the sprite's on-screen size.
    this.program = null;
    this.speckCount = 0;
    this._styleKey = '';
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
    // One oversized triangle rather than a quad: same coverage, no seam down
    // the diagonal, one fewer vertex.
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.fieldTex = null;
    this.fieldFbo = null;
    this.fieldW = 0;
    this.fieldH = 0;
  }

  /** Offscreen buffer the thickness field accumulates into, at reduced size. */
  ensureField(deviceW, deviceH) {
    const scale = CONFIG.water.fieldScale;
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
   * Keep the *on-screen* speck size constant. The physics grain radius scales
   * with the short edge of the viewport (and is clamped), so on a wide screen
   * each grain sprite can be twice the phone's size — with a fixed speck count
   * and ratio the sand turned coarse exactly where there was most room to see
   * it. Instead the speck radius targets `speckPx` CSS pixels and the count
   * grows to keep the same covered fraction, so a big sprite gets many small
   * specks rather than a few big ones. The count is a compile-time constant in
   * ES 1.00, so changing it means relinking the grain program — rare (layout
   * and tuner changes only) and cheap.
   */
  ensureGrainStyle(diameter) {
    const r = CONFIG.render;
    const clusterPx = Math.max(diameter * r.clusterSize, 4);
    const key = clusterPx.toFixed(2);
    if (key === this._styleKey && this.program) return;
    this._styleKey = key;

    // uSpeck is in sprite units: a speck's on-screen diameter is
    // uSpeck * clusterPx.
    this.speckRadius = Math.min(0.42, Math.max(0.12, r.speckPx / clusterPx));
    const count = Math.round(Math.min(40, Math.max(6,
      r.speckCoverage / (this.speckRadius * this.speckRadius))));
    if (count !== this.speckCount || !this.program) {
      this.speckCount = count;
      this.setupGrainProgram();
    }
  }

  setupGrainProgram() {
    const gl = this.gl;
    if (this.program) gl.deleteProgram(this.program);
    this.program = buildProgram(gl, VERTEX_SHADER, buildFragmentShader(this.speckCount));
    gl.useProgram(this.program);

    this.attrib = {
      pos: gl.getAttribLocation(this.program, 'aPos'),
      shade: gl.getAttribLocation(this.program, 'aShade'),
      jitter: gl.getAttribLocation(this.program, 'aJitter'),
    };
    this.uniform = {
      viewport: gl.getUniformLocation(this.program, 'uViewport'),
      pointSize: gl.getUniformLocation(this.program, 'uPointSize'),
      airShrink: gl.getUniformLocation(this.program, 'uAirShrink'),
      focal: gl.getUniformLocation(this.program, 'uFocal'),
      eye: gl.getUniformLocation(this.program, 'uEye'),
      depthRange: gl.getUniformLocation(this.program, 'uDepthRange'),
      depthDim: gl.getUniformLocation(this.program, 'uDepthDim'),
      deep: gl.getUniformLocation(this.program, 'uDeep'),
      mid: gl.getUniformLocation(this.program, 'uMid'),
      lit: gl.getUniformLocation(this.program, 'uLit'),
      patchScale: gl.getUniformLocation(this.program, 'uPatchScale'),
      patchAmp: gl.getUniformLocation(this.program, 'uPatchAmp'),
      spread: gl.getUniformLocation(this.program, 'uSpread'),
      speck: gl.getUniformLocation(this.program, 'uSpeck'),
      airSpeck: gl.getUniformLocation(this.program, 'uAirSpeck'),
      vary: gl.getUniformLocation(this.program, 'uVary'),
      glint: gl.getUniformLocation(this.program, 'uGlint'),
      glintRate: gl.getUniformLocation(this.program, 'uGlintRate'),
      time: gl.getUniformLocation(this.program, 'uTime'),
    };

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const loc of Object.values(this.attrib)) {
      if (loc >= 0) gl.enableVertexAttribArray(loc);
    }
    gl.vertexAttribPointer(this.attrib.pos, 3, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribPointer(this.attrib.shade, 3, gl.FLOAT, false, STRIDE, 12);
    gl.vertexAttribPointer(this.attrib.jitter, 2, gl.FLOAT, false, STRIDE, 24);

    const r = CONFIG.render;
    gl.uniform1f(this.uniform.spread, r.speckSpread);
    gl.uniform1f(this.uniform.vary, r.speckVariation);
    gl.uniform1f(this.uniform.patchScale, r.patchScale);
    gl.uniform1f(this.uniform.patchAmp, r.patchAmp);
    gl.uniform1f(this.uniform.glint, r.glintStrength);
    gl.uniform1f(this.uniform.glintRate, r.glintRate);
    gl.uniform1f(this.uniform.airShrink, r.airShrink);
    gl.uniform3fv(this.uniform.deep, r.deep);
    gl.uniform3fv(this.uniform.mid, r.mid);
    gl.uniform3fv(this.uniform.lit, r.lit);
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
   * not, so each material owns its own pass from here down.
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
    else this.drawGrains(material, focal);
  }

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
    this.ensureField(deviceW, deviceH);

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
      fluid.diameter * w.blobSize * this.dpr * CONFIG.water.fieldScale,
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

  drawGrains(sand, focal) {
    const gl = this.gl;
    this.ensureGrainStyle(sand.diameter);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const loc of Object.values(this.attrib)) {
      if (loc >= 0) gl.enableVertexAttribArray(loc);
    }
    gl.vertexAttribPointer(this.attrib.pos, 3, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribPointer(this.attrib.shade, 3, gl.FLOAT, false, STRIDE, 12);
    gl.vertexAttribPointer(this.attrib.jitter, 2, gl.FLOAT, false, STRIDE, 24);

    const n = sand.n;

    // Counting sort by z bucket, deepest first, so the pack order is
    // back-to-front for the grain pass.
    const { bucketOf, drawOrder, bucketStart } = this;
    const zScale = BUCKETS / Math.max(sand.depth, 1e-3);
    const zArr = sand.z;
    bucketStart.fill(0);
    for (let i = 0; i < n; i++) {
      let b = (zArr[i] * zScale) | 0;
      if (b < 0) b = 0; else if (b >= BUCKETS) b = BUCKETS - 1;
      bucketOf[i] = b;
      bucketStart[b + 1]++;
    }
    // Prefix from the deep end: bucket 31 packs first.
    let acc = 0;
    for (let b = BUCKETS - 1; b >= 0; b--) {
      const c = bucketStart[b + 1];
      bucketStart[b + 1] = acc;
      acc += c;
    }
    // bucketStart[b+1] now holds the running start for bucket b; place items.
    for (let i = 0; i < n; i++) drawOrder[bucketStart[bucketOf[i] + 1]++] = i;

    const cpu = this.cpu;
    const { x, y, light, speed01, airborne, sizeJitter, hueJitter } = sand;
    for (let k = 0; k < n; k++) {
      const i = drawOrder[k];
      const o = k * FLOATS_PER_GRAIN;
      cpu[o] = x[i];
      cpu[o + 1] = y[i];
      cpu[o + 2] = zArr[i];
      cpu[o + 3] = light[i];
      cpu[o + 4] = speed01[i];
      cpu[o + 5] = airborne[i];
      cpu[o + 6] = sizeJitter[i];
      cpu[o + 7] = hueJitter[i];
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const floats = n * FLOATS_PER_GRAIN;
    if (this.isWebGL2) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, cpu, 0, floats);
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, cpu.subarray(0, floats));
    }

    const px = sand.diameter * this.dpr;
    gl.uniform2f(this.uniform.viewport, this.width, this.height);
    gl.uniform1f(this.uniform.time, (performance.now() - this.t0) * 0.001);
    gl.uniform1f(this.uniform.speck, this.speckRadius);
    // An isolated grain draws as one speck the size of the grain itself. The
    // sprite is clusterSize x the grain, and the alpha falloff makes the solid
    // core about 1.6x the speck radius, so this lands the visible speck on the
    // true grain diameter whatever the screen.
    gl.uniform1f(this.uniform.airSpeck, 0.5 / (CONFIG.render.clusterSize * 1.6));
    gl.uniform1f(this.uniform.focal, focal);
    gl.uniform2f(this.uniform.eye, this.width * 0.5 + this.eyeX, this.height * 0.5 + this.eyeY);
    gl.uniform1f(this.uniform.depthRange, sand.depth);
    gl.uniform1f(this.uniform.depthDim, CONFIG.render.depthDim);

    // Single grain pass, back-to-front. No additive halo: real sand does not
    // glow, and the crevices between specks are supposed to be dark.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(this.uniform.pointSize, px * CONFIG.render.clusterSize);
    gl.drawArrays(gl.POINTS, 0, n);
  }
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
