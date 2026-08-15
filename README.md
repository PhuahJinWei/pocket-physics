# Silt

Thousands of glowing grains in a shallow 3D box behind the glass, pouring,
piling and splashing as you tilt your phone. A recreation of
[this ESP32-S3 demo](https://www.instagram.com/p/DbtqKz3jssZ/), built for
phones first and desktop second.

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
sliding friction. Each fixed substep: gravity, find contacts, solve velocities,
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

**The depth look.** Real Z plus cheap cues:

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
- *speed* — fast grains blow out toward white, which is what makes a splash
  read.

Rendering is one interleaved buffer and two draw calls: a wide additive halo,
then the beads over the top. The bead's spherical look is a fake normal
reconstructed from `gl_PointCoord` and lit per fragment, so a flat point sprite
reads as a little glass ball.

## Tuning it

Everything lives in [`src/config.js`](src/config.js). The knobs worth knowing:

| Knob | Effect |
| ---- | ------ |
| `bed.fill` | how much of the screen the settled sand covers |
| `bed.depthLayers` | how deep the box is, in grain diameters |
| `grain.divisor` | grain size relative to the short edge of the screen |
| `sim.gravityScale` | how briskly it pours and falls |
| `sim.velocityIterations` / `shockIterations` | how stiffly deep piles stand up |
| `sim.friction` / `wallFriction` | angle of repose; wall value must stay low |
| `bed.fill` (again) | pile depth is the solver's hardest constraint — deeper beds sink |
| `tuner.enabled` / `hiMs` | the low-end safety net; off means the look never changes, at any cost |
| `render.focal` / `depthDim` / `parallax` | how dramatic the depth looks |
| `render.deep` / `mid` / `ice` | the colour ramp from buried to surface |

The three notes above are the ones that cost real debugging time, and each is
commented where it lives. One more worth knowing: **bed depth is the binding
constraint on everything.** Pile depth is what the contact solver has to hold
up, and a bed much deeper than the default starts sinking into itself no matter
how many iterations it gets — which in turn caps how small grains can be, since
finer grains mean a deeper pile for the same bed.

`window.SILT` exposes the live sim (`SILT.sand`, `SILT.gravity`, `SILT.tuner`, …)
for poking at from a console.
