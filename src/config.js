// Every tunable in one place. Values are in CSS pixels and seconds; the sim is
// resolution independent and the renderer scales by devicePixelRatio.

export const CONFIG = {
  bed: {
    // Fraction of the screen height the settled bed should fill (front view).
    // Grain count is derived from this so the look is constant across devices.
    // Keep it shallow: pile depth is what the contact solver has to hold up,
    // and a bed much deeper than this starts sinking into itself no matter how
    // many iterations it gets. It also matches the reference hardware, whose
    // bed is only a shallow layer.
    fill: 0.22,
    // Depth of the box behind the glass, in grain diameters. This is the Z the
    // screen is a window into; deeper looks better but costs grains cubically.
    depthLayers: 3.5,
    // 3D random-close-packing density, converts bed volume -> grain count.
    packing: 0.64,
    minGrains: 400,
    maxGrains: 60000,
  },

  grain: {
    // radius = min(viewport) / divisor, clamped. 3D needs chunkier grains than
    // 2D did (count scales steeply with 1/r), but the default should look like
    // sand, not marbles — slow devices are the tuner's problem, not a tax the
    // designed look pays up front.
    divisor: 76,
    minRadius: 2.8,
    maxRadius: 9.5,
  },

  // Velocity-level sequential impulses. See src/grains.js for the reasoning
  // behind the velocity/position split — it is the whole basis of the solver.
  sim: {
    // Gravity magnitude = gravityScale * viewport diagonal (px/s^2). A phone
    // screen is ~50 px/cm, so true gravity would be ~50000 px/s^2; well below
    // that still reads as "falling through honey". This is the main knob for
    // how brisk and alive the sand feels.
    gravityScale: 7.0,
    // The solver runs on a fixed timestep so the feel never depends on frame
    // rate. maxSubsteps bounds catch-up work after a stall.
    fixedHz: 150,
    maxSubsteps: 4,
    // Contacts are found this far apart (fraction of a diameter) and the solver
    // then limits approach speed to the remaining gap. Detecting only actual
    // overlap leaves a grain resting exactly on a surface with no contact at
    // all — the floor stops holding the bed up and it sinks straight through.
    contactMargin: 0.05,
    // Extra reach (fraction of a diameter) baked into the contact list so it
    // survives several substeps. Finding pairs costs far more than solving
    // them, so the list is rebuilt at most once a frame — and only when some
    // grain has moved half the skin.
    skin: 0.35,
    // Grid cell size as a multiple of grain diameter; must exceed the list
    // radius (1 + skin) so the 3x3x3 scan cannot miss a pair.
    cellMul: 1.4,
    // Gauss-Seidel sweeps. Velocity iterations buy stacking stiffness (a deep
    // pile needs more); position iterations only clean up leftover overlap.
    velocityIterations: 6,
    // Bottom-up sweeps treating the supported side as ground. One is usually
    // enough and it is what lets a deep bed stand up at all.
    shockIterations: 1,
    // Approach speed (grain diameters per second) above which a contact is an
    // impact rather than a resting stack, and is left to the momentum-
    // conserving solver so it can spray instead of being absorbed.
    shockMaxApproach: 5,
    positionIterations: 3,
    // Fraction of excess penetration removed per position iteration.
    positionBeta: 0.15,
    // Overlap left uncorrected, as a fraction of a diameter. A little slack
    // here is what lets a settled bed stop fidgeting entirely.
    slop: 0.02,
    // Ceiling on one position correction, so a deep overlap unwinds over a few
    // steps instead of teleporting.
    maxCorrection: 0.08,
    // Coulomb friction. Grain-on-grain sets the angle of repose, which lands
    // well above atan(mu) because spheres have to climb out of each other's
    // pockets to move: 0.28 gives ~34°, which is real sand. Only meaningful
    // because friction is warm started — without that the solver never builds
    // enough of it to hold a slope, and the value barely matters.
    friction: 0.28,
    // Wall friction has to stay LOW and is the single most surprising knob in
    // here. The box is only a few grains deep, so roughly half of them touch
    // the glass or the back wall at any moment — at sand-on-sand values the
    // walls grip the entire bed and it rides out a 50° tilt as one rigid slab,
    // no matter what grain friction says.
    wallFriction: 0.12,
    // Bounce on impact, and the approach speed (grain diameters per second)
    // below which a contact counts as resting and does not bounce at all.
    // Sand grains barely bounce individually, but with none whatsoever a slosh
    // hits the far wall and dies instead of washing back.
    restitution: 0.3,
    restitutionCut: 6,
    // Per-second velocity decay. Keep it genuinely small: at 0.4 a slosh had
    // lost a third of its speed within a second, which flattened the rebound.
    // Warm starting is what quiets the bed now, so this does not have to.
    airDrag: 0.1,
    // Hard speed ceiling, in grain diameters travelled per substep.
    maxTravel: 1.0,
    // Neighbour search radius for shading, as a multiple of grain diameter.
    shadeRadius: 1.15,
    // Divisor for the "how buried am I" term (sum of upward contact dots).
    coverNorm: 2.4,
    // Fraction of a grain's brightness that reaches the grain beneath it.
    lightTransmit: 0.93,
    lightSmoothing: 18,
    splashSpeed: 1.0,
  },

  render: {
    maxDpr: 2,
    // Sprite sizes as multiples of grain diameter.
    beadSize: 1.15,
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
    // Gravity direction smoothing, per second. Motion gets a much lighter hand
    // than orientation: smoothing heavy enough to hide accelerometer noise also
    // hides the flick that makes the sand slosh.
    tiltSmoothing: 14,
    motionSmoothing: 45,
    keySmoothing: 8,
    // How long an accelerometer reading stays trusted before falling back to
    // orientation, and the ceiling on how many g a shake may apply.
    accelTimeout: 0.4,
    maxG: 4.0,
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
    // Downscale-only safety net, not an optimiser. Grain size is chosen from
    // the screen alone, and that is the ceiling: the tuner may coarsen grains
    // on a device that cannot keep up, and never refines past the designed
    // look. Refining was the wrong idea twice over — it made the app look
    // different depending on the GPU, and "more detail" means spawning grains,
    // which is visible as sand appearing out of nowhere seconds after load.
    //
    // Consequence: it never adds grains, so it can no longer disturb a settled
    // bed. A device that coarsens stays coarse until reload, which is a fair
    // trade for a look that never changes on its own.
    enabled: true,
    // Only sustained trouble counts — comfortably past a 60fps budget so a
    // stray spike or a background tab never triggers it.
    hiMs: 19,
    sampleFrames: 60,
    cooldown: 2.5,
    // Ignore the first seconds entirely. Every load opens with the bed
    // avalanching into place with nothing asleep yet — the most expensive
    // moment the app ever has, and an atypical one. Judging on it coarsened
    // the look on hardware that then ran the actual scene at a steady 60fps.
    warmup: 4.5,
    step: 0.18,
    // Coarsest allowed, as a fraction of the designed grain count.
    minScale: 0.22,
  },
};
