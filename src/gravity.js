// Where "down" is.
//
// Phone: derived from deviceorientation's beta/gamma. That is more portable
// than accelerationIncludingGravity, whose sign convention differs between
// iOS and Android. devicemotion is still used, but only for shake detection.
//
// Desktop / no sensors: arrow keys, WASD, or the on-screen stick.
//
// Deriving the in-plane gravity from beta/gamma: the device->earth rotation is
// Rz(alpha)Rx(beta)Ry(gamma), so earth-down expressed in device axes is
//   d = Ry(-gamma) Rx(-beta) (0,0,-1) = (sin g cos b, -sin b, -cos g cos b)
// Device +y points up the screen while CSS +y points down, so in screen space
//   gx = sin(gamma) * cos(beta)
//   gy = sin(beta)
// Held upright in portrait (beta 90, gamma 0) that is (0, 1): straight down.
// Flat on a table it is (0, 0) and the sand goes weightless, which is correct.

import { CONFIG } from './config.js';
import { approach, clamp, isIOS } from './util.js';

const DEG = Math.PI / 180;

export class GravityInput {
  constructor() {
    // Smoothed unit-ish vector in CSS space, consumed by the sim.
    this.gx = 0;
    this.gy = 1;
    // Raw sensor readings, surfaced in the stats panel for on-device debugging.
    this.beta = 0;
    this.gamma = 0;
    this.screenAngle = 0;
    this.shakeMagnitude = 0;
    this.mode = 'keys';
    this.sensorActive = false;
    this.needsPermission = false;
    this.flipped = false;
    this.lastError = '';

    this.onShake = null;
    this.keys = new Set();
    this.stick = { x: 0, y: 0, active: false };
    this.demo = false;
    this.demoPhase = 0;

    this._shakeCooldown = 0;
    this._hasOrientation = false;
    this._boundOrientation = (e) => this.handleOrientation(e);
    this._boundMotion = (e) => this.handleMotion(e);
  }

  /**
   * iOS needs requestPermission() from inside a user gesture; everyone else can
   * just subscribe. Returns true when sensor events are flowing.
   */
  async enableSensors() {
    const MotionEvent = window.DeviceMotionEvent;
    const OrientationEvent = window.DeviceOrientationEvent;
    if (!OrientationEvent && !MotionEvent) {
      this.lastError = 'No motion sensors on this device.';
      return false;
    }
    try {
      if (OrientationEvent && typeof OrientationEvent.requestPermission === 'function') {
        const state = await OrientationEvent.requestPermission();
        if (state !== 'granted') {
          this.lastError = 'Motion access denied.';
          return false;
        }
      }
      if (MotionEvent && typeof MotionEvent.requestPermission === 'function') {
        await MotionEvent.requestPermission().catch(() => {});
      }
    } catch (err) {
      // Thrown when not called from a gesture, or on a non-secure origin.
      this.lastError = String(err && err.message ? err.message : err);
      return false;
    }
    this.attach();
    return true;
  }

  attach() {
    window.addEventListener('deviceorientation', this._boundOrientation, { passive: true });
    window.addEventListener('devicemotion', this._boundMotion, { passive: true });
  }

  detach() {
    window.removeEventListener('deviceorientation', this._boundOrientation);
    window.removeEventListener('devicemotion', this._boundMotion);
  }

  /** Sensors need a secure context; plain http over LAN silently never fires. */
  static get secureContext() {
    return window.isSecureContext !== false;
  }

  get supportsSensors() {
    return !!(window.DeviceOrientationEvent || window.DeviceMotionEvent);
  }

  get requiresGesture() {
    const E = window.DeviceOrientationEvent;
    return !!(E && typeof E.requestPermission === 'function') || isIOS();
  }

  handleOrientation(event) {
    if (event.beta === null && event.gamma === null) return;
    this.beta = event.beta || 0;
    this.gamma = event.gamma || 0;
    this._hasOrientation = true;
    this.sensorActive = true;
    this.mode = 'tilt';
  }

  handleMotion(event) {
    // Gravity-excluded acceleration is the cleanest shake signal. Some
    // browsers leave it null, in which case fall back to the total vector
    // minus 1g, which is close enough for a threshold test.
    const a = event.acceleration;
    let mag;
    if (a && (a.x !== null || a.y !== null || a.z !== null)) {
      mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    } else {
      const t = event.accelerationIncludingGravity;
      if (!t) return;
      mag = Math.abs(Math.hypot(t.x || 0, t.y || 0, t.z || 0) - 9.81);
    }
    this.shakeMagnitude = mag;

    // If deviceorientation never arrives (rare, but some Android builds only
    // ship devicemotion) treat motion as proof the sensors are alive.
    if (!this._hasOrientation && event.accelerationIncludingGravity) {
      this.sensorActive = true;
      if (this.mode === 'keys') this.mode = 'motion';
    }

    if (mag > CONFIG.input.shakeThreshold && this._shakeCooldown <= 0) {
      this._shakeCooldown = CONFIG.input.shakeCooldown;
      const strength = clamp(mag / CONFIG.input.shakeThreshold, 1, 3);
      if (this.onShake) this.onShake(strength);
    }
  }

  setKey(code, down) {
    if (down) this.keys.add(code); else this.keys.delete(code);
  }

  /** Screen rotation, normalised to degrees clockwise from natural. */
  readScreenAngle() {
    const so = screen.orientation;
    if (so && typeof so.angle === 'number') return ((so.angle % 360) + 360) % 360;
    if (typeof window.orientation === 'number') {
      return ((window.orientation % 360) + 360) % 360;
    }
    return 0;
  }

  /** Target direction from tilt, keys, stick, or the demo sway. */
  targetVector() {
    if (this.demo) {
      // Roughly what a hand does: a lazy roll, never fully on its side.
      return { x: Math.sin(this.demoPhase) * 0.6, y: Math.cos(this.demoPhase * 0.63) * 0.35 + 0.65 };
    }

    let kx = 0;
    let ky = 0;
    const k = this.keys;
    if (k.has('ArrowLeft') || k.has('KeyA')) kx -= 1;
    if (k.has('ArrowRight') || k.has('KeyD')) kx += 1;
    if (k.has('ArrowUp') || k.has('KeyW')) ky -= 1;
    if (k.has('ArrowDown') || k.has('KeyS')) ky += 1;
    if (kx || ky) {
      const m = Math.hypot(kx, ky);
      return { x: kx / m, y: ky / m, keys: true };
    }

    if (this.stick.active) return { x: this.stick.x, y: this.stick.y, keys: true };

    if (this.sensorActive && this._hasOrientation) {
      const b = this.beta * DEG;
      const g = this.gamma * DEG;
      let dx = Math.sin(g) * Math.cos(b);
      let dy = Math.sin(b);

      // Rotate device axes into CSS axes when the screen is not upright.
      const angle = this.screenAngle * DEG;
      if (angle) {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const rx = dx * c + dy * s;
        const ry = -dx * s + dy * c;
        dx = rx;
        dy = ry;
      }
      if (this.flipped) {
        dx = -dx;
        dy = -dy;
      }
      return { x: dx, y: dy };
    }

    // No input at all: hold a gentle downward pull.
    return { x: 0, y: 1, keys: true };
  }

  update(dt) {
    if (this._shakeCooldown > 0) this._shakeCooldown -= dt;
    this.screenAngle = this.readScreenAngle();
    if (this.demo) this.demoPhase += dt * 0.9;

    const target = this.targetVector();
    const rate = target.keys ? CONFIG.input.keySmoothing : CONFIG.input.tiltSmoothing;
    this.gx = approach(this.gx, target.x, rate, dt);
    this.gy = approach(this.gy, target.y, rate, dt);
  }

  describe() {
    if (this.demo) return 'demo sway';
    if (this.stick.active) return 'stick';
    if (this.keys.size) return 'keys';
    if (this.sensorActive) return this._hasOrientation ? 'tilt' : 'motion';
    return 'idle';
  }
}
