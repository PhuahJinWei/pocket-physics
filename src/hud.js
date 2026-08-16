// DOM overlay: the control bar, the stats readout, the tilt-permission prompt,
// and the virtual tilt stick shown when no sensors are available.

export class Hud {
  constructor(root) {
    this.root = root;
    this.stats = root.querySelector('#stats');
    this.gate = root.querySelector('#gate');
    this.gateButton = root.querySelector('#gate-button');
    this.gateNote = root.querySelector('#gate-note');
    this.stick = root.querySelector('#stick');
    this.knob = root.querySelector('#knob');
    this.fatal = root.querySelector('#fatal');
    this.material = root.querySelector('#material');
    this.materialPicker = root.querySelector('#material-picker');
    this.materialMenu = root.querySelector('#material-menu');
    this.menuPanel = root.querySelector('#menu-panel');
    this.menuButton = root.querySelector('#menu');
    this.menuList = root.querySelector('#menu-list');

    this.statsVisible = false;
    this.onStick = null;
    this.onMaterial = null;
    this.onAction = null;
    // True while either list is open. The frame loop reads these so the
    // movement keys do not tilt the box out from under someone who is choosing.
    this.materialOpen = false;
    this.menuOpen = false;
    this._materialButtons = new Map();
    this._statsTimer = 0;
    this.bindStick();
    this.bindMaterial();
    this.bindControls();
  }

  /**
   * Actions menu. One listener on the list rather than one per row, so adding
   * an action is markup and a case in main.js — nothing here.
   */
  bindControls() {
    if (!this.menuButton) return;
    this.menuButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showMenu(!this.menuOpen);
    });
    // The panel floats over the canvas, so a press on it must not also start a
    // drag in the liquid underneath, the same reason the picker stops its own.
    this.menuPanel.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.menuList.addEventListener('click', (e) => {
      const button = e.target.closest('.menu-item');
      if (!button) return;
      e.stopPropagation();
      // Keep focus off the row after a tap: a focused button would otherwise
      // eat the next space press, which is the splash shortcut.
      button.blur();
      // The readout latches, so leave the menu up to show it took. Everything
      // else acts on the box, and you want to see the box.
      if (button.dataset.act !== 'stats') this.showMenu(false);
      if (this.onAction) this.onAction(button.dataset.act);
    });
    window.addEventListener('pointerdown', (e) => {
      if (this.menuOpen && !this.menuPanel.contains(e.target)) this.showMenu(false);
    });
    window.addEventListener('keydown', (e) => {
      if (this.menuOpen && e.code === 'Escape') {
        this.showMenu(false);
        this.menuButton.focus();
      }
    });
  }

  showMenu(open) {
    if (!this.menuList) return;
    this.menuOpen = open;
    this.menuList.hidden = !open;
    this.menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Two lists on two corners of the same rim; only one is ever up.
    if (open) this.showMaterialMenu(false);
  }

  /** Latch a menu row on or off — currently just the readout toggle. */
  setActionState(act, on) {
    const row = this.menuList && this.menuList.querySelector(`[data-act="${act}"]`);
    if (row) row.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  bindMaterial() {
    if (!this.material) return;
    this.material.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMaterialMenu();
    });
    // The picker sits in an overlay, so a tap on it never reaches the canvas —
    // but a stray pointerdown would still start a drag, so stop it here.
    this.materialPicker.addEventListener('pointerdown', (e) => e.stopPropagation());
    // Anywhere else dismisses, which is what every menu everywhere does.
    window.addEventListener('pointerdown', (e) => {
      if (this.materialOpen && !this.materialPicker.contains(e.target)) {
        this.showMaterialMenu(false);
      }
    });
    window.addEventListener('keydown', (e) => {
      if (this.materialOpen && e.code === 'Escape') {
        this.showMaterialMenu(false);
        this.material.focus();
      }
    });
  }

  /**
   * Build one row per material. Called once with the registry, so materials
   * added later appear here without touching the markup or this file.
   */
  setMaterials(list, currentId) {
    if (!this.materialMenu) return;
    this.materialMenu.innerHTML = '';
    this._materialButtons.clear();
    for (const m of list) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'material-option';
      row.setAttribute('role', 'option');
      row.dataset.id = m.id;

      const dot = document.createElement('span');
      dot.className = 'material-swatch';
      dot.style.background = m.tint || '#888';
      row.append(dot, document.createTextNode(m.label));

      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showMaterialMenu(false);
        if (this.onMaterial) this.onMaterial(m.id);
      });
      this.materialMenu.append(row);
      this._materialButtons.set(m.id, row);
    }
    const current = list.find((m) => m.id === currentId);
    this.setMaterial(currentId, current ? current.label : '');
  }

  setMaterial(id, label) {
    // The caret is a ::after pseudo-element, so replacing the text leaves it be.
    if (this.material) this.material.textContent = label;
    for (const [key, row] of this._materialButtons) {
      row.setAttribute('aria-selected', key === id ? 'true' : 'false');
    }
  }

  toggleMaterialMenu() {
    this.showMaterialMenu(!this.materialOpen);
  }

  showMaterialMenu(open) {
    if (!this.materialMenu) return;
    this.materialOpen = open;
    this.materialMenu.hidden = !open;
    this.material.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) this.showMenu(false);
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
    // Both the key and the toolbar button come through here, so the lamp on the
    // button is right however the readout was opened.
    this.setActionState('stats', this.statsVisible);
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
    if (!this.statsVisible) return;
    this._statsTimer -= dt;
    if (this._statsTimer > 0) return;
    this._statsTimer = 0.25;

    const rows = [
      ['fps', info.fps.toFixed(0)],
      ['work', info.workMs.toFixed(1) + ' ms'],
      ['material', info.material],
      [info.material === 'Water' ? 'particles' : 'grains', String(info.grains)],
      [info.material === 'Water' ? 'neighbours' : 'contacts', formatCount(info.contacts)],
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
