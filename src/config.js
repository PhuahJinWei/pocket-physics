// Every tunable in one place. Values are in CSS pixels and seconds; the sim is
// resolution independent and the renderer scales by devicePixelRatio.

export const CONFIG = {
  bed: {
    // Fraction of the viewport the settled bed should cover. Grain count is
    // derived from this so the look stays constant across screen sizes.
    fill: 0.34,
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
    iterations: 2,
    maxSubsteps: 5,
    // Allowed travel per substep as a fraction of a grid cell.
    substepTravel: 0.55,
    // Hard velocity ceiling as a fraction of cell/dt, so nothing tunnels.
    speedCeiling: 0.9,
    stiffness: 1.0,
    // Coulomb-ish contact friction. muS is the static cone, muK the sliding
    // coefficient; both scale with penetration depth (a pressure proxy).
    // Raise for a steeper, stickier pile; lower and the bed behaves like water.
    muS: 1.1,
    muK: 0.55,
    // Under-relaxation for the friction correction, since a grain's contacts
    // are resolved one after another rather than simultaneously.
    frictionRelax: 0.35,
    damping: 0.995,
    wallFriction: 0.5,
    // Grains with this many neighbours moving slower than sleepSpeed stop
    // completely, which is what gives a pile a stable angle of repose.
    sleepSpeed: 4.0,
    sleepContacts: 4,
    // Neighbour search radius for shading, as a multiple of grain diameter.
    shadeRadius: 1.15,
    // Divisor for the "how buried am I" term; ~1.7 is a full hemisphere.
    coverNorm: 1.7,
    // Fraction of a grain's brightness that reaches the grain beneath it.
    // Lower = light dies faster with depth = a darker, deeper-looking bed.
    lightTransmit: 0.93,
    lightSmoothing: 18,
    splashSpeed: 0.55,
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
