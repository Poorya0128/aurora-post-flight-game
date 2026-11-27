// structures-dense.js — structures density upgrade (visual only).
//
// Adds the built-environment density the air reads at altitude:
// five fire-lookout watchtowers at the reserve centres, 6–10 extra
// houses per existing fishing village (varied forms: two-storey
// steep-roof, L-shape, long barn-house), and tower-like silhouettes
// (church bell tower, grain silos, windmill, extra water tower).
//
// Nothing here is collidable, scored or read by flight.js /
// missions.js — every structure keeps the same airfield clearances
// world.js buildVillages uses (≥130 m from every strip rectangle,
// ≥90 m from every drop pad), stays out of every approach corridor
// (vegetation.js rule), off steep ground (slope ≤0.35), on dry land
// (h ≥2.2) and ≥45 m from the Aurora river polyline. Silhouettes
// keep ≥150 m from strip rectangles.
//
// Village centres are replicated exactly from world.js
// buildVillages (seededRandom(1126), same search + same house-loop
// RNG consumption), so the extra houses densify the real villages
// instead of founding new hamlets. The replicated cottage positions
// are used only as keep-clear points (≥10 m) for the new houses.
//
// Cost discipline: ALL opaque geometry merges into ONE
// vertex-coloured mesh (world.js D-130 pattern) and every lit pane
// / lamp into ONE emissive mesh — 2 draw calls (+1 shadow depth)
// for the whole module, deterministic seeded RNG throughout.
// LOW quality (quality.js isLow) drops the silhouettes' small
// details (cross, ladders, blade tips, bands); towers and houses
// are unchanged.
//
// buildStructuresDense(options) — options { heightAt, islands,
// strips, dropPads, terrainSlopeAt }, the same shape world.js
// passes to buildVegetation. Returns a THREE.Group with
// group.userData.stats = { watchtowers, houses, silhouettes, draws }
// and group.userData.placements for QA clearance checks.

import * as THREE from 'three';
import { isLow } from './quality.js';

// ---------------------------------------------------------------- rng

// Same LCG as world.js / vegetation.js (mulberry-style) so the
// village replication below consumes the identical stream.
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

// ------------------------------------------------------------ palette

// Subset of world.js PALETTE + village wall/roof families, so the
// new structures sit in the same dawn style.
const PALETTE = {
  cream: 0xf2ede4,
  mailRed: 0xd64541,
  lampGlow: 0xffe8c0,
  metal: 0x8a8f94,
  darkGlass: 0x1a2634,
  doorBrown: 0x3a2a20,
  stone: 0x8a8272,
  wood: 0x7a5c44,
  woodDark: 0x5a4230,
};
const WALL_COLORS = [0xf2ede4, 0xe8dcc6, 0xd9e2e6, 0xf2d7b8, 0xe6c9a8, 0xcfe0d8];
const ROOF_COLORS = [0xd64541, 0xb5482f, 0x2e5d6b, 0x3a3f44, 0x8a5a3a];

// Aurora river polyline (world.js river path) — structures keep
// ≥45 m from every segment.
const RIVER_POINTS = [
  { x: 335, z: 30 }, { x: 430, z: 190 }, { x: 500, z: 390 },
  { x: 575, z: 590 }, { x: 660, z: 760 },
];

// Fire-lookout reserve centres (one watchtower each, placed within
// 45 m of the centre at the best passing height/slope spot).
const WATCHTOWER_RESERVES = [
  { name: 'Aurora', x: 300, z: -280 },
  { name: 'Signal Hill', x: -720, z: 3350 },
  { name: 'Gull Rock', x: -2250, z: -2450 },
  { name: 'Brine Cay', x: 2550, z: -1500 },
  { name: 'Lantern Isle', x: 2000, z: 2850 },
];

// ------------------------------------------------------- clearances

// Distance from a point to a strip rectangle (0 when inside) —
// replicated from vegetation.js stripRectDistance / world.js
// stripRectangleDistance.
function stripRectDistance(strip, x, z) {
  const dx = x - strip.centre.x;
  const dz = z - strip.centre.z;
  const along = dx * strip.forward.x + dz * strip.forward.z;
  const across = dx * strip.right.x + dz * strip.right.z;
  const overAlong = Math.max(0, Math.abs(along) - strip.length / 2);
  const overAcross = Math.max(0, Math.abs(across) - strip.width / 2);
  return Math.sqrt(overAlong * overAlong + overAcross * overAcross);
}

// True when (x, z) sits in a strip's approach/departure corridor:
// within ±45 m of the extended centreline, 320 m past each
// threshold. Replicated from vegetation.js inApproachCorridor.
function inApproachCorridor(strip, x, z) {
  const dx = x - strip.centre.x;
  const dz = z - strip.centre.z;
  const along = dx * strip.forward.x + dz * strip.forward.z;
  const across = dx * strip.right.x + dz * strip.right.z;
  return Math.abs(across) < 45 && Math.abs(along) < strip.length / 2 + 320;
}

// True when (x, z) is on a strip rectangle — world.js stripAt,
// needed to replicate the buildVillages house loop faithfully.
function onStrip(strips, x, z) {
  for (const strip of strips) {
    const dx = x - strip.centre.x;
    const dz = z - strip.centre.z;
    const along = dx * strip.forward.x + dz * strip.forward.z;
    const across = dx * strip.right.x + dz * strip.right.z;
    if (Math.abs(along) <= strip.length / 2 && Math.abs(across) <= strip.width / 2) {
      return true;
    }
  }
  return false;
}

// Distance from (x, z) to the river polyline (point-to-segment).
function riverDistance(x, z) {
  let best = Infinity;
  for (let i = 0; i < RIVER_POINTS.length - 1; i++) {
    const a = RIVER_POINTS[i];
    const b = RIVER_POINTS[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const lengthSq = abx * abx + abz * abz;
    let t = lengthSq > 0 ? ((x - a.x) * abx + (z - a.z) * abz) / lengthSq : 0;
    t = Math.min(1, Math.max(0, t));
    const dx = x - (a.x + abx * t);
    const dz = z - (a.z + abz * t);
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < best) best = dist;
  }
  return best;
}

// ------------------------------------------------------------- merge

// Vertex-coloured build-time merge, replicated from world.js
// mergeColoredGeometries (D-130: no BufferGeometryUtils vendored).
// Carries position/normal/color of pre-transformed geometries.
function mergeColoredGeometries(entries) {
  const prepared = [];
  let totalVertices = 0;
  for (let e = 0; e < entries.length; e++) {
    const entry = entries[e];
    const geometry = entry.geometry.index ? entry.geometry.toNonIndexed() : entry.geometry;
    const paint = new THREE.Color(entry.color);
    const vertexTotal = geometry.attributes.position.count;
    const colors = new Float32Array(vertexTotal * 3);
    for (let i = 0; i < vertexTotal; i++) {
      colors[i * 3] = paint.r;
      colors[i * 3 + 1] = paint.g;
      colors[i * 3 + 2] = paint.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    prepared.push(geometry);
    totalVertices += vertexTotal;
  }
  const position = new Float32Array(totalVertices * 3);
  const normal = new Float32Array(totalVertices * 3);
  const color = new Float32Array(totalVertices * 3);
  let writeOffset = 0;
  for (let p = 0; p < prepared.length; p++) {
    const part = prepared[p];
    position.set(part.attributes.position.array, writeOffset * 3);
    normal.set(part.attributes.normal.array, writeOffset * 3);
    color.set(part.attributes.color.array, writeOffset * 3);
    writeOffset += part.attributes.position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return merged;
}

// Plain merge for the emissive lamp/pane stream, replicated from
// world.js mergeStaticGeometries (position/normal/uv).
function mergeStaticGeometries(geometries) {
  const parts = geometries.map((geometry) => (geometry.index ? geometry.toNonIndexed() : geometry));
  let vertexCount = 0;
  for (const part of parts) vertexCount += part.attributes.position.count;
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  let offset = 0;
  for (const part of parts) {
    position.set(part.attributes.position.array, offset * 3);
    normal.set(part.attributes.normal.array, offset * 3);
    if (part.attributes.uv) uv.set(part.attributes.uv.array, offset * 2);
    offset += part.attributes.position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return merged;
}

// Gable roof prism (ridge along X, slopes facing ±Z), replicated
// from world.js buildGableRoofGeometry. Eaves at y=0.
function buildGableRoofGeometry(width, depth, height) {
  const halfW = width / 2;
  const halfD = depth / 2;
  const cornerNW = [-halfW, 0, -halfD];
  const cornerNE = [halfW, 0, -halfD];
  const cornerSE = [halfW, 0, halfD];
  const cornerSW = [-halfW, 0, halfD];
  const ridgeW = [-halfW, height, 0];
  const ridgeE = [halfW, height, 0];
  const triangles = [
    cornerNW, ridgeW, ridgeE, cornerNW, ridgeE, cornerNE, // north slope
    cornerSW, cornerSE, ridgeE, cornerSW, ridgeE, ridgeW, // south slope
    cornerNW, cornerSW, ridgeW, // west gable
    cornerNE, ridgeE, cornerSE, // east gable
  ];
  const positions = new Float32Array(triangles.length * 3);
  for (let i = 0; i < triangles.length; i++) positions.set(triangles[i], i * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// Cylinder beam between two local-space points (legs, bracing).
function beamBetween(ax, ay, az, bx, by, bz, radius, segments) {
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az);
  const length = dir.length();
  const geometry = new THREE.CylinderGeometry(radius, radius, length, segments || 6);
  geometry.translate(0, length / 2, 0);
  const quaternion = new THREE.Quaternion()
    .setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  geometry.applyQuaternion(quaternion);
  geometry.translate(ax, ay, az);
  return geometry;
}

// ------------------------------------------------- village replication

// Replicate world.js buildVillages placement exactly (same seed,
// same centre search, same house-loop RNG consumption) so the
// village centres — and the real cottage positions, used here only
// as keep-clear points — match the shipped world. Returns
// { centres: [{x, z, seaward, islandIndex}], cottages: [{x, z}] }.
function replicateVillages(islands, strips, dropPads, heightAt, terrainSlopeAt) {
  const rng = seededRandom(1126);
  const cottages = [];
  const centres = [];
  function clearOfAirfields(x, z) {
    for (let s = 0; s < strips.length; s++) {
      if (stripRectDistance(strips[s], x, z) < 130) return false;
    }
    for (let p = 0; p < dropPads.length; p++) {
      const dx = x - dropPads[p].x;
      const dz = z - dropPads[p].z;
      if (dx * dx + dz * dz < 90 * 90) return false;
    }
    return true;
  }
  for (let i = 0; i < islands.length; i++) {
    const island = islands[i];
    let centre = null;
    for (let attempt = 0; attempt < 60 && !centre; attempt++) {
      const angle = rng() * Math.PI * 2;
      const dist = island.radius * (0.55 + rng() * 0.3);
      const x = island.centre.x + Math.cos(angle) * dist;
      const z = island.centre.z + Math.sin(angle) * dist;
      const h = heightAt(x, z);
      if (h < 3 || h > 14 || terrainSlopeAt(x, z) > 0.2 || !clearOfAirfields(x, z)) continue;
      centre = { x, z, seaward: angle, islandIndex: i };
    }
    if (!centre) continue;
    centres.push(centre);
    const houseCount = 7 + Math.floor(rng() * 6);
    let placedHere = 0;
    for (let k = 0; k < houseCount * 4 && cottages.length < 120; k++) {
      if (placedHere >= houseCount) break;
      const angle = rng() * Math.PI * 2;
      const dist = 8 + Math.sqrt(rng()) * 48;
      const x = centre.x + Math.cos(angle) * dist;
      const z = centre.z + Math.sin(angle) * dist;
      const h = heightAt(x, z);
      if (h < 2.2 || terrainSlopeAt(x, z) > 0.3 || onStrip(strips, x, z) || !clearOfAirfields(x, z)) continue;
      let crowded = false;
      for (let c = 0; c < cottages.length; c++) {
        const dx = cottages[c].x - x;
        const dz = cottages[c].z - z;
        if (dx * dx + dz * dz < 9 * 9) { crowded = true; break; }
      }
      if (crowded) continue;
      // Consume the same draws buildVillages makes for a placed
      // cottage (yaw jitter + quarter-turn coin, scale, roof, wall)
      // so later islands' centres land on the real villages.
      rng(); // yaw jitter
      rng(); // yaw quarter-turn coin
      rng(); // scale
      rng(); // roof colour
      rng(); // wall colour
      cottages.push({ x, z });
      placedHere++;
    }
  }
  return { centres, cottages };
}

// ------------------------------------------------ structure builders
// Every builder returns { solid: [{geometry, color}], lamp: [geometry] }
// in local space, base at y=0, front facing +Z. placeParts() scales,
// yaws and translates them into the merged streams.

function box(parts, width, height, depth, x, y, z, color) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  parts.solid.push({ geometry, color });
}

// Dark window panes on the ±Z faces of a body (width × depth),
// `floors` rows starting at firstY. One pane (front-left of the
// lowest row) is also pushed as a lit pane into parts.lamp.
function addWindows(parts, width, depth, firstY, floors, perRow, lit) {
  const paneW = 0.7;
  const paneH = 0.8;
  for (let floor = 0; floor < floors; floor++) {
    const y = firstY + floor * 2.4;
    for (const side of [-1, 1]) {
      for (let i = 0; i < perRow; i++) {
        const px = perRow === 1 ? 0 : (i / (perRow - 1) - 0.5) * width * 0.55;
        const pane = new THREE.BoxGeometry(paneW, paneH, 0.08);
        pane.translate(px, y, side * (depth / 2 + 0.02));
        parts.solid.push({ geometry: pane, color: PALETTE.darkGlass });
        if (lit && floor === 0 && side === 1 && i === 0) {
          const litPane = new THREE.BoxGeometry(0.62, 0.72, 0.06);
          litPane.translate(px, y, depth / 2 + 0.07);
          parts.lamp.push(litPane);
        }
      }
    }
  }
}

// Fire-lookout watchtower: 4 tapered legs, ring + X bracing, cabin
// with a dark window band, pyramid roof, emissive lamp at the apex.
// Total height 18–24 m (seeded).
function buildWatchtowerParts(rng, low) {
  const parts = { solid: [], lamp: [] };
  const totalHeight = 18 + rng() * 6;
  const legTopY = totalHeight - 4.6; // cabin floor height
  const baseSpread = 2.3;
  const topSpread = 1.35;
  const woodTones = [0x7a5c44, 0x8a6844, 0x6e5138];
  const wood = woodTones[Math.floor(rng() * woodTones.length)];
  const cabinColors = [PALETTE.cream, 0xe8dcc6, 0xd9e2e6];
  const cabinColor = cabinColors[Math.floor(rng() * cabinColors.length)];
  const roofColor = rng() < 0.6 ? PALETTE.mailRed : 0x3a3f44;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  // Legs (tapered by leaning inward).
  for (const [sx, sz] of corners) {
    parts.solid.push({
      geometry: beamBetween(sx * baseSpread, -0.4, sz * baseSpread,
        sx * topSpread, legTopY, sz * topSpread, 0.17, 6),
      color: wood,
    });
  }
  // Horizontal rings + X-braces between two ring levels.
  const ringLevels = [0.34, 0.67];
  const spreadAt = (t) => baseSpread + (topSpread - baseSpread) * t;
  for (const level of ringLevels) {
    const y = legTopY * level;
    const s = spreadAt(level);
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i];
      const [bx, bz] = corners[(i + 1) % 4];
      parts.solid.push({
        geometry: beamBetween(ax * s, y, az * s, bx * s, y, bz * s, 0.07, 5),
        color: wood,
      });
    }
  }
  const lowY = legTopY * ringLevels[0];
  const highY = legTopY * ringLevels[1];
  const lowS = spreadAt(ringLevels[0]);
  const highS = spreadAt(ringLevels[1]);
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i];
    const [bx, bz] = corners[(i + 1) % 4];
    parts.solid.push({
      geometry: beamBetween(ax * lowS, lowY, az * lowS, bx * highS, highY, bz * highS, 0.055, 5),
      color: wood,
    });
    parts.solid.push({
      geometry: beamBetween(bx * lowS, lowY, bz * lowS, ax * highS, highY, az * highS, 0.055, 5),
      color: wood,
    });
  }
  // Ladder up the +Z face (rails always, rungs HIGH only).
  const ladderZ = (y) => spreadAt(Math.min(1, y / legTopY)) + 0.12;
  for (const side of [-1, 1]) {
    parts.solid.push({
      geometry: beamBetween(side * 0.3, 0, ladderZ(0), side * 0.3, legTopY, ladderZ(legTopY), 0.045, 5),
      color: PALETTE.woodDark,
    });
  }
  if (!low) {
    for (let y = 0.9; y < legTopY - 0.4; y += 0.9) {
      parts.solid.push({
        geometry: beamBetween(-0.3, y, ladderZ(y), 0.3, y, ladderZ(y), 0.035, 4),
        color: PALETTE.woodDark,
      });
    }
  }
  // Platform, cabin, window band, pyramid roof, lamp.
  box(parts, 3.7, 0.25, 3.7, 0, legTopY + 0.12, 0, wood);
  box(parts, 3.2, 2.4, 3.2, 0, legTopY + 1.45, 0, cabinColor);
  box(parts, 3.34, 0.9, 3.34, 0, legTopY + 2.0, 0, PALETTE.darkGlass);
  const roof = new THREE.ConeGeometry(2.95, 1.7, 4);
  roof.rotateY(Math.PI / 4);
  roof.translate(0, legTopY + 2.65 + 0.85, 0);
  parts.solid.push({ geometry: roof, color: roofColor });
  const lamp = new THREE.SphereGeometry(0.22, 8, 6);
  lamp.translate(0, legTopY + 4.65, 0);
  parts.lamp.push(lamp);
  parts.height = totalHeight + 0.3;
  return parts;
}

// Extra village house. form: 0 = two-storey steep roof,
// 1 = L-shape, 2 = long barn-house. Stone plinth, gable roofs,
// chimney, dark panes + one lit pane.
function buildHouseParts(form, rng) {
  const parts = { solid: [], lamp: [] };
  const wallColor = WALL_COLORS[Math.floor(rng() * WALL_COLORS.length)];
  const roofColor = ROOF_COLORS[Math.floor(rng() * ROOF_COLORS.length)];
  if (form === 0) {
    const w = 5.0;
    const d = 4.0;
    const wallH = 5.4;
    box(parts, w + 0.3, 1.1, d + 0.3, 0, 0.1, 0, PALETTE.stone); // plinth
    box(parts, w, wallH, d, 0, wallH / 2, 0, wallColor);
    const roof = buildGableRoofGeometry(w + 0.6, d + 0.6, 2.5);
    roof.translate(0, wallH, 0);
    parts.solid.push({ geometry: roof, color: roofColor });
    box(parts, 0.55, 1.7, 0.55, 1.4, wallH + 1.5, -0.5, PALETTE.stone); // chimney
    addWindows(parts, w, d, 1.9, 2, 2, true);
    box(parts, 0.9, 1.9, 0.1, 0, 0.95, d / 2 + 0.03, PALETTE.doorBrown);
    parts.height = wallH + 2.5;
  } else if (form === 1) {
    const w = 5.2;
    const d = 3.8;
    const wallH = 3.0;
    box(parts, w + 0.3, 1.1, d + 0.3, 0, 0.1, 0, PALETTE.stone);
    box(parts, w, wallH, d, 0, wallH / 2, 0, wallColor);
    const roof = buildGableRoofGeometry(w + 0.6, d + 0.6, 1.9);
    roof.translate(0, wallH, 0);
    parts.solid.push({ geometry: roof, color: roofColor });
    // Wing extending +Z from the east end, ridge along Z.
    const wingW = 3.2;
    const wingD = 4.6;
    const wingH = 2.7;
    const wingX = 1.5;
    const wingZ = 2.4;
    box(parts, wingW + 0.3, 1.1, wingD + 0.3, wingX, 0.1, wingZ, PALETTE.stone);
    box(parts, wingW, wingH, wingD, wingX, wingH / 2, wingZ, wallColor);
    const wingRoof = buildGableRoofGeometry(wingD + 0.6, wingW + 0.6, 1.7);
    wingRoof.rotateY(Math.PI / 2);
    wingRoof.translate(wingX, wingH, wingZ);
    parts.solid.push({ geometry: wingRoof, color: roofColor });
    box(parts, 0.55, 1.6, 0.55, -1.3, wallH + 1.1, -0.4, PALETTE.stone);
    addWindows(parts, w, d, 1.7, 1, 2, true);
    // Wing windows on its ±X faces.
    for (const side of [-1, 1]) {
      const pane = new THREE.BoxGeometry(0.08, 0.8, 0.7);
      pane.translate(wingX + side * (wingW / 2 + 0.02), 1.6, wingZ + 0.8);
      parts.solid.push({ geometry: pane, color: PALETTE.darkGlass });
    }
    box(parts, 0.9, 1.9, 0.1, -0.6, 0.95, d / 2 + 0.03, PALETTE.doorBrown);
    parts.height = wallH + 1.9;
  } else {
    const w = 8.5;
    const d = 4.4;
    const wallH = 3.6;
    box(parts, w + 0.3, 1.1, d + 0.3, 0, 0.1, 0, PALETTE.stone);
    box(parts, w, wallH, d, 0, wallH / 2, 0, wallColor);
    const roof = buildGableRoofGeometry(w + 0.6, d + 0.6, 2.1);
    roof.translate(0, wallH, 0);
    parts.solid.push({ geometry: roof, color: roofColor });
    box(parts, 0.6, 1.8, 0.6, -3.2, wallH + 1.2, -0.5, PALETTE.stone);
    addWindows(parts, w, d, 2.0, 1, 3, true);
    box(parts, 1.9, 2.5, 0.1, 1.8, 1.25, d / 2 + 0.03, PALETTE.doorBrown); // barn door
    box(parts, 0.9, 1.9, 0.1, -1.8, 0.95, d / 2 + 0.03, PALETTE.doorBrown);
    parts.height = wallH + 2.1;
  }
  return parts;
}

// Church with bell tower (~16 m to the cross): nave + steep roof,
// square tower with belfry openings and a pyramid spire.
function buildChurchParts(rng, low) {
  const parts = { solid: [], lamp: [] };
  const wallColor = 0xe8e2d4;
  const roofColor = 0x3a3f44;
  // Nave.
  box(parts, 7.3, 1.1, 4.8, 0.8, 0.1, 0, PALETTE.stone);
  box(parts, 7.0, 4.0, 4.5, 0.8, 2.0, 0, wallColor);
  const naveRoof = buildGableRoofGeometry(7.6, 5.1, 2.6);
  naveRoof.translate(0.8, 4.0, 0);
  parts.solid.push({ geometry: naveRoof, color: roofColor });
  // Tall nave windows, one lit.
  for (const side of [-1, 1]) {
    for (const along of [-1.2, 0.8, 2.8]) {
      const pane = new THREE.BoxGeometry(0.6, 1.9, 0.08);
      pane.translate(along, 2.1, side * (4.5 / 2 + 0.02));
      parts.solid.push({ geometry: pane, color: PALETTE.darkGlass });
    }
  }
  const litPane = new THREE.BoxGeometry(0.52, 1.8, 0.06);
  litPane.translate(0.8, 2.1, 4.5 / 2 + 0.07);
  parts.lamp.push(litPane);
  // Tower at the west end.
  const towerX = -3.6;
  box(parts, 2.9, 1.1, 2.9, towerX, 0.1, 0, PALETTE.stone);
  box(parts, 2.6, 11.0, 2.6, towerX, 5.5, 0, wallColor);
  // Belfry openings on all four faces.
  for (const [ox, oz, rotY] of [[0, 1, 0], [0, -1, 0], [1, 0, Math.PI / 2], [-1, 0, Math.PI / 2]]) {
    const opening = new THREE.BoxGeometry(0.95, 1.7, 0.1);
    opening.rotateY(rotY);
    opening.translate(towerX + ox * 1.32, 9.4, oz * 1.32);
    parts.solid.push({ geometry: opening, color: PALETTE.darkGlass });
  }
  box(parts, 1.0, 2.1, 0.1, towerX, 1.05, 1.33, PALETTE.doorBrown); // west door (south face)
  const spire = new THREE.ConeGeometry(2.25, 4.2, 4);
  spire.rotateY(Math.PI / 4);
  spire.translate(towerX, 11.0 + 2.1, 0);
  parts.solid.push({ geometry: spire, color: roofColor });
  if (!low) {
    // Cross at the spire apex (small detail, HIGH only).
    box(parts, 0.09, 1.1, 0.09, towerX, 15.6, 0, PALETTE.metal);
    box(parts, 0.65, 0.09, 0.09, towerX, 15.75, 0, PALETTE.metal);
  }
  void rng;
  parts.height = low ? 15.2 : 16.2;
  return parts;
}

// Grain silo (~12 m): cylinder + dome + cap; bands and ladder are
// HIGH-only small details.
function buildSiloParts(rng, low) {
  const parts = { solid: [], lamp: [] };
  const bodyColor = rng() < 0.5 ? 0xd8d4c8 : 0xcfd4d6;
  const domeColor = 0xb8b2a4;
  const body = new THREE.CylinderGeometry(2.2, 2.2, 9.0, 12);
  body.translate(0, 4.5, 0);
  parts.solid.push({ geometry: body, color: bodyColor });
  const dome = new THREE.SphereGeometry(2.2, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.translate(0, 9.0, 0);
  parts.solid.push({ geometry: dome, color: domeColor });
  const cap = new THREE.CylinderGeometry(0.5, 0.7, 0.8, 8);
  cap.translate(0, 11.2, 0);
  parts.solid.push({ geometry: cap, color: domeColor });
  if (!low) {
    for (const y of [3.0, 6.0]) {
      const band = new THREE.TorusGeometry(2.22, 0.05, 4, 20);
      band.rotateX(Math.PI / 2);
      band.translate(0, y, 0);
      parts.solid.push({ geometry: band, color: PALETTE.metal });
    }
    for (const side of [-1, 1]) {
      parts.solid.push({
        geometry: beamBetween(side * 0.28, 0.2, 2.28, side * 0.28, 8.8, 2.28, 0.04, 4),
        color: PALETTE.metal,
      });
    }
    for (let y = 0.8; y < 8.8; y += 0.8) {
      parts.solid.push({
        geometry: beamBetween(-0.28, y, 2.28, 0.28, y, 2.28, 0.03, 4),
        color: PALETTE.metal,
      });
    }
  }
  parts.height = 11.6;
  return parts;
}

// Windmill (~14 m to the top blade tip): tapered tower, cap cone,
// static 4-blade rotor in an X pose facing +Z. Blade tip caps are
// HIGH-only small details.
function buildWindmillParts(rng, low) {
  const parts = { solid: [], lamp: [] };
  const tower = new THREE.CylinderGeometry(1.7, 2.7, 10.0, 10);
  tower.translate(0, 5.0, 0);
  parts.solid.push({ geometry: tower, color: PALETTE.cream });
  const cap = new THREE.ConeGeometry(2.3, 2.2, 10);
  cap.translate(0, 11.1, 0);
  parts.solid.push({ geometry: cap, color: PALETTE.mailRed });
  box(parts, 0.95, 1.9, 0.1, 0, 0.95, 2.55, PALETTE.doorBrown);
  const winA = new THREE.BoxGeometry(0.55, 0.7, 0.08);
  winA.translate(0, 5.6, 2.18);
  parts.solid.push({ geometry: winA, color: PALETTE.darkGlass });
  const winB = new THREE.BoxGeometry(0.55, 0.7, 0.08);
  winB.translate(0, 7.8, 1.98);
  parts.solid.push({ geometry: winB, color: PALETTE.darkGlass });
  // Hub + 4 static blades (X pose).
  const hubY = 9.4;
  const hubZ = 2.1;
  const hub = new THREE.CylinderGeometry(0.35, 0.35, 0.9, 8);
  hub.rotateX(Math.PI / 2);
  hub.translate(0, hubY, hubZ);
  parts.solid.push({ geometry: hub, color: PALETTE.woodDark });
  const bladeLength = 5.0;
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2;
    const blade = new THREE.BoxGeometry(0.85, bladeLength, 0.08);
    blade.translate(0, bladeLength / 2 + 0.3, 0);
    blade.rotateZ(angle);
    blade.translate(0, hubY, hubZ + 0.3);
    parts.solid.push({ geometry: blade, color: 0x8a6844 });
    if (!low) {
      const tip = new THREE.BoxGeometry(0.87, 0.8, 0.09);
      tip.translate(0, bladeLength - 0.1, 0);
      tip.rotateZ(angle);
      tip.translate(0, hubY, hubZ + 0.3);
      parts.solid.push({ geometry: tip, color: PALETTE.mailRed });
    }
  }
  void rng;
  parts.height = hubY + bladeLength + 0.3;
  return parts;
}

// Extra water tower (~13 m), same language as world.js
// buildWaterTower: 4 metal legs, cream tank, mail-red cone roof.
function buildWaterTowerParts(rng, low) {
  const parts = { solid: [], lamp: [] };
  const legSpread = 2.2;
  const legTopY = 8.0;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const leg = new THREE.CylinderGeometry(0.18, 0.18, legTopY + 0.4, 6);
    leg.translate(sx * legSpread, legTopY / 2, sz * legSpread);
    parts.solid.push({ geometry: leg, color: PALETTE.metal });
  }
  if (!low) {
    // Mid-height X-braces (HIGH only).
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i];
      const [bx, bz] = corners[(i + 1) % 4];
      parts.solid.push({
        geometry: beamBetween(ax * legSpread, 2.2, az * legSpread,
          bx * legSpread, 5.8, bz * legSpread, 0.05, 4),
        color: PALETTE.metal,
      });
      parts.solid.push({
        geometry: beamBetween(bx * legSpread, 2.2, bz * legSpread,
          ax * legSpread, 5.8, az * legSpread, 0.05, 4),
        color: PALETTE.metal,
      });
    }
  }
  const tank = new THREE.CylinderGeometry(3.4, 3.4, 3.6, 12);
  tank.translate(0, legTopY + 1.8, 0);
  parts.solid.push({ geometry: tank, color: PALETTE.cream });
  const roof = new THREE.ConeGeometry(3.9, 1.6, 12);
  roof.translate(0, legTopY + 3.6 + 0.8, 0);
  parts.solid.push({ geometry: roof, color: PALETTE.mailRed });
  void rng;
  parts.height = legTopY + 5.2;
  return parts;
}

// Scale/yaw/translate local parts into the global merged streams.
function placeParts(target, parts, scale, yaw, x, y, z) {
  for (const part of parts.solid) {
    if (scale !== 1) part.geometry.scale(scale, scale, scale);
    if (yaw) part.geometry.rotateY(yaw);
    part.geometry.translate(x, y, z);
    target.solid.push(part);
  }
  for (const geometry of parts.lamp) {
    if (scale !== 1) geometry.scale(scale, scale, scale);
    if (yaw) geometry.rotateY(yaw);
    geometry.translate(x, y, z);
    target.lamp.push(geometry);
  }
}

// ---------------------------------------------------------------- main

/**
 * Build all dense structures. `options`: { heightAt, islands,
 * strips, dropPads, terrainSlopeAt } — the shape world.js passes
 * to buildVegetation. Returns a THREE.Group (visual only).
 */
export function buildStructuresDense(options) {
  const group = new THREE.Group();
  group.name = 'structures-dense';
  const stats = { watchtowers: 0, houses: 0, silhouettes: 0, draws: 0 };
  const placements = [];
  group.userData.stats = stats;
  group.userData.placements = placements;
  if (!options || typeof options.heightAt !== 'function') return group;
  const heightAt = options.heightAt;
  const terrainSlopeAt = typeof options.terrainSlopeAt === 'function'
    ? options.terrainSlopeAt : () => 0;
  const islands = Array.isArray(options.islands) ? options.islands : [];
  const strips = Array.isArray(options.strips) ? options.strips : [];
  const dropPads = Array.isArray(options.dropPads) ? options.dropPads : [];
  if (islands.length === 0) return group;
  const low = isLow();

  // Shared clearance gate for every structure in this module.
  function passesClearances(x, z, minStripM) {
    const h = heightAt(x, z);
    if (h < 2.2) return false;
    if (terrainSlopeAt(x, z) > 0.35) return false;
    for (const strip of strips) {
      if (stripRectDistance(strip, x, z) < minStripM) return false;
      if (inApproachCorridor(strip, x, z)) return false;
    }
    for (const pad of dropPads) {
      const dx = x - pad.x;
      const dz = z - pad.z;
      if (dx * dx + dz * dz < 90 * 90) return false;
    }
    if (riverDistance(x, z) < 45) return false;
    return true;
  }
  function tooClose(x, z, spots, minDist) {
    for (const spot of spots) {
      const dx = spot.x - x;
      const dz = spot.z - z;
      if (dx * dx + dz * dz < minDist * minDist) return true;
    }
    return false;
  }

  const streams = { solid: [], lamp: [] };
  const bigSpots = []; // towers + silhouettes (houses keep ≥14 m)
  const houseSpots = []; // new houses (≥10 m apart)
  const towerRng = seededRandom(20261201);
  const silhouetteRng = seededRandom(20261202);
  const houseRng = seededRandom(20261203);

  // ------------------------------------------------------ watchtowers
  for (let t = 0; t < WATCHTOWER_RESERVES.length; t++) {
    const reserve = WATCHTOWER_RESERVES[t];
    // Candidates: the centre first, then rings out to 45 m. The
    // centre is used whenever it passes every clearance; only a
    // failing centre nudges outward, to the first ring with a
    // passing candidate (highest ground in that ring wins).
    let best = null;
    const ringRadii = [0, 12, 24, 36, 45];
    for (const radius of ringRadii) {
      if (best) break;
      const steps = radius === 0 ? 1 : 8;
      for (let s = 0; s < steps; s++) {
        const angle = t * 0.7 + (s / steps) * Math.PI * 2;
        const x = reserve.x + Math.cos(angle) * radius;
        const z = reserve.z + Math.sin(angle) * radius;
        if (!passesClearances(x, z, 130)) continue;
        if (tooClose(x, z, bigSpots, 20)) continue;
        const h = heightAt(x, z);
        if (!best || h > best.h) best = { x, z, h, nudge: radius };
      }
    }
    if (!best) continue;
    const parts = buildWatchtowerParts(towerRng, low);
    const yaw = towerRng() * Math.PI * 2;
    placeParts(streams, parts, 1, yaw, best.x, best.h - 0.3, best.z);
    bigSpots.push({ x: best.x, z: best.z });
    placements.push({
      kind: 'watchtower', name: reserve.name, x: best.x, z: best.z,
      groundY: best.h, height: parts.height, nudge: best.nudge,
    });
    stats.watchtowers++;
  }

  // ------------------------------------------- villages (replicated)
  const villages = replicateVillages(islands, strips, dropPads, heightAt, terrainSlopeAt);
  const auroraVillage = villages.centres.find((centre) => centre.islandIndex === 0) || null;
  const auroraIsland = islands[0];
  function islandByName(name, fallbackIndex) {
    return islands.find((island) => island.name === name) || islands[fallbackIndex] || null;
  }

  // ------------------------------------------------------ silhouettes
  // Church in Aurora's village (≥150 m from strips).
  {
    const anchor = auroraVillage || { x: auroraIsland.centre.x, z: auroraIsland.centre.z };
    let spot = null;
    for (let radius = 14; radius <= 70 && !spot; radius += 7) {
      for (let s = 0; s < 12 && !spot; s++) {
        const angle = (s / 12) * Math.PI * 2 + 0.4;
        const x = anchor.x + Math.cos(angle) * radius;
        const z = anchor.z + Math.sin(angle) * radius;
        if (!passesClearances(x, z, 150)) continue;
        if (tooClose(x, z, villages.cottages, 10)) continue;
        if (tooClose(x, z, bigSpots, 20)) continue;
        spot = { x, z, h: heightAt(x, z) };
      }
    }
    if (spot) {
      const parts = buildChurchParts(silhouetteRng, low);
      const yaw = silhouetteRng() * Math.PI * 2;
      placeParts(streams, parts, 1, yaw, spot.x, spot.h - 0.3, spot.z);
      bigSpots.push({ x: spot.x, z: spot.z });
      placements.push({
        kind: 'church', name: 'Aurora church', x: spot.x, z: spot.z,
        groundY: spot.h, height: parts.height, nudge: 0,
      });
      stats.silhouettes++;
    }
  }
  // Two grain silos near Aurora's fields (≥150 m from strips).
  {
    const anchor = auroraVillage || { x: auroraIsland.centre.x, z: auroraIsland.centre.z };
    const siloSpots = [];
    for (let attempt = 0; attempt < 400 && siloSpots.length < 2; attempt++) {
      const angle = silhouetteRng() * Math.PI * 2;
      const dist = 90 + silhouetteRng() * 130;
      const x = anchor.x + Math.cos(angle) * dist;
      const z = anchor.z + Math.sin(angle) * dist;
      if (!passesClearances(x, z, 150)) continue;
      if (tooClose(x, z, siloSpots, 25)) continue;
      if (tooClose(x, z, bigSpots, 20)) continue;
      siloSpots.push({ x, z, h: heightAt(x, z) });
    }
    for (const spot of siloSpots) {
      const parts = buildSiloParts(silhouetteRng, low);
      const yaw = silhouetteRng() * Math.PI * 2;
      placeParts(streams, parts, 1, yaw, spot.x, spot.h - 0.3, spot.z);
      bigSpots.push({ x: spot.x, z: spot.z });
      placements.push({
        kind: 'silo', name: 'Aurora silo', x: spot.x, z: spot.z,
        groundY: spot.h, height: parts.height, nudge: 0,
      });
      stats.silhouettes++;
    }
  }
  // Windmill on Brine Cay, falling back to Lantern Isle (highest
  // passing ground wins, ≥150 m from strips).
  {
    let spot = null;
    for (const island of [islandByName('Brine Cay', 1), islandByName('Lantern Isle', 3)]) {
      if (!island || spot) continue;
      for (let attempt = 0; attempt < 300; attempt++) {
        const angle = silhouetteRng() * Math.PI * 2;
        const dist = Math.sqrt(silhouetteRng()) * island.radius * 0.55;
        const x = island.centre.x + Math.cos(angle) * dist;
        const z = island.centre.z + Math.sin(angle) * dist;
        if (!passesClearances(x, z, 150)) continue;
        if (tooClose(x, z, bigSpots, 20)) continue;
        const h = heightAt(x, z);
        if (!spot || h > spot.h) spot = { x, z, h, islandName: island.name };
      }
    }
    if (spot) {
      const parts = buildWindmillParts(silhouetteRng, low);
      const yaw = silhouetteRng() * Math.PI * 2;
      placeParts(streams, parts, 1, yaw, spot.x, spot.h - 0.3, spot.z);
      bigSpots.push({ x: spot.x, z: spot.z });
      placements.push({
        kind: 'windmill', name: spot.islandName + ' windmill', x: spot.x, z: spot.z,
        groundY: spot.h, height: parts.height, nudge: 0,
      });
      stats.silhouettes++;
    }
  }
  // Extra water tower on Gull Rock (highest passing ground,
  // ≥150 m from strips).
  {
    const island = islandByName('Gull Rock', 2);
    let spot = null;
    if (island) {
      for (let attempt = 0; attempt < 300; attempt++) {
        const angle = silhouetteRng() * Math.PI * 2;
        const dist = Math.sqrt(silhouetteRng()) * island.radius * 0.55;
        const x = island.centre.x + Math.cos(angle) * dist;
        const z = island.centre.z + Math.sin(angle) * dist;
        if (!passesClearances(x, z, 150)) continue;
        if (tooClose(x, z, bigSpots, 20)) continue;
        const h = heightAt(x, z);
        if (!spot || h > spot.h) spot = { x, z, h };
      }
    }
    if (spot) {
      const parts = buildWaterTowerParts(silhouetteRng, low);
      const yaw = silhouetteRng() * Math.PI * 2;
      placeParts(streams, parts, 1, yaw, spot.x, spot.h - 0.3, spot.z);
      bigSpots.push({ x: spot.x, z: spot.z });
      placements.push({
        kind: 'water-tower', name: 'Gull Rock water tower', x: spot.x, z: spot.z,
        groundY: spot.h, height: parts.height, nudge: 0,
      });
      stats.silhouettes++;
    }
  }

  // ---------------------------------------------- village densification
  for (const centre of villages.centres) {
    const target = 6 + Math.floor(houseRng() * 5); // 6–10 extra houses
    let placed = 0;
    for (let attempt = 0; attempt < 120 && placed < target; attempt++) {
      const angle = houseRng() * Math.PI * 2;
      const dist = 12 + Math.sqrt(houseRng()) * 58; // within r=70
      const x = centre.x + Math.cos(angle) * dist;
      const z = centre.z + Math.sin(angle) * dist;
      if (!passesClearances(x, z, 130)) continue;
      if (tooClose(x, z, villages.cottages, 10)) continue;
      if (tooClose(x, z, houseSpots, 10)) continue;
      if (tooClose(x, z, bigSpots, 14)) continue;
      const h = heightAt(x, z);
      const form = Math.floor(houseRng() * 3);
      const parts = buildHouseParts(form, houseRng);
      // Ridge lines roughly face the sea, like the real cottages.
      const yaw = -centre.seaward + (houseRng() - 0.5) * 0.9 + (houseRng() < 0.5 ? 0 : Math.PI / 2);
      const scale = 0.9 + houseRng() * 0.35;
      placeParts(streams, parts, scale, yaw, x, h - 0.3, z);
      houseSpots.push({ x, z });
      placements.push({
        kind: 'house', name: 'village house', x, z,
        groundY: h, height: parts.height * scale, nudge: 0,
      });
      placed++;
      stats.houses++;
    }
  }

  // ------------------------------------------------------------- meshes
  const solidMaterial = new THREE.MeshStandardMaterial({
    flatShading: true,
    color: 0xffffff, vertexColors: true, roughness: 0.85, metalness: 0.05,
  });
  const lampMaterial = new THREE.MeshStandardMaterial({
    roughness: 0.5,
    color: 0x332200, emissive: PALETTE.lampGlow, emissiveIntensity: 1.6,
  });
  if (streams.solid.length > 0) {
    const geometry = mergeColoredGeometries(streams.solid);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, solidMaterial);
    mesh.name = 'structures-dense-solid';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    stats.draws++;
  }
  if (streams.lamp.length > 0) {
    const geometry = mergeStaticGeometries(streams.lamp);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, lampMaterial);
    mesh.name = 'structures-dense-lamps';
    group.add(mesh);
    stats.draws++;
  }
  return group;
}
