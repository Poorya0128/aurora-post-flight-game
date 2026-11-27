// vehicles.js — selectable aircraft exteriors for AURORA POST.
//
// Three VISUAL-ONLY vehicles sharing one local frame: forward -Z,
// right +X, up +Y, origin at CG, gear/skid contact at y = -1.32
// (same convention as plane-v2.js / aircraft.js AIRCRAFT_LAYOUT).
// Flight model, physics, controls, camera, HUD and gameplay are
// untouched — only the exterior mesh is visual.
//
//   'aurora-plane'  — current plane-v2 (buildPlaneV2 passthrough)
//   'aurora-liner'  — twin-engine airliner (generic, no trademarks)
//   'fighter-jet'   — single-seat fighter jet
//
// Every build() returns:
//   { id, kind: 'plane'|'heli', group, gear, wheels, wingGroup,
//     smokeAnchor, setPropeller(rpm, angleRad),
//     setControls({pitch, roll, yaw, flaps}) }
// gear/wheels/wingGroup/smokeAnchor may be null/[] when a vehicle
// has no such part — callers must guard (aircraft.js does).
//
// renderVehiclePreviews(renderer) renders each vehicle once as a
// solid lit 3D render on a dark background (480x300 PNG data URLs)
// for the vehicle-select panel, restoring renderer state afterwards.

import * as THREE from 'three';
import { buildPlaneV2 } from './plane-v2.js';

export const VEHICLE_GEAR_BOTTOM_Y = -1.32;

const FONT_STACK = ['AuroraSans', '"Segoe UI"', 'system-ui', 'Arial', 'sans-serif'].join(', ');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------ utilities

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function nextSeededRandom() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function createCanvasTexture(width, height, drawOnCanvas) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    drawOnCanvas(context, width, height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  } catch (error) {
    return null;
  }
}

function box(w, h, d, material, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
}

function strutBetween(start, end, radius, material) {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 8), material);
  mesh.position.copy(start).addScaledVector(direction, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function barBetween(start, end, width, depth, material) {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, length, depth), material);
  mesh.position.copy(start).addScaledVector(direction, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function paneQuad(p1, p2, p3, p4, material) {
  const positions = new Float32Array([
    p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z,
    p1.x, p1.y, p1.z, p3.x, p3.y, p3.z, p4.x, p4.y, p4.z,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function strokeSegment(ctx, x0, y0, x1, y1) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function decalMaterial(texture) {
  return new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    roughness: 0.6,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    depthWrite: false,
  });
}

function flatMat(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, ...extra });
}

// Same shadow policy as plane-v2: opaque, non-trim meshes above a
// small volume cast; transparent dressing never does.
function applyShadowPass(group, trimMaterial) {
  group.traverse((object) => {
    if (!object.isMesh || object.material.transparent) return;
    if (trimMaterial && object.material === trimMaterial) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    const b = object.geometry.boundingBox;
    const volume = (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
    object.castShadow = volume >= 0.03;
  });
}

// ------------------------------------------------------------- textures

function createGlowTexture() {
  return createCanvasTexture(128, 128, (ctx, w, h) => {
    const grad = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  });
}

// Prop blur disc (3 ghost blades) — same painting as aircraft.js.
function createPropBlurTexture() {
  return createCanvasTexture(256, 256, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    ctx.clearRect(0, 0, w, h);
    const wash = ctx.createRadialGradient(cx, cy, 8, cx, cy, 126);
    wash.addColorStop(0, 'rgba(28,28,34,0.72)');
    wash.addColorStop(0.35, 'rgba(28,28,34,0.45)');
    wash.addColorStop(0.8, 'rgba(28,28,34,0.30)');
    wash.addColorStop(0.96, 'rgba(255,209,102,0.45)');
    wash.addColorStop(1, 'rgba(255,209,102,0)');
    ctx.fillStyle = wash;
    ctx.beginPath();
    ctx.arc(cx, cy, 126, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 3; i += 1) {
      const angle = (i / 3) * Math.PI * 2 + 0.4;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      const bladeGrad = ctx.createLinearGradient(0, 18, 0, 122);
      bladeGrad.addColorStop(0, 'rgba(12,12,16,0.68)');
      bladeGrad.addColorStop(0.85, 'rgba(12,12,16,0.48)');
      bladeGrad.addColorStop(1, 'rgba(255,209,102,0.65)');
      ctx.fillStyle = bladeGrad;
      ctx.beginPath();
      ctx.ellipse(0, 72, 11, 52, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(20,20,24,0.6)';
    ctx.beginPath();
    ctx.arc(cx, cy, 16, 0, Math.PI * 2);
    ctx.fill();
  });
}

// -------------------------------------------------------- shared parts

// Static nav/landing lights: emissive bulb + additive glow sprite.
// specs: [{color, x, y, z, r?, glow?}]
function buildNavLights(specs) {
  const lights = new THREE.Group();
  const glowTexture = createGlowTexture();
  for (const spec of specs) {
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(spec.r || 0.045, 10, 8),
      new THREE.MeshStandardMaterial({
        color: spec.color, emissive: spec.color, emissiveIntensity: 2.6,
        roughness: 0.25, metalness: 0.1,
      }),
    );
    bulb.position.set(spec.x, spec.y, spec.z);
    lights.add(bulb);
    if (glowTexture) {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture, color: spec.color, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85,
      }));
      glow.position.set(spec.x, spec.y, spec.z);
      const s = spec.glow || 0.55;
      glow.scale.set(s, s, 1);
      lights.add(glow);
    }
  }
  return lights;
}

// Torus tyre + hub disc wheel; registers {wheelGroup, radius}.
function buildWheel(gearGroup, wheels, tyreMat, hubMat, tyreRadius, tubeRadius, x, y, z) {
  const wheelGroup = new THREE.Group();
  wheelGroup.position.set(x, y, z);
  const tyre = new THREE.Mesh(new THREE.TorusGeometry(tyreRadius, tubeRadius, 10, 20), tyreMat);
  tyre.rotation.y = Math.PI / 2; // axle along X
  wheelGroup.add(tyre);
  const hubDisc = new THREE.Mesh(
    new THREE.CylinderGeometry(tyreRadius * 0.55, tyreRadius * 0.55, tubeRadius * 1.4, 12),
    hubMat,
  );
  hubDisc.rotation.z = Math.PI / 2;
  wheelGroup.add(hubDisc);
  gearGroup.add(wheelGroup);
  wheels.push({ wheelGroup, radius: tyreRadius + tubeRadius });
  return wheelGroup;
}

// ---------------------------------------------------------- aurora liner
// Twin-engine airliner (generic Boeing-style silhouette, no real
// trademarks): low swept wings + winglets, two underwing nacelles,
// conventional tail, framed cockpit panes in light frosted glass,
// cabin window rows, cream fuselage with teal/orange cheatline.

function createLinerTailTexture() {
  return createCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.97)';
    ctx.font = `800 92px ${FONT_STACK}`;
    ctx.fillText('AURORA', w / 2, h / 2 - 40);
    ctx.font = `800 64px ${FONT_STACK}`;
    ctx.fillText('POST', w / 2, h / 2 + 52);
  });
}

function createLinerMaterials() {
  const warmWhite = {
    emissive: 0xffe8c0, emissiveIntensity: 0.2,
    roughness: 0.38, metalness: 0.14, envMapIntensity: 0.95,
  };
  return {
    white: flatMat(0xf4f6f8, { ...warmWhite }),
    belly: flatMat(0xd8dde2, { roughness: 0.6, metalness: 0.05, envMapIntensity: 0.5 }),
    teal: flatMat(0x1b7f9e, {
      roughness: 0.38, metalness: 0.14, envMapIntensity: 1.0,
      emissive: 0x0e4a5c, emissiveIntensity: 0.25,
    }),
    orange: flatMat(0xf97a1c, {
      roughness: 0.35, metalness: 0.12, envMapIntensity: 1.0,
      emissive: 0xf97a1c, emissiveIntensity: 0.2,
    }),
    // Light frosted glass (plane-v2 family), opaque so the cabin
    // never shows through; framed panes, never a dark ball.
    glass: flatMat(0x86a8bc, {
      roughness: 0.42, metalness: 0.2, envMapIntensity: 0.9,
      emissive: 0x2e4a5a, emissiveIntensity: 0.3, side: THREE.DoubleSide,
    }),
    windowDark: flatMat(0x24404f, { roughness: 0.35, metalness: 0.3, envMapIntensity: 0.8 }),
    frame: flatMat(0x2b3a49, { roughness: 0.55, metalness: 0.1, envMapIntensity: 0.5 }),
    panelLine: flatMat(0x55504a, { roughness: 0.65, metalness: 0.2, envMapIntensity: 0.6 }),
    darkMetal: flatMat(0x3a3f44, { roughness: 0.4, metalness: 0.7, envMapIntensity: 0.9 }),
    hubMetal: flatMat(0x9aa0a6, { roughness: 0.28, metalness: 0.85, envMapIntensity: 1.1 }),
    tyre: flatMat(0x22242a, { roughness: 0.92, metalness: 0.0, envMapIntensity: 0.35 }),
    intakeDark: flatMat(0x14181e, { roughness: 0.7, metalness: 0.3, envMapIntensity: 0.4 }),
  };
}

function buildAuroraLiner() {
  const materials = createLinerMaterials();
  const group = new THREE.Group();
  group.name = 'vehicle-aurora-liner';

  // --- fuselage: rounded lathe, nose -Z (length ~11.4, r 0.85)
  const profile = [
    [0.04, -5.7], [0.3, -5.35], [0.55, -4.7], [0.74, -3.9],
    [0.83, -2.8], [0.85, -1.0], [0.85, 1.5], [0.82, 3.2],
    [0.72, 4.4], [0.55, 5.2], [0.34, 5.65], [0.1, 5.85],
  ].map(([radius, y]) => new THREE.Vector2(radius, y));
  const fuselage = new THREE.Mesh(new THREE.LatheGeometry(profile, 20), materials.white);
  fuselage.rotation.x = -Math.PI / 2;
  fuselage.position.y = 0.12;
  group.add(fuselage);

  // --- cockpit glazing: raked flat panes + white frame pillars
  const F = {
    cl: new THREE.Vector3(0, 0.28, -5.02),
    cr: new THREE.Vector3(0, 0.28, -5.02),
    ol: new THREE.Vector3(-0.52, 0.3, -4.92),
    or: new THREE.Vector3(0.52, 0.3, -4.92),
    tcl: new THREE.Vector3(0, 0.82, -4.62),
    tcr: new THREE.Vector3(0, 0.82, -4.62),
    tol: new THREE.Vector3(-0.5, 0.82, -4.56),
    tor: new THREE.Vector3(0.5, 0.82, -4.56),
  };
  group.add(paneQuad(F.ol, F.cl, F.tcl, F.tol, materials.glass));
  group.add(paneQuad(F.cr, F.or, F.tor, F.tcr, materials.glass));
  group.add(barBetween(F.cl, F.tcl, 0.06, 0.06, materials.white));
  group.add(box(1.14, 0.07, 0.09, materials.white, 0, 0.86, -4.58));
  group.add(box(1.12, 0.07, 0.09, materials.white, 0, 0.24, -4.97));
  for (const side of [-1, 1]) {
    const s = side;
    group.add(barBetween(s < 0 ? F.ol : F.or, s < 0 ? F.tol : F.tor, 0.055, 0.055, materials.white));
    // Side cockpit pane.
    group.add(box(0.03, 0.34, 0.5, materials.glass, s * 0.72, 0.55, -4.35));
  }

  // --- cheatline + cabin windows + doors (both sides)
  for (const side of [-1, 1]) {
    const s = side;
    group.add(box(0.03, 0.16, 7.6, materials.teal, s * 0.845, -0.08, 0.1));
    group.add(box(0.032, 0.05, 7.6, materials.orange, s * 0.845, 0.05, 0.1));
    for (let z = -3.5; z <= 3.51; z += 0.55) {
      if (Math.abs(z + 3.5) < 0.01 || Math.abs(z - 3.5) < 0.3) continue; // door gaps
      group.add(box(0.025, 0.17, 0.24, materials.windowDark, s * 0.845, 0.42, z));
    }
    // Front + rear door outlines.
    for (const dz of [-3.55, 3.55]) {
      group.add(box(0.02, 0.85, 0.03, materials.panelLine, s * 0.82, 0.05, dz - 0.3));
      group.add(box(0.02, 0.85, 0.03, materials.panelLine, s * 0.82, 0.05, dz + 0.3));
      group.add(box(0.02, 0.03, 0.6, materials.panelLine, s * 0.82, 0.48, dz));
    }
  }

  // --- low swept wings with winglets + aileron/flap pivots
  const wing = new THREE.Group();
  wing.name = 'aircraft-wing';
  const controlSurfaces = { aileronLeft: null, aileronRight: null, flapLeft: null, flapRight: null };
  const fans = [];
  for (const side of [-1, 1]) {
    const s = side;
    const halfWing = new THREE.Group();
    halfWing.position.set(s * 0.55, -0.38, 0.35);
    halfWing.rotation.y = -s * THREE.MathUtils.degToRad(24); // sweep back
    halfWing.rotation.z = s * THREE.MathUtils.degToRad(4); // dihedral
    halfWing.add(box(5.0, 0.11, 1.5, materials.white, s * 2.5, 0, 0));
    halfWing.add(box(5.0, 0.02, 1.42, materials.belly, s * 2.5, -0.065, 0));
    // Winglet at the tip.
    const winglet = box(0.06, 0.55, 0.5, materials.teal, s * 4.95, 0.26, 0.18);
    winglet.rotation.z = -s * THREE.MathUtils.degToRad(18);
    halfWing.add(winglet);
    const flapPivot = new THREE.Group();
    flapPivot.position.set(s * 1.1, -0.02, 0.68);
    flapPivot.add(box(1.7, 0.045, 0.36, materials.white, 0, 0, 0.18));
    halfWing.add(flapPivot);
    const aileronPivot = new THREE.Group();
    aileronPivot.position.set(s * 3.6, -0.02, 0.66);
    aileronPivot.add(box(2.2, 0.045, 0.34, materials.white, 0, 0, 0.17));
    halfWing.add(aileronPivot);
    if (s < 0) {
      controlSurfaces.flapLeft = flapPivot;
      controlSurfaces.aileronLeft = aileronPivot;
    } else {
      controlSurfaces.flapRight = flapPivot;
      controlSurfaces.aileronRight = aileronPivot;
    }
    // Underwing engine: pylon + nacelle + dark intake + fan.
    const engine = new THREE.Group();
    engine.position.set(s * 2.05, -0.62, -0.55);
    engine.add(box(0.09, 0.42, 0.85, materials.white, 0, 0.32, 0.1));
    const nacelle = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.3, 1.55, 14), materials.white);
    nacelle.rotation.x = Math.PI / 2;
    engine.add(nacelle);
    const intake = new THREE.Mesh(new THREE.CircleGeometry(0.3, 16), materials.intakeDark);
    intake.position.z = -0.79;
    intake.rotation.y = Math.PI;
    engine.add(intake);
    const fan = new THREE.Group();
    fan.position.z = -0.78;
    for (let i = 0; i < 6; i += 1) {
      const holder = new THREE.Group();
      holder.rotation.z = (i / 6) * Math.PI * 2;
      holder.add(box(0.05, 0.24, 0.02, materials.hubMetal, 0, 0.13, 0));
      fan.add(holder);
    }
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 10), materials.hubMetal);
    spinner.rotation.x = -Math.PI / 2;
    fan.add(spinner);
    engine.add(fan);
    fans.push(fan);
    const exhaustPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.3, 10), materials.darkMetal);
    exhaustPipe.rotation.x = Math.PI / 2;
    exhaustPipe.position.z = 0.85;
    engine.add(exhaustPipe);
    halfWing.add(engine);
    wing.add(halfWing);
  }
  group.add(wing);

  // --- tail: horizontal stabilizers + teal vertical fin
  const tail = new THREE.Group();
  for (const side of [-1, 1]) {
    const s = side;
    const stab = box(1.9, 0.07, 0.75, materials.white, s * 1.05, 0.42, 5.15);
    stab.rotation.y = -s * THREE.MathUtils.degToRad(22);
    tail.add(stab);
  }
  const elevatorPivot = new THREE.Group();
  elevatorPivot.position.set(0, 0.42, 5.42);
  elevatorPivot.add(box(3.4, 0.045, 0.34, materials.white, 0, 0, 0.17));
  tail.add(elevatorPivot);
  const finShape = new THREE.Shape();
  finShape.moveTo(1.15, 0);
  finShape.lineTo(0.35, 1.55);
  finShape.lineTo(-0.55, 1.6);
  finShape.lineTo(-1.05, 0.05);
  finShape.lineTo(1.15, 0);
  const fin = new THREE.Mesh(
    new THREE.ExtrudeGeometry(finShape, { depth: 0.09, bevelEnabled: false }),
    materials.teal,
  );
  fin.rotation.y = Math.PI / 2;
  fin.position.set(-0.045, 0.35, 4.75);
  tail.add(fin);
  const rudderPivot = new THREE.Group();
  rudderPivot.position.set(0, 1.05, 5.55);
  const rudderShape = new THREE.Shape();
  rudderShape.moveTo(0, -0.68);
  rudderShape.lineTo(-0.4, -0.62);
  rudderShape.lineTo(-0.34, 0.62);
  rudderShape.lineTo(0, 0.68);
  rudderShape.lineTo(0, -0.68);
  const rudder = new THREE.Mesh(
    new THREE.ExtrudeGeometry(rudderShape, { depth: 0.07, bevelEnabled: false }),
    materials.orange,
  );
  rudder.rotation.y = Math.PI / 2;
  rudder.position.set(-0.035, 0, 0);
  rudderPivot.add(rudder);
  tail.add(rudderPivot);
  const tailTexture = createLinerTailTexture();
  if (tailTexture) {
    const mat = decalMaterial(tailTexture);
    for (const side of [-1, 1]) {
      const decal = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.15), mat);
      decal.position.set(side * 0.06, 1.15, 4.95);
      decal.rotation.y = side * (Math.PI / 2);
      tail.add(decal);
    }
  }
  group.add(tail);

  // --- gear: nose wheel + twin main bogies (bottoms at y=-1.32)
  const gear = new THREE.Group();
  const wheels = [];
  buildWheel(gear, wheels, materials.tyre, materials.hubMetal, 0.2, 0.09, 0, -1.03, -4.3);
  gear.add(strutBetween(
    new THREE.Vector3(0, -0.45, -4.35),
    new THREE.Vector3(0, -1.03, -4.3), 0.045, materials.darkMetal,
  ));
  for (const side of [-1, 1]) {
    buildWheel(gear, wheels, materials.tyre, materials.hubMetal, 0.26, 0.11, side * 0.85, -0.95, 0.75);
    buildWheel(gear, wheels, materials.tyre, materials.hubMetal, 0.26, 0.11, side * 0.85, -0.95, 1.35);
    gear.add(strutBetween(
      new THREE.Vector3(side * 0.5, -0.5, 1.05),
      new THREE.Vector3(side * 0.85, -0.95, 1.05), 0.05, materials.darkMetal,
    ));
    gear.add(box(0.08, 0.3, 0.85, materials.white, side * 0.72, -0.68, 1.05));
  }
  group.add(gear);

  group.add(buildNavLights([
    { color: 0xff3b30, x: -5.35, y: -0.05, z: 1.9, glow: 0.8 },
    { color: 0x7dffb2, x: 5.35, y: -0.05, z: 1.9, glow: 0.8 },
    { color: 0xffffff, x: 0, y: 0.3, z: 5.95, glow: 0.9 },
    { color: 0xff3b30, x: 0, y: 2.02, z: 5.15, glow: 0.8 },
    { color: 0xffe9b0, x: 0, y: -0.35, z: -5.55, r: 0.06, glow: 0.9 },
  ]));

  applyShadowPass(group, materials.panelLine);

  function setPropeller(rpm, angleRad) {
    for (const fan of fans) fan.rotation.z = angleRad * 1.8;
  }

  function setControls(controls = {}) {
    const pitch = clamp(controls.pitch || 0, -1, 1);
    const roll = clamp(controls.roll || 0, -1, 1);
    const yaw = clamp(controls.yaw || 0, -1, 1);
    const flaps = clamp(Math.round(controls.flaps || 0), 0, 2);
    controlSurfaces.aileronLeft.rotation.x = roll * 0.4;
    controlSurfaces.aileronRight.rotation.x = -roll * 0.4;
    controlSurfaces.flapLeft.rotation.x = flaps * 0.24;
    controlSurfaces.flapRight.rotation.x = flaps * 0.24;
    elevatorPivot.rotation.x = -pitch * 0.45;
    rudderPivot.rotation.y = yaw * 0.4;
  }

  return {
    id: 'aurora-liner',
    kind: 'plane',
    group,
    gear,
    wheels,
    wingGroup: wing,
    smokeAnchor: new THREE.Vector3(1.6, -0.7, 0.6),
    setPropeller,
    setControls,
  };
}

// ----------------------------------------------------------- fighter jet
// Single-seat fighter: slim fuselage, pointed nose, bubble canopy
// with frame pillars in light tinted glass, swept delta wings,
// twin tail fins, single afterburner nozzle, wing pylons + tanks.
// Military grey/green with orange accents.

function createFighterMaterials() {
  return {
    grey: flatMat(0x7d8590, {
      emissive: 0x3d434c, emissiveIntensity: 0.22,
      roughness: 0.45, metalness: 0.25, envMapIntensity: 0.85,
    }),
    greyDark: flatMat(0x59616b, { roughness: 0.55, metalness: 0.2, envMapIntensity: 0.7 }),
    green: flatMat(0x5c6248, { roughness: 0.55, metalness: 0.1, envMapIntensity: 0.7 }),
    orange: flatMat(0xf97a1c, {
      roughness: 0.35, metalness: 0.12, envMapIntensity: 1.0,
      emissive: 0xf97a1c, emissiveIntensity: 0.25,
    }),
    // Light tinted canopy glass (plane-v2 family), opaque; the
    // frame pillars over it keep it reading as a canopy, not a ball.
    glass: flatMat(0x9fc3d8, {
      roughness: 0.3, metalness: 0.3, envMapIntensity: 1.1,
      emissive: 0x2e4a5a, emissiveIntensity: 0.3, side: THREE.DoubleSide,
    }),
    frame: flatMat(0x2b3a49, { roughness: 0.55, metalness: 0.1, envMapIntensity: 0.5 }),
    panelLine: flatMat(0x3a3f36, { roughness: 0.65, metalness: 0.2, envMapIntensity: 0.6 }),
    darkMetal: flatMat(0x3a3f44, { roughness: 0.4, metalness: 0.7, envMapIntensity: 0.9 }),
    hubMetal: flatMat(0x9aa0a6, { roughness: 0.28, metalness: 0.85, envMapIntensity: 1.1 }),
    tyre: flatMat(0x22242a, { roughness: 0.92, metalness: 0.0, envMapIntensity: 0.35 }),
    nozzleDark: flatMat(0x1c1f24, { roughness: 0.5, metalness: 0.7, envMapIntensity: 0.6 }),
    burner: new THREE.MeshStandardMaterial({
      color: 0xff7a2a, emissive: 0xff7a2a, emissiveIntensity: 0.4,
      roughness: 0.4, metalness: 0.2, flatShading: true,
    }),
  };
}

function buildFighterJet() {
  const materials = createFighterMaterials();
  const group = new THREE.Group();
  group.name = 'vehicle-fighter-jet';

  // --- slim fuselage lathe, nose -Z (length ~9.8, r 0.52)
  const profile = [
    [0.02, -4.9], [0.14, -4.55], [0.28, -3.9], [0.42, -3.0],
    [0.5, -1.8], [0.52, -0.4], [0.52, 1.2], [0.5, 2.6],
    [0.46, 3.8], [0.4, 4.6], [0.3, 4.95],
  ].map(([radius, y]) => new THREE.Vector2(radius, y));
  const fuselage = new THREE.Mesh(new THREE.LatheGeometry(profile, 16), materials.grey);
  fuselage.rotation.x = -Math.PI / 2;
  fuselage.scale.set(0.9, 1, 1.05);
  fuselage.position.y = 0.05;
  group.add(fuselage);
  // Spine fairing behind the canopy.
  group.add(box(0.34, 0.2, 2.6, materials.greyDark, 0, 0.52, 0.9));
  // Side intakes (dark mouths + cheeks).
  for (const side of [-1, 1]) {
    const s = side;
    group.add(box(0.16, 0.5, 1.5, materials.greyDark, s * 0.5, -0.05, -0.9));
    group.add(box(0.03, 0.38, 0.1, materials.nozzleDark, s * 0.585, -0.05, -1.62));
  }

  // --- bubble canopy: slim scaled sphere + grey frame pillars
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.5, 18, 12), materials.glass);
  canopy.scale.set(0.72, 0.62, 1.9);
  canopy.position.set(0, 0.42, -2.15);
  group.add(canopy);
  group.add(box(0.78, 0.07, 1.95, materials.greyDark, 0, 0.34, -2.15)); // canopy sill
  group.add(barBetween(
    new THREE.Vector3(0, 0.4, -3.05),
    new THREE.Vector3(0, 0.74, -2.55), 0.05, 0.05, materials.greyDark,
  ));
  group.add(barBetween(
    new THREE.Vector3(0, 0.72, -1.75),
    new THREE.Vector3(0, 0.44, -1.3), 0.05, 0.05, materials.greyDark,
  ));
  for (const side of [-1, 1]) {
    const s = side;
    group.add(barBetween(
      new THREE.Vector3(s * 0.33, 0.38, -2.95),
      new THREE.Vector3(s * 0.3, 0.66, -2.5), 0.045, 0.045, materials.greyDark,
    ));
    group.add(barBetween(
      new THREE.Vector3(s * 0.3, 0.64, -1.8),
      new THREE.Vector3(s * 0.33, 0.4, -1.35), 0.045, 0.045, materials.greyDark,
    ));
  }

  // --- swept delta wings (extruded planform) + elevon pivots
  const wing = new THREE.Group();
  wing.name = 'aircraft-wing';
  const elevons = [];
  for (const side of [-1, 1]) {
    const s = side;
    const plan = new THREE.Shape();
    plan.moveTo(0.3, -1.15);
    plan.lineTo(3.35, 1.15);
    plan.lineTo(3.35, 1.75);
    plan.lineTo(0.35, 1.95);
    plan.lineTo(0.3, -1.15);
    const wingMesh = new THREE.Mesh(
      new THREE.ExtrudeGeometry(plan, { depth: 0.09, bevelEnabled: false }),
      materials.grey,
    );
    wingMesh.rotation.x = Math.PI / 2;
    wingMesh.scale.x = s;
    wingMesh.position.set(0, -0.12, 0.55);
    wing.add(wingMesh);
    const elevonPivot = new THREE.Group();
    elevonPivot.position.set(s * 2.1, -0.12, 2.32);
    elevonPivot.add(box(2.3, 0.045, 0.4, materials.greyDark, 0, 0, 0.2));
    wing.add(elevonPivot);
    elevons.push({ pivot: elevonPivot, side: s });
    // Wingtip rail (orange accent).
    wing.add(box(0.08, 0.08, 0.9, materials.orange, s * 3.38, -0.08, 2.0));
    // Wing pylon + drop tank.
    wing.add(box(0.07, 0.3, 0.6, materials.greyDark, s * 1.7, -0.32, 1.55));
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 1.15, 10), materials.green);
    tank.rotation.x = Math.PI / 2;
    tank.position.set(s * 1.7, -0.55, 1.55);
    wing.add(tank);
    const tankNose = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.3, 10), materials.green);
    tankNose.rotation.x = -Math.PI / 2;
    tankNose.position.set(s * 1.7, -0.55, 0.85);
    wing.add(tankNose);
  }
  group.add(wing);

  // --- twin tail fins + rudders, small ventral strake
  const rudders = [];
  for (const side of [-1, 1]) {
    const s = side;
    const finShape = new THREE.Shape();
    finShape.moveTo(0.75, 0);
    finShape.lineTo(0.2, 1.05);
    finShape.lineTo(-0.45, 1.08);
    finShape.lineTo(-0.7, 0.02);
    finShape.lineTo(0.75, 0);
    const fin = new THREE.Mesh(
      new THREE.ExtrudeGeometry(finShape, { depth: 0.07, bevelEnabled: false }),
      materials.greyDark,
    );
    fin.rotation.y = Math.PI / 2;
    fin.position.set(s * 0.42 - 0.035, 0.28, 3.55);
    fin.rotation.z = -s * THREE.MathUtils.degToRad(8);
    group.add(fin);
    group.add(box(0.08, 0.14, 0.75, materials.orange, s * 0.5, 1.3, 3.85));
    const rudderPivot = new THREE.Group();
    rudderPivot.position.set(s * 0.42, 0.75, 4.2);
    rudderPivot.add(box(0.05, 0.85, 0.36, materials.greyDark, 0, 0, 0.18));
    group.add(rudderPivot);
    rudders.push(rudderPivot);
  }
  group.add(box(0.06, 0.42, 0.8, materials.greyDark, 0, -0.42, 4.1));

  // --- single afterburner nozzle: dark cylinder + emissive ring
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.24, 0.5, 14), materials.nozzleDark);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(0, 0.05, 4.95);
  group.add(nozzle);
  const burnerRing = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.045, 8, 16), materials.burner);
  burnerRing.position.set(0, 0.05, 5.18);
  group.add(burnerRing);
  const burnerCore = new THREE.Mesh(new THREE.CircleGeometry(0.16, 14), materials.burner);
  burnerCore.position.set(0, 0.05, 5.19);
  group.add(burnerCore);

  // --- gear: nose wheel + two mains (bottoms at y=-1.32)
  const gear = new THREE.Group();
  const wheels = [];
  buildWheel(gear, wheels, materials.tyre, materials.hubMetal, 0.18, 0.08, 0, -1.06, -3.1);
  gear.add(strutBetween(
    new THREE.Vector3(0, -0.35, -3.15),
    new THREE.Vector3(0, -1.06, -3.1), 0.04, materials.darkMetal,
  ));
  for (const side of [-1, 1]) {
    buildWheel(gear, wheels, materials.tyre, materials.hubMetal, 0.24, 0.1, side * 0.95, -0.98, 1.5);
    gear.add(strutBetween(
      new THREE.Vector3(side * 0.45, -0.35, 1.5),
      new THREE.Vector3(side * 0.95, -0.98, 1.5), 0.045, materials.darkMetal,
    ));
  }
  group.add(gear);

  // --- pitot on the nose
  group.add(strutBetween(
    new THREE.Vector3(0, 0.08, -4.85),
    new THREE.Vector3(0, 0.1, -5.35), 0.012, materials.hubMetal,
  ));

  group.add(buildNavLights([
    { color: 0xff3b30, x: -3.42, y: -0.02, z: 2.0, glow: 0.7 },
    { color: 0x7dffb2, x: 3.42, y: -0.02, z: 2.0, glow: 0.7 },
    { color: 0xffffff, x: 0, y: 0.05, z: 5.25, glow: 0.7 },
    { color: 0xff3b30, x: 0, y: 0.72, z: 1.4, r: 0.045, glow: 0.7 },
    { color: 0xffe9b0, x: 0, y: -0.25, z: -4.6, r: 0.05, glow: 0.8 },
  ]));

  applyShadowPass(group, materials.panelLine);

  function setPropeller(rpm, angleRad) {
    // Afterburner glow follows throttle (rpm proxy).
    materials.burner.emissiveIntensity = 0.35 + clamp(rpm / 2200, 0, 1) * 2.4;
  }

  function setControls(controls = {}) {
    const pitch = clamp(controls.pitch || 0, -1, 1);
    const roll = clamp(controls.roll || 0, -1, 1);
    const yaw = clamp(controls.yaw || 0, -1, 1);
    for (const entry of elevons) {
      entry.pivot.rotation.x = -pitch * 0.4 + entry.side * roll * 0.35;
    }
    for (const rudder of rudders) rudder.rotation.y = yaw * 0.4;
  }

  return {
    id: 'fighter-jet',
    kind: 'plane',
    group,
    gear,
    wheels,
    wingGroup: wing,
    smokeAnchor: new THREE.Vector3(0, 0.05, 4.6),
    setPropeller,
    setControls,
  };
}

// ------------------------------------------------------------- registry

function buildAuroraPlane() {
  const v2 = buildPlaneV2();
  return {
    id: 'aurora-plane',
    kind: 'plane',
    group: v2.group,
    gear: v2.gear,
    wheels: v2.wheels,
    wingGroup: v2.wingGroup,
    smokeAnchor: new THREE.Vector3(0.35, -0.1, -3.3),
    setPropeller: v2.setPropeller,
    setControls: v2.setControls,
  };
}

export const VEHICLES = [
  {
    id: 'aurora-plane',
    name: 'AURORA BUSH PLANE',
    shortName: 'AURORA',
    stats: { speed: '110 kts', cargo: 'MED', maneuver: 'MED' },
    build: buildAuroraPlane,
  },
  {
    id: 'aurora-liner',
    name: 'AURORA LINER',
    shortName: 'LINER',
    stats: { speed: '165 kts', cargo: 'MAX', maneuver: 'LOW' },
    build: buildAuroraLiner,
  },
  {
    id: 'fighter-jet',
    name: 'AURORA FIGHTER',
    shortName: 'FIGHTER',
    stats: { speed: '220 kts', cargo: 'LOW', maneuver: 'HIGH' },
    build: buildFighterJet,
  },
];

// ----------------------------------------------------- preview renderer
// Solid lit 3/4 previews (480x300 PNG data URLs) for the
// vehicle-select panel: each vehicle rendered with its real
// materials under a warm key light + hemisphere fill, like a
// product photo. Builds throwaway instances (the live game
// vehicles are never touched), renders into an offscreen target,
// and restores the renderer's target / clear colour / size
// afterwards.

const PREVIEW_WIDTH = 480;
const PREVIEW_HEIGHT = 300;

function disposeBuiltVehicle(built) {
  const geometries = new Set();
  const materials = new Set();
  built.group.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const mat = object.material;
    if (Array.isArray(mat)) mat.forEach((m) => materials.add(m));
    else if (mat) materials.add(mat);
  });
  for (const geo of geometries) geo.dispose();
  for (const mat of materials) {
    if (mat.map) mat.map.dispose();
    mat.dispose();
  }
}

export function renderVehiclePreviews(renderer) {
  const previews = {};
  if (!renderer || typeof document === 'undefined' || !document.createElement) {
    return previews;
  }
  const prevTarget = renderer.getRenderTarget();
  const prevSize = renderer.getSize(new THREE.Vector2());
  const prevClearColor = renderer.getClearColor(new THREE.Color());
  const prevClearAlpha = renderer.getClearAlpha();
  const target = new THREE.WebGLRenderTarget(PREVIEW_WIDTH, PREVIEW_HEIGHT, {
    colorSpace: THREE.SRGBColorSpace,
  });
  const pixels = new Uint8Array(PREVIEW_WIDTH * PREVIEW_HEIGHT * 4);
  const canvas = document.createElement('canvas');
  canvas.width = PREVIEW_WIDTH;
  canvas.height = PREVIEW_HEIGHT;
  const context = canvas.getContext('2d');
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x0a1a2a, 1);
    for (const def of VEHICLES) {
      let built = null;
      try {
        built = def.build();
      } catch (error) {
        continue;
      }
      try {
        // The real vehicle with its real materials, lit like a
        // product photo: warm golden-hour key from front-right-top,
        // cool rim from back-left, hemisphere fill so undersides
        // never go black. No shadows (no shadow-casting light) —
        // the panel wants a clean read of the aircraft itself.
        const scene = new THREE.Scene();
        scene.add(built.group);
        const keyLight = new THREE.DirectionalLight(0xffe3b3, 2.6);
        keyLight.position.set(6, 8, -7);
        scene.add(keyLight);
        const rimLight = new THREE.DirectionalLight(0x7fb8ff, 1.1);
        rimLight.position.set(-7, 4, 8);
        scene.add(rimLight);
        scene.add(new THREE.HemisphereLight(0xbdd8ff, 0x2a3444, 1.15));
        // Fit a 3/4 front-right-top camera to the vehicle bounds.
        const bounds = new THREE.Box3().setFromObject(built.group);
        const sphere = bounds.getBoundingSphere(new THREE.Sphere());
        const camera = new THREE.PerspectiveCamera(32, PREVIEW_WIDTH / PREVIEW_HEIGHT, 0.1, 200);
        // Fit by the bounding sphere but pull in: aircraft are wide and
        // flat, so a pure vertical sphere fit leaves them tiny in frame.
        // 0.66 puts the projected diagonal at ~90% of the frame width.
        const distance = (sphere.radius / Math.tan(THREE.MathUtils.degToRad(16))) * 0.66;
        const direction = new THREE.Vector3(0.85, 0.36, -0.85).normalize();
        camera.position.copy(sphere.center).addScaledVector(direction, distance);
        camera.lookAt(sphere.center);
        renderer.render(scene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT, pixels);
        if (context) {
          const image = context.createImageData(PREVIEW_WIDTH, PREVIEW_HEIGHT);
          const rowBytes = PREVIEW_WIDTH * 4;
          for (let y = 0; y < PREVIEW_HEIGHT; y += 1) {
            const srcRow = (PREVIEW_HEIGHT - 1 - y) * rowBytes;
            image.data.set(pixels.subarray(srcRow, srcRow + rowBytes), y * rowBytes);
          }
          context.putImageData(image, 0, 0);
          previews[def.id] = canvas.toDataURL('image/png');
        }
      } catch (error) {
        // One bad preview must not lose the rest.
      } finally {
        disposeBuiltVehicle(built);
      }
    }
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClearColor, prevClearAlpha);
    const nowSize = renderer.getSize(new THREE.Vector2());
    if (nowSize.x !== prevSize.x || nowSize.y !== prevSize.y) {
      renderer.setSize(prevSize.x, prevSize.y, false);
    }
    target.dispose();
  }
  return previews;
}
