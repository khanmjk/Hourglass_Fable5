# ⌛ Hourglass — A Digital Twin Timer

[![License: MIT](https://img.shields.io/badge/License-MIT-d9a95c.svg)](LICENSE)
[![three.js](https://img.shields.io/badge/three.js-r164-049EF4.svg)](https://threejs.org)
[![Rapier](https://img.shields.io/badge/Rapier-0.19.3-orange.svg)](https://rapier.rs)
[![No build step](https://img.shields.io/badge/build-none%20needed-brightgreen.svg)](#run-it)

A single-page 3D hourglass timer in which **every grain of sand is a real rigid body**,
simulated with the [Rapier](https://rapier.rs) physics engine (WASM) and rendered with
[three.js](https://threejs.org). Sand pours from the top bulb, streams through the neck,
and piles up in the bottom bulb under real gravity, friction and collision — and the last
grain lands as the countdown hits 0:00.

**▶ Live demo:** https://khanmjk.github.io/Hourglass_Fable5/

![The hourglass mid-flow — grains falling through the neck onto the growing pile](docs/screenshot.jpg)

## Run it

Any static file server works (the libraries load from a CDN, so you need to be online
on first load):

```bash
cd Fable5_03July26_Hourglass
python3 -m http.server 8137
# then open http://localhost:8137
```

Most browsers will also run it straight from a double-click on `index.html`
(everything is ES modules over HTTPS; the physics WASM is embedded in the module).

## Using it

| Control | Action |
| --- | --- |
| **15 sec / 1 min / 5 min / 60 min** | pick a preset (custom minutes in the input field) |
| **Start / Pause** (or `Space`) | run or pause the timer |
| **⟲ Flip** (or `F`) | turn the hourglass over — sand tumbles, timer restarts |
| **Reset** (or `R`) | instantly restore all sand to the top |
| drag / scroll | orbit and zoom the camera |

Flipping is faithful to a real hourglass: flip it mid-run and the new run lasts only as
long as the sand that made it to the top (flip a 1-minute glass at 40s and you get a
~40-second timer back).

The glass always holds ~2,000 grains regardless of duration — only the metering rate
changes (a 1-minute timer streams ~32 grains/second; a 60-minute timer drips one every
~2 seconds, exactly like a real hourglass with finer sand and more patience).

## How it works (V2)

- **Rendering** — three.js `InstancedMesh` (one draw call for all grains), faceted
  flat-shaded grains with a palette-jittered sand tone per instance, physical glass
  with transmission, PMREM room environment, soft shadows.
- **Physics** — each grain is a Rapier (SIMD WASM) dynamic rigid body with a ball
  collider. The glass interior is ~780 *thick convex boxes* arranged in rings that
  trace the lathe profile (zero-thickness trimeshes eject grains under pile pressure;
  solid walls can't — zero escapes across all testing). The world is built at 10×
  scale so grain radii sit near Rapier's solver tolerances. Grain radius is derived
  from the cavity volume so ~2,000 grains always fill the bulb to the same line.
- **Perfect timing: the freeze-plug** *(control-plane design adopted from the
  [Opus 4.8 build](https://github.com/khanmjk/Hourglass_Opus48) of this benchmark)* —
  unreleased grains sinking into the throat column are pinned as `Fixed` bodies: a
  self-forming plug the pile rests on, costing the solver nothing. Each frame the
  meter releases `round(N·t/T)` minus already-released grains by unpinning the plug
  bottom-first and hopping each grain invisibly across the ~1-unit throat with a
  small downward velocity. The fall, the stream and the heap are all real simulation;
  the wall clock owns only *when* each grain crosses. No arching, no jams, no stalls
  — by construction.
- **The flip** — the physics world never rotates. The *rendered* rig rotates by θ while
  physics gravity is set to `Rz(−θ)·(0,−g,0)` each frame — the exact equivalent frame
  of a fixed camera watching the glass turn. The plug unfreezes first, so the sand
  genuinely tumbles during the turn.
- **Performance** — one merged O(N) pass per frame (position cache, velocity clamp,
  force-sleep, escape rescue, instance sync) that skips frozen and sleeping bodies
  with a single boolean; targeted feed-zone waking instead of global wakes. Steady
  state simulates only the falling stream and the two active pile fronts —
  typically 15–300 awake bodies out of ~2,000, at 120 fps.
- **Background tabs** — if the tab is throttled, the wall clock stays authoritative:
  the release budget absorbs the backlog (bursts stack into vertical bands below the
  neck) and the sand level is correct when you come back.

## Pinned libraries

| Library | Version | Why pinned |
| --- | --- | --- |
| three.js | 0.164.1 | last single-file `three.module.js` build with the classic `examples/jsm` addon layout |
| @dimforge/rapier3d-compat | 0.19.3 | `rapier.mjs` is genuine ESM with the WASM embedded — no bundler, no separate `.wasm` fetch |

Both load from jsDelivr via the import map at the top of `index.html`.

## Project layout

```
index.html        the entire application — markup, styles, simulation, UI
docs/             README assets
README.md         this file
LICENSE           MIT
```

## Known trade-offs

- The neck crossing is metered, not emergent: grains hop the ~1-unit throat
  invisibly. Justified by Beverloo's law (real hourglasses drain at a constant,
  head-independent rate), and it is what makes 1-minute and 60-minute timers share
  one glass — but it is an honest asterisk. Everything you can actually *see* —
  falling, funnelling, heaping, tumbling — is genuine rigid-body simulation.
- A 60-minute glass drips ~one grain per 2 seconds — honest pacing for ~2,000
  grains rather than a faked continuous stream.
- Rapier 0.19.3 logs a harmless `deprecated parameters` warning during WASM
  init (upstream issue, no effect).
- In heavily throttled/background tabs the sand reconciles via banded catch-up
  releases; the countdown itself is always wall-clock exact.

## ChronoBench — the multi-world test bench

[`/bench/`](bench/) generalizes the experiment: **each timekeeping device hides a
different physical law**, and a live chart plots the twin's measured drain curve
against the analytic law — the benchmark grades itself. Four worlds on one core
(shared wall clock, renderer, pluggable world modules — see
[`bench/core/WORLD_CONTRACT.md`](bench/core/WORLD_CONTRACT.md)):

| World | Hidden law | The twin must… |
| --- | --- | --- |
| ⌛ Hourglass | Beverloo: constant granular rate | drain **linearly** (freeze-plug metering, live flip) |
| 🔬 Granule Lab | Beverloo rate ∝ (D−1.4d)^2.5, jams below D/d≈5 | flow **emergently** — no metering; sliders for grain & aperture |
| 💧 Water Clock | Torricelli: outflow ∝ √h | slow down as it drains; the fix is vessel shape r ∝ h^¼ |
| 🕯️ Candle Clock | steady combustion | burn linearly — height *is* time |

Live: https://khanmjk.github.io/Hourglass_Fable5/bench/

## V1 → V2

V1 (see git history) metered sand through a collision-filtered gate that grains
physically squeezed past. Real granular arching jammed it, and fighting the jams
kept too many bodies awake — long presets became unplayable. V2 adopts the
freeze-plug + release-budget control plane pioneered by the
[Opus 4.8 implementation](https://github.com/khanmjk/Hourglass_Opus48), while
keeping this build's distinctives: single file with no build step, watertight
convex-box walls (zero escapes), a live physics flip where the sand actually
tumbles, pause that freezes the world, and sound. Also new in V2: constant grain
count with volume-derived radius, faceted gritty grains, instant preset switching,
and no idle camera auto-rotation.

## License

[MIT](LICENSE) © 2026 khanmjk

---

🤖 Built with [Claude Code](https://claude.com/claude-code)
