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
import { SAND_FIELD_VERTEX, SAND_FIELD_FRAGMENT, SAND_COMPOSITE_VERTEX, SAND_COMPOSITE_FRAGMENT, SPECK_VERTEX, SPECK_FRAGMENT, MARBLE_VERTEX, MARBLE_FRAGMENT, WALL_VERTEX_SHADER, WALL_FRAGMENT_SHADER } from './shaders.js';
import { WATER_FIELD_VERTEX, WATER_FIELD_FRAGMENT, WATER_COMPOSITE_VERTEX, WATER_COMPOSITE_FRAGMENT } from './water-shaders.js';
import { makeRandom } from './util.js';

const FLOATS_PER_GRAIN = 8; // x,y,z | light, speed, loose | sizeJitter, airborne
const STRIDE = FLOATS_PER_GRAIN * 4;
const FLOATS_PER_SPECK = 9; // x,y,z | light, tone, size, phase | speed, airborne
const SPECK_STRIDE = FLOATS_PER_SPECK * 4;
const FLOATS_PER_DROP = 5; // x, y, z, speed, weight
const FLOATS_PER_MARBLE = 11; // x, y, z | sizeJitter, hue, speed, light | quat xyzw
const MARBLE_STRIDE = FLOATS_PER_MARBLE * 4;
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
    // World up in screen space, mirrored from the gravity input each frame so
    // a metal's reflected horizon can stay anchored to the room while the box
    // turns. Straight up until the first frame sets it.
    this.tiltUp = [0, 1];
    // How far face-up (+) or face-down (-) the device is held.
    this.tiltPitch = 0;

    // Adaptive quality, mirrored from the tuner each frame. Only the speck
    // pass reads it — see speckCountFor.
    this.quality = 1;
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

    // Liquid pass: its own interleaved buffer. Sized at 3x the particle count
    // to leave room for the wall images packWater adds; a particle in a corner
    // can contribute three of them.
    this.waterCpu = new Float32Array(CONFIG.fluid.maxParticles * 3 * FLOATS_PER_DROP);

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

    // Half-float for the thickness field where the hardware renders to it.
    //
    // The field divides each blob by how much box its pixel's ray crosses, and
    // 8 bits cannot hold both ends of that. Near a wall the divisor is small,
    // so the near-wall band ran off the top: measured, the last 16px at every
    // wall clipped flat at 255 while the interior sat at 186. A clipped band
    // has no gradient, so its normal dies and it shades as a flat strip with a
    // hard edge — the "lines" down the sides of the water. Scaling the whole
    // field down to make room only trades that for the other end: the surface
    // threshold lands at 0.055, which is 3 levels once there is real headroom,
    // and the level set stair-steps. Half-float has room for both.
    this.floatField = this.isWebGL2 && !!this.gl.getExtension('EXT_color_buffer_float');

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
    // Scratch for the lifted wall colour, so the per-frame multiply does not
    // allocate and CONFIG.render.wallColor is never written through.
    this._wallRgb = new Float32Array(3);
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
      'uLooseShrink', 'uBlob', 'uThreshold', 'uBulkSize', 'uAloneSize', 'uSoloSize',
      'uAirPow', 'uAirLight',
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

    this.marbleBuffer = gl.createBuffer();
    this.marbleBufferBytes = 0;
    this.marbleProgram = buildProgram(gl, MARBLE_VERTEX, MARBLE_FRAGMENT);
    this.marbleAttrib = {
      pos: gl.getAttribLocation(this.marbleProgram, 'aPos'),
      data: gl.getAttribLocation(this.marbleProgram, 'aData'),
      spin: gl.getAttribLocation(this.marbleProgram, 'aSpin'),
    };
    this.marbleUniform = uniforms(gl, this.marbleProgram, [
      'uViewport', 'uFocal', 'uEye', 'uPointSize', 'uDepthRange', 'uMaxPoint',
      'uIor', 'uInterior', 'uSky', 'uGround', 'uUp', 'uPitch', 'uEnvSharp',
      'uLampAt', 'uLampWidth', 'uLampGain', 'uSaturation', 'uBodyTint', 'uCoreGain', 'uCore', 'uCoreSoft',
      'uVane', 'uVaneWidth', 'uVaneTint', 'uSpecular', 'uSpecPower', 'uBurial',
      'uFog', 'uDepthDim', 'uFogStart',
    ]);
    // How big a point this driver will actually rasterise. A marble sprite is
    // an order of magnitude wider than a speck, and the guaranteed minimum in
    // the spec is 1px — so this is read rather than assumed, and the shader
    // clamps to it.
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    this.maxPointSize = (range && range[1]) || 64;
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
      // So each blob can be clipped to the box as it stands at its own depth,
      // and divided by how much box its pixel's ray crosses.
      box: gl.getUniformLocation(this.fieldProgram, 'uBox'),
      fieldSize: gl.getUniformLocation(this.fieldProgram, 'uFieldSize'),
      radius: gl.getUniformLocation(this.fieldProgram, 'uRadius'),
      origin: gl.getUniformLocation(this.fieldProgram, 'uOrigin'),
      rayFloor: gl.getUniformLocation(this.fieldProgram, 'uRayFloor'),
      clipReal: gl.getUniformLocation(this.fieldProgram, 'uClipReal'),
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
      specPower: gl.getUniformLocation(this.compositeProgram, 'uSpecPower'),
      metal: gl.getUniformLocation(this.compositeProgram, 'uMetal'),
      fresnel: gl.getUniformLocation(this.compositeProgram, 'uFresnel'),
      foamAmount: gl.getUniformLocation(this.compositeProgram, 'uFoamAmount'),
      foamBias: gl.getUniformLocation(this.compositeProgram, 'uFoamBias'),
      alphaMin: gl.getUniformLocation(this.compositeProgram, 'uAlphaMin'),
      opacify: gl.getUniformLocation(this.compositeProgram, 'uOpacify'),
      calmRipple: gl.getUniformLocation(this.compositeProgram, 'uCalmRipple'),
      rippleGain: gl.getUniformLocation(this.compositeProgram, 'uRippleGain'),
      // The reflected room, for metals.
      up: gl.getUniformLocation(this.compositeProgram, 'uUp'),
      pitch: gl.getUniformLocation(this.compositeProgram, 'uPitch'),
      envSharp: gl.getUniformLocation(this.compositeProgram, 'uEnvSharp'),
      horizon: gl.getUniformLocation(this.compositeProgram, 'uHorizon'),
      lampAt: gl.getUniformLocation(this.compositeProgram, 'uLampAt'),
      lampWidth: gl.getUniformLocation(this.compositeProgram, 'uLampWidth'),
      lampGain: gl.getUniformLocation(this.compositeProgram, 'uLampGain'),
      // Where the screen sits inside the padded field, and the field's css span.
      viewport: gl.getUniformLocation(this.compositeProgram, 'uViewport'),
      fieldOrigin: gl.getUniformLocation(this.compositeProgram, 'uFieldOrigin'),
      fieldSpan: gl.getUniformLocation(this.compositeProgram, 'uFieldSpan'),
      // The box, and how wide a strip along each wall it must not shade.
      box: gl.getUniformLocation(this.compositeProgram, 'uBox'),
      guard: gl.getUniformLocation(this.compositeProgram, 'uGuard'),
    };
  }

  /**
   * Offscreen buffer the fields accumulate into, at reduced size, optionally
   * padded by `margin` device px on every side.
   *
   * The margin exists for one reason: GL discards a point sprite whose CENTRE
   * falls outside the viewport, whole, no matter how far its size would reach
   * back in (GLES 2 §2.13, and every driver honours it). The liquid pass mirrors
   * particles across the glass to fix kernel truncation there, and a particle
   * against the front glass mirrors to a centre a few px past the screen edge
   * — which is exactly the image that has to cover the edge, and exactly the
   * one that used to vanish. Measured, the field was 0 for the first 8px in
   * from the wall and half strength to 40px, and no amount of tuning could
   * reach pixels nothing was drawn on. Padding the viewport by the blob radius
   * keeps those centres inside it.
   */
  ensureField(deviceW, deviceH, scale, margin = 0) {
    const w = Math.max(1, Math.round((deviceW + 2 * margin) * scale));
    const h = Math.max(1, Math.round((deviceH + 2 * margin) * scale));
    if (w === this.fieldW && h === this.fieldH && this.fieldTex) return;
    const gl = this.gl;

    if (this.fieldTex) gl.deleteTexture(this.fieldTex);
    if (this.fieldFbo) gl.deleteFramebuffer(this.fieldFbo);

    this.fieldW = w;
    this.fieldH = h;
    this.fieldTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    if (this.floatField) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    // Linear sampling is doing real work here: it is the second half of the
    // blur that turns discrete blobs into a continuous surface.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.fieldFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fieldTex, 0);
    // The extension says half-float is renderable; drivers get the final word,
    // so ask, and fall back to 8 bits rather than drawing to a dead target.
    if (this.floatField
      && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.floatField = false;
      gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fieldTex, 0);
    }
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
    const wc = CONFIG.render.wallColor;
    const lift = CONFIG.render.wallLift;
    this._wallRgb[0] = wc[0] * lift;
    this._wallRgb[1] = wc[1] * lift;
    this._wallRgb[2] = wc[2] * lift;
    gl.uniform3fv(this.wallUniform.color, this._wallRgb);
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
    // Switch on the pass a material asks for, not on which material it is:
    // every liquid takes the same one and differs only in its `look`.
    if (material.render === 'fluid') this.drawFluid(material, focal);
    else if (material.render === 'marbles') this.drawMarbles(material, focal);
    else this.drawSand(material, focal);
  }

  // --------------------------------------------------------------- marbles

  /**
   * Marbles, packed FAR TO NEAR.
   *
   * This is the one pass that has to sort. Everything else in the app either
   * accumulates additively (the fields, where order cannot matter) or draws a
   * single full-screen triangle. Marbles are discrete alpha-blended sprites
   * that genuinely overlap, and the context is created with `depth: false` —
   * there is no depth buffer to sort them for us, and adding one would cost a
   * buffer for the sake of a couple of hundred sprites. Sorting an index array
   * is cheaper and exact: painter's algorithm, back of the box first.
   *
   * Insertion sort, because the order is almost always already correct — the
   * marbles moved a few pixels since last frame — and it is linear on nearly
   * sorted input where a comparison sort is not.
   */
  packMarbles(m) {
    const n = Math.min(m.n, this.capacity);
    const need = n * FLOATS_PER_MARBLE * 4;
    if (this.marbleCpu === undefined || this.marbleCpu.length < n * FLOATS_PER_MARBLE) {
      this.marbleCpu = new Float32Array(n * FLOATS_PER_MARBLE + 256 * FLOATS_PER_MARBLE);
    }
    if (this.marbleOrder === undefined || this.marbleOrder.length < n) {
      this.marbleOrder = new Int32Array(n + 256);
      this.marbleOrderCount = 0;
    }
    const order = this.marbleOrder;
    // Rebuild the index list if the count changed, then re-sort by depth.
    if (this.marbleOrderCount !== n) {
      for (let i = 0; i < n; i++) order[i] = i;
      this.marbleOrderCount = n;
    }
    const z = m.z;
    for (let a = 1; a < n; a++) {
      const v = order[a];
      const key = z[v];
      let b = a - 1;
      while (b >= 0 && z[order[b]] < key) { order[b + 1] = order[b]; b--; }
      order[b + 1] = v;
    }

    const cpu = this.marbleCpu;
    const { x, y, sizeJitter, hueJitter, speed01, light, qx, qy, qz, qw } = m;
    let o = 0;
    for (let a = 0; a < n; a++) {
      const i = order[a];
      cpu[o] = x[i];
      cpu[o + 1] = y[i];
      cpu[o + 2] = z[i];
      cpu[o + 3] = sizeJitter[i];
      cpu[o + 4] = hueJitter[i];
      cpu[o + 5] = speed01[i];
      // How lit this body is where it sits — the solver already derives it from
      // how buried the body is, and a pile without it reads as flat stickers.
      cpu[o + 6] = light[i];
      // Orientation, which is the entire reason the roll is visible: without a
      // mark that turns with the body a rolling sphere and a sliding one draw
      // the same pixels.
      cpu[o + 7] = qx[i];
      cpu[o + 8] = qy[i];
      cpu[o + 9] = qz[i];
      cpu[o + 10] = qw[i];
      o += FLOATS_PER_MARBLE;
    }
    return n;
  }

  drawMarbles(marbles, focal) {
    const gl = this.gl;
    const s = marbles.look || CONFIG.marbleLook;
    const n = this.packMarbles(marbles);
    if (n === 0) return;

    // Straight alpha, drawn far to near: these are solid objects that hide
    // each other, not light being added together like the fields.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.marbleProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.marbleBuffer);
    const bytes = n * MARBLE_STRIDE;
    if (bytes > this.marbleBufferBytes) {
      gl.bufferData(gl.ARRAY_BUFFER, this.marbleCpu.byteLength, gl.DYNAMIC_DRAW);
      this.marbleBufferBytes = this.marbleCpu.byteLength;
    }
    if (this.isWebGL2) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.marbleCpu, 0, n * FLOATS_PER_MARBLE);
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.marbleCpu.subarray(0, n * FLOATS_PER_MARBLE));
    }
    const ma = this.marbleAttrib;
    gl.enableVertexAttribArray(ma.pos);
    gl.vertexAttribPointer(ma.pos, 3, gl.FLOAT, false, MARBLE_STRIDE, 0);
    gl.enableVertexAttribArray(ma.data);
    gl.vertexAttribPointer(ma.data, 4, gl.FLOAT, false, MARBLE_STRIDE, 12);
    gl.enableVertexAttribArray(ma.spin);
    gl.vertexAttribPointer(ma.spin, 4, gl.FLOAT, false, MARBLE_STRIDE, 28);

    const mu = this.marbleUniform;
    const r = CONFIG.render;
    gl.uniform2f(mu.uViewport, this.width, this.height);
    gl.uniform1f(mu.uFocal, focal);
    gl.uniform2f(mu.uEye, this.width * 0.5 + this.eyeX, this.height * 0.5 + this.eyeY);
    gl.uniform1f(mu.uPointSize, marbles.diameter * this.dpr);
    gl.uniform1f(mu.uDepthRange, marbles.depth);
    gl.uniform1f(mu.uMaxPoint, this.maxPointSize);
    gl.uniform1f(mu.uIor, s.ior);
    gl.uniform3fv(mu.uInterior, s.interior);
    gl.uniform3fv(mu.uSky, s.sky);
    gl.uniform3fv(mu.uGround, s.ground);
    gl.uniform2f(mu.uUp, this.tiltUp[0], this.tiltUp[1]);
    gl.uniform1f(mu.uPitch, this.tiltPitch * s.pitchGain);
    gl.uniform1f(mu.uEnvSharp, s.envSharp);
    gl.uniform1f(mu.uLampAt, s.lampAt);
    gl.uniform1f(mu.uLampWidth, s.lampWidth);
    gl.uniform1f(mu.uLampGain, s.lampGain);
    gl.uniform1f(mu.uSaturation, s.saturation);
    gl.uniform1f(mu.uBodyTint, s.bodyTint);
    gl.uniform1f(mu.uCoreGain, s.coreGain);
    gl.uniform1f(mu.uCore, s.core);
    gl.uniform1f(mu.uCoreSoft, s.coreSoft);
    gl.uniform1f(mu.uVane, s.vane);
    gl.uniform1f(mu.uVaneWidth, s.vaneWidth);
    gl.uniform1f(mu.uVaneTint, s.vaneTint);
    gl.uniform1f(mu.uSpecular, s.specular);
    gl.uniform1f(mu.uSpecPower, s.specPower);
    gl.uniform1f(mu.uBurial, s.burial);
    gl.uniform3fv(mu.uFog, r.fog);
    gl.uniform1f(mu.uDepthDim, r.depthDim);
    gl.uniform1f(mu.uFogStart, r.fogStart);

    gl.drawArrays(gl.POINTS, 0, n);
    gl.disableVertexAttribArray(ma.pos);
    gl.disableVertexAttribArray(ma.data);
    gl.disableVertexAttribArray(ma.spin);
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
   *
   * That leaves the *total* independent of grain size — it works out at
   * screen area over speck area, which is the right answer for something that
   * tiles a surface, but it also means the tuner's usual lever does nothing
   * here: coarsening grains cuts their count and raises the specks per grain
   * by exactly as much. So quality scales the coverage directly. It is the
   * one part of the look that thins out on a struggling device, and it is the
   * right one to give up — fewer specks read as slightly smoother sand, where
   * fewer grains read as less sand.
   */
  speckCountFor(radius, look = CONFIG.sand) {
    const s = look;
    const speckArea = (s.speckPx * 0.5) ** 2;
    const coverage = s.speckCoverage * Math.min(1, Math.max(s.speckMinQuality, this.quality));
    const want = coverage * (radius * radius) / Math.max(speckArea, 1e-3);
    // The speck table is built once, with CONFIG.sand.speckMax rows per seed, so
    // a material asking for more than that would index past the end of it.
    return Math.max(1, Math.min(s.speckMax, CONFIG.sand.speckMax, Math.round(want)));
  }

  /**
   * Scatter each grain's specks around it. Offsets live in sim space (CSS px,
   * pre-projection) so perspective carries them with the grain exactly; the
   * layout for a grain comes from the table row picked by its own random.
   */
  packSpecks(sand) {
    const s = sand.look || CONFIG.sand;
    const n = Math.min(sand.n, this.capacity);
    const per = this.speckCountFor(sand.radius, s);
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
    // The material's own palette. Every granular material takes this same pass;
    // what separates them is this object and the solver tuning beside it.
    const s = sand.look || CONFIG.sand;
    const r = CONFIG.render;
    // deep/mid/lit have always lived in CONFIG.render, which made the bed's
    // colour a property of the renderer rather than of what is in the box. A
    // look may now carry its own; one that does not falls through to the
    // original, so sand is untouched.
    const pal = s.deep ? s : r;
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
    gl.uniform1f(fu.uAloneSize, s.aloneSize);
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
    gl.uniform3fv(cu.uDeep, pal.deep);
    gl.uniform3fv(cu.uMid, pal.mid);
    gl.uniform3fv(cu.uLit, pal.lit);
    gl.uniform1f(cu.uSurface, s.surface);
    gl.uniform1f(cu.uSoft, s.soft);
    gl.uniform1f(cu.uDither, s.dither);
    gl.uniform1f(cu.uDitherPx, s.ditherPx);
    gl.uniform1f(cu.uRelief, s.relief);
    gl.uniform1f(cu.uForm, s.form);
    gl.uniform1f(cu.uPale, s.pale);
    gl.uniform1f(cu.uPatchScale, s.patchScale);
    gl.uniform1f(cu.uPatchAmp, s.patchAmp);
    // Both of these are distances, and the distance that matters is measured
    // in GRAINS, not in pixels. Set in field texels they came out at 0.7 and
    // 0.3 grain diameters — the form gradient was sampling *within* a grain,
    // so it embossed individual grains into the mass as clumps, which is the
    // opposite of what it is for, and the silhouette low-pass was too narrow
    // to touch the grain-scale lumps it exists to remove. Both were wrong by a
    // different factor on every viewport and device ratio, which is exactly
    // what a screen-space unit buys you here.
    const grainInField = sand.diameter * this.dpr * s.fieldScale;
    gl.uniform1f(cu.uFormRadius, s.formGrains * grainInField);
    gl.uniform1f(cu.uEdgeRadius, s.edgeGrains * grainInField);
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
    gl.uniform3fv(su.uDeep, pal.deep);
    gl.uniform3fv(su.uMid, pal.mid);
    gl.uniform3fv(su.uLit, pal.lit);
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
   * Pack the liquid into the field buffer, mirroring anything close to the
   * glass back across it.
   *
   * The thickness field sags next to every wall for two separate reasons, and
   * this is the answer to the first one. A blob reaching past the wall spends
   * part of its mass outside the box, so within one blob radius of the glass
   * the field is only half as strong as it is in the open — the same half-space
   * truncation the solver hits (see Fluid.solveDensity), and it takes the same
   * answer: method of images. A mirrored particle contributes exactly what
   * liquid on the far side would have, so the field stays flat right up to the
   * wall. Reflecting in sim space and letting perspective project the image is
   * the same as reflecting on screen about that layer's own projected wall —
   * provably, since projection is affine per depth — so the images are correct
   * per layer for free.
   *
   * The second reason is perspective itself: near a wall a view ray leaves the
   * box early and crosses less liquid, so the field is genuinely thinner there.
   * That is WATER_COMPOSITE_FRAGMENT's job — it divides each pixel by how much
   * box its ray crosses — and images must NOT try to fill it. They used to,
   * because nothing stopped a back-layer image from landing on pixels whose
   * rays had left the box before ever reaching that layer. Measured, that piled
   * a lip along the top of the liquid at each wall and, with the liquid sitting
   * at the back, dropped floor images into plain view as detached grey blobs.
   * WATER_FIELD_FRAGMENT now clips every blob, real or image, to the box as it
   * stands at that particle's depth. With that in place an image can only ever
   * add back what truncation took away, which is all it was ever for.
   *
   * Only the four lateral walls get images. Depth needs none: thickness is the
   * count of particles along a view ray, and that ray genuinely does end at the
   * front and back glass — nothing is missing to add back.
   *
   * Images are full strength, always. They used to be scaled by the neighbour
   * count of the particle they mirror, to keep a thin film draining down the
   * glass from being drawn as a solid pillar; that pillar was really the
   * unclipped spill above, and the clip is what fixes it. The weighting could
   * not stay anyway: neighbour count is cut by the free surface and the front
   * glass as well as by the wall, so a particle at the top corner of a full
   * pool reads like a film and got a fifth of an image — and the top corner is
   * the one place a missing image shows, as a sag that no wall-only correction
   * of the count could recover. Measured: with the weighting honey sagged 14px
   * into each corner and mercury 35px beyond its own meniscus.
   */
  packWater(fluid, w) {
    const cpu = this.waterCpu;
    const limit = (cpu.length / FLOATS_PER_DROP) | 0;
    const n = Math.min(fluid.n, fluid.capacity);
    const { x, y, z, speed01 } = fluid;
    const wallX = fluid.bounds.x1;
    const wallY = fluid.bounds.y1;
    // An image only matters while its blob still overlaps the box.
    const reach = fluid.diameter * w.blobSize * 0.5;

    let count = 0;
    // The sign of the weight is the flag the field shader clips on: real
    // particles pass through, images get cut to the box at their own depth.
    const put = (px, py, pz, sp, real) => {
      if (count >= limit) return;
      const o = count * FLOATS_PER_DROP;
      cpu[o] = px;
      cpu[o + 1] = py;
      cpu[o + 2] = pz;
      cpu[o + 3] = sp;
      cpu[o + 4] = real ? 1 : -1;
      count++;
    };

    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const yi = y[i];
      const zi = z[i];
      const si = speed01[i];
      put(xi, yi, zi, si, true);

      const left = xi < reach;
      const right = wallX - xi < reach;
      const above = yi < reach;
      const below = wallY - yi < reach;
      if (!left && !right && !above && !below) continue;

      const mx = left ? -xi : 2 * wallX - xi;
      const my = above ? -yi : 2 * wallY - yi;
      if (left || right) put(mx, yi, zi, si, false);
      if (above || below) put(xi, my, zi, si, false);
      // Corners lose a quadrant, not just a half-space, so they need the
      // diagonal image too or they stay pinched.
      if ((left || right) && (above || below)) put(mx, my, zi, si, false);
    }
    return count;
  }

  drawFluid(fluid, focal) {
    const gl = this.gl;
    // The liquid's own palette, not water's — this pass draws honey too.
    const w = fluid.look;
    const deviceW = this.canvas.width;
    const deviceH = this.canvas.height;
    // Padded by one blob radius so wall images centred just past the glass
    // still rasterise — see ensureField. `reach` in packWater is the same
    // number, so every image it emits has its centre inside this viewport.
    const marginCss = fluid.diameter * w.blobSize * 0.5;
    this.ensureField(deviceW, deviceH, w.fieldScale, marginCss * this.dpr);
    const padW = this.width + 2 * marginCss;
    const padH = this.height + 2 * marginCss;

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

    // The field's own frame is the screen plus its margin: everything the
    // shader projects gets shifted by the margin and mapped over the padded
    // size, so screen (0,0) sits `marginCss` in from the buffer's corner.
    gl.uniform2f(this.fieldUniform.viewport, padW, padH);
    gl.uniform2f(this.fieldUniform.origin, marginCss, marginCss);
    gl.uniform1f(this.fieldUniform.focal, focal);
    gl.uniform2f(this.fieldUniform.eye, this.width * 0.5 + this.eyeX, this.height * 0.5 + this.eyeY);
    gl.uniform1f(this.fieldUniform.depthRange, fluid.depth);
    gl.uniform1f(this.fieldUniform.gain, w.gain);
    gl.uniform2f(this.fieldUniform.box, fluid.bounds.x1, fluid.bounds.y1);
    gl.uniform2f(this.fieldUniform.fieldSize, this.fieldW, this.fieldH);
    gl.uniform1f(this.fieldUniform.radius, fluid.radius);
    gl.uniform1f(this.fieldUniform.rayFloor, CONFIG.render.rayFloor);
    gl.uniform1f(this.fieldUniform.clipReal, CONFIG.render.clipReal ? 1 : 0);
    // Sprite size is in field pixels, so it carries both the device ratio and
    // the field's own downscale.
    gl.uniform1f(
      this.fieldUniform.pointSize,
      fluid.diameter * w.blobSize * this.dpr * w.fieldScale,
    );
    // The field is shared with the sand pass and sized on whoever drew last.
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
    gl.uniform1f(this.compositeUniform.specPower, w.specPower);
    gl.uniform1f(this.compositeUniform.metal, w.metal || 0);
    gl.uniform1f(this.compositeUniform.fresnel, w.fresnel);
    gl.uniform1f(this.compositeUniform.foamAmount, w.foamAmount);
    gl.uniform1f(this.compositeUniform.foamBias, w.foamBias);
    gl.uniform1f(this.compositeUniform.alphaMin, w.alphaMin);
    gl.uniform1f(this.compositeUniform.opacify, w.opacify);
    gl.uniform1f(this.compositeUniform.calmRipple, w.calmRipple);
    gl.uniform1f(this.compositeUniform.rippleGain, w.rippleGain);
    // World up in screen space, from the gravity the box is being tilted with.
    // Gravity points down the screen in sim axes, and this pass has +y running
    // UP, so the y term keeps its sign and x flips. Falls back to straight up
    // before the first frame has set a tilt.
    gl.uniform2f(this.compositeUniform.up, this.tiltUp[0], this.tiltUp[1]);
    // How far the device is tipped face-up or face-down, which is what aims a
    // flat mirror at the ceiling or the floor.
    gl.uniform1f(this.compositeUniform.pitch, this.tiltPitch * (w.pitchGain || 0));
    gl.uniform1f(this.compositeUniform.envSharp, w.envSharp || 0);
    gl.uniform1f(this.compositeUniform.horizon, w.horizon || 1);
    gl.uniform1f(this.compositeUniform.lampAt, w.lampAt || 0);
    gl.uniform1f(this.compositeUniform.lampWidth, w.lampWidth || 1);
    gl.uniform1f(this.compositeUniform.lampGain, w.lampGain || 0);
    // Where the screen sits inside the padded field the first pass just drew.
    gl.uniform2f(this.compositeUniform.viewport, this.width, this.height);
    gl.uniform2f(this.compositeUniform.fieldOrigin, marginCss, marginCss);
    gl.uniform2f(this.compositeUniform.fieldSpan, padW, padH);
    gl.uniform2f(this.compositeUniform.box, fluid.bounds.x1, fluid.bounds.y1);
    // How wide a strip along each wall the composite must not take a normal
    // from. Two artefacts share that strip and they scale with different
    // things, so it is the larger of the two: the band where the box converges
    // away behind the glass (perspective, so it shrinks in a wide window), and
    // the first row of particles sitting one radius off the wall (which does
    // not). See WATER_COMPOSITE_FRAGMENT.
    const shrink = fluid.depth / (focal + fluid.depth);
    const lattice = fluid.radius * CONFIG.render.wallGuardRows;
    gl.uniform2f(
      this.compositeUniform.guard,
      Math.max((this.width * 0.5 + this.eyeX) * shrink, lattice),
      Math.max((this.height * 0.5 + this.eyeY) * shrink, lattice),
    );
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
