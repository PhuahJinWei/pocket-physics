// Adaptive quality — a floor, not a target.
//
// Grain size comes from the screen size alone, and that is the look. This only
// steps in when a device demonstrably cannot sustain it, coarsening grains
// until it can. It never refines: the designed look is the ceiling, so the app
// looks the same on every load and on every device that can afford it, and no
// grain is ever spawned into a bed the user is already looking at.

import { CONFIG } from './config.js';
import { clamp } from './util.js';

export class Tuner {
  constructor() {
    // 1 = the designed grain size. Only ever decreases.
    this.scale = 1;
    this.frameMs = 16.7;
    this.fps = 60;
    this.enabled = CONFIG.tuner.enabled;
    this._accum = 0;
    this._frames = 0;
    this._cooldown = CONFIG.tuner.warmup;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
  }

  /**
   * Called once per frame with the measured work time and the real delta.
   * `eligible` marks frames where the sim actually did work — a dormant bed
   * costs almost nothing, and letting those frames into the average would hide
   * the expensive sloshing frames this is meant to catch.
   *
   * Returns true when the caller should re-apply quality.
   */
  sample(workMs, dt, eligible = true) {
    this.frameMs += (workMs - this.frameMs) * 0.1;
    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    if (this._cooldown > 0) this._cooldown -= dt;
    if (!eligible) {
      this._accum = 0;
      this._frames = 0;
      return false;
    }
    this._accum += workMs;
    this._frames++;

    const cfg = CONFIG.tuner;
    if (this._frames < cfg.sampleFrames) return false;
    const avg = this._accum / this._frames;
    this._accum = 0;
    this._frames = 0;
    if (!this.enabled || this._cooldown > 0) return false;
    if (avg <= cfg.hiMs) return false;

    const next = clamp(this.scale * (1 - cfg.step), cfg.minScale, 1);
    if (Math.abs(next - this.scale) < 1e-4) return false;

    this.scale = next;
    this._cooldown = cfg.cooldown;
    return true;
  }
}
