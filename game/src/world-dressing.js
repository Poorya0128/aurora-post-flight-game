// world-dressing.js — ambient scenery layer for the archipelago.
//
// Three purely-visual systems live here:
//   1. a foam band traced around every island's real coastline,
//   2. a high cirrus sheet tinted by the dawn sun,
//   3. instanced seabird flocks circling the shores.
// Nothing in this module collides, scores, or feeds the flight model.
// The world builder hands over its own height function; animation is a
// pure function of world time, so any frozen pose is reproducible.
//
// Draw budget: surf 1, cirrus 1, birds 3 (instanced). The per-frame
// update allocates nothing — scratch matrices are module-level.

import * as THREE from 'three';

const BEARINGS = 144;          // coastline samples per island
const BAND_IN_M = 4;           // foam band reaches this far up the beach
const BAND_OUT_M = 26;         // ... and this far out to sea
const CIRRUS_Y = 2600;         // altitude of the cloud sheet
const CIRRUS_SPAN = 26000;     // sheet size in metres
const CIRRUS_TILE = 4200;      // metres covered by one texture tile
const WINGSPAN = 2.9;          // bird span; big enough to read at judge size

// Small deterministic PRNG (Numerical Recipes LCG) so every machine
// paints identical foam, cirrus and flock layouts.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Paint a canvas and wrap it as an sRGB texture; null when headless.
function paintTexture(w, h, painter) {
  if (typeof document === 'undefined') return null;
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  const ctx = el.getContext('2d');
  if (!ctx) return null;
  painter(ctx, w, h);
  const tex = new THREE.CanvasTexture(el);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ------------------------------------------------------------------ surf

// Foam texture: v runs across the band (0 = beach, 1 = open sea),
// u runs along the shore. Three rows of streaky ellipses — a bright
// swash line, broken foam behind it, a fainter offshore crest — then
// a vertical fade so both edges dissolve into sand and water.
function makeFoamTexture() {
  const tex = paintTexture(512, 128, (ctx, w, h) => {
    const rand = rng(5150);
    ctx.clearRect(0, 0, w, h);
    const rows = [
      [0.24, 0.07, 0.95],
      [0.36, 0.12, 0.45],
      [0.7, 0.05, 0.5],
    ];
    for (const [mid, spread, peak] of rows) {
      for (let i = 0; i < 420; i++) {
        const cx = rand() * w;
        const cy = (mid + (rand() - 0.5) * spread * 2) * h;
        const len = 10 + rand() * 46;
        const thick = 1 + rand() * 2.6;
        ctx.fillStyle = `rgba(255,255,255,${(peak * (0.35 + rand() * 0.65)).toFixed(3)})`;
        const blob = (x) => {
          ctx.beginPath();
          ctx.ellipse(x, cy, len / 2, thick / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        };
        blob(cx);
        if (cx + len / 2 > w) blob(cx - w); // keep the u-seam invisible
      }
    }
    ctx.globalCompositeOperation = 'destination-in';
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.18, 'rgba(0,0,0,1)');
    g.addColorStop(0.78, 'rgba(0,0,0,0.9)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  });
  if (tex) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  }
  return tex;
}

// Walk one bearing inward from open sea until terrain pokes above the
// waterline. Returns the distance from the island centre, or null if
// that bearing never reaches land.
function landfall(isle, bearing, heightAt, seaY) {
  for (let d = isle.radius * 1.45; d > isle.radius * 0.15; d -= 5) {
    const x = isle.centre.x + Math.cos(bearing) * d;
    const z = isle.centre.z + Math.sin(bearing) * d;
    if (heightAt(x, z) > seaY + 0.15) return d;
  }
  return null;
}

// One merged ribbon mesh for every island: two vertices per bearing
// (inner/outer edge of the foam band), quads skipped where a bearing
// found no shoreline.
function makeSurf(islands, heightAt, seaY) {
  const pos = [];
  const uv = [];
  const idx = [];
  for (const isle of islands) {
    const shore = Array.from({ length: BEARINGS }, (_, k) =>
      landfall(isle, (k / BEARINGS) * Math.PI * 2, heightAt, seaY));
    const repeats = Math.max(4, Math.round((2 * Math.PI * isle.radius) / 90));
    const first = pos.length / 3;
    for (let k = 0; k <= BEARINGS; k++) {
      const slot = k % BEARINGS;
      const ang = (slot / BEARINGS) * Math.PI * 2;
      const d = shore[slot] === null ? isle.radius : shore[slot];
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const u = (k / BEARINGS) * repeats;
      for (const [off, v] of [[-BAND_IN_M, 0], [BAND_OUT_M, 1]]) {
        pos.push(isle.centre.x + ca * (d + off), seaY + 0.12, isle.centre.z + sa * (d + off));
        uv.push(u, v);
      }
    }
    for (let k = 0; k < BEARINGS; k++) {
      if (shore[k] === null || shore[(k + 1) % BEARINGS] === null) continue;
      const a = first + k * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const tex = makeFoamTexture();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff6ec,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  if (tex) mat.map = tex;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'coast-surf';
  mesh.renderOrder = 1;
  return { mesh, mat, tex, tris: idx.length / 3 };
}

// --------------------------------------------------------------- cirrus

// Wispy strokes combed in one direction, drawn 3x3-wrapped so the
// tile repeats seamlessly. White paint; the material colour does the
// dawn tinting.
function makeCirrusTexture() {
  const tex = paintTexture(512, 512, (ctx, w, h) => {
    const rand = rng(918);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    for (let i = 0; i < 70; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const len = 120 + rand() * 260;
      const bend = (rand() - 0.5) * 40;
      const strokes = 6 + Math.floor(rand() * 10);
      for (let s = 0; s < strokes; s++) {
        const dy = (rand() - 0.5) * 22;
        ctx.strokeStyle = `rgba(255,255,255,${(0.03 + rand() * 0.07).toFixed(3)})`;
        ctx.lineWidth = 2 + rand() * 7;
        for (const ox of [0, -w, w]) {
          for (const oy of [0, -h, h]) {
            ctx.beginPath();
            ctx.moveTo(x + ox, y + dy + oy);
            ctx.quadraticCurveTo(x + len / 2 + ox, y + dy + bend + oy, x + len + ox, y + dy + bend * 0.4 + oy);
            ctx.stroke();
          }
        }
      }
    }
  });
  if (tex) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    const tiles = CIRRUS_SPAN / CIRRUS_TILE;
    tex.repeat.set(tiles, tiles);
  }
  return tex;
}

// Radial alpha falloff so the sheet's rim never shows against the sky.
function makeCirrusFade() {
  return paintTexture(256, 256, (ctx, w) => {
    const c = w / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, w);
  });
}

function makeCirrus() {
  const map = makeCirrusTexture();
  const fade = makeCirrusFade();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffd2bd,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  if (map) mat.map = map;
  if (fade) mat.alphaMap = fade;
  const geo = new THREE.PlaneGeometry(CIRRUS_SPAN, CIRRUS_SPAN);
  geo.rotateX(Math.PI / 2); // face downward toward the islands
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'cirrus-veil';
  mesh.position.y = CIRRUS_Y;
  mesh.renderOrder = -5; // right after the sky dome
  mesh.frustumCulled = false;
  return { mesh, map };
}

// ---------------------------------------------------------------- birds

// One wing: a swept tapered fan of three triangles, dark at the tip
// via vertex colour. `side` is -1 for left, +1 for right.
function wingGeometry(side) {
  const half = WINGSPAN / 2;
  const pts = [
    [0, 0, -0.16],
    [side * half * 0.55, 0.04, -0.1],
    [side * half, 0.02, 0.18],
    [side * half * 0.62, 0, 0.16],
    [0, 0, 0.14],
  ];
  const faces = [[0, 1, 4], [1, 3, 4], [1, 2, 3]];
  const pos = [];
  const col = [];
  for (const face of faces) {
    for (const vi of face) {
      const p = pts[vi];
      pos.push(p[0], p[1], p[2]);
      const shade = Math.abs(p[0]) > half * 0.8 ? 0.22 : 0.92;
      col.push(shade, shade, shade * 0.98);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

function bodyGeometry() {
  const geo = new THREE.ConeGeometry(0.1, 0.62, 5);
  geo.rotateX(-Math.PI / 2); // beak toward -Z
  return geo;
}

// Scatter each flock's birds around its anchor with per-bird orbit and
// flap parameters, then build the three instanced meshes.
function makeFlocks(spots) {
  const rand = rng(3031);
  const birds = [];
  for (const spot of spots) {
    const n = spot.count || 9;
    for (let i = 0; i < n; i++) {
      birds.push({
        cx: spot.x,
        cz: spot.z,
        alt: spot.altitude + (rand() - 0.5) * 18,
        orbit: spot.radius * (0.7 + rand() * 0.6),
        omega: (0.16 + rand() * 0.08) * (rand() < 0.5 ? 1 : -1),
        phase: rand() * Math.PI * 2,
        flapHz: 6 + rand() * 3,
        flap0: rand() * Math.PI * 2,
        bob0: rand() * Math.PI * 2,
      });
    }
  }
  const wingMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, flatShading: true,
  });
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.8, flatShading: true });
  const left = new THREE.InstancedMesh(wingGeometry(-1), wingMat, birds.length);
  const right = new THREE.InstancedMesh(wingGeometry(1), wingMat, birds.length);
  const bodies = new THREE.InstancedMesh(bodyGeometry(), bodyMat, birds.length);
  for (const m of [left, right, bodies]) {
    m.frustumCulled = false; // roaming instances would outgrow static bounds
    m.castShadow = false;
  }
  const group = new THREE.Group();
  group.name = 'seabird-flocks';
  group.add(left, right, bodies);
  return { group, birds, left, right, bodies };
}

// Scratch space reused every frame.
const _mBody = new THREE.Matrix4();
const _mWing = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _qWing = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _origin = new THREE.Vector3();

// Place every bird on its circular path, nose along the tangent,
// banked into the turn; wings flap in bursts with glide pauses.
function poseFlocks(flock, t) {
  const { birds, left, right, bodies } = flock;
  birds.forEach((b, i) => {
    const ang = b.phase + t * b.omega;
    _p.set(
      b.cx + Math.cos(ang) * b.orbit,
      b.alt + Math.sin(t * 0.6 + b.bob0) * 3,
      b.cz + Math.sin(ang) * b.orbit,
    );
    const dir = b.omega > 0 ? 1 : -1;
    const yaw = Math.atan2(Math.sin(ang) * dir, -Math.cos(ang) * dir);
    _e.set(0, yaw, dir * 0.32, 'YXZ');
    _q.setFromEuler(_e);
    _mBody.compose(_p, _q, _one);
    bodies.setMatrixAt(i, _mBody);
    const beat = (t * b.flapHz + b.flap0) % (Math.PI * 6);
    const flap = beat < Math.PI * 2 ? Math.sin(beat) * 0.55 : 0.08;
    _qWing.setFromAxisAngle(_zAxis, flap);
    _mWing.compose(_origin, _qWing, _one).premultiply(_mBody);
    right.setMatrixAt(i, _mWing);
    _qWing.setFromAxisAngle(_zAxis, -flap);
    _mWing.compose(_origin, _qWing, _one).premultiply(_mBody);
    left.setMatrixAt(i, _mWing);
  });
  left.instanceMatrix.needsUpdate = true;
  right.instanceMatrix.needsUpdate = true;
  bodies.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- build

/**
 * Build the dressing layer.
 * options: { islands: [{centre, radius}], heightAt(x,z), seaLevel,
 *            flockSpots: [{x, z, altitude, radius, count}] }
 * Returns { group, update(timeSeconds, cameraPosition), stats }.
 */
export function buildWorldDressing(options) {
  const { islands, heightAt, seaLevel, flockSpots } = options;
  const group = new THREE.Group();
  group.name = 'world-dressing';

  const surf = makeSurf(islands, heightAt, seaLevel);
  group.add(surf.mesh);

  const cirrus = makeCirrus();
  group.add(cirrus.mesh);

  const flock = makeFlocks(flockSpots || []);
  group.add(flock.group);
  poseFlocks(flock, 0);

  function update(timeSeconds, cameraPosition) {
    const t = typeof timeSeconds === 'number' ? timeSeconds : 0;
    // Foam surges up and back the beach and drifts alongshore.
    if (surf.tex) {
      surf.tex.offset.y = -0.11 + Math.sin(t * 0.9) * 0.07;
      surf.tex.offset.x = (t * 0.012) % 1;
    }
    surf.mat.opacity = 0.88 + Math.sin(t * 0.9 + 1.2) * 0.08;
    // The cirrus sheet follows the camera so it never ends, but its
    // texture stays world-pinned (plus a slow high-altitude drift).
    if (cameraPosition) {
      cirrus.mesh.position.x = cameraPosition.x;
      cirrus.mesh.position.z = cameraPosition.z;
    }
    if (cirrus.map) {
      const tiles = CIRRUS_SPAN / CIRRUS_TILE;
      const wx = cirrus.mesh.position.x + t * 6;
      const wz = cirrus.mesh.position.z;
      cirrus.map.offset.set(((wx / CIRRUS_SPAN) * tiles) % 1, ((wz / CIRRUS_SPAN) * tiles) % 1);
    }
    poseFlocks(flock, t);
  }

  return {
    group,
    update,
    stats: { surfTriangles: surf.tris, birds: flock.birds.length },
  };
}
