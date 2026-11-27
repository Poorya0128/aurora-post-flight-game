// aircraft-fx.js — effects mounted on the exterior aircraft group.
//
// Two systems, both driven read-only from the flight state:
//   * Wingtip vapour: per tip, two crossed additive ribbon strips
//     (16 segments, swell-then-taper width, slight wake-settle droop,
//     seeded breakup jitter growing aft) plus a pre-allocated particle
//     layer of 110 soft puffs that stream behind the tip, expand,
//     sink and drift outward like a vortex wake. Brightness and
//     emission scale with airspeed and bank (load factor). Particles
//     are pre-seeded along the trail so a frozen first frame already
//     shows a developed streak.
//   * Landing light: a warm glare quad + emissive lens disc in the
//     left wing's leading edge, with a vertex-faded volumetric beam
//     cone that only shows low on approach / climb-out.
//
// Local axes match aircraft.js: forward -Z, right +X, up +Y. All
// buffers are allocated once; update() allocates nothing.

import * as THREE from 'three';

const TIP = { x: 5.5, y: 1.1, z: 0.25 };   // wingtip anchor (just aft of the tip)
const TRAIL_LEN = 28;                      // ribbon length, metres
const TRAIL_W0 = 0.12;                     // ribbon width at the tip
const TRAIL_W1 = 1.15;                     // ribbon width at the tail
const TRAIL_SEGS = 16;
const PUFFS = 110;                         // particles per tip
const LAMP = new THREE.Vector3(-3.0, 0.97, -1.36); // left-wing lamp position
const BEAM_LEN = 28;
const BEAM_R = 4.2;
const BEAM_AGL = 70;                       // beam fades out above this height

const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => {
  const t = sat((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Deterministic LCG: screenshot poses must be reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function paint(w, h, painter) {
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

// ------------------------------------------------------------- textures

// Ribbon gradient: u along the trail (bright core just aft of the tip,
// dissolving to the tail), v across it (feathered long edges).
function ribbonTexture() {
  return paint(128, 32, (ctx, w, h) => {
    const along = ctx.createLinearGradient(0, 0, w, 0);
    along.addColorStop(0, 'rgba(255,255,255,0)');
    along.addColorStop(0.06, 'rgba(255,255,255,0.95)');
    along.addColorStop(0.3, 'rgba(255,255,255,0.6)');
    along.addColorStop(0.7, 'rgba(255,255,255,0.18)');
    along.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = along;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-in';
    const across = ctx.createLinearGradient(0, 0, 0, h);
    across.addColorStop(0, 'rgba(0,0,0,0)');
    across.addColorStop(0.5, 'rgba(0,0,0,1)');
    across.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = across;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  });
}

// Lamp glare: radial warm core plus a thin horizontal anamorphic streak.
function glareTexture() {
  return paint(128, 128, (ctx, w) => {
    const c = w / 2;
    const core = ctx.createRadialGradient(c, c, 0, c, c, c);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.12, 'rgba(255,250,235,0.85)');
    core.addColorStop(0.4, 'rgba(255,230,190,0.22)');
    core.addColorStop(1, 'rgba(255,220,170,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, w, w);
    const streak = ctx.createLinearGradient(0, 0, w, 0);
    streak.addColorStop(0, 'rgba(255,240,210,0)');
    streak.addColorStop(0.5, 'rgba(255,240,210,0.7)');
    streak.addColorStop(1, 'rgba(255,240,210,0)');
    ctx.fillStyle = streak;
    ctx.fillRect(0, c - 2, w, 4);
  });
}

// -------------------------------------------------------------- geometry

// One tapered ribbon in the plane spanned by +Z and the (sx, sy) spread
// axis. Centreline droops (wake settle) and jitters sideways with an
// amplitude that grows toward the tail.
function ribbonGeometry(sx, sy, seed) {
  const rand = lcg(seed);
  const rows = TRAIL_SEGS + 1;
  const pos = new Float32Array(rows * 6);
  const uv = new Float32Array(rows * 4);
  const idx = [];
  for (let i = 0; i < rows; i++) {
    const t = i / TRAIL_SEGS;
    const swell = 1 + 0.3 * Math.sin(Math.PI * Math.min(t * 1.2, 1));
    const half = (TRAIL_W0 + (TRAIL_W1 - TRAIL_W0) * Math.pow(t, 0.8)) * 0.5 * swell;
    const jitter = (rand() - 0.5) * 0.55 * t;
    // jitter runs perpendicular to the spread axis: (sy, sx)
    const cx = sy * jitter;
    const cy = -0.55 * t * t + sx * jitter;
    const z = t * TRAIL_LEN;
    const b = i * 6;
    pos[b] = cx - sx * half;
    pos[b + 1] = cy - sy * half;
    pos[b + 2] = z;
    pos[b + 3] = cx + sx * half;
    pos[b + 4] = cy + sy * half;
    pos[b + 5] = z;
    const u = i * 4;
    uv[u] = t;
    uv[u + 1] = 0;
    uv[u + 2] = t;
    uv[u + 3] = 1;
    if (i < TRAIL_SEGS) {
      const v = i * 2;
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

// Open cone with its apex at the lamp, opening forward (-Z). Vertex
// colours fall from warm white to black; additive blending turns
// black into "nothing", so the beam dissolves with no texture.
function beamGeometry() {
  const geo = new THREE.ConeGeometry(BEAM_R, BEAM_LEN, 20, 6, true);
  geo.translate(0, -BEAM_LEN / 2, 0); // apex to origin
  geo.rotateX(Math.PI / 2);          // base (was -Y) swings to -Z: opens forward
  const attr = geo.attributes.position;
  const col = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    const fade = Math.pow(1 - sat(-attr.getZ(i) / BEAM_LEN), 2.2);
    col[i * 3] = fade;
    col[i * 3 + 1] = fade * 0.94;
    col[i * 3 + 2] = fade * 0.82;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// ------------------------------------------------------------ particles

// Soft round puffs: radial falloff in the fragment shader, per-particle
// size/alpha/tint attributes. Tint runs sun-lit white -> peach -> pink.
function puffMaterial() {
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  return new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: dpr }, uVapour: { value: 0 } },
    vertexShader: `
      attribute float aSize;
      attribute float aAlpha;
      attribute float aTint;
      uniform float uPixelRatio;
      varying float vAlpha;
      varying float vTint;
      void main() {
        vAlpha = aAlpha;
        vTint = aTint;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * (220.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uVapour;
      varying float vAlpha;
      varying float vTint;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        float soft = smoothstep(0.5, 0.1, d);
        vec3 white = vec3(1.0, 0.97, 0.92);
        vec3 peach = vec3(1.0, 0.82, 0.64);
        vec3 pink = vec3(1.0, 0.74, 0.70);
        vec3 col = vTint < 0.5 ? mix(white, peach, vTint * 2.0) : mix(peach, pink, (vTint - 0.5) * 2.0);
        gl_FragColor = vec4(col, soft * vAlpha * uVapour);
      }`,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    fog: false,
  });
}

// Ring-buffer particle set for one wingtip, stepped on the CPU in
// aircraft-local space. Airflow runs +Z; puffs drift outward and sink.
function tipPuffs(side, material) {
  const rand = lcg(side < 0 ? 424243 : 987123);
  const pos = new Float32Array(PUFFS * 3);
  const vel = new Float32Array(PUFFS * 3);
  const size = new Float32Array(PUFFS);
  const alpha = new Float32Array(PUFFS);
  const tint = new Float32Array(PUFFS);
  const age = new Float32Array(PUFFS);
  const life = new Float32Array(PUFFS);
  const base = new Float32Array(PUFFS);

  function spawn(i, preAged) {
    life[i] = 0.8 + rand() * 0.7;
    age[i] = preAged ? rand() * life[i] : 0;
    base[i] = 0.55 + rand() * 0.8;
    tint[i] = rand();
    vel[i * 3] = side * (0.4 + rand() * 0.7);
    vel[i * 3 + 1] = -0.35 - rand() * 0.4;
    vel[i * 3 + 2] = 14 + rand() * 10;
    pos[i * 3] = vel[i * 3] * age[i] + (rand() - 0.5) * 0.2;
    pos[i * 3 + 1] = vel[i * 3 + 1] * age[i] + (rand() - 0.5) * 0.2;
    pos[i * 3 + 2] = vel[i * 3 + 2] * age[i];
  }
  for (let i = 0; i < PUFFS; i++) spawn(i, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));
  const points = new THREE.Points(geo, material);
  points.name = side < 0 ? 'vapour-puffs-left' : 'vapour-puffs-right';
  points.frustumCulled = false;
  points.renderOrder = 2;

  let cursor = 0;
  let owed = 0;

  function step(dt, vapour, airspeed) {
    owed += vapour * 80 * dt; // emission rate follows the G factor
    while (owed >= 1) {
      owed -= 1;
      spawn(cursor, false);
      // New puffs take on a share of the airflow speed so the stream
      // stretches as the aircraft goes faster.
      vel[cursor * 3 + 2] = 8 + airspeed * 0.55 + rand() * 6;
      cursor = (cursor + 1) % PUFFS;
    }
    for (let i = 0; i < PUFFS; i++) {
      age[i] += dt;
      if (age[i] >= life[i]) {
        alpha[i] = 0;
        size[i] = 0;
        continue;
      }
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      vel[i * 3 + 2] *= 1 - 0.35 * dt; // wake drag
      const f = age[i] / life[i];
      size[i] = base[i] * (0.6 + 2.1 * f);
      alpha[i] = Math.pow(Math.sin(Math.PI * Math.min(f * 1.15, 1)), 0.8) * 0.58;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
    geo.attributes.aTint.needsUpdate = true;
  }

  return { points, step };
}

// ---------------------------------------------------------------- build

/**
 * Build the exterior effects. Returns { group, update(plane, dt?) } —
 * add the group to the exterior aircraft group so it inherits the pose.
 */
export function buildExteriorEffects() {
  const group = new THREE.Group();
  group.name = 'aircraft-fx';

  // --- vapour: crossed ribbons + puffs at each tip
  const ribbonMat = new THREE.MeshBasicMaterial({
    color: 0xfff2e0, // warm dawn white, like sun-lit vapour
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const rTex = ribbonTexture();
  if (rTex) ribbonMat.map = rTex;
  const flatGeo = ribbonGeometry(1, 0, 135791);
  const edgeGeo = ribbonGeometry(0, 1, 246802);
  const puffMat = puffMaterial();
  const vapourGroup = new THREE.Group();
  vapourGroup.name = 'wingtip-vapour';
  const emitters = [];
  for (const side of [-1, 1]) {
    const tip = new THREE.Group();
    tip.position.set(side * TIP.x, TIP.y, TIP.z);
    tip.add(new THREE.Mesh(flatGeo, ribbonMat));
    tip.add(new THREE.Mesh(edgeGeo, ribbonMat));
    const puffs = tipPuffs(side, puffMat);
    tip.add(puffs.points);
    emitters.push(puffs);
    vapourGroup.add(tip);
  }
  vapourGroup.visible = false;
  group.add(vapourGroup);

  // --- landing light: forward glare quad (back-face culled, so the
  // chase camera never sees the lamp shine through the wing)
  const glareMat = new THREE.MeshBasicMaterial({
    color: 0xfff1d6,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });
  const gTex = glareTexture();
  if (gTex) glareMat.map = gTex;
  const glareGeo = new THREE.PlaneGeometry(1.6, 1.6);
  glareGeo.rotateY(Math.PI); // face forward (-Z)
  const glare = new THREE.Mesh(glareGeo, glareMat);
  glare.position.copy(LAMP);
  glare.position.z -= 0.02;
  group.add(glare);

  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0.11,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(beamGeometry(), beamMat);
  beam.position.copy(LAMP);
  beam.rotation.x = THREE.MathUtils.degToRad(-4); // dipped below the flight path
  group.add(beam);

  // --- physical lamp hardware: dark bezel + emissive glass disc, so
  // the light reads as a fitting in exterior shots, not just glare.
  const lampGroup = new THREE.Group();
  lampGroup.name = 'landing-light-lens';
  const bezel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.11, 0.13, 0.05, 14),
    new THREE.MeshStandardMaterial({ color: 0x232a33, roughness: 0.4, metalness: 0.65, envMapIntensity: 0.8, flatShading: true }),
  );
  bezel.rotation.x = Math.PI / 2;
  lampGroup.add(bezel);
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0xfff1d6, emissive: 0xffd9a0, emissiveIntensity: 2.4,
    roughness: 0.12, metalness: 0.2, envMapIntensity: 1.4,
  });
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.095, 18), lensMat);
  lens.rotation.y = Math.PI;
  lens.position.z = -0.028;
  lampGroup.add(lens);
  lampGroup.position.copy(LAMP);
  group.add(lampGroup);

  group.traverse((o) => {
    if (o.isMesh) o.castShadow = false;
  });

  let lastMs = null;

  function update(plane, dtSeconds) {
    if (!plane) return;
    // dt may be passed in; otherwise derive it from an internal clock.
    // Clamped so tab-switches / frozen poses never teleport particles.
    let dt = typeof dtSeconds === 'number' && dtSeconds > 0 ? dtSeconds : 0;
    if (!dt) {
      const now = typeof performance !== 'undefined' ? performance.now() : 0;
      dt = lastMs === null ? 1 / 60 : Math.min(Math.max((now - lastMs) / 1000, 0), 0.05);
      lastMs = now;
    }

    const airspeed = typeof plane.airspeed === 'number' ? plane.airspeed : 0;
    const bank = Math.abs(typeof plane.rollDeg === 'number' ? plane.rollDeg : 0);
    const agl = typeof plane.altitudeAgl === 'number' ? plane.altitudeAgl : 999;

    // Vapour needs speed; bank (load factor) thickens it.
    const vapour = plane.onGround ? 0 : smooth(28, 46, airspeed) * (0.3 + 0.7 * sat((bank - 8) / 40));
    ribbonMat.opacity = vapour * 0.95;
    vapourGroup.visible = vapour > 0.02;
    puffMat.uniforms.uVapour.value = Math.min(1, vapour * 1.4);
    if (vapourGroup.visible) {
      for (const e of emitters) e.step(dt, vapour, airspeed);
    }

    // Lamp lit whenever the engine runs; beam only down low.
    const lit = plane.engineOn !== false;
    glare.visible = lit;
    lensMat.emissiveIntensity = lit ? 2.4 : 0.05;
    const beamAmt = lit ? 1 - smooth(BEAM_AGL * 0.6, BEAM_AGL, agl) : 0;
    beamMat.opacity = 0.11 * beamAmt;
    beam.visible = beamAmt > 0.02;
  }

  return { group, update };
}
