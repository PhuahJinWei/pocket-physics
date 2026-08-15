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
| Reset the bed  | —                         | `R`                            |
| Stats panel    | —                         | `` ` ``                        |
| Tilt pad       | shown automatically       | `J`                            |
| Flip tilt axes | —                         | `F`                            |
| Grain count    | —                         | `[` `]`                        |
| Grain size     | —                         | `,` `.`                        |

URL parameters: `?stats` opens the stats panel, `?demo` runs a hands-free sway
(useful for screenshots and for checking the sim without sensors), `?grains=8000`
and `?r=3` pin the grain count and radius, `?tune=off` disables adaptive quality,
`?stick` forces the tilt pad, and `?capture` enables `preserveDrawingBuffer` so
screenshot tools can read the canvas.

## How it works

```
main.js      frame loop, viewport → sim size, quality changes
  gravity.js   accelerometer / keys / tilt pad → an effective gravity vector
  poke.js      pointers → push impulses
  grains.js    the simulation
    grid.js      counting-sort spatial hash
  renderer.js  WebGL point sprites
    shaders.js
  tuner.js     adaptive quality
  hud.js       stats panel, hint line, permission prompt, tilt pad
config.js    every tunable, in one place
```

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

**The grain look.** Each physics grain is one point sprite, and the sprite draws
a small *cluster* of matte specks rather than a single lit ball. That decouples
visual grain size from physics grain size: the sand renders about three times
finer than the solver's grains, for free. Making the physics that fine instead
would roughly quintuple simulation cost (count scales with 1/r²); the cluster
costs a few ALU per fragment and no extra geometry.

A grain touching nothing draws as a **single speck the size of the grain
itself**, rather than as a cluster. Two failure modes sit either side of that:
spread the cluster and a flying grain reads as a flower of specks stuck
together; collapse it to the fine bed-speck size and the grain is drawn several
times smaller than it physically is — thousands of those look exactly like a
dust cloud, even while the simulation is behaving perfectly. It is keyed on
isolation rather than speed, because a speed threshold fires on any grain that
has fallen a few tens of pixels.

Speck size targets a constant number of *on-screen* pixels (`speckPx`), with
the per-sprite count adapting to keep coverage — the physics grain scales with
the viewport, so without this a wide screen showed coarse sand exactly where
there was most room to see it. Fast free-flying grains collapse their cluster
onto a single speck and shrink; inside the bed the cluster trick is invisible,
but an airborne grain drawn as a bundle reads as a little flower of balls.

Nearly all of the realism is **micro-relief**: every speck gets a gentle fake
normal lit by one global light — lit crest up-left, shade down-right — and the
webbing between specks falls into crevice shadow. Thousands of tiny highlights
and shadows all agreeing about the light direction is what reads as sand;
per-speck random brightness alone reads as static. Variation is layered on top
at two scales: a little per-speck mineral scatter, and slow value-noise patches
over world position, because real sand varies in patches, not grain by grain.
Dry-sand glints — brief, warm, sparse — finish the material.

There is no glow pass and nothing additive: real sand does not emit. The gaps a
cluster leaves show the grain drawn behind, which is deeper and darker — free
crevices.

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
- depth fog — the back of the box falls into shadow.
- back-to-front draw order via a 32-bucket counting sort on z (point sprites
  with blending fight a real depth buffer over the alpha edges).
- *how buried* a grain is — how much of its neighbourhood sits on the
  anti-gravity side. Grains with nothing above them are the lit surface.
- *light seeping down* — each grain takes the brightest value from neighbours
  above it, attenuated, one layer per frame: a real depth gradient through the
  bed instead of a flat dark slab.
- *speed* — airborne grains pale toward dust, which is what makes a splash
  read.

This bed-level shading is the shading that earns its place. It is computed in
the sim, costs nothing extra (it rides along in the contact scan the solver
already does), and it is what makes the pile read as a solid 3D mass rather than
a field of dots — which matters *more*, not less, as the grains get finer.

Rendering is one interleaved buffer and a single draw call, back-to-front.

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
| `bed.depthLayers` | how deep the box is, in grain diameters |
| `render.focal` / `depthDim` / `parallax` | how dramatic the depth looks |
| `render.wallColor` / `wallShade` | the box interior |
| `render.speckPx` / `speckCoverage` | on-screen speck size and density — independent of physics cost |
| `render.glintStrength` / `glintRate` | sparkle |
| `render.deep` / `mid` / `lit` | the colour ramp from crevice to sunlit |

The three notes above are the ones that cost real debugging time, and each is
commented where it lives. One more worth knowing: **bed depth is the binding
constraint on everything.** Pile depth is what the contact solver has to hold
up, and a bed much deeper than the default starts sinking into itself no matter
how many iterations it gets — which in turn caps how small grains can be, since
finer grains mean a deeper pile for the same bed.

`window.SILT` exposes the live sim (`SILT.sand`, `SILT.gravity`, `SILT.tuner`, …)
for poking at from a console.
