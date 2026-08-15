// What can go in the box.
//
// A material owns its own solver *and* its own idea of how big a particle
// should be and how many of them belong in the box, because those answers are
// not shared: sand wants the finest grain the device can afford since every
// grain is visible, while water wants a coarse particle because it is drawn as
// a surface and its particles never are. Pushing both decisions behind the
// interface is what keeps main.js from growing a branch per material.
//
// The contract, in full:
//
//   kind, label                       identity; the renderer switches on kind
//   capacity, n                       allocated / live particle count
//   radius, diameter, depth           geometry, in sim pixels
//   bounds, inner                     box, and the box inset by radius
//   gravityMagnitude                  px/s^2, so callers can scale forces
//   substeps, iterations, contactCount  read by the stats panel only
//   x, y, z                           positions, read by the renderer
//
//   preferredRadius(w, h, qualityScale)   particle size this material wants
//   targetCount(w, h, qualityScale)       how many of them belong in the box
//   configure(w, h, radius)               box or particle size changed
//   fill(count)                           (re)build from scratch
//   setCount(count)                       grow or shrink in place
//   clampToBounds()                       after a viewport change
//   step(dt, gx, gy, gz)                  advance
//   poke(cx, cy, dragX, dragY, dt)        finger
//   splash(strength)                      shake
//
// Anything beyond that is the material's own business, and the renderer reads
// it only through the branch for that kind.

import { CONFIG } from './config.js';
import { Grains } from './grains.js';
import { Fluid } from './fluid.js';

/**
 * The registry. Adding a material here is the whole job: the picker builds
 * itself from this list, so a new entry appears in the UI with its swatch and
 * needs no markup, no styling and no wiring.
 *
 * `tint` is only for the swatch dot in the menu — it is not used to render
 * anything in the box.
 */
export const MATERIALS = [
  {
    id: 'sand',
    label: 'Sand',
    tint: '#c8a97a',
    create: () => new Grains(CONFIG.bed.maxGrains),
  },
  {
    id: 'water',
    label: 'Water',
    tint: '#4e9fc4',
    create: () => new Fluid(CONFIG.fluid.maxParticles),
  },
];

/**
 * Holds one instance per material, built on first use. Keeping them alive
 * costs a few megabytes and means switching back is instant and lands on the
 * state you left, rather than re-running a settle every time.
 */
export class MaterialSet {
  constructor() {
    this.instances = new Map();
    this.index = 0;
  }

  get current() {
    const def = MATERIALS[this.index];
    let inst = this.instances.get(def.id);
    if (!inst) {
      inst = def.create();
      this.instances.set(def.id, inst);
    }
    return inst;
  }

  get label() {
    return MATERIALS[this.index].label;
  }

  get id() {
    return MATERIALS[this.index].id;
  }

  /** Which material `next()` would move to, without moving to it. */
  get nextId() {
    return MATERIALS[(this.index + 1) % MATERIALS.length].id;
  }

  /** True if the instance had not been built yet, i.e. it needs filling. */
  isFresh(id) {
    return !this.instances.has(id);
  }

  select(id) {
    const i = MATERIALS.findIndex((m) => m.id === id);
    if (i < 0) return false;
    this.index = i;
    return true;
  }

  next() {
    this.index = (this.index + 1) % MATERIALS.length;
    return this.current;
  }
}
