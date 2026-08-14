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

**Simulation.** Position-based dynamics in a shallow 3D box (the screen is the
front glass; the box extends ~4 grain diameters in Z), over a uniform 3D spatial
hash, in typed arrays with no per-frame allocation. Each substep integrates,
rebuilds the grid, then relaxes contacts: overlapping grains are pushed apart,
and a Coulomb-ish friction term cancels the tangential part of their relative
motion. Friction is what makes it sand rather than water — it gives the bed
shear strength, so it piles instead of levelling out. Grains are visited
deepest-first along the current gravity direction, so support propagates from
the base of a pile upward in a single sweep.

Tilt maps to a full 3D gravity vector: hold the phone flat and the sand settles
against the back wall; stand it up and the sand pours down the glass.

**Sleep.** A grain that stays slow and supported for a third of a second goes
fully dormant — no gravity, no solver corrections, an immovable obstacle. This
is what makes a resting bed *pixel-still* (and nearly free: a dormant bed costs
~0 CPU), and it is hysteretic, so nothing shimmers on the edge of stopping.
Waking is deliberate: tipping the device past ~10° wakes the whole bed at once
(a hard tilt slumps as one mass instead of peeling off layer by layer), pokes
and shakes wake what they touch, and ballistic grains — a splash landing — wake
what they hit. Slow creep deliberately cannot transmit wakefulness; that one
rule is the difference between a bed that sleeps and a bed that simmers forever.

**Cost control.** A fixed sweep budget per frame is split between substeps and
iterations: a settled bed spends it all on iterations (converging the deep,
compressed layers), while a bed in flight spends it on substeps instead. On top
of that the tuner watches frame time and adjusts grain *size* — count scales
with 1/r³, so headroom buys finer grains, never a different amount of sand. It
only judges frames where the sim actually worked; tuning on dormant frames
would inflate quality, spawn grains, and oscillate. Grains added by a quality
step spawn in a thin layer just above the bed surface, not at the top of the
screen.

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
| `sim.sleepSpeed` / `sleepDelay` | how quickly the bed goes dormant |
| `sim.gravityWakeAngle` | tilt change that wakes the whole bed at once |
| `sim.wakeSpeed` | how fast a grain must move to wake sleepers on impact |
| `sim.muS` / `muK` / `frictionPressureFloor` | grip; the floor is what gives near-unloaded surface grains any friction at all |
| `sim.contactDrag` / `rollingDrag` | how quickly loose grains calm down |
| `render.focal` / `depthDim` / `parallax` | how dramatic the depth looks |
| `render.deep` / `mid` / `ice` | the colour ramp from buried to surface |

A few of these are load-bearing in non-obvious ways, and each is commented in
place: dissipation is charged **per second and per contact** (a fixed
per-substep factor damps a settled bed least, so it slowly heats up); the
velocity ceiling and substep budget are fractions of a grain **diameter**, not
of a grid cell — a grain that crosses more than about half its own width in one
substep lands inside its neighbour and gets catapulted back out; and the sleep
decision runs on **net frame displacement**, never on instantaneous velocity,
because solver churn makes a grain squeezed between sleepers look permanently
fast while it goes nowhere.

`window.SILT` exposes the live sim (`SILT.sand`, `SILT.gravity`, `SILT.tuner`, …)
for poking at from a console.
