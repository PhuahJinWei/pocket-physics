// WebGL point-sprite renderer. One interleaved buffer, two draw calls per
// frame (halo then beads). Prefers a WebGL2 context but the shaders are ES 1.00
// so a WebGL1 fallback is identical in output.

import { CONFIG } from './config.js';
import { VERTEX_SHADER, FRAGMENT_SHADER } from './shaders.js';

const FLOATS_PER_GRAIN = 6; // x, y, light, speed, sizeJitter, hueJitter
const STRIDE = FLOATS_PER_GRAIN * 4;

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
    this.program = buildProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    gl.useProgram(this.program);

    this.attrib = {
      pos: gl.getAttribLocation(this.program, 'aPos'),
      shade: gl.getAttribLocation(this.program, 'aShade'),
      jitter: gl.getAttribLocation(this.program, 'aJitter'),
    };
    this.uniform = {
      viewport: gl.getUniformLocation(this.program, 'uViewport'),
      pointSize: gl.getUniformLocation(this.program, 'uPointSize'),
      speedBoost: gl.getUniformLocation(this.program, 'uSpeedBoost'),
      deep: gl.getUniformLocation(this.program, 'uDeep'),
      mid: gl.getUniformLocation(this.program, 'uMid'),
      ice: gl.getUniformLocation(this.program, 'uIce'),
      mode: gl.getUniformLocation(this.program, 'uMode'),
      glow: gl.getUniformLocation(this.program, 'uGlow'),
    };

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.cpu.byteLength, gl.DYNAMIC_DRAW);

    for (const loc of Object.values(this.attrib)) {
      if (loc >= 0) gl.enableVertexAttribArray(loc);
    }
    gl.vertexAttribPointer(this.attrib.pos, 2, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribPointer(this.attrib.shade, 2, gl.FLOAT, false, STRIDE, 8);
    gl.vertexAttribPointer(this.attrib.jitter, 2, gl.FLOAT, false, STRIDE, 16);

    const bg = CONFIG.render.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);

    gl.uniform3fv(this.uniform.deep, CONFIG.render.deep);
    gl.uniform3fv(this.uniform.mid, CONFIG.render.mid);
    gl.uniform3fv(this.uniform.ice, CONFIG.render.ice);
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

    gl.clear(gl.COLOR_BUFFER_BIT);
    const n = sand.n;
    if (n === 0) return;

    // Pack in the grid's gravity-sorted order: deepest grains first, so the
    // lit surface layer lands on top without needing a depth buffer.
    const cpu = this.cpu;
    const order = sand.grid.order;
    const { x, y, light, speed01, sizeJitter, hueJitter } = sand;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const o = k * FLOATS_PER_GRAIN;
      cpu[o] = x[i];
      cpu[o + 1] = y[i];
      cpu[o + 2] = light[i];
      cpu[o + 3] = speed01[i];
      cpu[o + 4] = sizeJitter[i];
      cpu[o + 5] = hueJitter[i];
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
    gl.uniform1f(this.uniform.speedBoost, 0.35);

    // Halo pass: additive, premultiplied.
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1f(this.uniform.mode, 0);
    gl.uniform1f(this.uniform.glow, CONFIG.render.glowStrength);
    gl.uniform1f(this.uniform.pointSize, px * CONFIG.render.glowSize);
    gl.drawArrays(gl.POINTS, 0, n);

    // Bead pass: straight alpha over the halo.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(this.uniform.mode, 1);
    gl.uniform1f(this.uniform.pointSize, px * CONFIG.render.beadSize);
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
