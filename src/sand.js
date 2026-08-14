// Granular sand as position-based dynamics over a spatial hash.
//
// Per substep: integrate -> rebuild grid -> relax contacts a few times ->
// derive velocity from the position change. Contacts do two jobs at once:
// separation (grains are incompressible) and Coulomb-ish friction (grains have
// shear strength, which is what produces a pile instead of a puddle).
//
// The same neighbour scan also accumulates the shading terms, so the 2.5D look
// costs almost nothing: `contacts` says how packed a grain is, and `cover`
// says how much sits above it along the gravity direction. Grains with nothing
// above them are the lit surface of the bed.

import { CONFIG } from './config.js';
import { Grid } from './grid.js';
import { clamp, makeRandom } from './util.js';

export class Sand {
  constructor(capacity) {
    this.capacity = capacity;
    this.n = 0;

    const f32 = () => new Float32Array(capacity);
    this.x = f32();
    this.y = f32();
    this.px = f32();
    this.py = f32();
    this.vx = f32();
    this.vy = f32();
    this.light = f32();
    this.speed01 = f32();
    this.sizeJitter = f32();
    this.hueJitter = f32();
    this.contacts = new Uint8Array(capacity);
    this.cover = f32();
    this.litAbove = f32();

    this.grid = new Grid(capacity);
    this.random = makeRandom(0x5117);

    this.radius = 3;
    this.diameter = 6;
    this.cellSize = 7.5;
    this.bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
    this.inner = { x0: 0, y0: 0, x1: 1, y1: 1 };
    this.speedNorm = 400;
    this.substeps = 1;
    this.iterations = CONFIG.sim.iterations;
    this.solvedPairs = 0;
  }

  /** Set the sim rectangle and grain size; keeps existing grains in place. */
  configure(width, height, radius) {
    this.radius = radius;
    this.diameter = radius * 2;
    this.cellSize = this.diameter * CONFIG.grain.cellMul;
    this.bounds = { x0: 0, y0: 0, x1: width, y1: height };
    this.inner = {
      x0: radius,
      y0: radius,
      x1: Math.max(radius, width - radius),
      y1: Math.max(radius, height - radius),
    };
    this.grid.configure(0, 0, width, height, this.cellSize);

    const g = CONFIG.sim.gravityScale * Math.hypot(width, height);
    this.speedNorm = 0.3 * Math.sqrt(2 * g * height);
    this.gravityMagnitude = g;
  }

  /** Grain count that fills `CONFIG.bed.fill` of the viewport when settled. */
  idealCount(fill = CONFIG.bed.fill) {
    const { x1, y1 } = this.bounds;
    const area = x1 * y1;
    const grainArea = (Math.PI * this.radius * this.radius) / CONFIG.bed.packing;
    const ideal = (fill * area) / grainArea;
    const ceiling = Math.min(
      CONFIG.bed.maxGrains,
      this.capacity,
      (CONFIG.bed.maxFill * area) / grainArea,
    );
    return Math.round(clamp(ideal, CONFIG.bed.minGrains, ceiling));
  }

  /** Lay out a settled hexagonal bed at the bottom, so nothing explodes at t=0. */
  fill(count) {
    const n = Math.min(count, this.capacity);
    this.n = n;
    this.grid.ensureCapacity(n);

    const rand = this.random;
    const d = this.diameter;
    const { x0, y0, x1, y1 } = this.inner;
    const usable = Math.max(d, x1 - x0);
    const perRow = Math.max(1, Math.floor(usable / d));
    // True hex packing: alternate rows offset by half a diameter, rows sqrt(3)/2
    // apart. Get either wrong and every grain starts overlapped, which the
    // solver then releases as a bed-wide explosion.
    const rowStep = d * 0.8660254;

    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const stagger = row % 2 ? this.radius : 0;
      const px = x0 + stagger + col * d + (rand() - 0.5) * this.radius * 0.25;
      const py = y1 - row * rowStep - (rand() - 0.5) * this.radius * 0.2;
      this.x[i] = clamp(px, x0, x1);
      this.y[i] = clamp(py, y0, y1);
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.light[i] = 0.2;
      this.speed01[i] = 0;
      this.sizeJitter[i] = rand();
      this.hueJitter[i] = rand();
      this.contacts[i] = 0;
      this.cover[i] = 0;
    }
  }

  /** Grow/shrink the bed without disturbing the grains that stay. */
  setCount(count) {
    const target = Math.min(Math.max(count, 0), this.capacity);
    if (target === this.n) return;
    if (target < this.n) {
      this.n = target;
      return;
    }
    const rand = this.random;
    const { x0, x1, y0 } = this.inner;
    for (let i = this.n; i < target; i++) {
      this.x[i] = x0 + rand() * (x1 - x0);
      this.y[i] = y0 + rand() * this.diameter * 3;
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.light[i] = 1;
      this.speed01[i] = 0;
      this.sizeJitter[i] = rand();
      this.hueJitter[i] = rand();
      this.contacts[i] = 0;
      this.cover[i] = 0;
    }
    this.n = target;
    this.grid.ensureCapacity(target);
  }

  /** Nudge every grain back inside after a viewport change. */
  clampToBounds() {
    const { x0, y0, x1, y1 } = this.inner;
    for (let i = 0; i < this.n; i++) {
      this.x[i] = clamp(this.x[i], x0, x1);
      this.y[i] = clamp(this.y[i], y0, y1);
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];
    }
  }

  /** Shake response: throw the bed into the air. */
  splash(strength) {
    const rand = this.random;
    const speed = this.speedNorm * CONFIG.sim.splashSpeed * strength;
    for (let i = 0; i < this.n; i++) {
      const a = rand() * Math.PI * 2;
      const m = speed * (0.35 + rand() * 0.65);
      this.vx[i] += Math.cos(a) * m;
      this.vy[i] += Math.sin(a) * m * 0.8 - m * 0.5;
    }
  }

  /** Push grains away from a point, and drag them along with it. */
  poke(cx, cy, dx, dy, dt) {
    const r = CONFIG.input.pokeRadius;
    const r2 = r * r;
    const push = CONFIG.input.pokeStrength * dt;
    const dragScale = CONFIG.input.pokeDrag;
    const x = this.x, y = this.y, vx = this.vx, vy = this.vy;
    for (let i = 0; i < this.n; i++) {
      const ox = x[i] - cx;
      const oy = y[i] - cy;
      const d2 = ox * ox + oy * oy;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const falloff = 1 - d / r;
      const k = (push * falloff) / d;
      vx[i] += ox * k + dx * dragScale * falloff;
      vy[i] += oy * k + dy * dragScale * falloff;
    }
  }

  step(dtFrame, gx, gy) {
    const n = this.n;
    if (n === 0) return;
    const cfg = CONFIG.sim;

    // Pick a substep count that keeps the fastest grain inside one grid cell,
    // so the 3x3 neighbour scan can never miss a collision. A settled bed runs
    // at one substep; only a violent shake pays for more.
    let maxV2 = 0;
    for (let i = 0; i < n; i++) {
      const s = this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i];
      if (s > maxV2) maxV2 = s;
    }
    const travel = cfg.substepTravel * this.cellSize;
    const needed = Math.ceil((Math.sqrt(maxV2) * dtFrame) / travel);
    const substeps = clamp(needed || 1, 1, cfg.maxSubsteps);
    const dt = dtFrame / substeps;
    this.substeps = substeps;

    const cellOrder = this.grid.orderCellsByGravity(gx, gy);
    const gmag = Math.hypot(gx, gy) || 1;
    const gdx = gx / gmag;
    const gdy = gy / gmag;

    // Substeps do more for convergence than extra iterations do, so once the
    // bed is moving fast enough to need several substeps, one sweep each is
    // both cheaper and stiffer than two.
    const iterations = substeps >= 3 ? 1 : cfg.iterations;
    this.iterations = iterations;

    this.solvedPairs = 0;
    for (let s = 0; s < substeps; s++) {
      this.integrate(dt, gx, gy);
      this.grid.build(this.x, this.y, n);
      for (let it = 0; it < iterations; it++) {
        this.solve(cellOrder, gdx, gdy);
        this.applyWalls();
      }
      this.deriveVelocity(dt);
    }
    this.updateShading(dtFrame);
  }

  integrate(dt, gx, gy) {
    const n = this.n;
    const damp = CONFIG.sim.damping;
    const x = this.x, y = this.y, px = this.px, py = this.py;
    const vx = this.vx, vy = this.vy;
    const dvx = gx * dt;
    const dvy = gy * dt;
    for (let i = 0; i < n; i++) {
      const nvx = (vx[i] + dvx) * damp;
      const nvy = (vy[i] + dvy) * damp;
      vx[i] = nvx;
      vy[i] = nvy;
      px[i] = x[i];
      py[i] = y[i];
      x[i] += nvx * dt;
      y[i] += nvy * dt;
    }
  }

  /**
   * One Gauss-Seidel relaxation sweep. Corrections are applied immediately and
   * grains are visited deepest-first, so each pair is examined twice per sweep
   * (once from either side) but only corrected while it actually overlaps.
   */
  solve(cellOrder, gdx, gdy) {
    const grid = this.grid;
    const cols = grid.cols, rows = grid.rows;
    const cells = grid.cellCount;
    const start = grid.cellStart, order = grid.order;
    const x = this.x, y = this.y, px = this.px, py = this.py;
    const contacts = this.contacts, cover = this.cover;
    const light = this.light, litAbove = this.litAbove;
    const cfg = CONFIG.sim;
    const D = this.diameter;
    const D2 = D * D;
    const DS = D * cfg.shadeRadius;
    const DS2 = DS * DS;
    const half = cfg.stiffness * 0.5;
    const muS = cfg.muS, muK = cfg.muK;
    // A grain has up to six contacts and each one resolves in sequence, so full
    // strength friction over-corrects and jitters. Under-relax it.
    const relax = cfg.frictionRelax;
    let pairs = 0;

    for (let oc = 0; oc < cells; oc++) {
      const c = cellOrder[oc];
      const s1 = start[c + 1];
      let s = start[c];
      if (s === s1) continue;
      const cy = (c / cols) | 0;
      const cx = c - cy * cols;
      const ry0 = cy > 0 ? cy - 1 : 0;
      const ry1 = cy < rows - 1 ? cy + 1 : rows - 1;
      const rx0 = cx > 0 ? cx - 1 : 0;
      const rx1 = cx < cols - 1 ? cx + 1 : cols - 1;

      for (; s < s1; s++) {
        const i = order[s];
        let xi = x[i], yi = y[i];
        const pxi = px[i], pyi = py[i];
        let count = 0;
        let cov = 0;
        let lit = 0;

        for (let ry = ry0; ry <= ry1; ry++) {
          const base = ry * cols;
          for (let rx = rx0; rx <= rx1; rx++) {
            const cc = base + rx;
            const t1 = start[cc + 1];
            for (let t = start[cc]; t < t1; t++) {
              const j = order[t];
              if (j === i) continue;
              const dx = x[j] - xi;
              const dy = y[j] - yi;
              const d2 = dx * dx + dy * dy;
              if (d2 >= DS2 || d2 < 1e-12) continue;
              pairs++;

              const d = Math.sqrt(d2);
              const inv = 1 / d;
              const nx = dx * inv;
              const ny = dy * inv;

              // Shading: neighbour count, how much of the load sits on the
              // anti-gravity side, and the brightest neighbour up there. The
              // last one lets light seep down through the bed one layer per
              // frame, which is what produces a depth gradient instead of a
              // flat dark slab. Reads last frame's light, so order-independent.
              count++;
              const above = -(nx * gdx + ny * gdy);
              if (above > 0) {
                cov += above;
                const lj = light[j];
                if (lj > lit) lit = lj;
              }

              if (d2 >= D2) continue;
              const overlap = D - d;
              const sep = overlap * half;
              xi -= nx * sep;
              yi -= ny * sep;
              x[j] += nx * sep;
              y[j] += ny * sep;

              // Friction acts on the tangential part of this substep's
              // relative motion. Inside the static cone it is cancelled
              // outright; beyond it, sliding is limited by muK * penetration.
              let tx = (xi - pxi) - (x[j] - px[j]);
              let ty = (yi - pyi) - (y[j] - py[j]);
              const dn = tx * nx + ty * ny;
              tx -= dn * nx;
              ty -= dn * ny;
              const t2 = tx * tx + ty * ty;
              if (t2 > 1e-10) {
                const tl = Math.sqrt(t2);
                const k = (tl < muS * overlap
                  ? 0.5
                  : Math.min((muK * overlap) / tl, 1) * 0.5) * relax;
                const fx = tx * k;
                const fy = ty * k;
                xi -= fx;
                yi -= fy;
                x[j] += fx;
                y[j] += fy;
              }
            }
          }
        }

        x[i] = xi;
        y[i] = yi;
        contacts[i] = count > 255 ? 255 : count;
        cover[i] = cov;
        litAbove[i] = lit;
      }
    }
    this.solvedPairs += pairs;
  }

  /**
   * Container walls, enforced after the neighbour sweep rather than inside it.
   * Done per-grain mid-sweep, every neighbour resolved afterwards shoves floor
   * grains straight back through the floor, and the leftover position delta
   * reads as a few hundred px/s that never dissipates — the whole bed simmers.
   *
   * Dragging the previous position along with the clamp is what makes the wall
   * inelastic: the normal velocity derives to exactly zero. Pulling the
   * tangential delta back toward the previous position is the wall friction.
   */
  applyWalls() {
    const n = this.n;
    const x = this.x, y = this.y, px = this.px, py = this.py;
    const b = this.inner;
    const wf = 1 - CONFIG.sim.wallFriction;

    for (let i = 0; i < n; i++) {
      const xi = x[i];
      if (xi < b.x0 || xi > b.x1) {
        x[i] = xi < b.x0 ? b.x0 : b.x1;
        px[i] = x[i];
        y[i] = py[i] + (y[i] - py[i]) * wf;
      }
      const yi = y[i];
      if (yi < b.y0 || yi > b.y1) {
        y[i] = yi < b.y0 ? b.y0 : b.y1;
        py[i] = y[i];
        x[i] = px[i] + (x[i] - px[i]) * wf;
      }
    }
  }

  deriveVelocity(dt) {
    const n = this.n;
    const cfg = CONFIG.sim;
    const x = this.x, y = this.y, px = this.px, py = this.py;
    const vx = this.vx, vy = this.vy, contacts = this.contacts;
    const invDt = 1 / dt;
    const ceiling = (cfg.speedCeiling * this.cellSize) / dt;
    const ceiling2 = ceiling * ceiling;
    const sleep2 = cfg.sleepSpeed * cfg.sleepSpeed;
    const sleepContacts = cfg.sleepContacts;

    for (let i = 0; i < n; i++) {
      let sx = (x[i] - px[i]) * invDt;
      let sy = (y[i] - py[i]) * invDt;
      const s2 = sx * sx + sy * sy;
      if (s2 > ceiling2) {
        const k = ceiling / Math.sqrt(s2);
        sx *= k;
        sy *= k;
      } else if (s2 < sleep2 && contacts[i] >= sleepContacts) {
        // Stiction: without this, a pile creeps downhill forever and slowly
        // flattens instead of holding an angle of repose.
        sx = 0;
        sy = 0;
      }
      vx[i] = sx;
      vy[i] = sy;
    }
  }

  updateShading(dt) {
    const n = this.n;
    const cfg = CONFIG.sim;
    const light = this.light, cover = this.cover, contacts = this.contacts;
    const litAbove = this.litAbove;
    const vx = this.vx, vy = this.vy, speed01 = this.speed01;
    const invCover = 1 / cfg.coverNorm;
    const invSpeed = 1 / this.speedNorm;
    const blend = 1 - Math.exp(-cfg.lightSmoothing * dt);
    const transmit = cfg.lightTransmit;

    for (let i = 0; i < n; i++) {
      const buried = clamp(cover[i] * invCover, 0, 1);
      const loose = 1 - clamp(contacts[i] / 5, 0, 1);
      // Lit if nothing is above you, or if you are barely touching anything...
      const exposed = Math.max(1 - buried, loose * 0.95);
      // ...otherwise take what filters down from the grain above you.
      const target = Math.max(exposed, litAbove[i] * transmit);
      light[i] += (target - light[i]) * blend;
      speed01[i] = clamp(Math.hypot(vx[i], vy[i]) * invSpeed, 0, 1);
    }
  }
}
