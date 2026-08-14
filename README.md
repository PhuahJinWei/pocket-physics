# Silt

Thousands of glowing grains that pour, pile and splash as you tilt your phone.
A recreation of [this ESP32-S3 demo](https://www.instagram.com/p/DbtqKz3jssZ/),
built for phones first and desktop second.

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
and `?r=3` pin the grain count and radius, `?stick` forces the tilt pad, and
`?capture` enables `preserveDrawingBuffer` so screenshot tools can read the
canvas.

## How it works

```
main.js      frame loop, viewport → sim size, quality changes
  gravity.js   deviceorientation / keys / tilt pad → a gravity vector
  poke.js      pointers → push impulses
  sand.js      the simulation
    grid.js      counting-sort spatial hash
  renderer.js  WebGL point sprites
    shaders.js
  tuner.js     adaptive quality
  hud.js       stats panel, hint line, permission prompt, tilt pad
config.js    every tunable, in one place
```

**Simulation.** Position-based dynamics over a uniform spatial hash, in typed
arrays with no per-frame allocation. Each substep integrates, rebuilds the grid,
then relaxes contacts: overlapping grains are pushed apart, and a Coulomb-ish
friction term cancels the tangential part of their relative motion. Friction is
what makes it sand rather than water — it gives the bed shear strength, so it
piles instead of levelling out.

Grains are visited deepest-first along the current gravity direction, so support
propagates from the base of a pile upward in a single sweep.

**Cost control.** A fixed sweep budget per frame is split between substeps and
iterations: a settled bed spends it all on iterations (converging the deep,
compressed layers), while a bed in flight spends it on substeps instead. Frame
cost stays roughly flat either way. On top of that the tuner watches frame time
and adjusts grain *size* — the bed always holds the same volume of sand, so extra
performance headroom buys finer grains rather than a deeper pile.

**The 2.5D look.** The bed is a 2D simulation; the depth comes from shading, and
all of it falls out of the neighbour scan that collision detection already does:

- *how buried* a grain is — how much of its neighbourhood sits on the
  anti-gravity side. Grains with nothing above them are the lit surface.
- *light seeping down* — each grain also takes the brightest value from the
  neighbours above it, attenuated. Propagating one layer per frame builds a real
  depth gradient through the bed instead of a flat dark slab.
- *speed* — fast grains blow out toward white, which is what makes a splash read.

Rendering is one interleaved buffer and two draw calls: a wide additive halo,
then the beads over the top. The bead's spherical look is a fake normal
reconstructed from `gl_PointCoord` and lit per fragment, so a flat point sprite
reads as a little glass ball. Grains are uploaded deepest-first so the lit
surface layer draws last and no depth buffer is needed.

## Tuning it

Everything lives in [`src/config.js`](src/config.js). The knobs worth knowing:

| Knob | Effect |
| ---- | ------ |
| `bed.fill` | how much of the screen the settled sand covers |
| `grain.divisor` | grain size relative to the short edge of the screen |
| `sim.gravityScale` | how briskly it pours |
| `sim.sleepSpeed` | **the angle of repose.** Too low and the pile creeps until it lies flat like a liquid |
| `sim.muS` / `muK` / `frictionPressureFloor` | grip; the floor is what gives near-unloaded surface grains any friction at all |
| `sim.contactDrag` | how dead the bulk feels |
| `render.glowStrength` / `beadSize` | bloom and bead size |
| `render.deep` / `mid` / `ice` | the colour ramp from buried to surface |

Two of these are load-bearing in non-obvious ways, and both are commented in
place: dissipation is charged **per second and per contact** (a fixed
per-substep factor damps a settled bed least, so it slowly heats up), and the
velocity ceiling and substep budget are fractions of a grain **diameter**, not of
a grid cell — a grain that crosses more than about half its own width in one
substep lands inside its neighbour and gets catapulted back out.

`window.SILT` exposes the live sim (`SILT.sand`, `SILT.gravity`, `SILT.tuner`, …)
for poking at from a console.
