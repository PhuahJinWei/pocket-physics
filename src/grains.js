// Granular solver: velocity-level sequential impulses in a shallow 3D box.
//
// The screen is the front glass; the box extends a few grain diameters in Z.
// Grains are equal-mass spheres with no rotational degree of freedom, so
// friction is pure sliding friction. Radii are **polydisperse** (a spread
// around the mean): identical spheres crystallise into a regular lattice the
// moment they settle — visible as a woven grid across the whole bed — and no
// amount of jitter keeps them from finding it again. Real sand never
// crystallises for exactly this reason.
//
// Each fixed substep:
//   1. gravity and drag into velocity
//   2. find contacts (grain-grain and box walls)
//   3. VELOCITY pass — Gauss-Seidel impulses: non-penetration, then Coulomb
//      friction capped by the normal impulse accumulated so far
//   4. clamp speed, integrate positions
//   5. POSITION pass — push apart whatever is still overlapping
//
// The split between 3 and 5 is the load-bearing design decision. An impulse can
// only ever remove kinetic energy, so contacts cannot manufacture motion; and
// the position pass repairs penetration WITHOUT writing back into velocity, so
// geometry never becomes energy either. Resolving overlap by moving grains and
// then re-deriving velocity from that movement — the obvious approach — pumps
// energy into every contact and boils the bed, which no amount of damping,
// sleeping or clamping can fully hide.
//
// Because nothing injects energy, the bed comes to rest on its own. There is no
// sleep system: every grain integrates every step, so tilt response is
// immediate and flow is continuous.
//
// Contacts are solved deepest-first along gravity, so one sweep propagates
// support from the floor up through the whole pile.

import { CONFIG } from './config.js';
import { Grid } from './grid.js';
import { clamp, makeRandom } from './util.js';

export class Grains {
  constructor(capacity) {
    this.kind = 'sand';
    this.label = 'Sand';
    // Lean the bed against the back wall: a granular pile holds whatever slope
    // it is given, and the lean is a strong 3D cue on a desktop with no sensor.
    this.zBias = CONFIG.input.zBias;
    this.capacity = capacity;
    this.n = 0;

    const f32 = () => new Float32Array(capacity);
    this.x = f32();
    this.y = f32();
    this.z = f32();
    this.vx = f32();
    this.vy = f32();
    this.vz = f32();

    // Shading inputs, all harvested from the contact search.
    this.light = f32();
    this.speed01 = f32();
    this.sizeJitter = f32();
    this.hueJitter = f32();
    this.contacts = new Uint8Array(capacity);
    // 1 when a grain is touching nothing at all, and a graded version of the
    // same: how far short of a full set of contacts it is. Both smoothed. The
    // renderer draws loosely held grains a little smaller than packed ones —
    // keyed on contact, not speed, because a *speed* threshold fires on any
    // grain that has fallen a few tens of pixels and would shrink an entire
    // moving bed.
    this.airborne = f32();
    this.loose = f32();
    this.cover = f32();
    this.litAbove = f32();

    this.rank = new Int32Array(capacity);
    // Per-grain radius (px). this.radius stays the mean, and most solver
    // scales (skin, slop, travel caps) stay keyed to it.
    this.rad = f32();
    // Positions when the contact list was last rebuilt, for the skin test.
    this.refX = f32();
    this.refY = f32();
    this.refZ = f32();
    this.grid = new Grid(capacity);
    this.random = makeRandom(0x5117);

    // Contact arrays, grown on demand. cj < 0 marks a static wall contact.
    this.contactCapacity = 0;
    this.ci = new Int32Array(0);
    this.cj = new Int32Array(0);
    this.cnx = new Float32Array(0);
    this.cny = new Float32Array(0);
    this.cnz = new Float32Array(0);
    this.cgap = new Float32Array(0);
    this.cjn = new Float32Array(0);
    // Accumulated friction impulse per contact, as a vector.
    this.cfx = new Float32Array(0);
    this.cfy = new Float32Array(0);
    this.cfz = new Float32Array(0);
    // Separation speed each contact should end the step with — restitution,
    // computed from the approach speed before the solve touches anything.
    this.cbounce = new Float32Array(0);
    // Rest distance per contact: rad[i] + rad[j] for the pair it belongs to.
    this.crest = new Float32Array(0);
    this.active = new Int32Array(0);
    this.contactCount = 0;
    this.activeCount = 0;
    this.hashSize = 0;
    this.hashMask = 0;
    this.hKeyI = new Int32Array(0);
    this.hKeyJ = new Int32Array(0);
    this.hJn = new Float32Array(0);
    this.hFx = new Float32Array(0);
    this.hFy = new Float32Array(0);
    this.hFz = new Float32Array(0);
    this.warmHits = 0;

    this.radius = 4;
    this.diameter = 8;
    this.cellSize = 8;
    this.depth = 32;
    this.bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
    this.inner = { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 };
    this.gravityMagnitude = 4000;
    this.speedNorm = 600;
    // Unit gravity from the last step, kept so a splash can throw the bed away
    // from whichever wall it is currently resting on.
    this.gdx = 0;
    this.gdy = 1;
    this.gdz = 0;
    // Live shake pulse: an extra body acceleration, and how long it has left.
    this.kickX = 0;
    this.kickY = 0;
    this.kickZ = 0;
    this.kickTime = 0;
    this.substeps = 1;
    this.iterations = CONFIG.sim.velocityIterations;
    this._carry = 0;
  }

  /** Set the box size and grain size; keeps existing grains in place. */
  configure(width, height, radius) {
    if (this.n > 0 && this.radius > 0 && radius !== this.radius) {
      // Quality/layout changed the mean: rescale every grain so each keeps its
      // place in the size distribution.
      const k = radius / this.radius;
      for (let i = 0; i < this.n; i++) this.rad[i] *= k;
    }
    this.radius = radius;
    this.diameter = radius * 2;
    // Must cover the speculative contact radius, or the 3x3x3 scan misses pairs
    // that are about to collide.
    this.cellSize = this.diameter * CONFIG.sim.cellMul;
    this.depth = Math.max(
      this.diameter * 2,
      Math.min(CONFIG.bed.depthLayers * this.diameter, Math.min(width, height) * 0.22),
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

    this.gravityMagnitude = CONFIG.sim.gravityScale * Math.hypot(width, height);
    this.speedNorm = 0.35 * Math.sqrt(2 * this.gravityMagnitude * height);
    // A finger covers a fraction of the screen, not a fixed pixel count: as a
    // constant it ends up a dot on a big display and reaches barely a hundred
    // grains. Scaled, the touch keeps the same footprint everywhere.
    this.pokeRadius = Math.max(
      CONFIG.input.pokeRadiusMin,
      Math.min(width, height) * CONFIG.input.pokeRadiusFrac,
    );
  }

  ensureContactCapacity(need) {
    if (this.contactCapacity >= need) return;
    const cap = Math.max(need, Math.ceil(this.contactCapacity * 1.5) + 1024);
    this.ci = new Int32Array(cap);
    this.cj = new Int32Array(cap);
    this.cnx = new Float32Array(cap);
    this.cny = new Float32Array(cap);
    this.cnz = new Float32Array(cap);
    this.cgap = new Float32Array(cap);
    this.cjn = new Float32Array(cap);
    this.cfx = new Float32Array(cap);
    this.cfy = new Float32Array(cap);
    this.cfz = new Float32Array(cap);
    this.cbounce = new Float32Array(cap);
    this.crest = new Float32Array(cap);
    this.active = new Int32Array(cap);
    this.contactCapacity = cap;
    this.ensureHash(cap);
  }

  /**
   * Grain size is chosen from the screen, and the tuner coarsens from there.
   *
   * `maxRadius` caps the *designed* size only — the tuner may push past it,
   * and it is the one lever that should be used. Sand is drawn as a mass now
   * (see src/shaders.js), so the physics grain size is no longer the look:
   * doubling it is nearly invisible. Grain *count*, on the other hand, is the
   * volume of sand in the box, and taking that away is the most visible change
   * the app can make — measured, a short play session on a wide screen used to
   * lose a third of the bed, permanently, because the tuner never adds back.
   * Count is derived from the bed volume, so coarsening keeps the box just as
   * full; it is only made of fewer, larger grains.
   */
  preferredRadius(width, height, qualityScale = 1) {
    const g = CONFIG.grain;
    const base = clamp(Math.min(width, height) / g.divisor, g.minRadius, g.maxRadius);
    return clamp(base / Math.cbrt(qualityScale), g.minRadius, g.coarseRadius);
  }

  /** Always fill the bed. Quality is spent on grain size, never on volume. */
  targetCount() {
    return this.idealCount();
  }

  /** Grain count that fills `CONFIG.bed.fill` of the front view when settled. */
  idealCount(fill = CONFIG.bed.fill) {
    const { x1, y1 } = this.bounds;
    const v = CONFIG.grain.polydispersity;
    const grainVol = (4 / 3) * Math.PI * this.radius ** 3 * (1 + 3 * v * v);
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
    this.vx[i] = 0;
    this.vy[i] = 0;
    this.vz[i] = 0;
    this.light[i] = 0.5;
    this.speed01[i] = 0;
    const v = CONFIG.grain.polydispersity;
    this.rad[i] = this.radius * (1 - v + 2 * v * rand());
    // The renderer reads this as the sprite size ratio (and as the cluster
    // seed — any per-grain float works for hashing).
    this.sizeJitter[i] = this.rad[i] / this.radius;
    this.hueJitter[i] = rand();
    this.contacts[i] = 0;
    this.cover[i] = 0;
    this.litAbove[i] = 0;
    this.airborne[i] = 0;
    this.loose[i] = 0;
  }

  /**
   * Lay out the starting bed as a staggered lattice: alternate layers offset by
   * half a pitch in x and z, so each grain sits in a pocket of the layer below.
   *
   * Both properties matter. Nothing may overlap, or the solver is handed a
   * bed's worth of stored energy on frame one and detonates. And the layout has
   * to be near settled *density*, because a naive loose lattice stands several
   * times too tall for its grain count — and a pile that deep outweighs what
   * the solver can support in its iteration budget, so it crushes itself into a
   * thin overlapping slab on the way down.
   */
  fill(count) {
    const n = Math.min(count, this.capacity);
    this.n = n;
    this.grid.ensureCapacity(n);
    this.kickTime = 0; // a fresh bed must not inherit a shake in progress

    const rand = this.random;
    const b = this.inner;
    // Spacing must clear the largest possible pair, not the mean, or the
    // biggest grains spawn overlapped and hand the solver stored energy.
    const d = this.diameter * (1 + CONFIG.grain.polydispersity);
    const pitch = d * 1.05;
    // With a half-pitch offset in both x and z, the nearest grain in the layer
    // below sits at sqrt((p/2)^2 + yp^2 + (p/2)^2); 0.78d keeps that over d.
    const yPitch = d * 0.78;
    const spanX = Math.max(pitch, b.x1 - b.x0);
    const spanZ = Math.max(0, b.z1 - b.z0);
    const perX = Math.max(1, Math.floor(spanX / pitch) + 1);
    const perZ = Math.max(1, Math.floor(spanZ / pitch) + 1);
    const perLayer = perX * perZ;
    const jitter = this.radius * 0.06;

    for (let i = 0; i < n; i++) {
      const layer = Math.floor(i / perLayer);
      const rem = i % perLayer;
      const off = layer % 2 ? pitch * 0.5 : 0;
      const zi = Math.floor(rem / perX);
      const xi = rem % perX;
      this._spawnAt(
        i,
        clamp(b.x0 + off + xi * pitch + (rand() - 0.5) * jitter, b.x0, b.x1),
        clamp(b.y1 - layer * yPitch + (rand() - 0.5) * jitter, b.y0, b.y1),
        clamp(b.z0 + (perZ > 1 ? off : 0) + zi * pitch + (rand() - 0.5) * jitter, b.z0, b.z1),
      );
    }
  }

  /** Grow/shrink the bed. New grains appear just above the current surface. */
  setCount(count) {
    const target = Math.min(Math.max(count, 0), this.capacity);
    if (target === this.n) return;
    if (target < this.n) {
      this.n = target;
      return;
    }

    let bedTop = this.inner.y1;
    for (let i = 0; i < this.n; i++) if (this.y[i] < bedTop) bedTop = this.y[i];

    const rand = this.random;
    const b = this.inner;
    const pitch = this.diameter * (1 + CONFIG.grain.polydispersity) * 1.1;
    const perX = Math.max(1, Math.floor((b.x1 - b.x0) / pitch) + 1);
    const perZ = Math.max(1, Math.floor((b.z1 - b.z0) / pitch) + 1);
    const perLayer = perX * perZ;
    for (let k = 0, i = this.n; i < target; k++, i++) {
      const row = Math.floor(k / perLayer);
      const rem = k % perLayer;
      this._spawnAt(
        i,
        clamp(b.x0 + (rem % perX) * pitch, b.x0, b.x1),
        clamp(bedTop - pitch * (1 + row), b.y0, b.y1),
        clamp(b.z0 + Math.floor(rem / perX) * pitch, b.z0, b.z1),
      );
    }
    this.n = target;
    this.grid.ensureCapacity(target);
  }

  /** Nudge every grain back inside after a viewport change. */
  clampToBounds() {
    const b = this.inner;
    for (let i = 0; i < this.n; i++) {
      this.x[i] = clamp(this.x[i], b.x0, b.x1);
      this.y[i] = clamp(this.y[i], b.y0, b.y1);
      this.z[i] = clamp(this.z[i], b.z0, b.z1);
    }
  }

  /**
   * Shake response: jerk the box, and let the sand work out the rest.
   *
   * The obvious implementation — hand every grain a velocity — cannot help
   * making a dust cloud, whatever distribution it draws from. Any per-grain
   * velocity is *relative* velocity between neighbours, so the bed aerates
   * everywhere at once: measured over a splash, mean contacts per grain fell
   * from 7.6 to about 4, i.e. the whole mass went loose and grainy rather than
   * moving as sand. Randomising the direction is the worst case (the solver
   * may only remove energy, so most of the kick is annihilated in two frames
   * and all that is left is the boil), but even a perfectly coherent throw
   * decompacts the bed if it is written into velocities.
   *
   * A hand shaking a box never does that. It accelerates the container, and
   * the sand feels a pseudo-force — a *body* force, identical for every grain,
   * which produces no relative velocity at the contacts at all. The bed stays
   * packed while it is driven, leaves the floor as one mass, and only opens up
   * where real sand opens up: at the free surface, and on landing.
   *
   * So this records a short acceleration pulse and lets `step` add it to
   * gravity. No velocities are touched.
   */
  splash(strength) {
    const rand = this.random;
    const cfg = CONFIG.sim;

    // Drive against gravity, not up the screen: on a tilted phone the sand
    // rests on a wall, and that wall is what throws it.
    let ux = -this.gdx;
    let uy = -this.gdy;
    let uz = -this.gdz;
    // Lean off-axis so repeated shakes differ and the bed heaves sideways
    // rather than hopping straight up.
    const lean = (rand() - 0.5) * 2 * cfg.splashLean;
    const tx = -uy * lean;
    const ty = ux * lean;
    ux += tx;
    uy += ty;
    const inv = 1 / (Math.hypot(ux, uy, uz) || 1);
    ux *= inv; uy *= inv; uz *= inv;

    const a =
      this.gravityMagnitude * (cfg.splashAccel + cfg.splashGain * Math.max(0, strength - 1));
    this.kickX = ux * a;
    this.kickY = uy * a;
    this.kickZ = uz * a;
    this.kickTime = cfg.splashDuration;
  }

  /** Push grains away from a screen point (a cylinder through the depth). */
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
    const cfg = CONFIG.sim;

    // Fixed timestep with a carry, so the feel never depends on frame rate.
    const h = 1 / cfg.fixedHz;
    this._carry += dtFrame;
    let steps = Math.floor(this._carry / h);
    if (steps > cfg.maxSubsteps) steps = cfg.maxSubsteps;
    if (steps < 1) {
      // Very high refresh rate: keep accumulating rather than stepping tiny.
      if (this._carry < h) return;
      steps = 1;
    }
    this._carry -= steps * h;
    if (this._carry > h * cfg.maxSubsteps) this._carry = 0; // shed a long stall
    this.substeps = steps;
    this.iterations = cfg.velocityIterations;

    const gmag = Math.hypot(gx, gy, gz) || 1;
    const gdx = gx / gmag;
    const gdy = gy / gmag;
    const gdz = gz / gmag;
    this.gdx = gdx;
    this.gdy = gdy;
    this.gdz = gdz;

    for (let s = 0; s < steps; s++) {
      // A live shake pulse rides on top of gravity as a pseudo-force. Note the
      // ordering direction above stays the *true* gravity: the pulse comes
      // from the floor, so contacts should still be solved bottom-up, and the
      // shading must not flip over for the tenth of a second it lasts.
      let ax = gx;
      let ay = gy;
      let az = gz;
      if (this.kickTime > 0) {
        ax += this.kickX;
        ay += this.kickY;
        az += this.kickZ;
        this.kickTime -= h;
      }
      this.applyGravity(h, ax, ay, az);
      if (s === 0 || this.listStale()) this.findContacts(gdx, gdy, gdz);
      else this.refreshGaps();
      this.solveVelocity(h);
      this.shockPass(h);
      this.integrate(h);
      this.solvePosition();
    }
    this.updateShading(dtFrame);
  }

  applyGravity(h, gx, gy, gz) {
    const n = this.n;
    const { vx, vy, vz } = this;
    const damp = Math.exp(-CONFIG.sim.airDrag * h);
    const dvx = gx * h;
    const dvy = gy * h;
    const dvz = gz * h;
    for (let i = 0; i < n; i++) {
      vx[i] = (vx[i] + dvx) * damp;
      vy[i] = (vy[i] + dvy) * damp;
      vz[i] = (vz[i] + dvz) * damp;
    }
  }

  /**
   * Impulse memory for warm starting, as an open-addressed hash keyed by the
   * contact pair. Rebuilding the contact list shuffles indices, so carrying
   * impulses forward needs identity, not position in an array.
   */
  ensureHash(cap) {
    let size = 1024;
    while (size < cap * 2) size <<= 1;
    if (this.hashSize >= size) return;
    this.hashSize = size;
    this.hashMask = size - 1;
    this.hKeyI = new Int32Array(size);
    this.hKeyJ = new Int32Array(size);
    this.hJn = new Float32Array(size);
    this.hFx = new Float32Array(size);
    this.hFy = new Float32Array(size);
    this.hFz = new Float32Array(size);
    this.hKeyI.fill(-1);
  }

  /** Slot for this pair: either its existing entry or the first free one. */
  hashSlot(i, j) {
    const mask = this.hashMask;
    const keyI = this.hKeyI;
    const keyJ = this.hKeyJ;
    let h = (Math.imul(i, 73856093) ^ Math.imul(j + 8, 19349663)) & mask;
    for (let probe = 0; probe < 24; probe++) {
      const k = keyI[h];
      if (k === -1 || (k === i && keyJ[h] === j)) return h;
      h = (h + 1) & mask;
    }
    return -1; // crowded: this contact just starts cold, which is harmless
  }

  /** Park the current frame's impulses before the contact list is rebuilt. */
  stashImpulses() {
    const cnt = this.contactCount;
    if (cnt === 0) return;
    const { ci, cj, cjn, cfx, cfy, cfz, hKeyI, hKeyJ, hJn, hFx, hFy, hFz } = this;
    hKeyI.fill(-1);
    for (let c = 0; c < cnt; c++) {
      const jn = cjn[c];
      if (jn <= 0) continue; // nothing worth remembering
      const i = ci[c];
      const j = cj[c];
      const slot = this.hashSlot(i, j);
      if (slot < 0) continue;
      hKeyI[slot] = i;
      hKeyJ[slot] = j;
      hJn[slot] = jn;
      hFx[slot] = cfx[c];
      hFy[slot] = cfy[c];
      hFz[slot] = cfz[c];
    }
  }

  /** Give each contact in the fresh list whatever it was carrying before. */
  restoreImpulses() {
    const cnt = this.contactCount;
    const { ci, cj, cjn, cfx, cfy, cfz, hKeyI, hKeyJ, hJn, hFx, hFy, hFz } = this;
    let hits = 0;
    for (let c = 0; c < cnt; c++) {
      const i = ci[c];
      const j = cj[c];
      const slot = this.hashSlot(i, j);
      if (slot >= 0 && hKeyI[slot] === i && hKeyJ[slot] === j) {
        cjn[c] = hJn[slot];
        cfx[c] = hFx[slot];
        cfy[c] = hFy[slot];
        cfz[c] = hFz[slot];
        hits++;
      } else {
        cjn[c] = 0;
        cfx[c] = 0;
        cfy[c] = 0;
        cfz[c] = 0;
      }
    }
    this.warmHits = hits;
  }

  /**
   * Collect contacts, deepest-first along gravity, and harvest the shading
   * terms from the same neighbour scan (they are free here: the distances are
   * already computed).
   */
  findContacts(gdx, gdy, gdz) {
    const n = this.n;
    const grid = this.grid;
    grid.build(this.x, this.y, this.z, n);
    const order = grid.orderByGravity(gdx, gdy, gdz, n);
    const rank = this.rank;
    for (let k = 0; k < n; k++) rank[order[k]] = k;

    this.stashImpulses();
    this.ensureContactCapacity(n * 10);

    const { x, y, z, rad, contacts, cover, light, litAbove } = this;
    const { ci, cj, cnx, cny, cnz, cgap, crest } = this;
    const cols = grid.cols, rows = grid.rows, slabs = grid.slabs;
    const layer = cols * rows;
    const start = grid.cellStart;
    const cellOrder = grid.order;
    const cellOf = grid.cellOf;
    const D = this.diameter;
    const skinD = CONFIG.sim.skin * D;
    // The list is built with a skin so it outlives several substeps; whether a
    // pair is actually active is decided per substep in refreshGaps(). Scan
    // radius covers the largest possible pair plus skin, and the shading reach.
    const RS = Math.max(D * (1 + CONFIG.grain.polydispersity) + skinD, D * CONFIG.sim.shadeRadius);
    const RS2 = RS * RS;
    const DS2 = (D * CONFIG.sim.shadeRadius) ** 2;
    const B = this.bounds;
    const cap = this.contactCapacity;

    contacts.fill(0, 0, n);
    cover.fill(0, 0, n);
    litAbove.fill(0, 0, n);

    let c = 0;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const xi = x[i], yi = y[i], zi = z[i];
      const ri = rad[i];

      // Walls first: they are the ultimate support, so solving them ahead of
      // this grain's neighbours is what a deepest-first sweep wants. Gaps are
      // measured against the outer box minus this grain's own radius.
      // Speculative: a grain resting exactly ON a wall has zero penetration, so
      // a strict "is it past the plane" test finds nothing and the floor
      // silently stops supporting the bed. Catch them a margin early instead
      // and let the solver limit approach speed to the remaining gap.
      if (c + 6 <= cap) {
        let gap = xi - B.x0 - ri;
        if (gap < skinD) { ci[c] = i; cj[c] = -1; cnx[c] = -1; cny[c] = 0; cnz[c] = 0; cgap[c] = gap; crest[c] = ri; c++; }
        gap = B.x1 - xi - ri;
        if (gap < skinD) { ci[c] = i; cj[c] = -2; cnx[c] = 1; cny[c] = 0; cnz[c] = 0; cgap[c] = gap; crest[c] = ri; c++; }
        gap = yi - B.y0 - ri;
        if (gap < skinD) { ci[c] = i; cj[c] = -3; cnx[c] = 0; cny[c] = -1; cnz[c] = 0; cgap[c] = gap; crest[c] = ri; c++; }
        gap = B.y1 - yi - ri;
        if (gap < skinD) { ci[c] = i; cj[c] = -4; cnx[c] = 0; cny[c] = 1; cnz[c] = 0; cgap[c] = gap; crest[c] = ri; c++; }
        gap = zi - ri;
        if (gap < skinD) { ci[c] = i; cj[c] = -5; cnx[c] = 0; cny[c] = 0; cnz[c] = -1; cgap[c] = gap; crest[c] = ri; c++; }
        gap = this.depth - zi - ri;
        if (gap < skinD) { ci[c] = i; cj[c] = -6; cnx[c] = 0; cny[c] = 0; cnz[c] = 1; cgap[c] = gap; crest[c] = ri; c++; }
      }

      const cell = cellOf[i];
      const cz = (cell / layer) | 0;
      const rest = cell - cz * layer;
      const cy = (rest / cols) | 0;
      const cx = rest - cy * cols;
      const x0 = cx > 0 ? cx - 1 : 0, x1 = cx < cols - 1 ? cx + 1 : cols - 1;
      const y0 = cy > 0 ? cy - 1 : 0, y1 = cy < rows - 1 ? cy + 1 : rows - 1;
      const z0 = cz > 0 ? cz - 1 : 0, z1 = cz < slabs - 1 ? cz + 1 : slabs - 1;

      for (let rz = z0; rz <= z1; rz++) {
        const zb = rz * layer;
        for (let ry = y0; ry <= y1; ry++) {
          const yb = zb + ry * cols;
          for (let rx = x0; rx <= x1; rx++) {
            const cc = yb + rx;
            const e = start[cc + 1];
            for (let s = start[cc]; s < e; s++) {
              const j = cellOrder[s];
              // Each pair once, owned by whichever grain is deeper.
              if (rank[j] <= k) continue;
              const dx = x[j] - xi;
              const dy = y[j] - yi;
              const dz = z[j] - zi;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 >= RS2) continue;

              const dist = Math.sqrt(d2);
              let nx, ny, nz;
              if (dist > 1e-6) {
                const inv = 1 / dist;
                nx = dx * inv; ny = dy * inv; nz = dz * inv;
              } else {
                // Exactly coincident: pick a deterministic direction rather
                // than skipping, which would weld the pair together forever.
                const a = i * 2.3999632;
                nx = Math.cos(a) * 0.94; ny = Math.sin(a) * 0.94; nz = 0.34;
              }

              // Shading: neighbour count, how much of the load sits on the
              // anti-gravity side, and the brightest neighbour up there.
              if (d2 < DS2) {
                contacts[i]++;
                contacts[j]++;
                const w = nx * gdx + ny * gdy + nz * gdz;
                if (w < 0) {
                  cover[i] -= w;
                  const lj = light[j];
                  if (lj > litAbove[i]) litAbove[i] = lj;
                } else {
                  cover[j] += w;
                  const li = light[i];
                  if (li > litAbove[j]) litAbove[j] = li;
                }
              }

              const sumR = ri + rad[j];
              if (dist >= sumR + skinD || c >= cap) continue;
              ci[c] = i;
              cj[c] = j;
              cnx[c] = nx; cny[c] = ny; cnz[c] = nz;
              cgap[c] = dist - sumR;
              crest[c] = sumR;
              c++;
            }
          }
        }
      }
    }
    this.contactCount = c;
    this.restoreImpulses();
    this.refX.set(this.x.subarray(0, n));
    this.refY.set(this.y.subarray(0, n));
    this.refZ.set(this.z.subarray(0, n));
    this.refreshGaps();
  }

  /**
   * Has anything moved far enough that the list might have missed a new pair?
   * The list is built with a skin, so it stays valid until some grain has
   * travelled half of it.
   */
  listStale() {
    const n = this.n;
    const { x, y, z, refX, refY, refZ } = this;
    const limit = CONFIG.sim.skin * this.diameter * 0.5;
    const limit2 = limit * limit;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - refX[i], dy = y[i] - refY[i], dz = z[i] - refZ[i];
      if (dx * dx + dy * dy + dz * dz > limit2) return true;
    }
    return false;
  }

  /**
   * Re-measure every listed pair against current positions and collect the ones
   * close enough to matter. The list itself is built at most once per frame —
   * finding pairs costs far more than solving them, so re-using it across
   * substeps is the difference between a bed that runs and one that does not.
   */
  refreshGaps() {
    const cnt = this.contactCount;
    const { ci, cj, cnx, cny, cnz, cgap, crest, cjn, cfx, cfy, cfz, active, x, y, z, rad } = this;
    const B = this.bounds;
    const depth = this.depth;
    const margin = CONFIG.sim.contactMargin * this.diameter;
    let a = 0;
    for (let c = 0; c < cnt; c++) {
      const i = ci[c];
      const j = cj[c];
      if (j >= 0) {
        const dx = x[j] - x[i], dy = y[j] - y[i], dz = z[j] - z[i];
        const d2 = dx * dx + dy * dy + dz * dz;
        const rc = crest[c] + margin;
        if (d2 >= rc * rc) { cjn[c] = 0; cfx[c] = 0; cfy[c] = 0; cfz[c] = 0; continue; }
        const dist = Math.sqrt(d2);
        if (dist > 1e-6) {
          const inv = 1 / dist;
          cnx[c] = dx * inv; cny[c] = dy * inv; cnz[c] = dz * inv;
        }
        cgap[c] = dist - crest[c];
      } else {
        const nx = cnx[c], ny = cny[c], nz = cnz[c];
        const ri = rad[i];
        let gap;
        if (nx < 0) gap = x[i] - B.x0 - ri;
        else if (nx > 0) gap = B.x1 - x[i] - ri;
        else if (ny < 0) gap = y[i] - B.y0 - ri;
        else if (ny > 0) gap = B.y1 - y[i] - ri;
        else if (nz < 0) gap = z[i] - ri;
        else gap = depth - z[i] - ri;
        if (gap >= margin) { cjn[c] = 0; cfx[c] = 0; cfy[c] = 0; cfz[c] = 0; continue; }
        cgap[c] = gap;
      }
      active[a++] = c;
    }
    this.activeCount = a;
  }

  /**
   * Velocity pass: Gauss-Seidel impulses. Non-penetration first, then Coulomb
   * friction capped by mu times the normal impulse on that contact.
   *
   * Both are **warm started** — each contact begins the step by re-applying the
   * impulse it settled on last time, and iterates from there. This is what makes
   * a deep bed genuinely quiet. Starting every step from zero, the solver has to
   * rediscover the entire weight of the pile within its iteration budget, always
   * falls a little short, and the bed sinks a fraction, gets pushed back out,
   * and sinks again — a permanent low simmer no amount of damping removes.
   * Beginning from the previous answer means it starts converged and stays there.
   *
   * Friction accumulates as a vector and is clamped as a whole (rather than
   * clamping each increment), which is what gives true static friction: inside
   * the cone, sliding is cancelled outright instead of merely slowed.
   */
  solveVelocity(h) {
    const cnt = this.activeCount;
    if (cnt === 0) return;
    const { ci, cj, cnx, cny, cnz, cgap, cjn, cfx, cfy, cfz, cbounce, active, vx, vy, vz } = this;
    const invH = 1 / h;
    const iters = CONFIG.sim.velocityIterations;
    const mu = CONFIG.sim.friction;
    const muWall = CONFIG.sim.wallFriction;

    // Restitution, measured from the approach speed *before* the solve runs.
    // Only genuine impacts bounce: below the threshold a contact is resting,
    // and letting those bounce would make the whole bed buzz. Without any of
    // this, sand slammed into a wall absorbs every bit of its momentum and
    // stops dead, which is what kills the slosh-back.
    const rest = CONFIG.sim.restitution;
    const restCut = CONFIG.sim.restitutionCut * this.diameter;
    for (let a = 0; a < cnt; a++) {
      const c = active[a];
      const i = ci[c];
      const j = cj[c];
      const nx = cnx[c], ny = cny[c], nz = cnz[c];
      const vn = j >= 0
        ? (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny + (vz[j] - vz[i]) * nz
        : -(vx[i] * nx + vy[i] * ny + vz[i] * nz);
      cbounce[c] = vn < -restCut ? -rest * vn : 0;
    }

    // Warm start: re-apply what each contact was already carrying.
    for (let a = 0; a < cnt; a++) {
      const c = active[a];
      const i = ci[c];
      const j = cj[c];
      const jn = cjn[c];
      const px = -cnx[c] * jn + cfx[c];
      const py = -cny[c] * jn + cfy[c];
      const pz = -cnz[c] * jn + cfz[c];
      vx[i] += px; vy[i] += py; vz[i] += pz;
      if (j >= 0) { vx[j] -= px; vy[j] -= py; vz[j] -= pz; }
    }

    for (let it = 0; it < iters; it++) {
      for (let a = 0; a < cnt; a++) {
        const c = active[a];
        const i = ci[c];
        const j = cj[c];
        const nx = cnx[c], ny = cny[c], nz = cnz[c];
        // Still apart: allow approach fast enough to just close the gap this
        // step, no faster. Already touching: separate at the bounce speed
        // (zero for a resting contact).
        const gap = cgap[c];
        const target = gap > 0 ? -gap * invH : cbounce[c];

        if (j >= 0) {
          // Two unit masses: 1/mi + 1/mj = 2, so the impulse is halved.
          let rx = vx[j] - vx[i], ry = vy[j] - vy[i], rz = vz[j] - vz[i];
          const vn = rx * nx + ry * ny + rz * nz;
          let dj = (target - vn) * 0.5;
          const total = cjn[c] + dj > 0 ? cjn[c] + dj : 0;
          dj = total - cjn[c];
          cjn[c] = total;
          if (dj !== 0) {
            vx[i] -= dj * nx; vy[i] -= dj * ny; vz[i] -= dj * nz;
            vx[j] += dj * nx; vy[j] += dj * ny; vz[j] += dj * nz;
          }

          rx = vx[j] - vx[i]; ry = vy[j] - vy[i]; rz = vz[j] - vz[i];
          const vn2 = rx * nx + ry * ny + rz * nz;
          // Impulse that would cancel all remaining sliding, added to what this
          // contact already holds, then clamped as a whole.
          let fx = cfx[c] + (rx - vn2 * nx) * 0.5;
          let fy = cfy[c] + (ry - vn2 * ny) * 0.5;
          let fz = cfz[c] + (rz - vn2 * nz) * 0.5;
          const cap = mu * cjn[c];
          const m2 = fx * fx + fy * fy + fz * fz;
          if (m2 > cap * cap) {
            const k = cap / Math.sqrt(m2);
            fx *= k; fy *= k; fz *= k;
          }
          const dfx = fx - cfx[c], dfy = fy - cfy[c], dfz = fz - cfz[c];
          cfx[c] = fx; cfy[c] = fy; cfz[c] = fz;
          vx[i] += dfx; vy[i] += dfy; vz[i] += dfz;
          vx[j] -= dfx; vy[j] -= dfy; vz[j] -= dfz;
        } else {
          // Static wall: infinite mass, zero velocity.
          const vn = -(vx[i] * nx + vy[i] * ny + vz[i] * nz);
          let dj = target - vn;
          const total = cjn[c] + dj > 0 ? cjn[c] + dj : 0;
          dj = total - cjn[c];
          cjn[c] = total;
          if (dj !== 0) {
            vx[i] -= dj * nx; vy[i] -= dj * ny; vz[i] -= dj * nz;
          }

          const rx = -vx[i], ry = -vy[i], rz = -vz[i];
          const vn2 = rx * nx + ry * ny + rz * nz;
          let fx = cfx[c] + (rx - vn2 * nx);
          let fy = cfy[c] + (ry - vn2 * ny);
          let fz = cfz[c] + (rz - vn2 * nz);
          const cap = muWall * cjn[c];
          const m2 = fx * fx + fy * fy + fz * fz;
          if (m2 > cap * cap) {
            const k = cap / Math.sqrt(m2);
            fx *= k; fy *= k; fz *= k;
          }
          const dfx = fx - cfx[c], dfy = fy - cfy[c], dfz = fz - cfz[c];
          cfx[c] = fx; cfy[c] = fy; cfz[c] = fz;
          vx[i] += dfx; vy[i] += dfy; vz[i] += dfz;
        }
      }
    }
  }

  /**
   * Shock propagation: one bottom-up sweep in which the deeper grain of each
   * pair is treated as immovable, so the whole impulse lands on the shallower
   * one.
   *
   * This is what makes deep piles stand up. Between two equal masses an impulse
   * only averages their velocities, so support crawls up a stack geometrically
   * — a thirty-layer bed needs far more iterations than is affordable, and
   * without this it slowly crushes itself into an overlapping slab. Treating
   * the supported side as ground (the floor does not recoil) carries support
   * from the box floor to the surface in a single pass. It deliberately breaks
   * momentum conservation, which is exactly what resting on solid ground does.
   */
  shockPass(h) {
    const cnt = this.activeCount;
    if (cnt === 0) return;
    const { ci, cj, cnx, cny, cnz, cgap, active, vx, vy, vz } = this;
    const invH = 1 / h;
    const passes = CONFIG.sim.shockIterations;
    // Only quasi-static contacts get the ground treatment. Treating the
    // supported grain as immovable is what holds a pile up, but it also dumps
    // the incoming momentum of a fast impact into "ground" instead of passing
    // it along the contact chain — so sand slamming into a wall is swallowed
    // rather than spraying back. Above this approach speed the symmetric,
    // momentum-conserving solve is left to handle it alone.
    const gate = -CONFIG.sim.shockMaxApproach * this.diameter;

    for (let p = 0; p < passes; p++) {
      for (let a = 0; a < cnt; a++) {
        const c = active[a];
        const i = ci[c];
        const j = cj[c];
        const nx = cnx[c], ny = cny[c], nz = cnz[c];
        const gap = cgap[c];
        const target = gap > 0 ? -gap * invH : 0;
        if (j >= 0) {
          // ci is the deeper grain: it is the one already held up.
          const vn = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny + (vz[j] - vz[i]) * nz;
          const dj = target - vn;
          if (dj > 0 && vn > gate) {
            vx[j] += dj * nx; vy[j] += dj * ny; vz[j] += dj * nz;
          }
        } else {
          const vn = -(vx[i] * nx + vy[i] * ny + vz[i] * nz);
          const dj = target - vn;
          if (dj > 0 && vn > gate) {
            vx[i] -= dj * nx; vy[i] -= dj * ny; vz[i] -= dj * nz;
          }
        }
      }
    }
  }

  integrate(h) {
    const n = this.n;
    const { x, y, z, vx, vy, vz } = this;
    // Nothing may cross more than about its own width per substep, or contacts
    // are found only once grains are already deep inside each other.
    const maxV = (CONFIG.sim.maxTravel * this.diameter) / h;
    const maxV2 = maxV * maxV;
    for (let i = 0; i < n; i++) {
      let ux = vx[i], uy = vy[i], uz = vz[i];
      const s2 = ux * ux + uy * uy + uz * uz;
      if (s2 > maxV2) {
        const k = maxV / Math.sqrt(s2);
        ux *= k; uy *= k; uz *= k;
        vx[i] = ux; vy[i] = uy; vz[i] = uz;
      }
      x[i] += ux * h;
      y[i] += uy * h;
      z[i] += uz * h;
    }
  }

  /**
   * Position pass: push overlapping pairs apart, and put wall violators back
   * inside. Velocities are deliberately left alone — turning this correction
   * into velocity is exactly how a solver starts manufacturing energy.
   *
   * `slop` leaves a sliver of overlap uncorrected so a resting bed has nothing
   * left to fidget about.
   */
  solvePosition() {
    const cnt = this.activeCount;
    const { ci, cj, cnx, cny, cnz, crest, active, x, y, z, rad } = this;
    const iters = CONFIG.sim.positionIterations;
    const beta = CONFIG.sim.positionBeta;
    const D = this.diameter;
    const slop = CONFIG.sim.slop * D;
    const maxFix = CONFIG.sim.maxCorrection * D;
    const B = this.bounds;
    const depth = this.depth;

    for (let it = 0; it < iters; it++) {
      for (let a = 0; a < cnt; a++) {
        const c = active[a];
        const i = ci[c];
        const j = cj[c];
        if (j >= 0) {
          const rest = crest[c];
          const dx = x[j] - x[i], dy = y[j] - y[i], dz = z[j] - z[i];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= rest * rest || d2 < 1e-12) continue;
          const dist = Math.sqrt(d2);
          let push = (rest - dist - slop) * beta * 0.5;
          if (push <= 0) continue;
          if (push > maxFix) push = maxFix;
          const inv = 1 / dist;
          const nx = dx * inv, ny = dy * inv, nz = dz * inv;
          x[i] -= nx * push; y[i] -= ny * push; z[i] -= nz * push;
          x[j] += nx * push; y[j] += ny * push; z[j] += nz * push;
        } else {
          const nx = cnx[c], ny = cny[c], nz = cnz[c];
          const ri = rad[i];
          // Distance past the plane this normal points at (negative = still
          // inside, which is the common speculative case and does nothing).
          let pen;
          if (nx < 0) pen = B.x0 + ri - x[i];
          else if (nx > 0) pen = x[i] - (B.x1 - ri);
          else if (ny < 0) pen = B.y0 + ri - y[i];
          else if (ny > 0) pen = y[i] - (B.y1 - ri);
          else if (nz < 0) pen = ri - z[i];
          else pen = z[i] - (depth - ri);
          let push = (pen - slop) * beta;
          if (push <= 0) continue;
          if (push > maxFix) push = maxFix;
          x[i] -= nx * push; y[i] -= ny * push; z[i] -= nz * push;
        }
      }
    }

    // Final hard clamp: whatever the solver did, nothing leaves the box.
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const ri = rad[i];
      if (x[i] < B.x0 + ri) x[i] = B.x0 + ri; else if (x[i] > B.x1 - ri) x[i] = B.x1 - ri;
      if (y[i] < B.y0 + ri) y[i] = B.y0 + ri; else if (y[i] > B.y1 - ri) y[i] = B.y1 - ri;
      if (z[i] < ri) z[i] = ri; else if (z[i] > depth - ri) z[i] = depth - ri;
    }
  }

  updateShading(dt) {
    const n = this.n;
    const cfg = CONFIG.sim;
    const { light, cover, contacts, litAbove, speed01, airborne, loose, vx, vy, vz } = this;
    const invCover = 1 / cfg.coverNorm;
    const invSpeed = 1 / this.speedNorm;
    const blend = 1 - Math.exp(-cfg.lightSmoothing * dt);
    const transmit = cfg.lightTransmit;

    for (let i = 0; i < n; i++) {
      const buried = clamp(cover[i] * invCover, 0, 1);
      const looseNow = 1 - clamp(contacts[i] / 6, 0, 1);
      // How UNSUPPORTED a grain is, for the renderer — a different question
      // from how lit it is, and it saturates much sooner. Three contacts
      // already means "part of a connected mass", and the renderer only needs
      // to tell a mass from a grain flying on its own. Measured against six
      // (full 3D coordination) a jammed single layer reads as half loose,
      // because a sheet one grain thick genuinely has fewer neighbours than a
      // deep bed — and the renderer then drew it small and tore it into holes,
      // which is exactly what a phone laid face-up showed.
      const packNow = 1 - clamp(contacts[i] / 3, 0, 1);
      // Lit if nothing is above you, or if you are barely touching anything...
      const exposed = Math.max(1 - buried, looseNow * 0.95);
      // ...otherwise take what filters down from the grain above you.
      const target = Math.max(exposed, litAbove[i] * transmit);
      light[i] += (target - light[i]) * blend;
      speed01[i] = clamp(Math.hypot(vx[i], vy[i], vz[i]) * invSpeed, 0, 1);
      // Touching nothing means genuinely in flight. Smoothed so a grain
      // entering or leaving the mass fades rather than pops; the graded
      // version is smoothed for the same reason, since contact counts at a
      // surface flicker from step to step.
      const air = contacts[i] === 0 ? 1 : 0;
      airborne[i] += (air - airborne[i]) * blend;
      loose[i] += (packNow - loose[i]) * blend;
    }
  }
}
