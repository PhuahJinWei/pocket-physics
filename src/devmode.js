// Developer mode: a rig for reproducing and inspecting rendering artefacts.
//
// It exists because "is this intended?" is very hard to answer from a
// screenshot. Three things make it answerable:
//
//   Pose   Pin the box at an exact attitude. A bug that only shows at "about
//          70-80 degrees from flat, screen facing up" cannot be held steady by
//          hand, and every report of it describes a slightly different angle.
//          As two numbers it is the same box every time, on every device.
//   Time   Pause, single-step and slow motion. A transient can be stopped and
//          looked at instead of chased, and a settle can be watched at 1/8
//          speed to see which frame the artefact appears on.
//   Loupe  A live magnified readback of a dragged-out region, with a contrast
//          gain and a profile plot. The artefacts this renderer produces are
//          5-10 tone steps out of 255 - invisible at 1x on a phone, obvious at
//          12x, and a *number* on the plot underneath.
//
// Off unless asked for, and it injects its own stylesheet the first time it
// opens, so a normal page load carries none of this.

// Not DEG: tools/bundle.py concatenates every module into one scope, so a
// top-level name that already exists in another module is a SyntaxError in the
// bundled build and nowhere else. gravity.js owns DEG.
const TO_RAD = Math.PI / 180;
const SPEEDS = [1, 0.5, 0.25, 0.125];
const ZOOMS = [2, 4, 8, 16];
const GAINS = [1, 4, 12, 30];
const STORE_KEY = 'silt.dev';

// The attitudes worth having one press away. Pitch is the angle away from
// lying flat with the screen up, rolled about the screen's own normal:
//   0 face up -> 90 upright -> 180 face down -> 270 upside down.
// Tilt 75 is here because that is where the wall artefacts show up.
const POSES = [
  { label: 'Face up', pitch: 0, roll: 0 },
  { label: 'Tilt 45', pitch: 45, roll: 0 },
  { label: 'Tilt 75', pitch: 75, roll: 0 },
  { label: 'Upright', pitch: 90, roll: 0 },
  { label: 'Face down', pitch: 180, roll: 0 },
  { label: 'Inverted', pitch: 270, roll: 0 },
  // Named for the wall the liquid ends up against, not for which way the phone
  // was turned to get there — you press these to go and look at a wall, and
  // the two readings are mirror images of each other. Measured: roll +90 puts
  // gravity at x = -1, so the pool goes left.
  { label: 'Pool L', pitch: 90, roll: 90 },
  { label: 'Pool R', pitch: 90, roll: -90 },
];

export class DevMode {
  constructor({ canvas, gravity, renderer, hud, config }) {
    this.canvas = canvas;
    this.gravity = gravity;
    this.renderer = renderer;
    this.hud = hud;
    // Live render switches live here so a candidate can be judged in every
    // pose on the device before it is made the default.
    this.config = config;

    this.active = false;
    this.collapsed = false;

    this.poseOn = false;
    this.pitch = 75;
    this.roll = 0;

    this.paused = false;
    this.speed = 1;
    this.stepPending = false;

    // Region is in CSS pixels relative to the viewport, which is also the
    // canvas: #stage is position:fixed inset:0, so the two frames coincide.
    this.region = null;
    this.zoom = 4;
    this.gain = 12;
    this.axis = 'x';

    this.el = null;
    this._pixels = null;
    this._picking = false;

    this.bindLongPress();
  }

  // ------------------------------------------------------------- activation

  /**
   * Long-press the existing menu button. A phone has no keyboard and the point
   * of this mode is that it leaves no mark on the normal UI, so the way in has
   * to be a gesture on something already there.
   */
  bindLongPress() {
    const trigger = this.hud && this.hud.menuButton;
    if (!trigger) return;
    let timer = 0;
    let fired = false;
    const cancel = () => clearTimeout(timer);
    trigger.addEventListener('pointerdown', () => {
      fired = false;
      timer = setTimeout(() => {
        fired = true;
        this.hud.showMenu(false);
        this.toggle();
      }, 650);
    });
    trigger.addEventListener('pointerup', cancel);
    trigger.addEventListener('pointerleave', cancel);
    trigger.addEventListener('pointercancel', cancel);
    // Swallow the click the long press is about to produce, before it reaches
    // the button's own handler and opens the menu. Capture on window runs
    // ahead of a bubble listener on the target; registration order does not
    // help here, since the Hud binds its listener first.
    window.addEventListener('click', (e) => {
      if (!fired) return;
      fired = false;
      if (e.target.closest && e.target.closest('#menu')) e.stopPropagation();
    }, true);
  }

  static wanted(params) {
    if (params.has('dev')) return params.get('dev') !== '0';
    try {
      return localStorage.getItem(STORE_KEY) === '1';
    } catch {
      return false;
    }
  }

  toggle(on) {
    const next = on === undefined ? !this.active : !!on;
    if (next === this.active) return;
    this.active = next;
    try {
      localStorage.setItem(STORE_KEY, next ? '1' : '0');
    } catch {
      /* storage blocked - the mode just will not be remembered */
    }
    // The readout is deliberately short for a normal run; the rig wants every
    // row it has.
    if (this.hud && this.hud.setVerbose) this.hud.setVerbose(next);
    if (next) {
      this.build();
      this.el.hidden = false;
    } else {
      // Leaving must put everything back: a pinned pose or a paused sim that
      // outlived the panel would look like the app had broken.
      this.poseOn = false;
      this.paused = false;
      this.speed = 1;
      this.region = null;
      this.gravity.pose = null;
      // A lifted box that outlived the panel would silently become the shipped
      // look, which is the one thing this toggle must not do.
      if (this.config) this.config.render.wallLift = 1;
      if (this.el) this.el.hidden = true;
      if (this.loupeWin) this.loupeWin.hidden = true;
    }
  }

  // ------------------------------------------------------------ frame hooks

  /**
   * Simulation dt for this frame. Zero while paused; a single step delivers
   * one nominal frame regardless of the slow-motion factor, so stepping is
   * always the same size of nudge.
   */
  scaleDt(dt) {
    if (!this.active) return dt;
    if (this.stepPending) {
      this.stepPending = false;
      return 1 / 60;
    }
    if (this.paused) return 0;
    return dt * this.speed;
  }

  /** Push the pinned attitude into the gravity input, or release it. */
  applyPose() {
    if (!this.active || !this.poseOn) {
      this.gravity.pose = null;
      return;
    }
    const th = this.pitch * TO_RAD;
    const ph = this.roll * TO_RAD;
    const s = Math.sin(th);
    this.gravity.pose = {
      x: -Math.sin(ph) * s,
      y: Math.cos(ph) * s,
      z: Math.cos(th),
    };
  }

  /**
   * Grab the loupe's region straight after the draw. It has to happen here:
   * the context is created without preserveDrawingBuffer, so the colour buffer
   * is only guaranteed to hold the frame until the task that drew it ends.
   */
  afterDraw() {
    if (!this.active || !this.region || !this.loupeWin || this.loupeWin.hidden) return;
    const R = this.renderer;
    const gl = R.gl;
    if (!gl || R.contextLost) return;
    const dpr = R.dpr;
    const r = this.region;
    const dw = Math.max(1, Math.round(r.w * dpr));
    const dh = Math.max(1, Math.round(r.h * dpr));
    const dx = Math.max(0, Math.round(r.x * dpr));
    // readPixels counts rows up from the bottom of the buffer, CSS counts down
    // from the top. Getting this backwards reads a mirrored strip from the
    // opposite side of the box, which looks plausible and is not the region.
    const dy = Math.max(0, Math.round((R.height - r.y - r.h) * dpr));
    const need = dw * dh * 4;
    if (!this._pixels || this._pixels.length < need) this._pixels = new Uint8Array(need);
    const buf = this._pixels;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(dx, dy, dw, dh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    this.paint(buf, dw, dh);
  }

  // --------------------------------------------------------------- keyboard

  /** Returns true when the key belonged to dev mode and must not fall through. */
  handleKey(code, shift) {
    if (code === 'KeyG' && shift) {
      this.toggle();
      return true;
    }
    if (!this.active) return false;
    switch (code) {
      case 'KeyP':
        this.paused = !this.paused;
        this.sync();
        return true;
      case 'KeyO':
        this.paused = true;
        this.stepPending = true;
        this.sync();
        return true;
      case 'KeyL':
        this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
        this.sync();
        return true;
      case 'KeyZ':
        this.pick();
        return true;
      default:
        break;
    }
    if (/^Digit[1-8]$/.test(code)) {
      this.setPose(POSES[Number(code.slice(5)) - 1]);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------- panel

  build() {
    if (this.el) return;
    if (!document.getElementById('dev-css')) {
      const link = document.createElement('link');
      link.id = 'dev-css';
      link.rel = 'stylesheet';
      link.href = 'styles/dev.css';
      document.head.append(link);
    }

    const panel = el('div', 'dev-panel');
    panel.id = 'dev-panel';
    panel.hidden = true;

    const head = el('div', 'dev-head');
    head.append(el('span', 'dev-title', 'DEV'));
    const collapse = button('dev-x', '−', () => {
      this.collapsed = !this.collapsed;
      panel.classList.toggle('collapsed', this.collapsed);
      collapse.firstChild.textContent = this.collapsed ? '+' : '−';
    });
    const close = button('dev-x', '×', () => this.toggle(false));
    head.append(collapse, close);
    panel.append(head);

    const body = el('div', 'dev-body');
    panel.append(body);

    // --- pose
    body.append(el('div', 'dev-label', 'Pose'));
    const poseGrid = el('div', 'dev-grid');
    this._poseButtons = POSES.map((p, i) =>
      button('dev-btn', p.label, () => this.setPose(p), String(i + 1)),
    );
    poseGrid.append(...this._poseButtons);
    body.append(poseGrid);

    this._live = button('dev-btn dev-wide', 'Release to live input', () => {
      this.poseOn = false;
      this.sync();
    });
    body.append(this._live);

    this._pitch = slider(0, 360, 1, this.pitch, (v) => {
      this.pitch = v;
      this.poseOn = true;
      this.sync();
    });
    this._roll = slider(-180, 180, 1, this.roll, (v) => {
      this.roll = v;
      this.poseOn = true;
      this.sync();
    });
    body.append(row('pitch', this._pitch.el), row('roll', this._roll.el));

    // --- time
    body.append(el('div', 'dev-label', 'Time'));
    const timeRow = el('div', 'dev-row');
    this._pause = button('dev-btn', 'Pause', () => {
      this.paused = !this.paused;
      this.sync();
    }, 'P');
    this._step = button('dev-btn', 'Step', () => {
      this.paused = true;
      this.stepPending = true;
      this.sync();
    }, 'O');
    timeRow.append(this._pause, this._step);
    body.append(timeRow);
    this._speeds = SPEEDS.map((s) =>
      button('dev-btn', s === 1 ? '1x' : '1/' + Math.round(1 / s), () => {
        this.speed = s;
        this.sync();
      }),
    );
    body.append(group(this._speeds));

    // --- loupe
    body.append(el('div', 'dev-label', 'Loupe'));
    const loupeRow = el('div', 'dev-row');
    this._pickBtn = button('dev-btn', 'Select area', () => this.pick(), 'Z');
    this._clearBtn = button('dev-btn', 'Clear', () => {
      this.region = null;
      if (this.loupeWin) this.loupeWin.hidden = true;
      this.sync();
    });
    loupeRow.append(this._pickBtn, this._clearBtn);
    body.append(loupeRow);
    this._zooms = ZOOMS.map((z) =>
      button('dev-btn', z + 'x', () => {
        this.zoom = z;
        this.sync();
      }),
    );
    this._gains = GAINS.map((g) =>
      button('dev-btn', g === 1 ? 'true' : 'g' + g, () => {
        this.gain = g;
        this.sync();
      }),
    );
    body.append(row('zoom', group(this._zooms)), row('gain', group(this._gains)));

    // --- field: render switches under evaluation
    if (this.config) {
      body.append(el('div', 'dev-label', 'Field'));
      this._clipBtn = button('dev-btn dev-wide', 'Clip real particles to the box', () => {
        this.config.render.clipReal = !this.config.render.clipReal;
        this.sync();
      });
      body.append(this._clipBtn);

      // --- box: the walls are deliberately below the threshold where they can
      // be looked at, which is right with a full box and arguably wrong with an
      // empty one. This is the A/B for that call, and it has to be made on a
      // phone: the walls sit at 2-7x the background, a ratio a desktop panel
      // shows and a phone in a lit room does not.
      body.append(el('div', 'dev-label', 'Box'));
      this._wallBtn = button('dev-btn dev-wide', 'Lift box walls', () => {
        const R = this.config.render;
        R.wallLift = R.wallLift > 1 ? 1 : R.wallLiftHigh;
        this.sync();
      });
      body.append(this._wallBtn);
    }

    document.getElementById('ui').append(panel);
    this.el = panel;

    this.buildLoupe();
    this.buildSelection();
    this.sync();
  }

  buildLoupe() {
    const win = el('div', 'dev-loupe');
    win.hidden = true;
    const head = el('div', 'dev-head dev-drag');
    head.append(el('span', 'dev-title', 'LOUPE'));
    this._axisBtn = button('dev-x dev-axis', '↔', () => {
      this.axis = this.axis === 'x' ? 'y' : 'x';
      this.sync();
    });
    head.append(this._axisBtn, button('dev-x', '×', () => {
      win.hidden = true;
      this.region = null;
      this.sync();
    }));
    // The plot lives outside the image's scroller, or a tall magnification
    // pushes it below the fold and the one number worth reading is the one you
    // have to go looking for. The two scroll together instead, so a feature in
    // the picture still sits over its own value however far across you are.
    const scroll = el('div', 'dev-scroll');
    this._view = document.createElement('canvas');
    scroll.append(this._view);
    const rail = el('div', 'dev-rail');
    this._plot = document.createElement('canvas');
    rail.append(this._plot);
    let syncing = false;
    const link = (from, to) => from.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      to.scrollLeft = from.scrollLeft;
      syncing = false;
    });
    link(scroll, rail);
    link(rail, scroll);
    this._readout = el('div', 'dev-readout');
    win.append(head, scroll, rail, this._readout);
    document.getElementById('ui').append(win);
    this.loupeWin = win;
    dragBy(head, win);
  }

  buildSelection() {
    this._marquee = el('div', 'dev-marquee');
    this._marquee.hidden = true;
    document.getElementById('ui').append(this._marquee);
  }

  setPose(p) {
    if (!p) return;
    this.pitch = p.pitch;
    this.roll = p.roll;
    this.poseOn = true;
    if (this._pitch) this._pitch.set(p.pitch);
    if (this._roll) this._roll.set(p.roll);
    this.sync();
  }

  /** Reflect state onto the controls. One place, called after every change. */
  sync() {
    if (!this.el) return;
    const near = (a, b) => Math.abs(a - b) < 0.5;
    this._poseButtons.forEach((b, i) =>
      b.classList.toggle(
        'on',
        this.poseOn && near(POSES[i].pitch, this.pitch) && near(POSES[i].roll, this.roll),
      ),
    );
    this._live.classList.toggle('on', !this.poseOn);
    this._pitch.label(Math.round(this.pitch) + '°');
    this._roll.label(Math.round(this.roll) + '°');
    this._pause.classList.toggle('on', this.paused);
    this._pause.firstChild.textContent = this.paused ? 'Resume' : 'Pause';
    this._speeds.forEach((b, i) => b.classList.toggle('on', SPEEDS[i] === this.speed));
    this._zooms.forEach((b, i) => b.classList.toggle('on', ZOOMS[i] === this.zoom));
    this._gains.forEach((b, i) => b.classList.toggle('on', GAINS[i] === this.gain));
    this._pickBtn.classList.toggle('on', this._picking);
    if (this._axisBtn) this._axisBtn.firstChild.textContent = this.axis === 'x' ? '↔' : '↕';
    if (this._clipBtn) this._clipBtn.classList.toggle('on', !!this.config.render.clipReal);
    if (this._wallBtn) {
      const lift = this.config.render.wallLift;
      this._wallBtn.classList.toggle('on', lift > 1);
      this._wallBtn.firstChild.textContent = `Lift box walls ${lift.toFixed(2)}×`;
    }
  }

  // ------------------------------------------------------------- area picker

  /**
   * Drag a rectangle over the canvas. Listeners are on window in the capture
   * phase so the pick never reaches the poke input underneath and pours the
   * liquid around while an area is being chosen.
   */
  pick() {
    if (this._picking) return;
    this._picking = true;
    document.body.classList.add('dev-picking');
    this.sync();

    let x0 = 0;
    let y0 = 0;
    let rect = null;
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const shape = (x1, y1) => {
      const W = this.renderer.width;
      const H = this.renderer.height;
      const x = Math.max(0, Math.min(x0, x1));
      const y = Math.max(0, Math.min(y0, y1));
      rect = {
        x,
        y,
        w: Math.min(Math.abs(x1 - x0), W - x),
        h: Math.min(Math.abs(y1 - y0), H - y),
      };
      const s = this._marquee.style;
      s.left = rect.x + 'px';
      s.top = rect.y + 'px';
      s.width = rect.w + 'px';
      s.height = rect.h + 'px';
    };
    const move = (e) => {
      stop(e);
      shape(e.clientX, e.clientY);
    };
    const up = (e) => {
      stop(e);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      this._marquee.hidden = true;
      document.body.classList.remove('dev-picking');
      this._picking = false;
      // Too small to be a deliberate drag: treat it as a cancel rather than
      // opening a four-pixel window.
      if (rect && rect.w > 8 && rect.h > 8) {
        this.region = rect;
        this.loupeWin.hidden = false;
      }
      this.sync();
    };
    const down = (e) => {
      stop(e);
      window.removeEventListener('pointerdown', down, true);
      x0 = e.clientX;
      y0 = e.clientY;
      this._marquee.hidden = false;
      shape(x0, y0);
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
    };
    window.addEventListener('pointerdown', down, true);
  }

  // ------------------------------------------------------------------ output

  /**
   * Magnify the grabbed strip, and plot its profile underneath.
   *
   * At gain 1 the pixels are shown as they are. Above that the strip is
   * flattened to luminance and stretched about its own mean: a real colour
   * image saturates into confetti at 12x, while the greyscale stretch turns a
   * six-tone step - which is what these artefacts are - into a wall.
   */
  paint(buf, dw, dh) {
    const zoom = this.zoom;
    const view = this._view;
    if (view.width !== dw * zoom || view.height !== dh * zoom) {
      view.width = dw * zoom;
      view.height = dh * zoom;
    }
    const ctx = view.getContext('2d');
    const img = ctx.createImageData(view.width, view.height);
    const out = img.data;

    let sum = 0;
    let lo = 255;
    let hi = 0;
    const n = dw * dh;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const lum = (buf[o] + buf[o + 1] + buf[o + 2]) / 3;
      sum += lum;
      if (lum < lo) lo = lum;
      if (lum > hi) hi = lum;
    }
    const mean = sum / n;
    const gain = this.gain;

    for (let j = 0; j < dh; j++) {
      // Flip: row 0 of the readback is the bottom of the region.
      const src = (dh - 1 - j) * dw;
      for (let i = 0; i < dw; i++) {
        const o = (src + i) * 4;
        let r = buf[o];
        let g = buf[o + 1];
        let b = buf[o + 2];
        if (gain > 1) {
          const v = clamp8(128 + ((r + g + b) / 3 - mean) * gain);
          r = v;
          g = v;
          b = v;
        }
        for (let dy = 0; dy < zoom; dy++) {
          let p = ((j * zoom + dy) * view.width + i * zoom) * 4;
          for (let dx = 0; dx < zoom; dx++) {
            out[p] = r;
            out[p + 1] = g;
            out[p + 2] = b;
            out[p + 3] = 255;
            p += 4;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);

    this.plot(buf, dw, dh, view.width);
    this._readout.textContent =
      dw + '×' + dh + 'px  µ' + mean.toFixed(1) +
      '  lo' + lo.toFixed(0) + '  hi' + hi.toFixed(0);
  }

  /**
   * Mean luminance per column (or per row), drawn at the same width as the
   * magnified strip above it so a feature in the picture sits directly over
   * its own number. The span printed with it is the whole point: a flat body
   * reads under a tone or two, and a band reads five or more.
   */
  plot(buf, dw, dh, width) {
    const cross = this.axis === 'x';
    const count = cross ? dw : dh;
    const other = cross ? dh : dw;
    const series = new Float64Array(count);
    for (let a = 0; a < count; a++) {
      let s = 0;
      for (let b = 0; b < other; b++) {
        const i = cross ? b * dw + a : (dh - 1 - a) * dw + b;
        const o = i * 4;
        s += (buf[o] + buf[o + 1] + buf[o + 2]) / 3;
      }
      series[a] = s / other;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let a = 0; a < count; a++) {
      if (series[a] < lo) lo = series[a];
      if (series[a] > hi) hi = series[a];
    }
    const span = hi - lo;

    const plot = this._plot;
    const H = 56;
    if (plot.width !== width || plot.height !== H) {
      plot.width = width;
      plot.height = H;
    }
    const ctx = plot.getContext('2d');
    ctx.clearRect(0, 0, width, H);
    ctx.fillStyle = 'rgba(7,6,4,0.9)';
    ctx.fillRect(0, 0, width, H);
    ctx.strokeStyle = 'rgba(240,194,116,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const pad = 6;
    const range = Math.max(span, 1e-3);
    for (let a = 0; a < count; a++) {
      const x = count === 1 ? 0 : (a / (count - 1)) * (width - 1);
      const y = H - pad - ((series[a] - lo) / range) * (H - pad * 2);
      if (a === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(226,213,189,0.55)';
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText((cross ? 'per column' : 'per row') + '  span ' + span.toFixed(1), 6, 12);
  }
}

// ------------------------------------------------------------------- helpers

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(cls, text, onClick, key) {
  const b = el('button', cls);
  b.type = 'button';
  b.append(document.createTextNode(text));
  if (key) b.append(el('kbd', '', key));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    b.blur();
    onClick();
  });
  // The panel floats over the canvas; a press on it must not also start a drag
  // in the liquid underneath.
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  return b;
}

function group(buttons) {
  const g = el('div', 'dev-group');
  g.append(...buttons);
  return g;
}

function row(name, control) {
  const r = el('div', 'dev-line');
  r.append(el('span', 'dev-name', name), control);
  return r;
}

function slider(min, max, step, value, onInput) {
  const wrap = el('div', 'dev-slider');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = el('span', 'dev-value');
  input.addEventListener('input', () => onInput(Number(input.value)));
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  wrap.append(input, out);
  return {
    el: wrap,
    set: (v) => {
      input.value = String(v);
    },
    label: (t) => {
      out.textContent = t;
    },
  };
}

/** Drag a floating window by its header. */
function dragBy(handle, win) {
  let id = null;
  let ox = 0;
  let oy = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.stopPropagation();
    id = e.pointerId;
    handle.setPointerCapture(id);
    const r = win.getBoundingClientRect();
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    win.style.right = 'auto';
    win.style.bottom = 'auto';
  });
  handle.addEventListener('pointermove', (e) => {
    if (id !== e.pointerId) return;
    e.stopPropagation();
    win.style.left = Math.max(0, e.clientX - ox) + 'px';
    win.style.top = Math.max(0, e.clientY - oy) + 'px';
  });
  const release = (e) => {
    if (id === e.pointerId) id = null;
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
}

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
