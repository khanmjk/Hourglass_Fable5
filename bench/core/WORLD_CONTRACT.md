# World module contract (ChronoBench)

Every simulation world is one ES module in `bench/worlds/` exporting a default class.
The core (`core/app.js`) owns: the renderer/scene/camera/controls, the wall-clock
timer, the countdown display, the preset/start/pause/reset UI, the parameter panel,
and the live theory-vs-measured chart. The world owns everything inside its `rig`.

```js
export default class ExampleWorld {
  static id = 'example';          // url-safe id
  static label = '⌛ Example';    // tab label (emoji + name)
  static blurb = 'One sentence shown under the clock while this world is active.';

  constructor(ctx) {
    // ctx = {
    //   THREE,                    three.js namespace (r164)
    //   scene, camera, renderer,  shared three objects (do not reconfigure renderer)
    //   rig,                      THREE.Group dedicated to this world — put EVERYTHING here
    //   getRAPIER: async () => RAPIER,   lazy singleton (SIMD build, already init()ed)
    //   audio: () => AudioContext|null,  lazy shared AudioContext (null if unavailable/muted)
    //   setBusy(text|null),       show/hide the loading overlay (use during long builds)
    // }
    // Store ctx; do NOT touch the DOM outside what params() declares.
  }

  async build() {}                // create meshes/physics. May take seconds; core shows overlay.

  // --- timer lifecycle (core owns the wall clock; world reacts) ---
  usesTimer = true;               // false = experiment world: no presets, Start = actionLabel, clock counts UP
  actionLabel = 'Start';          // label for the primary button when usesTimer === false
  setDuration(secs) {}            // called before start and on preset change (usesTimer worlds)
  onStart() {} onPause() {} onResume() {} onReset() {}

  tick(dtSec, elapsedSec, running) {}  // every frame. dt clamped ≤0.05. Step your own physics here.

  // --- the bench ---
  expectedDuration() { return 60; }    // seconds used to normalize tau (timer worlds: the set duration)
  progress() { return 0; }             // MEASURED observable, 0..1 (sand through / volume drained / wax burned)
  theory(tau) { return tau; }          // analytic law: expected progress at normalized time tau∈[0,1]
  theoryLabel = 'linear (Beverloo)';   // shown on the chart legend
  statsLine() { return ''; }           // short live stats for the footer

  // --- presentation ---
  cameraHome() { return { pos: [34, 13, 47], target: [0, 0, 0] }; }
  params() { return []; }              // [{type:'slider'|'select'|'button', id, label, min,max,step,value, options?, onChange|onClick}]
  supportsFlip = false; flip() {}      // optional

  dispose() {}                         // free physics worlds, geometries, materials; core removes/clears rig
}
```

Rules:
- All meshes go in `ctx.rig`; core clears it on dispose. Dispose your geometries/materials/render targets and `world.free()` any Rapier world.
- Never block the main thread > ~50ms; chunk long settles across frames or do them inside build() behind setBusy.
- The wall clock is authoritative. `elapsedSec` comes from the core; never keep your own clock.
- Worlds using Rapier: create your own `new RAPIER.World(...)`, fixed timestep 1/120 with an accumulator capped at 3 substeps, shed backlog. Scale: ~1 unit = 10 cm (grain-scale bodies ≈ 0.3–0.6 units) so radii sit near Rapier's solver tolerances.
- Visual language: dark scene, warm sand/amber accents, `MeshPhysicalMaterial` transmission glass where glass is needed. Match the existing hourglass world's look (`worlds/hourglass.js` is the reference implementation).
- Sound is optional and must go through `ctx.audio()` (returns null when muted): keep it subtle.
