/* The hourglass — reference world. Every grain is a Rapier rigid body;
   a self-forming freeze-plug holds the throat and a wall-clock release
   budget meters the flow (Beverloo: real hourglasses drain linearly).
   See ../core/WORLD_CONTRACT.md. */
import * as THREE from 'three';
import { GLASS, makeProfile, grainRadiusFor, buildWalls, seedPositions, makeGrainMesh, buildGlassDressing } from '../core/granular.js';

const { H, THROAT_H } = GLASS;
const NECK_R = 1.3;
const N_GRAINS = 1600;
const G = 75;
const DT = 1 / 120, MAX_STEPS = 3;
const V_MAX = 60, SLEEP_SP2 = 0.25;
const TRANSIT_S = 0.9, REL_CAP = 60, BANDS = 12;

export default class HourglassWorld {
  static id = 'hourglass';
  static label = '⌛ Hourglass';
  static blurb = 'Granular flow drains at a constant rate regardless of the head above (Beverloo) — so a real hourglass empties linearly, and so does this one.';

  usesTimer = true;
  supportsFlip = true;
  theoryLabel = 'linear · Beverloo';

  constructor(ctx) {
    this.ctx = ctx;
    this.duration = 60;
    this.effDuration = 60;
    this.deadTime = 0;        // flip animation time before flow resumes
    this.releasedCount = 0;
    this.topStart = N_GRAINS;
    this.orientation = 1;
    this.thetaBase = 0;
    this.flipPhase = null;    // null | 'turn' | 'settle'
    this.flipT = 0;
    this.relRate = 0;
    this.acc = 0;
    this.running = false;
    this.noise = null;
  }

  async build() {
    const RAPIER = await this.ctx.getRAPIER();
    this.RAPIER = RAPIER;
    this.profile = makeProfile(NECK_R);
    this.grainR = grainRadiusFor(this.profile, N_GRAINS);
    this.yHold = THROAT_H + this.grainR * 1.4;
    this.holdR2 = (NECK_R * 1.9) ** 2;
    this.feedY = THROAT_H + this.grainR * 9;
    this.feedR2 = (NECK_R * 2.2) ** 2;

    this.world = new RAPIER.World({ x: 0, y: -G, z: 0 });
    this.world.timestep = DT;
    buildWalls(RAPIER, this.world, this.profile);
    this.dressing = buildGlassDressing(this.ctx.rig, this.profile);

    const pts = seedPositions(this.profile, this.grainR, N_GRAINS);
    this.N = pts.length;
    this.bodies = [];
    this.pos = new Float32Array(this.N * 3);
    this.frozen = new Uint8Array(this.N);
    this.released = new Uint8Array(this.N);
    this.slow = new Uint8Array(this.N);
    this.frozenList = [];
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
    this.topStart = this.N;

    // blocking settle behind the core overlay, freeze pass keeps the plug forming
    for (let s = 0; s < 320; s++) {
      this.world.step();
      if (s % 7 === 0) { this.postStep(true); this.freezePass(); }
    }
    this.postStep(true);
    this.freezePass();
    this.cacheSettled();
  }

  cacheSettled() {
    this.cache = new Float32Array(this.N * 8);
    for (let i = 0; i < this.N; i++) {
      const t = this.bodies[i].translation(), r = this.bodies[i].rotation();
      this.cache.set([t.x, t.y, t.z, r.x, r.y, r.z, r.w, this.frozen[i]], i * 8);
    }
  }

  setDuration(secs) { this.duration = secs; this.effDuration = secs; }
  expectedDuration() { return this.deadTime + this.effDuration; }
  progress() { return this.topStart ? this.releasedCount / this.topStart : 0; }
  theory(tau) {
    const T = this.expectedDuration();
    if (T <= 0) return 0;
    const t = tau * T;
    return Math.max(0, Math.min(1, (t - this.deadTime) / Math.max(0.5, this.effDuration - TRANSIT_S)));
  }
  statsLine() {
    let awake = 0;
    for (let i = 0; i < this.N; i++) if (!this.frozen[i] && !this.bodies[i].isSleeping()) awake++;
    return `${this.releasedCount.toLocaleString()} / ${this.topStart.toLocaleString()} grains · ${awake} awake`;
  }
  cameraHome() { return { pos: [34, 13, 47], target: [0, 0, 0] }; }
  params() { return []; }

  onStart() { this.running = true; this.ensureNoise(); }
  onPause() { this.running = false; }
  onResume() { this.running = true; }
  onReset() {
    this.running = false;
    this.thetaBase = 0; this.orientation = 1;
    this.ctx.rig.rotation.z = 0;
    this.setGravity(0, -G);
    this.flipPhase = null;
    this.deadTime = 0;
    this.effDuration = this.duration;
    for (let i = 0; i < this.N; i++) {
      const o = i * 8;
      if (this.frozen[i]) this.unfreeze(i, false);
      this.bodies[i].setTranslation({ x: this.cache[o], y: this.cache[o + 1], z: this.cache[o + 2] }, false);
      this.bodies[i].setRotation({ x: this.cache[o + 3], y: this.cache[o + 4], z: this.cache[o + 5], w: this.cache[o + 6] }, false);
      this.bodies[i].setLinvel({ x: 0, y: 0, z: 0 }, false);
      this.bodies[i].setAngvel({ x: 0, y: 0, z: 0 }, false);
      this.released[i] = 0;
      this.pos.set([this.cache[o], this.cache[o + 1], this.cache[o + 2]], i * 3);
    }
    this.frozenList = [];
    for (let i = 0; i < this.N; i++) {
      if (this.cache[i * 8 + 7]) this.freeze(i);
      else this.bodies[i].sleep();
    }
    this.releasedCount = 0;
    this.topStart = this.N;
    this.relRate = 0;
    this.postStep(true);
  }

  setGravity(gx, gy) { this.world.gravity.x = gx; this.world.gravity.y = gy; this.world.gravity.z = 0; }
  freeze(i) { this.bodies[i].setBodyType(this.RAPIER.RigidBodyType.Fixed, false); this.frozen[i] = 1; this.frozenList.push(i); }
  unfreeze(i, wake) { this.bodies[i].setBodyType(this.RAPIER.RigidBodyType.Dynamic, wake); this.frozen[i] = 0; }

  freezePass() {
    for (let i = 0; i < this.N; i++) {
      if (this.frozen[i] || this.released[i]) continue;
      const yo = this.pos[i * 3 + 1] * this.orientation;
      if (yo > this.yHold) continue;
      const x = this.pos[i * 3], z = this.pos[i * 3 + 2];
      if (x * x + z * z < this.holdR2) this.freeze(i);
    }
  }

  dropThroughNeck(i, burstIdx) {
    const band = burstIdx % BANDS;
    const a = Math.random() * Math.PI * 2;
    const rr = Math.random() * NECK_R * 0.4;
    if (this.frozen[i]) this.unfreeze(i, true);
    this.bodies[i].setTranslation({
      x: Math.cos(a) * rr,
      y: -(THROAT_H + this.grainR * 1.6 + band * this.grainR * 2.2) * this.orientation,
      z: Math.sin(a) * rr,
    }, true);
    this.bodies[i].setLinvel({ x: (Math.random() - 0.5) * 1.5, y: -3 * this.orientation, z: (Math.random() - 0.5) * 1.5 }, true);
    this.bodies[i].setAngvel({ x: 0, y: 0, z: 0 }, false);
    this.released[i] = 1;
    this.releasedCount++;
  }

  wakeFeedZone() {
    for (let i = 0; i < this.N; i++) {
      if (this.frozen[i] || this.released[i]) continue;
      const yo = this.pos[i * 3 + 1] * this.orientation;
      if (yo < 0) continue;
      const x = this.pos[i * 3], z = this.pos[i * 3 + 2];
      if (yo < this.feedY || x * x + z * z < this.feedR2) this.bodies[i].wakeUp();
    }
  }

  meter(flowElapsed, complete = false) {
    const p = complete ? 1 : Math.min(1, flowElapsed / Math.max(0.5, this.effDuration - TRANSIT_S));
    const target = complete ? this.topStart : Math.round(this.topStart * p);
    let need = Math.min(REL_CAP, target - this.releasedCount);
    let releasedNow = 0;
    if (need > 0) {
      while (need > 0 && this.frozenList.length) {
        const i = this.frozenList.pop();
        if (this.released[i] || !this.frozen[i]) continue;
        this.dropThroughNeck(i, releasedNow);
        need--; releasedNow++;
      }
      if (need > 0) {
        const cands = [];
        for (let i = 0; i < this.N; i++) if (!this.released[i]) cands.push(i);
        cands.sort((a, b) => this.pos[a * 3 + 1] * this.orientation - this.pos[b * 3 + 1] * this.orientation);
        for (let k = 0; k < cands.length && need > 0; k++) {
          this.dropThroughNeck(cands[k], releasedNow);
          need--; releasedNow++;
        }
      }
      if (releasedNow > 0) this.wakeFeedZone();
    }
    this.relRate = this.relRate * 0.92 + releasedNow * 60 * 0.08;
  }

  postStep(force = false) {
    const m = HourglassWorld._m ??= new THREE.Matrix4();
    const q = HourglassWorld._q ??= new THREE.Quaternion();
    const v = HourglassWorld._v ??= new THREE.Vector3();
    const s = HourglassWorld._s ??= new THREE.Vector3(1, 1, 1);
    let dirty = false;
    const maxSq = V_MAX * V_MAX;
    for (let i = 0; i < this.N; i++) {
      const b = this.bodies[i];
      if (!force && (this.frozen[i] || b.isSleeping())) continue;
      const t = b.translation(), r = b.rotation();
      this.pos.set([t.x, t.y, t.z], i * 3);
      if (!this.frozen[i]) {
        const lv = b.linvel();
        const sq = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
        if (sq > maxSq) {
          const sc = V_MAX / Math.sqrt(sq);
          b.setLinvel({ x: lv.x * sc, y: lv.y * sc, z: lv.z * sc }, true);
          this.slow[i] = 0;
        } else if (!force && sq < SLEEP_SP2 && !this.flipPhase) {
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
      }
      v.set(t.x, t.y, t.z);
      q.set(r.x, r.y, r.z, r.w);
      m.compose(v, q, s);
      this.mesh.setMatrixAt(i, m);
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  flip() {
    // core restarts the clock at 0; the turn+settle time becomes deadTime
    this.flipPhase = 'turn';
    this.flipT = 0;
    for (let i = 0; i < this.N; i++) { if (this.frozen[i]) this.unfreeze(i, true); this.bodies[i].wakeUp(); }
    this.frozenList = [];
    this.running = true;
  }

  tick(dt, elapsed, running) {
    // flip animation (driven by world time, not the wall clock)
    if (this.flipPhase === 'turn') {
      this.flipT += dt;
      const t = Math.min(1, this.flipT / 1.4);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const theta = this.thetaBase + e * Math.PI;
      this.ctx.rig.rotation.z = theta;
      this.setGravity(-G * Math.sin(theta), -G * Math.cos(theta));
      for (let i = 0; i < this.N; i++) if (this.bodies[i].isSleeping()) this.bodies[i].wakeUp();
      if (t >= 1) {
        this.thetaBase = (this.thetaBase + Math.PI) % (2 * Math.PI);
        this.ctx.rig.rotation.z = this.thetaBase;
        this.orientation = Math.abs(this.thetaBase) < 0.1 ? 1 : -1;
        this.setGravity(0, -G * this.orientation);
        this.flipPhase = 'settle';
        this.flipT = 0;
      }
    } else if (this.flipPhase === 'settle') {
      this.flipT += dt;
      if (this.flipT >= 0.7) {
        this.flipPhase = null;
        let top = 0;
        for (let i = 0; i < this.N; i++) {
          const yo = this.pos[i * 3 + 1] * this.orientation;
          this.released[i] = yo > 0.2 ? 0 : 1;
          if (yo > 0.2) top++;
        }
        this.topStart = Math.max(1, top);
        this.releasedCount = 0;
        this.effDuration = Math.max(1, this.duration * (top / Math.max(1, this.N)));
        this.deadTime = elapsed; // flow starts now; the chart's theory accounts for it
      }
    }

    // physics stepping (runs in ready/done too so late grains settle)
    this.acc += dt;
    let steps = 0;
    while (this.acc >= DT && steps < MAX_STEPS) { this.world.step(); this.acc -= DT; steps++; }
    if (this.acc > DT) this.acc = 0;
    this.postStep();
    if (!this.flipPhase) {
      this.freezePass();
      const flow = elapsed - this.deadTime;
      if (running && flow >= 0) {
        this.meter(flow);
      } else if (!running && this.releasedCount > 0 && this.releasedCount < this.topStart && flow >= this.effDuration) {
        // core has hit 'done' — drain the stragglers (banded, capped per frame)
        this.meter(flow, true);
      }
    }
    this.updateNoise(running);
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
  updateNoise(running) {
    if (!this.noise) return;
    const ctx = this.ctx.audio();
    if (!ctx) return;
    const target = running ? Math.min(0.06, this.relRate * 0.004) : 0;
    this.noise.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.12);
  }

  dispose() {
    try { this.noise?.disconnect(); } catch {}
    this.world?.free();
    this.mesh?.geometry.dispose();
    this.mesh?.material.dispose();
    this.dressing?.glassMat.dispose();
  }
}
