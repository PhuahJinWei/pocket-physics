// Where "down" is — a 3D vector, since the box has depth, and one whose
// magnitude matters as much as its direction.
//
// Phone: the accelerometer's whole vector, because a box being carried is a
// non-inertial frame. Its contents feel gravity *plus* a pseudo-force opposing
// however the box is being accelerated, which is precisely what
// accelerationIncludingGravity reads. Orientation alone would give only the
// direction of down, so a flick would rotate gravity smoothly and the sand
// would slide over and stop dead — no slosh. deviceorientation is still read,
// as the fallback and to calibrate the accelerometer's sign (iOS and Android
// disagree about it, and guessing wrong inverts every push).
//
// Desktop / no sensors: arrow keys, WASD, or the on-screen stick, with a fixed
// into-screen bias so the bed leans against the back wall and reads as 3D.
//
// Deriving gravity from beta/gamma: the device->earth rotation is
// Rz(alpha)Rx(beta)Ry(gamma), so earth-down expressed in device axes is
//   d = (sin g cos b, -sin b, -cos g cos b)
// Device +y points up the screen while CSS +y points down, and device +z points
// out of the screen while box +z points into it, so in box space
//   gx = sin(gamma) * cos(beta)
//   gy = sin(beta)
//   gz = cos(beta) * cos(gamma)
// Held upright in portrait (beta 90) that is (0,1,0): straight down the screen.
// Flat on a table it is (0,0,1): into the screen, so the sand settles against
// the back wall and spreads out — which is exactly what a real box would do.

import { CONFIG } from './config.js';
import { approach, clamp, isIOS } from './util.js';

const DEG = Math.PI / 180;

export class GravityInput {
  constructor() {
    // Smoothed unit-ish vector in box space, consumed by the sim.
    this.gx = 0;
    this.gy = 1;
    // How hard gravity leans into the screen when there is no live sensor.
    // Owned by the material, not by this class: sand wants to pile against the
    // back wall because that is what makes the box read as 3D, but the same
    // lean tips a *liquid* surface, and a tilted water line is exactly the
    // thing water is not allowed to do. Set from the current material.
    this.zBias = CONFIG.input.zBias;
    this.gz = this.zBias;
    // Raw sensor readings, surfaced in the stats panel for on-device debugging.
    this.beta = 0;
    this.gamma = 0;
    this.screenAngle = 0;
    this.shakeMagnitude = 0;
    // Raw accelerometer vector (device axes) and how stale it is. This is the
    // *specific force*: gravity plus whatever the hand is doing to the box.
    this.ax = 0; this.ay = 0; this.az = 0;
    this.accelAge = 99;
    // Platform sign for accelerationIncludingGravity, worked out by comparing
    // it against the orientation-derived gravity while the device is still.
    // iOS and Android disagree, and guessing wrong inverts every push.
    this.accelSign = 0;
    this._signVotes = 0;
    this.gForce = 1;
    this.mode = 'keys';
    this.sensorActive = false;
    this.flipped = false;
    this.lastError = '';

    this.onShake = null;
    this.keys = new Set();
    this.stick = { x: 0, y: 0, active: false };
    this.demo = false;
    this.demoPhase = 0;

    this._age = 0;
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
    const total = event.accelerationIncludingGravity;
    if (total && (total.x !== null || total.y !== null || total.z !== null)) {
      this.ax = total.x || 0;
      this.ay = total.y || 0;
      this.az = total.z || 0;
      this.accelAge = 0;
      this.calibrateAccelSign();
    }

    const a = event.acceleration;
    let mag;
    if (a && (a.x !== null || a.y !== null || a.z !== null)) {
      mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    } else {
      if (!total) return;
      mag = Math.abs(Math.hypot(this.ax, this.ay, this.az) - 9.81);
    }
    this.shakeMagnitude = mag;

    // If deviceorientation never arrives (rare, but some Android builds only
    // ship devicemotion) treat motion as proof the sensors are alive.
    if (!this._hasOrientation && event.accelerationIncludingGravity) {
      this.sensorActive = true;
      if (this.mode === 'keys') this.mode = 'motion';
    }

    // Picking the phone up and putting it down spikes the accelerometer well
    // past the shake threshold, so shakes stay disarmed for the first moments.
    if (this._age < CONFIG.input.shakeArmDelay) return;

    if (mag > CONFIG.input.shakeThreshold && this._shakeCooldown <= 0) {
      this._shakeCooldown = CONFIG.input.shakeCooldown;
      const strength = clamp(mag / CONFIG.input.shakeThreshold, 1, 3);
      if (this.onShake) this.onShake(strength);
    }
  }

  /**
   * Decide which way round accelerationIncludingGravity points on this device,
   * by comparing it with the orientation-derived gravity while the phone is
   * near enough to still that the reading *is* gravity. Needs a few agreeing
   * samples so one noisy frame cannot flip it.
   */
  calibrateAccelSign() {
    if (this.accelSign !== 0 || !this._hasOrientation) return;
    const mag = Math.hypot(this.ax, this.ay, this.az);
    if (mag < 8.6 || mag > 11.0) return; // moving: this is not pure gravity
    const b = this.beta * DEG;
    const g = this.gamma * DEG;
    const cb = Math.cos(b);
    // Earth-down in device axes.
    const dx = Math.sin(g) * cb;
    const dy = -Math.sin(b);
    const dz = -Math.cos(g) * cb;
    const dot = (this.ax * dx + this.ay * dy + this.az * dz) / mag;
    if (Math.abs(dot) < 0.75) return; // too oblique to be sure
    this._signVotes += dot > 0 ? 1 : -1;
    if (this._signVotes >= 4) this.accelSign = 1;
    else if (this._signVotes <= -4) this.accelSign = -1;
  }

  /**
   * Effective gravity in box space, in g units, from the accelerometer.
   *
   * A box being carried is a non-inertial frame: its contents feel gravity plus
   * a pseudo-force opposing however the box is being accelerated — which is
   * exactly what an accelerometer reads. Driving the sim from orientation alone
   * gives only the direction of down, so flicking the device just rotates
   * gravity smoothly and the sand slides over and stops. Feeding the whole
   * vector in is what makes it slosh: the flick throws the sand, and stopping
   * the flick throws it back.
   */
  accelVector() {
    const sign = this.accelSign || -1; // spec convention until proven otherwise
    let dx = sign * this.ax;
    let dy = sign * this.ay;
    let dz = sign * this.az;
    // Device axes -> box axes: screen y runs down, box z runs into the screen.
    let gx = dx / 9.81;
    let gy = -dy / 9.81;
    const gz = -dz / 9.81;

    const angle = this.screenAngle * DEG;
    if (angle) {
      const c = Math.cos(angle);
      const sn = Math.sin(angle);
      const rx = gx * c + gy * sn;
      const ry = -gx * sn + gy * c;
      gx = rx;
      gy = ry;
    }
    // A hard shake can read several g; allow it, but not unboundedly.
    const m = Math.hypot(gx, gy, gz);
    const cap = CONFIG.input.maxG;
    if (m > cap) {
      const k = cap / m;
      gx *= k; gy *= k;
      return { x: gx, y: gy, z: gz * k, mag: cap };
    }
    return { x: gx, y: gy, z: gz, mag: m };
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
  /**
   * Where gravity points, and the flip applied to it.
   *
   * The flip used to live inside the two sensor branches below, which meant it
   * did nothing at all without sensors: the keyboard, the stick and the
   * resting case each return before ever reaching it, so on a desktop the
   * control was inert. Applied here it is the same correction for a phone —
   * identical, since both branches flipped immediately before returning and
   * the magnitude cap is unchanged by a sign flip — and it now also inverts
   * keys, stick and rest, so the box can be turned upside down anywhere.
   *
   * x and y only. Flipping z as well would push the liquid against the other
   * pane of glass, which is not what turning a box over does.
   */
  targetVector() {
    const v = this.sourceVector();
    if (!this.flipped) return v;
    return { ...v, x: -v.x, y: -v.y };
  }

  sourceVector() {
    const zBias = this.zBias;

    if (this.demo) {
      // Roughly what a hand does: a lazy roll, never fully on its side.
      return normalise(
        Math.sin(this.demoPhase) * 0.6,
        Math.cos(this.demoPhase * 0.63) * 0.35 + 0.65,
        zBias,
        true,
      );
    }

    let kx = 0;
    let ky = 0;
    const k = this.keys;
    if (k.has('ArrowLeft') || k.has('KeyA')) kx -= 1;
    if (k.has('ArrowRight') || k.has('KeyD')) kx += 1;
    if (k.has('ArrowUp') || k.has('KeyW')) ky -= 1;
    if (k.has('ArrowDown') || k.has('KeyS')) ky += 1;
    if (kx || ky) return normalise(kx, ky, zBias, true);

    if (this.stick.active) return normalise(this.stick.x, this.stick.y, zBias, true);

    // Live accelerometer: use the whole vector, motion included.
    if (this.sensorActive && this.accelAge < CONFIG.input.accelTimeout) {
      const v = this.accelVector();
      this.gForce = +v.mag.toFixed(2);
      return { x: v.x, y: v.y, z: v.z, motion: true };
    }

    if (this.sensorActive && this._hasOrientation) {
      const b = this.beta * DEG;
      const g = this.gamma * DEG;
      const cb = Math.cos(b);
      let dx = Math.sin(g) * cb;
      let dy = Math.sin(b);
      const dz = cb * Math.cos(g); // into the screen; unaffected by rotation

      // Rotate device x/y into CSS axes when the screen is not upright.
      const angle = this.screenAngle * DEG;
      if (angle) {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const rx = dx * c + dy * s;
        const ry = -dx * s + dy * c;
        dx = rx;
        dy = ry;
      }
      return { x: dx, y: dy, z: dz };
    }

    // No input at all: rest against the bottom and back wall.
    return normalise(0, 1, zBias, true);
  }

  update(dt) {
    this._age += dt;
    this.accelAge += dt;
    if (this._shakeCooldown > 0) this._shakeCooldown -= dt;
    this.screenAngle = this.readScreenAngle();
    if (this.demo) this.demoPhase += dt * 0.9;

    const target = this.targetVector();
    // Motion needs a light hand: smoothing that hides accelerometer noise also
    // hides the flick that makes the sand slosh.
    const rate = target.keys
      ? CONFIG.input.keySmoothing
      : target.motion ? CONFIG.input.motionSmoothing : CONFIG.input.tiltSmoothing;
    this.gx = approach(this.gx, target.x, rate, dt);
    this.gy = approach(this.gy, target.y, rate, dt);
    this.gz = approach(this.gz, target.z, rate, dt);
  }

  describe() {
    if (this.demo) return 'demo sway';
    if (this.stick.active) return 'stick';
    if (this.keys.size) return 'keys';
    if (this.sensorActive) {
      if (this.accelAge < CONFIG.input.accelTimeout) return 'accel ' + this.gForce.toFixed(1) + 'g';
      return this._hasOrientation ? 'tilt' : 'motion';
    }
    return 'idle';
  }
}

function normalise(x, y, z, keys) {
  const m = Math.hypot(x, y, z) || 1;
  return { x: x / m, y: y / m, z: z / m, keys };
}
