// river.js — RIVER visual for AURORA POST (user order: a river on the
// island). One job: drape a turquoise water ribbon + sand/gravel banks
// down the Aurora hill to the sea, with a spring pond at the source,
// bank rocks, stepping stones, a plank bridge IF a road crosses (none
// does today — checked against replicated buildRoads math), and a
// shorter stream on Signal Hill.
//
// VISUAL ONLY: heights come from options.heightAt (world.js analytic
// terrain, the single source of truth for flight.js) and are never
// modified. Nothing here is collidable, scored or read by flight.js /
// missions.js. Static geometry, zero per-frame work, no update hook.
//
// Hook contract: buildRiver({ heightAt, islands, strips }) returns a
// THREE.Group named 'river'; stats ride on group.userData.stats for
// QA. Follows the vegetation.js pattern (seeded RNG, replicated
// stripRectDistance, canvas textures with null fallback, no world.js
// import — no circular dependency). Paths verified offline against
// the real heightAt: Aurora river 802 m, h 60.0 → -4.2, min strip
// distance 161 m, max deviation from the ordered polyline 2.8 m;
// Signal Hill stream 708 m, h 110.7 → -3.1, 87 m from the lighthouse.

import * as THREE from 'three';

// ---------------------------------------------------------------- rng
// Same seeded LCG family as vegetation.js / world.js (deterministic
// placement: same river every load).
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ placement
// Distance from a point to a strip rectangle (0 when inside) — same
// math as world.js stripRectangleDistance / vegetation.js
// stripRectDistance, recomputed from the strip fields.
function stripRectDistance(strip, x, z) {
  const dx = x - strip.centre.x;
  const dz = z - strip.centre.z;
  const along = dx * strip.forward.x + dz * strip.forward.z;
  const across = dx * strip.right.x + dz * strip.right.z;
  const overAlong = Math.max(0, Math.abs(along) - strip.length / 2);
  const overAcross = Math.max(0, Math.abs(across) - strip.width / 2);
  return Math.sqrt(overAlong * overAlong + overAcross * overAcross);
}

// Terrain slope from heightAt alone (world.js terrainSlopeAt formula,
// step 6) — only needed to replicate the road walk for the bridge
// crossing check.
function slopeAt(heightAt, x, z) {
  const step = 6;
  const dx = heightAt(x + step, z) - heightAt(x - step, z);
  const dz = heightAt(x, z + step) - heightAt(x, z - step);
  return Math.sqrt(dx * dx + dz * dz) / (2 * step);
}

// Road centreline polylines, replicated from world.js buildRoads
// (STEP 16 m, 48 steps, stop at h < 1.4 or slope > 0.6, meander
// sin(travelled * 0.008 + phase) * 0.35 rad). Used only to detect a
// river/road crossing for the plank bridge.
function roadPolylines(heightAt, strips) {
  const lines = [];
  const STEP = 16;
  function addRoad(startX, startZ, dirX, dirZ, phase) {
    const baseAngle = Math.atan2(dirZ, dirX);
    let x = startX;
    let z = startZ;
    let travelled = 0;
    const pts = [];
    for (let i = 0; i < 48; i++) {
      if (heightAt(x, z) < 1.4) break;
      if (i > 2 && slopeAt(heightAt, x, z) > 0.6) break;
      pts.push({ x, z });
      const angle = baseAngle + Math.sin(travelled * 0.008 + phase) * 0.35;
      x += Math.cos(angle) * STEP;
      z += Math.sin(angle) * STEP;
      travelled += STEP;
    }
    if (pts.length > 1) lines.push(pts);
  }
  strips.forEach((strip, s) => {
    if (!strip.centre || !strip.forward || !strip.right) return;
    const side = strip.width / 2 + 16;
    addRoad(
      strip.centre.x + strip.forward.x * 30 + strip.right.x * side,
      strip.centre.z + strip.forward.z * 30 + strip.right.z * side,
      strip.forward.x * 0.65 + strip.right.x * 0.75,
      strip.forward.z * 0.65 + strip.right.z * 0.75, s * 1.7);
    if (s === 0) {
      addRoad(
        strip.centre.x - strip.forward.x * 30 + strip.right.x * side,
        strip.centre.z - strip.forward.z * 30 + strip.right.z * side,
        -strip.forward.x * 0.65 + strip.right.x * 0.75,
        -strip.forward.z * 0.65 + strip.right.z * 0.75, 4.2);
    }
  });
  return lines;
}

// 2D segment intersection (XZ plane); returns the crossing point or null.
function segmentCrossing(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x;
  const d1z = p2.z - p1.z;
  const d2x = p4.x - p3.x;
  const d2z = p4.z - p3.z;
  const denom = d1x * d2z - d1z * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2z - (p3.z - p1.z) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1z - (p3.z - p1.z) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + d1x * t, z: p1.z + d1z * t, roadDirX: d2x, roadDirZ: d2z };
}

// ------------------------------------------------------- canvas texture
// Vegetation-pattern canvas helper: null when canvas is unavailable
// (headless tests) so materials fall back to plain colour.
function canvasTexture(width, height, draw) {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    draw(context, width, height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    return texture;
  } catch (error) {
    return null;
  }
}

// Grayscale flow noise for the water bump/roughness maps: elongated
// horizontal streaks (canvas x = along the river) over a mid-grey
// base, so the surface breaks into moving-water flecks under the sun
// instead of one flat fill. Linear data (no sRGB) — it feeds
// bumpMap/roughnessMap only, the hue comes from the material colour.
function makeWaterNoiseTexture() {
  return canvasTexture(256, 256, (ctx, w, h) => {
    const rng = seededRandom(20261127);
    ctx.fillStyle = '#8c8c8c';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 420; i++) {
      const light = rng() > 0.5;
      ctx.fillStyle = light ? 'rgba(235,235,235,0.35)' : 'rgba(70,70,70,0.32)';
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 8 + rng() * 26, 1.2 + rng() * 2.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 1600; i++) {
      const v = 90 + Math.floor(rng() * 110);
      ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
      ctx.fillRect(rng() * w, rng() * h, 1.5 + rng() * 3, 1.2);
    }
  });
}

// ------------------------------------------------------------------
// Stream builder: samples one Catmull-Rom path, drapes a water ribbon
// + bank ribbon on heightAt, and collects detail spots (rocks,
// stepping stones) for shared instancing in buildRiver.
// ------------------------------------------------------------------
const SAMPLE_STEP_M = 4; // dense sampling: water never dips under terrain between samples
const WATER_LIFT_M = 0.35;
const BANK_LIFT_M = 0.04;
const BANK_EXTRA_M = 4; // bank ribbon extends this far past each water edge
const SMOOTH_RADIUS = 4; // moving-average half-window (9 samples ≈ 36 m)

const BANK_WET = new THREE.Color(0x8a6f4d); // damp sand at the waterline
const BANK_DRY = new THREE.Color(0xb08d5f); // darker than PALETTE.sand (dawn light pinked it)
const BANK_GRAVEL = new THREE.Color(0x7d7668);

function smoothHeights(values) {
  let current = values.slice();
  for (let pass = 0; pass < 2; pass++) {
    const next = new Array(current.length);
    for (let i = 0; i < current.length; i++) {
      let sum = 0;
      let count = 0;
      for (let k = -SMOOTH_RADIUS; k <= SMOOTH_RADIUS; k++) {
        const j = Math.min(current.length - 1, Math.max(0, i + k));
        sum += current[j];
        count++;
      }
      next[i] = sum / count;
    }
    current = next;
  }
  return current;
}

function buildStream(spec, heightAt, strips, materials, rng) {
  const points = spec.waypoints.map((w) => new THREE.Vector3(w.x, 0, w.z));
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const lengthM = curve.getLength();
  const count = Math.max(2, Math.ceil(lengthM / SAMPLE_STEP_M));

  // Sample centreline, tangents and terrain heights (centre + both
  // water edges, so the water surface clears the highest ground it
  // spans).
  const samples = [];
  for (let i = 0; i <= count; i++) {
    const u = i / count;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u);
    const width = spec.widthStart + (spec.widthEnd - spec.widthStart) * u;
    const half = width / 2;
    // Side vector in XZ: (tz, -tx) — perpendicular to the tangent.
    const sx = t.z;
    const sz = -t.x;
    const lx = p.x + sx * half;
    const lz = p.z + sz * half;
    const rx = p.x - sx * half;
    const rz = p.z - sz * half;
    const hC = heightAt(p.x, p.z);
    const hL = heightAt(lx, lz);
    const hR = heightAt(rx, rz);
    samples.push({
      x: p.x, z: p.z, tx: t.x, tz: t.z, sx, sz, half, hC, hL, hR,
      dist: u * lengthM, waterY: 0,
    });
  }
  // Water level: smoothed centreline terrain, forced non-increasing
  // downstream (a river never flows uphill) but never below the
  // centreline ground — the uphill edge may bury into the bank slope
  // on a cross-slope, which the sand banks cover; the channel middle
  // never clips through terrain and never floats over a dip by more
  // than the smoothing window allows.
  const smoothed = smoothHeights(samples.map((s) => s.hC));
  let prevY = Math.max(samples[0].hC, smoothed[0]);
  for (let i = 0; i < samples.length; i++) {
    const y = i === 0 ? prevY : Math.max(samples[i].hC, Math.min(smoothed[i], prevY));
    samples[i].waterY = y + WATER_LIFT_M;
    prevY = y;
  }

  // Strip clearance stat (QA): closest approach to any strip rect.
  let minStripDistM = Infinity;
  for (const s of samples) {
    for (const strip of strips) {
      if (!strip.centre || !strip.forward || !strip.right) continue;
      const d = stripRectDistance(strip, s.x, s.z);
      if (d < minStripDistM) minStripDistM = d;
    }
  }

  const group = new THREE.Group();
  group.name = spec.name;

  // --- water ribbon (3 verts across: centre pinned at the water
  // level so convex ridge crossings never poke through mid-channel;
  // edges hug the ground at +0.5 m where a steep cross-slope would
  // otherwise leave the downhill edge floating — still above the
  // banks at +0.04, so the water always wins the depth test) ---
  const wPos = [];
  const wUv = [];
  const wIdx = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const yL = Math.min(s.waterY, s.hL + 0.5);
    const yR = Math.min(s.waterY, s.hR + 0.5);
    wPos.push(s.x + s.sx * s.half, yL, s.z + s.sz * s.half);
    wPos.push(s.x, s.waterY, s.z);
    wPos.push(s.x - s.sx * s.half, yR, s.z - s.sz * s.half);
    const u = s.dist / 14; // one noise tile per 14 m of flow
    wUv.push(u, 0, u, 0.5, u, 1);
    if (i > 0) {
      const prev = (i - 1) * 3;
      const cur = i * 3;
      for (let k = 0; k < 2; k++) {
        wIdx.push(prev + k, prev + k + 1, cur + k, prev + k + 1, cur + k + 1, cur + k);
      }
    }
  }
  const waterGeo = new THREE.BufferGeometry();
  waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
  waterGeo.setAttribute('uv', new THREE.Float32BufferAttribute(wUv, 2));
  waterGeo.setIndex(wIdx);
  waterGeo.computeVertexNormals();
  const water = new THREE.Mesh(waterGeo, materials.water);
  water.name = spec.name + '-water';
  water.receiveShadow = true;
  group.add(water);

  // --- banks ribbon (4 verts across: outer dry → inner wet → inner
  // wet → outer dry), draped per-vertex on the terrain ---
  const bPos = [];
  const bCol = [];
  const bUv = [];
  const bIdx = [];
  const tmpColor = new THREE.Color();
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const offsets = [s.half + BANK_EXTRA_M, s.half, -s.half, -(s.half + BANK_EXTRA_M)];
    for (let k = 0; k < 4; k++) {
      const vx = s.x + s.sx * offsets[k];
      const vz = s.z + s.sz * offsets[k];
      bPos.push(vx, heightAt(vx, vz) + BANK_LIFT_M, vz);
      const inner = k === 1 || k === 2;
      tmpColor.copy(inner ? BANK_WET : BANK_DRY);
      // Gravel flecks + tone jitter so the bank is not one flat fill.
      tmpColor.lerp(BANK_GRAVEL, rng() * (inner ? 0.45 : 0.3));
      tmpColor.multiplyScalar(0.92 + rng() * 0.16);
      bCol.push(tmpColor.r, tmpColor.g, tmpColor.b);
      bUv.push(s.dist / 14, k / 3);
    }
    if (i > 0) {
      const prev = (i - 1) * 4;
      const cur = i * 4;
      for (let k = 0; k < 3; k++) {
        bIdx.push(prev + k, prev + k + 1, cur + k, prev + k + 1, cur + k + 1, cur + k);
      }
    }
  }
  const bankGeo = new THREE.BufferGeometry();
  bankGeo.setAttribute('position', new THREE.Float32BufferAttribute(bPos, 3));
  bankGeo.setAttribute('color', new THREE.Float32BufferAttribute(bCol, 3));
  bankGeo.setAttribute('uv', new THREE.Float32BufferAttribute(bUv, 2));
  bankGeo.setIndex(bIdx);
  bankGeo.computeVertexNormals();
  const banks = new THREE.Mesh(bankGeo, materials.bank);
  banks.name = spec.name + '-banks';
  banks.receiveShadow = true;
  group.add(banks);

  // --- spring pond at the source: disc conformed to the terrain ---
  const src = samples[0];
  const pondGeo = new THREE.CircleGeometry(spec.pondRadius, 28);
  pondGeo.rotateX(-Math.PI / 2);
  const pondPos = pondGeo.attributes.position;
  for (let i = 0; i < pondPos.count; i++) {
    const vx = pondPos.getX(i);
    const vz = pondPos.getZ(i);
    pondPos.setY(i, heightAt(src.x + vx, src.z + vz) + WATER_LIFT_M + 0.02);
  }
  pondGeo.computeVertexNormals();
  const pond = new THREE.Mesh(pondGeo, materials.water);
  pond.name = spec.name + '-pond';
  pond.position.set(src.x, 0, src.z);
  pond.receiveShadow = true;
  group.add(pond);

  // --- detail spots (instanced by buildRiver across all streams) ---
  const rockSpots = [];
  for (let i = 0; i < spec.rockCount; i++) {
    const s = samples[Math.floor(rng() * samples.length)];
    const sideSign = rng() > 0.5 ? 1 : -1;
    const off = (s.half + 0.8 + rng() * 5.5) * sideSign;
    const x = s.x + s.sx * off;
    const z = s.z + s.sz * off;
    rockSpots.push({
      x, y: heightAt(x, z) + 0.1, z,
      scale: 0.35 + rng() * 1.1,
      squash: 0.6 + rng() * 0.4,
      yaw: rng() * Math.PI * 2,
      tilt: (rng() - 0.5) * 0.5,
    });
  }
  const stoneSpots = [];
  for (const u of spec.stoneClusters) {
    const s = samples[Math.min(samples.length - 1, Math.floor(u * samples.length))];
    const across = [-0.55, 0, 0.55];
    for (const f of across) {
      const alongJitter = (rng() - 0.5) * 1.6;
      const x = s.x + s.sx * f * s.half + s.tx * alongJitter;
      const z = s.z + s.sz * f * s.half + s.tz * alongJitter;
      stoneSpots.push({
        x, y: s.waterY - 0.05, z,
        r: 0.8 + rng() * 0.35,
        yaw: rng() * Math.PI * 2,
      });
    }
  }

  return {
    group,
    samples,
    rockSpots,
    stoneSpots,
    stats: {
      name: spec.name,
      lengthM: Math.round(lengthM * 10) / 10,
      samples: samples.length,
      minStripDistM: Number.isFinite(minStripDistM) ? Math.round(minStripDistM * 10) / 10 : null,
      startH: Math.round(samples[0].hC * 100) / 100,
      endH: Math.round(samples[samples.length - 1].hC * 100) / 100,
    },
  };
}

// Wooden plank bridge at a road crossing: 3 planks side by side on
// 4 posts, deck along the road direction, spanning the water width.
function buildBridge(crossing, waterY, waterWidth, heightAt, material) {
  const group = new THREE.Group();
  group.name = 'river-bridge';
  const dirLen = Math.hypot(crossing.roadDirX, crossing.roadDirZ) || 1;
  const dx = crossing.roadDirX / dirLen;
  const dz = crossing.roadDirZ / dirLen;
  const yaw = -Math.atan2(dz, dx); // align box +X with the road direction
  const deckY = waterY + 0.6;
  const deckLen = waterWidth + 7;
  for (let i = -1; i <= 1; i++) {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(deckLen, 0.15, 0.85), material);
    plank.name = 'river-bridge-plank';
    // Offset across the deck (perpendicular to the road direction).
    plank.position.set(crossing.x - dz * i * 0.9, deckY, crossing.z + dx * i * 0.9);
    plank.rotation.y = yaw;
    plank.receiveShadow = true;
    group.add(plank);
  }
  for (const along of [-1, 1]) {
    for (const across of [-1, 1]) {
      const px = crossing.x + dx * along * (deckLen / 2 - 0.5) - dz * across * 1.1;
      const pz = crossing.z + dz * along * (deckLen / 2 - 0.5) + dx * across * 1.1;
      const groundY = heightAt(px, pz);
      const postH = Math.max(0.4, deckY - groundY + 0.3);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, postH, 6), material);
      post.name = 'river-bridge-post';
      post.position.set(px, groundY + postH / 2 - 0.3, pz);
      post.receiveShadow = true;
      group.add(post);
    }
  }
  return group;
}

function findIsland(islands, name, fallbackIndex, fallbackCentre) {
  if (Array.isArray(islands)) {
    const byName = islands.find((i) => i && i.name === name && i.centre);
    if (byName) return byName;
    const byIndex = islands[fallbackIndex];
    if (byIndex && byIndex.centre) return byIndex;
  }
  return { name, centre: fallbackCentre };
}

/**
 * Build the rivers. `options`: { heightAt, islands, strips } (as
 * world.js will pass them). Returns a THREE.Group; QA stats on
 * group.userData.stats = { lengthM, samples, rocks, bridges, ... }.
 * Static: no update hook, nothing to call per frame.
 */
export function buildRiver(options) {
  const group = new THREE.Group();
  group.name = 'river';
  const stats = { lengthM: 0, samples: 0, rocks: 0, bridges: 0, minStripDistM: null, streams: [] };
  group.userData.stats = stats;
  if (!options || typeof options.heightAt !== 'function') return group;
  const heightAt = options.heightAt;
  const islands = Array.isArray(options.islands) ? options.islands : [];
  const strips = Array.isArray(options.strips) ? options.strips : [];
  const rng = seededRandom(20261127);

  // Materials — sea.js palette family (deep 0x0d4f8a → shallow
  // turquoise 0x24c2b0); the river sits between them, biased bright
  // so it reads as fresh water over the sand banks.
  const noiseTexture = makeWaterNoiseTexture();
  const waterParams = {
    color: 0x1a9ec4,
    roughness: 0.22,
    metalness: 0.0,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
    // Water always wins the depth test against the bank ribbon
    // (banks sit at -1, water at -2): the channel must read as one
    // continuous ribbon from the air, never dirt with blue pools.
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  };
  if (noiseTexture) {
    waterParams.bumpMap = noiseTexture;
    waterParams.bumpScale = 0.5;
    waterParams.roughnessMap = noiseTexture;
  }
  const materials = {
    water: new THREE.MeshStandardMaterial(waterParams),
    bank: new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 1.0, metalness: 0.0,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    rock: new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, metalness: 0.0, flatShading: true,
    }),
    stone: new THREE.MeshStandardMaterial({
      color: 0x8a8578, roughness: 0.95, metalness: 0.0, flatShading: true,
    }),
    wood: new THREE.MeshStandardMaterial({
      color: 0x8a6844, roughness: 0.9, metalness: 0.0, flatShading: true,
    }),
  };

  // Waypoints are island-centre-relative so a config island shift
  // carries the river with it. Aurora offsets = the ordered absolute
  // polyline (centre 0,0): hill (342,0) → SE coast. Verified: stays
  // 161 m clear of Aurora Field, descends 60.0 → -4.2, ends in the sea.
  const aurora = findIsland(islands, 'Aurora', 0, { x: 0, z: 0 });
  const signal = findIsland(islands, 'Signal Hill', 7, { x: -800, z: 3600 });
  const rel = (island, offsets) => offsets.map((o) => ({
    x: island.centre.x + o[0], z: island.centre.z + o[1],
  }));
  const specs = [
    {
      name: 'aurora-river',
      waypoints: rel(aurora, [[335, 30], [430, 190], [500, 390], [575, 590], [660, 760]]),
      widthStart: 12, widthEnd: 18, pondRadius: 9, rockCount: 40,
      stoneClusters: [0.32, 0.58, 0.84],
    },
    {
      // Signal Hill stream: from below the hill (≥80 m from the
      // lighthouse at (-915,3413); verified min 87 m) flowing SW to
      // the coast. Verified: descends 110.7 → -3.1, no strip within
      // 2.7 km.
      name: 'signal-stream',
      waypoints: rel(signal, [[-60, -120], [-150, 20], [-250, 180], [-350, 350], [-460, 460]]),
      widthStart: 8, widthEnd: 11, pondRadius: 6, rockCount: 16,
      stoneClusters: [0.5],
    },
  ];

  const allRockSpots = [];
  const allStoneSpots = [];
  const built = [];
  for (const spec of specs) {
    const stream = buildStream(spec, heightAt, strips, materials, rng);
    group.add(stream.group);
    built.push(stream);
    allRockSpots.push(...stream.rockSpots);
    allStoneSpots.push(...stream.stoneSpots);
    stats.lengthM += stream.stats.lengthM;
    stats.samples += stream.stats.samples;
    stats.streams.push(stream.stats);
    if (stream.stats.minStripDistM !== null
      && (stats.minStripDistM === null || stream.stats.minStripDistM < stats.minStripDistM)) {
      stats.minStripDistM = stream.stats.minStripDistM;
    }
  }
  stats.lengthM = Math.round(stats.lengthM * 10) / 10;

  // --- instanced bank rocks (one draw) ---
  if (allRockSpots.length > 0) {
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rocks = new THREE.InstancedMesh(rockGeo, materials.rock, allRockSpots.length);
    rocks.name = 'river-rocks';
    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scl = new THREE.Vector3();
    const tint = new THREE.Color();
    const rockTints = [0x8a8578, 0x7a7264, 0x968d7c, 0x6e675c, 0x857a68];
    for (let i = 0; i < allRockSpots.length; i++) {
      const spot = allRockSpots[i];
      pos.set(spot.x, spot.y, spot.z);
      euler.set(spot.tilt, spot.yaw, spot.tilt * 0.6);
      quat.setFromEuler(euler);
      scl.set(spot.scale, spot.scale * spot.squash, spot.scale);
      matrix.compose(pos, quat, scl);
      rocks.setMatrixAt(i, matrix);
      tint.setHex(rockTints[Math.floor(rng() * rockTints.length)]);
      tint.multiplyScalar(0.85 + rng() * 0.3);
      rocks.setColorAt(i, tint);
    }
    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    rocks.receiveShadow = true;
    if (typeof rocks.computeBoundingSphere === 'function') rocks.computeBoundingSphere();
    group.add(rocks);
    stats.rocks = allRockSpots.length;
  }

  // --- instanced stepping stones (one draw) ---
  if (allStoneSpots.length > 0) {
    const stoneGeo = new THREE.CylinderGeometry(1, 1, 0.3, 10);
    const stones = new THREE.InstancedMesh(stoneGeo, materials.stone, allStoneSpots.length);
    stones.name = 'river-stepping-stones';
    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scl = new THREE.Vector3();
    for (let i = 0; i < allStoneSpots.length; i++) {
      const spot = allStoneSpots[i];
      pos.set(spot.x, spot.y, spot.z);
      euler.set(0, spot.yaw, 0);
      quat.setFromEuler(euler);
      scl.set(spot.r, 1, spot.r * (0.8 + rng() * 0.3));
      matrix.compose(pos, quat, scl);
      stones.setMatrixAt(i, matrix);
    }
    stones.instanceMatrix.needsUpdate = true;
    stones.receiveShadow = true;
    if (typeof stones.computeBoundingSphere === 'function') stones.computeBoundingSphere();
    group.add(stones);
  }

  // --- plank bridge where a road crosses (checked, not assumed) ---
  // With today's world the Aurora roads pass ~59 m west of the river
  // and never cross it, so this normally adds nothing; it exists so a
  // future strip/road change gets its bridge automatically.
  const roads = roadPolylines(heightAt, strips);
  outer:
  for (const stream of built) {
    const samples = stream.samples;
    for (let i = 0; i < samples.length - 1; i++) {
      for (const line of roads) {
        for (let j = 0; j < line.length - 1; j++) {
          const hit = segmentCrossing(samples[i], samples[i + 1], line[j], line[j + 1]);
          if (hit) {
            group.add(buildBridge(hit, samples[i].waterY, samples[i].half * 2, heightAt, materials.wood));
            stats.bridges += 1;
            break outer;
          }
        }
      }
    }
  }

  return group;
}
