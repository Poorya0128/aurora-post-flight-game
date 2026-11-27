// cockpit-controls.js — flight controls for the AURORA POST cockpit
// rebuild (user reference: real Sling High Wing cockpit photo).
// SINGLE centre seat adaptation: DUAL yokes flanking the centre
// console (exact-target pass — the target image supersedes the
// earlier centre stick), centre console with T-handle throttle +
// trim wheel, two rudder pedals, overhead fuel selector. Aircraft
// space (forward = -Z): panel centre (0, 0.22, -0.88), pilot eye
// ≈ (0, 0.74, 0.55) effective, seat centre x=0, z≈0.35, floor top
// y≈-0.55. Procedural primitives + canvas textures only, merged per
// material. No external assets, no update loop (static controls).

import * as THREE from 'three';

function makeCanvas(width, height) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// Same build-time merge pattern as cockpit-glass.js / aircraft.js.
function mergeGeometries(geometries) {
  const parts = geometries.map((g) => (g.index ? g.toNonIndexed() : g));
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

function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function cyl(rt, rb, h, seg, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

// Pedal face texture: dark metal with raised grip dots + brand stamp,
// like the reference's Sling-stamped pedals (canvas only).
function pedalTexture() {
  const canvas = makeCanvas(128, 160);
  if (!canvas) return null;
  const c = canvas.getContext('2d');
  c.fillStyle = '#4a4d52';
  c.fillRect(0, 0, 128, 160);
  c.fillStyle = '#2e3034';
  for (let r = 0; r < 8; r += 1) {
    for (let col = 0; col < 5; col += 1) {
      c.beginPath();
      c.arc(16 + col * 24, 18 + r * 16, 5, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.fillStyle = 'rgba(230,230,230,0.55)';
  c.font = '800 15px Arial, sans-serif';
  c.textAlign = 'center';
  c.fillText('AURORA', 64, 150);
  return canvasTexture(canvas);
}

// Fuel selector face: LEFT / RIGHT / OFF arc + FUEL label, red-on-black
// like the reference overhead valve.
function fuelSelectorTexture() {
  const canvas = makeCanvas(256, 256);
  if (!canvas) return null;
  const c = canvas.getContext('2d');
  c.fillStyle = '#101114';
  c.fillRect(0, 0, 256, 256);
  c.strokeStyle = 'rgba(255,255,255,0.25)';
  c.lineWidth = 3;
  c.strokeRect(6, 6, 244, 244);
  c.fillStyle = '#e8e8e8';
  c.font = '800 26px Arial, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('RIGHT', 128, 34);
  c.fillText('LEFT', 34, 128);
  c.fillText('OFF', 222, 128);
  c.fillStyle = '#ff3b30';
  c.font = '800 30px Arial, sans-serif';
  c.fillText('FUEL', 128, 222);
  // Detent ticks around the valve.
  c.fillStyle = '#e8e8e8';
  for (const [x, y] of [[128, 62], [62, 128], [194, 128]]) {
    c.beginPath();
    c.arc(x, y, 5, 0, Math.PI * 2);
    c.fill();
  }
  return canvasTexture(canvas);
}

// Console top labels (throttle quadrant markings), one canvas.
function consoleLabelTexture() {
  const canvas = makeCanvas(256, 512);
  if (!canvas) return null;
  const c = canvas.getContext('2d');
  c.fillStyle = '#14161a';
  c.fillRect(0, 0, 256, 512);
  c.fillStyle = '#ffd9a0';
  c.font = '800 30px Arial, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('THROTTLE', 128, 90);
  c.font = '800 24px Arial, sans-serif';
  c.fillText('FULL', 128, 140);
  c.fillText('IDLE', 128, 300);
  c.fillText('TRIM', 128, 400);
  c.fillText('NOSE UP · DN', 128, 440);
  return canvasTexture(canvas);
}

export function buildCockpitControls(materials = {}) {
  const group = new THREE.Group();
  group.name = 'cockpit-controls';

  // Own materials; caller-supplied ones win where provided.
  const mat = {
    dark: materials.panelDark || new THREE.MeshStandardMaterial({ color: 0x1c2026, roughness: 0.86, metalness: 0.02, envMapIntensity: 0.35 }), // MATFIX: console modelling, not flat black
    grip: materials.knobDark || new THREE.MeshStandardMaterial({ color: 0x1e2024, roughness: 0.52, metalness: 0.05, envMapIntensity: 0.5 }), // MATFIX: rubber grip read (was glossy grey)
    boot: new THREE.MeshStandardMaterial({ color: 0x1e2023, roughness: 0.96, metalness: 0.0 }), // MATFIX: deeper rubber
    metal: materials.metal || new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.3, metalness: 0.85, envMapIntensity: 1.0 }),
    red: new THREE.MeshStandardMaterial({ color: 0xc22418, roughness: 0.42, metalness: 0.1, envMapIntensity: 0.6 }),
    carpet: new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 1, metalness: 0 }), // MATFIX: lifted from near-black void
  };

  // ---- 1. Dual yokes (x=±0.29) flanking the centre console.
  // Exact-target pass: the target image shows two grey ram's-horn
  // yokes at the bottom left/right of the console with the throttle
  // centre. The previous centre stick (Sling adaptation) is REMOVED —
  // the target framing wins. The single centre seat (cockpit-trim.js,
  // x=0, z≈0.35) is unchanged; the yokes sit either side of the
  // console in front of it, columns emerging below the panel.
  // Overlap discipline (M2, verified by capture): from the eye
  // (0, 0.74, 0.55) the PFD bezel bottom sits at ~27.2 deg depression
  // and the NAV bezel bottom at ~27.6 deg. Yoke grip caps (top
  // y~0.21, z~-0.42) project at ~28.9 deg — below both bezels, so no
  // yoke part covers any display; the crossbar (y 0.10, z -0.43)
  // sits at ~33 deg, inside the ~37 deg frame bottom.
  {
    const yokeGrey = new THREE.MeshStandardMaterial({ color: 0x6e757d, roughness: 0.58, metalness: 0.15, envMapIntensity: 0.55 });
    const yokeDark = new THREE.MeshStandardMaterial({ color: 0x4c5258, roughness: 0.6, metalness: 0.2, envMapIntensity: 0.5 });
    const greyParts = [];
    const darkParts = [];
    for (const side of [-1, 1]) {
      const x = side * 0.29;
      // Column: from below the panel bottom edge (y -0.10, z -0.82)
      // up to the hub (y 0.08, z -0.44); cylinder along Y rotated
      // toward +Z by atan2(dz, dy).
      const colTilt = Math.atan2(0.38, 0.18); // ~1.13 rad
      darkParts.push(cyl(0.024, 0.024, 0.42, 10, x, -0.01, -0.63, colTilt, 0, 0)); // column
      darkParts.push(cyl(0.028, 0.052, 0.10, 10, x, -0.06, -0.78, colTilt, 0, 0)); // boot at panel
      greyParts.push(box(0.09, 0.07, 0.06, x, 0.09, -0.43)); // hub
      greyParts.push(box(0.32, 0.032, 0.04, x, 0.10, -0.43)); // crossbar
      for (const g of [-1, 1]) {
        greyParts.push(cyl(0.019, 0.021, 0.12, 10, x + g * 0.145, 0.145, -0.425, 0.1, 0, -g * 0.3)); // grip (splayed)
        greyParts.push(cyl(0.022, 0.022, 0.02, 10, x + g * 0.163, 0.198, -0.42, 0.1, 0, -g * 0.3)); // grip cap (top y ~0.21)
      }
    }
    group.add(new THREE.Mesh(mergeGeometries(darkParts), yokeDark));
    group.add(new THREE.Mesh(mergeGeometries(greyParts), yokeGrey));
    // Red PTT button on the left yoke's outer grip (flown-kit detail).
    const pttParts = [cyl(0.009, 0.009, 0.01, 8, -0.29 - 0.163, 0.185, -0.405, Math.PI / 2, 0, 0)];
    group.add(new THREE.Mesh(mergeGeometries(pttParts), mat.red));
  }

  // ---- 2. Centre console (seat z≈0.35 to panel z=-0.88): body, carpet
  // sides, T-handle throttle, trim wheel, small lever/knob details.
  // Visibility fix (shell-presence pass): top plate raised to y=-0.015
  // (block centre y=-0.30, height 0.50, grounded on the floor at
  // y=-0.55; front edge z=-0.795 just behind the panel) so the
  // console's front top edge sits at ~33 deg depression — inside the
  // frame at bottom-centre below the panel. The throttle quadrant
  // sits at the console's forward end (slot z=-0.59, forward of the
  // stick shaft at z~-0.46) so the T-handle reads beside the grip.
  {
    const bodyParts = [
      box(0.3, 0.5, 0.95, 0, -0.30, -0.32), // console block (grounded on floor y=-0.55)
      box(0.32, 0.04, 0.97, 0, -0.035, -0.32), // top plate (top y=-0.015)
      box(0.3, 0.12, 0.2, 0, -0.10, 0.23), // aft armrest hump toward seat
    ];
    group.add(new THREE.Mesh(mergeGeometries(bodyParts), mat.dark));
    const carpetParts = [
      box(0.02, 0.38, 0.9, -0.16, -0.34, -0.32),
      box(0.02, 0.38, 0.9, 0.16, -0.34, -0.32),
    ];
    group.add(new THREE.Mesh(mergeGeometries(carpetParts), mat.carpet));
    const labelTex = consoleLabelTexture();
    if (labelTex) {
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(0.2, 0.42),
        new THREE.MeshStandardMaterial({ color: 0xffffff, map: labelTex, roughness: 0.85, metalness: 0.02 }),
      );
      label.rotation.x = -Math.PI / 2;
      label.position.set(0, -0.012, -0.52);
      group.add(label);
    }
    // T-handle throttle (target: centre lever, "THROTTLE" label on
    // the console top): slot, stalk, cross grip.
    // Exact-target pass: with the centre stick gone, the quadrant
    // moved aft (slot z=-0.55, crossbar z=-0.54) and the crossbar
    // top raised to y~0.10 so it projects at ~30.4 deg depression
    // from the eye (0, 0.74, 0.55) — below the NAV bezel (~27.6 deg)
    // with margin, and above the HUD target pill so the T reads as
    // its own silhouette between the two yokes. (Earlier positions:
    // y=0.195/z=-0.715 covered the NAV lower strip; y~0.08/z=-0.60
    // hid exactly on the panel-bottom sight line.)
    const metalParts = [
      box(0.035, 0.012, 0.22, 0, -0.008, -0.55), // throttle slot plate
      cyl(0.014, 0.014, 0.10, 8, 0, 0.035, -0.545, -0.25, 0, 0), // stalk
      box(0.20, 0.03, 0.05, 0, 0.09, -0.54, -0.25, 0, 0), // T crossbar (top y ~0.105, clear of the NAV display)
    ];
    // Trim wheel on the right console side + small levers/knobs on top.
    const trimWheel = new THREE.TorusGeometry(0.055, 0.012, 8, 20);
    trimWheel.rotateY(Math.PI / 2);
    trimWheel.translate(0.165, -0.16, -0.05);
    metalParts.push(trimWheel);
    metalParts.push(cyl(0.01, 0.01, 0.03, 8, 0.16, -0.16, -0.05, 0, 0, Math.PI / 2)); // trim hub
    metalParts.push(cyl(0.008, 0.008, 0.07, 8, -0.08, 0.02, -0.58, -0.4, 0, 0)); // small lever
    metalParts.push(cyl(0.014, 0.016, 0.022, 10, 0.08, 0.0, -0.50)); // knob
    metalParts.push(cyl(0.014, 0.016, 0.022, 10, -0.08, 0.0, -0.54)); // knob
    group.add(new THREE.Mesh(mergeGeometries(metalParts), mat.metal));
    const redParts = [
      box(0.05, 0.02, 0.03, 0, 0.0, -0.48), // red guard lever (reference)
    ];
    group.add(new THREE.Mesh(mergeGeometries(redParts), mat.red));
  }

  // ---- 3. Rudder pedals (x=±0.18, z=-0.75): arms + textured faces.
  {
    const armParts = [];
    for (const side of [-1, 1]) {
      armParts.push(box(0.03, 0.3, 0.03, side * 0.18, -0.42, -0.78, 0.3, 0, 0));
    }
    group.add(new THREE.Mesh(mergeGeometries(armParts), mat.metal));
    const pedalTex = pedalTexture();
    // m1: pedals sit below the pilot sightline (no geometry change);
    // faces kept responsive to the panel light if the camera pitches.
    const faceMat = pedalTex
      ? new THREE.MeshStandardMaterial({ color: 0xffffff, map: pedalTex, roughness: 0.4, metalness: 0.55 })
      : mat.metal;
    const faceParts = [];
    for (const side of [-1, 1]) {
      faceParts.push(box(0.13, 0.16, 0.015, side * 0.18, -0.34, -0.74, 0.3, 0, 0));
    }
    group.add(new THREE.Mesh(mergeGeometries(faceParts), faceMat));
  }

  // ---- 4. Overhead fuel selector (y≈1.3, z≈0.0, above/behind eye line —
  // out of the forward sight cone): black panel, printed face, red handle.
  {
    const holder = new THREE.Group();
    holder.position.set(0, 1.3, 0.0);
    holder.rotation.x = 0.9; // face tilted down toward the pilot
    holder.add(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.03), mat.dark));
    const faceTex = fuelSelectorTexture();
    if (faceTex) {
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(0.24, 0.24),
        new THREE.MeshStandardMaterial({ color: 0xffffff, map: faceTex, roughness: 0.85, metalness: 0.02 }),
      );
      face.position.z = 0.016;
      holder.add(face);
    }
    // Red selector handle pointing RIGHT (reference position).
    const handleParts = [
      cyl(0.028, 0.028, 0.025, 12, 0, 0, 0.028, Math.PI / 2, 0, 0), // hub
      box(0.03, 0.09, 0.02, 0, 0.05, 0.04), // pointer tab
    ];
    holder.add(new THREE.Mesh(mergeGeometries(handleParts), mat.red));
    group.add(holder);
  }

  group.traverse((object) => { if (object.isMesh) object.castShadow = false; });
  return group;
}
