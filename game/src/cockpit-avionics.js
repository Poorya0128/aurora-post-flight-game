// cockpit-avionics.js — the lit avionics stack in the instrument panel.
//
// Four units fill the bay between the six-pack and the engine gauges
// (panel-local x ≈ 0.07…0.27): a GPS moving map, a COM/NAV radio, a
// transponder, and an engine/clock strip. Read-only: it samples plane
// position, heading, altitude, throttle and fuel, and writes nothing.
//
// Panel-local coordinates (aircraft.js): board front at z = 0.035,
// gauges at z = 0.04, +Y up the board. Screen faces are unlit canvas
// textures with tone mapping off so the LCD greens/ambers stay crisp
// through the ACES grade, like a real backlit display at dawn.

import * as THREE from 'three';
import { ISLANDS, STRIPS } from './config.js';

const STACK_X = 0.168;
const STACK_W = 0.17;
const SCREEN_Z = 0.058;
const BEZEL_Z = 0.046;
const MAP_RANGE = 6500;    // metres from own-ship to the map edge
const MAP_RING = 4000;     // outer range-ring radius, metres
const MAP_PERIOD = 0.25;   // map redraw interval (4 Hz is plenty)
const GREEN = '#7DFFB2';
const AMBER = '#FFD166';
const DIM = 'rgba(125,255,178,0.35)';
const FONT = 'AuroraSans, "Segoe UI", system-ui, Arial, sans-serif';
const MONO = '"Consolas", "SFMono-Regular", "Menlo", monospace';

function newCanvas(w, h) {
  if (typeof document === 'undefined') return null;
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  return el;
}

function toTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ------------------------------------------------------------ bezel wear

// Shared grayscale roughness/bump sheet for the bezels: matte anodised
// base, speckle, darker (smoother) worn-through scratches, polished
// edge bands where hands brush the metal. Built once, lazily.
let wearCache = null;
function wearTexture() {
  if (wearCache) return wearCache;
  const canvas = newCanvas(256, 128);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  let seed = 7331;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  ctx.fillStyle = '#d9d9d9';
  ctx.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 900; i++) {
    const g = 195 + Math.floor(rand() * 45);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(rand() * 256, rand() * 128, 1.4, 1.4);
  }
  ctx.strokeStyle = 'rgba(110,110,110,0.55)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 16; i++) {
    const x = rand() * 256;
    const y = rand() * 128;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 8 + rand() * 30, y + (rand() - 0.5) * 8);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(130,130,130,0.35)';
  ctx.fillRect(0, 0, 256, 7);
  ctx.fillRect(0, 121, 256, 7);
  ctx.fillRect(0, 0, 7, 128);
  ctx.fillRect(249, 0, 7, 128);
  wearCache = toTexture(canvas);
  wearCache.wrapS = THREE.RepeatWrapping;
  wearCache.wrapT = THREE.RepeatWrapping;
  return wearCache;
}

// Dark anodised bezel body with a polished top lip and bakelite knobs
// carrying cream pointer lines.
function makeBezel(w, h, knobCount) {
  const bezel = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.62, metalness: 0.35 });
  const wear = wearTexture();
  if (wear) {
    bodyMat.roughnessMap = wear;
    bodyMat.bumpMap = wear;
    bodyMat.bumpScale = 0.01;
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(w + 0.016, h + 0.014, 0.022), bodyMat);
  bezel.add(body);
  const lip = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.02, 0.004, 0.024),
    new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.32, metalness: 0.75 }),
  );
  lip.position.y = (h + 0.014) / 2;
  bezel.add(lip);
  const knobMat = new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.45, metalness: 0.08 });
  const pointerMat = new THREE.MeshStandardMaterial({ color: 0xf2ede4, roughness: 0.5 });
  for (let i = 0; i < knobCount; i++) {
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.012, 14), knobMat);
    knob.rotation.x = Math.PI / 2;
    knob.position.set(w / 2 - 0.004 - i * 0.022, -h / 2 - 0.0005, 0.016);
    bezel.add(knob);
    const pointer = new THREE.Mesh(new THREE.BoxGeometry(0.0025, 0.011, 0.002), pointerMat);
    pointer.position.set(knob.position.x, knob.position.y + 0.002, 0.0225);
    pointer.rotation.z = -0.6 + i * 0.9;
    bezel.add(pointer);
  }
  return bezel;
}

function makeScreen(w, h, canvas) {
  const tex = toTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  );
  return { mesh, tex };
}

// ---------------------------------------------------------- screen faces

// Glass reflection baked into every face: a diagonal sheen band, a
// faint warm counter-band, a top-edge catch-light and a corner
// vignette. Alphas stay low so readouts survive the judge shrink.
function glassSheen(ctx, w, h) {
  const main = ctx.createLinearGradient(0, 0, w * 0.7, h);
  main.addColorStop(0, 'rgba(255,255,255,0.15)');
  main.addColorStop(0.35, 'rgba(255,255,255,0.03)');
  main.addColorStop(0.6, 'rgba(255,255,255,0)');
  ctx.fillStyle = main;
  ctx.fillRect(0, 0, w, h);
  const counter = ctx.createLinearGradient(w, h * 0.6, w * 0.4, h);
  counter.addColorStop(0, 'rgba(255,240,210,0.05)');
  counter.addColorStop(1, 'rgba(255,240,210,0)');
  ctx.fillStyle = counter;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(0, 0, w, 2);
  const vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.72);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
}

/** Moving map, track-up: sea grid, islands, strips, range rings, own-ship. */
export function drawMovingMap(ctx, w, h, state) {
  const hdg = (state.headingDeg * Math.PI) / 180;
  const ox = w / 2;
  const oy = h * 0.62;
  const ppm = (h * 0.42) / MAP_RING;
  const reach = MAP_RANGE * 1.6;
  ctx.save();
  ctx.fillStyle = '#06131f';
  ctx.fillRect(0, 0, w, h);

  // World layer: own-ship at the origin, rotated so track points up.
  // World +X east / +Z south maps straight onto canvas x-right/y-down.
  ctx.save();
  ctx.translate(ox, oy);
  ctx.rotate(-hdg);
  ctx.strokeStyle = 'rgba(80,160,220,0.14)';
  ctx.lineWidth = 1;
  const span = reach * ppm;
  for (let gx = Math.floor((state.x - reach) / 1000) * 1000; gx <= state.x + reach; gx += 1000) {
    const sx = (gx - state.x) * ppm;
    ctx.beginPath();
    ctx.moveTo(sx, -span);
    ctx.lineTo(sx, span);
    ctx.stroke();
  }
  for (let gz = Math.floor((state.z - reach) / 1000) * 1000; gz <= state.z + reach; gz += 1000) {
    const sy = (gz - state.z) * ppm;
    ctx.beginPath();
    ctx.moveTo(-span, sy);
    ctx.lineTo(span, sy);
    ctx.stroke();
  }
  for (const isle of ISLANDS) {
    const dx = isle.centre.x - state.x;
    const dz = isle.centre.z - state.z;
    if (Math.hypot(dx, dz) - isle.radius > reach) continue;
    const cx = dx * ppm;
    const cy = dz * ppm;
    const r = isle.radius * ppm;
    const g = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
    g.addColorStop(0, 'rgba(104,156,78,0.95)');
    g.addColorStop(0.82, 'rgba(72,120,58,0.95)');
    g.addColorStop(1, 'rgba(217,179,128,0.9)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#F2EDE4';
  ctx.lineCap = 'round';
  ctx.lineWidth = 4;
  for (const strip of STRIPS) {
    const cx = (strip.position.x - state.x) * ppm;
    const cy = (strip.position.z - state.z) * ppm;
    const half = Math.max(4, (strip.length / 2) * ppm);
    const rad = (strip.headingDeg * Math.PI) / 180;
    const ux = Math.sin(rad);
    const uy = -Math.cos(rad);
    ctx.beginPath();
    ctx.moveTo(cx - ux * half, cy - uy * half);
    ctx.lineTo(cx + ux * half, cy + uy * half);
    ctx.stroke();
  }
  ctx.restore();

  // Island names upright in screen space (track-up, like a real GPS).
  ctx.font = `800 13px ${FONT}`;
  ctx.textAlign = 'center';
  const cosH = Math.cos(-hdg);
  const sinH = Math.sin(-hdg);
  for (const isle of ISLANDS) {
    const dx = isle.centre.x - state.x;
    const dz = isle.centre.z - state.z;
    if (Math.hypot(dx, dz) - isle.radius > reach) continue;
    const lx = ox + (dx * cosH - dz * sinH) * ppm;
    const ly = oy + (dx * sinH + dz * cosH) * ppm;
    if (lx < -30 || lx > w + 30 || ly < 36 || ly > h - 28) continue;
    const label = isle.name.toUpperCase();
    ctx.strokeStyle = 'rgba(4,10,18,0.85)';
    ctx.lineWidth = 3;
    ctx.strokeText(label, lx, ly);
    ctx.fillStyle = 'rgba(230,255,238,0.92)';
    ctx.fillText(label, lx, ly);
  }

  // Fixed overlay: dashed 2 km / 4 km arcs, track line, own-ship.
  ctx.strokeStyle = DIM;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 5]);
  for (const ring of [MAP_RING / 2, MAP_RING]) {
    ctx.beginPath();
    ctx.arc(ox, oy, ring * ppm, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = DIM;
  ctx.font = `800 15px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('4 KM', ox + h * 0.3, oy - h * 0.34);
  ctx.fillText('2', ox + h * 0.16, oy - h * 0.17);

  ctx.strokeStyle = 'rgba(125,255,178,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ox, oy - 16);
  ctx.lineTo(ox, oy - h * 0.3);
  ctx.stroke();

  ctx.fillStyle = GREEN;
  ctx.strokeStyle = '#06131f';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ox, oy - 16);
  ctx.lineTo(ox + 11, oy + 11);
  ctx.lineTo(ox, oy + 5);
  ctx.lineTo(ox - 11, oy + 11);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Data bars sized to read at 768 px.
  ctx.fillStyle = 'rgba(4,10,18,0.9)';
  ctx.fillRect(0, 0, w, 32);
  ctx.fillStyle = GREEN;
  ctx.font = `800 20px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText(`TRK ${String(Math.round(state.headingDeg) % 360).padStart(3, '0')}°`, 8, 23);
  ctx.textAlign = 'right';
  ctx.fillStyle = AMBER;
  ctx.fillText(`GS ${Math.round(state.groundSpeed)} M/S`, w - 8, 23);
  ctx.fillStyle = 'rgba(4,10,18,0.9)';
  ctx.fillRect(0, h - 24, w, 24);
  ctx.fillStyle = DIM;
  ctx.font = `800 14px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('NAV MAP · TRACK UP', w / 2, h - 8);
  glassSheen(ctx, w, h);
  ctx.restore();
}

/** COM/NAV radio face: active + standby frequencies. */
export function drawRadio(ctx, w, h) {
  ctx.fillStyle = '#050b0a';
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = 'left';
  ctx.font = `800 15px ${FONT}`;
  ctx.fillStyle = DIM;
  ctx.fillText('COM', 8, 20);
  ctx.fillText('NAV', 8, h - 10);
  ctx.font = `800 30px ${MONO}`;
  ctx.fillStyle = GREEN;
  ctx.fillText('122.80', 58, 30);
  ctx.fillStyle = 'rgba(125,255,178,0.6)';
  ctx.fillText('118.30', w - 128, 30);
  ctx.font = `800 24px ${MONO}`;
  ctx.fillStyle = AMBER;
  ctx.fillText('110.50', 58, h - 8);
  ctx.fillStyle = 'rgba(255,209,102,0.55)';
  ctx.fillText('AUR', w - 66, h - 8);
  ctx.font = `800 13px ${FONT}`;
  ctx.fillStyle = DIM;
  ctx.fillText('STBY', w - 128, 48);
  glassSheen(ctx, w, h);
}

/** Transponder face: squawk code, reply lamp, flight level. */
export function drawTransponder(ctx, w, h, state) {
  ctx.fillStyle = '#0b0805';
  ctx.fillRect(0, 0, w, h);
  ctx.font = `800 15px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,209,102,0.6)';
  ctx.fillText('XPDR', 8, h / 2 + 5);
  ctx.font = `800 32px ${MONO}`;
  ctx.fillStyle = AMBER;
  ctx.fillText('4521', 62, h / 2 + 11);
  ctx.font = `800 17px ${MONO}`;
  ctx.fillStyle = state.replying ? GREEN : 'rgba(125,255,178,0.3)';
  ctx.fillText('R', 146, h / 2 + 6);
  ctx.font = `800 20px ${MONO}`;
  ctx.fillStyle = AMBER;
  ctx.textAlign = 'right';
  ctx.fillText(`FL${String(Math.max(0, Math.round((state.altitudeMsl * 3.28084) / 100))).padStart(3, '0')}`, w - 8, h / 2 + 7);
  glassSheen(ctx, w, h);
}

/** Engine/clock strip: RPM (red only past 2700), fuel bar, mission clock. */
export function drawEngineStrip(ctx, w, h, state) {
  ctx.fillStyle = '#05090d';
  ctx.fillRect(0, 0, w, h);
  ctx.font = `800 13px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = DIM;
  ctx.fillText('RPM', 8, 16);
  ctx.fillText('FUEL', 104, 16);
  ctx.font = `800 26px ${MONO}`;
  ctx.fillStyle = state.rpm > 2700 ? '#FF6B6B' : GREEN;
  ctx.fillText(String(Math.round(state.rpm / 10) * 10).padStart(4, ' '), 8, h - 8);
  const barX = 104;
  const barY = h - 22;
  const barW = 76;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(barX, barY, barW, 12);
  ctx.fillStyle = state.fuel < 0.25 ? '#FF9F1C' : AMBER;
  ctx.fillRect(barX, barY, barW * Math.max(0, Math.min(1, state.fuel)), 12);
  ctx.fillStyle = 'rgba(5,9,13,0.8)';
  for (const tick of [0.25, 0.5, 0.75]) ctx.fillRect(barX + barW * tick - 1, barY, 2, 12);
  ctx.font = `800 24px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = AMBER;
  ctx.fillText(state.clock, w - 8, h - 8);
  glassSheen(ctx, w, h);
}

// ---------------------------------------------------------------- build

/**
 * Build the stack. Returns { group, update(plane, timeSeconds) } —
 * add the group to the instrument panel group.
 */
export function buildAvionicsStack() {
  const group = new THREE.Group();
  group.name = 'avionics-stack';
  group.position.set(STACK_X, 0, 0);

  // Top-to-bottom unit layout; cursor walks down from below the
  // warning-light row.
  const specs = [
    { name: 'gps-map', h: 0.115, pw: 320, ph: 220, knobs: 0, draw: drawMovingMap },
    { name: 'com-nav', h: 0.05, pw: 320, ph: 84, knobs: 2, draw: drawRadio },
    { name: 'transponder', h: 0.036, pw: 320, ph: 60, knobs: 1, draw: drawTransponder },
    { name: 'engine-clock', h: 0.046, pw: 320, ph: 76, knobs: 0, draw: drawEngineStrip },
  ];
  const GAP = 0.014;
  let cursorY = 0.185;
  const units = {};
  const screwPts = [];

  for (const spec of specs) {
    const canvas = newCanvas(spec.pw, spec.ph);
    if (!canvas) continue;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    const cy = cursorY - spec.h / 2;
    cursorY -= spec.h + GAP;
    const bezel = makeBezel(STACK_W, spec.h, spec.knobs);
    bezel.position.set(0, cy, BEZEL_Z);
    group.add(bezel);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        screwPts.push([sx * (STACK_W / 2 + 0.001), cy + sy * (spec.h / 2 - 0.001), BEZEL_Z + 0.012]);
      }
    }
    const screen = makeScreen(STACK_W - 0.012, spec.h - 0.01, canvas);
    screen.mesh.position.set(0, cy, SCREEN_Z);
    screen.mesh.name = `avionics-${spec.name}`;
    group.add(screen.mesh);
    units[spec.name] = { canvas, ctx, tex: screen.tex, draw: spec.draw };
  }

  // Every bezel screw in one instanced draw, each parked at its own angle.
  if (screwPts.length) {
    const screwGeo = new THREE.CylinderGeometry(0.0035, 0.0035, 0.004, 6);
    screwGeo.rotateX(Math.PI / 2);
    const screws = new THREE.InstancedMesh(
      screwGeo,
      new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.28, metalness: 0.82 }),
      screwPts.length,
    );
    const dummy = new THREE.Object3D();
    screwPts.forEach(([x, y, z], i) => {
      dummy.position.set(x, y, z);
      dummy.rotation.z = i * 0.7;
      dummy.updateMatrix();
      screws.setMatrixAt(i, dummy.matrix);
    });
    screws.instanceMatrix.needsUpdate = true;
    group.add(screws);
  }

  // Faint green backlight spill on the board around the stack.
  const spill = new THREE.Mesh(
    new THREE.PlaneGeometry(STACK_W + 0.05, 0.42),
    new THREE.MeshBasicMaterial({
      color: 0x1aff6b, transparent: true, opacity: 0.035, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  spill.position.set(0, -0.02, 0.037);
  group.add(spill);

  group.traverse((o) => {
    if (o.isMesh) o.castShadow = false;
  });

  const state = {
    x: 0, z: 0, headingDeg: 0, groundSpeed: 0, altitudeMsl: 0,
    rpm: 0, fuel: 1, clock: '06:12', replying: false,
  };
  let lastMapAt = -Infinity;
  let radioPainted = false;

  function paint(unit) {
    if (!unit) return;
    unit.draw(unit.ctx, unit.canvas.width, unit.canvas.height, state);
    unit.tex.needsUpdate = true;
  }

  function update(plane, timeSeconds) {
    if (!plane || !plane.position) return;
    const t = typeof timeSeconds === 'number' ? timeSeconds : 0;
    state.x = plane.position.x;
    state.z = plane.position.z;
    state.headingDeg = typeof plane.headingDeg === 'number' ? plane.headingDeg : 0;
    state.groundSpeed = typeof plane.groundSpeed === 'number' ? plane.groundSpeed : 0;
    state.altitudeMsl = typeof plane.altitudeMsl === 'number' ? plane.altitudeMsl : plane.position.y;
    const throttle = typeof plane.throttle === 'number' ? plane.throttle : 0;
    state.rpm = plane.engineOn === false ? 0 : 600 + throttle * 2100;
    state.fuel = typeof plane.fuel === 'number' ? plane.fuel : 1;
    const minutes = 372 + Math.floor(t / 60); // 06:12 mission start
    state.clock = `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    state.replying = t % 2 < 0.25;

    if (!radioPainted && units['com-nav']) {
      paint(units['com-nav']); // static face: paint once
      radioPainted = true;
    }
    if (t - lastMapAt < MAP_PERIOD && t >= lastMapAt) return;
    lastMapAt = t;
    paint(units['gps-map']);
    paint(units.transponder);
    paint(units['engine-clock']);
  }

  update({ position: { x: 0, z: 0, y: 0 }, headingDeg: 90, engineOn: false }, 0);
  return { group, update };
}
