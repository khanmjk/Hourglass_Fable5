/* Granule Lab — the hourglass's scientific counterpart: PURE EMERGENT
   granular flow. No metering, no freeze-plug, no teleports. A fixed stopper
   holds the sand until Pour; after that the neck is governed by raw physics.
   Vary grain size and neck aperture and see whether the simulation
   reproduces Beverloo's constant-rate law and the D/d ≲ 5 jamming threshold.
   See ../core/WORLD_CONTRACT.md. */
import * as THREE from 'three';
import { GLASS, makeProfile, buildWalls, seedPositions, makeGrainMesh, buildGlassDressing } from '../core/granular.js';

const { H, THROAT_H } = GLASS;
const N_GRAINS = 1000;
const G = 75;
const DT = 1 / 120, MAX_STEPS = 3;
const V_MAX = 60, SLEEP_SP2 = 0.25;
const PASS_Y = -1.5;          // one-way gate: a grain has "passed" once below this
const SETTLE_STEPS = 260;
const SAMPLE_DT = 0.25;       // cadence of the (time, count) ring buffer
const RATE_WIN = 2;           // rolling flow-rate window (s)
const JAM_WIN = 3;            // jam detection window (s)
const JAM_MIN_WAITING = 20;   // unpassed grains that must sit above the neck

export default class GranuleLabWorld {
  static id = 'granulab';
  static label = '🔬 Granule Lab';
  static blurb = 'No metering here — pure emergent flow. Beverloo predicts a constant rate ∝ (D−1.4d)^2.5, and apertures below ~5 grain diameters jam. See if the physics agrees.';

  usesTimer = false;
  actionLabel = 'Pour';
  supportsFlip = false;
  theoryLabel = 'constant rate · Beverloo';

  constructor(ctx) {
    this.ctx = ctx;
    this.grainR = 0.55;
    this.neckR = 1.8;
    this.N = 0;
    this.poured = false;
    this.running = false;
    this.acc = 0;
    this.passedCount = 0;
    this.rate = 0;
    this.jammed = false;
    this.samples = [];        // [elapsedSec, passedCount] ring buffer
    this.sampleAcc = 0;
    this.noise = null;
    this.rebuildTimer = 0;
    this.rebuilding = false;
    this.disposed = false;
    this.computeBeverloo();
  }

  /* Standard 3D number-rate Beverloo: Q = C·√g·(D − 1.4d)^2.5 / d³ grains/s. */
  computeBeverloo() {
    const D = 2 * this.neckR, d = 2 * this.grainR;
    const Q = Math.max(0.01, (0.58 * Math.sqrt(G) * Math.pow(Math.max(0.01, D - 1.4 * d), 2.5)) / Math.pow(d, 3));
    this.D = D; this.d = d; this.Q = Q;
    this.predictedDrain = Math.min(3600, Math.max(5, (this.N || N_GRAINS) / Q));
  }

  async build() {
    this.RAPIER = await this.ctx.getRAPIER();
    this.dressingGroup = new THREE.Group();
    this.ctx.rig.add(this.dressingGroup);
    this.buildSim();
  }

  /* Full (re)build of physics + grains, used by build() and the param sliders.
     Resilient mid-pour: always rebuilds fresh with the stopper back in place. */
  buildSim() {
    const RAPIER = this.RAPIER;
    if (this.world) { this.world.free(); this.world = null; this.stopperCol = null; this.stopperBody = null; }
    if (this.mesh) {
      this.ctx.rig.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    this.profile = makeProfile(this.neckR);
    if (this.builtNeckR !== this.neckR) this.rebuildDressing();

    this.world = new RAPIER.World({ x: 0, y: -G, z: 0 });
    this.world.timestep = DT;
    buildWalls(RAPIER, this.world, this.profile);
    this.stopperBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.addStopper();

    const pts = seedPositions(this.profile, this.grainR, N_GRAINS);
    this.N = pts.length;
    this.bodies = [];
    this.pos = new Float32Array(this.N * 3);
    this.passed = new Uint8Array(this.N);
    this.slow = new Uint8Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const [x, y, z] = pts[i];
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z)
          .setLinearDamping(0.3).setAngularDamping(0.8)
          .setSoftCcdPrediction(this.grainR * 4)
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.ball(this.grainR).setFriction(0.55).setRestitution(0).setDensity(1.4),
        body
      );
      this.bodies.push(body);
      this.pos.set([x, y, z], i * 3);
    }
    this.mesh = makeGrainMesh(this.N, this.grainR);
    this.ctx.rig.add(this.mesh);
    this.feedY = THROAT_H + this.grainR * 9;
    this.feedR2 = (this.neckR * 2.2) ** 2;

    // blocking settle behind the core overlay, stopper holding the neck
    for (let s = 0; s < SETTLE_STEPS; s++) {
      this.world.step();
      if (s % 7 === 0) this.postStep(true);
    }
    this.postStep(true);
    this.cacheSettled();
    this.resetMeasurement();
    this.computeBeverloo();
  }

  rebuildDressing() {
    for (const child of this.dressingGroup.children) {
      child.geometry?.dispose();
      child.material?.dispose();
    }
    this.dressingGroup.clear();
    this.dressing = buildGlassDressing(this.dressingGroup, this.profile);
    this.builtNeckR = this.neckR;
  }

  addStopper() {
    if (this.stopperCol) return;
    this.stopperCol = this.world.createCollider(
      this.RAPIER.ColliderDesc.cylinder(THROAT_H, this.neckR + 0.4)
        .setFriction(0.55).setRestitution(0),
      this.stopperBody
    );
  }
  removeStopper() {
    if (!this.stopperCol) return;
    this.world.removeCollider(this.stopperCol, true);
    this.stopperCol = null;
  }

  cacheSettled() {
    this.cache = new Float32Array(this.N * 7);
    for (let i = 0; i < this.N; i++) {
      const t = this.bodies[i].translation(), r = this.bodies[i].rotation();
      this.cache.set([t.x, t.y, t.z, r.x, r.y, r.z, r.w], i * 7);
    }
  }

  resetMeasurement() {
    this.passed.fill(0);
    this.slow.fill(0);
    this.passedCount = 0;
    this.samples = [];
    this.sampleAcc = 0;
    this.rate = 0;
    this.jammed = false;
    this.poured = false;
  }

  params() {
    return [
      {
        type: 'slider', id: 'grainR', label: 'grain radius',
        min: 0.35, max: 0.8, step: 0.05, value: this.grainR,
        format: (v) => v.toFixed(2),
        onChange: (v) => { this.grainR = v; this.queueRebuild(); },
      },
      {
        type: 'slider', id: 'neckR', label: 'neck radius',
        min: 0.9, max: 2.8, step: 0.1, value: this.neckR,
        format: (v) => v.toFixed(1),
        onChange: (v) => { this.neckR = v; this.queueRebuild(); },
      },
    ];
  }

  /* Sliders fire continuously while dragging — debounce the heavy rebuild. */
  queueRebuild() {
    this.computeBeverloo(); // keep the prediction live while sliding
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.rebuild(), 220);
  }
  async rebuild() {
    if (this.rebuilding) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = setTimeout(() => this.rebuild(), 120);
      return;
    }
    this.rebuilding = true;
    this.ctx.setBusy('Regrinding the sand…');
    await new Promise((r) => requestAnimationFrame(r)); // let the overlay paint
    if (this.disposed) { this.rebuilding = false; return; }
    this.buildSim();
    this.ctx.setBusy(null);
    this.rebuilding = false;
  }

  onStart() {
    this.computeBeverloo(); // prediction locked in at Pour time
    this.removeStopper();
    for (let i = 0; i < this.N; i++) this.bodies[i].wakeUp();
    this.slow.fill(0);
    this.poured = true;
    this.running = true;
    this.samples = [[0, 0]];
    this.sampleAcc = 0;
    this.ensureNoise();
  }
  onPause() { this.running = false; }
  onResume() { this.running = true; }
  onReset() {
    this.running = false;
    this.addStopper();
    for (let i = 0; i < this.N; i++) {
      const o = i * 7, b = this.bodies[i];
      b.setTranslation({ x: this.cache[o], y: this.cache[o + 1], z: this.cache[o + 2] }, false);
      b.setRotation({ x: this.cache[o + 3], y: this.cache[o + 4], z: this.cache[o + 5], w: this.cache[o + 6] }, false);
      b.setLinvel({ x: 0, y: 0, z: 0 }, false);
      b.setAngvel({ x: 0, y: 0, z: 0 }, false);
      b.sleep();
      this.pos.set([this.cache[o], this.cache[o + 1], this.cache[o + 2]], i * 3);
    }
    this.resetMeasurement();
    this.postStep(true);
  }

  expectedDuration() { return this.predictedDrain; }
  progress() { return this.N ? this.passedCount / this.N : 0; }
  theory(tau) { return Math.min(1, tau); }
  statsLine() {
    const ratio = this.D / this.d;
    let s = `${this.passedCount}/${this.N} through · ${this.rate.toFixed(1)}/s (Beverloo ${this.Q.toFixed(1)}/s) · D/d ${ratio.toFixed(1)}`;
    if (this.jammed) s += ` · ⚠ JAMMED — D/d = ${ratio.toFixed(1)} (needs ≳5)`;
    return s;
  }
  cameraHome() { return { pos: [34, 13, 47], target: [0, 0, 0] }; }

  tick(dt, elapsed, running) {
    this.acc += dt;
    let steps = 0;
    while (this.acc >= DT && steps < MAX_STEPS) { this.world.step(); this.acc -= DT; steps++; }
    if (this.acc > DT) this.acc = 0; // shed backlog
    this.postStep();

    if (running && this.poured) {
      this.sampleAcc += dt;
      if (this.sampleAcc >= SAMPLE_DT) {
        this.sampleAcc = 0;
        this.sample(elapsed);
        this.wakeFeedZone();
      }
    }
    this.updateNoise(running && this.poured);
  }

  /* Ring-buffer sampling: rolling flow rate over ~RATE_WIN s and jam
     detection over JAM_WIN s. Jamming needs a waiting pile above the neck
     (an empty bulb is "drained", not "jammed"). */
  sample(t) {
    this.samples.push([t, this.passedCount]);
    while (this.samples.length > 2 && this.samples[0][0] < t - (JAM_WIN + 1)) this.samples.shift();
    let ref = this.samples[0];
    for (const s of this.samples) { if (s[0] <= t - RATE_WIN) ref = s; else break; }
    const span = t - ref[0];
    this.rate = span > 0.2 ? (this.passedCount - ref[1]) / span : 0;

    let jamRef = null;
    for (const s of this.samples) { if (s[0] <= t - JAM_WIN) jamRef = s; else break; }
    if (jamRef && this.passedCount - jamRef[1] < 1 && this.passedCount < this.N) {
      let waiting = 0;
      for (let i = 0; i < this.N; i++) {
        if (this.passed[i]) continue;
        const y = this.pos[i * 3 + 1];
        if (y > 0 && y < 6) waiting++;
      }
      this.jammed = waiting >= JAM_MIN_WAITING;
    } else {
      this.jammed = false;
    }
  }

  /* Physics hygiene (same idiom as the hourglass): the force-sleep pass can
     strand grains near the neck, so periodically re-wake the feed zone.
     Waking adds no energy — a genuinely stable arch stays jammed. */
  wakeFeedZone() {
    if (this.passedCount >= this.N) return;
    for (let i = 0; i < this.N; i++) {
      if (this.passed[i]) continue;
      const y = this.pos[i * 3 + 1];
      if (y < 0) continue;
      const x = this.pos[i * 3], z = this.pos[i * 3 + 2];
      if (y < this.feedY || x * x + z * z < this.feedR2) this.bodies[i].wakeUp();
    }
  }

  /* Single merged pass: sync InstancedMesh, clamp velocity, force-sleep
     after 4 consecutive slow frames, radial escape-rescue against the
     profile, and the one-way passed gate at y < PASS_Y. */
  postStep(force = false) {
    const m = GranuleLabWorld._m ??= new THREE.Matrix4();
    const q = GranuleLabWorld._q ??= new THREE.Quaternion();
    const v = GranuleLabWorld._v ??= new THREE.Vector3();
    const s = GranuleLabWorld._s ??= new THREE.Vector3(1, 1, 1);
    let dirty = false;
    const maxSq = V_MAX * V_MAX;
    for (let i = 0; i < this.N; i++) {
      const b = this.bodies[i];
      if (!force && b.isSleeping()) continue;
      const t = b.translation(), r = b.rotation();
      this.pos.set([t.x, t.y, t.z], i * 3);
      if (!this.passed[i] && t.y < PASS_Y) { this.passed[i] = 1; this.passedCount++; }
      const lv = b.linvel();
      const sq = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
      if (sq > maxSq) {
        const sc = V_MAX / Math.sqrt(sq);
        b.setLinvel({ x: lv.x * sc, y: lv.y * sc, z: lv.z * sc }, true);
        this.slow[i] = 0;
      } else if (!force && sq < SLEEP_SP2) {
        if (++this.slow[i] >= 4) { b.sleep(); this.slow[i] = 0; }
      } else {
        this.slow[i] = 0;
      }
      const rxz = Math.hypot(t.x, t.z);
      if (rxz > this.profile(Math.min(Math.abs(t.y), H)) + this.grainR * 2 || Math.abs(t.y) > H + 1.5) {
        const yc = Math.max(-H + 1, Math.min(H - 1, t.y));
        const rSafe = Math.max(0.1, this.profile(Math.abs(yc)) * 0.5);
        const sc = rxz > 1e-4 ? rSafe / rxz : 0;
        b.setTranslation({ x: t.x * sc, y: yc, z: t.z * sc }, true);
        b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
      v.set(t.x, t.y, t.z);
      q.set(r.x, r.y, r.z, r.w);
      m.compose(v, q, s);
      this.mesh.setMatrixAt(i, m);
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  ensureNoise() {
    const ctx = this.ctx.audio();
    if (!ctx || this.noise) return;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3400; bp.Q.value = 0.6;
    this.noise = ctx.createGain();
    this.noise.gain.value = 0;
    src.connect(bp).connect(this.noise).connect(ctx.destination);
    src.start();
  }
  updateNoise(active) {
    if (!this.noise) return;
    const ctx = this.ctx.audio();
    if (!ctx) return;
    const target = active ? Math.min(0.06, this.rate * 0.004) : 0;
    this.noise.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.12);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.rebuildTimer);
    try { this.noise?.disconnect(); } catch {}
    this.world?.free();
    this.mesh?.geometry.dispose();
    this.mesh?.material.dispose();
    for (const child of this.dressingGroup?.children ?? []) {
      child.geometry?.dispose();
      child.material?.dispose();
    }
  }
}
