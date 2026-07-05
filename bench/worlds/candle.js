/* The candle clock — steady combustion as a timer. The wax front recedes at a
   constant rate, so height maps linearly onto elapsed time and the engraved
   hour rings burn past one by one. No physics engine; the showpiece is the
   flame: two smoothed random walks drive its shape, sway and a warm point
   light, with recycled smoke sprites and the occasional wax drip for charm.
   See ../core/WORLD_CONTRACT.md; visual language matches worlds/hourglass.js. */
import * as THREE from 'three';

const H_C = 22;        // full candle height (1 unit = 10 cm)
const R_C = 3.2;       // candle radius
const MARKS = 8;       // hour divisions (7 engraved rings at k·H_C/8)
const MAX_DRIPS = 20;
const N_SMOKE = 24;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const rand = (a, b) => a + Math.random() * (b - a);

export default class CandleWorld {
  static id = 'candle';
  static label = '🕯️ Candle Clock';
  static blurb = 'Steady combustion: the wax front recedes at a constant rate, so height IS time. King Alfred timed his day with marked candles.';

  usesTimer = true;
  supportsFlip = false;
  theoryLabel = 'linear · steady combustion';

  constructor(ctx) {
    this.ctx = ctx;
    this.duration = 60;
    this.rate = H_C / 60;    // units/sec
    this.burned = 0;
    this.lit = false;
    this.flameScale = 0;     // 0..1 ignition/extinguish envelope
    this.emberT = 0;
    this.animT = 0;
    this.smokeIn = 0;
    this.crackleIn = 0;
    this.dripIn = rand(6, 14);
    this.dripCursor = 0;
    this.smokeCursor = 0;
    this.walkA = { v: 0.5, t: 0.5, next: 0 }; // flame shape + light intensity
    this.walkB = { v: 0.5, t: 0.5, next: 0 }; // sway
    this.crackleGain = null;
    this._disposables = [];
  }

  _track(o) { this._disposables.push(o); return o; }

  async build() {
    const rig = this.ctx.rig;

    // dark wood table (same look as the hourglass world's)
    const table = new THREE.Mesh(
      this._track(new THREE.CylinderGeometry(34, 36, 2.4, 64)),
      this._track(new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 0.85 }))
    );
    table.position.y = -1.8; // top face at y = -0.6; the dish sits on it
    table.receiveShadow = true;
    rig.add(table);

    // brass dish: shallow cylinder + torus rim
    const brass = this._track(new THREE.MeshStandardMaterial({
      color: 0xc9a227, metalness: 0.85, roughness: 0.35,
    }));
    const dish = new THREE.Mesh(this._track(new THREE.CylinderGeometry(6.2, 5.4, 0.6, 48)), brass);
    dish.position.y = -0.3;
    dish.castShadow = dish.receiveShadow = true;
    rig.add(dish);
    const dishRim = new THREE.Mesh(this._track(new THREE.TorusGeometry(6.1, 0.28, 12, 64)), brass);
    dishRim.rotation.x = Math.PI / 2;
    dishRim.position.y = 0.02;
    dishRim.castShadow = true;
    rig.add(dishRim);

    // wax body — geometry spans y ∈ [0, H_C]; scale.y renders the unburned height
    const waxGeo = this._track(new THREE.CylinderGeometry(R_C, R_C, H_C, 48));
    waxGeo.translate(0, H_C / 2, 0);
    this.candle = new THREE.Mesh(waxGeo, this._track(new THREE.MeshStandardMaterial({
      color: 0xf2e4c8, roughness: 0.55, emissive: 0x1a1206,
    })));
    this.candle.castShadow = this.candle.receiveShadow = true;
    rig.add(this.candle);

    // engraved hour marks — fixed heights in an UNSCALED group; hidden once burned past
    this.marks = new THREE.Group();
    const markGeo = this._track(new THREE.TorusGeometry(R_C + 0.03, 0.07, 8, 64));
    const markMat = this._track(new THREE.MeshStandardMaterial({ color: 0x8a6b40, roughness: 0.8 }));
    for (let k = 1; k < MARKS; k++) {
      const ring = new THREE.Mesh(markGeo, markMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = (k * H_C) / MARKS;
      this.marks.add(ring);
    }
    rig.add(this.marks);

    // everything that rides the receding melt line
    this.top = new THREE.Group();
    const meltMat = this._track(new THREE.MeshStandardMaterial({
      color: 0xe8cf9f, roughness: 0.25, emissive: 0x351d08, emissiveIntensity: 0.5,
    }));
    const pool = new THREE.Mesh(this._track(new THREE.CylinderGeometry(R_C - 0.06, R_C - 0.06, 0.12, 48)), meltMat);
    pool.position.y = 0.02;
    this.top.add(pool);
    const lip = new THREE.Mesh(this._track(new THREE.TorusGeometry(R_C, 0.09, 8, 64)), meltMat);
    lip.rotation.x = Math.PI / 2;
    lip.position.y = 0.04;
    this.top.add(lip);

    this.wickMat = this._track(new THREE.MeshStandardMaterial({
      color: 0x1c1310, roughness: 0.9, emissive: 0xff6a1a, emissiveIntensity: 0,
    }));
    const wick = new THREE.Mesh(this._track(new THREE.CylinderGeometry(0.09, 0.12, 0.7, 10)), this.wickMat);
    wick.position.y = 0.42;
    this.top.add(wick);

    // the flame — teardrop lathe, additive layers
    const drop = this._teardropGeo();
    const flameMat = (color, opacity) => this._track(new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.flame = new THREE.Group();
    this.flame.position.y = 0.72;
    const outer = new THREE.Mesh(drop, flameMat(0xff9633, 0.85));
    outer.renderOrder = 20;
    const core = new THREE.Mesh(drop, flameMat(0xfff3c9, 0.9));
    core.scale.set(0.45, 0.52, 0.45);
    core.position.y = 0.05;
    core.renderOrder = 21;
    const blue = new THREE.Mesh(this._track(new THREE.SphereGeometry(0.26, 12, 10)), flameMat(0x4d8dff, 0.5));
    blue.scale.set(1, 0.7, 1);
    blue.position.y = 0.12;
    blue.renderOrder = 19;
    this.flame.add(outer, core, blue);
    this.light = new THREE.PointLight(0xffa64d, 0, 45, 2);
    this.light.position.y = 0.6;
    this.flame.add(this.light);
    this.flame.visible = false;
    this.top.add(this.flame);
    rig.add(this.top);

    // smoke — recycled sprites over a soft radial DataTexture
    const S = 64, px = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) {
      const x = (i % S) + 0.5 - S / 2, y = Math.floor(i / S) + 0.5 - S / 2;
      const d = Math.min(1, Math.hypot(x, y) / (S / 2));
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 255;
      px[i * 4 + 3] = Math.round(Math.pow(1 - d, 2.4) * 255);
    }
    const tex = this._track(new THREE.DataTexture(px, S, S));
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.smoke = [];
    for (let i = 0; i < N_SMOKE; i++) {
      const sp = new THREE.Sprite(this._track(new THREE.SpriteMaterial({
        map: tex, color: 0x777777, transparent: true, opacity: 0, depthWrite: false,
      })));
      sp.visible = false;
      sp.renderOrder = 15;
      rig.add(sp);
      this.smoke.push({ sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0, peak: 0.1, grow: 0.5, phase: 0 });
    }

    // wax drips — small recycled pool riding the candle surface
    const dripGeo = this._track(new THREE.SphereGeometry(0.22, 10, 8));
    const dripMat = this._track(new THREE.MeshStandardMaterial({ color: 0xf2e4c8, roughness: 0.3 }));
    this.drips = [];
    for (let i = 0; i < MAX_DRIPS; i++) {
      const m = new THREE.Mesh(dripGeo, dripMat);
      m.scale.set(0.9, 1.5, 0.9);
      m.visible = false;
      rig.add(m);
      this.drips.push({ m, angle: 0, y: 0, vy: 0, state: 0 }); // 0 idle | 1 sliding | 2 stuck
    }

    this.applyBurn();
  }

  _teardropGeo() {
    const pts = [];
    const N = 14;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const r = 0.42 * Math.sin(Math.PI * Math.pow(t, 0.6)) * (1 - 0.3 * t);
      pts.push(new THREE.Vector2(i === 0 || i === N ? 0 : Math.max(0.01, r), t * 1.6));
    }
    return this._track(new THREE.LatheGeometry(pts, 20));
  }

  /* ---------- contract ---------- */
  setDuration(secs) {
    this.duration = Math.max(0.5, secs);
    this.rate = H_C / this.duration;
  }
  expectedDuration() { return this.duration; }
  progress() { return clamp01(this.burned / H_C); }
  theory(tau) { return tau; }
  statsLine() {
    const waxPct = ((H_C - this.burned) / H_C) * 100;
    // 1 unit = 10 cm → rate (units/s) × 10 × 60 = cm/min
    return `${waxPct.toFixed(0)}% wax · ${(this.rate * 600).toFixed(2)} cm/min · ${this.lit ? 'lit' : 'out'}`;
  }
  cameraHome() { return { pos: [20, 14, 34], target: [0, 9, 0] }; }
  params() { return []; }

  onStart() {
    this.lit = true; // flameScale eases in over 0.3s in tick (fresh light or relight)
    this.crackleIn = 0.4;
    this.smokeIn = 0.8;
    this.dripIn = rand(6, 14);
  }
  onPause() {}
  onResume() {}
  onReset() {
    this.burned = 0;
    this.lit = false;
    this.flameScale = 0;
    this.emberT = 0;
    this.wickMat.emissiveIntensity = 0;
    this.flame.visible = false;
    this.light.intensity = 0;
    for (const d of this.drips) { d.state = 0; d.m.visible = false; }
    for (const s of this.smoke) { s.life = 0; s.sp.visible = false; s.sp.material.opacity = 0; }
    this.applyBurn();
  }

  /* ---------- burn rendering ---------- */
  applyBurn() {
    const topY = Math.max(0.25, H_C - this.burned); // a wax stub survives in the dish
    this.candle.scale.y = topY / H_C;
    this.top.position.y = topY;
    for (const ring of this.marks.children) ring.visible = topY > ring.position.y + 0.06;
    return topY;
  }

  extinguish() {
    if (!this.lit) return;
    this.lit = false;
    this.emberT = 2;
    for (let i = 0; i < 15; i++) this.emitSmoke(true);
  }

  /* ---------- particles ---------- */
  emitSmoke(burst) {
    const s = this.smoke[this.smokeCursor++ % N_SMOKE];
    const y0 = this.top.position.y + 1.9;
    s.sp.position.set(rand(-0.15, 0.15), y0 + (burst ? rand(0, 0.6) : 0), rand(-0.15, 0.15));
    s.life = s.max = burst ? rand(2.4, 3.4) : rand(1.4, 2.2);
    s.vx = rand(-0.25, 0.25); s.vz = rand(-0.25, 0.25);
    s.vy = burst ? rand(1.4, 2.6) : rand(1.0, 1.8);
    s.peak = burst ? rand(0.16, 0.25) : rand(0.06, 0.12);
    s.grow = burst ? rand(0.8, 1.4) : rand(0.4, 0.8);
    s.phase = rand(0, Math.PI * 2);
    s.sp.scale.setScalar(burst ? rand(0.7, 1.2) : rand(0.4, 0.7));
    s.sp.visible = true;
  }

  spawnDrip() {
    const d = this.drips[this.dripCursor++ % MAX_DRIPS];
    d.angle = rand(0, Math.PI * 2); // fixed longitude for this droplet's whole life
    d.y = this.top.position.y - 0.15;
    d.vy = rand(1.0, 1.8);
    d.state = 1;
    d.m.visible = true;
    this.placeDrip(d);
  }
  placeDrip(d) {
    const r = R_C + 0.1; // at the candle SURFACE radius
    d.m.position.set(Math.cos(d.angle) * r, d.y, Math.sin(d.angle) * r);
  }

  stepWalk(w, dt) {
    w.next -= dt;
    if (w.next <= 0) { w.t = Math.random(); w.next = rand(0.08, 0.15); }
    w.v += (w.t - w.v) * Math.min(1, dt * 10);
    return w.v;
  }

  /* ---------- frame ---------- */
  tick(dt, elapsed, running) {
    this.animT += dt;

    // burn front: rate = H_C/duration, but clamped to the authoritative wall clock
    if (running) this.burned = Math.min(H_C, elapsed * this.rate);
    const topY = this.applyBurn();

    // end: guttered down to the stub, or the core stopped the run (done state)
    if (this.lit && (this.burned >= H_C * 0.98 || !running)) this.extinguish();

    // ignition / extinguish envelope
    if (this.lit) this.flameScale = Math.min(1, this.flameScale + dt / 0.3);
    else this.flameScale = Math.max(0, this.flameScale - dt / 0.6);
    this.flame.visible = this.flameScale > 0.001;

    // flicker — two smoothed random walks drive shape, sway and light in sync
    const a = this.stepWalk(this.walkA, dt);
    const b = this.stepWalk(this.walkB, dt);
    if (this.flame.visible) {
      const s = this.flameScale;
      this.flame.scale.set(s, s * (0.85 + 0.3 * a), s);
      this.flame.rotation.x = (b - 0.5) * 0.16;
      this.flame.rotation.z = (0.5 - b) * 0.13 + (a - 0.5) * 0.05;
      this.light.intensity = (180 + 80 * a) * s;
    } else {
      this.light.intensity = 0;
    }

    // ember glow on the wick after extinguish (~2s pulse)
    if (this.emberT > 0) {
      this.emberT = Math.max(0, this.emberT - dt);
      this.wickMat.emissiveIntensity = (this.emberT / 2) * (1.4 + 1.6 * a);
    }

    // smoke: thin wisps while lit; burst particles keep fading on their own
    if (this.lit && this.flameScale > 0.5) {
      this.smokeIn -= dt;
      if (this.smokeIn <= 0) { this.emitSmoke(false); this.smokeIn = rand(0.35, 0.8); }
    }
    for (const s of this.smoke) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.sp.visible = false; s.sp.material.opacity = 0; continue; }
      const age = 1 - s.life / s.max;
      s.sp.position.x += (s.vx + Math.sin(this.animT * 1.7 + s.phase) * 0.3) * dt;
      s.sp.position.z += (s.vz + Math.cos(this.animT * 1.3 + s.phase) * 0.3) * dt;
      s.sp.position.y += s.vy * dt;
      s.sp.scale.addScalar(s.grow * dt);
      s.sp.material.opacity = s.peak * Math.min(1, age * 4) * (1 - age);
    }

    // wax drips: spawn every ~6–14s while burning; slide, decelerate, stick
    if (running && this.lit) {
      this.dripIn -= dt;
      if (this.dripIn <= 0) { this.spawnDrip(); this.dripIn = rand(6, 14); }
    }
    for (const d of this.drips) {
      if (!d.state) continue;
      if (d.y > topY - 0.05) { d.state = 0; d.m.visible = false; continue; } // melt line consumed it
      if (d.state === 1) {
        d.y -= d.vy * dt;
        d.vy *= Math.exp(-0.5 * dt);
        if (d.vy < 0.08 || d.y < 0.35) { d.vy = 0; d.y = Math.max(0.35, d.y); d.state = 2; }
        this.placeDrip(d);
      }
    }

    // faint crackle while lit
    if (this.lit) {
      this.crackleIn -= dt;
      if (this.crackleIn <= 0) { this.crackle(); this.crackleIn = rand(0.3, 1.5); }
    }
  }

  /* ---------- audio ---------- */
  crackle() {
    const ac = this.ctx.audio();
    if (!ac) return;
    if (!this.crackleGain || this.crackleGain.context !== ac) {
      this.crackleGain = ac.createGain();
      this.crackleGain.gain.value = 1;
      this.crackleGain.connect(ac.destination);
      const len = Math.floor(ac.sampleRate * 0.25);
      this.noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rand(1800, 4400);
    bp.Q.value = 1.5;
    const g = ac.createGain();
    const t0 = ac.currentTime, dur = rand(0.03, 0.12);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(rand(0.004, 0.016), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(this.crackleGain);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  dispose() {
    try { this.crackleGain?.disconnect(); } catch {}
    this.crackleGain = null;
    this.light?.dispose();
    for (const o of this._disposables) o.dispose();
    this._disposables = [];
  }
}
