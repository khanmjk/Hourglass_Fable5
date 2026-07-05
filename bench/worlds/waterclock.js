/* The water clock — the anti-hourglass. Torricelli's law (v = √(2gh)) makes a
   cylindrical vessel drain fast-then-slow: h(t) = h₀(1−t/T)². The ancient fix
   was vessel GEOMETRY: with r(h) ∝ h^¼ the LEVEL falls linearly. Both shapes
   are simulated honestly: at calibration the Torricelli ODE dh/dt = −(a/A(h))·√(2gh)
   is integrated once (as an exact quadrature in w=√h, which removes the
   h→0 singularity) into a lookup table; tick() just interpolates h(elapsed),
   so playback is faithful and frame-rate independent.
   See ../core/WORLD_CONTRACT.md; visual language matches worlds/hourglass.js. */
import * as THREE from 'three';

const G = 75;                 // scene gravity, matches the hourglass world
const H0 = 16;                // interior water-column height at start
const Y0 = 6;                 // orifice height: interior bottom of the upper vessel
const R_TOP = 6;              // interior radius (cylinder; engineered at the rim)
const R_LOW = 7, LOW_H = 13, LOW_Y = -10; // receiving vessel: radius, height, floor y
const N_DROPS = 50;
const TAB_N = 800;            // samples in the h(τ) / V(τ) lookup tables

export default class WaterClockWorld {
  static id = 'water';
  static label = '💧 Water Clock';
  static blurb = 'Water is not sand: Torricelli says the outflow slows as the head drops. The ancients fixed it with vessel shape — r ∝ h^¼ makes the level fall linearly.';

  usesTimer = true;
  supportsFlip = false;
  theoryLabel = 'quadratic level · Torricelli';

  constructor(ctx) {
    this.ctx = ctx;
    this.duration = 60;
    this.shape = 'cylinder';
    this.h = H0;              // current head above the orifice
    this.tau = 0;             // normalized elapsed time of the last applied level
    this.speed = 0;           // √(2gh)
    this.flow = 0;            // volumetric outflow a·√(2gh)
    this.Qref = 1;            // outflow at full head (current calibration)
    this.streamLen = 1;
    this.builtWaterH = -1;    // level at which the engineered water lathe was built
    this.noise = null; this.noiseSrc = null;
  }

  /* Interior radius at head h (0..H0). */
  rOf(h) {
    if (this.shape === 'cylinder') return R_TOP;
    return Math.max(0.9, R_TOP * Math.pow(Math.max(h, 0) / H0, 0.25));
  }

  async build() {
    const rig = this.ctx.rig;

    // --- materials (all disposed in dispose()) ---
    this.glassMat = new THREE.MeshPhysicalMaterial({
      transmission: 1, thickness: 0.9, roughness: 0.035, ior: 1.45,
      clearcoat: 0.5, clearcoatRoughness: 0.18,
      attenuationColor: new THREE.Color(0xeaf4f8), attenuationDistance: 140,
      specularIntensity: 0.6, envMapIntensity: 0.45, side: THREE.DoubleSide,
    });
    // plain tinted transparency: nested transmission materials don't refract
    // each other in three's transmission pass, so "water inside glass" reads
    // milky-white with transmission — simple alpha reads as water reliably
    this.waterMat = new THREE.MeshPhysicalMaterial({
      color: 0x3fa8d8, transparent: true, opacity: 0.55,
      roughness: 0.12, metalness: 0, envMapIntensity: 0.8,
      clearcoat: 0.6, clearcoatRoughness: 0.2, depthWrite: false,
    });
    this.woodMat = new THREE.MeshStandardMaterial({ color: 0x5c3a22, roughness: 0.62, metalness: 0.05 });
    this.woodDark = new THREE.MeshStandardMaterial({ color: 0x472c18, roughness: 0.7, metalness: 0.05 });
    this.tableMat = new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 0.85 });
    this.markMat = new THREE.MeshStandardMaterial({ color: 0x1c130c, roughness: 0.55, metalness: 0.1 });
    this.spoutMat = new THREE.MeshStandardMaterial({ color: 0x9a7b46, metalness: 0.85, roughness: 0.35 });
    this.dropMat = new THREE.MeshStandardMaterial({
      color: 0xcfeafc, roughness: 0.06, metalness: 0, envMapIntensity: 1.1,
      transparent: true, opacity: 0.85,
    });
    this.streamTex = this.makeRampTexture();
    this.streamMat = new THREE.MeshStandardMaterial({
      color: 0xbfe8f7, roughness: 0.06, metalness: 0, envMapIntensity: 1.2,
      transparent: true, opacity: 0.7, alphaMap: this.streamTex, depthWrite: false,
    });

    // --- table (same look as the hourglass world) ---
    const table = new THREE.Mesh(new THREE.CylinderGeometry(34, 36, 2.4, 64), this.tableMat);
    table.position.y = LOW_Y - 1.2;
    table.receiveShadow = true;
    rig.add(table);

    this.buildStand(rig);
    this.buildLower(rig);

    this.upperGroup = new THREE.Group();
    this.marksGroup = new THREE.Group();
    rig.add(this.upperGroup, this.marksGroup);
    this.buildUpper();

    // brass spout at the orifice
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.24, 0.8, 24), this.spoutMat);
    spout.position.y = Y0 - 0.35;
    spout.castShadow = true;
    rig.add(spout);

    // falling stream: unit cylinder, top pinned at its origin, alpha fades at the bottom
    const sg = new THREE.CylinderGeometry(1, 0.75, 1, 14, 1, true);
    sg.translate(0, -0.5, 0);
    this.stream = new THREE.Mesh(sg, this.streamMat);
    this.stream.visible = false;
    rig.add(this.stream);

    // recycled droplets riding the stream
    this.drops = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 8, 6), this.dropMat, N_DROPS);
    this.drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.drops.frustumCulled = false;
    this.drops.visible = false;
    rig.add(this.drops);
    this.dropS = new Float32Array(N_DROPS);
    this.dropSpd = new Float32Array(N_DROPS);
    this.dropX = new Float32Array(N_DROPS);
    this.dropZ = new Float32Array(N_DROPS);
    for (let i = 0; i < N_DROPS; i++) this.resetDrop(i, true);

    this.calibrate();
    this.applyLevel(0, false);
  }

  makeRampTexture() {
    const n = 32, data = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      // row 0 = v0 = bottom of the stream → transparent; opaque by ~45% up
      const a = Math.min(1, (i / (n - 1)) * 2.2);
      data[i * 4] = 255;
      data[i * 4 + 1] = Math.round(a * 255); // alphaMap reads the green channel
      data[i * 4 + 2] = 255;
      data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, 1, n, THREE.RGBAFormat);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  buildStand(rig) {
    const up = new THREE.Vector3(0, 1, 0), radial = new THREE.Vector3();
    const postH = 30.8;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, postH, 14), this.woodDark);
      post.position.set(Math.cos(a) * 9.6, LOW_Y + postH / 2, Math.sin(a) * 9.6);
      post.castShadow = true;
      rig.add(post);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 3.6, 10), this.woodMat);
      arm.position.set(Math.cos(a) * 8.1, 20, Math.sin(a) * 8.1);
      arm.quaternion.setFromUnitVectors(up, radial.set(Math.cos(a), 0, Math.sin(a)).normalize());
      arm.castShadow = true;
      rig.add(arm);
    }
    const collar = new THREE.Mesh(new THREE.TorusGeometry(6.6, 0.42, 10, 64), this.woodMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 20;
    collar.castShadow = true;
    rig.add(collar);
    const brace = new THREE.Mesh(new THREE.TorusGeometry(9.6, 0.26, 8, 64), this.woodDark);
    brace.rotation.x = Math.PI / 2;
    brace.position.y = -2;
    brace.castShadow = true;
    rig.add(brace);
  }

  buildLower(rig) {
    const b = LOW_Y + 0.1, top = LOW_Y + LOW_H;
    const pts = [
      new THREE.Vector2(0.4, b),
      new THREE.Vector2(R_LOW + 0.12, b),
      new THREE.Vector2(R_LOW + 0.12, (b + top) / 2),
      new THREE.Vector2(R_LOW + 0.12, top),
      new THREE.Vector2(R_LOW + 0.3, top + 0.25),
    ];
    rig.add(new THREE.Mesh(new THREE.LatheGeometry(pts, 64), this.glassMat));
    const g = new THREE.CylinderGeometry(R_LOW - 0.1, R_LOW - 0.1, 1, 48);
    g.translate(0, 0.5, 0); // base at local y=0 so scale.y = fill height
    this.lowerWater = new THREE.Mesh(g, this.waterMat);
    this.lowerWater.position.y = LOW_Y + 0.18;
    this.lowerWater.scale.y = 0.02;
    this.lowerWater.visible = false;
    rig.add(this.lowerWater);
  }

  /* Upper vessel glass + water mesh for the current shape (rebuilt on shape change). */
  buildUpper() {
    if (this.upperGlass) {
      this.upperGlass.geometry.dispose();
      this.upperWater.geometry.dispose();
      this.upperGroup.clear();
    }
    const pts = [
      new THREE.Vector2(0.32, Y0 - 0.14),
      new THREE.Vector2(this.rOf(0) + 0.12, Y0 - 0.14),
    ];
    const S = 40;
    for (let j = 0; j <= S; j++) {
      const h = (H0 * j) / S;
      pts.push(new THREE.Vector2(this.rOf(h) + 0.12, Y0 + h));
    }
    pts.push(new THREE.Vector2(this.rOf(H0) + 0.34, Y0 + H0 + 0.35)); // rim flare
    this.upperGlass = new THREE.Mesh(new THREE.LatheGeometry(pts, 72), this.glassMat);
    this.upperGroup.add(this.upperGlass);

    if (this.shape === 'cylinder') {
      // a unit cylinder scaled in Y is all the wetted interior ever needs
      const g = new THREE.CylinderGeometry(R_TOP - 0.06, R_TOP - 0.06, 1, 48);
      g.translate(0, 0.5, 0);
      this.upperWater = new THREE.Mesh(g, this.waterMat);
    } else {
      this.upperWater = new THREE.Mesh(this.waterLathe(this.h), this.waterMat);
      this.builtWaterH = this.h;
    }
    this.upperWater.position.y = Y0 + 0.02;
    this.upperGroup.add(this.upperWater);
  }

  /* Closed lathe of the wetted interior of the engineered vessel up to head h. */
  waterLathe(h) {
    h = Math.max(0.02, h);
    const S = 22, pts = [new THREE.Vector2(0.02, 0.02)];
    for (let j = 0; j <= S; j++) {
      const hj = (h * j) / S;
      pts.push(new THREE.Vector2(Math.max(0.05, this.rOf(hj) - 0.06), 0.02 + hj));
    }
    pts.push(new THREE.Vector2(0.02, 0.02 + h));
    return new THREE.LatheGeometry(pts, 48);
  }

  /* --- physics: one exact quadrature per calibration, then table lookups ---
     dh/dt = −(a/A(h))·√(2gh)  ⇒  t(h→0) = ∫ A(u)/(a√(2gu)) du. Substituting
     u = w² makes the integrand smooth: t = ∫ 2A(w²)/(a√(2g)) dw. */
  calibrate() {
    const N = 8000, wMax = Math.sqrt(H0), dw = wMax / N, s2g = Math.sqrt(2 * G);
    const A = (h) => { const r = this.rOf(h); return Math.PI * r * r; };
    const cumT = new Float64Array(N + 1); // unit-orifice time to drain from level w² to 0
    const cumV = new Float64Array(N + 1); // water volume below level w²
    let fT = 2 * A(0) / s2g, fV = 0;
    for (let i = 1; i <= N; i++) {
      const w = i * dw, h = w * w;
      const gT = 2 * A(h) / s2g, gV = 2 * w * A(h);
      cumT[i] = cumT[i - 1] + 0.5 * (fT + gT) * dw;
      cumV[i] = cumV[i - 1] + 0.5 * (fV + gV) * dw;
      fT = gT; fV = gV;
    }
    const t1 = cumT[N];                  // full drain time with orifice area a = 1
    this.a = t1 / this.duration;         // orifice area so the drain takes exactly duration
    this.totalVol = cumV[N];
    this.Qref = this.a * Math.sqrt(2 * G * H0);

    // invert into h(τ) and drained-volume V(τ): cumT(√h) = t1·(1−τ)
    this.hTab = new Float64Array(TAB_N + 1);
    this.vTab = new Float64Array(TAB_N + 1);
    let j = N;
    for (let k = 0; k <= TAB_N; k++) {
      const remT = t1 * (1 - k / TAB_N);
      while (j > 0 && cumT[j - 1] >= remT) j--;
      let w = 0;
      if (j > 0) {
        const f = (remT - cumT[j - 1]) / Math.max(1e-12, cumT[j] - cumT[j - 1]);
        w = (j - 1 + f) * dw;
      }
      this.hTab[k] = w * w;
      const wi = Math.min(N - 1e-6, w / dw), i0 = Math.floor(wi);
      this.vTab[k] = this.totalVol - (cumV[i0] + (cumV[i0 + 1] - cumV[i0]) * (wi - i0));
    }
    this.hTab[0] = H0; this.vTab[0] = 0;
    this.hTab[TAB_N] = 0; this.vTab[TAB_N] = this.totalVol;
    this.buildMarks();
  }

  lookup(tab, tau) {
    const x = Math.max(0, Math.min(1, tau)) * TAB_N;
    const i = Math.min(TAB_N - 1, Math.floor(x));
    return tab[i] + (tab[i + 1] - tab[i]) * (x - i);
  }

  /* Equal-time gradations: rings at the levels the water stands at t = k·T/8.
     They crowd near the bottom on the cylinder, sit evenly on the engineered vessel. */
  buildMarks() {
    for (const m of this.marksGroup.children) m.geometry.dispose();
    this.marksGroup.clear();
    for (let k = 0; k < 8; k++) {
      const level = this.lookup(this.hTab, k / 8);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(this.rOf(level) + 0.26, 0.06, 6, 64), this.markMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = Y0 + level;
      this.marksGroup.add(ring);
    }
  }

  /* --- world contract --- */
  setDuration(secs) { this.duration = secs; this.calibrate(); }
  expectedDuration() { return this.duration; }
  progress() { return Math.max(0, Math.min(1, 1 - this.h / H0)); }
  theory(tau) {
    tau = Math.max(0, Math.min(1, tau));
    return this.shape === 'cylinder' ? 1 - (1 - tau) ** 2 : tau;
  }
  statsLine() {
    const s = `level ${(Math.max(0, this.h / H0) * 100).toFixed(0)}% · outflow √(2gh) = ${this.speed.toFixed(1)} u/s`;
    return this.h <= 1e-3 ? s + ' · drained' : s;
  }
  cameraHome() { return { pos: [28, 10, 46], target: [0, 4, 0] }; }

  params() {
    return [{
      type: 'select', id: 'vessel', label: 'Vessel', value: this.shape,
      options: [
        { value: 'cylinder', label: 'Cylinder (ancient problem)' },
        { value: 'engineered', label: 'Engineered r∝h^¼ (linear level)' },
      ],
      onChange: (v) => {
        if (v === this.shape) return;
        this.shape = v;
        this.theoryLabel = v === 'cylinder'
          ? 'quadratic level · Torricelli'
          : 'linear level · engineered profile';
        this.buildUpper();
        this.calibrate();
        this.applyLevel(this.tau, false);
      },
    }];
  }

  onStart() { this.ensureNoise(); }
  onPause() { this.setNoiseTarget(0); }
  onResume() {}
  onReset() {
    this.tau = 0;
    this.applyLevel(0, false);
    for (let i = 0; i < N_DROPS; i++) this.resetDrop(i, true);
    this.setNoiseTarget(0);
  }

  tick(dt, elapsed, running) {
    if (running) {
      this.tau = Math.min(1, elapsed / Math.max(1e-3, this.duration));
      this.applyLevel(this.tau, true);
      this.animateDrops(dt);
    }
    this.setNoiseTarget(running && this.flow > 1e-5
      ? Math.min(0.05, 0.05 * (this.flow / Math.max(1e-9, this.Qref)))
      : 0);
  }

  /* Push the state at normalized time tau into every mesh. */
  applyLevel(tau, flowing) {
    const h = this.h = this.lookup(this.hTab, tau);
    const drained = this.lookup(this.vTab, tau);
    this.speed = Math.sqrt(2 * G * Math.max(0, h));
    this.flow = h > 1e-4 ? this.a * this.speed : 0;

    // upper water
    this.upperWater.visible = h > 0.015;
    if (this.shape === 'cylinder') {
      this.upperWater.scale.y = Math.max(0.01, h);
    } else if (Math.abs(h - this.builtWaterH) > H0 * 0.005) {
      this.upperWater.geometry.dispose();
      this.upperWater.geometry = this.waterLathe(h);
      this.builtWaterH = h;
    }

    // lower vessel fills by volume conservation, capped below its rim
    const lvl = Math.min(LOW_H - 0.6, drained / (Math.PI * R_LOW * R_LOW));
    this.lowerLevel = lvl;
    this.lowerWater.visible = lvl > 0.02;
    this.lowerWater.scale.y = Math.max(0.02, lvl);

    // stream: radius ∝ √outflow, spanning orifice → lower surface
    const on = !!flowing && this.flow > 1e-4;
    this.stream.visible = on;
    this.drops.visible = on;
    if (on) {
      const top = Y0 - 0.55;
      const len = Math.max(0.1, top - (LOW_Y + 0.18 + lvl));
      const r = Math.min(0.3, Math.max(0.08, 0.3 * Math.sqrt(this.flow / this.Qref)));
      this.stream.scale.set(r, len, r);
      this.stream.position.y = top;
      this.streamLen = len;
      this.streamR = r;
    }
  }

  resetDrop(i, randomPhase) {
    this.dropS[i] = randomPhase ? Math.random() : 0;
    this.dropSpd[i] = 1.3 + Math.random() * 0.5;
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random());
    this.dropX[i] = Math.cos(a) * rr;
    this.dropZ[i] = Math.sin(a) * rr;
  }

  animateDrops(dt) {
    if (!this.drops.visible) return;
    const m = WaterClockWorld._m ??= new THREE.Matrix4();
    const top = Y0 - 0.55;
    for (let i = 0; i < N_DROPS; i++) {
      this.dropS[i] += dt * this.dropSpd[i];
      if (this.dropS[i] >= 1) { this.dropS[i] -= 1; this.resetDrop(i, false); this.dropS[i] = Math.random() * 0.05; }
      const f = this.dropS[i] * this.dropS[i]; // free fall: position ∝ t²
      const wob = this.streamR * 0.7 + 0.18 * f;
      m.makeTranslation(this.dropX[i] * wob, top - f * this.streamLen, this.dropZ[i] * wob);
      this.drops.setMatrixAt(i, m);
    }
    this.drops.instanceMatrix.needsUpdate = true;
  }

  /* --- soft trickle: filtered noise, gain ∝ outflow --- */
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
    bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 1.5;
    this.noise = ctx.createGain();
    this.noise.gain.value = 0;
    src.connect(bp).connect(this.noise).connect(ctx.destination);
    src.start();
    this.noiseSrc = src;
  }
  setNoiseTarget(target) {
    if (!this.noise) return;
    const ctx = this.ctx.audio();
    if (!ctx) return;
    this.noise.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.15);
  }

  dispose() {
    try { this.noise?.disconnect(); } catch {}
    try { this.noiseSrc?.stop(); } catch {}
    this.ctx.rig.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
    this.drops?.dispose();
    for (const m of [this.glassMat, this.waterMat, this.woodMat, this.woodDark, this.tableMat,
      this.markMat, this.spoutMat, this.dropMat, this.streamMat]) m?.dispose();
    this.streamTex?.dispose();
  }
}
