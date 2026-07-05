/* ChronoBench core: one renderer, one wall clock, one bench chart —
   many simulation worlds. Worlds implement core/WORLD_CONTRACT.md. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BenchChart } from './chart.js';
import HourglassWorld from '../worlds/hourglass.js';
import GranuleLabWorld from '../worlds/granulab.js';
import WaterClockWorld from '../worlds/waterclock.js';
import CandleWorld from '../worlds/candle.js';

const WORLDS = [HourglassWorld, GranuleLabWorld, WaterClockWorld, CandleWorld];

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const clockEl = $('clock'), statusEl = $('status'), blurbEl = $('blurb'), statsEl = $('stats');
const overlayEl = $('overlay'), overlayText = $('overlayText'), errEl = $('err');
const startBtn = $('startBtn'), flipBtn = $('flipBtn'), resetBtn = $('resetBtn'), muteBtn = $('muteBtn');
const tabsEl = $('tabs'), presetsEl = $('presets'), paramsRow = $('paramsRow');

function fatal(msg) {
  overlayEl.classList.remove('hidden');
  overlayText.style.display = 'none';
  errEl.style.display = 'block';
  errEl.textContent = msg;
}
function setBusy(text) {
  if (text) {
    overlayText.style.display = '';
    overlayText.textContent = text;
    overlayEl.classList.remove('hidden');
  } else {
    overlayEl.classList.add('hidden');
  }
}

/* ---------- three ---------- */
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  fatal('The graphics context was lost — please refresh the page.');
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f16);
scene.fog = new THREE.Fog(0x0d0f16, 150, 420);
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new RoomEnvironment();
  scene.environment = pmrem.fromScene(env, 0.04).texture;
  pmrem.dispose(); env.dispose();
}
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.5, 500);
camera.position.set(34, 13, 47);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.autoRotate = false;
controls.minDistance = 12;
controls.maxDistance = 130;
controls.maxPolarAngle = Math.PI / 2 + 0.25;

const keyLight = new THREE.DirectionalLight(0xfff2dd, 2.8);
keyLight.position.set(40, 70, 50);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -45; keyLight.shadow.camera.right = 45;
keyLight.shadow.camera.top = 45; keyLight.shadow.camera.bottom = -45;
keyLight.shadow.camera.far = 250;
keyLight.shadow.bias = -0.0008;
keyLight.shadow.normalBias = 0.4;
scene.add(keyLight);
scene.add(new THREE.HemisphereLight(0x8899bb, 0x21160a, 0.5));
const rim = new THREE.PointLight(0xd9a95c, 2200, 0, 2);
rim.position.set(-30, 25, -30);
scene.add(rim);

const rig = new THREE.Group();
scene.add(rig);

/* ---------- shared singletons ---------- */
let rapierPromise = null;
async function getRAPIER() {
  if (!rapierPromise) {
    rapierPromise = import('@dimforge/rapier3d-simd-compat').then(async (ns) => {
      const RAPIER = ns.default ?? ns;
      await RAPIER.init();
      return RAPIER;
    });
  }
  return rapierPromise;
}

let audioCtx = null, muted = false;
function audio() {
  if (muted) return null;
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
muteBtn.addEventListener('click', () => {
  muted = !muted;
  muteBtn.textContent = muted ? '🔇' : '🔊';
});

/* ---------- timer / state ---------- */
let state = 'boot'; // boot | building | ready | running | paused | done
let world = null;
let duration = 60;
let startStamp = 0, elapsedMs = 0;
let chimed = false;

const chart = new BenchChart($('benchChart'));

function fmt(secs) {
  secs = Math.max(0, secs);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (secs < 10 && state === 'running' && world?.usesTimer) return `${m}:${String(s).padStart(2, '0')}.${Math.floor((secs % 1) * 10)}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function chime() {
  const ctx = audio();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  for (const [f, dt, dur] of [[659.25, 0, 0.9], [880, 0.18, 1.3]]) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0 + dt); o.stop(t0 + dt + dur + 0.1);
  }
}

function setStatus(s) { statusEl.textContent = s; }
function updateButtons() {
  const busy = state === 'boot' || state === 'building';
  startBtn.disabled = busy || state === 'done';
  startBtn.textContent =
    state === 'running' ? 'Pause' :
    state === 'paused' ? 'Resume' :
    (world && !world.usesTimer ? world.actionLabel : 'Start');
  flipBtn.style.display = world?.supportsFlip ? '' : 'none';
  flipBtn.disabled = busy;
  resetBtn.disabled = busy;
  presetsEl.style.display = world && !world.usesTimer ? 'none' : '';
  for (const b of presetsEl.querySelectorAll('.chip')) b.disabled = busy;
  const inp = $('customMin');
  inp.disabled = busy;
  for (const t of tabsEl.querySelectorAll('.tab')) t.disabled = busy;
}

function renderParams() {
  paramsRow.innerHTML = '';
  if (!world) return;
  for (const p of world.params()) {
    const wrap = document.createElement('div');
    wrap.className = 'param';
    const label = document.createElement('span');
    label.textContent = p.label;
    wrap.appendChild(label);
    if (p.type === 'slider') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = p.min; input.max = p.max; input.step = p.step; input.value = p.value;
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = p.format ? p.format(p.value) : p.value;
      input.addEventListener('input', () => {
        val.textContent = p.format ? p.format(+input.value) : input.value;
        p.onChange(+input.value);
      });
      wrap.appendChild(input); wrap.appendChild(val);
    } else if (p.type === 'select') {
      const sel = document.createElement('select');
      for (const o of p.options) {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label;
        if (o.value === p.value) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => p.onChange(sel.value));
      wrap.appendChild(sel);
    } else if (p.type === 'button') {
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.textContent = p.label;
      btn.addEventListener('click', () => p.onClick());
      wrap.innerHTML = '';
      wrap.appendChild(btn);
    }
    paramsRow.appendChild(wrap);
  }
}

function resetRun() {
  elapsedMs = 0; chimed = false;
  chart.reset((t) => world.theory(t));
  $('benchLaw').textContent = world.theoryLabel || '';
  clockEl.classList.remove('done');
}

async function selectWorld(Cls) {
  if (world) {
    try { world.dispose(); } catch (e) { console.warn(e); }
    world = null;
  }
  rig.clear();
  rig.rotation.set(0, 0, 0);
  state = 'building';
  updateButtons();
  setBusy(`Building ${Cls.label.replace(/^\S+\s/, '')}…`);
  for (const t of tabsEl.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.id === Cls.id);
  blurbEl.textContent = Cls.blurb;
  try {
    world = new Cls({ THREE, scene, camera, renderer, rig, getRAPIER, audio, setBusy });
    await world.build();
    world.setDuration?.(duration);
    const home = world.cameraHome();
    camera.position.set(...home.pos);
    controls.target.set(...home.target);
    renderParams();
    resetRun();
    state = 'ready';
    setBusy(null);
    setStatus('ready');
  } catch (err) {
    console.error(err);
    fatal(`Could not build this world (${err?.message || err}). Refresh to retry.`);
  }
  updateButtons();
}

/* ---------- UI wiring ---------- */
for (const Cls of WORLDS) {
  const b = document.createElement('button');
  b.className = 'tab';
  b.dataset.id = Cls.id;
  b.textContent = Cls.label;
  b.addEventListener('click', () => { if (state !== 'building' && Cls.id !== world?.constructor.id) selectWorld(Cls); });
  tabsEl.appendChild(b);
}

presetsEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || chip.disabled) return;
  presetsEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
  $('customMin').value = '';
  duration = Number(chip.dataset.secs);
  applyDuration();
});
$('customMin').addEventListener('change', () => {
  if (state === 'building' || state === 'boot') return;
  const v = parseFloat($('customMin').value);
  if (!Number.isFinite(v) || v <= 0) return;
  presetsEl.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  duration = Math.min(180, Math.max(0.25, v)) * 60;
  applyDuration();
});
function applyDuration() {
  world?.setDuration?.(duration);
  world?.onReset?.();
  resetRun();
  state = 'ready';
  setStatus('ready');
  updateButtons();
}

startBtn.addEventListener('click', () => {
  if (!world) return;
  if (state === 'ready') {
    startStamp = performance.now();
    elapsedMs = 0;
    state = 'running';
    world.onStart?.();
    audio();
    setStatus(world.usesTimer ? 'flowing' : 'observing');
  } else if (state === 'running') {
    state = 'paused';
    world.onPause?.();
    setStatus('paused');
  } else if (state === 'paused') {
    startStamp = performance.now() - elapsedMs;
    state = 'running';
    world.onResume?.();
    setStatus(world.usesTimer ? 'flowing' : 'observing');
  }
  updateButtons();
});
flipBtn.addEventListener('click', () => {
  if (world?.supportsFlip && state !== 'building') {
    world.flip();
    resetRun();
    startStamp = performance.now();
    state = 'running';
    setStatus('flowing');
    updateButtons();
  }
});
resetBtn.addEventListener('click', () => {
  if (!world || state === 'building') return;
  world.onReset?.();
  resetRun();
  state = 'ready';
  setStatus('ready');
  updateButtons();
});
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); startBtn.click(); }
  else if ((e.key === 'r' || e.key === 'R')) resetBtn.click();
  else if ((e.key === 'f' || e.key === 'F') && world?.supportsFlip) flipBtn.click();
});
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  chart.resize();
});

/* ---------- loop ---------- */
let lastT = 0, fps = 60, statsTimer = 0, sampleTimer = 0, lastRaf = 0;
// keep the clock honest if rAF is suspended in a background tab
setInterval(() => {
  if (performance.now() - lastRaf < 400) return;
  if (state === 'running') {
    elapsedMs = performance.now() - startStamp;
    if (world?.usesTimer && elapsedMs / 1000 >= world.expectedDuration() && !chimed) {
      chimed = true;
      state = 'done';
      world.onPause?.();
      chime();
    }
  }
}, 300);

function loop(now) {
  requestAnimationFrame(loop);
  lastRaf = now;
  const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016);
  lastT = now;
  fps = fps * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05;

  if (state === 'running') elapsedMs = now - startStamp;
  const elapsed = elapsedMs / 1000;

  if (world && state !== 'building' && state !== 'boot' && state !== 'paused') {
    world.tick(dt, elapsed, state === 'running');
  }

  // finish conditions (expectedDuration, not the preset — flips shorten the run)
  const T = world ? world.expectedDuration() : duration;
  if (state === 'running') {
    if (world.usesTimer && elapsed >= T) {
      state = 'done'; chimed = true;
      clockEl.classList.add('done');
      chime();
      setStatus("time's up");
      updateButtons();
    } else if (!world.usesTimer && world.progress() >= 0.999) {
      state = 'done';
      clockEl.classList.add('done');
      setStatus('drained');
      updateButtons();
    }
  }

  // clock
  if (world?.usesTimer) {
    clockEl.textContent = state === 'done' ? fmt(0) : fmt((state === 'ready' ? duration : T - elapsed));
  } else {
    clockEl.textContent = fmt(elapsed);
  }

  // bench sampling
  if (world && (state === 'running' || state === 'done')) {
    sampleTimer += dt;
    if (sampleTimer > 0.25 && state === 'running') {
      sampleTimer = 0;
      const T = world.expectedDuration();
      if (T > 0) chart.push(elapsed / T, world.progress());
    }
  }
  statsTimer += dt;
  if (statsTimer > 0.3) {
    statsTimer = 0;
    chart.draw();
    const err = chart.meanErrorPct();
    $('benchErr').textContent = err == null ? '—' : `twin vs law: ±${err.toFixed(1)}%`;
    if (world) statsEl.textContent = `${world.statsLine()} · ${Math.round(fps)} fps`;
  }

  controls.update();
  renderer.render(scene, camera);
}

/* ---------- boot ---------- */
(async () => {
  try {
    updateButtons();
    await selectWorld(WORLDS[0]);
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    fatal('Boot failed: ' + (err?.message || err));
  }
})();
