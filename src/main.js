// Wiring: viewport -> box size, input -> gravity, frame loop, adaptive quality.

import { CONFIG } from './config.js';
import { MaterialSet, MATERIALS } from './materials.js';
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

// Remembering the choice across reloads. localStorage *throws* rather than
// no-ops where storage is blocked — a sandboxed iframe, which is how the
// artifact build runs, or a browser set to refuse cookies — so both sides
// swallow it: remembering the material is a convenience, never a dependency.
const MATERIAL_KEY = 'silt.material';

function loadMaterial() {
  try {
    return localStorage.getItem(MATERIAL_KEY);
  } catch {
    return null;
  }
}

function saveMaterial(id) {
  try {
    localStorage.setItem(MATERIAL_KEY, id);
  } catch {
    /* storage unavailable — the session just will not be remembered */
  }
}

// Reload lands on whatever was last in the box rather than back on sand. An
// explicit ?material= still wins, so a capture or a shared link pins what it
// names. select() rejects an id it does not know and leaves the default
// standing, so a value left over from a renamed material degrades quietly.
const materials = new MaterialSet();
const startMaterial = params.get('material') || loadMaterial();
if (startMaterial) materials.select(startMaterial);
// Written back so storage tracks what is actually in the box, including when
// the query param picked it.
saveMaterial(materials.id);
let sand = materials.current;
const gravity = new GravityInput();
const poke = new PokeInput(canvas);
const tuner = new Tuner();

const touch = isTouchDevice();
const forcedGrains = intParam('grains');
const forcedRadius = floatParam('r');
if (forcedGrains || params.get('tune') === 'off') tuner.enabled = false;
if (params.has('demo')) gravity.demo = true;
if (params.has('flip')) gravity.flipped = true;
if (params.has('stats')) hud.toggleStats(true);

let viewWidth = 0;
let viewHeight = 0;
let radius = 4;
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

// Both of these are the material's call now: sand wants the finest grain the
// device can afford because every grain is visible, water wants a coarse
// particle because it is drawn as a surface. See materials.js.
function grainRadius(width, height) {
  if (forcedRadiusOverride) return forcedRadiusOverride;
  if (forcedRadius) return forcedRadius;
  return sand.preferredRadius(width, height, tuner.scale);
}

function targetCount() {
  if (forcedGrains) return Math.min(forcedGrains, sand.capacity);
  return sand.targetCount(viewWidth, viewHeight, tuner.scale);
}

/**
 * Re-derive grain size and count after a quality or viewport change.
 * `allowGrowth` is false for tuner-driven changes: the tuner may only coarsen,
 * so a step that would add grains means something is wrong, and adding sand to
 * a bed the user is watching is exactly the surprise we are avoiding.
 */
function applyQuality(allowGrowth = true) {
  radius = grainRadius(viewWidth, viewHeight);
  sand.configure(viewWidth, viewHeight, radius);
  const target = targetCount();
  sand.setCount(allowGrowth ? target : Math.min(target, sand.n));
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

/**
 * Switch what is in the box. Each material keeps its own state, so coming back
 * to one lands on the pile you left rather than re-running a settle — but a
 * material being seen for the first time has to be sized and filled here,
 * since layout() only ever ran for whichever one was current at load.
 */
function selectMaterial(id) {
  if (id === materials.id) return;
  // Asked before selecting, because reading `current` is what builds it.
  const fresh = materials.isFresh(id);
  if (!materials.select(id)) return;
  saveMaterial(id);
  sand = materials.current;
  gravity.zBias = sand.zBias;
  radius = grainRadius(viewWidth, viewHeight);
  sand.configure(viewWidth, viewHeight, radius);
  if (fresh || sand.n === 0) sand.fill(targetCount());
  else sand.clampToBounds();
  hud.setMaterial(materials.id, materials.label);
}

/** Keyboard shortcut: step to the next material in the registry. */
function switchMaterial() {
  selectMaterial(materials.nextId);
}

layout(true);
gravity.zBias = sand.zBias;
hud.setMaterials(MATERIALS, materials.id);

// ---------------------------------------------------------------- input setup

gravity.onShake = (strength) => sand.splash(strength);
hud.onMaterial = selectMaterial;

// The toolbar runs the same handlers as the keys — one behaviour, two ways in.
hud.onAction = (act) => {
  switch (act) {
    case 'splash': sand.splash(1.4); break;
    case 'flip': gravity.flipped = !gravity.flipped; break;
    case 'reset': reset(); break;
    case 'stats': hud.toggleStats(); break;
    default: break;
  }
};

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
  // While either list is open the keyboard belongs to it — otherwise arrowing
  // through the options also tilts the box, and space splashes it.
  if (hud.materialOpen || hud.menuOpen) return;
  gravity.setKey(e.code, true);
  // Before the switch: the movement keys fall through to `default` and would
  // otherwise never get here.
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  switch (e.code) {
    case 'Space': sand.splash(1.4); break;
    case 'KeyR': reset(); break;
    case 'KeyM': switchMaterial(); break;
    case 'Backquote': hud.toggleStats(); break;
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
      radius = clamp(radius * k, 1.6, 14);
      forcedRadiusOverride = radius;
      sand.configure(viewWidth, viewHeight, radius);
      sand.setCount(targetCount());
      break;
    }
    default: break;
  }
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
  sand.step(dt, gravity.gx * magnitude, gravity.gy * magnitude, gravity.gz * magnitude);

  // Parallax: shift the projection eye against the tilt, so tipping the device
  // lets you peek around the grains — a cheap but convincing depth cue.
  const P = CONFIG.render.parallax;
  renderer.eyeX = -gravity.gx * P;
  renderer.eyeY = -gravity.gy * P;
  // Which way is up, for a metal's reflected horizon. Gravity points down the
  // screen in sim axes; the composite runs +y upward, so y keeps its sign and
  // x flips. Near free-fall there is no meaningful up, so hold the last one.
  const gm = Math.hypot(gravity.gx, gravity.gy);
  if (gm > 0.05) {
    renderer.tiltUp[0] = -gravity.gx / gm;
    renderer.tiltUp[1] = gravity.gy / gm;
  }
  // Face-up is +z here, and a face-up mirror looks at the ceiling.
  renderer.tiltPitch = gravity.gz;
  // Speck density is the one part of the look the tuner can thin out; grain
  // size, its usual lever, leaves the total speck count unchanged.
  renderer.quality = tuner.scale;
  renderer.draw(sand);

  const workMs = performance.now() - t0;

  if (tuner.sample(workMs, dt) && !forcedGrains && !forcedRadius) {
    applyQuality(false);
  }

  // If sensors never came alive on a touch device, offer the stick instead.
  if (touch && !gravity.sensorActive && !gravity.demo && sensorWatchdog < 3) {
    sensorWatchdog += dt;
    if (sensorWatchdog >= 3) stickForced = true;
  }
  hud.showStick(stickForced || (!touch && gravity.stick.active));

  hud.update(dt, {
    fps: tuner.fps,
    workMs,
    material: materials.label,
    grains: sand.n,
    contacts: sand.contactCount,
    radius,
    depth: sand.depth,
    substeps: sand.substeps,
    iterations: sand.iterations,
    scale: tuner.scale,
    gx: gravity.gx,
    gy: gravity.gy,
    gz: gravity.gz,
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
// `sand` is whichever material is current — the name is historical.
window.SILT = {
  get sand() { return sand; },
  get material() { return sand; },
  materials, switchMaterial,
  gravity, poke, tuner, renderer, hud, reset, applyQuality, CONFIG,
};
