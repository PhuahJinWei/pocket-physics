// Every tunable in one place. Values are in CSS pixels and seconds; the sim is
// resolution independent and the renderer scales by devicePixelRatio.

export const CONFIG = {
  bed: {
    // Fraction of the screen height the settled bed should fill (front view).
    // Grain count is derived from this so the look is constant across devices.
    fill: 0.34,
    // Depth of the box behind the glass, in grain diameters. This is the Z the
    // screen is a window into; deeper looks better but costs grains cubically.
    depthLayers: 4.0,
    // 3D random-close-packing density, converts bed volume -> grain count.
    packing: 0.64,
    minGrains: 400,
    maxGrains: 60000,
  },

  grain: {
    // radius = min(viewport) / divisor, clamped. 3D needs chunkier grains than
    // 2D did: count scales with 1/r^3, so halving the radius is 8x the grains.
    divisor: 80,
    minRadius: 3.2,
    maxRadius: 9.5,
    // Spatial-hash cell size as a multiple of grain diameter. Must be >= the
    // shading radius or the 3x3x3 neighbour scan misses contacts.
    cellMul: 1.25,
  },

  sim: {
    // Gravity magnitude = gravityScale * viewport diagonal (px/s^2). A real
    // phone screen is ~50 px/cm, so true gravity would be ~50000 px/s^2 —
    // far below that reads as "falling through honey". This is the knob for
    // how brisk and alive the sand feels.
    gravityScale: 4.5,
    // Total relaxation sweeps per frame, split across substeps: a settled bed
    // spends them all on convergence (which is what lets the deepest, most
    // compressed layers decompress), while a bed in flight spends them on
    // substeps instead. Frame cost stays roughly flat either way.
    solveBudget: 8,
    maxIterations: 8,
    // Also the cap on how fast anything may move: max speed is roughly
    // substepTravel * maxSubsteps * diameter * 60/s. Too low and splashes and
    // free fall visibly hit a terminal-velocity ceiling.
    maxSubsteps: 12,
    // Both are fractions of a grain *diameter* — not of a grid cell. A grain
    // that moves further than about half its own width in one substep ends up
    // deep inside its neighbour, and the solver then flings the pair apart
    // hard enough to boil the whole bed.
    substepTravel: 0.45,
    speedCeiling: 0.5,
    // Ceiling on a single separation correction. Deep overlaps (a splash
    // landing, grains squeezed into a corner) then unwind over a few substeps
    // instead of detonating.
    maxSeparation: 0.45,
    stiffness: 1.0,
    // Coulomb-ish contact friction. muS is the static cone, muK the sliding
    // coefficient; both scale with penetration depth (a pressure proxy).
    // Keep these moderate: piles get their permanence from sleep, not from
    // friction — overdoing friction makes the bed feel like wet clay.
    // Strong enough that the loaded bed floor jams solid instead of creeping
    // sideways under the pile's weight forever. Responsiveness to tilt comes
    // from the wake dynamics, not from weak friction.
    muS: 2.0,
    muK: 0.85,
    // Under-relaxation for the friction correction, since a grain's contacts
    // are resolved one after another rather than simultaneously.
    frictionRelax: 0.75,
    // Floor on the penetration-as-normal-force proxy, as a fraction of a grain
    // diameter, so near-unloaded surface grains get some grip too.
    frictionPressureFloor: 0.05,
    // Dissipation, per second so the substep count cannot change the feel.
    // Granular energy is lost at contacts, so most of the drag is charged per
    // contact — the bulk goes quiet while airborne grains stay lively.
    airDrag: 0.15,
    contactDrag: 0.55,
    maxDragContacts: 12,
    // Rolling resistance: extra per-second drag on grains moving slower than
    // rollingBelow (multiples of the sleep speed). Real grains are angular and
    // stop rolling almost immediately; perfect spheres would trundle around
    // trading momentum forever, each one keeping its neighbours' sleep debt
    // from ever maturing. Leaves anything faster than a crawl untouched.
    rollingDrag: 7.0,
    rollingBelow: 1.6,
    wallFriction: 0.45,
    // Sleep, the hysteretic kind. A grain drifting slower than sleepSpeed (in
    // grain diameters per second) with at least sleepContacts neighbours goes
    // fully dormant: no gravity, no solver corrections, zero motion — which is
    // both what makes a resting bed pixel-still and what holds a pile's shape.
    // It wakes when pushed by more than wakePressure (fraction of a diameter,
    // accumulated over a frame), or when gravity swings by gravityWakeAngle
    // degrees — that global wake is what lets the whole bed slump at once on a
    // hard tilt instead of peeling off layer by layer.
    sleepSpeed: 3.0,
    sleepContacts: 4,
    // A grain must stay slow for this many consecutive substeps before it may
    // sleep. Without the delay, a freshly woken bed re-freezes before gravity
    // has had a single frame to accelerate it — which is exactly the "back
    // grains wait for the front" stickiness, reintroduced through the back door.
    sleepDelay: 20,
    wakePressure: 0.1,
    // Minimum speed (diameters/s) a grain needs before it can wake sleepers at
    // all. Resting grains lean into their support by g*dt^2 every substep, and
    // slow surface trickle re-energises the bed floor in a perpetual simmer —
    // so only ballistic grains (splash landings, a poured stream) transmit
    // wakefulness. Everything slower relies on the tilt/poke/splash wakes.
    wakeSpeed: 25,
    // Overlap (fraction of a diameter) against a sleeper that wakes it outright.
    // Catches grains trapped in pockets that froze too small for them. Must sit
    // well above the bed's equilibrium load-bearing overlap or it wakes the
    // pile floor in a perpetual storm — check the stats panel's awake count
    // holds near zero at rest after touching gravity or stiffness.
    pinchWake: 0.55,
    gravityWakeAngle: 10,
    // Neighbour search radius for shading, as a multiple of grain diameter.
    shadeRadius: 1.15,
    // Divisor for the "how buried am I" term (sum of upward contact dots).
    coverNorm: 2.4,
    // Fraction of a grain's brightness that reaches the grain beneath it.
    lightTransmit: 0.93,
    lightSmoothing: 18,
    splashSpeed: 1.1,
  },

  render: {
    maxDpr: 2,
    // Sprite sizes as multiples of grain diameter.
    beadSize: 1.35,
    glowSize: 3.2,
    glowStrength: 0.1,
    // Perspective: focal length as a multiple of min(viewport w, h). Smaller =
    // more dramatic depth. Parallax shifts the eye against tilt, in px.
    focal: 1.4,
    depthDim: 0.45,
    parallax: 40,
    background: [0.008, 0.016, 0.035],
    // Deep (buried) -> mid -> ice (surface). Fast grains blow out to white.
    deep: [0.035, 0.11, 0.42],
    mid: [0.1, 0.45, 0.96],
    ice: [0.68, 0.9, 1.0],
  },

  input: {
    // Gravity direction smoothing, per second.
    tiltSmoothing: 14,
    keySmoothing: 8,
    // Fixed into-screen gravity bias for keyboard/stick/demo input, so the bed
    // leans against the back wall and the box reads as 3D on desktop too.
    zBias: 0.45,
    // m/s^2 of gravity-excluded acceleration that counts as a shake, and how
    // long after load before shakes are armed (picking the phone up spikes the
    // accelerometer hard enough to read as several shakes otherwise).
    shakeThreshold: 13,
    shakeCooldown: 0.35,
    shakeArmDelay: 1.5,
    // Finger/mouse push.
    pokeRadius: 46,
    pokeStrength: 2600,
    pokeDrag: 0.85,
  },

  tuner: {
    // Target CPU+GPU frame budget. Below lo we add grains, above hi we remove.
    loMs: 9.5,
    hiMs: 14.5,
    sampleFrames: 45,
    cooldown: 2.5,
    step: 0.18,
    minScale: 0.22,
    maxScale: 2.0,
  },
};
