// DOM overlay: the hint line, the stats panel, the tilt-permission prompt, and
// the virtual tilt stick shown when no sensors are available.

export class Hud {
  constructor(root) {
    this.root = root;
    this.hint = root.querySelector('#hint');
    this.stats = root.querySelector('#stats');
    this.gate = root.querySelector('#gate');
    this.gateButton = root.querySelector('#gate-button');
    this.gateNote = root.querySelector('#gate-note');
    this.stick = root.querySelector('#stick');
    this.knob = root.querySelector('#knob');
    this.fatal = root.querySelector('#fatal');

    this.statsVisible = false;
    this.onStick = null;
    this._hintTimer = 0;
    this._statsTimer = 0;
    this.bindStick();
  }

  setHint(text) {
    this.hint.textContent = text;
    this.hint.classList.remove('faded');
    this._hintTimer = 7;
  }

  showGate(text, note, onClick) {
    this.gateNote.textContent = note || '';
    this.gateButton.textContent = text;
    this.gate.classList.add('visible');
    this.gateButton.onclick = async () => {
      this.gateButton.disabled = true;
      const ok = await onClick();
      this.gateButton.disabled = false;
      if (ok) this.hideGate();
      else this.gateNote.textContent = 'Sensors unavailable — using the tilt stick instead.';
    };
  }

  hideGate() {
    this.gate.classList.remove('visible');
  }

  toggleStats(force) {
    this.statsVisible = force === undefined ? !this.statsVisible : force;
    this.stats.classList.toggle('visible', this.statsVisible);
  }

  showStick(visible) {
    this.stick.classList.toggle('visible', visible);
  }

  fail(message) {
    this.fatal.textContent = message;
    this.fatal.classList.add('visible');
  }

  bindStick() {
    const state = { id: null };
    const send = (event) => {
      const rect = this.stick.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const reach = rect.width / 2;
      let dx = (event.clientX - cx) / reach;
      let dy = (event.clientY - cy) / reach;
      const m = Math.hypot(dx, dy);
      if (m > 1) {
        dx /= m;
        dy /= m;
      }
      this.knob.style.transform = `translate(${dx * reach * 0.55}px, ${dy * reach * 0.55}px)`;
      if (this.onStick) this.onStick(dx, dy, true);
    };

    this.stick.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      state.id = e.pointerId;
      this.stick.setPointerCapture(e.pointerId);
      send(e);
    });
    this.stick.addEventListener('pointermove', (e) => {
      if (state.id !== e.pointerId) return;
      e.stopPropagation();
      send(e);
    });
    const release = (e) => {
      if (state.id !== e.pointerId) return;
      state.id = null;
      this.knob.style.transform = 'translate(0px, 0px)';
      if (this.onStick) this.onStick(0, 1, false);
    };
    this.stick.addEventListener('pointerup', release);
    this.stick.addEventListener('pointercancel', release);
  }

  update(dt, info) {
    if (this._hintTimer > 0) {
      this._hintTimer -= dt;
      if (this._hintTimer <= 0) this.hint.classList.add('faded');
    }
    if (!this.statsVisible) return;
    this._statsTimer -= dt;
    if (this._statsTimer > 0) return;
    this._statsTimer = 0.25;

    const rows = [
      ['fps', info.fps.toFixed(0)],
      ['work', info.workMs.toFixed(1) + ' ms'],
      ['grains', String(info.grains)],
      ['contacts', formatCount(info.contacts)],
      ['radius', info.radius.toFixed(2) + ' px'],
      ['depth', Math.round(info.depth) + ' px'],
      ['solve', `${info.substeps}×${info.iterations}`],
      ['quality', info.scale.toFixed(2) + '×'],
      ['gravity', `${info.gx.toFixed(2)}, ${info.gy.toFixed(2)}, ${info.gz.toFixed(2)}`],
      ['source', info.source],
      ['beta/gamma', `${info.beta.toFixed(0)}° / ${info.gamma.toFixed(0)}°`],
      ['screen', info.screenAngle + '°' + (info.flipped ? ' flipped' : '')],
      ['shake', info.shake.toFixed(1)],
      ['viewport', `${Math.round(info.width)}×${Math.round(info.height)} @${info.dpr}x`],
      ['backend', info.backend],
    ];
    if (info.error) rows.push(['note', info.error]);

    this.stats.innerHTML = rows
      .map(([k, v]) => `<span class="k">${k}</span><span class="v">${escapeHtml(v)}</span>`)
      .join('');
  }
}

function formatCount(n) {
  if (n > 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n > 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
