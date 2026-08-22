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
    // Normalised speed above which a grain touching nothing counts as being
    // in flight rather than simply lying somewhere by itself, and the width of
    // that ramp. Low, because speed01 saturates after a couple of pixels of
    // fall — this only has to exclude grains that are genuinely at rest.
    flightSpeed: 0.008,
    flightSpeedBand: 0.035,
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
    // more dramatic depth, more convergence toward the back.
    //
    // Raised from 1.0 because of what it does to a RESTING liquid. The eye sits
    // at the box centre, so it looks down at any pool below that, and the line
    // where the liquid meets the side glass runs from the front-top corner back
    // to the back-top corner — a level surface, but perspective projects that
    // line as a slope. At 1.0 it measured a 37px drop over the last 43px, which
    // reads as the liquid sagging into the walls when it is in fact flat.
    // Measured drop at each end, in px below the bulk surface:
    //
    //           focal 1.0   1.5    2.0    3.0
    //   water        3/5   -2/-1  -5/-5  -7/-7
    //   honey       18/1    8/-6   5/-9   3/-12
    //   mercury     82/69  55/48  44/40  35/35
    //
    // 2.0 halved it while keeping real convergence (the box's back face still
    // insets 23px on screen, against 43 at 1.0). Past that it stopped paying:
    // mercury plateaus at 35 because it genuinely stands 20px off every wall
    // (non-wetting), and water goes negative — its ends rise, which is its real
    // wetting meniscus showing once the perspective slope stops masking it.
    //
    // Raised again to 3.0 when `clipReal` was turned on below. That table was
    // measured with the spill still filling the near-wall strip, which masked
    // most of the slope; clipping stops the mask and the true drop appears —
    // measured on water, 34px at the wall at 75 degrees and 22px upright. Focal
    // is the only lever against it: 3.0 brings those to 22/12 and 4.5 to 16/5.
    // 3.0 is the point where the slope stops reading as sag while the box still
    // visibly converges; past it the box starts to read flat.
    //
    // This costs less than it looks. Parallax — the eye sliding against tilt,
    // set below — is the strongest depth cue available on a phone because it is
    // coupled to the hand, and it is untouched by focal.
    focal: 3.0,
    // The liquid field divides each blob by how much of the box its pixel's
    // view ray actually crosses, so a brim-full box reads as full right up to
    // the glass instead of thinning out into it. A ray that only clips a corner
    // crosses next to nothing, and dividing by next to nothing turns a stray
    // blob tail into solid liquid: this is the least capacity it will divide
    // by. Measured on water, at the very last pixel column: 0.05 boosted the
    // body there to 2.19x its bulk value, 0.15 to 1.2x, 0.30 undershoots to
    // 0.6x. See WATER_FIELD_FRAGMENT.
    // Lowered from 0.15 when `clipReal` was turned on. The floor existed to stop
    // the near-wall SPILL being amplified by a tiny divisor; with the spill
    // clipped there is far less left to amplify, and the floor itself became
    // the artefact — it under-corrects the outermost column, leaving it thin,
    // hence pale, hence a bright hairline against the wall. Measured on water
    // at 75 degrees, that column's excess over the body: 14.2 tones at 0.15,
    // 6.2 at 0.08, 3.8 at 0.05, and no further gain below that. Everything from
    // 2px in sits within 0.5 of the body, which is flatter than the 2.8 the
    // unclipped path managed. Do not raise this again without turning clipReal
    // off with it — the two are set together.
    rayFloor: 0.05,
    // Whether real particles are cut to the box at their own depth, as the wall
    // images already are — that is, whether a pixel may only count liquid its
    // own view ray actually reaches.
    //
    // Off, a blob's splat is ~3.5 diameters wide against a ball 1 diameter
    // across, and those tails spill into the strip along each wall where the
    // ray has already left the box. The capacity divide then amplifies the
    // spill. With the liquid lying on the BACK wall (screen near flat, face up)
    // that lands at 67% of bulk thickness — above the surface threshold, so
    // liquid is drawn, but thin enough that its alpha is under 1. The result is
    // a translucent film of liquid painted over the dry inner side wall, ending
    // in a hard 15.6-tone edge where the thickness recovers and it goes opaque.
    // That edge is the "line down the side" reported over and over; it is not
    // the wall showing through the liquid, it is liquid drawn on the wall.
    // Ruled out by ablation at that pose: relief 0, guard 9 and absorb 0 all
    // leave it unchanged, so it is neither shading, the wall guard, nor
    // Beer-Lambert.
    //
    // On, the strip reads bulk and the film is gone: the wall stays wall
    // (tone 30) out to the wedge and the liquid starts clean. A second
    // formulation was tried and measured — ramping by depth against the same
    // integral capacityAt uses, so numerator and denominator share one geometry
    // — and it produces IDENTICAL numbers, because it encodes the same physical
    // condition. There is no third option short of rebuilding the capacity
    // model, so do not go looking for one.
    //
    // The cost is that the free surface then shows its true perspective where
    // it meets the side glass, which the spill had been hiding: measured on
    // water, the waterline drops 34px at the wall at 75 degrees and 22px
    // upright, against 1-4px with the spill. `focal` is the lever against that
    // (see above) and is set to 3.0 for it, which halves the drop to 22/12
    // while keeping most of the box's depth. Toggle live from the dev panel
    // under Field. See WATER_FIELD_FRAGMENT.
    clipReal: true,
    // The liquid composite refuses to take a surface normal from a strip along
    // each wall, because two things there are box geometry rather than liquid
    // shape: the capacity correction's leftovers, and the first row of
    // particles, which sits one radius off every wall and on a flat floor is a
    // dead straight line of blobs the full width of the box. This is that strip
    // in particle radii; the composite takes whichever is wider, this or the
    // perspective band. Set by measurement — see WATER_COMPOSITE_FRAGMENT.
    //
    // It has to cover the first TWO rows, not one. Measured on settled mercury,
    // the rows above the floor sit at 15, 33 and 51px with a 10.1px radius —
    // 1.5, 3.3 and 5.0 radii, spaced about 1.8r rather than 2r because the
    // liquid is packed. At 2.5 the guard reached 25px, so it swallowed the
    // first row and left the SECOND lit: measured, a dark trough at 42px and a
    // bright ridge at 29px above the floor, an 11.7-tone step across 6px, which
    // reads as the floor of the box seen through the metal. Mercury shows it
    // worst because it is non-wetting and stands off the glass, pushing every
    // row further in. At 4.5 (45px) the step falls to 3.6 and stops being a
    // line: the sharpest gradient moves elsewhere and becomes a ramp.
    //
    // The cost is bounded and was measured: the body's own texture is untouched
    // (grain 51.38 either way, out to 5.5), only the margin loses relief, and
    // water and honey do not change at all when settled and improve when
    // sloshing (step 5.2 -> 2.7 water, 2.4 -> 1.9 honey). Past ~7 the guard
    // starts eating into the body — grain falls to 48.8 — so do not raise it
    // further to chase a wave crest, which is what the remaining swing is.
    wallGuardRows: 4.5,
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
    // A multiplier on the above, and a live one - the dev panel toggles it
    // between 1 and `wallLiftHigh` under Box.
    //
    // It exists because the halving that produced wallColor was measured with
    // a bed of sand in the box, where the walls really were competing. With the
    // box half empty - which is most poses on a desktop window, and any pose
    // just after a flip - the same values put the four faces at 2-7x a 5/255
    // background, i.e. under the threshold where a phone screen shows them at
    // all, and the empty half reads as flat black rather than as an empty box.
    // Judge it on a phone with the material at rest and the box mostly empty;
    // that is the case the shipped value has to serve, and it is not the case a
    // desktop screenshot shows.
    wallLift: 1,
    wallLiftHigh: 1.4,
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
    // Where a PACKED grain's silhouette lands, as a multiple of its own
    // radius. A little over 1 on purpose: a physics grain stands in for a
    // clump of real sand, and that sand fills its neighbourhood rather than
    // an inscribed sphere, so a jammed single layer should read as continuous
    // sand — which is what you get when the phone is laid flat and the whole
    // bed collapses into a sheet one grain thick.
    bulkSize: 1.25,
    // Where a grain resting BY ITSELF draws — its own true size. Not spray:
    // a grain lying alone in a bare patch is a grain of sand lying there, and
    // shrinking it is what left those patches as clean empty holes with
    // nothing scattered in them.
    aloneSize: 1.0,
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
    // Where a grain with NOTHING to touch draws instead, in its own radii —
    // and the bed slides between the two by contact count. Deliberately well
    // inside the grain: sand in flight is drawn by its SPECKS (which spread to
    // speckAirSpread) with the field only putting a soft core underneath them.
    // Drawn full size a flying grain is a smooth 20px disc — a bead — because
    // a lone blob's level set is a clean circle that nothing breaks up, and
    // sparse grains drawn generously merge into rounded lobes that turn a
    // splash into batter.
    soloSize: 0.5,
    // Blob profile exponent for a lone grain (the mass uses 2). Lower is a
    // gentler falloff, so the composite's fixed soft band spans more pixels
    // and that core fades out instead of ending on a hard rim.
    airPow: 0.7,
    // Ceiling on the colour ramp for sand in flight. The top of the ramp is
    // the pale cream of a sunlit surface, which a lone grain has not earned —
    // left there, a splash is a scatter of glowing beads.
    airLight: 0.45,
    // Coverage at which sand starts. This no longer decides how big anything
    // looks — bulkSize and soloSize do, and the field pass solves each grain's
    // peak to match — so it is purely the scale the field works in. Lower
    // leaves more 8-bit headroom before a deep bed clips; too low and the
    // field quantises. Nothing visual should move if you change it.
    surface: 0.042,
    soft: 0.006,
    // The threshold wanders by this much at grain scale, so the silhouette
    // breaks into fuzz instead of a smooth contour. Proportional to `surface`
    // — as an absolute offset it would swamp a low threshold and re-open the
    // holes it exists to roughen.
    dither: 0.009,
    ditherPx: 3.0,
    // Form shading from the field gradient: how strongly the gradient tilts
    // the normal, how much of the result the colour sees, and — the load
    // bearing one — how far apart the gradient is sampled, **in grain
    // diameters**. Sampled within a grain this is blob noise and it embosses
    // every grain, curdling the mass into clumps; sampled several grains apart
    // it is the shape of the pile, which is the shading that makes a bed look
    // like a heap of sand instead of a slab. It has to be a grain-relative
    // distance: as a pixel count it lands on a different physical scale on
    // every viewport and device ratio.
    relief: 2.2,
    form: 0.45,
    formGrains: 2.5,
    // Silhouette low-pass, also in grain diameters, and how much of it the
    // mask takes. The raw contour is the level set of a sum of blobs, so it
    // carries lumps at physics-grain scale; averaging across about a grain
    // removes them and the fine dither above puts the fuzz back.
    edgeGrains: 0.7,
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
    // Specks reach the full grain rather than huddling near its centre. Kept
    // short, they bunch into a little rosette per grain with smooth gaps
    // between — grouping at speck scale, which is the same tell the field
    // render exists to avoid, just an order of magnitude smaller.
    speckSpread: 1.0,
    // Spread for a grain in flight, which is drawn by its specks rather than
    // by the field. The clump has to cover the sand the grain stands for, or
    // a splash reads as dust however many specks it has.
    speckAirSpread: 1.15,
    // Fraction of a grain's disc its own specks cover. High, because the
    // specks ARE the sand: the field under them is smooth, and at a third
    // covered they read as scattered dots on a smooth surface — speckled
    // paint rather than grains. This was hidden on a desktop, where a grain
    // is twice the size and carries four times the specks for the same
    // fraction; on a phone it left the sand looking washed out and flat.
    speckCoverage: 0.75,
    // Headroom for coarsened grains: the per-grain count scales with the
    // grain's area so the sand keeps the same fineness on screen, and the
    // tuner's lever is now grain size, so this has to reach.
    speckMax: 64,
    // Floor on how far adaptive quality may thin the specks out. Below about
    // this the sand stops reading as grains at all, and a smooth bed is worse
    // than a slightly slow one.
    speckMinQuality: 0.45,
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
    // Tangential drag at the walls — no-slip — and the width of the band it
    // acts over as a multiple of rest spacing. `adhesionGlass` is the front and
    // back panes, and in a box this shallow it is the one that decides how
    // thick the liquid behaves. Water barely wets glass at this scale; honey
    // emphatically does. See Fluid.adhesion.
    adhesion: 0,
    adhesionGlass: 0,
    adhesionBand: 1.0,
    // Surface tension, as a constraint solved alongside incompressibility —
    // how far a particle moves toward its neighbourhood centroid per solver
    // iteration, 0 to 1. Zero in the interior by symmetry, so this only ever
    // acts on a surface. Water has effectively none at this scale; it is the
    // whole of what makes mercury bead. See Fluid.solveTension.
    tension: 0,
    // Ceiling on one iteration's move, as a fraction of rest spacing — the
    // same guard the pressure correction uses, for the same reason.
    tensionMaxMove: 0.25,
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
    // Coverage: alpha at the silhouette edge, and the Beer-Lambert rate at
    // which thickness turns opaque. Opacity is the strongest "gel" signal —
    // real water lets the tank show through wherever it runs thin, and it is
    // also most of what separates water from a thick liquid, so water is kept
    // deliberately see-through and honey deliberately not.
    alphaMin: 0.24,
    opacify: 4.0,
    specular: 0.9,
    // Tight. A rippled surface throws many small hard glints, which is what
    // water looks like; see the composite.
    specPower: 90.0,
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

// -------------------------------------------------------------------- grains
//
// The granular solver's tuning, as one object per material — the same shape the
// fluid side has had since honey, and for the same reason. Grains read `sim`,
// `bed` and `grain` directly for a long time, which meant the solver was
// hardcoded to exactly one granular material: a second one would silently run
// on sand's friction, restitution and grain-size distribution however its own
// config was written. That is the identical bug the fluid solver had (see the
// note in Fluid.step) and it is invisible until the new material needs a knob
// to differ, so it is fixed here BEFORE there is a second material rather than
// after.
//
// The three source objects have no overlapping keys, so the merge is lossless
// and every existing knob keeps its name and value — sand is unchanged.
//
// `gravityScale` and the splash constants are deliberately left OUT and still
// read from CONFIG.sim: they are properties of the world, not of the material,
// and the fluid solver reads them from there too. Copying them here would mean
// editing CONFIG.sim moved the liquids and not the sand.
const { gravityScale, splashAccel, splashGain, splashDuration, splashLean, ...GRANULAR } = CONFIG.sim;
CONFIG.grains = Object.assign({}, GRANULAR, CONFIG.bed, CONFIG.grain, {
  // Whether bodies spin. Off for sand, and off is the original solver to the
  // bit — a granular mass drawn as a field has no visible surface to turn, so
  // the whole cost would buy nothing. See Grains.solveVelocity.
  rotation: 0,
  // Rolling resistance, per second. Only meaningful with rotation on, and it
  // has to exist: a sphere rolling without slipping presents no sliding for
  // friction to bite on, so nothing else in the solver can ever slow one down.
  // Measured on a single marble shoved at 320 px/s across a clear floor, by how
  // far it travels in three seconds: 1.6 -> 382px, 0.5 -> 545px, 0.15 -> 620px
  // and still going. 0.6 keeps a marble travelling like a marble while still
  // letting a jar of them come to rest.
  angularDrag: 0.6,
  // Ceiling on spin, rad/s.
  maxSpin: 40,
});

// ------------------------------------------------------------------ marbles
//
// The granular solver again, but the first material that is not drawn as a
// mass: a marble IS the object, so it gets its own pass (see MARBLE_FRAGMENT).
// That is the whole reason it reads as a different substance rather than as
// recoloured sand — the speck texture is what says "sand", and marbles do not
// use it at all.
//
// What differs from sand, in order of how much it matters:
//
//   radius     Twenty-odd pixels instead of eight, which is the point: you are
//              meant to track individual objects. Count follows from the same
//              volume maths sand uses, so a bigger grain simply means fewer —
//              about 150 of them rather than 2500.
//   friction   Glass on glass, and low. Sand's 0.28 is what holds a slope; a
//              heap of marbles should not hold one, it should find its level.
//   restitution Raised. Marbles click off each other and off the glass, and
//              this is the one material where that is the whole character.
//   polydispersity  Nearly off. Sand needs a spread or identical spheres
//              crystallise into a visible lattice; marbles ARE near-identical
//              and a regular pack is what a jar of them genuinely does, so
//              only enough spread is left to keep the pack from looking
//              machined.
CONFIG.marble = Object.assign({}, CONFIG.grains, {
  divisor: 27,
  minRadius: 14,
  maxRadius: 26,
  coarseRadius: 32,
  polydispersity: 0.08,
  rotation: 1,
  friction: 0.08,
  wallFriction: 0.05,
  restitution: 0.45,
  // In grain diameters per second, and a marble diameter is now large, so this
  // has to come down or nothing ever counts as an impact and none of them ever
  // bounce at all.
  restitutionCut: 2.5,
  airDrag: 0.05,
  // Fewer layers than sand: marbles are big, and a box five diameters deep
  // would hide most of them behind each other.
  depthLayers: 3.0,
  fill: 0.30,
  minGrains: 40,
});

CONFIG.marbleLook = {
  // Air into glass. Everything inside the marble is seen along the ray this
  // bends, which is what makes the core magnify and swim as the body turns.
  ior: 1.0 / 1.52,
  // What shows THROUGH a marble. The box behind it is nearly black, and that
  // is the point: glass is dark where it transmits and bright only where it
  // reflects, and that contrast is most of what separates it from plastic.
  interior: [0.045, 0.05, 0.065],
  // The room it reflects, anchored to gravity so tipping the box sweeps the
  // horizon across the whole jar at once. Same idea as mercury.
  sky: [0.62, 0.68, 0.80],
  ground: [0.16, 0.13, 0.10],
  envSharp: 1.5,
  pitchGain: 0.45,
  lampAt: 0.55,
  lampWidth: 26,
  lampGain: 0.45,
  saturation: 0.80,
  bodyTint: 0.16,
  coreGain: 0.55,
  // Core radius as a fraction of the marble, measured against the REFRACTED
  // ray, so it is a real sphere inside the glass rather than a disc on the
  // sprite. Well inside, leaving a ring of clear glass at the rim.
  core: 0.26,
  coreSoft: 0.16,
  // The cat's eye: a flat disc through the middle in the body's own frame.
  vane: 0.85,
  // Radius of the disc IN THE GLASS, which is not what you see: the sphere is
  // a lens, so it comes out magnified by about 1.4x. 0.42 reads as a vane
  // filling a little over half the marble face-on, which is a cat's eye; at
  // 0.60 it swelled to fill nearly the whole face and went back to looking
  // like a solid coloured ball.
  vaneWidth: 0.42,
  vaneTint: 0.72,
  specular: 1.15,
  specPower: 90,
  // How far a fully buried marble darkens.
  burial: 0.55,
};

// --------------------------------------------------------------------- honey
//
// The same solver and the same two passes as water — a liquid is a liquid — so
// honey is written as the handful of numbers that differ, layered over water's.
// Built with Object.assign rather than spread into a literal so both objects
// stay live on CONFIG and can be poked from a console like everything else.
//
// What actually separates the two, in order of how much it matters:
//
//   adhesionGlass  The whole of it, and not where you would look first. The
//               box is a slab a few particles deep, so the front and back
//               panes are nearly all of the wetted area, and holding the
//               liquid against them is what creates a shear profile for the
//               viscosity to act on. Measured under a sustained 20-degree
//               tilt: water answers at 215 px/s and rings (its mean speed
//               climbs again at 2s as it sloshes back), honey at 56 and
//               creeps monotonically to the same place over about three
//               seconds. Turned off, honey is water.
//   viscosity   XSPH, which drags each particle toward its neighbours' average
//               velocity. On its own it does *nothing* to a body sliding as a
//               plug — there is no shear to resist — which is why it needs the
//               wall term. What it does own is the absence of slosh: it
//               carries the walls' grip into the body and the surface settles
//               without ringing. Past ~0.9 the fluid locks solid.
//   adhesion    The same grip on the four lateral walls, so it also coats the
//               sides it has flowed away from rather than draining clean.
//   drag        Barely above water's. Bulk drag is the obvious knob for "slow"
//               and the wrong one: gravity re-accelerates every substep, so it
//               only sets a terminal velocity, and cranked hard enough to be
//               visibly slow it deadens the shake response as well.
//   surface*    Artificial pressure exists to stop water tearing into beads;
//               honey may hold a rounder, lumpier surface, so it is eased.
//
// Honey also falls slowly, and that is a deliberate choice rather than a
// leftover. A body in flight is unavoidably touching both panes in a box this
// shallow, so no-slip decelerates a ballistic arc to roughly 40% of gravity.
// Fading the grip out above a speed does fix the fall, but the two regimes sit
// only about 1.5x apart — a gripped tilt settles near 350 px/s, a shake
// averages 540 — so no threshold separates them, and every setting that made
// the fall look right also released the grip during ordinary tilting and left
// honey behaving like water. Given the choice, thickness wins: it is the
// entire point of the material, and a slow fall reads as heavy rather than as
// wrong. See Fluid.adhesion.
CONFIG.honey = Object.assign({}, CONFIG.fluid, {
  viscosity: 0.72,
  adhesion: 6.0,
  adhesionGlass: 25.0,
  adhesionBand: 1.3,
  drag: 0.15,
  surfacePressure: 0.0002,
  // Slightly less of it, so the body reads as a heavier, shallower pool.
  fill: 0.20,
});

CONFIG.honeyLook = Object.assign({}, CONFIG.water, {
  // Amber. Honey absorbs far harder than water, but not so hard that the ramp
  // is spent inside the first few particles: at 7.5 the whole body sat at the
  // deep end of it and came out as one flat orange slab, which reads as clay.
  // Half that, and the thickness gradient is visible across the pool — thin
  // edges glowing gold, the middle going to dark amber — which is most of what
  // makes honey look lit from inside rather than painted.
  // Both ends have to sit at honey's hue, not just the bright one. A body this
  // thick spends nearly all of the Beer-Lambert ramp at the deep end, so the
  // deep colour is what you actually see: a red-brown there (hue 21) rendered
  // the whole pool at hue 24, which is past orange and nowhere near honey.
  // Real honey runs 40-45 — clover #FFC30B is 45, amber #E8A317 is 40 — so
  // both ends are set on that line and the deep end is lifted out of the mud.
  shallow: [1.00, 0.82, 0.30],
  deep: [0.55, 0.38, 0.05],
  foam: [0.99, 0.88, 0.62],
  absorb: 3.2,
  // Solid, but not a cut-out. Water is a tinted window onto the box behind it
  // and honey is a body you cannot see into, so these stay well apart — but
  // pushed to 0.88/16 the edge went opaque within a pixel of the silhouette
  // and every shape ended up a flat slab with a hard rim. The thinnest honey
  // is still translucent; it is the *body* that is not.
  alphaMin: 0.50,
  opacify: 8.0,
  // Tight, and *tighter* than water — the second time this one caught me out.
  // Broad highlights come from a rough surface, and honey is optically smooth:
  // it is a mirror with few highlights, not a diffuse one with soft ones. At
  // 22 the lobe was so wide that a flat, viewer-facing surface sat near its
  // peak, so the entire body took a uniform white lift and came out as flat
  // pale-yellow paper. Measured, that one number moved the mean from
  // (215,175,82) to (168,124,30) — from highlighter to amber.
  specular: 1.1,
  specPower: 70.0,
  fresnel: 0.20,
  // SMOOTHER than water, which is the correction that mattered most. A still
  // honey surface is a mirror; still water is not, because water is never
  // quite still. Set the other way round — honey wrinklier than water, on the
  // reasoning that a viscous surface holds whatever shape it is given — the
  // two came out with the same fine texture in the same places, and honey read
  // as water in a different colour. Measured, honey carried nearly twice
  // water's surface contrast (44 against 25) when it should carry less. What a
  // viscous surface actually holds is *large* shape, and that comes from the
  // solver refusing to level, not from the shader.
  // A slab of liquid filling the box has the same thickness along every view
  // ray, so its interior is genuinely uniform and no palette can shade it —
  // measured, thickness runs 0.65 to 0.70 across the whole body. All of the
  // form therefore has to come from the silhouette and the curved edges, which
  // is what relief shades, so it needs to be *up*, not down. What keeps honey
  // from reading as water is calmRipple: still honey is a mirror, still water
  // never is, and that is a property of the resting surface rather than of how
  // strongly the surface is lit.
  relief: 7.0,
  calmRipple: 0.06,
  rippleGain: 1.0,
  // No foam. Honey does not aerate on a shake; it heaves and folds.
  foamAmount: 0.0,
});

// ------------------------------------------------------------------- mercury
//
// The third liquid, and the first that needed a new force rather than new
// numbers. Honey differs from water in how fast it flows; mercury differs in
// what shape it wants to be, and incompressibility has nothing to say about
// that — a density constraint is indifferent to where the edge of the liquid
// is, so a body just takes the shape of whatever holds it. Mercury does the
// opposite: it holds its own shape and refuses the container's.
//
//   cohesion    Pairwise attraction, so the body pulls itself into beads that
//               merge on contact. Everything characteristic comes from here.
//   wallDensity Above 1, which is the trick for non-wetting. The term exists
//               to hand back the density a wall's missing half-space would
//               have contributed; overpay it and the wall reads as *denser*
//               than open fluid, so the liquid pushes off rather than
//               settling against it — a contact angle past 90 degrees, which
//               is exactly what mercury does to glass.
//   viscosity   Barely any. Mercury is about as runny as water and nothing
//               about it should feel thick; the beading must come from
//               tension alone, or it reads as jelly.
//   adhesion    Zero, and pointedly so. Honey's defining trait is that it
//               grips what it touches; mercury's is that it grips nothing.
CONFIG.mercury = Object.assign({}, CONFIG.fluid, {
  // In gravities: how hard the surface pulls itself in against how hard
  // gravity pulls it down. Surface tension only wins below the capillary
  // length, so how much of it is in the box matters as much as this number —
  // a pool spanning the box stays flat however hard it pulls (correctly: so
  // does mercury in a wide tray), and it is the smaller puddle that beads.
  // Measured at fill 0.05: cohesion 0 spread to 97% of the box width and 30px
  // deep, cohesion 6 pulled back to 71% and 70px deep.
  tension: 0.35,
  wallDensity: 1.8,
  viscosity: 0.06,
  drag: 0.02,
  adhesion: 0,
  adhesionGlass: 0,
  // Artificial pressure fights clustering, which is the one thing this liquid
  // is supposed to do. Eased right down, leaving the explicit cohesion term to
  // decide the shape instead of a numerical correction arguing with it.
  surfacePressure: 0.00005,
  // Distinctly less than the other liquids, and that is a physical choice
  // rather than a cosmetic one: tension can only shape a body smaller than the
  // capillary length, so a boxful of mercury would just be a flat metal floor.
  fill: 0.11,
});

CONFIG.mercuryLook = Object.assign({}, CONFIG.water, {
  // A metal, so `shallow` and `deep` stop being a depth ramp and become the
  // two ends of a reflected environment — sky above, ground below. See uMetal
  // in the composite.
  //
  // The environment is BRIGHT, at both ends. The first cut used the box's own
  // near-black as the ground, and the result averaged (68,70,75) — a dark
  // blue-grey at 28% lightness that read as wet slate. Real mercury is the
  // brightest thing in whatever room it is in, because it reflects the room:
  // its "dark" side is still a mid silver. Both ends are neutral, too; the
  // faint blue in the old deep end tinted the entire body.
  metal: 1.0,
  // Sky and ground of the reflected room. Neither is at an extreme: the sky
  // leaves headroom so the reflected light below can still be the brightest
  // thing on the surface, and the ground is a mid silver rather than a dark,
  // because mercury reflects the room even where it is "dark".
  shallow: [0.80, 0.81, 0.83],
  deep: [0.30, 0.31, 0.33],
  foam: [1.00, 1.00, 1.00],
  // The reflected room. A mirror's defining trick is that the room stays put
  // while the object moves, so all of this is measured against gravity rather
  // than the screen: tip the box and the horizon rakes across the mercury.
  //
  // envSharp is how much a given slope of surface swings the reflection. The
  // body is nearly flat, so its normals only tip a little and this has to
  // amplify hard or the whole pool sits on one flat patch of environment —
  // which is exactly what "grey blob" was.
  envSharp: 3.2,
  // How far tipping the device face-up or face-down slides the reflection. The
  // flat body of the pool has nothing else to go on — every one of its normals
  // faces the viewer — so without this it holds one tone at every angle and
  // reads as painted rather than reflective. This is the tilt sensitivity.
  pitchGain: 0.5,
  // Half-width of the horizon crossing. Small, because a mirror's horizon is a
  // line rather than a fade, and that hard edge sliding past is most of the
  // read.
  horizon: 0.45,
  // The window in the room. On a curved surface — the rim, a wave — this is a
  // band that rakes across as the thing rolls. On the FLAT body it cannot be a
  // band, because every pixel there shares one reflection, so it brightens the
  // whole pool at once as the tilt sweeps past it. Kept gentle for that reason:
  // at 0.55 it simply blew the body to white through the middle of the tilt.
  lampAt: 0.25,
  lampWidth: 40.0,
  lampGain: 0.22,
  // Opaque. Nothing gets into mercury, so there is no thickness gradient and
  // no seeing the box through it.
  alphaMin: 1.0,
  opacify: 40.0,
  absorb: 40.0,
  // A mirror: hard highlights that actually reach white, and a strong grazing
  // edge. Not as tight as the instinct says — at specPower 220 the lobe was so
  // narrow that on a half-res field almost nothing ever caught it, and the
  // body went to flat matte grey (p99 148, no whites at all). 120 gives real
  // whites (p99 255) at the crests while the flat interior stays a mid silver.
  specular: 2.0,
  specPower: 120.0,
  fresnel: 0.6,
  // The defining thing about mercury is that it is optically SMOOTH — the one
  // liquid that is a true mirror at rest. Relief here shades the particle
  // lattice, and at 14 it lit every particle as a bump: measured, 770 bright
  // specks and a luminance SD of 48 across the interior, which is what made it
  // look pebbled and wet rather than mirrored. Low relief and a near-zero calm
  // ripple keep the interior a smooth field with a single sheen; the curved
  // rim still shades because its gradient is real, not lattice noise.
  relief: 8.0,
  calmRipple: 0.06,
  // Near zero — the opposite of water. Water earns its ripple gain because
  // agitated water genuinely does ripple; a heaving metal is still a mirror,
  // and letting motion re-expose the lattice made the moving surface pebbly
  // again (138 bright specks mid-splash at 1.2, 62 at 0.2). Real waves are
  // large shape and the field still carries those; this only ever added noise.
  rippleGain: 0.2,
  foamAmount: 0.0,
});
