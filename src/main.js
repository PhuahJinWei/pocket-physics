// Wiring: viewport -> sim size, input -> gravity, frame loop, adaptive quality.

import { CONFIG } from './config.js';
import { Sand } from './sand.js';
import { Renderer } from './renderer.js';
import { GravityInput } from './gravity.js';
import { PokeInput } from './poke.js';
import { Tuner } from './tuner.js';
import { Hud } from './hud.js';
import { clamp, isTouchDevice } from './util.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('stage');
const hud = new Hud(document.getElementById('ui'));

let renderer;
try {
  renderer = new Renderer(canvas, CONFIG.bed.maxGrains, params.has('capture'));
} catch (err) {
  hud.fail(String(err && err.message ? err.message : err));
  throw err;
}

const sand = new Sand(CONFIG.bed.maxGrains);
const gravity = new GravityInput();
const poke = new PokeInput(canvas);
const tuner = new Tuner();

const touch = isTouchDevice();
const forcedGrains = intParam('grains');
const forcedRadius = floatParam('r');
if (forcedGrains) tuner.enabled = false;
if (params.has('demo')) gravity.demo = true;
if (params.has('flip')) gravity.flipped = true;
if (params.has('stats')) hud.toggleStats(true);

let viewWidth = 0;
let viewHeight = 0;
let radius = 3;
let lastFrame = performance.now();
let sensorWatchdog = 0;
let stickForced = params.has('stick');
// Set by the , / . keys so a later resize does not undo a manual grain size.
let forcedRadiusOverride = 0;

function intParam(name) {
  const v = parseInt(params.get(name) || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function floatParam(name) {
  const v = parseFloat(params.get(name) || '');
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function measureViewport() {
  const rect = canvas.getBoundingClientRect();
  return {
    width: Math.max(120, rect.width || window.innerWidth),
    height: Math.max(120, rect.height || window.innerHeight),
  };
}

function grainRadius(width, height) {
  if (forcedRadiusOverride) return forcedRadiusOverride;
  if (forcedRadius) return forcedRadius;
  const g = CONFIG.grain;
  const base = clamp(Math.min(width, height) / g.divisor, g.minRadius, g.maxRadius);
  // Performance headroom buys *finer* grains, never a deeper bed: count is
  // always whatever fills CONFIG.bed.fill, so the amount of sand on screen
  // looks the same on every device.
  return clamp(base / Math.sqrt(tuner.scale), g.minRadius, g.maxRadius);
}

function targetCount() {
  return forcedGrains ? Math.min(forcedGrains, sand.capacity) : sand.idealCount();
}

/** Re-derive grain size and count after a quality or viewport change. */
function applyQuality() {
  radius = grainRadius(viewWidth, viewHeight);
  sand.configure(viewWidth, viewHeight, radius);
  sand.setCount(targetCount());
}

function layout(initial) {
  const { width, height } = measureViewport();
  const changedALot =
    Math.abs(width - viewWidth) > viewWidth * 0.12 ||
    Math.abs(height - viewHeight) > viewHeight * 0.12;

  viewWidth = width;
  viewHeight = height;
  radius = grainRadius(width, height);
  renderer.resize(width, height);
  sand.configure(width, height, radius);

  if (initial) {
    sand.fill(targetCount());
  } else {
    sand.clampToBounds();
    if (changedALot) sand.setCount(targetCount());
  }
}

function reset() {
  sand.fill(targetCount());
}

layout(true);

// ---------------------------------------------------------------- input setup

gravity.onShake = (strength) => sand.splash(strength);

hud.onStick = (x, y, active) => {
  gravity.stick.x = x;
  gravity.stick.y = y;
  gravity.stick.active = active;
};

if (touch && gravity.supportsSensors && !gravity.demo) {
  if (!GravityInput.secureContext) {
    gravity.lastError = 'Motion sensors need https (or localhost).';
    stickForced = true;
  } else if (gravity.requiresGesture) {
    hud.showGate('Enable tilt', 'iOS needs a tap before it will share motion data.', () =>
      gravity.enableSensors(),
    );
  } else {
    gravity.attach();
  }
}

const HINT = touch
  ? 'Tilt to pour · touch to push · shake to splash'
  : 'Arrows / WASD to tilt · drag to push · space to splash · ` for stats';
hud.setHint(HINT);

poke.onFirstTouch = () => {
  // A tap is a gesture, so it is also a chance to ask for sensors on iOS.
  if (touch && !gravity.sensorActive && gravity.requiresGesture && GravityInput.secureContext) {
    gravity.enableSensors();
  }
};

// Movement keys feed the gravity vector; everything else is an action. Note
// WASD is reserved for tilting, so stats sits on backquote rather than D.
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  gravity.setKey(e.code, true);
  switch (e.code) {
    case 'Space': sand.splash(1.4); break;
    case 'KeyR': reset(); break;
    case 'Backquote': hud.toggleStats(); break;
    case 'KeyH': hud.setHint(HINT); break;
    case 'KeyF': gravity.flipped = !gravity.flipped; break;
    case 'KeyJ':
      stickForced = !stickForced;
      hud.showStick(stickForced);
      break;
    case 'BracketLeft':
    case 'BracketRight': {
      tuner.enabled = false;
      const k = e.code === 'BracketRight' ? 1.25 : 0.8;
      sand.setCount(Math.round(sand.n * k));
      break;
    }
    case 'Comma':
    case 'Period': {
      const k = e.code === 'Period' ? 1.15 : 0.87;
      radius = clamp(radius * k, 1.2, 12);
      forcedRadiusOverride = radius;
      sand.configure(viewWidth, viewHeight, radius);
      sand.setCount(targetCount());
      break;
    }
    default: return;
  }
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
}, { passive: false });

window.addEventListener('keyup', (e) => gravity.setKey(e.code, false));
window.addEventListener('blur', () => gravity.keys.clear());

let resizeTimer = 0;
function scheduleLayout() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => layout(false), 120);
}
window.addEventListener('resize', scheduleLayout);
window.addEventListener('orientationchange', scheduleLayout);
if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleLayout);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) lastFrame = performance.now();
});

// ------------------------------------------------------------------ main loop

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000, 1 / 30);
  lastFrame = now;
  if (dt <= 0) return;

  const t0 = performance.now();

  gravity.update(dt);
  const magnitude = sand.gravityMagnitude;
  poke.apply(sand, dt);
  sand.step(dt, gravity.gx * magnitude, gravity.gy * magnitude);
  renderer.draw(sand);

  const workMs = performance.now() - t0;
  if (tuner.sample(workMs, dt) && !forcedGrains && !forcedRadius) applyQuality();

  // If sensors never came alive on a touch device, offer the stick instead.
  if (touch && !gravity.sensorActive && !gravity.demo && sensorWatchdog < 3) {
    sensorWatchdog += dt;
    if (sensorWatchdog >= 3) stickForced = true;
  }
  hud.showStick(stickForced || (!touch && gravity.stick.active));

  hud.update(dt, {
    fps: tuner.fps,
    workMs,
    grains: sand.n,
    radius,
    substeps: sand.substeps,
    iterations: sand.iterations,
    pairs: sand.solvedPairs,
    scale: tuner.scale,
    gx: gravity.gx,
    gy: gravity.gy,
    source: gravity.describe(),
    beta: gravity.beta,
    gamma: gravity.gamma,
    screenAngle: gravity.screenAngle,
    flipped: gravity.flipped,
    shake: gravity.shakeMagnitude,
    width: viewWidth,
    height: viewHeight,
    dpr: renderer.dpr,
    backend: renderer.backend,
    error: gravity.lastError,
  });
}

requestAnimationFrame(frame);

// Handy from a console or a remote debugger: window.SILT.sand.splash(2) etc.
window.SILT = { sand, gravity, poke, tuner, renderer, hud, reset, applyQuality, CONFIG };
