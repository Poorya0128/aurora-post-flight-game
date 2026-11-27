// vegetation.js — foliage visual upgrade (trees, grass, wildflowers,
// wheat, bushes, rocks) matched to the user's environment references
// (env4 hill: layered conifers + round deciduous in varied greens /
// yellows / warm autumn tones; env7 barn: grass + golden wheat
// foreground; env8 water tower: white/yellow/purple wildflowers;
// env9 field: wheat patches, lupine spikes, rocks).
//
// Visual only: nothing here is collidable, scored or read by
// flight.js — existing obstacle trees (world.js buildTrees) are never
// moved, and no new obstacle is created. buildVegetation(options)
// keeps its signature and options contract; the return gains an
// optional `update(seconds)` clock hook (see wind note below).
//
// Cost discipline: TWELVE InstancedMesh draws total — six tree
// kinds (conifers, deciduous, tall pines, spruces, birches,
// poplars), bushes, rocks, grass, round wildflowers, lupine, wheat
// (plus 6 shadow-depth draws for the tree casters). No per-instance
// CPU work after build: wind sway + distance fade run in the vertex
// shader (onBeforeCompile) off ONE shared time uniform. The uniform
// is self-driven from an onBeforeRender hook (one float write per
// frame, no world.js wiring needed); a coordinator may instead call
// the returned update(seconds) / updateVegetationTime(seconds) with
// sim time — the first external call disables the self-drive.
// LOW quality (quality.js isLow) halves every instance count
// (trees, bushes, rocks and ground cover alike).
//
// Placement rules: clustered stands (never uniform scatter), trees
// ≥40 m from every strip rectangle and out of the approach corridor
// (strip axis ±45 m across, 320 m past each threshold), ≥50 m from
// drop pads, ≥7 m from existing obstacle trees and each other —
// plus new tree keep-clear zones: ≥45 m from the Aurora river
// polyline, ≥55 m from watchtower centres, ≥60 m from village
// centres (replicated exactly from world.js buildVillages). Two
// deliberate exceptions, both visual only: tall-pine lines along
// runway edges at 14–26 m rect distance (corridor extensions past
// thresholds still excluded), and dense stands 8–30 m either side
// of the replicated road centrelines so roads run through forest.
// Bushes ≥14 m / grass ≥8 m / flowers ≥9 m / wheat ≥24 m / rocks
// ≥12 m from strip rectangles. Conifer family dominates hillsides,
// deciduous family favours lowland groves. Sunset rim feel comes
// from a low warm emissive tint on the foliage materials.
//
// LOD choice: single mid-poly geometry per tree kind (~104 tris
// conifer, ~184 tris deciduous) with distance-faded SWAY (not fade-
// out) — trees are landmarks read from the air at kilometres, so
// they never shrink away; ground cover (grass/flowers/wheat) scales
// to zero in the vertex shader past its fade band instead.

import * as THREE from 'three';
import { isLow } from './quality.js';

// ---------------------------------------------------------------- rng

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

// ------------------------------------------------------------ wind/time

// One shared time uniform for every wind material in this module.
const vegTimeUniform = { value: 0 };
let externalClock = false;

/** Coordinator hook: drive wind sway from sim time (seconds). The
 *  first call disables the built-in performance.now() self-drive. */
export function updateVegetationTime(seconds) {
  externalClock = true;
  vegTimeUniform.value = seconds;
}

// Vertex-shader wind: sway offset weighted by local height² and
// distance-faded (1/(1+d·k)), phase hashed from the instance world
// position so neighbours don't move in lockstep. Optional distance
// fade scales the whole instance to zero at its base (ground cover).
// wind = { amp, freq, heightRef, fadeStart, fadeEnd (0 = no fade), key }
function applyWind(material, wind) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uVegTime = vegTimeUniform;
    const fadeLine = wind.fadeEnd > 0
      ? '  transformed *= 1.0 - smoothstep(' + wind.fadeStart.toFixed(1)
        + ', ' + wind.fadeEnd.toFixed(1) + ', vegDist);'
      : '';
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uVegTime;')
      .replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          '#ifdef USE_INSTANCING',
          '  vec3 vegInstPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);',
          '#else',
          '  vec3 vegInstPos = vec3(0.0);',
          '#endif',
          '  vec3 vegWorldPos = (modelMatrix * vec4(vegInstPos, 1.0)).xyz;',
          '  float vegDist = distance(cameraPosition, vegWorldPos);',
          '  float vegH = clamp(position.y / ' + wind.heightRef.toFixed(3) + ', 0.0, 1.0);',
          '  float vegPhase = vegWorldPos.x * 0.13 + vegWorldPos.z * 0.17;',
          '  float vegSway = sin(uVegTime * ' + wind.freq.toFixed(3) + ' + vegPhase)',
          '    + 0.5 * sin(uVegTime * ' + (wind.freq * 1.73).toFixed(3) + ' + vegPhase * 1.31);',
          '  float vegSwayFade = 1.0 / (1.0 + vegDist * 0.0035);',
          '  float vegAmp = ' + wind.amp.toFixed(4) + ' * vegH * vegH * vegSwayFade;',
          '  transformed.x += vegSway * vegAmp;',
          '  transformed.z += vegSway * vegAmp * 0.62;',
          fadeLine,
        ].join('\n'));
  };
  material.customProgramCacheKey = () => 'veg-wind-' + wind.key;
  return material;
}

const CONIFER_WIND = { amp: 0.22, freq: 0.9, heightRef: 7.65, fadeStart: 0, fadeEnd: 0, key: 'conifer' };
const DECIDUOUS_WIND = { amp: 0.18, freq: 1.0, heightRef: 5.71, fadeStart: 0, fadeEnd: 0, key: 'deciduous' };
const BUSH_WIND = { amp: 0.04, freq: 1.2, heightRef: 1.3, fadeStart: 0, fadeEnd: 0, key: 'bush' };
const GRASS_WIND = { amp: 0.13, freq: 1.6, heightRef: 0.95, fadeStart: 150, fadeEnd: 280, key: 'grass' };
const FLOWER_WIND = { amp: 0.06, freq: 1.8, heightRef: 0.6, fadeStart: 120, fadeEnd: 220, key: 'flower' };
const LUPINE_WIND = { amp: 0.07, freq: 1.5, heightRef: 0.85, fadeStart: 140, fadeEnd: 240, key: 'lupine' };
const WHEAT_WIND = { amp: 0.11, freq: 1.3, heightRef: 1.15, fadeStart: 200, fadeEnd: 360, key: 'wheat' };
const TALL_PINE_WIND = { amp: 0.26, freq: 0.8, heightRef: 12.6, fadeStart: 0, fadeEnd: 0, key: 'tallpine' };
const SPRUCE_WIND = { amp: 0.16, freq: 0.95, heightRef: 8.3, fadeStart: 0, fadeEnd: 0, key: 'spruce' };
const BIRCH_WIND = { amp: 0.2, freq: 1.1, heightRef: 7.0, fadeStart: 0, fadeEnd: 0, key: 'birch' };
const POPLAR_WIND = { amp: 0.24, freq: 0.9, heightRef: 8.9, fadeStart: 0, fadeEnd: 0, key: 'poplar' };

// ------------------------------------------------------- canvas textures

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
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  } catch (error) {
    return null;
  }
}

// Leaf-speckle skin for the bush blobs: layered green dabs over a deep
// base so a smooth blob reads as foliage, not a billiard ball.
function buildBushTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const rng = seededRandom(7717);
    ctx.fillStyle = '#2c4a26';
    ctx.fillRect(0, 0, w, h);
    const shades = ['#3d6633', '#4e7a3a', '#5d8a44', '#6b9a4a', '#87a856', '#a9b84e'];
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = shades[Math.floor(rng() * shades.length)];
      ctx.globalAlpha = 0.35 + rng() * 0.5;
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 2 + rng() * 5, 1.5 + rng() * 3, rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Warm sun-kissed flecks (dawn rim baked into the texture).
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = 'rgba(255,190,120,0.35)';
      ctx.fillRect(rng() * w, rng() * h * 0.5, 2, 2);
    }
  });
}

// Grass blades for the cross-quads: tapered strokes fanning from the
// base, lush green at the root brightening to yellow-green at the
// tips (env9 ground cover), only a few straw blades, a few seed
// heads dotted on top. Transparent background + alphaTest cutout.
function buildGrassTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const rng = seededRandom(9021);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    for (let i = 0; i < 76; i++) {
      const baseX = 8 + rng() * (w - 16);
      const lean = (rng() - 0.5) * 48;
      const topY = 4 + rng() * 50;
      const warm = rng();
      const gradient = ctx.createLinearGradient(0, h, 0, topY);
      gradient.addColorStop(0, '#3d6b34');
      gradient.addColorStop(0.7, warm > 0.8 ? '#8a9a4a' : '#6aa84e');
      gradient.addColorStop(1, warm > 0.8 ? '#d0bc7a' : '#9fc46a');
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 2.0 + rng() * 2.0;
      ctx.beginPath();
      ctx.moveTo(baseX, h);
      ctx.quadraticCurveTo(baseX + lean * 0.3, (h + topY) / 2, baseX + lean, topY);
      ctx.stroke();
      if (rng() > 0.84) { // seed head
        ctx.fillStyle = warm > 0.8 ? '#d8c078' : '#b8c95e';
        ctx.beginPath();
        ctx.ellipse(baseX + lean, topY, 2.2, 4.2, lean * 0.02, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
}

// Round wildflowers (env8 foreground): green stems + white daisy heads
// with yellow centres. Instance colour tints the whole card with pale
// variants (white / pale yellow / pale pink / pale violet), so the
// greens shift only slightly.
function buildFlowerTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const rng = seededRandom(5511);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    // Grassy base so the card never floats.
    for (let i = 0; i < 26; i++) {
      const baseX = 6 + rng() * (w - 12);
      const lean = (rng() - 0.5) * 30;
      const topY = 40 + rng() * 44;
      ctx.strokeStyle = rng() > 0.5 ? '#4e7a3a' : '#5d8a44';
      ctx.lineWidth = 2 + rng() * 1.6;
      ctx.beginPath();
      ctx.moveTo(baseX, h);
      ctx.quadraticCurveTo(baseX + lean * 0.3, (h + topY) / 2, baseX + lean, topY);
      ctx.stroke();
    }
    for (let i = 0; i < 15; i++) {
      const baseX = 10 + rng() * (w - 20);
      const lean = (rng() - 0.5) * 34;
      const topY = 10 + rng() * 52;
      const headX = baseX + lean;
      ctx.strokeStyle = '#4e7a3a';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(baseX, h);
      ctx.quadraticCurveTo(baseX + lean * 0.3, (h + topY) / 2, headX, topY + 4);
      ctx.stroke();
      // Petals: 6 white ellipses around a yellow centre.
      const r = 4.5 + rng() * 3;
      ctx.fillStyle = '#f7f3e8';
      for (let p = 0; p < 6; p++) {
        const a = (p / 6) * Math.PI * 2 + rng() * 0.4;
        ctx.beginPath();
        ctx.ellipse(headX + Math.cos(a) * r * 0.75, topY + Math.sin(a) * r * 0.75,
          r * 0.62, r * 0.34, a, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#e8b53a';
      ctx.beginPath();
      ctx.arc(headX, topY, r * 0.36, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

// Lupine spikes (env9): tall flower spikes of stacked purple/blue
// buds tapering to a tip, over a small green leafy base. Drawn
// saturated; instance colour varies brightness only.
function buildLupineTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const rng = seededRandom(6633);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    // Leafy base.
    for (let i = 0; i < 18; i++) {
      const baseX = 8 + rng() * (w - 16);
      const lean = (rng() - 0.5) * 36;
      const topY = 66 + rng() * 30;
      ctx.strokeStyle = rng() > 0.5 ? '#4e7a3a' : '#6b9a4a';
      ctx.lineWidth = 2.4 + rng() * 1.6;
      ctx.beginPath();
      ctx.moveTo(baseX, h);
      ctx.quadraticCurveTo(baseX + lean * 0.3, (h + topY) / 2, baseX + lean, topY);
      ctx.stroke();
    }
    const spikes = 6;
    for (let s = 0; s < spikes; s++) {
      const baseX = 14 + (s / (spikes - 1)) * (w - 28) + (rng() - 0.5) * 8;
      const lean = (rng() - 0.5) * 16;
      const tipY = 6 + rng() * 26;
      const baseY = 92 + rng() * 18;
      ctx.strokeStyle = '#4e7a3a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(baseX, h);
      ctx.lineTo(baseX + lean * 0.5, baseY);
      ctx.stroke();
      // Buds: pairs of dots shrinking toward the tip.
      const buds = 11;
      for (let b = 0; b < buds; b++) {
        const t = b / (buds - 1);
        const y = baseY + (tipY - baseY) * t;
        const x = baseX + lean * 0.5 + lean * 0.5 * t;
        const r = 4.6 * (1 - t * 0.72) + rng() * 0.8;
        ctx.fillStyle = t > 0.75 ? '#9a8ae8' : (rng() > 0.4 ? '#6a5acd' : '#7a6ae0');
        ctx.beginPath();
        ctx.arc(x - r * 0.55, y, r * 0.72, 0, Math.PI * 2);
        ctx.arc(x + r * 0.55, y - r * 0.4, r * 0.72, 0, Math.PI * 2);
        ctx.arc(x, y - r * 0.5, r * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
}

// Golden wheat (env7/env9): straw stalks with elongated grain heads
// along the top third. Instance colour varies the gold brightness.
function buildWheatTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const rng = seededRandom(7744);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    for (let i = 0; i < 30; i++) {
      const baseX = 6 + rng() * (w - 12);
      const lean = (rng() - 0.5) * 26;
      const topY = 4 + rng() * 30;
      const headBaseY = topY + 26 + rng() * 14;
      const xAt = (y) => baseX + lean * ((h - y) / (h - topY));
      ctx.strokeStyle = rng() > 0.5 ? '#b89a4e' : '#c9a95e';
      ctx.lineWidth = 1.8 + rng() * 1.2;
      ctx.beginPath();
      ctx.moveTo(baseX, h);
      ctx.quadraticCurveTo(baseX + lean * 0.3, (h + topY) / 2, baseX + lean, topY);
      ctx.stroke();
      // Grains: paired ovals angled up the head.
      const grains = 7;
      for (let g = 0; g < grains; g++) {
        const y = headBaseY + (topY - headBaseY) * (g / (grains - 1));
        const x = xAt(y);
        ctx.fillStyle = rng() > 0.5 ? '#e0bd6a' : '#d4af58';
        ctx.beginPath();
        ctx.ellipse(x - 3, y, 2.4, 5, -0.5, 0, Math.PI * 2);
        ctx.ellipse(x + 3, y - 2, 2.4, 5, 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // Awns (bristles) at the tip.
      ctx.strokeStyle = 'rgba(224,189,106,0.8)';
      ctx.lineWidth = 1;
      for (let a = 0; a < 3; a++) {
        ctx.beginPath();
        ctx.moveTo(baseX + lean, topY + 2);
        ctx.lineTo(baseX + lean + (a - 1) * 5, topY - 6);
        ctx.stroke();
      }
    }
  });
}

// ------------------------------------------------------------- geometry

// Build-time merge of pre-transformed geometries into one non-indexed
// stream (same discipline as world.js D-130; duplicated here so this
// module stays self-contained). Carries position/normal/uv + optional
// per-part baked colour.
function mergeParts(parts) {
  const prepared = parts.map((part) => {
    const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry;
    if (part.color !== undefined) {
      const color = new THREE.Color(part.color);
      const count = geometry.attributes.position.count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    return geometry;
  });
  let vertexCount = 0;
  for (const part of prepared) vertexCount += part.attributes.position.count;
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const hasColor = prepared.some((part) => part.attributes.color);
  const color = hasColor ? new Float32Array(vertexCount * 3) : null;
  let offset = 0;
  for (const part of prepared) {
    position.set(part.attributes.position.array, offset * 3);
    normal.set(part.attributes.normal.array, offset * 3);
    if (part.attributes.uv) uv.set(part.attributes.uv.array, offset * 2);
    if (color && part.attributes.color) color.set(part.attributes.color.array, offset * 3);
    offset += part.attributes.position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (color) merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return merged;
}

// Jitter every vertex radially by a seeded factor (organic silhouette
// instead of a perfect primitive). Indexed geometries share vertices,
// so the surface stays watertight.
function jitterGeometry(geometry, rng, min, max) {
  const positions = geometry.attributes.position;
  const vertex = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    vertex.fromBufferAttribute(positions, i);
    vertex.multiplyScalar(min + rng() * (max - min));
    positions.setXYZ(i, vertex.x, vertex.y, vertex.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// One cone tier with a drooping, ragged rim: base-ring vertices sink
// and flare unevenly and the apex leans a touch, so stacked tiers
// read as layered skirts (env7/env8 pines) instead of party hats.
function buildTier(radius, height, centreY, rng) {
  const cone = new THREE.ConeGeometry(radius, height, 8);
  const positions = cone.attributes.position;
  const baseY = -height / 2;
  const topY = height / 2;
  const apexOffX = (rng() - 0.5) * 0.22;
  const apexOffZ = (rng() - 0.5) * 0.22;
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i);
    const x = positions.getX(i);
    const z = positions.getZ(i);
    if (Math.abs(y - baseY) < 0.001) {
      if (x * x + z * z > 0.01) { // rim vertex, not the cap centre
        const flare = 1.02 + rng() * 0.16;
        positions.setXYZ(i,
          x * flare + (rng() - 0.5) * 0.12,
          y - (0.16 + rng() * 0.36),
          z * flare + (rng() - 0.5) * 0.12);
      }
    } else if (Math.abs(y - topY) < 0.001) {
      positions.setXYZ(i, x + apexOffX, y, z + apexOffZ);
    }
  }
  cone.computeVertexNormals();
  cone.rotateY(rng() * Math.PI);
  cone.translate(0, centreY, 0);
  return cone;
}

export const CONIFER_HEIGHT = 7.65;
export const DECIDUOUS_HEIGHT = 5.71;

/**
 * Layered conifer as ONE merged vertex-coloured geometry: visible
 * tapered trunk + five drooping foliage tiers (wide skirt → top
 * spike), mid-green at the base warming to yellow-green at the tip
 * (env4 sunlit pines). ~7.65 m tall at scale 1 (CONIFER_HEIGHT),
 * base at y=0. Exported so the coordinator can restyle world.js
 * obstacle trees with the same look — pair with createTreeMaterial();
 * obstacle trees must keep uniform scale so drawn height matches
 * flight.js strike height (scale = obstacleHeight / CONIFER_HEIGHT).
 */
export function buildConiferGeometry() {
  const rng = seededRandom(3301);
  const trunk = new THREE.CylinderGeometry(0.13, 0.3, 2.4, 6);
  trunk.translate(0, 1.2, 0);
  const geometry = mergeParts([
    { geometry: trunk, color: 0x6b5040 },
    { geometry: buildTier(2.15, 2.2, 2.95, rng), color: 0x3a6b2f },
    { geometry: buildTier(1.85, 2.0, 4.05, rng), color: 0x4a7f36 },
    { geometry: buildTier(1.5, 1.9, 5.05, rng), color: 0x5a9440 },
    { geometry: buildTier(1.1, 1.7, 5.95, rng), color: 0x6da84a },
    { geometry: buildTier(0.65, 1.7, 6.8, rng), color: 0x7db85a },
  ]);
  geometry.userData = { kind: 'conifer', height: CONIFER_HEIGHT };
  return geometry;
}

/**
 * Round deciduous tree as ONE merged vertex-coloured geometry:
 * visible trunk + three angled branches + five jittered foliage
 * clumps. Foliage vertex colours are deliberately pale (near-white
 * greens) so the per-instance colour carries the hue — greens,
 * yellow-greens and warm autumn tones all come from instanceColor.
 * ~5.71 m tall at scale 1 (DECIDUOUS_HEIGHT), base at y=0.
 */
export function buildDeciduousGeometry() {
  const rng = seededRandom(3302);
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.15, 0.3, 2.8, 6);
  trunk.translate(0, 1.4, 0);
  parts.push({ geometry: trunk, color: 0x8a6844 });
  for (let i = 0; i < 3; i++) {
    const branch = new THREE.CylinderGeometry(0.06, 0.12, 1.7, 5);
    branch.translate(0, 0.85, 0);
    branch.rotateZ(0.55 + rng() * 0.25);
    branch.rotateY((i / 3) * Math.PI * 2 + rng() * 0.8);
    branch.translate(0, 2.35, 0);
    parts.push({ geometry: branch, color: 0x8a6844 });
  }
  const clumpColours = [0xd6e8b0, 0xc8e0a0, 0xe2e8a8, 0xd0e6a0, 0xe8e0a0];
  const clumps = [
    { x: 0, y: 4.3, z: 0, r: 1.5 },
    { x: 1.05, y: 3.7, z: 0.35, r: 1.05 },
    { x: -1.0, y: 3.85, z: -0.3, r: 1.1 },
    { x: 0.3, y: 3.55, z: -1.0, r: 0.95 },
    { x: -0.35, y: 3.6, z: 1.0, r: 1.0 },
  ];
  for (let i = 0; i < clumps.length; i++) {
    const clump = clumps[i];
    const blob = jitterGeometry(new THREE.IcosahedronGeometry(clump.r, 0), rng, 0.84, 1.16);
    blob.translate(clump.x, clump.y, clump.z);
    parts.push({ geometry: blob, color: clumpColours[i] });
  }
  const geometry = mergeParts(parts);
  geometry.userData = { kind: 'deciduous', height: DECIDUOUS_HEIGHT };
  return geometry;
}

export const TALL_PINE_HEIGHT = 12.6;
export const SPRUCE_HEIGHT = 8.3;
export const BIRCH_HEIGHT = 7.0;
export const POPLAR_HEIGHT = 8.9;

/**
 * Tall pine as ONE merged vertex-coloured geometry: slim reddish
 * trunk rising ~6.5 m before a high, layered canopy of five drooping
 * tiers. ~12.6 m at scale 1 (TALL_PINE_HEIGHT), base at y=0. Used
 * for the runway-edge lines and mixed into conifer stands.
 */
export function buildTallPineGeometry() {
  const rng = seededRandom(3303);
  const trunk = new THREE.CylinderGeometry(0.16, 0.34, 6.5, 6);
  trunk.translate(0, 3.25, 0);
  const geometry = mergeParts([
    { geometry: trunk, color: 0x7a5a44 },
    { geometry: buildTier(1.9, 2.0, 7.6, rng), color: 0x3f7031 },
    { geometry: buildTier(1.6, 1.9, 8.9, rng), color: 0x4f8438 },
    { geometry: buildTier(1.25, 1.8, 10.0, rng), color: 0x619a42 },
    { geometry: buildTier(0.85, 1.7, 11.0, rng), color: 0x74b04e },
    { geometry: buildTier(0.45, 1.5, 11.9, rng), color: 0x86c25c },
  ]);
  geometry.userData = { kind: 'tallPine', height: TALL_PINE_HEIGHT };
  return geometry;
}

/**
 * Spruce as ONE merged vertex-coloured geometry: short trunk and six
 * narrow, dark tiers stacked tight — the darkest, slimmest conifer
 * silhouette. ~8.3 m at scale 1 (SPRUCE_HEIGHT), base at y=0.
 */
export function buildSpruceGeometry() {
  const rng = seededRandom(3304);
  const trunk = new THREE.CylinderGeometry(0.14, 0.3, 2.2, 6);
  trunk.translate(0, 1.1, 0);
  const geometry = mergeParts([
    { geometry: trunk, color: 0x5a4230 },
    { geometry: buildTier(1.5, 1.8, 2.6, rng), color: 0x2c5a2e },
    { geometry: buildTier(1.3, 1.7, 3.8, rng), color: 0x33663a },
    { geometry: buildTier(1.05, 1.6, 4.9, rng), color: 0x3a7240 },
    { geometry: buildTier(0.8, 1.5, 5.9, rng), color: 0x427e46 },
    { geometry: buildTier(0.55, 1.4, 6.8, rng), color: 0x4a8a4c },
    { geometry: buildTier(0.32, 1.3, 7.6, rng), color: 0x529652 },
  ]);
  geometry.userData = { kind: 'spruce', height: SPRUCE_HEIGHT };
  return geometry;
}

/**
 * Birch as ONE merged vertex-coloured geometry: pale near-white
 * trunk and branches under a light, airy rounded crown of three
 * jittered clumps. Foliage vertex colours are pale so instance
 * colour carries the light-green hue. ~7.0 m at scale 1
 * (BIRCH_HEIGHT), base at y=0.
 */
export function buildBirchGeometry() {
  const rng = seededRandom(3305);
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.11, 0.22, 3.6, 6);
  trunk.translate(0, 1.8, 0);
  parts.push({ geometry: trunk, color: 0xe8e2d4 });
  for (let i = 0; i < 2; i++) {
    const branch = new THREE.CylinderGeometry(0.05, 0.1, 1.5, 5);
    branch.translate(0, 0.75, 0);
    branch.rotateZ(0.5 + rng() * 0.25);
    branch.rotateY(i * Math.PI + rng() * 0.8);
    branch.translate(0, 3.1, 0);
    parts.push({ geometry: branch, color: 0xe8e2d4 });
  }
  const clumps = [
    { x: 0, y: 5.4, z: 0, r: 1.25 },
    { x: 0.85, y: 4.7, z: 0.3, r: 0.95 },
    { x: -0.8, y: 4.85, z: -0.25, r: 0.9 },
  ];
  const clumpColours = [0xeaf2c0, 0xe2eeb4, 0xf0f0b8];
  for (let i = 0; i < clumps.length; i++) {
    const clump = clumps[i];
    const blob = jitterGeometry(new THREE.IcosahedronGeometry(clump.r, 0), rng, 0.85, 1.15);
    blob.translate(clump.x, clump.y, clump.z);
    parts.push({ geometry: blob, color: clumpColours[i] });
  }
  const geometry = mergeParts(parts);
  geometry.userData = { kind: 'birch', height: BIRCH_HEIGHT };
  return geometry;
}

/**
 * Poplar as ONE merged vertex-coloured geometry: tall columnar
 * crown of three vertically-stretched jittered blobs over a slim
 * trunk — reads as a green exclamation mark from the air. Pale
 * vertex colours; instance colour carries the hue. ~8.9 m at
 * scale 1 (POPLAR_HEIGHT), base at y=0.
 */
export function buildPoplarGeometry() {
  const rng = seededRandom(3306);
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.13, 0.26, 3.0, 6);
  trunk.translate(0, 1.5, 0);
  parts.push({ geometry: trunk, color: 0x6b5040 });
  const blobs = [
    { y: 4.2, r: 1.05, color: 0xd8e8a8 },
    { y: 6.0, r: 0.9, color: 0xd0e4a0 },
    { y: 7.7, r: 0.7, color: 0xe0ecac },
  ];
  for (const blobDef of blobs) {
    const blob = jitterGeometry(new THREE.IcosahedronGeometry(blobDef.r, 0), rng, 0.86, 1.14);
    blob.scale(0.75, 1.6, 0.75);
    blob.computeVertexNormals();
    blob.translate(0, blobDef.y, 0);
    parts.push({ geometry: blob, color: blobDef.color });
  }
  const geometry = mergeParts(parts);
  geometry.userData = { kind: 'poplar', height: POPLAR_HEIGHT };
  return geometry;
}

const TREE_WIND_BY_KIND = {
  conifer: CONIFER_WIND, deciduous: DECIDUOUS_WIND,
  tallPine: TALL_PINE_WIND, spruce: SPRUCE_WIND,
  birch: BIRCH_WIND, poplar: POPLAR_WIND,
};

/** Shared tree material (vertex colours + gentle wind sway) for the
 *  exported geometries — also the material to use if world.js
 *  obstacle trees are restyled with buildConiferGeometry /
 *  buildDeciduousGeometry. `kind`: 'conifer' | 'deciduous' |
 *  'tallPine' | 'spruce' | 'birch' | 'poplar'. */
export function createTreeMaterial(kind) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0.0,
    flatShading: true, emissive: 0xff9a55, emissiveIntensity: 0.07,
  });
  return applyWind(material, TREE_WIND_BY_KIND[kind] || CONIFER_WIND);
}

/** Matching shadow-depth material so tree shadows sway with the
 *  crowns. `kind`: see createTreeMaterial. */
export function createTreeDepthMaterial(kind) {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const wind = TREE_WIND_BY_KIND[kind] || CONIFER_WIND;
  return applyWind(material, { ...wind, key: wind.key + '-depth' });
}

// Bush: three merged jittered blobs (main + two satellites) so the
// silhouette is irregular from every angle; squashed per-instance.
function buildBushGeometry() {
  const rng = seededRandom(4411);
  const main = jitterGeometry(new THREE.IcosahedronGeometry(0.95, 1), rng, 0.84, 1.16);
  main.translate(0, 0.55, 0);
  const satA = jitterGeometry(new THREE.IcosahedronGeometry(0.55, 0), rng, 0.82, 1.18);
  satA.translate(0.62, 0.38, 0.18);
  const satB = jitterGeometry(new THREE.IcosahedronGeometry(0.48, 0), rng, 0.82, 1.18);
  satB.translate(-0.58, 0.34, -0.22);
  return mergeParts([{ geometry: main }, { geometry: satA }, { geometry: satB }]);
}

// Rock: strongly jittered icosahedron, flattened — grey-brown via
// instance colour, flat shading does the facets.
function buildRockGeometry() {
  const rng = seededRandom(4412);
  const rock = jitterGeometry(new THREE.IcosahedronGeometry(1.0, 0), rng, 0.72, 1.28);
  rock.scale(1, 0.68, 1);
  rock.translate(0, 0.32, 0);
  rock.computeVertexNormals();
  return rock;
}

// Crossed quads (star from above), base at y=0 — grass/flowers/wheat.
function buildCrossQuads(width, height, angles) {
  const parts = [];
  for (const angle of angles) {
    const quad = new THREE.PlaneGeometry(width, height);
    if (angle) quad.rotateY(angle);
    quad.translate(0, height / 2, 0);
    parts.push({ geometry: quad });
  }
  return mergeParts(parts);
}

function buildGrassGeometry() {
  return buildCrossQuads(1.25, 0.95, [0, Math.PI / 3, (2 * Math.PI) / 3]);
}
function buildFlowerGeometry() {
  return buildCrossQuads(0.85, 0.6, [0, Math.PI / 2]);
}
function buildLupineGeometry() {
  return buildCrossQuads(0.7, 0.85, [0, Math.PI / 2]);
}
function buildWheatGeometry() {
  return buildCrossQuads(1.3, 1.15, [0, Math.PI / 3, (2 * Math.PI) / 3]);
}

// ------------------------------------------------------------- placement

// Distance from a point to a strip rectangle (0 when inside) — same
// math as world.js stripRectangleDistance, recomputed from the strip
// fields so this module needs no world.js internals.
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
// within ±45 m of the extended centreline, 320 m past each threshold.
// Tall vegetation never goes here (visual hazard illusion).
function inApproachCorridor(strip, x, z) {
  const dx = x - strip.centre.x;
  const dz = z - strip.centre.z;
  const along = dx * strip.forward.x + dz * strip.forward.z;
  const across = dx * strip.right.x + dz * strip.right.z;
  return Math.abs(across) < 45 && Math.abs(along) < strip.length / 2 + 320;
}

const TREE_TARGET_HIGH = 3200;
const BUSH_TARGET_HIGH = 900;
const ROCK_TARGET_HIGH = 500;
const GRASS_TARGET_HIGH = 9000;
const FLOWER_TARGET_HIGH = 2200;
const LUPINE_TARGET_HIGH = 800;
const WHEAT_TARGET_HIGH = 2000;
// New tree keep-clear zones (visual only): Aurora river corridor,
// watchtower centres, and village centres (replicated from world.js
// buildVillages — see computeVillageCentres below).
const RIVER_POINTS = [[335, 30], [430, 190], [500, 390], [575, 590], [660, 760]];
const RIVER_MIN_M = 45;
const WATCHTOWER_POINTS = [[300, -280], [-720, 3350], [-2250, -2450], [2550, -1500], [2000, 2850]];
const WATCHTOWER_MIN_M = 55;
const VILLAGE_MIN_M = 60; // spec 55 m + 5 m safety margin
const TREE_MIN_STRIP_M = 40;
const TREE_MIN_PAD_M = 50;
const TREE_MIN_SPACING_M = 7;
const BUSH_MIN_STRIP_M = 14;
const BUSH_MIN_PAD_M = 44;
const ROCK_MIN_STRIP_M = 12;
const ROCK_MIN_PAD_M = 36;
const GRASS_MIN_STRIP_M = 8;
const GRASS_MIN_PAD_M = 30;
const FLOWER_MIN_STRIP_M = 9;
const FLOWER_MIN_PAD_M = 34;
const WHEAT_MIN_STRIP_M = 24;
const WHEAT_MIN_PAD_M = 40;

/**
 * Build all foliage. `options`: { islands, strips, dropPads,
 * heightAt, terrainSlopeAt, obstacleTrees }.
 * Returns { group, stats, update } — `update(seconds)` optionally
 * drives the wind clock from sim time; without it the sway
 * self-drives from performance.now(). No other per-frame work.
 */
export function buildVegetation(options) {
  const group = new THREE.Group();
  group.name = 'vegetation-vd6veg';
  const low = isLow();
  const groundScale = low ? 0.5 : 1;
  const stats = {
    pines: 0, conifers: 0, deciduous: 0, tallPines: 0, spruces: 0,
    birches: 0, poplars: 0, trees: 0, bushes: 0, rocks: 0,
    grass: 0, flowers: 0, lupine: 0, wheat: 0, draws: 0,
    quality: low ? 'low' : 'high',
  };
  const result = { group, stats, update: updateVegetationTime };
  group.userData.updateVegetationTime = updateVegetationTime;
  if (!options || typeof options.heightAt !== 'function') return result;
  const { islands, strips, dropPads, heightAt } = options;
  const terrainSlopeAt = typeof options.terrainSlopeAt === 'function'
    ? options.terrainSlopeAt : () => 0;
  const obstacleTrees = Array.isArray(options.obstacleTrees) ? options.obstacleTrees : [];
  const islandList = Array.isArray(islands) ? islands : [];
  const stripList = Array.isArray(strips) ? strips : [];
  const padList = Array.isArray(dropPads) ? dropPads : [];
  if (islandList.length === 0) return result;

  const TREE_TARGET = Math.round(TREE_TARGET_HIGH * groundScale);
  const BUSH_TARGET = Math.round(BUSH_TARGET_HIGH * groundScale);
  const ROCK_TARGET = Math.round(ROCK_TARGET_HIGH * groundScale);
  const GRASS_TARGET = Math.round(GRASS_TARGET_HIGH * groundScale);
  const FLOWER_TARGET = Math.round(FLOWER_TARGET_HIGH * groundScale);
  const LUPINE_TARGET = Math.round(LUPINE_TARGET_HIGH * groundScale);
  const WHEAT_TARGET = Math.round(WHEAT_TARGET_HIGH * groundScale);

  function clearOfStripsAndPads(x, z, minStripM, minPadM, checkCorridor) {
    for (const strip of stripList) {
      if (stripRectDistance(strip, x, z) < minStripM) return false;
      if (checkCorridor && inApproachCorridor(strip, x, z)) return false;
    }
    for (const pad of padList) {
      const dx = x - pad.x;
      const dz = z - pad.z;
      if (dx * dx + dz * dz < minPadM * minPadM) return false;
    }
    return true;
  }

  // True when (x, z) is inside a strip rectangle (world.js stripAt
  // equivalent, recomputed from strip fields).
  function stripContains(strip, x, z) {
    const dx = x - strip.centre.x;
    const dz = z - strip.centre.z;
    const along = dx * strip.forward.x + dz * strip.forward.z;
    const across = dx * strip.right.x + dz * strip.right.z;
    return Math.abs(along) <= strip.length / 2 && Math.abs(across) <= strip.width / 2;
  }

  // Island whose disc contains (x, z), else the nearest centre —
  // used where placement is driven by strips/roads, not islands.
  function islandAt(x, z) {
    let best = islandList[0];
    let bestDist = Infinity;
    for (const island of islandList) {
      const dx = x - island.centre.x;
      const dz = z - island.centre.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist <= island.radius) return island;
      if (dist < bestDist) { bestDist = dist; best = island; }
    }
    return best;
  }

  // Village centres replicated EXACTLY from world.js buildVillages:
  // same seededRandom(1126) stream, same per-island centre search
  // (60 attempts, angle/dist 0.55–0.85 radius, h 3–14, slope ≤0.2,
  // ≥130 m strip rect, ≥90 m pads), and the house-placement RNG
  // consumption replayed between islands (2 draws per failed house
  // attempt, 5 per placed cottage) so later islands' centre
  // searches stay in lockstep with the real villages. Trees keep
  // ≥VILLAGE_MIN_M from each centre.
  const villageCentres = (() => {
    const rng = seededRandom(1126);
    const centres = [];
    const cottages = [];
    function clearOfAirfields(x, z) {
      for (const strip of stripList) {
        if (stripRectDistance(strip, x, z) < 130) return false;
      }
      for (const pad of padList) {
        const dx = x - pad.x;
        const dz = z - pad.z;
        if (dx * dx + dz * dz < 90 * 90) return false;
      }
      return true;
    }
    for (const island of islandList) {
      let centre = null;
      for (let attempt = 0; attempt < 60 && !centre; attempt++) {
        const angle = rng() * Math.PI * 2;
        const dist = island.radius * (0.55 + rng() * 0.3);
        const x = island.centre.x + Math.cos(angle) * dist;
        const z = island.centre.z + Math.sin(angle) * dist;
        const h = heightAt(x, z);
        if (h < 3 || h > 14 || terrainSlopeAt(x, z) > 0.2 || !clearOfAirfields(x, z)) continue;
        centre = { x, z, seaward: angle };
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
        if (h < 2.2 || terrainSlopeAt(x, z) > 0.3
          || stripList.some((s) => stripContains(s, x, z))
          || !clearOfAirfields(x, z)) continue;
        let crowded = false;
        for (const c of cottages) {
          const dx = c.x - x;
          const dz = c.z - z;
          if (dx * dx + dz * dz < 81) { crowded = true; break; }
        }
        if (crowded) continue;
        rng(); rng(); // yaw draws
        rng(); // scale draw
        rng(); rng(); // roof + wall draws
        cottages.push({ x, z });
        placedHere++;
      }
    }
    return centres;
  })();

  function distToSegment(px, pz, ax, az, bx, bz) {
    const abx = bx - ax;
    const abz = bz - az;
    const lenSq = abx * abx + abz * abz;
    const t = lenSq > 0
      ? Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / lenSq)) : 0;
    const dx = px - (ax + abx * t);
    const dz = pz - (az + abz * t);
    return Math.sqrt(dx * dx + dz * dz);
  }

  // New keep-clear zones for TREES only (all kinds incl. runway
  // pines): river corridor ≥45 m, watchtowers ≥55 m, villages
  // ≥60 m (spec 55 + margin). Ground cover is unaffected.
  function clearOfNewZones(x, z) {
    for (const tower of WATCHTOWER_POINTS) {
      const dx = x - tower[0];
      const dz = z - tower[1];
      if (dx * dx + dz * dz < WATCHTOWER_MIN_M * WATCHTOWER_MIN_M) return false;
    }
    for (const centre of villageCentres) {
      const dx = x - centre.x;
      const dz = z - centre.z;
      if (dx * dx + dz * dz < VILLAGE_MIN_M * VILLAGE_MIN_M) return false;
    }
    for (let i = 0; i < RIVER_POINTS.length - 1; i++) {
      const a = RIVER_POINTS[i];
      const b = RIVER_POINTS[i + 1];
      if (distToSegment(x, z, a[0], a[1], b[0], b[1]) < RIVER_MIN_M) return false;
    }
    return true;
  }

  // Spacing hash for trees (vs each other + existing obstacle trees).
  const treeCells = new Set();
  const cellKey = (x, z) => Math.floor(x / TREE_MIN_SPACING_M) + ':' + Math.floor(z / TREE_MIN_SPACING_M);
  for (const tree of obstacleTrees) treeCells.add(cellKey(tree.x, tree.z));
  function treeSpotFree(x, z) {
    const cx = Math.floor(x / TREE_MIN_SPACING_M);
    const cz = Math.floor(z / TREE_MIN_SPACING_M);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        if (treeCells.has(gx + ':' + gz)) return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------ trees
  const treeRng = seededRandom(20261127);
  const coniferSpots = [];
  const deciduousSpots = [];
  const tallPineSpots = [];
  const spruceSpots = [];
  const birchSpots = [];
  const poplarSpots = [];
  function totalTrees() {
    return coniferSpots.length + deciduousSpots.length + tallPineSpots.length
      + spruceSpots.length + birchSpots.length + poplarSpots.length;
  }
  function tryAddTree(x, z, island, deciduousBias) {
    if (totalTrees() >= TREE_TARGET) return;
    const h = heightAt(x, z);
    if (h < 2.5 || h > island.peak * 0.62) return;
    if (terrainSlopeAt(x, z) > 0.5) return;
    if (!clearOfStripsAndPads(x, z, TREE_MIN_STRIP_M, TREE_MIN_PAD_M, true)) return;
    if (!clearOfNewZones(x, z)) return;
    if (!treeSpotFree(x, z)) return;
    treeCells.add(cellKey(x, z));
    // Hillsides lean conifer, lowlands lean deciduous (env4 mix).
    const bias = Math.max(0.05, Math.min(0.9, deciduousBias - (h / island.peak) * 0.35));
    const spot = {
      x, y: h - 0.25, z,
      scale: 0.9 + treeRng() * 0.75,
      wide: 0.9 + treeRng() * 0.35,
      tall: 0.85 + treeRng() * 0.65,
      yaw: treeRng() * Math.PI * 2,
    };
    // Six kinds in two families: conifer / tall pine / spruce vs
    // deciduous / birch / poplar. High ground shifts the conifer
    // family toward spruce; lowland shifts deciduous toward birch.
    const highGround = h / island.peak > 0.4;
    if (treeRng() < bias) {
      const k = treeRng();
      if (k < 0.55) deciduousSpots.push(spot);
      else if (k < 0.8) birchSpots.push(spot);
      else poplarSpots.push(spot);
    } else {
      const k = treeRng();
      if (highGround) {
        if (k < 0.35) coniferSpots.push(spot);
        else if (k < 0.6) tallPineSpots.push(spot);
        else spruceSpots.push(spot);
      } else if (k < 0.5) coniferSpots.push(spot);
      else if (k < 0.78) tallPineSpots.push(spot);
      else spruceSpots.push(spot);
    }
  }
  function plantStand(cx, cz, spread, count, island, deciduousBias) {
    for (let k = 0; k < count; k++) {
      tryAddTree(
        cx + (treeRng() + treeRng() - 1) * spread,
        cz + (treeRng() + treeRng() - 1) * spread, island, deciduousBias);
    }
  }
  // Runway tall pines: lines of the tall-pine kind along both long
  // edges of every strip (rect distance 14–26 m by construction,
  // middle ~70% of strip length, 18–25 m spacing with jitter,
  // scaled up). Visual only — never registered as obstacles.
  // NOTE on clearances: the 14–26 m spec deliberately overrides the
  // general 40 m tree strip minimum, and the approach-corridor rule
  // is applied to the corridor EXTENSIONS past each threshold
  // (|along| > length/2 within ±45 m across, 320 m out) — applying
  // inApproachCorridor literally would reject every edge pine,
  // since the whole strip length sits inside ±45 m across. Pads,
  // new zones, spacing, height and slope rules all still apply.
  function tryAddRunwayPine(x, z, island) {
    if (totalTrees() >= TREE_TARGET) return;
    const h = heightAt(x, z);
    if (h < 2.0 || h > island.peak * 0.62) return;
    if (terrainSlopeAt(x, z) > 0.5) return;
    for (const pad of padList) {
      const dx = x - pad.x;
      const dz = z - pad.z;
      if (dx * dx + dz * dz < TREE_MIN_PAD_M * TREE_MIN_PAD_M) return;
    }
    if (!clearOfNewZones(x, z)) return;
    for (const strip of stripList) {
      const dx = x - strip.centre.x;
      const dz = z - strip.centre.z;
      const along = dx * strip.forward.x + dz * strip.forward.z;
      const across = dx * strip.right.x + dz * strip.right.z;
      if (Math.abs(across) < 45 && Math.abs(along) > strip.length / 2
        && Math.abs(along) < strip.length / 2 + 320) return;
    }
    if (!treeSpotFree(x, z)) return;
    treeCells.add(cellKey(x, z));
    tallPineSpots.push({
      x, y: h - 0.25, z,
      scale: 1.1 + treeRng() * 0.4,
      wide: 0.95 + treeRng() * 0.25,
      tall: 1.0 + treeRng() * 0.25,
      yaw: treeRng() * Math.PI * 2,
    });
  }
  for (const strip of stripList) {
    const island = islandAt(strip.centre.x, strip.centre.z);
    for (const side of [-1, 1]) {
      let along = -strip.length * 0.35;
      while (along <= strip.length * 0.35) {
        const rectDist = 14 + treeRng() * 12; // 14–26 m
        const across = side * (strip.width / 2 + rectDist);
        tryAddRunwayPine(
          strip.centre.x + strip.forward.x * along + strip.right.x * across,
          strip.centre.z + strip.forward.z * along + strip.right.z * across,
          island);
        along += 18 + treeRng() * 7; // 18–25 m spacing
      }
    }
  }

  // Forest roads: road centrelines replicated from world.js
  // buildRoads (same starts, directions, phases, STEP 16, ≤48
  // steps, stop h<1.4 or slope>0.6 after step 2), then dense
  // stands planted 8–30 m to both sides so the roads read as
  // running through forest. Full tree clearances apply, so the
  // first metres near each strip stay clear as before.
  function buildRoadCenterlines() {
    const lanes = [];
    const STEP = 16;
    function trace(startX, startZ, dirX, dirZ, phase) {
      const baseAngle = Math.atan2(dirZ, dirX);
      let x = startX;
      let z = startZ;
      let travelled = 0;
      const pts = [];
      for (let stepIndex = 0; stepIndex < 48; stepIndex++) {
        const h = heightAt(x, z);
        if (h < 1.4) break;
        if (stepIndex > 2 && terrainSlopeAt(x, z) > 0.6) break;
        const angle = baseAngle + Math.sin(travelled * 0.008 + phase) * 0.35;
        const dx = Math.cos(angle);
        const dz = Math.sin(angle);
        pts.push({ x, z, dx, dz });
        x += dx * STEP;
        z += dz * STEP;
        travelled += STEP;
      }
      return pts;
    }
    stripList.forEach((strip, s) => {
      const startX = strip.centre.x + strip.forward.x * 30 + strip.right.x * (strip.width / 2 + 16);
      const startZ = strip.centre.z + strip.forward.z * 30 + strip.right.z * (strip.width / 2 + 16);
      lanes.push(trace(startX, startZ,
        strip.forward.x * 0.65 + strip.right.x * 0.75,
        strip.forward.z * 0.65 + strip.right.z * 0.75, s * 1.7));
      if (s === 0) {
        const start2X = strip.centre.x - strip.forward.x * 30 + strip.right.x * (strip.width / 2 + 16);
        const start2Z = strip.centre.z - strip.forward.z * 30 + strip.right.z * (strip.width / 2 + 16);
        lanes.push(trace(start2X, start2Z,
          -strip.forward.x * 0.65 + strip.right.x * 0.75,
          -strip.forward.z * 0.65 + strip.right.z * 0.75, 4.2));
      }
    });
    return lanes;
  }
  for (const lane of buildRoadCenterlines()) {
    for (const pt of lane) {
      const island = islandAt(pt.x, pt.z);
      const px = -pt.dz;
      const pz = pt.dx;
      for (const side of [-1, 1]) {
        const tries = 1 + (treeRng() < 0.6 ? 1 : 0);
        for (let t = 0; t < tries; t++) {
          const off = 8 + treeRng() * 22; // 8–30 m from centreline
          const alongJ = (treeRng() - 0.5) * 14;
          tryAddTree(
            pt.x + px * side * off + pt.dx * alongJ,
            pt.z + pz * side * off + pt.dz * alongJ, island, 0.25);
        }
      }
    }
  }

  // Guaranteed dense stands flanking the home strip (tower-reference
  // conifer mass) and in the chase-shot foreground (Aurora south-west,
  // mixed like env4).
  const homeStrip = stripList[0];
  const aurora = islandList[0];
  if (homeStrip && aurora) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const along = -homeStrip.length / 2 + (homeStrip.length / 3) * i + (treeRng() - 0.5) * 30;
        const across = side * (55 + treeRng() * 55);
        plantStand(
          homeStrip.centre.x + homeStrip.forward.x * along + homeStrip.right.x * across,
          homeStrip.centre.z + homeStrip.forward.z * along + homeStrip.right.z * across,
          42, 14, aurora, 0.18);
      }
    }
    for (const stand of [{ x: -420, z: 480 }, { x: -80, z: 620 }, { x: 320, z: 560 }, { x: 560, z: 240 }, { x: -560, z: -180 }, { x: 240, z: -520 }]) {
      plantStand(stand.x, stand.z, 70, 16, aurora, 0.35);
    }
  }
  // Random clustered stands on every island until the target is met;
  // each stand is conifer- or deciduous-dominant, never pure.
  let treeAttempts = 0;
  while (totalTrees() < TREE_TARGET && treeAttempts < 1200) {
    treeAttempts++;
    const island = islandList[Math.floor(treeRng() * islandList.length)];
    const angle = treeRng() * Math.PI * 2;
    const dist = Math.sqrt(treeRng()) * island.radius * 0.82;
    const bias = treeRng() < 0.6 ? 0.15 + treeRng() * 0.2 : 0.55 + treeRng() * 0.3;
    plantStand(
      island.centre.x + Math.cos(angle) * dist,
      island.centre.z + Math.sin(angle) * dist,
      26 + treeRng() * 80, 8 + Math.floor(treeRng() * 13), island, bias);
  }
  const treeSpots = coniferSpots.concat(
    deciduousSpots, tallPineSpots, spruceSpots, birchSpots, poplarSpots);

  // ----------------------------------------------------------- bushes
  const bushRng = seededRandom(20261128);
  const bushSpots = [];
  function tryAddBush(x, z, island) {
    if (bushSpots.length >= BUSH_TARGET) return;
    const h = heightAt(x, z);
    if (h < 2.2 || h > island.peak * 0.55) return;
    if (terrainSlopeAt(x, z) > 0.5) return;
    if (!clearOfStripsAndPads(x, z, BUSH_MIN_STRIP_M, BUSH_MIN_PAD_M, false)) return;
    bushSpots.push({
      x, y: h - 0.15, z,
      scale: 0.7 + bushRng() * 1.3,
      yaw: bushRng() * Math.PI * 2,
    });
  }
  // Bush clusters hug the strip edges, drop-zone villages and tree
  // stands (undergrowth), plus lowland scrub scatter.
  for (const strip of stripList) {
    const island = islandList[0];
    for (let i = 0; i < 22; i++) {
      const along = (bushRng() - 0.5) * (strip.length + 80);
      const side = bushRng() > 0.5 ? 1 : -1;
      const across = side * (strip.width / 2 + 18 + bushRng() * 40);
      tryAddBush(
        strip.centre.x + strip.forward.x * along + strip.right.x * across,
        strip.centre.z + strip.forward.z * along + strip.right.z * across, island);
    }
  }
  for (const pad of padList) {
    for (let i = 0; i < 8; i++) {
      const angle = bushRng() * Math.PI * 2;
      const dist = 48 + bushRng() * 34;
      tryAddBush(pad.x + Math.cos(angle) * dist, pad.z + Math.sin(angle) * dist, islandList[0]);
    }
  }
  for (const spot of treeSpots) {
    if (bushRng() > 0.45) continue;
    tryAddBush(spot.x + (bushRng() - 0.5) * 22, spot.z + (bushRng() - 0.5) * 22, islandList[0]);
  }
  let bushAttempts = 0;
  while (bushSpots.length < BUSH_TARGET && bushAttempts < 4200) {
    bushAttempts++;
    const island = islandList[Math.floor(bushRng() * islandList.length)];
    const angle = bushRng() * Math.PI * 2;
    const dist = Math.sqrt(bushRng()) * island.radius * 0.9;
    tryAddBush(island.centre.x + Math.cos(angle) * dist, island.centre.z + Math.sin(angle) * dist, island);
  }

  // ------------------------------------------------------------ rocks
  const rockRng = seededRandom(20261130);
  const rockSpots = [];
  function tryAddRock(x, z, island) {
    if (rockSpots.length >= ROCK_TARGET) return;
    const h = heightAt(x, z);
    if (h < 1.2 || h > island.peak * 0.8) return;
    if (terrainSlopeAt(x, z) > 0.75) return;
    if (!clearOfStripsAndPads(x, z, ROCK_MIN_STRIP_M, ROCK_MIN_PAD_M, false)) return;
    rockSpots.push({
      x, y: h - 0.1, z,
      scale: 0.4 + rockRng() * 1.8,
      squash: 0.5 + rockRng() * 0.45,
      yaw: rockRng() * Math.PI * 2,
      tilt: (rockRng() - 0.5) * 0.35,
    });
  }
  // Rocks cluster at tree bases, on hillsides and along coasts.
  for (const spot of treeSpots) {
    if (rockRng() > 0.22) continue;
    tryAddRock(spot.x + (rockRng() - 0.5) * 18, spot.z + (rockRng() - 0.5) * 18, islandList[0]);
  }
  let rockAttempts = 0;
  while (rockSpots.length < ROCK_TARGET && rockAttempts < 4200) {
    rockAttempts++;
    const island = islandList[Math.floor(rockRng() * islandList.length)];
    const angle = rockRng() * Math.PI * 2;
    const dist = Math.sqrt(rockRng()) * island.radius * 0.95;
    tryAddRock(island.centre.x + Math.cos(angle) * dist, island.centre.z + Math.sin(angle) * dist, island);
  }

  // ------------------------------------------------------------ grass
  const grassRng = seededRandom(20261129);
  const grassSpots = [];
  function tryAddGrass(x, z) {
    if (grassSpots.length >= GRASS_TARGET) return;
    const h = heightAt(x, z);
    if (h < 1.6) return;
    if (terrainSlopeAt(x, z) > 0.55) return;
    if (!clearOfStripsAndPads(x, z, GRASS_MIN_STRIP_M, GRASS_MIN_PAD_M, false)) return;
    grassSpots.push({
      x, y: h - 0.04, z,
      scale: 0.75 + grassRng() * 0.9,
      yaw: grassRng() * Math.PI * 2,
    });
  }
  // Dense tuft bands along both strip shoulders (the judged shots'
  // foreground), rings around drop pads, and undergrowth in the stands.
  for (const strip of stripList) {
    for (let i = 0; i < 240; i++) {
      const along = (grassRng() - 0.5) * (strip.length + 120);
      const side = grassRng() > 0.5 ? 1 : -1;
      const across = side * (strip.width / 2 + 8 + grassRng() * 46);
      tryAddGrass(
        strip.centre.x + strip.forward.x * along + strip.right.x * across,
        strip.centre.z + strip.forward.z * along + strip.right.z * across);
    }
  }
  for (const pad of padList) {
    for (let i = 0; i < 36; i++) {
      const angle = grassRng() * Math.PI * 2;
      const dist = 32 + grassRng() * 44;
      tryAddGrass(pad.x + Math.cos(angle) * dist, pad.z + Math.sin(angle) * dist);
    }
  }
  for (const spot of treeSpots) {
    if (grassRng() > 0.55) continue;
    tryAddGrass(spot.x + (grassRng() - 0.5) * 16, spot.z + (grassRng() - 0.5) * 16);
  }
  let grassAttempts = 0;
  while (grassSpots.length < GRASS_TARGET && grassAttempts < 16000) {
    grassAttempts++;
    const island = islandList[Math.floor(grassRng() * islandList.length)];
    const angle = grassRng() * Math.PI * 2;
    const dist = Math.sqrt(grassRng()) * island.radius * 0.9;
    const x = island.centre.x + Math.cos(angle) * dist;
    const z = island.centre.z + Math.sin(angle) * dist;
    if (heightAt(x, z) > island.peak * 0.5) continue;
    tryAddGrass(x, z);
  }

  // --------------------------------------------- wildflowers + lupine
  const flowerRng = seededRandom(20261131);
  const flowerSpots = [];
  const lupineSpots = [];
  function tryAddGroundCard(list, target, x, z, maxSlope) {
    if (list.length >= target) return;
    const h = heightAt(x, z);
    if (h < 1.8) return;
    if (terrainSlopeAt(x, z) > maxSlope) return;
    if (!clearOfStripsAndPads(x, z, FLOWER_MIN_STRIP_M, FLOWER_MIN_PAD_M, false)) return;
    list.push({
      x, y: h - 0.03, z,
      scale: 0.8 + flowerRng() * 0.7,
      yaw: flowerRng() * Math.PI * 2,
    });
  }
  function plantMeadow(list, target, clusters, perCluster, maxSlope) {
    for (let c = 0; c < clusters; c++) {
      const island = islandList[Math.floor(flowerRng() * islandList.length)];
      const angle = flowerRng() * Math.PI * 2;
      const dist = Math.sqrt(flowerRng()) * island.radius * 0.8;
      const cx = island.centre.x + Math.cos(angle) * dist;
      const cz = island.centre.z + Math.sin(angle) * dist;
      if (heightAt(cx, cz) > island.peak * 0.35) continue;
      const spread = 5 + flowerRng() * 9;
      const count = Math.floor(perCluster * (0.6 + flowerRng() * 0.8));
      for (let k = 0; k < count; k++) {
        tryAddGroundCard(list, target,
          cx + (flowerRng() + flowerRng() - 1) * spread,
          cz + (flowerRng() + flowerRng() - 1) * spread, maxSlope);
      }
    }
  }
  // Meadow clusters, strip verges and drop-pad rings (env8/env9).
  plantMeadow(flowerSpots, FLOWER_TARGET, 95, 30, 0.45);
  plantMeadow(lupineSpots, LUPINE_TARGET, 48, 16, 0.5);
  for (const strip of stripList) {
    for (let i = 0; i < 60; i++) {
      const along = (flowerRng() - 0.5) * (strip.length + 60);
      const side = flowerRng() > 0.5 ? 1 : -1;
      const across = side * (strip.width / 2 + 9 + flowerRng() * 30);
      tryAddGroundCard(flowerSpots, FLOWER_TARGET,
        strip.centre.x + strip.forward.x * along + strip.right.x * across,
        strip.centre.z + strip.forward.z * along + strip.right.z * across, 0.45);
    }
    for (let i = 0; i < 26; i++) {
      const along = (flowerRng() - 0.5) * (strip.length + 60);
      const side = flowerRng() > 0.5 ? 1 : -1;
      const across = side * (strip.width / 2 + 10 + flowerRng() * 34);
      tryAddGroundCard(lupineSpots, LUPINE_TARGET,
        strip.centre.x + strip.forward.x * along + strip.right.x * across,
        strip.centre.z + strip.forward.z * along + strip.right.z * across, 0.5);
    }
  }
  for (const pad of padList) {
    for (let i = 0; i < 10; i++) {
      const angle = flowerRng() * Math.PI * 2;
      const dist = 36 + flowerRng() * 34;
      tryAddGroundCard(flowerSpots, FLOWER_TARGET,
        pad.x + Math.cos(angle) * dist, pad.z + Math.sin(angle) * dist, 0.45);
    }
  }
  // Lowland scatter fill so both quality levels actually reach their
  // targets (clusters alone under-fill on sparse islands).
  function scatterFill(list, target, maxSlope, maxAttempts) {
    let attempts = 0;
    while (list.length < target && attempts < maxAttempts) {
      attempts++;
      const island = islandList[Math.floor(flowerRng() * islandList.length)];
      const angle = flowerRng() * Math.PI * 2;
      const dist = Math.sqrt(flowerRng()) * island.radius * 0.85;
      const x = island.centre.x + Math.cos(angle) * dist;
      const z = island.centre.z + Math.sin(angle) * dist;
      if (heightAt(x, z) > island.peak * 0.4) continue;
      tryAddGroundCard(list, target, x, z, maxSlope);
    }
  }
  scatterFill(flowerSpots, FLOWER_TARGET, 0.45, 10000);
  scatterFill(lupineSpots, LUPINE_TARGET, 0.5, 5000);

  // ------------------------------------------------------------ wheat
  const wheatRng = seededRandom(20261132);
  const wheatSpots = [];
  function tryAddWheat(x, z) {
    if (wheatSpots.length >= WHEAT_TARGET) return;
    const h = heightAt(x, z);
    if (h < 2.0) return;
    if (terrainSlopeAt(x, z) > 0.3) return;
    if (!clearOfStripsAndPads(x, z, WHEAT_MIN_STRIP_M, WHEAT_MIN_PAD_M, false)) return;
    wheatSpots.push({
      x, y: h - 0.03, z,
      scale: 0.85 + wheatRng() * 0.5,
      yaw: wheatRng() * Math.PI * 2,
    });
  }
  // Elliptical field patches on flat lowland, grid-jitter filled so
  // they read as sown fields (env7/env9), not scatter.
  function plantWheatPatch(cx, cz, island) {
    if (heightAt(cx, cz) > island.peak * 0.3) return;
    if (terrainSlopeAt(cx, cz) > 0.22) return;
    const rx = 16 + wheatRng() * 20;
    const rz = 10 + wheatRng() * 14;
    const yaw = wheatRng() * Math.PI;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const step = 2.4;
    for (let gx = -rx; gx <= rx; gx += step) {
      for (let gz = -rz; gz <= rz; gz += step) {
        if ((gx * gx) / (rx * rx) + (gz * gz) / (rz * rz) > 1) continue;
        tryAddWheat(
          cx + gx * cosY - gz * sinY + (wheatRng() - 0.5) * 1.6,
          cz + gx * sinY + gz * cosY + (wheatRng() - 0.5) * 1.6);
      }
    }
  }
  // Two guaranteed patches flanking the home strip (env7 foreground).
  if (homeStrip && aurora) {
    for (const side of [-1, 1]) {
      const along = (wheatRng() - 0.5) * homeStrip.length * 0.5;
      const across = side * (homeStrip.width / 2 + 62 + wheatRng() * 30);
      plantWheatPatch(
        homeStrip.centre.x + homeStrip.forward.x * along + homeStrip.right.x * across,
        homeStrip.centre.z + homeStrip.forward.z * along + homeStrip.right.z * across,
        aurora);
    }
  }
  let wheatAttempts = 0;
  while (wheatSpots.length < WHEAT_TARGET && wheatAttempts < 70) {
    wheatAttempts++;
    const island = islandList[Math.floor(wheatRng() * islandList.length)];
    const angle = wheatRng() * Math.PI * 2;
    const dist = Math.sqrt(wheatRng()) * island.radius * 0.75;
    plantWheatPatch(
      island.centre.x + Math.cos(angle) * dist,
      island.centre.z + Math.sin(angle) * dist, island);
  }

  // --------------------------------------------------------- instancing
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scaleVec = new THREE.Vector3();
  const tint = new THREE.Color();

  // Shared instancing helper: pose + tint every spot once, enable
  // frustum culling with a correct world-spanning bounding sphere.
  function makeInstanced(geometry, material, spots, name, pose, colour, opts) {
    if (spots.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
    mesh.name = name;
    for (let i = 0; i < spots.length; i++) {
      pose(spots[i], position, euler, scaleVec);
      quaternion.setFromEuler(euler);
      matrix.compose(position, quaternion, scaleVec);
      mesh.setMatrixAt(i, matrix);
      colour(spots[i], tint);
      mesh.setColorAt(i, tint);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (opts && opts.castShadow) mesh.castShadow = true;
    if (opts && opts.receiveShadow) mesh.receiveShadow = true;
    if (opts && opts.depthMaterial) mesh.customDepthMaterial = opts.depthMaterial;
    mesh.frustumCulled = true;
    if (typeof mesh.computeBoundingSphere === 'function') mesh.computeBoundingSphere();
    group.add(mesh);
    stats.draws += 1;
    return mesh;
  }

  function treePose(spot, pos, eul, scl) {
    pos.set(spot.x, spot.y, spot.z);
    eul.set(0, spot.yaw, 0);
    scl.set(spot.scale * spot.wide, spot.scale * spot.tall, spot.scale * spot.wide);
  }
  function cardPose(spot, pos, eul, scl) {
    pos.set(spot.x, spot.y, spot.z);
    eul.set(0, spot.yaw, 0);
    scl.set(spot.scale, spot.scale, spot.scale);
  }

  // Conifers — ONE draw (+1 shadow depth). Vertex colours carry
  // trunk/tier hues; instance colour varies the green per tree,
  // ~28% yellow-green like the sunlit env4 pines.
  const conifers = makeInstanced(
    buildConiferGeometry(), createTreeMaterial('conifer'), coniferSpots, 'veg-conifers',
    treePose,
    (spot, out) => {
      const g = 0.95 + treeRng() * 0.4;
      if (treeRng() < 0.28) out.setRGB(g * 1.12, g * 1.08, g * 0.62);
      else out.setRGB(g * (0.9 + treeRng() * 0.2), g, g * (0.82 + treeRng() * 0.2));
    },
    { castShadow: true, receiveShadow: true, depthMaterial: createTreeDepthMaterial('conifer') });
  stats.conifers = coniferSpots.length;
  stats.pines = coniferSpots.length;

  // Deciduous — ONE draw (+1 shadow depth). Pale vertex colours ×
  // instance hue: greens, yellow-greens, golden and autumn tones.
  const deciduousPalette = [
    0x6fae52, 0x7fb95a, 0x8fc466, 0x6fae52, 0x7fb95a, 0x8fc466,
    0xa3c95e, 0xb8d05e, 0xd4c04e, 0xe0a84a, 0xd06a3a,
  ];
  const deciduous = makeInstanced(
    buildDeciduousGeometry(), createTreeMaterial('deciduous'), deciduousSpots, 'veg-deciduous',
    treePose,
    (spot, out) => {
      out.setHex(deciduousPalette[Math.floor(treeRng() * deciduousPalette.length)]);
      out.multiplyScalar(0.95 + treeRng() * 0.4);
    },
    { castShadow: true, receiveShadow: true, depthMaterial: createTreeDepthMaterial('deciduous') });
  stats.deciduous = deciduousSpots.length;

  // Tall pines — ONE draw (+1 shadow depth). Same sunlit-green
  // family as conifers; includes the runway-edge lines.
  const tallPines = makeInstanced(
    buildTallPineGeometry(), createTreeMaterial('tallPine'), tallPineSpots, 'veg-tallpines',
    treePose,
    (spot, out) => {
      const g = 0.95 + treeRng() * 0.4;
      if (treeRng() < 0.28) out.setRGB(g * 1.12, g * 1.08, g * 0.62);
      else out.setRGB(g * (0.9 + treeRng() * 0.2), g, g * (0.82 + treeRng() * 0.2));
    },
    { castShadow: true, receiveShadow: true, depthMaterial: createTreeDepthMaterial('tallPine') });
  stats.tallPines = tallPineSpots.length;

  // Spruces — ONE draw (+1 shadow depth). Darker, bluer greens.
  makeInstanced(
    buildSpruceGeometry(), createTreeMaterial('spruce'), spruceSpots, 'veg-spruces',
    treePose,
    (spot, out) => {
      const g = 0.8 + treeRng() * 0.3;
      out.setRGB(g * (0.68 + treeRng() * 0.14), g, g * (0.74 + treeRng() * 0.14));
    },
    { castShadow: true, receiveShadow: true, depthMaterial: createTreeDepthMaterial('spruce') });
  stats.spruces = spruceSpots.length;

  // Birches — ONE draw (+1 shadow depth). Pale trunk in the
  // geometry; light yellow-green crown hues.
  const birchPalette = [0xa8d878, 0xbfe08a, 0xd4e88a, 0x9fd06e, 0xc8e29a];
  makeInstanced(
    buildBirchGeometry(), createTreeMaterial('birch'), birchSpots, 'veg-birches',
    treePose,
    (spot, out) => {
      out.setHex(birchPalette[Math.floor(treeRng() * birchPalette.length)]);
      out.multiplyScalar(0.95 + treeRng() * 0.3);
    },
    { castShadow: true, receiveShadow: true, depthMaterial: createTreeDepthMaterial('birch') });
  stats.birches = birchSpots.length;

  // Poplars — ONE draw (+1 shadow depth). Columnar crowns in
  // mid greens.
  const poplarPalette = [0x5da24a, 0x6fb254, 0x7fc05e, 0x66aa50];
  makeInstanced(
    buildPoplarGeometry(), createTreeMaterial('poplar'), poplarSpots, 'veg-poplars',
    treePose,
    (spot, out) => {
      out.setHex(poplarPalette[Math.floor(treeRng() * poplarPalette.length)]);
      out.multiplyScalar(0.95 + treeRng() * 0.35);
    },
    { castShadow: true, receiveShadow: true, depthMaterial: createTreeDepthMaterial('poplar') });
  stats.poplars = poplarSpots.length;
  stats.trees = totalTrees();

  // Bushes — ONE draw. Canvas leaf texture × instance colour family.
  const bushTexture = buildBushTexture();
  const bushParams = {
    color: 0xffffff, roughness: 0.95, metalness: 0.0, flatShading: true,
    emissive: 0xff9a55, emissiveIntensity: 0.05,
  };
  if (bushTexture) bushParams.map = bushTexture;
  const bushMaterial = applyWind(new THREE.MeshStandardMaterial(bushParams), BUSH_WIND);
  const bushTints = [0xffffff, 0xd8e6c8, 0xb9d69a, 0xe8e0b8, 0xcfe0ae, 0xe8d0a8];
  makeInstanced(
    buildBushGeometry(), bushMaterial, bushSpots, 'veg-bushes',
    (spot, pos, eul, scl) => {
      pos.set(spot.x, spot.y, spot.z);
      eul.set(0, spot.yaw, 0);
      scl.set(spot.scale, spot.scale * (0.55 + bushRng() * 0.25), spot.scale);
    },
    (spot, out) => {
      out.setHex(bushTints[Math.floor(bushRng() * bushTints.length)]);
      out.multiplyScalar(0.85 + bushRng() * 0.3);
    },
    { receiveShadow: true });
  stats.bushes = bushSpots.length;

  // Rocks — ONE draw. Grey-brown instance tints, no wind.
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1.0, metalness: 0.0, flatShading: true,
    emissive: 0xff9a55, emissiveIntensity: 0.03,
  });
  const rockTints = [0x8a8578, 0x7a7264, 0x968d7c, 0x6e675c, 0x857a68];
  makeInstanced(
    buildRockGeometry(), rockMaterial, rockSpots, 'veg-rocks',
    (spot, pos, eul, scl) => {
      pos.set(spot.x, spot.y, spot.z);
      eul.set(spot.tilt, spot.yaw, spot.tilt * 0.6);
      scl.set(spot.scale, spot.scale * spot.squash, spot.scale);
    },
    (spot, out) => {
      out.setHex(rockTints[Math.floor(rockRng() * rockTints.length)]);
      out.multiplyScalar(0.85 + rockRng() * 0.3);
    },
    { receiveShadow: true });
  stats.rocks = rockSpots.length;

  // Grass — ONE draw. Alpha-tested triple cross-quads, double-sided;
  // dryness is a smooth function of world position so golden patches
  // cluster (env9) instead of per-instance salt-and-pepper.
  const grassTexture = buildGrassTexture();
  const grassParams = {
    color: 0xffffff, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
    alphaTest: 0.42, emissive: 0xff9a55, emissiveIntensity: 0.05,
  };
  if (grassTexture) grassParams.map = grassTexture;
  const grassMaterial = applyWind(new THREE.MeshStandardMaterial(grassParams), GRASS_WIND);
  makeInstanced(
    buildGrassGeometry(), grassMaterial, grassSpots, 'veg-grass',
    (spot, pos, eul, scl) => {
      pos.set(spot.x, spot.y, spot.z);
      eul.set(0, spot.yaw, 0);
      scl.set(spot.scale, spot.scale * (0.8 + grassRng() * 0.5), spot.scale);
    },
    (spot, out) => {
      const dry = 0.5 + 0.5 * Math.sin(spot.x * 0.011 + Math.sin(spot.z * 0.009) * 2.1)
        * Math.cos(spot.z * 0.008 + Math.sin(spot.x * 0.007) * 1.7);
      const jitter = 0.95 + grassRng() * 0.18;
      out.setRGB(
        (0.78 + dry * 0.22) * jitter,
        (1.0 + dry * 0.06) * jitter,
        (0.88 - dry * 0.22) * jitter);
    },
    null);
  stats.grass = grassSpots.length;

  // Round wildflowers — ONE draw. Pale instance tints over the
  // white-daisy texture: white / pale yellow / pale pink / violet.
  const flowerTexture = buildFlowerTexture();
  const flowerParams = {
    color: 0xffffff, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
    alphaTest: 0.42, emissive: 0xff9a55, emissiveIntensity: 0.05,
  };
  if (flowerTexture) flowerParams.map = flowerTexture;
  const flowerMaterial = applyWind(new THREE.MeshStandardMaterial(flowerParams), FLOWER_WIND);
  const flowerTints = [0xffffff, 0xfff2b0, 0xffd9e8, 0xe8e0ff, 0xffffff];
  makeInstanced(
    buildFlowerGeometry(), flowerMaterial, flowerSpots, 'veg-flowers',
    cardPose,
    (spot, out) => {
      out.setHex(flowerTints[Math.floor(flowerRng() * flowerTints.length)]);
      out.multiplyScalar(0.9 + flowerRng() * 0.18);
    },
    null);
  stats.flowers = flowerSpots.length;

  // Lupine — ONE draw. Saturated purple texture, brightness jitter.
  const lupineTexture = buildLupineTexture();
  const lupineParams = {
    color: 0xffffff, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
    alphaTest: 0.42, emissive: 0xff9a55, emissiveIntensity: 0.05,
  };
  if (lupineTexture) lupineParams.map = lupineTexture;
  const lupineMaterial = applyWind(new THREE.MeshStandardMaterial(lupineParams), LUPINE_WIND);
  makeInstanced(
    buildLupineGeometry(), lupineMaterial, lupineSpots, 'veg-lupine',
    cardPose,
    (spot, out) => {
      const b = 0.85 + flowerRng() * 0.35;
      out.setRGB(b * (0.92 + flowerRng() * 0.12), b * 0.95, b * (1.0 + flowerRng() * 0.1));
    },
    null);
  stats.lupine = lupineSpots.length;

  // Wheat — ONE draw. Golden texture, brightness jitter per stalk card.
  const wheatTexture = buildWheatTexture();
  const wheatParams = {
    color: 0xffffff, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
    alphaTest: 0.42, emissive: 0xff9a55, emissiveIntensity: 0.06,
  };
  if (wheatTexture) wheatParams.map = wheatTexture;
  const wheatMaterial = applyWind(new THREE.MeshStandardMaterial(wheatParams), WHEAT_WIND);
  makeInstanced(
    buildWheatGeometry(), wheatMaterial, wheatSpots, 'veg-wheat',
    cardPose,
    (spot, out) => {
      const b = 0.85 + wheatRng() * 0.35;
      out.setRGB(b * 1.05, b * 0.98, b * 0.82);
    },
    null);
  stats.wheat = wheatSpots.length;

  // Wind clock self-drive: one float write per frame from the first
  // tree mesh's render hook, until a coordinator drives update().
  const clockMesh = conifers || deciduous || tallPines;
  if (clockMesh) {
    clockMesh.onBeforeRender = () => {
      if (!externalClock) vegTimeUniform.value = performance.now() * 0.001;
    };
  }

  return result;
}
