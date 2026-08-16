// Water: Position Based Fluids (Macklin & Müller, 2013).
//
// Why not reuse the granular solver with friction turned off: a Coulomb contact
// solver with mu = 0 is not a liquid, it is a frictionless granular gas. It
// resists penetration but nothing else, so it stays compressible, bounces, and
// never develops the pressure gradient that makes water level itself out. A
// fluid needs a *density* constraint instead of a non-penetration one — every
// particle wants the same number of neighbours around it, which is what makes
// it flow, fill corners, and hold a flat surface.
//
// PBF solves that constraint the same way the sand solves contacts: predict,
// project, then read the velocity back out of the position change. So the
// expensive parts of the project carry straight over — the spatial hash, the
// fixed timestep, the tilt input, the shake pulse. What is different is the
// constraint itself and everything downstream of it.
//
// The one piece of real subtlety here is the boundary correction. This box is
// only a few particles deep, so most of the water is within a smoothing radius
// of the front or back glass. A particle there sees fewer neighbours than one
// in open fluid, reads as under-dense, and gets sucked into the wall — the
// whole body would creep into the glass and stick. `wallDensity` below adds
// back exactly the mass the missing half-space would have contributed.

import { CONFIG } from './config.js';
import { Grid } from './grid.js';
import { clamp, makeRandom } from './util.js';

// Poly6 is used for density and Spiky for its gradient (Poly6's gradient
// vanishes at r=0, so particles on top of each other would never separate).
// Both are written normalised to W(0) = 1, which drops h^9-sized constants out
// of the arithmetic; the only thing that has to survive is their *ratio*, and
// that is this number. See CONFIG.fluid for the derivation.
const GRAD_K = 2880 / 315;

// Scratch for the coincident-particle fallback. Module level so the inner
// loops stay allocation-free.
const SEP = new Float64Array(3);

/**
 * A separation direction for a pair that has collapsed onto the same point,
 * where the geometry offers none. Derived from the two indices, so it is the
 * same every frame (a random one would jitter the pair in place), and negated
 * for the partner so both halves of the pair push the same way apart.
 */
function scatterDir(i, j) {
  const lo = i < j ? i : j;
  const hi = i < j ? j : i;
  let h = (Math.imul(lo, 73856093) ^ Math.imul(hi, 19349663)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  const uz = ((h & 2047) / 2047) * 2 - 1;
  const phi = (((h >>> 11) & 2047) / 2047) * 6.283185307179586;
  const s = Math.sqrt(Math.max(0, 1 - uz * uz));
  const sign = i < j ? 1 : -1;
  SEP[0] = s * Math.cos(phi) * sign;
  SEP[1] = s * Math.sin(phi) * sign;
  SEP[2] = uz * sign;
}

export class Fluid {
  /**
   * @param {number} capacity
   * @param {object} def Which liquid this is. `tuning` is the solver's half
   *   (CONFIG.fluid and friends) and `look` the renderer's (CONFIG.water and
   *   friends); everything that separates honey from water lives in those two
   *   objects, so a new liquid is a config entry rather than a subclass.
   */
  constructor(capacity, def = {}) {
    this.kind = def.kind || 'water';
    this.label = def.label || 'Water';
    this.tuning = def.tuning || CONFIG.fluid;
    this.look = def.look || CONFIG.water;
    // Which pass in the renderer draws this. Every liquid takes the same one.
    this.render = 'fluid';
    // No into-screen lean. Sand uses one to pile against the back wall, but a
    // liquid answers a tilted gravity with a tilted surface: measured, the
    // sand's 0.45 put the back of the water 22px higher than the front, which
    // perspective then widened into a visible shelf. Water fills the box on its
    // own, so it does not need the cue.
    this.zBias = 0;
    this.capacity = capacity;
    this.n = 0;

    const f32 = () => new Float32Array(capacity);
    // Committed state.
    this.x = f32();
    this.y = f32();
    this.z = f32();
    this.vx = f32();
    this.vy = f32();
    this.vz = f32();
    // Predicted positions the constraint is solved against.
    this.px = f32();
    this.py = f32();
    this.pz = f32();
    // Per-iteration scratch.
    this.lambda = f32();
    this.dx = f32();
    this.dy = f32();
    this.dz = f32();
    this.density = f32();
    // Velocity smoothing target (XSPH) — written in one pass, applied in the
    // next, so particles all see the same velocity field.
    this.ax = f32();
    this.ay = f32();
    this.az = f32();
    // Wall-term gradient, carried from solveDensity to applyCorrection.
    this.wgx = f32();
    this.wgy = f32();
    this.wgz = f32();
    // Shading channel: normalised speed, which the renderer turns into foam.
    this.speed01 = f32();

    this.grid = new Grid(capacity);
    this.random = makeRandom(0x51F7);

    // Flat neighbour list, rebuilt once per substep and reused by every solver
    // iteration. Gathering is the expensive half, and it does not change while
    // the positions are only being nudged.
    this.maxNeighbours = this.tuning.maxNeighbours;
    this.nbr = new Int32Array(0);
    this.nbrCount = new Int32Array(capacity);

    this.radius = 8;
    this.diameter = 16;
    this.spacing = 16;
    this.smoothing = 32;
    this.restDensity = 1;
    this.depth = 32;
    this.bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
    this.inner = { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 };
    this.gravityMagnitude = 4000;
    this.speedNorm = 600;
    this.pokeRadius = 60;
    // Unit gravity from the last step, so a splash throws away from whichever
    // wall the water is currently lying against.
    this.gdx = 0;
    this.gdy = 1;
    this.gdz = 0;

    // Shake pulse, identical in shape to the sand's: an acceleration added to
    // gravity for a moment rather than a velocity handed to each particle.
    this.kickX = 0;
    this.kickY = 0;
    this.kickZ = 0;
    this.kickTime = 0;

    this.substeps = 1;
    this.iterations = this.tuning.solverIterations;
    this.contactCount = 0;
    this._carry = 0;
  }

  /**
   * Water picks a coarser particle than sand on purpose. Sand needs many
   * particles because every one of them is visible; water is drawn as a
   * surface, so its particles are hidden and can be several times larger for
   * the same amount of stuff in the box.
   */
  preferredRadius(width, height, qualityScale = 1) {
    const f = CONFIG.fluid;
    const base = clamp(Math.min(width, height) / f.divisor, f.minRadius, f.maxRadius);
    return clamp(base / Math.cbrt(qualityScale), f.minRadius, f.maxRadius);
  }

  configure(width, height, radius) {
    this.radius = radius;
    this.diameter = radius * 2;
    // Rest spacing is one diameter: the particle count and the fill volume are
    // derived from the same number in idealCount, so the body settles at the
    // fill level asked for instead of drifting to whatever the solver likes.
    this.spacing = this.diameter;
    this.smoothing = this.spacing * this.tuning.smoothingRatio;

    this.depth = Math.max(
      this.diameter * 2,
      Math.min(this.tuning.depthLayers * this.diameter, Math.min(width, height) * 0.22),
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
    // One cell per smoothing radius, so the 3x3x3 scan is exactly the kernel
    // support and nothing inside it is missed.
    this.grid.configure(width, height, this.depth, this.smoothing);

    this.restDensity = latticeDensity(this.spacing, this.smoothing);
    this.gravityMagnitude = CONFIG.sim.gravityScale * Math.hypot(width, height);
    this.speedNorm = 0.35 * Math.sqrt(2 * this.gravityMagnitude * height);
    this.pokeRadius = Math.max(
      CONFIG.input.pokeRadiusMin,
      Math.min(width, height) * CONFIG.input.pokeRadiusFrac,
    );
  }

  /** Same pinned-radius problem the sand has; same lever. */
  targetCount(width, height, qualityScale = 1) {
    const ideal = this.idealCount();
    const f = CONFIG.fluid;
    const pinned = Math.min(width, height) / f.divisor >= f.maxRadius;
    return pinned ? Math.round(ideal * Math.min(1, qualityScale)) : ideal;
  }

  /** Particle count that fills `this.tuning.fill` of the front view. */
  idealCount(fill = this.tuning.fill) {
    const { x1, y1 } = this.bounds;
    const volume = x1 * (fill * y1) * this.depth;
    const ideal = volume / (this.spacing * this.spacing * this.spacing);
    return Math.round(clamp(ideal, this.tuning.minParticles, Math.min(this.tuning.maxParticles, this.capacity)));
  }

  ensureNeighbourCapacity(n) {
    const need = n * this.maxNeighbours;
    if (this.nbr.length >= need) return;
    this.nbr = new Int32Array(need);
  }

  fill(count) {
    const n = Math.min(count, this.capacity);
    this.n = n;
    this.grid.ensureCapacity(n);
    this.ensureNeighbourCapacity(n);
    this.kickTime = 0;

    const rand = this.random;
    const b = this.inner;
    // Start on a lattice at rest spacing, jittered a little. Starting at rest
    // spacing matters: dropping water in over-packed hands the solver a large
    // density error on frame one and it answers with an explosion.
    const pitch = this.spacing;
    const perX = Math.max(1, Math.floor((b.x1 - b.x0) / pitch));
    const perZ = Math.max(1, Math.floor((b.z1 - b.z0) / pitch) + 1);
    const perLayer = perX * perZ;
    const rows = Math.ceil(n / perLayer);
    const surface = b.y1 - rows * pitch;

    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / perLayer);
      const rem = i % perLayer;
      const j = rem % perX;
      const k = Math.floor(rem / perX);
      this.x[i] = clamp(b.x0 + (j + 0.5) * pitch + (rand() - 0.5) * pitch * 0.2, b.x0, b.x1);
      this.y[i] = clamp(surface + row * pitch + (rand() - 0.5) * pitch * 0.2, b.y0, b.y1);
      this.z[i] = clamp(b.z0 + k * pitch + (rand() - 0.5) * pitch * 0.2, b.z0, b.z1);
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.vz[i] = 0;
      this.speed01[i] = 0;
    }
  }

  setCount(count) {
    const target = Math.min(Math.max(count, 0), this.capacity);
    if (target === this.n) return;
    if (target < this.n) {
      this.n = target;
      return;
    }
    // Growing: refill rather than sprinkling particles into a settled body,
    // where they would land inside their neighbours and blow the density
    // constraint apart.
    this.fill(target);
  }

  clampToBounds() {
    const b = this.inner;
    for (let i = 0; i < this.n; i++) {
      this.x[i] = clamp(this.x[i], b.x0, b.x1);
      this.y[i] = clamp(this.y[i], b.y0, b.y1);
      this.z[i] = clamp(this.z[i], b.z0, b.z1);
    }
  }

  /** Shake: jerk the container, exactly as the sand does. See Grains.splash. */
  splash(strength) {
    const rand = this.random;
    const cfg = CONFIG.sim;
    const g = this.gravityMagnitude || 1;
    let ux = -this.gdx;
    let uy = -this.gdy;
    let uz = -this.gdz;
    const lean = (rand() - 0.5) * 2 * cfg.splashLean;
    const tx = -uy * lean;
    const ty = ux * lean;
    ux += tx;
    uy += ty;
    const inv = 1 / (Math.hypot(ux, uy, uz) || 1);
    ux *= inv; uy *= inv; uz *= inv;
    const a = g * (cfg.splashAccel + cfg.splashGain * Math.max(0, strength - 1));
    this.kickX = ux * a;
    this.kickY = uy * a;
    this.kickZ = uz * a;
    this.kickTime = cfg.splashDuration;
  }

  poke(cx, cy, dragX, dragY, dt) {
    const r = this.pokeRadius;
    const r2 = r * r;
    const push = this.gravityMagnitude * CONFIG.input.pokeAccel * dt;
    const dragScale = CONFIG.input.pokeDrag;
    const { x, y, vx, vy } = this;
    for (let i = 0; i < this.n; i++) {
      const ox = x[i] - cx;
      const oy = y[i] - cy;
      const d2 = ox * ox + oy * oy;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const falloff = 1 - d / r;
      const k = (push * falloff) / d;
      vx[i] += ox * k + dragX * dragScale * falloff;
      vy[i] += oy * k + dragY * dragScale * falloff;
    }
  }

  // ------------------------------------------------------------------ stepping

  step(dtFrame, gx, gy, gz) {
    const n = this.n;
    if (n === 0) return;
    const cfg = CONFIG.fluid;

    const h = 1 / cfg.fixedHz;
    this._carry += dtFrame;
    let steps = Math.floor(this._carry / h);
    if (steps > cfg.maxSubsteps) steps = cfg.maxSubsteps;
    if (steps < 1) {
      if (this._carry < h) return;
      steps = 1;
    }
    this._carry -= steps * h;
    if (this._carry > h * cfg.maxSubsteps) this._carry = 0;
    this.substeps = steps;
    this.iterations = cfg.solverIterations;

    const gmag = Math.hypot(gx, gy, gz) || 1;
    this.gdx = gx / gmag;
    this.gdy = gy / gmag;
    this.gdz = gz / gmag;

    for (let s = 0; s < steps; s++) {
      let ax = gx;
      let ay = gy;
      let az = gz;
      if (this.kickTime > 0) {
        ax += this.kickX;
        ay += this.kickY;
        az += this.kickZ;
        this.kickTime -= h;
      }
      this.predict(h, ax, ay, az);
      this.grid.build(this.px, this.py, this.pz, n);
      this.gatherNeighbours();
      for (let it = 0; it < this.iterations; it++) {
        this.solveDensity();
        this.applyCorrection();
      }
      this.commit(h);
      // After commit, so the separation shows up in the next frame's velocity
      // rather than being read back as a spurious impulse this one.
      this.separate();
      this.viscosity();
      this.cohesion(h);
      this.adhesion(h);
    }
    this.updateShading(dtFrame);
  }

  predict(h, gx, gy, gz) {
    const n = this.n;
    const { x, y, z, px, py, pz, vx, vy, vz } = this;
    const damp = Math.exp(-this.tuning.drag * h);
    for (let i = 0; i < n; i++) {
      const nvx = (vx[i] + gx * h) * damp;
      const nvy = (vy[i] + gy * h) * damp;
      const nvz = (vz[i] + gz * h) * damp;
      vx[i] = nvx; vy[i] = nvy; vz[i] = nvz;
      px[i] = x[i] + nvx * h;
      py[i] = y[i] + nvy * h;
      pz[i] = z[i] + nvz * h;
    }
    this.project(px, py, pz, n);
  }

  /** Keep predicted positions inside the glass. */
  project(px, py, pz, n) {
    const b = this.inner;
    for (let i = 0; i < n; i++) {
      if (px[i] < b.x0) px[i] = b.x0; else if (px[i] > b.x1) px[i] = b.x1;
      if (py[i] < b.y0) py[i] = b.y0; else if (py[i] > b.y1) py[i] = b.y1;
      if (pz[i] < b.z0) pz[i] = b.z0; else if (pz[i] > b.z1) pz[i] = b.z1;
    }
  }

  gatherNeighbours() {
    const n = this.n;
    const grid = this.grid;
    const { px, py, pz, nbr, nbrCount } = this;
    const cap = this.maxNeighbours;
    const hh = this.smoothing;
    const h2 = hh * hh;
    const cols = grid.cols;
    const rows = grid.rows;
    const slabs = grid.slabs;
    const layer = cols * rows;
    const start = grid.cellStart;
    const order = grid.order;
    const inv = 1 / grid.cellSize;
    let total = 0;

    for (let i = 0; i < n; i++) {
      const xi = px[i], yi = py[i], zi = pz[i];
      let cx = (xi * inv) | 0, cy = (yi * inv) | 0, cz = (zi * inv) | 0;
      if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
      if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
      if (cz < 0) cz = 0; else if (cz >= slabs) cz = slabs - 1;

      let count = 0;
      const base = i * cap;
      const z0 = cz > 0 ? cz - 1 : 0, z1 = cz < slabs - 1 ? cz + 1 : slabs - 1;
      const y0 = cy > 0 ? cy - 1 : 0, y1 = cy < rows - 1 ? cy + 1 : rows - 1;
      const x0 = cx > 0 ? cx - 1 : 0, x1 = cx < cols - 1 ? cx + 1 : cols - 1;
      for (let bz = z0; bz <= z1; bz++) {
        for (let by = y0; by <= y1; by++) {
          const rowBase = bz * layer + by * cols;
          const from = start[rowBase + x0];
          const to = start[rowBase + x1 + 1];
          for (let s = from; s < to; s++) {
            const j = order[s];
            if (j === i) continue;
            const dx = xi - px[j], dy = yi - py[j], dz = zi - pz[j];
            if (dx * dx + dy * dy + dz * dz >= h2) continue;
            if (count >= cap) break;
            nbr[base + count++] = j;
          }
          if (count >= cap) break;
        }
        if (count >= cap) break;
      }
      nbrCount[i] = count;
      total += count;
    }
    this.contactCount = total >> 1;
  }

  /**
   * Density, then the Lagrange multiplier that will correct it. Both loops run
   * over the whole fluid before anything moves (Jacobi, not Gauss-Seidel) —
   * with a shared constraint like density, solving in place makes the result
   * depend on particle ordering and the surface ends up visibly striped.
   */
  solveDensity() {
    const n = this.n;
    const { px, py, pz, nbr, nbrCount, lambda, density, wgx, wgy, wgz } = this;
    const cap = this.maxNeighbours;
    const hh = this.smoothing;
    const inv = 1 / hh;
    const gradK = GRAD_K * inv;
    const rho0 = this.restDensity;
    const eps = this.tuning.relaxation;
    const wallScale = this.tuning.wallDensity;

    for (let i = 0; i < n; i++) {
      const xi = px[i], yi = py[i], zi = pz[i];
      let rho = 1; // self contribution: W(0) = 1
      // Gradient with respect to this particle, and the sum of squared
      // gradients with respect to every neighbour.
      let gx = 0, gy = 0, gz = 0, sumSq = 0;
      const base = i * cap;
      const count = nbrCount[i];
      for (let k = 0; k < count; k++) {
        const j = nbr[base + k];
        const dx = xi - px[j], dy = yi - py[j], dz = zi - pz[j];
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r <= 1e-6 || r >= hh) continue;
        const q = r * inv;
        const w = 1 - q * q;
        rho += w * w * w;
        // Spiky falls off with distance, so its gradient points *toward* the
        // neighbour: dW/dr is negative. Dropping that minus sign inverts the
        // whole solver — over-dense particles pull together instead of pushing
        // apart, and the fluid collapses to a point.
        const gm = -(gradK * (1 - q) * (1 - q)) / r;
        const cx = dx * gm, cy = dy * gm, cz = dz * gm;
        gx += cx; gy += cy; gz += cz;
        sumSq += cx * cx + cy * cy + cz * cz;
      }

      // The glass cuts the kernel short. Add back what the fluid on the other
      // side would have contributed, or every particle near a wall reads as
      // under-dense and the body creeps into the glass and sticks there.
      //
      // Combined as a union, not a sum. Where two walls meet, the regions they
      // cut off overlap, and adding the terms counts that corner twice — in a
      // box only a few particles deep almost every particle touches a glass
      // *and* a side or the floor, so the double count is the common case, not
      // the exception. Summed, it drove bulk density to 1.5x rest, a pressure
      // the solver can never relieve by moving anything, and the fluid extruded
      // itself up the walls in permanent standing columns.
      //
      // And the term enters the *gradient*, not just the density. This is the
      // difference between a wall the water rests against and a wall it welds
      // to. Density alone raises C for a particle pinned on the glass, but
      // every correction then acts along neighbour directions — pushes into
      // the wall are clamped away, and nothing ever pushes it off, because
      // nothing says C would drop if it moved. Measured on a live standing
      // column: 58 particles all at exactly the wall x, static for minutes,
      // and removing the wall term collapsed it in two seconds. With the
      // gradient in place, an over-dense wall particle is pushed back into
      // the fluid, which is the lateral escape hydrostatics needs.
      // z runs from 0 (front glass) to depth (back glass). `bounds` has no z
      // fields — an earlier version read `bounds.z0` here, and the resulting
      // NaN was silently swallowed by wallDensity's final clamp, which meant
      // the front glass had no density term at all.
      const fx0 = wallDensity(xi - this.bounds.x0, hh);
      const fx1 = wallDensity(this.bounds.x1 - xi, hh);
      const fy0 = wallDensity(yi - this.bounds.y0, hh);
      const fy1 = wallDensity(this.bounds.y1 - yi, hh);
      const fz0 = wallDensity(zi, hh);
      const fz1 = wallDensity(this.depth - zi, hh);
      const missing =
        (1 - fx0) * (1 - fx1) * (1 - fy0) * (1 - fy1) * (1 - fz0) * (1 - fz1);
      rho += rho0 * (1 - missing) * wallScale;

      // d(union)/dp = f'_k * PROD_{m!=k}(1-f_m); the product for wall k is
      // missing/(1-f_k), safe because f never reaches 1 (it tops out at 0.5).
      // A near wall's density falls as the particle leaves it and the far
      // wall's rises, hence the signs.
      const wk = rho0 * wallScale;
      const gwx =
        (-wallDensityGrad(xi - this.bounds.x0, hh) * missing) / (1 - fx0) +
        (wallDensityGrad(this.bounds.x1 - xi, hh) * missing) / (1 - fx1);
      const gwy =
        (-wallDensityGrad(yi - this.bounds.y0, hh) * missing) / (1 - fy0) +
        (wallDensityGrad(this.bounds.y1 - yi, hh) * missing) / (1 - fy1);
      const gwz =
        (-wallDensityGrad(zi, hh) * missing) / (1 - fz0) +
        (wallDensityGrad(this.depth - zi, hh) * missing) / (1 - fz1);
      wgx[i] = gwx * wk;
      wgy[i] = gwy * wk;
      wgz[i] = gwz * wk;
      gx += wgx[i];
      gy += wgy[i];
      gz += wgz[i];

      density[i] = rho;
      const c = rho / rho0 - 1;
      if (c <= 0) {
        // Free surface: let it expand. Clamping here is what stops the surface
        // being pulled flat and lets waves and spray exist at all.
        lambda[i] = 0;
        continue;
      }
      sumSq += gx * gx + gy * gy + gz * gz;
      lambda[i] = -c / (sumSq / (rho0 * rho0) + eps);
    }
  }

  applyCorrection() {
    const n = this.n;
    const { px, py, pz, nbr, nbrCount, lambda, dx, dy, dz, wgx, wgy, wgz } = this;
    const cap = this.maxNeighbours;
    const hh = this.smoothing;
    const inv = 1 / hh;
    const gradK = GRAD_K * inv;
    const rho0 = this.restDensity;
    const k = this.tuning.surfacePressure;
    const dq = this.tuning.surfaceDistance;
    const wq = Math.pow(1 - dq * dq, 3);

    for (let i = 0; i < n; i++) {
      const xi = px[i], yi = py[i], zi = pz[i];
      const li = lambda[i];
      let ax = 0, ay = 0, az = 0;
      const base = i * cap;
      const count = nbrCount[i];
      for (let m = 0; m < count; m++) {
        const j = nbr[base + m];
        const ox = xi - px[j], oy = yi - py[j], oz = zi - pz[j];
        const r = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (r <= 1e-6 || r >= hh) continue;
        const q = r * inv;
        const w = 1 - q * q;
        // Artificial pressure. Without it particles clump into strands and
        // beads under the free surface (tensile instability) instead of
        // holding a sheet; with it they keep a small standoff and the surface
        // behaves as if it had surface tension.
        const s = -k * Math.pow((w * w * w) / wq, 4);
        const gm = -(gradK * (1 - q) * (1 - q)) / r; // see solveDensity

        const c = (li + lambda[j] + s) * gm;
        ax += ox * c; ay += oy * c; az += oz * c;
      }
      // The wall's own share of the constraint gradient. No partner lambda —
      // the wall is static and simply absorbs the momentum.
      ax += li * wgx[i];
      ay += li * wgy[i];
      az += li * wgz[i];
      const s = 1 / rho0;
      dx[i] = ax * s; dy[i] = ay * s; dz[i] = az * s;
    }

    const maxMove = this.spacing * this.tuning.maxCorrection;
    for (let i = 0; i < n; i++) {
      let mx = dx[i], my = dy[i], mz = dz[i];
      const m = Math.hypot(mx, my, mz);
      if (m > maxMove) {
        const t = maxMove / m;
        mx *= t; my *= t; mz *= t;
      }
      px[i] += mx; py[i] += my; pz[i] += mz;
    }
    this.project(px, py, pz, n);
  }

  /**
   * A hard floor on how close two particles may sit.
   *
   * The density constraint does not provide one, and cannot. A handful of
   * particles driven together by a splash forms a group that is *locally*
   * packed but *globally* under-dense — it has lost the neighbours that used
   * to surround it — so C comes out negative, lambda is clamped to zero at the
   * free surface, and no correction is ever generated. The group is welded
   * into a bead that survives forever, and because several particles are then
   * stacked on one point the thickness field spikes and draws it as a dark
   * blob. Left alone they accumulate: every splash makes a few more.
   *
   * So this is separate from the fluid pressure on purpose. It is unconditional
   * — it does not care what the density says — and it only ever acts on pairs
   * far closer than rest spacing, which normal compression never reaches.
   */
  separate() {
    const n = this.n;
    const { x, y, z, nbr, nbrCount, dx, dy, dz } = this;
    const cap = this.maxNeighbours;
    const minDist = this.spacing * this.tuning.minSeparation;
    const stiffness = this.tuning.separationStiffness;

    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i], zi = z[i];
      let ax = 0, ay = 0, az = 0;
      const base = i * cap;
      const count = nbrCount[i];
      for (let k = 0; k < count; k++) {
        const j = nbr[base + k];
        let ox = xi - x[j], oy = yi - y[j], oz = zi - z[j];
        const r = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (r >= minDist) continue;
        if (r > 1e-4) {
          const inv = 1 / r;
          ox *= inv; oy *= inv; oz *= inv;
        } else {
          // Exactly coincident, which the wall clamp produces readily: every
          // particle pushed past a wall lands on precisely the same plane.
          // There is no direction to separate along, so take a fixed one.
          scatterDir(i, j);
          ox = SEP[0]; oy = SEP[1]; oz = SEP[2];
        }
        // Each side of the pair sees this and takes half, so the neighbour's
        // own pass supplies the opposite push.
        const push = (minDist - r) * 0.5 * stiffness;
        ax += ox * push; ay += oy * push; az += oz * push;
      }
      dx[i] = ax; dy[i] = ay; dz[i] = az;
    }

    for (let i = 0; i < n; i++) {
      x[i] += dx[i]; y[i] += dy[i]; z[i] += dz[i];
    }
    this.project(x, y, z, n);
  }

  /** Read the velocity back out of the position change, PBD style. */
  commit(h) {
    const n = this.n;
    const { x, y, z, px, py, pz, vx, vy, vz } = this;
    const invH = 1 / h;
    const maxV = (this.spacing * this.tuning.maxTravel) / h;
    for (let i = 0; i < n; i++) {
      let ux = (px[i] - x[i]) * invH;
      let uy = (py[i] - y[i]) * invH;
      let uz = (pz[i] - z[i]) * invH;
      const m = Math.hypot(ux, uy, uz);
      if (m > maxV) {
        const t = maxV / m;
        ux *= t; uy *= t; uz *= t;
      }
      vx[i] = ux; vy[i] = uy; vz[i] = uz;
      x[i] = px[i]; y[i] = py[i]; z[i] = pz[i];
    }
  }

  /**
   * XSPH: nudge each particle toward the average velocity of its neighbours.
   * This is the whole of the fluid's viscosity — without it PBF is glassy and
   * every splash shatters instead of pouring.
   */
  viscosity() {
    const n = this.n;
    const { x, y, z, vx, vy, vz, ax, ay, az, nbr, nbrCount } = this;
    const cap = this.maxNeighbours;
    const hh = this.smoothing;
    const inv = 1 / hh;
    const c = this.tuning.viscosity;
    if (c <= 0) return;

    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i], zi = z[i];
      let sx = 0, sy = 0, sz = 0, wsum = 0;
      const base = i * cap;
      const count = nbrCount[i];
      for (let k = 0; k < count; k++) {
        const j = nbr[base + k];
        const dx = xi - x[j], dy = yi - y[j], dz = zi - z[j];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= hh * hh) continue;
        const q = Math.sqrt(r2) * inv;
        const w = 1 - q * q;
        const ww = w * w * w;
        sx += (vx[j] - vx[i]) * ww;
        sy += (vy[j] - vy[i]) * ww;
        sz += (vz[j] - vz[i]) * ww;
        wsum += ww;
      }
      if (wsum > 1e-6) {
        const s = c / wsum;
        ax[i] = vx[i] + sx * s;
        ay[i] = vy[i] + sy * s;
        az[i] = vz[i] + sz * s;
      } else {
        ax[i] = vx[i]; ay[i] = vy[i]; az[i] = vz[i];
      }
    }
    for (let i = 0; i < n; i++) {
      vx[i] = ax[i]; vy[i] = ay[i]; vz[i] = az[i];
    }
  }

  /**
   * Cohesion — surface tension, and the whole of what makes mercury mercury.
   *
   * The density constraint alone cannot produce it. Incompressibility says
   * every particle wants the same number of neighbours; it is indifferent to
   * where the *edge* of the liquid is, so a body has no reason to prefer a
   * small surface and simply takes the shape of whatever holds it. Water is
   * near enough to that at this scale. Mercury is not: it pulls itself into
   * beads, refuses to wet what it sits on, and merges on contact.
   *
   * Modelled as a pairwise attraction over the neighbour list the solver has
   * already gathered, and the load-bearing detail is *where the kernel starts*.
   * It is zero at and inside the rest spacing, rises beyond it, and falls back
   * to zero at the smoothing radius.
   *
   * Beginning at rest spacing is the whole of what makes it stable. Written
   * the obvious way — a kernel peaking at half the smoothing radius, which is
   * exactly the rest spacing — cohesion pulls hardest precisely where the
   * density constraint is pushing back, and the two form an undamped spring.
   * Measured, that did not settle at all: the body plateaued at an RMS of 177
   * px/s and stayed there indefinitely, where the same fluid without cohesion
   * reaches 0.1. It is the same trap the granular solver has, in a different
   * costume — a correction that fights the projection pumps energy in forever,
   * and no amount of damping hides it.
   *
   * Starting past rest spacing leaves the constraint alone: incompressibility
   * owns everything up to a particle's own size, and cohesion only ever pulls
   * back neighbours that are drifting apart. Which is what surface tension is.
   *
   * Applied to velocity rather than position for the same reason — an
   * attraction that moved particles directly would be undone by the next
   * constraint iteration, and the two would argue every substep.
   */
  cohesion(h) {
    const k = this.tuning.cohesion;
    if (!k) return;
    const n = this.n;
    const { x, y, z, vx, vy, vz, nbr, nbrCount } = this;
    const cap = this.maxNeighbours;
    const hh = this.smoothing;
    // Cohesion lives strictly between rest spacing and the smoothing radius.
    const rest = this.spacing;
    const span = hh - rest;
    if (span <= 0) return;
    const invSpan = 1 / span;
    // Strength is in GRAVITIES, and the accumulated direction below is an
    // average rather than a sum, so `cohesion` reads as "how hard the surface
    // pulls itself in, against how hard gravity pulls it down". Scaled any
    // other way the number means nothing: written first as a raw coefficient
    // times spacing, a plausible-looking 400 worked out at 9600 px/s^2 —
    // larger than gravity — which saturated the travel clamp on every surface
    // particle every substep and boiled the body permanently.
    const gain = k * this.gravityMagnitude * h;
    // Companion damping along each pair, and it is not optional — see below.
    const dampGain = this.tuning.cohesionDamp * h;
    // A cohesive body still has to be caught by the solver, so no single
    // substep may add more than a fraction of the travel cap.
    const maxDv = (this.spacing * this.tuning.maxTravel) / h * 0.25;

    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i], zi = z[i];
      const vxi = vx[i], vyi = vy[i], vzi = vz[i];
      let ax = 0, ay = 0, az = 0;      // attraction
      let bx = 0, by = 0, bz = 0;      // damping
      let wsum = 0;
      const base = i * cap;
      const count = nbrCount[i];
      for (let m = 0; m < count; m++) {
        const j = nbr[base + m];
        const dx = xi - x[j], dy = yi - y[j], dz = zi - z[j];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= hh * hh || r2 < 1e-8) continue;
        const r = Math.sqrt(r2);
        // Zero at and inside rest spacing — the density constraint owns that
        // range, and overlapping it is what turns cohesion into a spring.
        const u = (r - rest) * invSpan;
        if (u <= 0) continue;
        const om = 1 - u;
        const w = 16 * u * u * om * om;   // peaks at u = 0.5, normalised to 1
        const inv_r = 1 / r;
        const nx = dx * inv_r, ny = dy * inv_r, nz = dz * inv_r;
        ax -= nx * w; ay -= ny * w; az -= nz * w;   // toward the neighbour
        wsum += w;
        // Relative velocity along the pair, opposed. Without this the whole
        // term is an undamped spring stepped explicitly, which adds energy on
        // every cycle no matter how the kernel is shaped: measured, the body
        // never settled at all, plateauing at an RMS of 210 px/s against the
        // 1 px/s it reaches with cohesion off. Water hid it behind its own
        // viscosity; mercury is barely viscous by design and has nothing to
        // bleed it off, so the damping has to live here, with the force that
        // creates the oscillation.
        const rel = (vxi - vx[j]) * nx + (vyi - vy[j]) * ny + (vzi - vz[j]) * nz;
        const dw = w * rel;
        bx -= nx * dw; by -= ny * dw; bz -= nz * dw;
      }
      if (wsum < 1e-6) continue;
      // Averaged, not summed. Summed, the pull grows with however many
      // neighbours happen to be in range, so a denser patch pulls harder for
      // no physical reason and the strength has no stable meaning.
      const inv_w = 1 / wsum;
      let dvx = ax * inv_w * gain + bx * inv_w * dampGain;
      let dvy = ay * inv_w * gain + by * inv_w * dampGain;
      let dvz = az * inv_w * gain + bz * inv_w * dampGain;
      const mag = Math.hypot(dvx, dvy, dvz);
      if (mag > maxDv) {
        const t = maxDv / mag;
        dvx *= t; dvy *= t; dvz *= t;
      }
      vx[i] += dvx; vy[i] += dvy; vz[i] += dvz;
    }
  }

  /**
   * Wall adhesion: a liquid that wets the glass drags against it. Water barely
   * does at this scale, honey emphatically does — it is what leaves a coating
   * behind on a wall the body has flowed away from, and without it a thick
   * liquid is only a slow one.
   *
   * Modelled as tangential drag in a thin band along each wall, which is what
   * the no-slip boundary of a viscous liquid amounts to: the layer touching the
   * glass is held, and XSPH then carries that shear back into the body a
   * particle at a time. Applying it as a *velocity* damping rather than an
   * attraction is deliberate — an attractive force toward the wall would pull
   * the body flat against the glass and stick it there permanently, whereas
   * drag can only ever remove motion, so it can never manufacture a film that
   * was not already flowing.
   *
   * The front and back glass get their own strength, and it is the one that
   * matters. This box is only a few particles deep, so the glass is nearly all
   * of the wetted area: the liquid is a slab between two plates, and no-slip at
   * both plates is what makes a thick one crawl. Leaving the glass out — on the
   * reasoning that it would freeze everything — is what left honey behaving
   * exactly like water. Measured, the two were indistinguishable: a tilt drew
   * the same centre-of-mass curve to within a couple of pixels.
   *
   * That is also *why* it has to be a boundary effect rather than a bulk one.
   * XSPH only ever equalises neighbouring velocities, so a body sliding as a
   * plug has no shear for it to resist and viscosity does nothing. Bulk drag is
   * no better: gravity re-accelerates every substep, so drag only sets a
   * terminal velocity and, cranked hard enough to be slow, it deadens the shake
   * response too. Holding the liquid at the walls is what creates the shear
   * profile in the first place; XSPH then carries it into the body, and the
   * result slows down for the reason a real liquid does.
   *
   * The grip is deliberately NOT gated on speed. It once was, to keep a shaken
   * body falling at gravity: because a body in flight is unavoidably touching
   * both panes, no-slip decelerates a ballistic arc to about 40% of g. Fading
   * the grip out above a threshold does fix that, but the two regimes are only
   * about 1.5x apart in speed — a gripped tilt settles near 350 px/s, a shake
   * averages 540 — so no threshold separates them, and every setting that made
   * the fall look right also switched the grip off during ordinary tilting and
   * left the liquid behaving like water. Thickness is the whole point of a
   * thick liquid, so it wins: honey falls slowly, on purpose.
   */
  adhesion(h) {
    const lateral = this.tuning.adhesion;
    const glass = this.tuning.adhesionGlass;
    if (!lateral && !glass) return;
    const n = this.n;
    const { x, y, z, vx, vy, vz } = this;
    const b = this.inner;
    const band = this.spacing * this.tuning.adhesionBand;
    if (band <= 0) return;
    // Per-substep decay, so the amount of grip does not depend on timestep.
    const keepLat = Math.exp(-lateral * h);
    const keepGlass = Math.exp(-glass * h);
    // The gap between the plates is often thinner than the band, so grip from
    // the glass never reaches zero anywhere — which is the point.
    const zBand = Math.min(band, (b.z1 - b.z0) * 0.5);

    for (let i = 0; i < n; i++) {
      let f = 1;
      if (lateral) {
        const dx = Math.min(x[i] - b.x0, b.x1 - x[i]);
        const dy = Math.min(y[i] - b.y0, b.y1 - y[i]);
        const d = dx < dy ? dx : dy;
        if (d < band) f *= 1 - (1 - keepLat) * (1 - d / band);
      }
      if (glass && zBand > 0) {
        const dz = Math.min(z[i] - b.z0, b.z1 - z[i]);
        if (dz < zBand) f *= 1 - (1 - keepGlass) * (1 - dz / zBand);
      }
      if (f < 1) { vx[i] *= f; vy[i] *= f; vz[i] *= f; }
    }
  }

  updateShading(dt) {
    const n = this.n;
    const { vx, vy, vz, speed01 } = this;
    const invSpeed = 1 / this.speedNorm;
    const blend = 1 - Math.exp(-this.tuning.foamSmoothing * dt);
    for (let i = 0; i < n; i++) {
      const s = clamp(Math.hypot(vx[i], vy[i], vz[i]) * invSpeed, 0, 1);
      speed01[i] += (s - speed01[i]) * blend;
    }
  }
}

/**
 * Density of a particle sitting in an infinite lattice at `spacing`, measured
 * with the same kernel the solver uses. Deriving rest density this way rather
 * than picking a number means the fluid settles at exactly the spacing that
 * idealCount assumed, so the body fills the fraction of the box that was asked
 * for instead of swelling or collapsing to find its own level.
 */
function latticeDensity(spacing, smoothing) {
  const reach = Math.ceil(smoothing / spacing);
  let rho = 0;
  for (let a = -reach; a <= reach; a++) {
    for (let b = -reach; b <= reach; b++) {
      for (let c = -reach; c <= reach; c++) {
        const r = Math.sqrt(a * a + b * b + c * c) * spacing;
        if (r >= smoothing) continue;
        const w = 1 - (r / smoothing) ** 2;
        rho += w * w * w;
      }
    }
  }
  return rho;
}

/**
 * Fraction of a Poly6 kernel's mass lying beyond a flat wall at distance `d`.
 *
 * Exact, not fitted: the kernel integral over the cap past the plane works out
 * to 0.5 - (315/256) * P(s) with s = d/h. Multiplying this by the rest density
 * gives back exactly the contribution of the fluid that would have been there
 * if the wall were not.
 */
function wallDensity(d, smoothing) {
  const s = d / smoothing;
  if (s >= 1) return 0;
  if (s <= 0) return 0.5;
  const s2 = s * s;
  const s3 = s2 * s;
  const s5 = s3 * s2;
  const s7 = s5 * s2;
  const s9 = s7 * s2;
  const p = s - (4 / 3) * s3 + (6 / 5) * s5 - (4 / 7) * s7 + s9 / 9;
  const f = 0.5 - (315 / 256) * p;
  return f > 0 ? f : 0;
}

/**
 * Magnitude of d(wallDensity)/d(distance): how fast the missing-half-space
 * fraction shrinks as the particle backs away from the wall. P'(s) collapses
 * to (1-s^2)^4, so this is exact, not fitted, like wallDensity itself.
 */
function wallDensityGrad(d, smoothing) {
  const s = d / smoothing;
  // Written so NaN also lands in the zero branch: wallDensity happens to
  // swallow bad input via its final clamp, and this must fail the same way
  // rather than poison the whole solve.
  if (!(s >= 0 && s < 1)) return 0;
  const w = 1 - s * s;
  const w2 = w * w;
  return ((315 / 256) * w2 * w2) / smoothing;
}
