# Silt — tilt sand

A tilt-driven sand toy: thousands of glowing grains that pour, pile and splash as
you tip your phone. Pure ES modules, WebGL rendering, no build step and no
dependencies — open `index.html` from any static server and it runs.

## Run it

Any static file server works. The repo ships a launch config that uses Python:

```bash
python -m http.server 8146
```

Then open http://localhost:8146. Motion sensors need a secure context, so on a
phone use `https` or localhost port-forwarding — over plain `http` the app falls
back to an on-screen joystick.

## Controls

| | |
|---|---|
| Touch | Tilt to pour · touch to push · shake to splash |
| Keyboard | Arrows / WASD to tilt · drag to push · Space to splash |
| `R` | Reset the bed |
| `` ` `` | Toggle the stats overlay |
| `F` | Flip the gravity direction |
| `J` | Toggle the virtual stick |
| `[` `]` | Fewer / more grains (disables the auto-tuner) |
| `,` `.` | Smaller / larger grains |

## URL parameters

`?grains=N` fixed grain count · `?r=N` fixed grain radius · `?demo` synthetic
gravity · `?flip` inverted gravity · `?stick` force the joystick · `?stats` open
the overlay · `?capture` capture-friendly renderer setup.

## Layout

| File | Role |
|---|---|
| [src/main.js](src/main.js) | Wiring: viewport → sim size, input → gravity, frame loop, adaptive quality |
| [src/config.js](src/config.js) | Every tunable in one place, with notes on what each one does |
| [src/sand.js](src/sand.js) | The solver: spatial hash, substepping, contact + friction, sleeping |
| [src/renderer.js](src/renderer.js) | WebGL instanced sprite renderer |
| [src/shaders.js](src/shaders.js) | Vertex/fragment sources |
| [src/gravity.js](src/gravity.js) | Device motion, keyboard tilt, virtual stick, shake detection |
| [src/poke.js](src/poke.js) | Pointer/touch push forces |
| [src/grid.js](src/grid.js) | Spatial hash used by the solver |
| [src/tuner.js](src/tuner.js) | Frame-budget tracker that scales grain count and size |
| [src/hud.js](src/hud.js) | Hint text, stats overlay, gate button, stick UI |

The simulation is resolution independent: grain count is derived from the
fraction of the viewport the settled bed should cover, so the amount of sand on
screen looks the same on every device, and spare performance headroom buys finer
grains rather than a deeper bed.
