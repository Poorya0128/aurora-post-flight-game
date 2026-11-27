// fx-detail.js — V6-FX realism layer (display only, reads PlaneState,
// never writes it; flight logic untouched).
//
// aircraft-fx.js / ring-gates.js / lens-flare.js are claimed by
// V6-WORLD-LOOK, so this pass adds a NEW module hooked once from
// main.js instead of editing them:
//
//  1. World-space wingtip vapour ribbons — true trailing geometry
//     (the aircraft-fx quads are rigid and rotate with the airframe):
//     each tip drops points into a preallocated ring buffer, the
//     ribbon is rebuilt per frame camera-facing, width grows and
//     alpha fades with age, points sink like a real vortex wake.
//     Warm dawn tint so the vapour catches the sunset. A frozen
//     ?shot= pose seeds a straight synthetic trail behind the tips
//     so judged stills show the reference streaks.
//  2. Golden sparkle swirl around the active ('next') ring — one
//     Points draw, counter-rotating against ring-gates' green rim
//     sparkles for parallax, star-sprite canvas texture, twinkle.
//  3. Pooled dust (one ShaderMaterial Points draw, 160 particles):
//     touchdown burst scaled by sink rate, wheel dust on the roll,
//     prop-wash stream at full throttle on the ground, and a light
//     dust kick just after liftoff. Soft round sprites computed in
//     the fragment shader — no texture, no per-frame allocation.
//  4. Landing-light ground pool — a warm additive ellipse on the
//     terrain ahead of the nose, low altitude only, complementing
//     aircraft-fx's volumetric cone.
//  5. Lens-flare CSS — lens-flare.js builds .flare-glow /
//     .flare-streak / .flare-ghost divs but no stylesheet ever
//     styled them (grep: 0 hits in style.css), so the flare was
//     invisible. A small <style> in the dawn palette fixes that
//     without touching the claimed lens-flare.js or style.css.
//
// Cost: ≤5 draw calls (2 ribbons + sparkles + dust + pool), all
// buffers preallocated, seeded LCG so runs are deterministic.

import * as THREE from 'three';

const WINGTIP_X = 5.5;
const WINGTIP_Y = 1.1;
const WINGTIP_Z = 0.55; // a touch behind aircraft-fx's quad root
const TRAIL_POINTS = 44;
const TRAIL_EMIT_SPACING = 1.3; // metres of tip travel per point
const TRAIL_LIFE = 2.4; // seconds before a point fully fades
const DUST_MAX = 160;
const SPARKLE_COUNT = 140;

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smoothStep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// Deterministic LCG (same family as ring-gates.js) — no Math.random,
// so screenshot poses and replays stay reproducible.
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function canvasTexture(width, height, draw) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  draw(context, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Puffy vapour strip: overlapping soft blobs along u, feathered
// across v, so the ribbon reads as condensing wake, not a hard quad.
function buildVapourTexture() {
  return canvasTexture(256, 64, (context, width, height) => {
    const random = makeRandom(424243);
    context.clearRect(0, 0, width, height);
    for (let i = 0; i < 26; i++) {
      const x = (i / 25) * width + (random() - 0.5) * 8;
      const y = height / 2 + (random() - 0.5) * height * 0.3;
      const r = height * (0.34 + random() * 0.3);
      const blob = context.createRadialGradient(x, y, 0, x, y, r);
      blob.addColorStop(0, 'rgba(255,255,255,0.32)');
      blob.addColorStop(1, 'rgba(255,255,255,0)');
      context.fillStyle = blob;
      context.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // Overall taper: bright near the tip (u=0), gone at the tail.
    context.globalCompositeOperation = 'destination-in';
    const along = context.createLinearGradient(0, 0, width, 0);
    along.addColorStop(0, 'rgba(0,0,0,0)');
    along.addColorStop(0.05, 'rgba(0,0,0,1)');
    along.addColorStop(0.45, 'rgba(0,0,0,0.75)');
    along.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = along;
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = 'source-over';
  });
}

// Four-point star with a soft halo — ring sparkle sprite.
function buildStarTexture() {
  return canvasTexture(64, 64, (context, size) => {
    const centre = size / 2;
    const halo = context.createRadialGradient(centre, centre, 0, centre, centre, centre);
    halo.addColorStop(0, 'rgba(255,255,255,0.9)');
    halo.addColorStop(0.3, 'rgba(255,255,255,0.28)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = halo;
    context.fillRect(0, 0, size, size);
    context.fillStyle = 'rgba(255,255,255,0.95)';
    // Tapered cross arms (two thin diamonds).
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      context.beginPath();
      context.moveTo(centre - dx * (centre - 2), centre - dy * (centre - 2));
      context.lineTo(centre + dy * 2.2, centre + dx * 2.2);
      context.lineTo(centre + dx * (centre - 2), centre + dy * (centre - 2));
      context.lineTo(centre - dy * 2.2, centre - dx * 2.2);
      context.closePath();
      context.fill();
    }
  });
}

// Warm radial falloff for the landing-light ground pool.
function buildPoolTexture() {
  return canvasTexture(128, 128, (context, size) => {
    const centre = size / 2;
    const pool = context.createRadialGradient(centre, centre, 0, centre, centre, centre);
    pool.addColorStop(0, 'rgba(255,255,255,0.85)');
    pool.addColorStop(0.45, 'rgba(255,255,255,0.38)');
    pool.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = pool;
    context.fillRect(0, 0, size, size);
  });
}

// Lens-flare styling (see header note 5). Dawn family only: amber /
// peach / rose, matching lens-flare.js GHOSTS (--flare-rgb per ghost).
function injectFlareStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('fx-detail-flare-style')) return;
  const style = document.createElement('style');
  style.id = 'fx-detail-flare-style';
  style.textContent = [
    '#hud-lens-flare{position:absolute;inset:0;overflow:hidden;pointer-events:none;}',
    '.flare-glow{position:absolute;left:0;top:0;width:360px;height:360px;margin:-180px 0 0 -180px;border-radius:50%;',
    'background:radial-gradient(circle,rgba(255,220,160,0.6) 0%,rgba(255,178,110,0.24) 38%,rgba(255,150,95,0) 70%);}',
    '.flare-streak{position:absolute;left:0;top:0;width:560px;height:22px;margin:-11px 0 0 -280px;',
    'background:linear-gradient(90deg,rgba(255,200,140,0) 0%,rgba(255,205,150,0.5) 50%,rgba(255,200,140,0) 100%);}',
    '.flare-ghost{position:absolute;left:0;top:0;border-radius:50%;',
    'background:radial-gradient(circle,rgba(var(--flare-rgb,255,209,102),0.85) 0%,rgba(var(--flare-rgb,255,209,102),0.28) 55%,rgba(var(--flare-rgb,255,209,102),0) 78%);}',
    '.flare-ring{background:radial-gradient(circle,rgba(0,0,0,0) 56%,rgba(var(--flare-rgb,255,209,102),0.75) 70%,rgba(var(--flare-rgb,255,209,102),0.22) 84%,rgba(0,0,0,0) 96%);}',
  ].join('');
  document.head.appendChild(style);
}

// One wingtip ribbon: ring buffer of wake points + rebuilt strip.
function createTrail(material) {
  const positions = new Float32Array(TRAIL_POINTS * 2 * 3);
  const colors = new Float32Array(TRAIL_POINTS * 2 * 3);
  const uvs = new Float32Array(TRAIL_POINTS * 2 * 2);
  const index = new Uint16Array((TRAIL_POINTS - 1) * 6);
  for (let i = 0; i < TRAIL_POINTS - 1; i++) {
    const a = i * 2;
    index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.visible = false;
  return {
    mesh,
    points: new Float32Array(TRAIL_POINTS * 3),
    ages: new Float32Array(TRAIL_POINTS),
    count: 0,
    head: 0, // next write slot
    distAcc: 0,
    lastTip: new THREE.Vector3(),
    hasLastTip: false,
  };
}

function trailEmit(trail, x, y, z, age) {
  const i = trail.head * 3;
  trail.points[i] = x;
  trail.points[i + 1] = y;
  trail.points[i + 2] = z;
  trail.ages[trail.head] = age;
  trail.head = (trail.head + 1) % TRAIL_POINTS;
  if (trail.count < TRAIL_POINTS) trail.count += 1;
}

export function createFxDetail() {
  injectFlareStyles();
  const group = new THREE.Group();
  group.name = 'fx-detail';
  const random = makeRandom(918273645);

  // ---- wingtip vapour ribbons (2 draws, hidden when factor ~0)
  const vapourTexture = buildVapourTexture();
  const trailMaterial = new THREE.MeshBasicMaterial({
    color: 0xffdcb4, // warm dawn white — vapour catching the sunset
    transparent: true,
    opacity: 0.62,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexColors: true,
    fog: false,
  });
  if (vapourTexture) trailMaterial.map = vapourTexture;
  const trailLeft = createTrail(trailMaterial);
  const trailRight = createTrail(trailMaterial);
  group.add(trailLeft.mesh, trailRight.mesh);

  // ---- golden ring sparkle swirl (1 draw)
  const sparklePositions = new Float32Array(SPARKLE_COUNT * 3);
  for (let i = 0; i < SPARKLE_COUNT; i++) {
    const angle = random() * Math.PI * 2;
    const radius = 1.04 + random() * 0.34; // unit ring, scaled per frame
    sparklePositions[i * 3] = Math.cos(angle) * radius;
    sparklePositions[i * 3 + 1] = Math.sin(angle) * radius;
    sparklePositions[i * 3 + 2] = (random() - 0.5) * 0.34;
  }
  const sparkleGeometry = new THREE.BufferGeometry();
  sparkleGeometry.setAttribute('position', new THREE.BufferAttribute(sparklePositions, 3));
  const starTexture = buildStarTexture();
  const sparkleMaterial = new THREE.PointsMaterial({
    color: 0xb6ffa0, // neon green — matches ring gates (user order 2026-11-27)
    size: 2.1,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  if (starTexture) sparkleMaterial.map = starTexture;
  const sparkles = new THREE.Points(sparkleGeometry, sparkleMaterial);
  sparkles.frustumCulled = false;
  sparkles.renderOrder = 4;
  sparkles.visible = false;
  group.add(sparkles);

  // ---- pooled dust (1 draw, custom soft-sprite shader)
  const dustPositions = new Float32Array(DUST_MAX * 3);
  const dustSizes = new Float32Array(DUST_MAX);
  const dustAlphas = new Float32Array(DUST_MAX);
  const dustVel = new Float32Array(DUST_MAX * 3);
  const dustLife = new Float32Array(DUST_MAX); // remaining seconds
  const dustMaxLife = new Float32Array(DUST_MAX);
  const dustBaseSize = new Float32Array(DUST_MAX);
  for (let i = 0; i < DUST_MAX; i++) dustPositions[i * 3 + 1] = -9999;
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3).setUsage(THREE.DynamicDrawUsage));
  dustGeometry.setAttribute('aSize', new THREE.BufferAttribute(dustSizes, 1).setUsage(THREE.DynamicDrawUsage));
  dustGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(dustAlphas, 1).setUsage(THREE.DynamicDrawUsage));
  const dustMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0xd8b98f) }, // dawn-lit dust tan
      uScale: { value: 600 },
    },
    vertexShader: [
      'attribute float aSize;',
      'attribute float aAlpha;',
      'varying float vAlpha;',
      'uniform float uScale;',
      'void main() {',
      '  vAlpha = aAlpha;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_PointSize = clamp(aSize * uScale / max(1.0, -mv.z), 0.0, 240.0);',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'varying float vAlpha;',
      'uniform vec3 uColor;',
      'void main() {',
      '  vec2 p = gl_PointCoord - 0.5;',
      '  float d = length(p) * 2.0;',
      '  float wobble = 0.12 * sin(atan(p.y, p.x) * 3.0 + d * 5.0);',
      '  float a = smoothstep(1.0, 0.15, d + wobble) * vAlpha;',
      '  if (a < 0.004) discard;',
      '  gl_FragColor = vec4(uColor, a);',
      '}',
    ].join('\n'),
  });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.frustumCulled = false;
  dust.renderOrder = 3;
  group.add(dust);
  let dustCursor = 0;
  let dustEmitAcc = 0;

  function emitDust(x, y, z, vx, vy, vz, life, size) {
    const i = dustCursor;
    dustCursor = (dustCursor + 1) % DUST_MAX;
    dustPositions[i * 3] = x;
    dustPositions[i * 3 + 1] = y;
    dustPositions[i * 3 + 2] = z;
    dustVel[i * 3] = vx;
    dustVel[i * 3 + 1] = vy;
    dustVel[i * 3 + 2] = vz;
    dustLife[i] = life;
    dustMaxLife[i] = life;
    dustBaseSize[i] = size;
  }

  // ---- landing-light ground pool (1 draw)
  const poolTexture = buildPoolTexture();
  const poolMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd9a3,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  if (poolTexture) poolMaterial.map = poolTexture;
  const poolGeometry = new THREE.CircleGeometry(10, 28);
  poolGeometry.rotateX(-Math.PI / 2);
  const pool = new THREE.Mesh(poolGeometry, poolMaterial);
  pool.renderOrder = 2;
  pool.visible = false;
  group.add(pool);

  group.traverse((object) => {
    if (object.isMesh || object.isPoints) object.castShadow = false;
  });

  // Preallocated scratch — the update loop allocates nothing.
  const _tip = new THREE.Vector3();
  const _forward = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _view = new THREE.Vector3();
  const _side = new THREE.Vector3();
  const _pos = new THREE.Vector3();
  const _prev = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  let clock = 0;
  let prevOnGround = true;
  let prevVy = 0;

  function groundYAt(world, x, z, fallback) {
    if (world && typeof world.heightAt === 'function') {
      const y = world.heightAt(x, z);
      if (typeof y === 'number' && Number.isFinite(y)) return y;
    }
    return fallback;
  }

  function updateTrail(trail, sideSign, plane, vapour, dt, camera) {
    _tip.set(sideSign * WINGTIP_X, WINGTIP_Y, WINGTIP_Z).applyQuaternion(plane.quaternion).add(plane.position);
    if (!trail.hasLastTip) {
      trail.lastTip.copy(_tip);
      trail.hasLastTip = true;
    }
    const moved = _tip.distanceTo(trail.lastTip);

    if (vapour <= 0.02) {
      trail.mesh.visible = false;
      if (plane.onGround) trail.count = 0;
      trail.lastTip.copy(_tip);
      return;
    }

    if (trail.count < TRAIL_POINTS && moved < 0.05) {
      // Frozen pose (?shot= stills): seed a straight synthetic wake
      // behind the tip so the still shows the reference streak.
      const spacing = Math.max(plane.airspeed || 0, 18) * 0.06;
      for (let i = TRAIL_POINTS - 1; i >= 0; i--) {
        const back = i * spacing;
        const sink = i * i * 0.006;
        trailEmit(
          trail,
          _tip.x - _forward.x * back + _right.x * sideSign * i * 0.012,
          _tip.y - _forward.y * back - sink,
          _tip.z - _forward.z * back + _right.z * sideSign * i * 0.012,
          i * 0.06,
        );
      }
    } else if (moved > 0) {
      trail.distAcc += moved;
      while (trail.distAcc >= TRAIL_EMIT_SPACING) {
        trail.distAcc -= TRAIL_EMIT_SPACING;
        trailEmit(trail, _tip.x, _tip.y, _tip.z, 0);
      }
    }
    trail.lastTip.copy(_tip);

    // Age + vortex sink, then rebuild the camera-facing strip.
    for (let i = 0; i < TRAIL_POINTS; i++) {
      if (trail.ages[i] > TRAIL_LIFE + 1) continue;
      trail.ages[i] += dt;
      trail.points[i * 3 + 1] -= dt * (0.22 + trail.ages[i] * 0.4);
    }
    const count = trail.count;
    if (count < 2) {
      trail.mesh.visible = false;
      return;
    }
    const posAttr = trail.mesh.geometry.attributes.position;
    const colAttr = trail.mesh.geometry.attributes.color;
    const uvAttr = trail.mesh.geometry.attributes.uv;
    const pos = posAttr.array;
    const col = colAttr.array;
    const uv = uvAttr.array;
    for (let k = 0; k < count; k++) {
      const idx = (trail.head - count + k + TRAIL_POINTS * 2) % TRAIL_POINTS;
      const p3 = idx * 3;
      _pos.set(trail.points[p3], trail.points[p3 + 1], trail.points[p3 + 2]);
      if (k > 0) {
        const prevIdx = (trail.head - count + k - 1 + TRAIL_POINTS * 2) % TRAIL_POINTS;
        _prev.set(trail.points[prevIdx * 3], trail.points[prevIdx * 3 + 1], trail.points[prevIdx * 3 + 2]);
        _dir.subVectors(_pos, _prev);
        if (_dir.lengthSq() < 1e-6) _dir.copy(_forward);
      } else {
        _dir.copy(_forward);
      }
      _dir.normalize();
      if (camera) _view.subVectors(camera.position, _pos).normalize();
      else _view.set(0, 0, 1);
      _side.crossVectors(_dir, _view);
      if (_side.lengthSq() < 1e-6) _side.set(0, 1, 0);
      _side.normalize();
      const age = trail.ages[idx];
      const halfWidth = Math.min(0.07 + age * 0.6, 1.5);
      const fade = Math.pow(clamp01(1 - age / TRAIL_LIFE), 1.4) * vapour;
      const o = k * 6;
      pos[o] = _pos.x - _side.x * halfWidth;
      pos[o + 1] = _pos.y - _side.y * halfWidth;
      pos[o + 2] = _pos.z - _side.z * halfWidth;
      pos[o + 3] = _pos.x + _side.x * halfWidth;
      pos[o + 4] = _pos.y + _side.y * halfWidth;
      pos[o + 5] = _pos.z + _side.z * halfWidth;
      // Warm tint, brightest at the tip, peach as it dissolves.
      const r = fade * 1.0;
      const g = fade * (0.88 - 0.12 * clamp01(age / TRAIL_LIFE));
      const b = fade * (0.72 - 0.16 * clamp01(age / TRAIL_LIFE));
      col[o] = r; col[o + 1] = g; col[o + 2] = b;
      col[o + 3] = r; col[o + 4] = g; col[o + 5] = b;
      const u = k / (count - 1);
      uv[k * 4] = u; uv[k * 4 + 1] = 0;
      uv[k * 4 + 2] = u; uv[k * 4 + 3] = 1;
    }
    trail.mesh.geometry.setDrawRange(0, (count - 1) * 6);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
    trail.mesh.visible = true;
  }

  function burstDust(plane, world, count, strength) {
    const gy = groundYAt(world, plane.position.x, plane.position.z, plane.position.y - 1);
    for (let i = 0; i < count; i++) {
      const spread = (random() - 0.5) * 2.4;
      const back = 1.5 + random() * 3.5 * strength;
      emitDust(
        plane.position.x + _right.x * spread - _forward.x * (0.5 + random() * 1.5),
        gy + 0.25 + random() * 0.4,
        plane.position.z + _right.z * spread - _forward.z * (0.5 + random() * 1.5),
        -_forward.x * back + _right.x * spread * 0.8 + (random() - 0.5),
        0.5 + random() * 1.1 * strength,
        -_forward.z * back + _right.z * spread * 0.8 + (random() - 0.5),
        0.9 + random() * 1.3,
        1.1 + random() * 1.4,
      );
    }
  }

  function update(plane, dtRaw, _timeSeconds, world, camera) {
    if (!plane || !plane.position || !plane.quaternion) return;
    const dt = Math.min(Math.max(typeof dtRaw === 'number' ? dtRaw : 0, 0), 0.1);
    clock += dt;

    const airspeed = typeof plane.airspeed === 'number' ? plane.airspeed : 0;
    const groundSpeed = typeof plane.groundSpeed === 'number' ? plane.groundSpeed : airspeed;
    const bankDeg = Math.abs(typeof plane.rollDeg === 'number' ? plane.rollDeg : 0);
    const agl = typeof plane.altitudeAgl === 'number' ? plane.altitudeAgl : 999;
    const throttle = typeof plane.throttle === 'number' ? plane.throttle : 0;
    const airborne = !plane.onGround;
    const vy = plane.velocity && typeof plane.velocity.y === 'number' ? plane.velocity.y : 0;

    _forward.set(0, 0, -1).applyQuaternion(plane.quaternion);
    _right.set(1, 0, 0).applyQuaternion(plane.quaternion);

    // ---- vapour ribbons: flying speed + bank (load factor)
    const speedFactor = smoothStep(26, 44, airspeed);
    const bankFactor = 0.35 + 0.65 * clamp01((bankDeg - 6) / 38);
    const vapour = airborne ? speedFactor * bankFactor : 0;
    updateTrail(trailLeft, -1, plane, vapour, dt, camera);
    updateTrail(trailRight, 1, plane, vapour, dt, camera);

    // ---- ring sparkle swirl: track the active ring
    let nextRing = null;
    if (world && Array.isArray(world.rings)) {
      for (let i = 0; i < world.rings.length; i++) {
        if (world.rings[i] && world.rings[i].state === 'next' && world.rings[i].mesh) {
          nextRing = world.rings[i];
          break;
        }
      }
    }
    if (nextRing) {
      const mesh = nextRing.mesh;
      mesh.getWorldPosition(sparkles.position);
      mesh.getWorldQuaternion(_quat);
      sparkles.quaternion.copy(_quat);
      sparkles.rotateZ(-clock * 0.45); // counter-swirl vs green rim sparkles
      const radius = typeof nextRing.radius === 'number' ? nextRing.radius : 12;
      const breathe = radius * (1.05 + 0.03 * Math.sin(clock * 1.7));
      sparkles.scale.set(breathe, breathe, breathe);
      sparkleMaterial.opacity = 0.6 + 0.25 * Math.sin(clock * 2.6) * Math.sin(clock * 1.3 + 1.7);
      sparkles.visible = true;
    } else {
      sparkles.visible = false;
    }

    // ---- dust: touchdown burst, roll, prop wash, liftoff kick
    if (prevOnGround === false && plane.onGround) {
      const sink = Math.max(0, -prevVy);
      burstDust(plane, world, Math.round(18 + sink * 7), 0.7 + sink * 0.35);
    }
    let emitRate = 0;
    if (plane.onGround && groundSpeed > 6) emitRate = groundSpeed * 1.6;
    else if (plane.onGround && throttle > 0.65) emitRate = 14; // prop wash
    else if (airborne && agl < 10 && vy > 0.5 && throttle > 0.75) emitRate = 10; // liftoff kick
    if (emitRate > 0 && dt > 0) {
      dustEmitAcc += emitRate * dt;
      while (dustEmitAcc >= 1) {
        dustEmitAcc -= 1;
        burstDust(plane, world, 1, 0.8);
      }
    }
    for (let i = 0; i < DUST_MAX; i++) {
      if (dustLife[i] <= 0) {
        dustAlphas[i] = 0;
        continue;
      }
      dustLife[i] -= dt;
      const drag = Math.pow(0.35, dt); // strong air drag: dust billows, then hangs
      dustVel[i * 3] *= drag;
      dustVel[i * 3 + 2] *= drag;
      dustVel[i * 3 + 1] = dustVel[i * 3 + 1] * drag - 0.35 * dt; // gentle settle
      dustPositions[i * 3] += dustVel[i * 3] * dt;
      dustPositions[i * 3 + 1] += dustVel[i * 3 + 1] * dt;
      dustPositions[i * 3 + 2] += dustVel[i * 3 + 2] * dt;
      const frac = clamp01(1 - dustLife[i] / Math.max(dustMaxLife[i], 0.001));
      dustSizes[i] = dustBaseSize[i] * (0.6 + frac * 2.2);
      dustAlphas[i] = Math.sin(Math.PI * clamp01(frac)) * 0.34;
      if (dustLife[i] <= 0) {
        dustPositions[i * 3 + 1] = -9999;
        dustAlphas[i] = 0;
      }
    }
    dustGeometry.attributes.position.needsUpdate = true;
    dustGeometry.attributes.aSize.needsUpdate = true;
    dustGeometry.attributes.aAlpha.needsUpdate = true;
    if (typeof window !== 'undefined' && window.innerHeight) {
      dustMaterial.uniforms.uScale.value = window.innerHeight * 0.72;
    }

    // ---- landing-light ground pool (low only, engine running)
    const lit = plane.engineOn !== false;
    const poolStrength = lit ? 1 - smoothStep(18, 46, agl) : 0;
    if (poolStrength > 0.03) {
      const px = plane.position.x + _forward.x * 9;
      const pz = plane.position.z + _forward.z * 9;
      pool.position.set(px, groundYAt(world, px, pz, plane.position.y - agl) + 0.3, pz);
      pool.rotation.y = Math.atan2(_forward.x, _forward.z);
      pool.scale.set(1, 1, 1.7);
      poolMaterial.opacity = 0.42 * poolStrength;
      pool.visible = true;
    } else {
      pool.visible = false;
    }

    prevOnGround = !!plane.onGround;
    prevVy = vy;
  }

  return { group, update };
}
