// Adaptive quality. Watches a rolling frame time and scales the grain count so
// the same page runs on a five-year-old phone and a desktop GPU without either
// being sandbagged. Steps are small and rate-limited so the bed does not visibly
// pop while it settles on a number.

import { CONFIG } from './config.js';
import { clamp } from './util.js';

export class Tuner {
  constructor() {
    this.scale = 1;
    this.frameMs = 16.7;
    this.fps = 60;
    this.enabled = true;
    this._accum = 0;
    this._frames = 0;
    this._cooldown = 1;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
  }

  /** Called once per frame with the measured work time and the real delta. */
  sample(workMs, dt) {
    this.frameMs += (workMs - this.frameMs) * 0.1;
    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    if (this._cooldown > 0) this._cooldown -= dt;
    this._accum += workMs;
    this._frames++;

    const cfg = CONFIG.tuner;
    if (this._frames < cfg.sampleFrames) return false;
    const avg = this._accum / this._frames;
    this._accum = 0;
    this._frames = 0;
    if (!this.enabled || this._cooldown > 0) return false;

    let next = this.scale;
    if (avg > cfg.hiMs) next = this.scale * (1 - cfg.step);
    else if (avg < cfg.loMs) next = this.scale * (1 + cfg.step);
    next = clamp(next, cfg.minScale, cfg.maxScale);
    if (Math.abs(next - this.scale) < 1e-4) return false;

    this.scale = next;
    this._cooldown = cfg.cooldown;
    return true;
  }
}
