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
    depthLayers: 5.0,
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
    // Radius spread around the mean. Identical spheres crystallise into a
    // regular lattice as they settle — visible as a woven grid across the bed —
    // and real sand never does exactly because its grains all differ.
    polydispersity: 0.18,
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
    // rate. Keep maxSubsteps tight: catch-up is a feedback loop, because a slow
    // frame hands the next step a bigger dt, which buys *more* substeps and
    // makes it slower again. Capped, a struggling device runs the sim slightly
    // slow-motion instead of spiralling — measured 37fps -> 60fps here.
    // 120Hz x 3 substeps = 25ms of simulated time available per frame, so the
    // sim stays real-time on anything holding 40fps. At 150Hz the budget was
    // 20ms, and a wide window (which maximises grain count AND gravity) dropped
    // below that mid-splash — the sim then runs in slow motion, and a splash
    // that rains out in half a second becomes seconds of drifting mist.
    fixedHz: 120,
    maxSubsteps: 3,
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
    // Grid cell size as a multiple of grain diameter; must exceed the largest
    // pair's list radius (1 + polydispersity + skin) so the 3x3x3 scan cannot
    // truncate the speculative band for the biggest grains.
    cellMul: 1.6,
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
    // A shake is modelled as the box being jerked: a body acceleration added
    // to gravity for a moment, in multiples of gravity, rather than a velocity
    // handed to each grain. See Grains.splash — writing velocities is what
    // turns a splash into a dust cloud, because per-grain velocity is relative
    // velocity, and relative velocity is what pulls a packed bed apart.
    // The floor matters more than it looks: a pulse too weak to lift the bed
    // clear of the ground leaves part of it supported while the rest rises, so
    // the bed shears against itself and goes loose. Measured at strength 1,
    // 2.6g left 5.7% of grains isolated and 3.4g left 0.5%. Once airborne
    // every grain shares the same gravity, so the mass travels rigid — the
    // dispersion only ever happens during a half-hearted launch.
    splashAccel: 3.4,
    // Added per unit of shake strength above 1. Deliberately shallow: a hard
    // shake should hit harder, but the strong end is already well clear of the
    // threshold and a linear scaling just throws sand into the ceiling.
    splashGain: 0.8,
    // Seconds the pulse lasts. Long enough to launch the bed, short enough to
    // read as a jerk rather than a change in gravity.
    splashDuration: 0.09,
    // How far the jerk tips off the gravity axis, so shakes differ and the
    // sand heaves sideways rather than hopping straight up.
    splashLean: 0.45,
  },

  render: {
    maxDpr: 2,
    // Sprite sizes as multiples of grain diameter. The grain sprite draws a
    // cluster of small matte specks rather than one ball, which is what makes
    // the sand look finer than the physics actually is — visual grain size is
    // speckRadius * clusterSize * diameter, not the physics diameter.
    clusterSize: 1.5,
    // Speck size on screen, in CSS px — held constant across devices. The
    // physics grain scales with the viewport (and is clamped), so on a wide
    // screen each sprite is nearly twice the phone's size; a fixed speck count
    // and ratio made the sand coarsest exactly where there was most room to
    // see it. The renderer picks the per-sprite speck count from this and
    // speckCoverage, rebuilding the shader when it changes.
    speckPx: 3.4,
    speckCoverage: 0.72,
    speckSpread: 1.2,
    // Airborne grains barely shrink now: the fragment shader draws them as a
    // single grain-sized speck, so shrinking the sprite on top would make a
    // flying grain smaller than it physically is.
    airShrink: 0.05,
    // Brightness scatter between specks; the grain-to-grain variation that
    // stops a bed reading as one smooth surface.
    speckVariation: 0.3,
    // Spatial patchiness: real sand varies in correlated patches (minerals,
    // moisture), not grain by grain. Scale is the patch size in CSS px.
    patchScale: 52,
    patchAmp: 0.09,
    // Sand glints as facets catch the light. Brief flashes on a few specks at
    // a time — cheap, and it does a lot of the work of selling the material.
    glintStrength: 0.16,
    glintRate: 1.2,
    // Perspective: focal length as a multiple of min(viewport w, h). Smaller =
    // more dramatic depth. Parallax shifts the eye against tilt, in px.
    // Shorter focal = more aggressive convergence toward the back. Parallax is
    // how far the eye slides against the tilt; it is the strongest depth cue
    // available on a phone because it is coupled to the hand.
    focal: 1.0,
    depthDim: 0.55,
    parallax: 65,
    // Box interior. Shaded by facing under the same light as the sand: the
    // floor catches it, the ceiling is in shadow. Back vertices are multiplied
    // by wallBackFalloff so every wall recedes into darkness.
    // Kept deliberately dim. The box only has to be *implied* — measured
    // against a background of 5/255, the old values put the floor at 67 and
    // the right wall at 57, so the empty half of the box read as a lit brown
    // panel competing with the sand. Halved, the walls sit at 2-7x the
    // background: enough to place the corners, not enough to look at.
    wallColor: [0.15, 0.125, 0.095],
    // Right was nearly as bright as the floor, which is what made the far wall
    // pop. Pulled closer to the left face, keeping some asymmetry so the box
    // still reads as lit from one side.
    wallShade: { floor: 1.0, ceiling: 0.42, left: 0.5, right: 0.58, back: 0.55 },
    wallBackFalloff: 0.55,
    background: [0.02, 0.017, 0.014],
    // Dry quartz: crevice-shadow brown for buried grains, tan through the
    // body, pale warm cream where the surface catches the light.
    deep: [0.21, 0.16, 0.115],
    mid: [0.55, 0.44, 0.30],
    lit: [0.91, 0.83, 0.66],
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
    // Finger/mouse push. The radius is a fraction of the shorter screen edge,
    // not a pixel count: fixed at 46px it reached about a hundred grains on a
    // desktop and read as a pinprick.
    pokeRadiusFrac: 0.22,
    pokeRadiusMin: 54,
    // Push strength in gravities. A packed bed absorbs a weak push completely
    // — the solver removes it as fast as it goes in, so velocity never
    // accumulates — and the old fixed 2600 (a fifth of a g on a large screen)
    // moved the sand by a *seventh of one grain* however wide the touch area
    // was. It has to be gravity-relative for the same reason the radius has to
    // be screen-relative: gravityScale follows the screen diagonal, so a fixed
    // number lands differently on every device. Past roughly 5g the travel
    // clamp caps grain speed anyway, so more strength only widens the crater.
    pokeAccel: 4.5,
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
