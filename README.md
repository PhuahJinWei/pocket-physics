# Silt

A shallow 3D box of sand behind the glass: thousands of simulated grains that
pour, pile and splash as you tilt your phone. Started as a recreation of
[this ESP32-S3 demo](https://www.instagram.com/p/DbtqKz3jssZ/) and later steered
toward realism — warm quartz rather than the reference's glowing blue. Built for
phones first, desktop second.

No build step, no dependencies. Plain ES modules and WebGL — open `index.html`
from any static server and it runs.

## Running it

```bash
python -m http.server 8146
```

Then open <http://localhost:8146>. On desktop the sand is driven by the keyboard;
the tilt sensors need a phone (see below).

## On a phone

Motion sensors only work on a **secure origin**. `http://192.168.x.x:8146` from
your phone will load the page but the tilt will never respond — there is no
workaround for this, it is a browser rule. Either:

- serve it over https from any static host (drop `dist/silt.html` on Netlify,
  GitHub Pages, Vercel, an S3 bucket — it is one self-contained file), or
- tunnel localhost with https (`cloudflared tunnel --url http://localhost:8146`).

iOS additionally requires a **user gesture** before it will hand over motion
data, so the page shows an "Enable tilt" button on first load. If sensors are
unavailable for any reason, a virtual tilt pad appears after a few seconds so the
page is still usable.

Build the single-file versions with:

```bash
python tools/bundle.py
```

## Controls

|                | Phone                     | Desktop                        |
| -------------- | ------------------------- | ------------------------------ |
| Gravity        | tilt the device           | arrow keys / WASD              |
| Push the sand  | touch and drag (multi-touch) | click and drag              |
| Splash         | shake                     | space                          |
| Material       | tap the pill, pick one    | pill, or `M` to cycle          |
| Reset the bed  | —                         | `R`                            |
| Stats panel    | —                         | `` ` ``                        |
| Tilt pad       | shown automatically       | `J`                            |
| Flip tilt axes | —                         | `F`                            |
| Grain count    | —                         | `[` `]`                        |
| Grain size     | —                         | `,` `.`                        |

URL parameters: `?stats` opens the stats panel, `?demo` runs a hands-free sway
(useful for screenshots and for checking the sim without sensors), `?grains=8000`
and `?r=3` pin the grain count and radius, `?material=water` opens straight into
water, `?tune=off` disables adaptive quality, `?stick` forces the tilt pad, and
`?capture` enables `preserveDrawingBuffer` so screenshot tools can read the
canvas.

## How it works

```
main.js        frame loop, viewport → sim size, quality changes
  gravity.js     accelerometer / keys / tilt pad → an effective gravity vector
  poke.js        pointers → push impulses
  materials.js   what is in the box; the interface both solvers implement
    grains.js      sand — sequential impulses
    fluid.js       water — position based fluids
    grid.js        counting-sort spatial hash, shared by both
  renderer.js    WebGL: both materials as a screen-space field, sand plus specks
    shaders.js       sand field, composite, specks, and the box walls
    water-shaders.js
  tuner.js       adaptive quality
  hud.js         stats panel, hint line, permission prompt, tilt pad
config.js      every tunable, in one place
```

**Materials.** Sand and water are separate solvers behind one interface
(`materials.js` documents it in full). Adding one is a single entry in the
`MATERIALS` registry: the picker builds itself from that list, so a new material
appears in the UI with its swatch and needs no markup, styling or wiring. They share the spatial hash, the fixed
timestep, the tilt input, the shake pulse and the box; they share nothing else,
because water is not sand with the friction turned off. A Coulomb contact solver
with `mu = 0` is a *frictionless granular gas* — it resists penetration and
nothing else, so it stays compressible and never develops the pressure gradient
that makes water find its own level.

A material also decides its own particle size and count, because the right
answer differs: sand wants the finest grain the device can afford since every
grain is visible, while water is drawn as a surface and its particles never are,
so it uses coarse ones. Measured on a 1600×865 desktop, water is about **half
the cost of sand** — 1,700 particles at 7.8 ms against 4,700 grains at 14.2 ms.

**Simulation.** Velocity-level sequential impulses in a shallow 3D box (the
screen is the front glass; the box extends a few grain diameters in Z), over a
uniform 3D spatial hash, in typed arrays with no per-frame allocation. Grains
are equal-mass spheres with no rotational degree of freedom, so friction is pure
sliding friction. Radii are **polydisperse** (±18% around the mean): identical
spheres crystallise into a regular lattice the moment they settle — visible as a
woven grid across the whole bed — and no spawn jitter keeps them from finding it
again. Real sand never crystallises for exactly this reason, and the size
spread is also what breaks the sprite tiling on large screens. Each fixed substep: gravity, find contacts, solve velocities,
integrate, then repair leftover overlap.

The velocity/position split is the whole basis of the solver. An impulse can only
remove kinetic energy, so contacts can never manufacture motion, and the position
pass repairs penetration *without* writing back into velocity, so geometry never
becomes energy either. Resolving overlap by moving grains and then re-deriving
velocity from that movement — the obvious approach, and what an earlier version
of this did — pumps energy into every contact and boils the bed, which no amount
of damping, sleeping or clamping can hide. Because nothing injects energy the bed
settles on its own, so there is **no sleep system**: every grain integrates every
step, which is why tilt response is immediate and flow is continuous.

Four details carry more weight than they look:

- **Warm starting.** Each contact begins the step by re-applying the impulse it
  settled on last time — kept in a hash keyed by the contact pair, since
  rebuilding the list shuffles indices. This is what makes the bed *actually*
  still. From a cold start the solver has to rediscover the entire weight of the
  pile inside its iteration budget every step, always falls slightly short, and
  the bed sinks a little, gets pushed out, and sinks again: a permanent low
  simmer that no amount of damping removes. Friction is warm started the same
  way, accumulated as a vector and clamped as a whole, which is what produces
  true static friction — and therefore an angle of repose that responds to `mu`
  at all.
- **Speculative contacts.** Pairs are found slightly *before* they touch and the
  solver limits approach to the remaining gap. Detecting only actual overlap
  leaves a grain resting exactly on a surface with no contact at all — the floor
  stops holding the bed up and it sinks straight through.
- **Shock propagation.** One bottom-up sweep treats the deeper grain of each pair
  as immovable. Between equal masses an impulse only averages their velocities,
  so support crawls up a stack geometrically and a deep bed crushes itself; the
  floor, treated as ground, carries support to the surface in one pass.
- **Wall friction must stay low.** The box is only a few grains deep, so about
  half of them touch the glass at any moment. At sand-on-sand values the walls
  grip the whole bed and it rides out a 50° tilt as one rigid slab, whatever
  grain friction says.

**Sloshing.** Gravity comes from the accelerometer's *whole* vector, not just
the orientation-derived direction of down. A box being carried is a non-inertial
frame: its contents feel gravity plus a pseudo-force opposing however the box is
being accelerated, which is precisely what `accelerationIncludingGravity` reads.
Driving the sim from orientation alone gives only which way is down, so flicking
the phone merely rotates gravity smoothly and the sand slides over and stops
dead. Feeding the whole vector in is what makes it slosh — the flick throws the
sand one way, and stopping the flick throws it back.

Two smaller pieces feed the same feel. Contacts have a little restitution above
an impact threshold (resting contacts stay perfectly inelastic, or the bed
buzzes). And the shock pass is **gated to slow contacts**: treating the
supported grain as ground is what holds a pile up, but applied to a fast impact
it dumps that momentum into "ground" instead of passing it along the contact
chain, so sand hitting a wall gets swallowed rather than spraying back.

The accelerometer's sign convention differs between iOS and Android, and
guessing wrong inverts every push, so it is calibrated at runtime by comparing
the reading against orientation-derived gravity while the device is near still.

**The sand look.** The physics grain is 10–16 px across — far too big to be a
grain of sand — and every renderer that gave it a shape of its own drew
something else: shiny beads first, then, dressed as a rigid cluster of small
specks, popcorn. The scale a viewer locks onto is the scale that *moves*, and a
puff of specks travelling as one body is a puff however fine the specks. So the
grains are no longer drawn at all. Sand is drawn as a **mass**, the way water
already was:

- **Field pass.** Every grain splats a wide soft blob into an offscreen
  half-resolution buffer, summed: a smooth coverage field, plus the sim's
  bed-level light and speed carried along as weighted averages. Blobs are
  about 2.3 grain radii wide on purpose — at 1.6 every surface grain still stood
  out of the pile as its own rounded lump, a metaball outline at exactly the
  scale sand must not have. Wide blobs low-pass the surface over a couple of
  grains, and it reads as a slope with fuzz on it.
- **Composite.** The level set of that field is the silhouette, jittered by
  grain-scale noise so the edge is fuzz rather than a clean clay contour. The
  light channel colours the mass (open surface toward cream, buried sand toward
  brown); the coverage gradient brightens crests that face the light — brighten
  only, because darkening the lee side as well drew a dark rim along every
  shadowed edge, which reads as an outline. Over the whole mass sits embossed
  noise at grain scale, a lit side and shadowed side for every grain: real
  sand is grains all the way down, and that fine *agreeing* relief is what
  reads as sand rather than felt. It is screen-anchored, so it fades wherever
  the sand is moving — still sand keeps its grain, flowing sand blurs.
- **Speck pass.** The visible grain: a few tiny (2.4 px) specks per physics
  grain, drawn as their own points on top — mostly near the body tone, some
  dark mineral, some bright quartz that glints. They are real particles riding
  the sim, so texture moves exactly with the sand, and they are far too small
  and sparse to give away which grain owns them. They fade past the silhouette
  so a surface is fringed with texture rather than beside it.

**Sand in flight** is the one case the mass render cannot handle on its own,
and it takes three separate corrections. All of them are keyed on *contact*
rather than speed — a speed threshold fires on any grain that has fallen a few
tens of pixels, which would catch an entire moving bed.

- **It has to clear the threshold alone.** A grain in the mass never has to:
  hundreds of blobs sum together and the level set falls where it falls. A
  grain by itself gets one blob, and with a fixed peak it usually lost — the
  depth weighting alone put it under. Measured, **75% of the grains in a splash
  drew literally nothing**, every one of them past the front of the box. So an
  isolated grain is given exactly the peak that lands its level set on a
  known fraction of its own radius, with no depth attenuation. Solving for the
  peak rather than just turning the gain up is what keeps it safe: a narrow
  blob with a tall peak is compact and cannot bridge, and because the target
  size sits inside the blob radius the peak stays low enough that several may
  overlap before the 8-bit field clips (measured max 186/255 through a splash).
- **The specks draw it, not the field.** A lone blob's level set is a clean
  circle that nothing breaks up — the threshold dither moves it less than a
  pixel — so a full-size blob renders a flying grain as a smooth bead. Instead
  the field only supplies a soft core at half the radius with a gentler blob
  profile, the specks spread out to the grain's true size, and they are exempt
  from the fade that normally keeps specks inside the silhouette. What is left
  is a porous clump, which is what a clod of sand in the air actually is. The
  extent stays honest: drawn much under size, thousands of these are a dust
  cloud even while the simulation is behaving perfectly.
- **It is not sunlit.** A grain in the air is fully exposed, but that is not
  the same as being the lit crest of a pile — the top of the colour ramp is a
  pale cream earned by a whole surface facing the light. Left there, a splash
  is a scatter of glowing beads, so flying sand is capped partway up the ramp,
  in the field pass, before it is summed.

**Depth is a colour, never a coverage.** When the bed leans on the back wall
(it always does a little — gravity has a component into the screen), a band of
sand shows above the front surface that exists only at the back of the box.
The first version attenuated deep grains in the coverage sum, so that band drew
as a thin translucent smear that tore into holes — measured, its coverage
ramped 6→46 against a threshold of 22 — and it dimmed their *light*, which
slid the colour down the ramp into buried brown. Now coverage barely depends
on depth (sand is opaque however deep it sits), the field carries an average
depth per pixel, and the composite fogs colour toward the box's own darkness
by it. Same fog on the specks. That reads as *far*; the old way read as
*buried*, and looked like smoke.

Separately, loosely held grains (as opposed to fully isolated ones) draw a
*narrower* blob, graded by how few contacts they have. A blob wide enough to
smooth the packed surface otherwise bridges the gap to a grain that is barely
attached and hangs it off the pile as a drip. This is a width only, never a
brightness: blending an ordinary surface grain toward the isolated-grain peak
bulges it out of the surface as its own lump and fringes the whole bed with
grain-sized nubs — exactly the scale the field render exists to hide.

None of it is additive and nothing glows. The whole thing costs one to two
milliseconds against a simulation that costs ten or more.

**The depth look.** Real Z plus cheap cues:

- **the box itself** — four interior walls running from the viewport edge back
  to an inset rectangle, plus a back plane, shaded by facing (the floor catches
  the light, the ceiling is in shadow) and darkened toward the back. Without
  them the container is invisible and the eye has to infer a box from loose
  grains, which is why depth read as flat however many layers were behind the
  glass. Because the front rectangle sits exactly on the viewport edge (persp is
  1 at z=0, parallax included), only the back moves — so tilting *shears* the
  walls, and that motion is the strongest depth cue a phone can give.


- a pinhole projection in the vertex shader — deeper grains shrink and converge
  toward the eye point, which slides against the tilt for a parallax peek.
- depth fog — the back of the box falls into shadow, sand and specks alike,
  by a per-pixel depth the field carries along.
- *how buried* a grain is — how much of its neighbourhood sits on the
  anti-gravity side. Grains with nothing above them are the lit surface.
- *light seeping down* — each grain takes the brightest value from neighbours
  above it, attenuated, one layer per frame: a real depth gradient through the
  bed instead of a flat dark slab.
- *speed* — moving sand pales a little, and loses its still-grain relief.

This bed-level shading is the shading that earns its place. It is computed in
the sim, costs nothing extra (it rides along in the contact scan the solver
already does), and it is what makes the pile read as a solid 3D mass rather than
a flat cut-out.

## Tuning it

Everything lives in [`src/config.js`](src/config.js). The knobs worth knowing:

| Knob | Effect |
| ---- | ------ |
| `bed.fill` | how much of the screen the settled sand covers |
| `grain.divisor` / `polydispersity` | grain size and its spread |
| `sim.gravityScale` | how briskly it pours and falls |
| `sim.velocityIterations` / `shockIterations` | how stiffly deep piles stand up |
| `sim.friction` / `wallFriction` | angle of repose; wall value must stay low |
| `bed.fill` (again) | pile depth is the solver's hardest constraint — deeper beds sink |
| `tuner.enabled` / `hiMs` | the low-end safety net; off means the look never changes, at any cost |
| `grain.coarseRadius` | how far the tuner may coarsen — it never removes sand |
| `bed.depthLayers` | how deep the box is, in grain diameters |
| `render.focal` / `parallax` | how dramatic the perspective is |
| `render.wallColor` / `wallShade` | the box interior |
| `sand.blob` / `surface` | how smooth the silhouette is, and how tight it sits on the grains |
| `sand.speckPx` / `speckCoverage` | on-screen speck size and density — independent of physics cost |
| `sand.grainAmp` / `grainPx` | the fine grain relief over the mass |
| `sand.looseShrink` | how much narrower a barely-attached grain's blob is |
| `sand.soloSize` / `speckAirSpread` | how big sand in flight draws, and how far its specks spread |
| `sand.airPow` / `airLight` | how soft and how pale flying sand is |
| `render.depthDim` / `fog` | how far, and toward what, the back of the box darkens |
| `sand.glintStrength` / `glintRate` | sparkle |
| `render.deep` / `mid` / `lit` | the colour ramp from buried to sunlit |

The three notes above are the ones that cost real debugging time, and each is
commented where it lives.

**Quality is spent on grain size, never on how much sand there is.** The tuner
coarsens grains and may push past `grain.maxRadius` to do it, up to
`coarseRadius`; the count always follows from the bed volume, so the box stays
just as full and is only made of fewer, larger grains. It used to trade the
other way on wide screens — where the wanted radius is pinned at the cap and
coarsening had nowhere to go — and that reads as the sand quietly draining
away: measured, a short play session lost a third of the bed, permanently,
because the tuner never adds back. The trade flipped because the renderer did.
Grain size used to *be* the look; now sand is drawn as a mass and doubling the
grain is nearly invisible, while taking grains away is the most visible change
the app can make. Measured across the full quality range, the settled bed holds
206–223 px of screen while the count falls from 4565 to 1664.

One more worth knowing: **bed depth is the binding constraint on everything.** Pile depth is what the contact solver has to hold
up, and a bed much deeper than the default starts sinking into itself no matter
how many iterations it gets — which in turn caps how small grains can be, since
finer grains mean a deeper pile for the same bed.

`window.SILT` exposes the live sim (`SILT.sand`, `SILT.gravity`, `SILT.tuner`, …)
for poking at from a console.
