// WebGL point-sprite renderer: one interleaved buffer, one draw call for the
// sand plus a tiny one for the box. Prefers a WebGL2 context but the shaders
// are ES 1.00 so a WebGL1 fallback is identical in output.
//
// Grains are packed back-to-front (a 32-bucket counting sort on z), so nearer
// grains paint over deeper ones and no depth buffer is needed — point sprites
// with blending and a depth buffer fight over the alpha edges anyway.

import { CONFIG } from './config.js';
import { VERTEX_SHADER, buildFragmentShader, WALL_VERTEX_SHADER, WALL_FRAGMENT_SHADER } from './shaders.js';

const FLOATS_PER_GRAIN = 8; // x,y,z | light, speed, airborne | sizeJitter, hueJitter
const STRIDE = FLOATS_PER_GRAIN * 4;
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

    // Grain program is built lazily by ensureGrainStyle on the first draw,
    // because the speck count depends on the sprite's on-screen size.
    this.program = null;
    this.speckCount = 0;
    this._styleKey = '';
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

    // Hand the pipeline back to the grain program.
    gl.disableVertexAttribArray(this.wallAttrib.shade);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const loc of Object.values(this.attrib)) {
      if (loc >= 0) gl.enableVertexAttribArray(loc);
    }
    gl.vertexAttribPointer(this.attrib.pos, 3, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribPointer(this.attrib.shade, 3, gl.FLOAT, false, STRIDE, 12);
    gl.vertexAttribPointer(this.attrib.jitter, 2, gl.FLOAT, false, STRIDE, 24);
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

  draw(sand) {
    const gl = this.gl;
    if (this.contextLost) return;

    this.ensureGrainStyle(sand.diameter);

    gl.clear(gl.COLOR_BUFFER_BIT);
    const focal = CONFIG.render.focal * Math.min(this.width, this.height);
    // Box first: the sand always lives inside it, so no depth test is needed.
    this.drawWalls(sand.depth, focal, this.eyeX, this.eyeY);

    const n = sand.n;
    if (n === 0) return;

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
