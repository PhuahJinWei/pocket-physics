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
    // Ceiling for the tuner only. maxRadius caps the size the app *chooses*;
    // this caps how far a struggling device may coarsen past it. Since sand is
    // drawn as a mass, a bigger grain is nearly invisible while fewer grains
    // is visibly less sand — so coarsening is the right lever and it needs
    // somewhere to go. See Grains.preferredRadius.
    coarseRadius: 16,
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
    // Perspective: focal length as a multiple of min(viewport w, h). Smaller =
    // more dramatic depth. Parallax shifts the eye against tilt, in px.
    // Shorter focal = more aggressive convergence toward the back. Parallax is
    // how far the eye slides against the tilt; it is the strongest depth cue
    // available on a phone because it is coupled to the hand.
    focal: 1.0,
    // How far the back of the box falls into shadow: sand and specks fade
    // this fraction of the way toward `fog` at full depth. A colour, never a
    // coverage — sand deep in the box is opaque sand, just further away.
    depthDim: 0.5,
    // Depth at which that fade begins. The per-pixel depth is an average along
    // the view ray, so the front face of the bed already reads as mid-depth
    // once the grains behind it are summed in; fogging from zero greyed the
    // whole mass by a fifth. Only what is genuinely toward the back pays.
    fogStart: 0.45,
    // What they fade toward: the box's own darkness, a shade warmer than the
    // back wall so deep sand still reads as sand in shadow rather than as a
    // hole.
    fog: [0.10, 0.075, 0.05],
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
    // Dry quartz: shadowed brown for buried sand, warm tan through the body,
    // pale cream where the surface catches the light. Buried sand is only a
    // little darker than the surface — against the glass, real sand is nearly
    // one tone — so the deep end stays well up from black. Measured against
    // real dry sand (beach sand #C2B280 is 45 deg / 35% sat / 63% light), the
    // rendered mass wants to land near 40 deg / 35% / 62%; greyer than that
    // reads as damp sand or concrete.
    deep: [0.34, 0.25, 0.15],
    mid: [0.70, 0.56, 0.37],
    lit: [0.96, 0.87, 0.66],
  },

  // The sand look. See src/shaders.js for the idea: the pile is drawn as one
  // continuous mass from a coverage field, and the grain texture comes from
  // tiny independent specks on top. Physics grains are never drawn as such.
  sand: {
    // Fraction of the canvas the coverage field is rendered at. Half res is
    // cheaper and doubles as the blur that turns blobs into a mass.
    fieldScale: 0.5,
    // Blob radius as a multiple of the grain radius. This is what smooths the
    // silhouette: at 1.6 every surface grain stood out of the pile as its own
    // rounded lump — a metaball outline at physics-grain scale, which is
    // exactly the scale sand must not have. Wide blobs low-pass the surface
    // over a couple of grains, so it reads as a slope with fuzz on it.
    blob: 2.3,
    // Peak contribution of one blob. The interior sums twenty-odd overlapping
    // blobs and the field is 8-bit, so this has to keep that sum below 1 — a
    // clipped coverage channel throws the light average off. Measured on a
    // settled 4.5k-grain bed: 0.11 clipped 0.27% of field pixels, 0.09 none,
    // and a single layer of sand still sums to about three times the
    // threshold.
    gain: 0.09,
    // How much less a grain at the back of the box counts in the field's
    // AVERAGES (light, speed, depth). Kept small on purpose — this also scales
    // coverage, and sand is opaque however deep it sits. At 0.55 the sand
    // visible only at the back of the box (the band above the front surface
    // when the bed leans on the back wall) drew as a translucent smear that
    // tore into holes: measured, its coverage ramped 6 -> 46 against a
    // threshold of 22. Depth belongs to colour, via render.depthDim.
    depthWeight: 0.12,
    // A grain touching nothing draws its blob this much NARROWER (graded by
    // how few contacts it has). This is a width, not a brightness: a narrow
    // blob cannot bridge to the mass and hang off it as a drip. Its peak is
    // solved for separately — see uSoloSize and the field vertex shader.
    looseShrink: 0.35,
    // Where a lone grain's silhouette lands, as a fraction of its true radius.
    // The physics grain is many real grains' worth of sand, so drawing a
    // flying one slightly under size reads as spray rather than as a boulder —
    // but only slightly: drawn at a quarter size, thousands of them are a dust
    // cloud even while the simulation is perfectly sane. It also sets how hard
    // a lone grain has to shout to clear the threshold, and therefore how many
    // may overlap before the 8-bit field clips, so it is cheap to keep modest.
    // Deliberately well inside the grain: a grain in flight is drawn by its
    // SPECKS (which spread to speckAirSpread), and the field only supplies a
    // soft core underneath them. Drawn as a full-size blob instead, a flying
    // grain is a smooth 20px disc — a bead — because a lone blob's level set
    // is a clean circle that nothing breaks up.
    soloSize: 0.5,
    // Blob profile exponent for a lone grain (the mass uses 2). Lower is a
    // gentler falloff, so the composite's fixed soft band spans more pixels
    // and that core fades out instead of ending on a hard rim.
    airPow: 0.7,
    // Ceiling on the colour ramp for sand in flight. The top of the ramp is
    // the pale cream of a sunlit surface, which a lone grain has not earned —
    // left there, a splash is a scatter of glowing beads.
    airLight: 0.45,
    // Coverage at which sand starts, and the width of the anti-aliased edge.
    // A lone grain's blob peaks at `gain`; this threshold draws it a little
    // *under* its physical size (about 0.8 of its radius), which tightens the
    // grains protruding from a surface into small bumps rather than domes.
    surface: 0.085,
    soft: 0.012,
    // The threshold wanders by this much at grain scale, so the silhouette
    // breaks into fuzz instead of a smooth contour.
    dither: 0.02,
    ditherPx: 3.0,
    // Form shading from the field gradient: how strongly the gradient tilts
    // the normal, how much of the result the colour sees, and — the load
    // bearing one — how far apart the gradient is sampled, in field texels.
    // Sampled at one texel this is blob noise and it embosses every grain;
    // sampled several grains apart it is the shape of the pile, which is the
    // shading that makes a bed look like a heap of sand instead of a slab.
    relief: 2.2,
    form: 0.45,
    formRadius: 7.0,
    // Silhouette low-pass: radius in field texels, and how much of it the
    // mask takes. The raw contour is the level set of a sum of 15-20px blobs,
    // so it carries lumps at physics-grain scale; averaging wider removes
    // them and the fine dither above puts the fuzz back.
    edgeRadius: 3.0,
    edgeSmooth: 0.75,
    // Fast sand pales a little toward dust.
    pale: 0.15,
    // Spatial patchiness: real sand varies in correlated patches (minerals,
    // moisture), not grain by grain. Scale is the patch size in CSS px.
    patchScale: 52,
    patchAmp: 0.09,

    // Specks: the visible grain. Diameter on screen in CSS px, held constant
    // across devices; how far each grain scatters its specks (multiple of
    // its radius); and how much of a grain's projected disc its own specks
    // cover — the per-grain count follows from that and the grain size.
    speckPx: 2.4,
    speckSpread: 0.85,
    // Spread for a grain in flight, which is drawn by its specks rather than
    // by the field. The clump has to cover the sand the grain stands for, or
    // a splash reads as dust however many specks it has.
    speckAirSpread: 1.15,
    speckCoverage: 0.32,
    // Headroom for coarsened grains: the per-grain count scales with the
    // grain's area so the sand keeps the same fineness on screen, and the
    // tuner's lever is now grain size, so this has to reach.
    speckMax: 48,
    speckAlpha: 0.85,
    // Per-speck relief: each speck gets a lit crest and a shadowed far side
    // under one global light. This is where the fine realism lives, and it is
    // here rather than in the composite because a speck rides the simulation —
    // so the relief travels with the sand instead of standing still while the
    // sand pours through it. `round` is how domed a speck is; higher is
    // flatter, and below about 0.3 the shadowed sides go black.
    speckRelief: 0.42,
    speckRound: 0.55,
    // Sand in flight gets this many times the bed's specks, at this size:
    // more and finer, so a splash reads as spray rather than as a puff.
    speckAirMul: 2.2,
    speckAirSize: 0.8,
    // Mineral mix. Fractions of specks that are dark grains and bright quartz,
    // their tones relative to the body, and the spread of everything else.
    speckDark: 0.10,
    speckDarkTone: 0.6,
    speckBright: 0.10,
    speckBrightTone: 1.16,
    speckVary: 0.16,
    // Specks toward the back of the box thin out a little. Only a little:
    // they are the texture, and sand seen deeper in the box is still sand.
    // Fading them out entirely left the back reading as smooth mud.
    speckDepthFade: 0.3,
    // Sand glints as facets catch the light: brief, sparse, on the bright
    // specks only, more readily when moving. Restrained on purpose — now that
    // every speck carries its own lit crest, the bed already sparkles a
    // little on its own, and at 0.35 on top of that it read as sugar.
    glintStrength: 0.18,
    glintRate: 1.6,
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

  // --------------------------------------------------------------- water
  // Position Based Fluids. See fluid.js for why this is a separate solver
  // rather than the granular one with friction set to zero.
  fluid: {
    // Water particles are far coarser than sand grains, and deliberately so:
    // sand needs a high count because every grain is visible, while water is
    // drawn as a surface and hides its particles entirely. Coarser particles
    // mean the same volume of liquid for a quarter of the work.
    divisor: 62,
    minRadius: 5,
    maxRadius: 15,
    depthLayers: 4,
    fill: 0.24,
    minParticles: 200,
    maxParticles: 6000,

    // Kernel support as a multiple of rest spacing. 2.0 gives ~30 neighbours,
    // which is the usual working point: fewer and the density estimate is too
    // noisy to hold a flat surface, more and the cost climbs as the cube.
    smoothingRatio: 2.0,
    // Poly6 for density, Spiky for its gradient, both normalised to W(0)=1.
    // Their ratio is the only constant that has to survive that normalisation:
    // (45/pi h^4) / (315/64 pi h^3) = 2880/315/h, which is GRAD_K in fluid.js.
    solverIterations: 4,
    // Constraint force mixing. Stops lambda blowing up where a particle has
    // almost no neighbours (a lone drop of spray) and the denominator vanishes.
    relaxation: 0.0008,
    // Artificial pressure: strength, and the distance it peaks at as a
    // fraction of the smoothing radius. Counteracts the tensile instability
    // that otherwise pulls surface particles into beads and strands.
    surfacePressure: 0.0004,
    surfaceDistance: 0.2,
    // Ceilings, both as fractions of rest spacing. A single solver iteration
    // may not shove a particle further than maxCorrection, and a substep may
    // not move one further than maxTravel — past a cell width the neighbour
    // list it was solved against is no longer the one it lands in.
    maxCorrection: 0.35,
    maxTravel: 0.9,
    // Room above the measured mean of ~30. Overflowing silently would drop
    // real neighbours and read as a density hole.
    maxNeighbours: 64,
    // How much of the missing-half-space density to hand back at a wall (see
    // Fluid.solveDensity). Full strength is what the geometry says, and once
    // the terms are combined as a union rather than summed it is also what
    // behaves: measured across 0 to 1 the bulk settles at 1.08x rest either
    // way, so there is nothing to buy by weakening it, and weakening it only
    // presses more particles flat against the glass.
    wallDensity: 1.0,
    // Closest two particles may sit, as a fraction of rest spacing, and how
    // much of any overlap is resolved per substep. Well below rest, so normal
    // compression never touches it — this exists only to break up the welded
    // beads described in Fluid.separate, which the density constraint cannot.
    minSeparation: 0.62,
    separationStiffness: 0.8,

    // XSPH velocity smoothing. This is the whole of the viscosity model, and
    // it is what makes water pour rather than shatter.
    viscosity: 0.12,
    drag: 0.05,
    fixedHz: 60,
    maxSubsteps: 2,
    foamSmoothing: 9,
  },

  water: {
    // Sprite size as a multiple of particle diameter. Generous on purpose: the
    // blobs have to overlap heavily or the field is lumpy and the surface
    // inherits the lumps.
    // Well above the 2.0 that would merely make blobs touch. Particles at rest
    // sit on a lattice, and a kernel only as wide as the spacing leaves a
    // ripple at exactly that frequency — the body came out visibly striped.
    // Wide blobs average the lattice away.
    blobSize: 3.6,
    // Per-particle peak contribution to the thickness field. Moves inversely
    // with blobSize (wider blobs overlap more), and tuned so a full body sits
    // below saturation — once the field clips at 1.0 its gradient goes flat and
    // the surface loses every ripple.
    gain: 0.058,
    // Fraction of the canvas the field is rendered at. Half res is cheaper and
    // doubles as the blur that turns blobs into a surface.
    fieldScale: 0.5,
    // Thickness at which water starts, and the width of the soft edge. Low on
    // purpose: a higher threshold pulls the level set inward from the glass and
    // rounds off the corners, which reads as a block of gel rather than a tank
    // of water. Low, and the water meets the wall square.
    surface: 0.055,
    soft: 0.055,
    // Beer-Lambert absorption: how fast colour deepens with thickness.
    absorb: 4.2,
    // How strongly the thickness gradient tilts the surface normal.
    relief: 7.0,
    // Fraction of that relief a *calm* body keeps, and how fast agitation
    // restores the rest. The particle lattice leaves a permanent fine ripple
    // in the field; shaded at full relief it reads as wrinkled plastic, so a
    // still surface is held nearly glassy and only moving water ripples.
    calmRipple: 0.1,
    rippleGain: 2.5,
    // Wall images are scaled by the neighbour count of the particle they
    // mirror (see Renderer.packWater). Measured against this box: a thin film
    // draining down the glass sits near 14 neighbours, bulk water against the
    // same wall near 26, so the ramp runs between them. Below the floor the
    // image never vanishes entirely, so the body still meets the glass instead
    // of fraying away from it.
    imageBuriedLo: 10,
    imageBuriedHi: 24,
    imageFloor: 0.2,
    // Coverage: alpha at the silhouette edge, and the Beer-Lambert rate at
    // which thickness turns opaque. Opacity is the strongest "gel" signal —
    // real water lets the tank show through wherever it runs thin.
    alphaMin: 0.35,
    opacify: 5.0,
    specular: 0.9,
    fresnel: 0.10,
    // Foam wants to be rare. Keyed on speed, it fired across the whole crest of
    // every wave and turned the water white; it should only catch the fastest
    // thin edges, so the bias sits well up the speed range.
    foamAmount: 1.4,
    foamBias: 0.42,
    shallow: [0.32, 0.62, 0.68],
    deep: [0.03, 0.16, 0.30],
    foam: [0.90, 0.95, 0.97],
  },
};
