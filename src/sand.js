// Granular sand as position-based dynamics in a shallow 3D box, over a uniform
// spatial hash. The screen is the front glass; the box extends a few grain
// diameters in Z behind it.
//
// Per substep: integrate -> rebuild grid -> relax contacts a few times ->
// derive velocity from the position change. Contacts do two jobs at once:
// separation (grains are incompressible) and Coulomb-ish friction (grains have
// shear strength, which is what produces a pile instead of a puddle).
//
// Sleep is hysteretic and does the heavy lifting for both stillness and pile
// permanence. A slow, well-supported grain goes fully dormant: it skips
// integration, receives no corrections, and acts as an immovable obstacle. It
// wakes only when pushed hard enough (an avalanche arriving), when gravity
// swings (the phone tilted), or when poked/splashed. A fully asleep bed costs
// almost nothing and is pixel-still — no simmering, no stick-slip shimmer.
//
// The same neighbour scan also accumulates the shading terms, so the depth
// look costs almost nothing: `contacts` says how packed a grain is, `cover`
// how buried it is along gravity, and `litAbove` lets light seep down through
// the bed one layer per frame.

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
    this.z = f32();
    this.px = f32();
    this.py = f32();
    this.pz = f32();
    this.vx = f32();
    this.vy = f32();
    this.vz = f32();
    this.light = f32();
    this.speed01 = f32();
    this.sizeJitter = f32();
    this.hueJitter = f32();
    this.contacts = new Uint8Array(capacity);
    this.cover = f32();
    this.litAbove = f32();
    this.sleep = new Uint8Array(capacity);
    this.wake = new Uint8Array(capacity);
    this.justWoke = new Uint8Array(capacity);
    this.sleepDebt = new Uint8Array(capacity); // consecutive slow frames
    this.pushOn = f32(); // accumulated push against a sleeping grain, per frame
    // Position at the start of the frame, for the sleep decision. Judged on
    // net frame displacement — instantaneous velocity would keep every grain
    // that solver churn jiggles in place awake forever.
    this.fx = f32();
    this.fy = f32();
    this.fz = f32();

    this.grid = new Grid(capacity);
    this.random = makeRandom(0x5117);

    this.radius = 4;
    this.diameter = 8;
    this.cellSize = 10;
    this.depth = 36;
    this.bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
    this.inner = { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 };
    this.speedNorm = 400;
    this.gravityMagnitude = 3000;
    this.substeps = 1;
    this.iterations = CONFIG.sim.solveBudget;
    this.solvedPairs = 0;
    this.awakeCount = 0;

    // Gravity direction at the last global wake; swinging past the threshold
    // wakes the whole bed so it slumps as a mass instead of peeling in layers.
    this._refGx = 0;
    this._refGy = 1;
    this._refGz = 0;
    this._refSet = false;
    this._wakeCos = Math.cos((CONFIG.sim.gravityWakeAngle * Math.PI) / 180);
    this._dragTable = null;
  }

  /** Set the box size and grain size; keeps existing grains in place. */
  configure(width, height, radius) {
    this.radius = radius;
    this.diameter = radius * 2;
    this.cellSize = this.diameter * CONFIG.grain.cellMul;
    this.depth = Math.max(
      this.diameter * 2,
      Math.min(CONFIG.bed.depthLayers * this.diameter, Math.min(width, height) * 0.2),
    );
    this.bounds = { x0: 0, y0: 0, x1: width, y1: height };
    this.inner = {
      x0: radius,
      y0: radius,
      z0: radius,
      x1: Math.max(radius, width - radius),
      y1: Math.max(radius, height - radius),
      z1: Math.max(radius, this.depth - radius),
    };
    this.grid.configure(width, height, this.depth, this.cellSize);

    const g = CONFIG.sim.gravityScale * Math.hypot(width, height);
    this.gravityMagnitude = g;
    this.speedNorm = 0.3 * Math.sqrt(2 * g * height);

    // Grain size or box changed under a frozen bed: geometry no longer valid.
    this.wakeAll();
  }

  /** Grain count that fills `CONFIG.bed.fill` of the front view when settled. */
  idealCount(fill = CONFIG.bed.fill) {
    const { x1, y1 } = this.bounds;
    const grainVol = (4 / 3) * Math.PI * this.radius ** 3;
    const volume = x1 * (fill * y1) * this.depth;
    const ideal = (volume * CONFIG.bed.packing) / grainVol;
    const ceiling = Math.min(
      CONFIG.bed.maxGrains,
      this.capacity,
      (x1 * (0.6 * y1) * this.depth * CONFIG.bed.packing) / grainVol,
    );
    return Math.round(clamp(ideal, CONFIG.bed.minGrains, ceiling));
  }

  _spawnAt(i, x, y, z) {
    const rand = this.random;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = 0;
    this.vy[i] = 0;
    this.vz[i] = 0;
    this.light[i] = 0.5;
    this.speed01[i] = 0;
    this.sizeJitter[i] = rand();
    this.hueJitter[i] = rand();
    this.contacts[i] = 0;
    this.cover[i] = 0;
    this.litAbove[i] = 0;
    this.sleep[i] = 0;
    this.wake[i] = 0;
    this.justWoke[i] = 0;
    this.sleepDebt[i] = 0;
    this.pushOn[i] = 0;
  }

  /** Lay out a settled lattice at the bottom, so nothing explodes at t=0. */
  fill(count) {
    const n = Math.min(count, this.capacity);
    this.n = n;
    this.grid.ensureCapacity(n);

    const rand = this.random;
    const d = this.diameter;
    const b = this.inner;
    const perX = Math.max(1, Math.floor((b.x1 - b.x0) / d));
    const perZ = Math.max(1, Math.floor((b.z1 - b.z0) / (d * 0.9)) + 1);
    const perLayer = perX * perZ;
    const rowStep = d * 0.85;

    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / perLayer);
      const rem = i % perLayer;
      const zi = Math.floor(rem / perX);
      const xi = rem % perX;
      const stagger = (row + zi) % 2 ? this.radius : 0;
      const x = clamp(b.x0 + stagger + xi * d + (rand() - 0.5) * this.radius * 0.4, b.x0, b.x1);
      const y = clamp(this.inner.y1 - row * rowStep - (rand() - 0.5) * this.radius * 0.2, b.y0, b.y1);
      const z = clamp(b.z0 + zi * d * 0.9 + (rand() - 0.5) * this.radius * 0.4, b.z0, b.z1);
      this._spawnAt(i, x, y, z);
    }
    this.awakeCount = n;
    this._refSet = false;
  }

  /**
   * Grow/shrink the bed without disturbing the grains that stay. New grains
   * appear in a thin layer just above the current bed surface — NOT at the top
   * of the screen, which reads as the app spontaneously splashing in more sand
   * every time the quality tuner steps.
   */
  setCount(count) {
    const target = Math.min(Math.max(count, 0), this.capacity);
    if (target === this.n) return;
    if (target < this.n) {
      this.n = target;
      this.awakeCount = Math.min(this.awakeCount, target);
      return;
    }

    let bedTop = this.inner.y1;
    for (let i = 0; i < this.n; i++) if (this.y[i] < bedTop) bedTop = this.y[i];

    const rand = this.random;
    const d = this.diameter;
    const b = this.inner;
    const added = target - this.n;
    const perX = Math.max(1, Math.floor((b.x1 - b.x0) / d));
    const perZ = Math.max(1, Math.floor((b.z1 - b.z0) / (d * 0.9)) + 1);
    const perLayer = perX * perZ;

    for (let k = 0; k < added; k++) {
      const i = this.n + k;
      const row = Math.floor(k / perLayer);
      const x = b.x0 + rand() * (b.x1 - b.x0);
      const y = clamp(bedTop - d - row * d * 0.9, b.y0, b.y1);
      const z = b.z0 + rand() * (b.z1 - b.z0);
      this._spawnAt(i, x, y, z);
    }
    this.n = target;
    this.awakeCount += added;
    this.grid.ensureCapacity(target);
  }

  /** Nudge every grain back inside after a viewport change. */
  clampToBounds() {
    const b = this.inner;
    for (let i = 0; i < this.n; i++) {
      this.x[i] = clamp(this.x[i], b.x0, b.x1);
      this.y[i] = clamp(this.y[i], b.y0, b.y1);
      this.z[i] = clamp(this.z[i], b.z0, b.z1);
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];
      this.pz[i] = this.z[i];
    }
    this.wakeAll();
  }

  wakeAll() {
    if (this.n === 0) return;
    this.sleep.fill(0, 0, this.n);
    this.wake.fill(0, 0, this.n);
    // Deliberately NOT setting justWoke: a global wake (tilt, splash, resize)
    // should mobilise the bed with all its energy, not tiptoe out of sleep.
    this.sleepDebt.fill(0, 0, this.n);
    this.awakeCount = this.n;
  }

  /** Shake response: throw the bed into the air. */
  splash(strength) {
    this.wakeAll();
    const rand = this.random;
    const speed = this.speedNorm * CONFIG.sim.splashSpeed * strength;
    for (let i = 0; i < this.n; i++) {
      const a = rand() * Math.PI * 2;
      const m = speed * (0.35 + rand() * 0.65);
      this.vx[i] += Math.cos(a) * m;
      this.vy[i] += Math.sin(a) * m * 0.8 - m * 0.5;
      this.vz[i] += (rand() - 0.5) * m * 0.6;
    }
  }

  /** Push grains away from a screen point (a cylinder through the depth). */
  poke(cx, cy, dx, dy, dt) {
    const r = CONFIG.input.pokeRadius;
    const r2 = r * r;
    const wakeR2 = r2 * 2.25;
    const push = CONFIG.input.pokeStrength * dt;
    const dragScale = CONFIG.input.pokeDrag;
    const { x, y, vx, vy, sleep } = this;
    let woke = 0;
    for (let i = 0; i < this.n; i++) {
      const ox = x[i] - cx;
      const oy = y[i] - cy;
      const d2 = ox * ox + oy * oy;
      if (d2 > wakeR2) continue;
      if (sleep[i]) {
        sleep[i] = 0;
        woke++;
      }
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const falloff = 1 - d / r;
      const k = (push * falloff) / d;
      vx[i] += ox * k + dx * dragScale * falloff;
      vy[i] += oy * k + dy * dragScale * falloff;
    }
    this.awakeCount += woke;
  }

  step(dtFrame, gx, gy, gz) {
    const n = this.n;
    if (n === 0) return;
    const cfg = CONFIG.sim;

    // Global wake on a real change of gravity direction. Without this, a
    // sleeping pile only mobilises where avalanching grains push on it — the
    // "back grains wait for the front" stickiness. With it, a hard tilt wakes
    // everything and the bed slumps as one mass.
    const gmag = Math.hypot(gx, gy, gz) || 1;
    const gdx = gx / gmag;
    const gdy = gy / gmag;
    const gdz = gz / gmag;
    if (!this._refSet) {
      this._refGx = gdx;
      this._refGy = gdy;
      this._refGz = gdz;
      this._refSet = true;
    } else if (gdx * this._refGx + gdy * this._refGy + gdz * this._refGz < this._wakeCos) {
      this.wakeAll();
      this._refGx = gdx;
      this._refGy = gdy;
      this._refGz = gdz;
    }

    // Fully dormant bed: nothing to do. This is the common case at rest and
    // costs ~zero CPU (and therefore battery).
    if (this.awakeCount === 0) {
      this.substeps = 0;
      this.iterations = 0;
      this.solvedPairs = 0;
      return;
    }

    this.pushOn.fill(0, 0, n);

    // Pick a substep count that keeps the fastest grain's travel well under its
    // own diameter, so no pair is ever discovered already deeply interpenetrated.
    // A settled bed runs at one substep; only a splash pays for more.
    let maxV2 = 0;
    for (let i = 0; i < n; i++) {
      const s = this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i] + this.vz[i] * this.vz[i];
      if (s > maxV2) maxV2 = s;
    }
    const travel = cfg.substepTravel * this.diameter;
    const needed = Math.ceil((Math.sqrt(maxV2) * dtFrame) / travel);
    const substeps = clamp(needed || 1, 1, cfg.maxSubsteps);
    const dt = dtFrame / substeps;
    this.substeps = substeps;

    // Spend a fixed sweep budget: substeps first (they do more for a moving bed
    // than iterations do), whatever is left on iterations.
    const iterations = clamp(Math.round(cfg.solveBudget / substeps), 1, cfg.maxIterations);
    this.iterations = iterations;

    const cellOrder = this.grid.orderCellsByGravity(gx, gy, gz);

    // Frame-start snapshot for the sleep decision.
    this.fx.set(this.x.subarray(0, n));
    this.fy.set(this.y.subarray(0, n));
    this.fz.set(this.z.subarray(0, n));

    this.solvedPairs = 0;
    for (let s = 0; s < substeps; s++) {
      this.integrate(dt, gx, gy, gz);
      this.grid.build(this.x, this.y, this.z, n);
      // Walls before the sweep so it relaxes against legal positions, and again
      // after so nothing is left hanging outside the box. Wake bookkeeping only
      // on the final sweep: approach is measured from the substep's start, so
      // collecting it every iteration would count the same displacement once
      // per sweep and wake sleepers off pure solver noise.
      for (let it = 0; it < iterations; it++) {
        this.applyWalls();
        this.solve(cellOrder, gdx, gdy, gdz, it === iterations - 1);
      }
      this.applyWalls();
      this.deriveVelocity(dt);
    }
    this.sleepPass(dtFrame);
    this.updateShading(dtFrame);
  }

  integrate(dt, gx, gy, gz) {
    const n = this.n;
    const damp = Math.exp(-CONFIG.sim.airDrag * dt);
    const { x, y, z, px, py, pz, vx, vy, vz, sleep, wake } = this;
    const dvx = gx * dt;
    const dvy = gy * dt;
    const dvz = gz * dt;
    const justWoke = this.justWoke;
    for (let i = 0; i < n; i++) {
      if (sleep[i]) {
        if (wake[i]) {
          sleep[i] = 0;
          wake[i] = 0;
          // Woken by pressure or pinch: relax positionally but do not convert
          // the stored compression into a jump (see deriveVelocity).
          justWoke[i] = 1;
        } else {
          // Dormant: hold position exactly. px==x means zero derived velocity.
          px[i] = x[i];
          py[i] = y[i];
          pz[i] = z[i];
          continue;
        }
      }
      const nvx = (vx[i] + dvx) * damp;
      const nvy = (vy[i] + dvy) * damp;
      const nvz = (vz[i] + dvz) * damp;
      vx[i] = nvx;
      vy[i] = nvy;
      vz[i] = nvz;
      px[i] = x[i];
      py[i] = y[i];
      pz[i] = z[i];
      x[i] += nvx * dt;
      y[i] += nvy * dt;
      z[i] += nvz * dt;
    }
  }

  /**
   * One Gauss-Seidel relaxation sweep over the 3x3x3 neighbourhood. Corrections
   * are applied immediately and grains are visited deepest-first along gravity,
   * so support propagates up through a pile in a single sweep.
   *
   * Sleeping grains do not scan and are immovable to those that do: an awake
   * grain takes the full separation against them, and the push it *would* have
   * delivered accumulates in pushOn[] — past the wake threshold, the sleeper
   * joins the avalanche next substep.
   */
  solve(cellOrder, gdx, gdy, gdz, collectWake) {
    const grid = this.grid;
    const cols = grid.cols, rows = grid.rows, slabs = grid.slabs;
    const layer = cols * rows;
    const cells = grid.cellCount;
    const start = grid.cellStart, order = grid.order;
    const { x, y, z, px, py, pz, vx, vy, vz, contacts, cover, light, litAbove, sleep, wake, pushOn } = this;
    const cfg = CONFIG.sim;
    const D = this.diameter;
    const D2 = D * D;
    const DS = D * cfg.shadeRadius;
    const DS2 = DS * DS;
    const half = cfg.stiffness * 0.5;
    const maxSep = cfg.maxSeparation * D;
    const wakeAt = cfg.wakePressure * D;
    const pinchWake = cfg.pinchWake * D;
    const wakeSpeed = cfg.wakeSpeed * D;
    const wakeSpeed2 = wakeSpeed * wakeSpeed;
    const muS = cfg.muS, muK = cfg.muK;
    const pressFloor = cfg.frictionPressureFloor * D;
    // A grain has up to twelve contacts and each one resolves in sequence, so
    // full-strength friction over-corrects and jitters. Under-relax it.
    const relax = cfg.frictionRelax;
    let pairs = 0;
    let woke = 0;

    for (let oc = 0; oc < cells; oc++) {
      const c = cellOrder[oc];
      const s1 = start[c + 1];
      let s = start[c];
      if (s === s1) continue;
      const cz = (c / layer) | 0;
      const rest = c - cz * layer;
      const cy = (rest / cols) | 0;
      const cx = rest - cy * cols;
      const ry0 = cy > 0 ? cy - 1 : 0;
      const ry1 = cy < rows - 1 ? cy + 1 : rows - 1;
      const rx0 = cx > 0 ? cx - 1 : 0;
      const rx1 = cx < cols - 1 ? cx + 1 : cols - 1;
      const rz0 = cz > 0 ? cz - 1 : 0;
      const rz1 = cz < slabs - 1 ? cz + 1 : slabs - 1;

      for (; s < s1; s++) {
        const i = order[s];
        if (sleep[i]) continue;
        let xi = x[i], yi = y[i], zi = z[i];
        const pxi = px[i], pyi = py[i], pzi = pz[i];
        // Only a grain that is genuinely travelling may wake sleepers. A grain
        // merely resting on one still free-falls into it by g*dt^2 every
        // substep before separation undoes it, and that reads as "approach" —
        // without this gate the entire bed floor gets woken by its own weight,
        // frame after frame, forever.
        const canWake = collectWake &&
          vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i] > wakeSpeed2;
        let count = 0;
        let cov = 0;
        let lit = 0;

        for (let rz = rz0; rz <= rz1; rz++) {
          const zbase = rz * layer;
          for (let ry = ry0; ry <= ry1; ry++) {
            const base = zbase + ry * cols;
            for (let rx = rx0; rx <= rx1; rx++) {
              const cc = base + rx;
              const t1 = start[cc + 1];
              for (let t = start[cc]; t < t1; t++) {
                const j = order[t];
                if (j === i) continue;
                const dx = x[j] - xi;
                const dy = y[j] - yi;
                const dz = z[j] - zi;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 >= DS2) continue;
                pairs++;

                let d, nx, ny, nz;
                if (d2 > 1e-8) {
                  d = Math.sqrt(d2);
                  const inv = 1 / d;
                  nx = dx * inv;
                  ny = dy * inv;
                  nz = dz * inv;
                } else {
                  // Coincident grains have no contact normal. Skipping them
                  // (the obvious guard) welds the pair together permanently,
                  // so pick a deterministic direction from the index instead.
                  const a = i * 2.3999632;
                  d = 0;
                  nx = Math.cos(a) * 0.94;
                  ny = Math.sin(a) * 0.94;
                  nz = 0.34;
                }

                // Shading terms, from the scan we are already paying for.
                count++;
                const above = -(nx * gdx + ny * gdy + nz * gdz);
                if (above > 0) {
                  cov += above;
                  const lj = light[j];
                  if (lj > lit) lit = lj;
                }

                if (d2 >= D2) continue;
                const overlap = D - d;
                const sepBase = overlap < maxSep ? overlap : maxSep;

                if (sleep[j]) {
                  // Immovable neighbour: take the whole correction ourselves.
                  const sep = sepBase * cfg.stiffness;
                  xi -= nx * sep;
                  yi -= ny * sep;
                  zi -= nz * sep;
                  if (canWake) {
                    // Wake it only on *approach* — how far we actually moved
                    // into it this substep. Counting the static overlap instead
                    // would wake every load-bearing grain every frame just for
                    // holding the pile up. Signed sum, clamped at zero, so
                    // back-and-forth churn nets out and only a sustained shove
                    // (an avalanche arriving) accumulates.
                    const approach = (xi - pxi) * nx + (yi - pyi) * ny + (zi - pzi) * nz;
                    let p = pushOn[j] + approach;
                    if (p < 0) p = 0;
                    pushOn[j] = p;
                    // Also wake on deep static overlap: a pocket that froze too
                    // small leaves its occupant rattling between immovable
                    // walls forever, visibly sunk into its neighbours.
                    if ((p > wakeAt || overlap > pinchWake) && !wake[j]) {
                      wake[j] = 1;
                      woke++;
                    }
                  }
                } else {
                  const sep = sepBase * half;
                  xi -= nx * sep;
                  yi -= ny * sep;
                  zi -= nz * sep;
                  x[j] += nx * sep;
                  y[j] += ny * sep;
                  z[j] += nz * sep;
                }

                // Friction acts on the tangential part of this substep's
                // relative motion. Inside the static cone it is cancelled
                // outright; beyond it, sliding is limited by muK * pressure.
                let tx = (xi - pxi) - (x[j] - px[j]);
                let ty = (yi - pyi) - (y[j] - py[j]);
                let tz = (zi - pzi) - (z[j] - pz[j]);
                const dn = tx * nx + ty * ny + tz * nz;
                tx -= dn * nx;
                ty -= dn * ny;
                tz -= dn * nz;
                const t2 = tx * tx + ty * ty + tz * tz;
                if (t2 > 1e-10) {
                  const tl = Math.sqrt(t2);
                  // Penetration depth stands in for normal force, with a floor
                  // so lightly loaded surface grains get some grip too.
                  const press = overlap > pressFloor ? overlap : pressFloor;
                  const k = (tl < muS * press
                    ? 0.5
                    : Math.min((muK * press) / tl, 1) * 0.5) * relax;
                  const fx = tx * k;
                  const fy = ty * k;
                  const fz = tz * k;
                  xi -= fx;
                  yi -= fy;
                  zi -= fz;
                  if (!sleep[j]) {
                    x[j] += fx;
                    y[j] += fy;
                    z[j] += fz;
                  }
                }
              }
            }
          }
        }

        x[i] = xi;
        y[i] = yi;
        z[i] = zi;
        contacts[i] = count > 255 ? 255 : count;
        cover[i] = cov;
        litAbove[i] = lit;
      }
    }
    this.solvedPairs += pairs;
    this.awakeCount += woke; // woken grains re-enter the sim next integrate
  }

  /**
   * Box walls (the screen is the z0 glass), as a push-out clamped exactly like
   * a grain-grain contact rather than a hard snap to the boundary.
   *
   * The hard snap is the tempting version and it fails twice over: it drops two
   * stacked grains onto the same wall coordinate (welding them into a permanent
   * 100%-overlap pair), and, run mid-sweep, every neighbour resolved afterwards
   * shoves wall grains back through the wall, leaving a few hundred px/s of
   * residue that never dissipates and simmers the whole bed.
   *
   * Dragging the previous position along makes the wall inelastic: the normal
   * velocity derives to exactly zero. Pulling the tangential delta back toward
   * the previous position is the wall friction.
   */
  applyWalls() {
    const n = this.n;
    const { x, y, z, px, py, pz, sleep } = this;
    const b = this.inner;
    const wf = 1 - CONFIG.sim.wallFriction;
    const maxPush = CONFIG.sim.maxSeparation * this.diameter;

    for (let i = 0; i < n; i++) {
      if (sleep[i]) continue;
      let pen = b.x0 - x[i];
      if (pen > 0) {
        x[i] += pen < maxPush ? pen : maxPush;
        px[i] = x[i];
        y[i] = py[i] + (y[i] - py[i]) * wf;
        z[i] = pz[i] + (z[i] - pz[i]) * wf;
      } else {
        pen = x[i] - b.x1;
        if (pen > 0) {
          x[i] -= pen < maxPush ? pen : maxPush;
          px[i] = x[i];
          y[i] = py[i] + (y[i] - py[i]) * wf;
          z[i] = pz[i] + (z[i] - pz[i]) * wf;
        }
      }

      pen = b.y0 - y[i];
      if (pen > 0) {
        y[i] += pen < maxPush ? pen : maxPush;
        py[i] = y[i];
        x[i] = px[i] + (x[i] - px[i]) * wf;
        z[i] = pz[i] + (z[i] - pz[i]) * wf;
      } else {
        pen = y[i] - b.y1;
        if (pen > 0) {
          y[i] -= pen < maxPush ? pen : maxPush;
          py[i] = y[i];
          x[i] = px[i] + (x[i] - px[i]) * wf;
          z[i] = pz[i] + (z[i] - pz[i]) * wf;
        }
      }

      pen = b.z0 - z[i];
      if (pen > 0) {
        z[i] += pen < maxPush ? pen : maxPush;
        pz[i] = z[i];
        x[i] = px[i] + (x[i] - px[i]) * wf;
        y[i] = py[i] + (y[i] - py[i]) * wf;
      } else {
        pen = z[i] - b.z1;
        if (pen > 0) {
          z[i] -= pen < maxPush ? pen : maxPush;
          pz[i] = z[i];
          x[i] = px[i] + (x[i] - px[i]) * wf;
          y[i] = py[i] + (y[i] - py[i]) * wf;
        }
      }
    }
  }

  deriveVelocity(dt) {
    const n = this.n;
    const cfg = CONFIG.sim;
    const { x, y, z, px, py, pz, vx, vy, vz, contacts, sleep, justWoke } = this;
    const invDt = 1 / dt;
    const ceiling = (cfg.speedCeiling * this.diameter) / dt;
    const ceiling2 = ceiling * ceiling;

    // Contact drag as a small lookup: `contacts` is a tiny integer, so this
    // avoids an exp() per grain per substep.
    const maxC = cfg.maxDragContacts;
    const drag = this._dragTable || (this._dragTable = new Float32Array(maxC + 1));
    for (let c = 0; c <= maxC; c++) drag[c] = Math.exp(-cfg.contactDrag * c * dt);
    const rollBelow = cfg.rollingBelow * cfg.sleepSpeed * this.diameter;
    const rollBelow2 = rollBelow * rollBelow;
    const rollDamp = Math.exp(-cfg.rollingDrag * dt);

    for (let i = 0; i < n; i++) {
      if (sleep[i]) {
        vx[i] = 0;
        vy[i] = 0;
        vz[i] = 0;
        continue;
      }
      const cnt = contacts[i];
      let k = drag[cnt < maxC ? cnt : maxC];
      // A grain woken by pressure/pinch is decompressing: its position change
      // this frame is stored solver penetration unwinding, not real motion.
      // Deriving velocity from it would fire the grain out like a spring and
      // set off a self-sustaining wake storm through the pile.
      if (justWoke[i]) k *= 0.05;
      let sx = (x[i] - px[i]) * invDt * k;
      let sy = (y[i] - py[i]) * invDt * k;
      let sz = (z[i] - pz[i]) * invDt * k;
      const s2 = sx * sx + sy * sy + sz * sz;
      if (s2 > ceiling2) {
        const k2 = ceiling / Math.sqrt(s2);
        sx *= k2;
        sy *= k2;
        sz *= k2;
      } else if (s2 < rollBelow2 && cnt > 0) {
        // Rolling resistance: real grains are angular and stop trundling almost
        // immediately; perfect spheres would trade momentum forever.
        sx *= rollDamp;
        sy *= rollDamp;
        sz *= rollDamp;
      }
      vx[i] = sx;
      vy[i] = sy;
      vz[i] = sz;
    }
  }

  /**
   * The sleep decision, once per frame. Judged on NET frame displacement, not
   * on instantaneous velocity: a grain squeezed between sleeping neighbours is
   * shoved back and forth by the solver every sweep — its derived velocity
   * looks fast forever even though it goes nowhere, so a velocity gate would
   * keep it (and every grain like it) permanently awake. Net displacement
   * cancels the oscillation and measures actual travel.
   */
  sleepPass(dtFrame) {
    const n = this.n;
    const cfg = CONFIG.sim;
    const { x, y, z, fx, fy, fz, px, py, pz, vx, vy, vz, contacts, sleep, sleepDebt, justWoke } = this;
    const sleepDelay = cfg.sleepDelay;
    const sleepContacts = cfg.sleepContacts;
    const enter = cfg.sleepSpeed * this.diameter * dtFrame; // px of net travel
    const enter2 = enter * enter;
    // A wall is worth two grains of support: a lone grain on the floor or a
    // tripod resting against the glass could otherwise never reach the contact
    // quorum and would stay awake (and faintly restless) forever.
    const b = this.inner;
    const eps = 0.05 * this.diameter;
    const wx0 = b.x0 + eps, wx1 = b.x1 - eps;
    const wy0 = b.y0 + eps, wy1 = b.y1 - eps;
    const wz0 = b.z0 + eps, wz1 = b.z1 - eps;

    let awake = 0;
    for (let i = 0; i < n; i++) {
      if (sleep[i]) continue;
      justWoke[i] = 0;
      const dx = x[i] - fx[i];
      const dy = y[i] - fy[i];
      const dz = z[i] - fz[i];
      const d2 = dx * dx + dy * dy + dz * dz;

      if (d2 < enter2) {
        let support = contacts[i];
        if (support < sleepContacts) {
          const xi = x[i], yi = y[i], zi = z[i];
          if (xi <= wx0 || xi >= wx1) support += 2;
          if (yi <= wy0 || yi >= wy1) support += 2;
          if (zi <= wz0 || zi >= wz1) support += 2;
        }
        if (support >= sleepContacts) {
          // Slow and supported — but only dormant after staying that way for a
          // stretch. Sleeping on the first slow frame would re-freeze a freshly
          // woken bed before gravity gets a chance to accelerate it.
          if (++sleepDebt[i] >= sleepDelay) {
            sleep[i] = 1;
            sleepDebt[i] = 0;
            px[i] = x[i];
            py[i] = y[i];
            pz[i] = z[i];
            vx[i] = 0;
            vy[i] = 0;
            vz[i] = 0;
            continue;
          }
          awake++;
          continue;
        }
      }
      // Decay rather than reset: churn spikes a settling grain past the
      // threshold on odd frames, and a hard reset would keep the whole surface
      // layer hovering just short of dormancy forever.
      if (sleepDebt[i] > 0) sleepDebt[i] -= Math.min(2, sleepDebt[i]);
      awake++;
    }
    this.awakeCount = awake;
  }

  updateShading(dt) {
    const n = this.n;
    const cfg = CONFIG.sim;
    const { light, cover, contacts, litAbove, speed01, sleep, vx, vy, vz } = this;
    const invCover = 1 / cfg.coverNorm;
    const invSpeed = 1 / this.speedNorm;
    const blend = 1 - Math.exp(-cfg.lightSmoothing * dt);
    const transmit = cfg.lightTransmit;

    for (let i = 0; i < n; i++) {
      const buried = clamp(cover[i] * invCover, 0, 1);
      const loose = 1 - clamp(contacts[i] / 6, 0, 1);
      // Lit if nothing is above you, or if you are barely touching anything...
      const exposed = Math.max(1 - buried, loose * 0.95);
      // ...otherwise take what filters down from the grain above you.
      const target = Math.max(exposed, litAbove[i] * transmit);
      light[i] += (target - light[i]) * blend;
      speed01[i] = sleep[i]
        ? 0
        : clamp(Math.hypot(vx[i], vy[i], vz[i]) * invSpeed, 0, 1);
    }
  }
}
