// Multi-touch / mouse pushing. Tracks live pointers in CSS sim coordinates and
// hands the sim one poke per pointer per frame, including the pointer's own
// velocity so dragging sweeps grains along.

export class PokeInput {
  constructor(canvas) {
    this.canvas = canvas;
    this.pointers = new Map();
    this.onFirstTouch = null;

    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('pointerleave', (e) => this.up(e));
    // Belt and braces alongside touch-action:none in CSS.
    canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  locate(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  down(event) {
    this.canvas.setPointerCapture?.(event.pointerId);
    const p = this.locate(event);
    this.pointers.set(event.pointerId, { x: p.x, y: p.y, dx: 0, dy: 0, fresh: true });
    if (this.onFirstTouch) this.onFirstTouch();
  }

  move(event) {
    const entry = this.pointers.get(event.pointerId);
    if (!entry) return;
    const p = this.locate(event);
    entry.dx = p.x - entry.x;
    entry.dy = p.y - entry.y;
    entry.x = p.x;
    entry.y = p.y;
  }

  up(event) {
    this.pointers.delete(event.pointerId);
  }

  get active() {
    return this.pointers.size > 0;
  }

  apply(sand, dt) {
    if (this.pointers.size === 0) return;
    const invDt = 1 / Math.max(dt, 1e-3);
    for (const entry of this.pointers.values()) {
      // dx/dy are this frame's displacement; hand the sim a velocity.
      sand.poke(entry.x, entry.y, entry.dx * invDt, entry.dy * invDt, dt);
      // Decay so a held-still finger keeps pushing but stops dragging.
      entry.dx *= 0.6;
      entry.dy *= 0.6;
      entry.fresh = false;
    }
  }
}
