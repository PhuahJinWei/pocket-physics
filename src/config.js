// Every tunable in one place. Values are in CSS pixels and seconds; the sim is
// resolution independent and the renderer scales by devicePixelRatio.

export const CONFIG = {
  bed: {
    // Fraction of the viewport the settled bed should cover. Grain count is
    // derived from this so the look stays constant across screen sizes.
    fill: 0.38,
    // 2D random-close-packing density, used to convert area -> grain count.
    packing: 0.82,
    maxFill: 0.55,
    minGrains: 500,
    maxGrains: 60000,
  },

  grain: {
    // radius = min(viewport) / divisor, clamped. Keeps grains ~1/75 of the
    // short edge, which is roughly what the reference video shows.
    divisor: 150,
    minRadius: 2.0,
    maxRadius: 5.0,
    // Spatial-hash cell size as a multiple of grain diameter. Must be >= the
    // shading radius or the 3x3 neighbour scan misses contacts.
    cellMul: 1.25,
  },

  sim: {
    // Gravity magnitude = gravityScale * viewport diagonal (px/s^2).
    gravityScale: 3.0,
    // Total relaxation sweeps per frame, split across substeps: a settled bed
    // spends them all on convergence (which is what lets the deepest, most
    // compressed layers decompress), while a bed in flight spends them on
    // substeps instead. Frame cost stays roughly flat either way.
    solveBudget: 5,
    maxIterations: 5,
    // Worth being generous: the speed ceiling below scales with 1/dt, so the
    // substep cap is also the cap on how dramatic a splash can get.
    maxSubsteps: 8,
    // All three are fractions of a grain *diameter* — not of a grid cell. A
    // grain that moves further than about half its own width in one substep
    // ends up deep inside its neighbour, and the solver then flings the pair
    // apart hard enough to boil the whole bed.
    substepTravel: 0.42,
    speedCeiling: 0.45,
    // Ceiling on a single separation correction. Deep overlaps (a splash
    // landing, grains squeezed into a corner) then unwind over a few substeps
    // instead of detonating.
    maxSeparation: 0.25,
    stiffness: 1.0,
    // Coulomb-ish contact friction. muS is the static cone, muK the sliding
    // coefficient; both scale with penetration depth (a pressure proxy).
    // Raise for a steeper, stickier pile; lower and the bed behaves like water.
    muS: 3.0,
    muK: 1.2,
    // Under-relaxation for the friction correction, since a grain's contacts
    // are resolved one after another rather than simultaneously.
    frictionRelax: 0.55,
    // Floor on the penetration-as-normal-force proxy, as a fraction of a grain
    // diameter. Governs how much grip near-unloaded surface grains get, and so
    // most of the angle of repose.
    frictionPressureFloor: 0.15,
    // Dissipation, both per second so the substep count cannot change the feel.
    // A fixed per-substep factor gets this exactly backwards: a settled bed runs
    // one substep and so would be damped least, and it slowly heats up.
    // Granular energy is lost at contacts, so most of the drag is charged per
    // contact — the bulk goes quiet while airborne grains stay lively.
    airDrag: 0.25,
    contactDrag: 1.4,
    maxDragContacts: 10,
    wallFriction: 0.5,
    // A grain with at least sleepContacts neighbours, drifting slower than
    // sleepSpeed (in grain diameters per second, so it scales with the screen),
    // is snapped to a full stop. This is what holds an angle of repose and what
    // stops the last sub-pixel of solver jitter from shimmering across the bed.
    // Requiring several contacts keeps surface grains awake, so avalanche
    // fronts still flow instead of freezing mid-slide.
    // This is the single strongest control over the angle of repose: too low and
    // the pile creeps until its surface lies flat against gravity like a liquid.
    sleepSpeed: 8.0,
    sleepContacts: 4,
    // Neighbour search radius for shading, as a multiple of grain diameter.
    shadeRadius: 1.15,
    // Divisor for the "how buried am I" term; ~1.7 is a full hemisphere.
    coverNorm: 1.7,
    // Fraction of a grain's brightness that reaches the grain beneath it.
    // Lower = light dies faster with depth = a darker, deeper-looking bed.
    lightTransmit: 0.93,
    lightSmoothing: 18,
    splashSpeed: 1.4,
  },

  render: {
    maxDpr: 2,
    // Sprite sizes as multiples of grain diameter.
    beadSize: 1.35,
    glowSize: 3.2,
    glowStrength: 0.1,
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
    // m/s^2 of gravity-excluded acceleration that counts as a shake.
    shakeThreshold: 13,
    shakeCooldown: 0.35,
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
    cooldown: 1.2,
    step: 0.08,
    minScale: 0.35,
    maxScale: 2.0,
  },
};
