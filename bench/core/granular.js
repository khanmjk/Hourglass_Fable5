/* Shared granular helpers: the hourglass profile, watertight convex-box
   walls, near-packed seeding, and the instanced grit mesh. Extracted from
   the V2 hourglass so granular worlds share one implementation.
   Scale: 1 unit = 10 cm; gravity ~75 works well with these radii. */
import * as THREE from 'three';

export const GLASS = {
  H: 15.5,        // interior half-height
  BULB_R: 10.5,
  CAP_R: 5.2,
  THROAT_H: 0.6,  // half-height of the narrow throat
};

export function makeProfile(neckR) {
  const { H, BULB_R, CAP_R } = GLASS;
  const WAIST_Y = 0.62 * H;
  const smooth = (t) => t * t * (3 - 2 * t);
  return function profileR(u) {
    if (u <= WAIST_Y) return neckR + (BULB_R - neckR) * smooth(u / WAIST_Y);
    const t = Math.min(1, (u - WAIST_Y) / (H - WAIST_Y));
    return BULB_R + (CAP_R - BULB_R) * smooth(t);
  };
}

/* Grain radius from the fill volume so N grains fill the bulb to the same line. */
export function grainRadiusFor(profileR, count, fillFrac = 0.78, packing = 0.62) {
  const { H, THROAT_H } = GLASS;
  const yTop = H * fillFrac;
  let v = 0;
  const steps = 240;
  for (let i = 0; i < steps; i++) {
    const y = THROAT_H + ((yTop - THROAT_H) * (i + 0.5)) / steps;
    const r = profileR(y);
    v += Math.PI * r * r * ((yTop - THROAT_H) / steps);
  }
  const perGrain = (v * packing) / count;
  return Math.max(0.28, Math.min(0.85, Math.cbrt(perGrain / ((4 / 3) * Math.PI))));
}

/* Watertight interior: rings of thick convex cuboids tracing the profile,
   plus end lids. Zero-thickness trimeshes eject grains under pile pressure;
   solid boxes cannot. Returns the fixed rigid body. */
export function buildWalls(RAPIER, world, profileR) {
  const { H, CAP_R } = GLASS;
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const BANDS = 30, SEGS = 26, WALL_T = 0.9;
  const q = new THREE.Quaternion(), basis = new THREE.Matrix4();
  const xA = new THREE.Vector3(), yA = new THREE.Vector3(), zA = new THREE.Vector3();
  for (let b = 0; b < BANDS; b++) {
    const y0 = -H + (2 * H * b) / BANDS, y1 = -H + (2 * H * (b + 1)) / BANDS;
    const r0 = profileR(Math.abs(y0)), r1 = profileR(Math.abs(y1));
    const ym = (y0 + y1) / 2, rm = (r0 + r1) / 2;
    const dr = r1 - r0, dy = y1 - y0;
    const L = Math.hypot(dr, dy);
    const nu = dy / L, ny = -dr / L;
    const cu = rm + nu * (WALL_T / 2), cy = ym + ny * (WALL_T / 2);
    const chord = (2 * Math.PI * Math.max(cu, 0.4)) / SEGS;
    for (let s = 0; s < SEGS; s++) {
      const a = (s / SEGS) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      yA.set((dr / L) * ca, dy / L, (dr / L) * sa);
      xA.set(-sa, 0, ca);
      zA.crossVectors(xA, yA).normalize();
      basis.makeBasis(xA, yA, zA);
      q.setFromRotationMatrix(basis);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(chord * 0.62, L / 2 + 0.12, WALL_T / 2)
          .setTranslation(cu * ca, cy, cu * sa)
          .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          .setFriction(0.55).setRestitution(0.02),
        fixed
      );
    }
  }
  for (const s of [-1, 1]) {
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(0.5, CAP_R + 1.2)
        .setTranslation(0, s * (H + 0.48), 0)
        .setFriction(0.55),
      fixed
    );
  }
  return fixed;
}

/* Near-packed concentric-ring seeding above the throat. */
export function seedPositions(profileR, grainR, count, yFrom = null) {
  const { H, THROAT_H } = GLASS;
  const out = [];
  const jit = () => (Math.random() - 0.5) * grainR * 0.6;
  const spacing = grainR * 1.96;
  for (let y = (yFrom ?? THROAT_H + grainR); y < H - 1.2 && out.length < count; y += grainR * 1.75) {
    const rMax = profileR(Math.abs(y)) - grainR - 0.15;
    if (rMax <= 0) continue;
    out.push([jit() * 0.4, y, jit() * 0.4]);
    const a0 = y * 3.7;
    for (let rr = spacing; rr <= rMax && out.length < count; rr += spacing) {
      const n = Math.max(3, Math.floor((Math.PI * 2 * rr) / spacing));
      for (let k = 0; k < n && out.length < count; k++) {
        const a = a0 + (k / n) * Math.PI * 2;
        out.push([Math.cos(a) * rr + jit(), y + jit() * 0.4, Math.sin(a) * rr + jit()]);
      }
    }
  }
  return out;
}

/* Faceted, flat-shaded, palette-jittered grit. */
export function makeGrainMesh(count, grainR) {
  const geo = new THREE.IcosahedronGeometry(grainR, 0);
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.95, metalness: 0, flatShading: true, envMapIntensity: 0.45,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  const palette = [0xe8c074, 0xdca85a, 0xf0d089, 0xcf9a4c, 0xe3b366, 0xf5dca0];
  const c = new THREE.Color(), hsl = {};
  for (let i = 0; i < count; i++) {
    c.setHex(palette[(Math.random() * palette.length) | 0]);
    c.getHSL(hsl);
    c.setHSL(hsl.h, hsl.s + (Math.random() - 0.5) * 0.05, hsl.l + (Math.random() - 0.5) * 0.09);
    mesh.setColorAt(i, c);
  }
  mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/* The glass body + wooden frame + table dressing. Adds to rig; returns
   { glass, glassMat } so callers can swap material on perf fallback. */
export function buildGlassDressing(rig, profileR, { withTable = true } = {}) {
  const { H, BULB_R } = GLASS;
  const lathePts = [new THREE.Vector2(0.15, -H)];
  for (let i = 0; i <= 72; i++) {
    const y = -H + (2 * H * i) / 72;
    lathePts.push(new THREE.Vector2(profileR(Math.abs(y)) + 0.12, y));
  }
  lathePts.push(new THREE.Vector2(0.15, H));
  const glassMat = new THREE.MeshPhysicalMaterial({
    transmission: 1, thickness: 0.9, roughness: 0.035, ior: 1.45,
    clearcoat: 0.5, clearcoatRoughness: 0.18,
    attenuationColor: new THREE.Color(0xeaf4f8), attenuationDistance: 140,
    specularIntensity: 0.6, envMapIntensity: 0.45,
  });
  const glass = new THREE.Mesh(new THREE.LatheGeometry(lathePts, 72), glassMat);
  rig.add(glass);

  const woodMat = new THREE.MeshStandardMaterial({ color: 0x5c3a22, roughness: 0.62, metalness: 0.05 });
  const woodDark = new THREE.MeshStandardMaterial({ color: 0x472c18, roughness: 0.7, metalness: 0.05 });
  for (const s of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(BULB_R + 2.2, BULB_R + 2.2, 1.5, 48), woodMat);
    cap.position.y = s * (H + 0.75);
    cap.castShadow = cap.receiveShadow = true;
    rig.add(cap);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(BULB_R + 2.2, 0.28, 12, 64), woodDark);
    lip.rotation.x = Math.PI / 2;
    lip.position.y = s * (H + 1.55);
    lip.castShadow = true;
    rig.add(lip);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2 * H + 1.5, 16), woodDark);
    post.position.set(Math.cos(a) * (BULB_R + 1.3), 0, Math.sin(a) * (BULB_R + 1.3));
    post.castShadow = true;
    rig.add(post);
  }
  if (withTable) {
    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(34, 36, 2.4, 64),
      new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 0.85 })
    );
    table.position.y = -(H + 1.83) - 1.2;
    table.receiveShadow = true;
    rig.add(table);
  }
  return { glass, glassMat };
}
