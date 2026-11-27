// ring-gates.js — visual dressing that turns each target-ring torus
// into a lit race gate: halo disc + billboard halo, HDR glow rings,
// rim ticks, inward chevrons, a numbered badge, twinkling sparkles
// and inner dust. world.js owns the hoop, its placement and state; it
// calls dressRingGate / styleRingGate / animateRingGates. Nothing here
// touches crossing detection or scoring.
//
// Ring-local frame (world.js placeRings): torus in the local XY plane,
// local +Z faces the next ring, local +Y stays world-up.
//
// Colour order (user, 2026-11-27): DARK GREEN — deep saturated green
// (0x00c853) that reads against olive terrain, blue sea and the orange
// dawn sky alike. State is read by brightness and dressing: 'next'
// burns dark green, pulsing, with chevrons/sparkles/ticks; 'todo' is a
// softer dimmer green; 'done' hides all dressing (world.js fades the
// hoop itself).
//
// Draws: active gate +8, upcoming gate +3, cleared gate +0. Geometry
// and materials are shared/cached; badge textures cache per number,
// so re-placing a course allocates nothing new.

import * as THREE from 'three';

const NEXT_HEX = 0x00c853;      // dark green — active gate
const TODO_HEX = 0x5ee86a;      // softer green — upcoming gates
const CHEVRON_HEX = 0xeaffea;   // cool white fly-through cue
const HALO_SCALE = 1.75;        // halo disc radius / hoop centre radius
const BADGE_FONT = '800 92px AuroraSans, "Segoe UI", system-ui, -apple-system, Arial, sans-serif';
const NEXT_GLOW = 2.8;          // emissive intensity, active hoop (bloom range)
const TODO_GLOW = 1.35;

const caches = {
  haloGeo: new Map(),
  chevronGeo: new Map(),
  badgeTex: new Map(),
  sparkleGeo: new Map(),
  dustGeo: new Map(),
  glowGeo: new Map(),
  tickGeo: new Map(),
};
let haloTex = null;
let sparkleTex = null;
let sparkleMat = null;
let sharedMats = null;

function cached(map, key, make) {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
}

function paintSquare(size, painter) {
  if (typeof document === 'undefined') return null;
  const el = document.createElement('canvas');
  el.width = size;
  el.height = size;
  const ctx = el.getContext('2d');
  if (!ctx) return null;
  painter(ctx, size);
  const tex = new THREE.CanvasTexture(el);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ------------------------------------------------------------- textures

// Radial halo profile (white; material colour carries the hue): faint
// membrane inside the hoop with three ripple rings, a bright band on
// the rim line, then a soft falloff to nothing.
function makeHaloTexture() {
  return paintSquare(256, (ctx, size) => {
    const c = size / 2;
    const rim = c / HALO_SCALE;
    const rimStop = rim / c;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,0.05)');
    g.addColorStop(rimStop * 0.7, 'rgba(255,255,255,0.08)');
    g.addColorStop(rimStop * 0.93, 'rgba(255,255,255,0.30)');
    g.addColorStop(rimStop, 'rgba(255,255,255,0.62)');
    g.addColorStop(rimStop * 1.09, 'rgba(255,255,255,0.30)');
    g.addColorStop(rimStop * 1.32, 'rgba(255,255,255,0.09)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    for (const f of [0.32, 0.55, 0.78]) {
      ctx.beginPath();
      ctx.arc(c, c, rim * f, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}

// Sparkle sprite: soft core with cross flare arms.
function makeSparkleTexture() {
  return paintSquare(64, (ctx, size) => {
    const c = size / 2;
    const core = ctx.createRadialGradient(c, c, 0, c, c, c);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(c - 1.5, 2, 3, size - 4);
    ctx.fillRect(2, c - 1.5, size - 4, 3);
  });
}

// Numbered badge: near-black disc, white ring, dotted outer rim,
// inner hairline, big white numeral. White paint so the sprite
// material colour tints it per state while the numeral stays bright.
function badgeTexture(number) {
  return cached(caches.badgeTex, number, () => paintSquare(160, (ctx, size) => {
    const c = size / 2;
    const glow = ctx.createRadialGradient(c, c, c * 0.55, c, c, c);
    glow.addColorStop(0, 'rgba(255,255,255,0.20)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);
    const disc = ctx.createLinearGradient(0, c - 62, 0, c + 62);
    disc.addColorStop(0, 'rgba(22,26,40,0.94)');
    disc.addColorStop(1, 'rgba(6,8,16,0.94)');
    ctx.beginPath();
    ctx.arc(c, c, c - 14, 0, Math.PI * 2);
    ctx.fillStyle = disc;
    ctx.fill();
    ctx.lineWidth = 9;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c + Math.cos(a) * (c - 6), c + Math.sin(a) * (c - 6), 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(c, c, c - 28, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.stroke();
    ctx.font = BADGE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(String(number), c, c + 5);
  }));
}

// ------------------------------------------------------------- geometry

// Concatenate indexed geometries (position + normal + optional colour)
// into one buffer so paired parts cost a single draw.
function mergeParts(parts, withColor) {
  let vTotal = 0;
  let iTotal = 0;
  for (const g of parts) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nor = new Float32Array(vTotal * 3);
  const col = withColor ? new Float32Array(vTotal * 3) : null;
  const idx = new Uint32Array(iTotal);
  let vOff = 0;
  let iOff = 0;
  for (const g of parts) {
    const p = g.attributes.position;
    pos.set(p.array, vOff * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, vOff * 3);
    if (col && g.attributes.color) col.set(g.attributes.color.array, vOff * 3);
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) idx[iOff + i] = src[i] + vOff;
      iOff += src.length;
    } else {
      for (let i = 0; i < p.count; i++) idx[iOff + i] = i + vOff;
      iOff += p.count;
    }
    vOff += p.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  merged.setIndex(new THREE.BufferAttribute(idx, 1));
  return merged;
}

// Fill a geometry with one flat HDR vertex colour.
function tintGeometry(geo, hex, intensity) {
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  const r = (((hex >> 16) & 255) / 255) * intensity;
  const g = (((hex >> 8) & 255) / 255) * intensity;
  const b = ((hex & 255) / 255) * intensity;
  for (let i = 0; i < n; i++) {
    col[i * 3] = r;
    col[i * 3 + 1] = g;
    col[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function haloGeometry(centreRadius) {
  return cached(caches.haloGeo, Math.round(centreRadius * 100),
    () => new THREE.CircleGeometry(centreRadius * HALO_SCALE, 48));
}

// Double-ring glow: fat inner torus (neon, HDR ×2.3) + thin pale rim
// highlight (HDR ×1.7), merged into one draw.
function glowRingGeometry(centreRadius, tube) {
  const key = `${Math.round(centreRadius * 100)}:${Math.round(tube * 100)}`;
  return cached(caches.glowGeo, key, () => {
    const inner = tintGeometry(new THREE.TorusGeometry(centreRadius - tube * 0.42, tube * 0.3, 8, 48), 0x00c853, 2.3);
    const rim = tintGeometry(new THREE.TorusGeometry(centreRadius + tube * 0.58, tube * 0.14, 6, 48), 0xd6ffd0, 1.7);
    return mergeParts([inner, rim], true);
  });
}

// 24 ticks standing on the rim (every 6th longer), merged to one draw.
function tickGeometry(centreRadius, tube) {
  const key = `${Math.round(centreRadius * 100)}:${Math.round(tube * 100)}`;
  return cached(caches.tickGeo, key, () => {
    const r = centreRadius + tube * 1.05;
    const parts = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1);
    const at = new THREE.Vector3();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const box = new THREE.BoxGeometry(tube * 0.16, tube * (i % 6 === 0 ? 0.85 : 0.5), tube * 0.16);
      at.set(Math.cos(a) * r, Math.sin(a) * r, 0);
      e.set(0, 0, a - Math.PI / 2);
      q.setFromEuler(e);
      m.compose(at, q, one);
      box.applyMatrix4(m);
      parts.push(box);
    }
    return mergeParts(parts, false);
  });
}

// Four V-chevrons inside the rim at the diagonals, tips toward centre,
// as raw triangles in a single geometry.
function chevronGeometry(innerRadius) {
  return cached(caches.chevronGeo, Math.round(innerRadius * 100), () => {
    const hw = innerRadius * 0.15;
    const hh = innerRadius * 0.13;
    const th = innerRadius * 0.055;
    const place = innerRadius - hh * 0.95;
    const arms = [
      [[-hw, hh / 2], [0, -hh / 2], [0, -hh / 2 + th * 1.6], [-hw + th, hh / 2]],
      [[0, -hh / 2], [hw, hh / 2], [hw - th, hh / 2], [0, -hh / 2 + th * 1.6]],
    ];
    const pos = [];
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2 - Math.PI / 2;
      const sin = Math.sin(a);
      const cos = Math.cos(a);
      for (const quad of arms) {
        const corners = quad.map(([x, y]) => {
          const py = y + place;
          return [x * cos - py * sin, x * sin + py * cos];
        });
        for (const vi of [0, 1, 2, 0, 2, 3]) pos.push(corners[vi][0], corners[vi][1], 0);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    return geo;
  });
}

// --------------------------------------------------------------- points

function pointsGeometry(count, place) {
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const tint = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const p = place(i);
    pos[i * 3] = p[0];
    pos[i * 3 + 1] = p[1];
    pos[i * 3 + 2] = p[2];
    size[i] = p[3];
    phase[i] = p[4];
    tint[i] = p[5];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));
  return geo;
}

// Glitter motes orbiting the rim (150, active gate only).
function sparkleGeometry(centreRadius) {
  return cached(caches.sparkleGeo, Math.round(centreRadius * 100), () => {
    const rand = lcg(918273);
    const count = 150;
    return pointsGeometry(count, (i) => {
      const a = (i / count) * Math.PI * 2 + rand() * 0.12;
      const r = centreRadius * (0.94 + rand() * 0.18);
      return [
        Math.cos(a) * r,
        Math.sin(a) * r,
        (rand() - 0.5) * centreRadius * 0.22,
        1.4 + rand() * 3.2,
        rand(),
        rand(),
      ];
    });
  });
}

// Fine motes drifting inside the disc (70), counter-rotating for depth.
function dustGeometry(centreRadius) {
  return cached(caches.dustGeo, Math.round(centreRadius * 100), () => {
    const rand = lcg(517739);
    return pointsGeometry(70, () => {
      const a = rand() * Math.PI * 2;
      const r = centreRadius * Math.sqrt(rand()) * 0.88;
      return [
        Math.cos(a) * r,
        Math.sin(a) * r,
        (rand() - 0.5) * centreRadius * 0.3,
        0.7 + rand() * 1.1,
        rand(),
        rand(),
      ];
    });
  });
}

// One shared twinkle shader for sparkles and dust: per-point size,
// phase and tint; only uTime changes per frame.
function pointsMaterial() {
  if (sparkleMat) return sparkleMat;
  if (!sparkleTex) sparkleTex = makeSparkleTexture();
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  sparkleMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: sparkleTex },
      uPixelRatio: { value: dpr },
      uColorA: { value: new THREE.Color(0xc9ffb0) },
      uColorB: { value: new THREE.Color(0x00c853) },
      uOpacity: { value: 0.95 },
    },
    vertexShader: `
      attribute float aSize;
      attribute float aPhase;
      attribute float aTint;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vTwinkle;
      varying float vTint;
      void main() {
        vTint = aTint;
        float tw = 0.5 + 0.5 * sin(uTime * 2.7 + aPhase * 6.28318);
        vTwinkle = 0.35 + 0.65 * tw;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * (160.0 / max(1.0, -mv.z)) * (0.75 + 0.5 * tw);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uOpacity;
      varying float vTwinkle;
      varying float vTint;
      void main() {
        vec4 tex = texture2D(uMap, gl_PointCoord);
        vec3 col = mix(uColorA, uColorB, vTint) * 1.6;
        gl_FragColor = vec4(col, tex.a * vTwinkle * uOpacity);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  return sparkleMat;
}

function makePoints(name, geo) {
  const pts = new THREE.Points(geo, pointsMaterial());
  pts.name = name;
  pts.renderOrder = 3;
  pts.visible = false;
  pts.frustumCulled = false;
  return pts;
}

// ------------------------------------------------------------ materials

function additiveMat(color, map) {
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  if (map) mat.map = map;
  return mat;
}

function materials() {
  if (sharedMats) return sharedMats;
  if (!haloTex) haloTex = makeHaloTexture();
  sharedMats = {
    haloNext: additiveMat(NEXT_HEX, haloTex),
    haloTodo: additiveMat(TODO_HEX, haloTex),
    glowNext: new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }),
    glowTodo: new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }),
    spriteNext: new THREE.SpriteMaterial({
      map: haloTex, color: NEXT_HEX, transparent: true, opacity: 0.38,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }),
    spriteTodo: new THREE.SpriteMaterial({
      map: haloTex, color: TODO_HEX, transparent: true, opacity: 0.15,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }),
    tickNext: new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x00c853).multiplyScalar(1.8), fog: false,
      transparent: true, opacity: 0.95, depthWrite: false,
    }),
    chevronNext: new THREE.MeshBasicMaterial({
      color: new THREE.Color(CHEVRON_HEX).multiplyScalar(1.5), side: THREE.DoubleSide, fog: false,
      transparent: true, opacity: 0.98, depthWrite: false,
    }),
  };
  // User order 2026-11-27 (clarified): do NOT dim the ring's own lights
  // (torus emissive, glow torus, sparkles stay full) — only the AMBIENT
  // halo field around the ring comes down a little so the hoop reads
  // crisper against its surroundings.
  sharedMats.haloNext.opacity = 0.7;
  sharedMats.haloTodo.opacity = 0.32;
  return sharedMats;
}

// The hoop material is shared per state in world.js (MAT.ringNext /
// MAT.ringTodo), so driving it here is idempotent across rings.
function driveHoop(mesh, state) {
  const mat = mesh && mesh.material;
  if (!mat || !mat.emissive) return;
  if (state === 'next') {
    mat.emissive.setHex(NEXT_HEX);
    mat.emissiveIntensity = NEXT_GLOW;
  } else if (state === 'todo') {
    mat.emissive.setHex(TODO_HEX);
    mat.emissiveIntensity = TODO_GLOW;
  }
}

// ----------------------------------------------------------------- API

/**
 * Hang the gate dressing on a freshly placed ring mesh. `index` is
 * 0-based; the badge shows index + 1 (the HUD's "Ring N"). Starts 'todo'.
 */
export function dressRingGate(mesh, index, innerRadius) {
  if (!mesh) return;
  const params = mesh.geometry && mesh.geometry.parameters;
  const tube = params ? params.tube : innerRadius * 0.08;
  const centreRadius = params ? params.radius : innerRadius + tube;
  const mats = materials();

  const halo = new THREE.Mesh(haloGeometry(centreRadius), mats.haloTodo);
  halo.name = 'ring-gate-halo';
  halo.renderOrder = 2;
  mesh.add(halo);

  const glowRings = new THREE.Mesh(glowRingGeometry(centreRadius, tube), mats.glowTodo);
  glowRings.name = 'ring-gate-glow-rings';
  glowRings.renderOrder = 2;
  mesh.add(glowRings);

  // Billboard halo: active gate only (fill-rate on software renderers).
  const haloSprite = new THREE.Sprite(mats.spriteNext);
  haloSprite.name = 'ring-gate-halo-sprite';
  const spriteSize = centreRadius * 3.4;
  haloSprite.scale.set(spriteSize, spriteSize, 1);
  haloSprite.renderOrder = 2;
  haloSprite.visible = false;
  mesh.add(haloSprite);

  const ticks = new THREE.Mesh(tickGeometry(centreRadius, tube), mats.tickNext);
  ticks.name = 'ring-gate-ticks';
  ticks.renderOrder = 3;
  ticks.visible = false;
  mesh.add(ticks);

  const chevrons = new THREE.Mesh(chevronGeometry(innerRadius), mats.chevronNext);
  chevrons.name = 'ring-gate-chevrons';
  chevrons.position.z = 0.02;
  chevrons.visible = false;
  chevrons.renderOrder = 3;
  mesh.add(chevrons);

  const badge = new THREE.Sprite(new THREE.SpriteMaterial({
    map: badgeTexture(index + 1),
    color: TODO_HEX,
    transparent: true,
    depthWrite: false,
    fog: false,
  }));
  badge.name = 'ring-gate-badge';
  const badgeSize = Math.max(3.4, innerRadius * 0.54);
  badge.scale.set(badgeSize, badgeSize, 1);
  badge.position.set(0, centreRadius + tube + badgeSize * 0.78, 0);
  badge.renderOrder = 4;
  mesh.add(badge);

  const sparkles = makePoints('ring-gate-sparkles', sparkleGeometry(centreRadius));
  mesh.add(sparkles);
  const dust = makePoints('ring-gate-dust', dustGeometry(centreRadius));
  mesh.add(dust);

  mesh.userData.gate = { halo, glowRings, haloSprite, ticks, chevrons, badge, sparkles, dust, state: 'todo' };
  driveHoop(mesh, 'todo');
}

/** Restyle a dressed ring for its state: 'next', 'todo' or 'done'. */
export function styleRingGate(mesh, state) {
  const gate = mesh && mesh.userData ? mesh.userData.gate : null;
  if (!gate) return;
  const mats = materials();
  gate.state = state;
  driveHoop(mesh, state);
  const isNext = state === 'next';
  const isDone = state === 'done';
  gate.halo.visible = !isDone;
  gate.halo.material = isNext ? mats.haloNext : mats.haloTodo;
  gate.glowRings.visible = !isDone;
  gate.glowRings.material = isNext ? mats.glowNext : mats.glowTodo;
  gate.haloSprite.visible = isNext;
  if (isNext) gate.haloSprite.material = mats.spriteNext;
  gate.ticks.visible = isNext;
  gate.chevrons.visible = isNext;
  gate.badge.visible = !isDone;
  if (!isDone) gate.badge.material.color.setHex(isNext ? 0x00c853 : TODO_HEX);
  if (gate.sparkles) gate.sparkles.visible = isNext;
  if (gate.dust) gate.dust.visible = isNext;
}

/**
 * Per-frame life for the active gate, all a pure function of world
 * time: halo/glow pulse, chevrons breathe inward, sparkles orbit,
 * dust counter-rotates, ticks creep, hoop emissive breathes.
 */
export function animateRingGates(rings, timeSeconds) {
  if (!Array.isArray(rings)) return;
  const mats = materials();
  const wave = Math.sin(timeSeconds * 3.1);
  mats.haloNext.opacity = 0.64 + 0.12 * wave;
  mats.glowNext.opacity = 0.9 + 0.1 * Math.sin(timeSeconds * 3.1 + 0.6);
  mats.spriteNext.opacity = 0.38 + 0.08 * wave;
  pointsMaterial().uniforms.uTime.value = timeSeconds;
  for (const ring of rings) {
    const mesh = ring && ring.mesh;
    const gate = mesh && mesh.userData ? mesh.userData.gate : null;
    if (!gate || gate.state !== 'next') continue;
    if (mesh.material && mesh.material.emissive) {
      mesh.material.emissiveIntensity = NEXT_GLOW + 0.45 * wave;
    }
    const inward = 1 - 0.05 * (0.5 + 0.5 * Math.sin(timeSeconds * 4.4));
    gate.chevrons.scale.set(inward, inward, 1);
    if (gate.sparkles) gate.sparkles.rotation.z = timeSeconds * 0.7;
    if (gate.dust) gate.dust.rotation.z = -timeSeconds * 0.32;
    if (gate.ticks) gate.ticks.rotation.z = timeSeconds * 0.12;
  }
}
