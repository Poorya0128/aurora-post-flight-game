// plane-v2.js — STANDALONE preview build of the AURORA POST bush plane,
// rebuilt to match the reference render (cream-white Cessna-like high-wing,
// teal + orange cheatlines, sun-disc tail badge, 'AURORA POST' +
// 'MAIL • ISLAND • EXPRESS' lettering, plain ring wing roundels,
// registration AP-AUR, panel lines/rivets, tinted teal glass, prop blur
// disc, navigation/landing lights, big tundra tires with orange hubs).
//
// NOT wired into the game. Loaded only by preview-plane.html. Integration
// (if approved later) is drop-in: same local axes and layout constants as
// game/src/aircraft.js — forward = -Z, right = +X, up = +Y, origin at CG,
// wheels touch y = PLANE_V2_LAYOUT.gearBottomY, propeller pivot at
// PLANE_V2_LAYOUT.propellerCentre.
//
// buildPlaneV2() -> { group, propeller, bladeGroup, blurDisc,
//   blurDiscMaterial, controlSurfaces, rudderPivot, elevatorPivot, wheels,
//   setPropeller(rpm, angleRad), setControls({pitch, roll, yaw, flaps}) }

import * as THREE from 'three';

export const PLANE_V2_LAYOUT = {
  gearBottomY: -1.32,
  propellerCentre: new THREE.Vector3(0, 0.05, -4.32),
  noseTipZ: -4.35,
  tailTipZ: 4.4,
  wingSpan: 11.0,
  wingCentreY: 1.14,
};

const PALETTE = {
  cream: 0xf8ecd4,
  teal: 0x0e7f93,
  tealDeep: 0x075263,
  orange: 0xf97a1c,
  coral: 0xff6f61,
  amber: 0xffb03a,
  gold: 0xffc94d,
  bellySand: 0xe8d3a8,
  glass: 0x1f8fa8,
  tyre: 0x22242a,
  hubMetal: 0x9aa0a6,
  strutDark: 0x3a3f44,
  panelLine: 0x55504a,
  frameDark: 0x2b3a49,
  propBlade: 0x1a1a1e,
  propTip: 0xffc53d,
};

const TEAL_CSS = '#0e7f93';
const TEAL_DEEP_CSS = '#075263';
const ORANGE_CSS = '#f97a1c';
const CORAL_CSS = '#ff6f61';
const AMBER_CSS = '#ffb03a';
const CREAM_CSS = '#faf0da';
const FONT_STACK = ['AuroraSans', '"Segoe UI"', 'system-ui', 'Arial', 'sans-serif'].join(', ');

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
    texture.anisotropy = 8;
    return texture;
  } catch (error) {
    return null;
  }
}

// Vertical gradient texture (stops: [[offset, cssColor], ...], offset 0 = top
// of the texture). Used for sunset-gradient cheatlines and accents.
function createGradientTexture(stops, width = 64, height = 256) {
  return createCanvasTexture(width, height, (ctx, w, h) => {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    for (const [offset, color] of stops) grad.addColorStop(offset, color);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  });
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

// ------------------------------------------------------------- textures

function paintFuselageSkin() {
  const skin = createCanvasTexture(1024, 512, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const rnd = createSeededRandom(90210);
    for (let n = 0; n < 46; n += 1) {
      const sx = rnd() * w;
      const sy = rnd() * h;
      ctx.strokeStyle = 'rgba(90,80,60,0.10)';
      ctx.lineWidth = 2 + rnd() * 4;
      strokeSegment(ctx, sx, sy, sx + 30 + rnd() * 110, sy + (rnd() - 0.5) * 8);
    }
    // Frame stations + longerons.
    ctx.strokeStyle = 'rgba(85,80,74,0.68)';
    ctx.lineWidth = 2.5;
    for (let px = 64; px < w; px += 96) strokeSegment(ctx, px, 0, px, h);
    ctx.lineWidth = 1.5;
    for (let py = 48; py < h; py += 86) strokeSegment(ctx, 0, py, w, py);
    // Rivets along every panel line.
    ctx.fillStyle = 'rgba(70,64,58,0.65)';
    for (let px = 64; px < w; px += 96) {
      for (let py = 6; py < h; py += 14) ctx.fillRect(px - 1, py, 2, 2);
    }
    for (let py = 48; py < h; py += 86) {
      for (let px = 6; px < w; px += 14) ctx.fillRect(px, py - 1, 2, 2);
    }
    // Access hatches with corner screws.
    ctx.strokeStyle = 'rgba(85,80,74,0.6)';
    ctx.lineWidth = 2;
    for (const [hx, hy, hw, hh] of [[150, 120, 130, 84], [430, 300, 150, 92], [700, 150, 120, 80]]) {
      ctx.strokeRect(hx, hy, hw, hh);
      ctx.fillStyle = 'rgba(60,56,50,0.8)';
      for (const [sx, sy] of [[hx + 6, hy + 6], [hx + hw - 8, hy + 6], [hx + 6, hy + hh - 8], [hx + hw - 8, hy + hh - 8]]) {
        ctx.fillRect(sx, sy, 3, 3);
      }
    }
    // Cabin door outline + handle + hinges.
    ctx.strokeStyle = 'rgba(70,64,58,0.75)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(330, 90, 92, 210);
    ctx.strokeRect(338, 98, 76, 120);
    ctx.fillStyle = 'rgba(50,46,42,0.85)';
    ctx.fillRect(404, 210, 12, 5);
    ctx.fillRect(326, 110, 5, 14);
    ctx.fillRect(326, 260, 5, 14);
    // Exhaust soot wash behind the cowling.
    const soot = ctx.createLinearGradient(0, 0, 260, 0);
    soot.addColorStop(0, 'rgba(38,30,24,0.42)');
    soot.addColorStop(0.55, 'rgba(52,42,32,0.18)');
    soot.addColorStop(1, 'rgba(52,42,32,0)');
    ctx.fillStyle = soot;
    ctx.fillRect(0, 170, 260, 150);
    // Baked registration + stencils.
    ctx.fillStyle = 'rgba(249,122,28,0.92)';
    ctx.font = `800 34px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('AP-AUR', 760, 150);
    ctx.fillStyle = 'rgba(14,127,147,0.75)';
    ctx.font = `800 13px ${FONT_STACK}`;
    ctx.fillText('RESCUE →', 452, 120);
    ctx.fillStyle = 'rgba(70,64,58,0.6)';
    ctx.font = `700 11px ${FONT_STACK}`;
    ctx.fillText('DRAIN', 180, 380);
  });
  if (skin) {
    skin.wrapS = THREE.RepeatWrapping;
    skin.wrapT = THREE.RepeatWrapping;
    skin.repeat.set(2, 1);
  }
  return skin;
}

function paintWingSkin() {
  const skin = createCanvasTexture(1024, 512, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const rnd = createSeededRandom(40917);
    for (let n = 0; n < 30; n += 1) {
      const sx = rnd() * w;
      const sy = rnd() * h;
      ctx.strokeStyle = 'rgba(90,80,60,0.09)';
      ctx.lineWidth = 2 + rnd() * 3;
      strokeSegment(ctx, sx, sy, sx + 40 + rnd() * 90, sy + (rnd() - 0.5) * 6);
    }
    ctx.strokeStyle = 'rgba(85,80,74,0.62)';
    ctx.lineWidth = 2.5;
    for (let px = 48; px < w; px += 84) strokeSegment(ctx, px, 0, px, h);
    for (const py of [110, 256, 400]) strokeSegment(ctx, 0, py, w, py);
    ctx.fillStyle = 'rgba(70,64,58,0.6)';
    for (let px = 48; px < w; px += 84) {
      for (let py = 8; py < h; py += 16) ctx.fillRect(px - 1, py, 2, 2);
    }
    for (const py of [110, 256, 400]) {
      for (let px = 8; px < w; px += 16) ctx.fillRect(px, py - 1, 2, 2);
    }
    ctx.fillStyle = 'rgba(90,80,60,0.10)';
    ctx.fillRect(0, 0, w, 26);
    // Root walkway + fuel caps.
    ctx.fillStyle = 'rgba(45,42,40,0.55)';
    ctx.fillRect(0, 300, 150, 120);
    ctx.fillStyle = 'rgba(255,240,210,0.85)';
    ctx.font = `800 15px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NO STEP', 75, 360);
    for (const [cx, cy] of [[420, 200], [780, 200]]) {
      ctx.beginPath();
      ctx.arc(cx, cy, 16, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(70,64,58,0.7)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(70,64,58,0.7)';
      ctx.fill();
      ctx.font = `700 11px ${FONT_STACK}`;
      ctx.fillText('AVGAS 100LL', cx, cy + 32);
    }
    ctx.strokeStyle = 'rgba(85,80,74,0.55)';
    ctx.lineWidth = 2;
    strokeSegment(ctx, 0, 452, 360, 452);
    strokeSegment(ctx, 560, 452, w, 452);
    ctx.strokeRect(240, 120, 90, 56);
    ctx.strokeRect(620, 330, 90, 56);
  });
  if (skin) {
    skin.wrapS = THREE.RepeatWrapping;
    skin.wrapT = THREE.RepeatWrapping;
    skin.repeat.set(2, 1);
  }
  return skin;
}

function paintTyreTread() {
  const tread = createCanvasTexture(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#8a8f94';
    for (let px = 0; px < w; px += 32) {
      ctx.fillRect(px + 3, 14, 22, 34);
      ctx.fillRect(px + 3, 80, 22, 34);
      ctx.fillRect(px + 3, 52, 22, 24);
    }
    ctx.fillStyle = '#55504a';
    for (let px = 0; px < w; px += 32) ctx.fillRect(px + 28, 0, 4, h);
  });
  if (tread) {
    tread.wrapS = THREE.RepeatWrapping;
    tread.wrapT = THREE.RepeatWrapping;
    tread.repeat.set(18, 2);
  }
  return tread;
}

function createTailLogoTexture() {
  return createCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    // Plain sun-disc badge: amber disc, teal ring, orange core.
    ctx.fillStyle = AMBER_CSS;
    ctx.beginPath();
    ctx.arc(w / 2, h * 0.38, 108, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = TEAL_CSS;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(w / 2, h * 0.38, 82, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = ORANGE_CSS;
    ctx.beginPath();
    ctx.arc(w / 2, h * 0.38, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ORANGE_CSS;
    ctx.font = `800 64px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('AP-AUR', w / 2, h * 0.72);
  });
}

function createWingRoundelTexture() {
  return createCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const ring = (r, color) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    ring(248, TEAL_CSS);
    ring(224, CORAL_CSS);
    ring(198, ORANGE_CSS);
    ring(168, CREAM_CSS);
    ring(110, TEAL_CSS);
    ring(48, CREAM_CSS);
  });
}

function createFuselageLetteringTexture() {
  return createCanvasTexture(1024, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEAL_CSS;
    ctx.font = `800 112px ${FONT_STACK}`;
    ctx.fillText('AURORA POST', w / 2, h / 2 - 42);
    const pillW = 640;
    const pillH = 62;
    const pillX = w / 2 - pillW / 2;
    const pillY = h / 2 + 22;
    const pillGrad = ctx.createLinearGradient(pillX, 0, pillX + pillW, 0);
    pillGrad.addColorStop(0, AMBER_CSS);
    pillGrad.addColorStop(0.5, ORANGE_CSS);
    pillGrad.addColorStop(1, CORAL_CSS);
    ctx.fillStyle = pillGrad;
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, pillH / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 40px ${FONT_STACK}`;
    ctx.fillText('MAIL • ISLAND • EXPRESS', w / 2, pillY + pillH / 2 + 2);
    ctx.fillStyle = CORAL_CSS;
    ctx.font = `800 34px ${FONT_STACK}`;
    ctx.textAlign = 'right';
    ctx.fillText('AP-AUR', w - 24, h - 26);
  });
}

function createPropBlurTexture() {
  return createCanvasTexture(256, 256, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    ctx.clearRect(0, 0, w, h);
    const wash = ctx.createRadialGradient(cx, cy, 8, cx, cy, 126);
    wash.addColorStop(0, 'rgba(28,28,34,0.72)');
    wash.addColorStop(0.35, 'rgba(28,28,34,0.45)');
    wash.addColorStop(0.8, 'rgba(28,28,34,0.30)');
    wash.addColorStop(0.96, 'rgba(255,190,90,0.5)');
    wash.addColorStop(1, 'rgba(255,190,90,0)');
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

// ------------------------------------------------------------- materials

function createMaterials() {
  const flat = (color, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, flatShading: true, ...extra });
  const warmCream = {
    emissive: 0xffdfae, emissiveIntensity: 0.26,
    roughness: 0.36, metalness: 0.12, envMapIntensity: 1.0,
  };
  const fuselageSkin = paintFuselageSkin();
  const wingSkin = paintWingSkin();
  const tyreTread = paintTyreTread();
  const fuselageCream = flat(PALETTE.cream, { ...warmCream });
  if (fuselageSkin) {
    fuselageCream.map = fuselageSkin;
    fuselageCream.bumpMap = fuselageSkin;
    fuselageCream.bumpScale = 0.6;
  }
  const wingCream = flat(PALETTE.cream, { ...warmCream, roughness: 0.47 });
  if (wingSkin) {
    wingCream.map = wingSkin;
    wingCream.bumpMap = wingSkin;
    wingCream.bumpScale = 0.5;
  }
  const wingUnder = flat(0x8e8676, { roughness: 0.74, metalness: 0.02, envMapIntensity: 0.3 });
  if (wingSkin) {
    wingUnder.map = wingSkin;
    wingUnder.bumpMap = wingSkin;
    wingUnder.bumpScale = 0.5;
  }
  const tyre = flat(PALETTE.tyre, { roughness: 0.92, metalness: 0.0, envMapIntensity: 0.35 });
  if (tyreTread) {
    tyre.map = tyreTread;
    tyre.bumpMap = tyreTread;
    tyre.bumpScale = 1.2;
  }
  // Sunset-gradient cheatline materials (deep -> bright across the stripe).
  const cheatTealTex = createGradientTexture([
    [0, '#075263'], [0.45, '#0e7f93'], [1, '#27a7bd'],
  ]);
  const cheatOrangeTex = createGradientTexture([
    [0, '#ffb03a'], [0.5, '#f97a1c'], [1, '#e85d10'],
  ]);
  const cheatTeal = flat(0xffffff, {
    roughness: 0.3, metalness: 0.15, envMapIntensity: 1.0,
    emissive: PALETTE.tealDeep, emissiveIntensity: 0.18,
  });
  if (cheatTealTex) cheatTeal.map = cheatTealTex;
  else cheatTeal.color.setHex(PALETTE.teal);
  const cheatOrange = flat(0xffffff, {
    roughness: 0.32, metalness: 0.12, envMapIntensity: 1.0,
    emissive: PALETTE.orange, emissiveIntensity: 0.14,
  });
  if (cheatOrangeTex) cheatOrange.map = cheatOrangeTex;
  else cheatOrange.color.setHex(PALETTE.orange);
  return {
    fuselageCream,
    wingCream,
    wingUnder,
    cream: flat(PALETTE.cream, { ...warmCream }),
    teal: flat(PALETTE.teal, {
      roughness: 0.3, metalness: 0.15, envMapIntensity: 1.0,
      emissive: PALETTE.tealDeep, emissiveIntensity: 0.28,
    }),
    orange: flat(PALETTE.orange, {
      roughness: 0.32, metalness: 0.12, envMapIntensity: 1.0,
      emissive: PALETTE.orange, emissiveIntensity: 0.22,
    }),
    coral: flat(PALETTE.coral, {
      roughness: 0.34, metalness: 0.1, envMapIntensity: 1.0,
      emissive: PALETTE.coral, emissiveIntensity: 0.2,
    }),
    gold: flat(PALETTE.gold, {
      roughness: 0.3, metalness: 0.35, envMapIntensity: 1.1,
      emissive: PALETTE.amber, emissiveIntensity: 0.22,
    }),
    belly: flat(PALETTE.bellySand, {
      roughness: 0.55, metalness: 0.05, envMapIntensity: 0.6,
      emissive: 0xd9a86a, emissiveIntensity: 0.12,
    }),
    cheatTeal,
    cheatOrange,
    spinner: flat(PALETTE.coral, {
      roughness: 0.25, metalness: 0.35, envMapIntensity: 1.15,
      emissive: PALETTE.coral, emissiveIntensity: 0.18,
    }),
    // Opaque frosted glass: matte dark-teal, NOT see-through — the cabin
    // interior behind it must never show the hollow fuselage.
    tintedGlass: flat(0x1b7f9e, {
      roughness: 0.42, metalness: 0.2, envMapIntensity: 0.9,
      emissive: 0x0e4a5c, emissiveIntensity: 0.45,
      side: THREE.DoubleSide,
    }),
    // Dark cabin interior block/panels behind the glass (seals every
    // gap between panes so no hollow fuselage is ever visible).
    cabinInterior: flat(0x1c242c, {
      roughness: 0.92, metalness: 0.0, envMapIntensity: 0.25,
      side: THREE.DoubleSide,
    }),
    frame: flat(PALETTE.frameDark, { roughness: 0.55, metalness: 0.1, envMapIntensity: 0.5 }),
    panelLine: flat(PALETTE.panelLine, { roughness: 0.65, metalness: 0.2, envMapIntensity: 0.6 }),
    tyre,
    hubMetal: flat(PALETTE.hubMetal, { roughness: 0.28, metalness: 0.85, envMapIntensity: 1.1 }),
    strut: flat(PALETTE.strutDark, { roughness: 0.35, metalness: 0.7, envMapIntensity: 0.9 }),
    exhaustMetal: flat(0x4a423c, { roughness: 0.45, metalness: 0.8, envMapIntensity: 0.8 }),
    propBlade: flat(PALETTE.propBlade, { roughness: 0.45, metalness: 0.35, envMapIntensity: 0.5 }),
    propTip: flat(PALETTE.propTip, {
      emissive: PALETTE.propTip, emissiveIntensity: 0.28, roughness: 0.5,
    }),
  };
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

// ------------------------------------------------------------- propeller

function buildPropeller(materials) {
  const propeller = new THREE.Group();
  propeller.position.copy(PLANE_V2_LAYOUT.propellerCentre);
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.48, 16), materials.spinner);
  spinner.rotation.x = -Math.PI / 2;
  spinner.position.z = -0.1;
  propeller.add(spinner);
  const bladeGroup = new THREE.Group();
  for (let i = 0; i < 3; i += 1) {
    const holder = new THREE.Group();
    holder.rotation.z = (i / 3) * Math.PI * 2;
    const blade = box(0.1, 0.92, 0.035, materials.propBlade, 0, 0.58, 0);
    blade.rotation.y = 0.35;
    holder.add(blade);
    const tip = box(0.108, 0.19, 0.038, materials.propTip, 0, 0.955, 0);
    tip.rotation.y = 0.35;
    holder.add(tip);
    bladeGroup.add(holder);
  }
  propeller.add(bladeGroup);
  const blurTexture = createPropBlurTexture();
  const blurDiscMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0,
    side: THREE.DoubleSide, depthWrite: false,
  });
  if (blurTexture) blurDiscMaterial.map = blurTexture;
  else blurDiscMaterial.color.setHex(0x2b2b30);
  const blurDisc = new THREE.Mesh(new THREE.CircleGeometry(1.06, 32), blurDiscMaterial);
  blurDisc.position.z = 0.02;
  blurDisc.visible = false;
  propeller.add(blurDisc);
  return { propeller, bladeGroup, blurDisc, blurDiscMaterial };
}

// -------------------------------------------------------------- fuselage

function buildFuselage(materials) {
  const body = new THREE.Group();
  const profile = [
    [0.03, -4.4], [0.18, -4.0], [0.32, -3.0], [0.48, -1.8],
    [0.62, -0.8], [0.72, 0.2], [0.74, 0.9], [0.7, 1.6],
    [0.62, 2.4], [0.58, 3.2], [0.52, 3.9], [0.3, 4.15], [0.06, 4.25],
  ].map(([radius, y]) => new THREE.Vector2(radius, y));
  const fuselage = new THREE.Mesh(new THREE.LatheGeometry(profile, 20), materials.fuselageCream);
  fuselage.rotation.x = -Math.PI / 2;
  fuselage.scale.set(0.92, 1, 1.08);
  body.add(fuselage);

  // Two-tone belly: warm sand shell hugging the underside (partial lathe,
  // same profile slightly proud of the skin). In lathe space the underside
  // after the -90° X rotation sits at phi = PI, so centre the arc there.
  const bellyProfile = profile.map((p) => new THREE.Vector2(p.x + 0.012, p.y));
  const belly = new THREE.Mesh(
    new THREE.LatheGeometry(bellyProfile, 14, Math.PI - 0.95, 1.9),
    materials.belly,
  );
  belly.rotation.x = -Math.PI / 2;
  belly.scale.set(0.92, 1, 1.08);
  body.add(belly);

  // Cowling: dark intake ring around the spinner + side intakes/slots.
  const noseRing = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.34, 0.16, 20, 1, true),
    materials.panelLine,
  );
  noseRing.rotation.x = Math.PI / 2;
  noseRing.position.set(0, 0.05, -4.22);
  body.add(noseRing);
  for (const side of [-1, 1]) {
    body.add(box(0.3, 0.16, 0.06, materials.panelLine, side * 0.26, -0.12, -4.18));
    body.add(box(0.05, 0.3, 0.7, materials.panelLine, side * 0.52, -0.05, -3.55));
  }

  // Greenhouse: flat trapezoidal windscreen + side panes, tinted teal
  // glass, dark frame bars (mirrors the reference render).
  const WS = {
    bl: new THREE.Vector3(-0.66, 0.28, -1.62),
    br: new THREE.Vector3(0.66, 0.28, -1.62),
    tr: new THREE.Vector3(0.70, 1.10, -1.20),
    tl: new THREE.Vector3(-0.70, 1.10, -1.20),
  };
  // Raised cabin roof fairing: cream hump standing proud of the
  // fuselage line (top y = 1.11) that the wing sits on.
  body.add(box(1.16, 0.30, 2.35, materials.cream, 0, 0.96, -0.30));
  // Opaque cabin interior: a dark core block filling the greenhouse so
  // the hollow fuselage is never visible through (or between) the
  // panes — that volume is the cabin. Backing panels sit just inside
  // the side and rear panes; a backing quad sits behind the windscreen.
  body.add(box(1.12, 0.98, 2.0, materials.cabinInterior, 0, 0.56, -0.15));
  body.add(paneQuad(
    new THREE.Vector3(-0.64, 0.26, -1.56),
    new THREE.Vector3(0.64, 0.26, -1.56),
    new THREE.Vector3(0.68, 1.08, -1.14),
    new THREE.Vector3(-0.68, 1.08, -1.14),
    materials.cabinInterior,
  ));
  for (const side of [-1, 1]) {
    // Side-window backing panel (just inside the side panes).
    body.add(box(0.04, 1.02, 1.5, materials.cabinInterior, side * 0.59, 0.57, -0.4));
    // Rear-window backing panel (fixes the rear window's inside).
    body.add(box(0.04, 0.88, 0.78, materials.cabinInterior, side * 0.55, 0.58, 0.64));
  }
  // Windscreen quad wound so its normal faces forward/up (lit side out).
  body.add(paneQuad(WS.br, WS.bl, WS.tl, WS.tr, materials.tintedGlass));
  body.add(box(1.47, 0.06, 0.08, materials.frame, 0, 1.10, -1.20));
  body.add(barBetween(WS.bl, WS.br, 0.045, 0.045, materials.frame));
  for (const side of [-1, 1]) {
    const top = side < 0 ? WS.tl : WS.tr;
    const bot = side < 0 ? WS.bl : WS.br;
    body.add(barBetween(bot, top, 0.05, 0.05, materials.frame));
    const gSillF = new THREE.Vector3(side * 0.65, 0.04, -1.62);
    const gSillR = new THREE.Vector3(side * 0.65, 0.04, 0.22);
    const gMidR = new THREE.Vector3(side * 0.65, 0.28, 0.22);
    const gTopR = new THREE.Vector3(side * 0.65, 1.10, 0.22);
    // Side panes wound so normals face outward on both sides.
    if (side > 0) {
      body.add(paneQuad(gSillR, gSillF, bot, gMidR, materials.tintedGlass));
      body.add(paneQuad(gMidR, bot, top, gTopR, materials.tintedGlass));
    } else {
      body.add(paneQuad(gSillF, gSillR, gMidR, bot, materials.tintedGlass));
      body.add(paneQuad(bot, gMidR, gTopR, top, materials.tintedGlass));
    }
    body.add(barBetween(bot, gSillF, 0.05, 0.05, materials.frame));
    body.add(box(0.03, 0.88, 0.78, materials.tintedGlass, side * 0.60, 0.58, 0.64));
    body.add(barBetween(top, new THREE.Vector3(side * 0.65, 1.10, 0.22), 0.045, 0.045, materials.frame));
    body.add(barBetween(
      new THREE.Vector3(side * 0.60, 1.02, 0.22),
      new THREE.Vector3(side * 0.60, 1.02, 1.03), 0.045, 0.045, materials.frame,
    ));
    body.add(barBetween(
      new THREE.Vector3(side * 0.65, 0.04, -1.62),
      new THREE.Vector3(side * 0.65, 0.04, 0.22), 0.04, 0.045, materials.frame,
    ));
    body.add(box(0.035, 0.04, 0.82, materials.frame, side * 0.60, 0.12, 0.64));
    body.add(box(0.05, 1.06, 0.10, materials.frame, side * 0.625, 0.57, 0.22));
    body.add(barBetween(
      new THREE.Vector3(side * 0.677, 0.62, -1.446),
      new THREE.Vector3(side * 0.65, 0.62, 0.22), 0.035, 0.032, materials.frame,
    ));
    body.add(box(0.035, 0.032, 0.78, materials.frame, side * 0.60, 0.62, 0.64));
  }

  // Panel-line station rings.
  for (const station of [
    { z: -2.0, radius: 0.66 }, { z: -0.5, radius: 0.73 },
    { z: 1.2, radius: 0.56 }, { z: 2.6, radius: 0.39 },
  ]) {
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(station.radius + 0.006, station.radius + 0.006, 0.025, 20, 1, true),
      materials.panelLine,
    );
    ring.rotation.x = Math.PI / 2;
    ring.scale.set(0.92, 1, 1.08);
    ring.position.z = station.z;
    body.add(ring);
  }

  // Door outlines + handles.
  for (const side of [-1, 1]) {
    const doorX = side * 0.665;
    body.add(box(0.015, 0.02, 1.0, materials.panelLine, doorX, 0.00, -0.65));
    body.add(box(0.015, 0.02, 1.0, materials.panelLine, doorX, -0.28, -0.65));
    body.add(box(0.015, 0.28, 0.02, materials.panelLine, doorX, -0.14, -1.15));
    body.add(box(0.015, 0.28, 0.02, materials.panelLine, doorX, -0.14, -0.15));
    body.add(box(0.03, 0.03, 0.16, materials.hubMetal, side * 0.68, -0.02, -0.25));
  }

  // Sunset cheatline stack, segmented along the taper (top -> bottom):
  // gold pinstripe, gradient teal, coral band, gradient orange.
  const cheatlineSegments = [
    { z: -3.55, length: 1.3, x: 0.52 }, { z: -2.9, length: 1.6, x: 0.56 },
    { z: -1.2, length: 1.9, x: 0.66 }, { z: 0.5, length: 1.6, x: 0.62 },
    { z: 2.0, length: 1.5, x: 0.48 }, { z: 3.2, length: 1.0, x: 0.33 },
    { z: 3.95, length: 0.6, x: 0.2 },
  ];
  for (const side of [-1, 1]) {
    for (const segment of cheatlineSegments) {
      body.add(box(0.042, 0.02, segment.length, materials.gold, side * segment.x, 0.12, segment.z));
      body.add(box(0.04, 0.13, segment.length, materials.cheatTeal, side * segment.x, 0.04, segment.z));
      body.add(box(0.042, 0.04, segment.length, materials.coral, side * segment.x, -0.045, segment.z));
      body.add(box(0.04, 0.13, segment.length, materials.cheatOrange, side * segment.x, -0.135, segment.z));
    }
  }

  // Fuselage lettering decals: curved cylinder segments hugging the
  // tapered rear fuselage (a flat plane would bury its front edge).
  const letteringTexture = createFuselageLetteringTexture();
  if (letteringTexture) {
    // Cylinder v runs along the fuselage axis, so rotate the canvas
    // art 90 degrees to keep the title reading nose-to-tail.
    letteringTexture.center.set(0.5, 0.5);
    letteringTexture.rotation = Math.PI / 2;
    const mat = decalMaterial(letteringTexture);
    for (const side of [-1, 1]) {
      const thetaCentre = side > 0 ? Math.PI / 2 : (3 * Math.PI) / 2;
      const thetaLength = THREE.MathUtils.degToRad(78);
      const geo = new THREE.CylinderGeometry(
        0.48, 0.7, 2.0, 16, 1, true, thetaCentre - thetaLength / 2, thetaLength,
      );
      geo.rotateX(Math.PI / 2); // axis -> Z, small radius -> tail (+Z)
      const decal = new THREE.Mesh(geo, mat);
      decal.scale.set(0.92, 1.08, 1); // match fuselage elliptical section
      decal.position.set(0, 0.02, 1.9);
      body.add(decal);
    }
  }

  // Exhaust, antenna mast + wire, belly step.
  body.add(strutBetween(
    new THREE.Vector3(0.34, -0.3, -3.5),
    new THREE.Vector3(0.46, -0.55, -2.85), 0.045, materials.exhaustMetal,
  ));
  body.add(box(0.03, 0.22, 0.08, materials.strut, 0, 1.20, 0.72));
  body.add(strutBetween(
    new THREE.Vector3(0, 1.30, 0.72),
    new THREE.Vector3(0, 1.42, 3.6), 0.006, materials.strut,
  ));
  body.add(box(0.3, 0.04, 0.18, materials.strut, -0.72, -0.62, -0.6));
  return body;
}

// ------------------------------------------------------------------ wing

function buildWing(materials) {
  const wing = new THREE.Group();
  wing.name = 'aircraft-wing';
  const controlSurfaces = { aileronLeft: null, aileronRight: null, flapLeft: null, flapRight: null };
  const roundelTexture = createWingRoundelTexture();
  const roundelMat = roundelTexture ? decalMaterial(roundelTexture) : null;

  for (const side of [-1, 1]) {
    const halfWing = new THREE.Group();
    halfWing.position.set(0, PLANE_V2_LAYOUT.wingCentreY, -0.55);
    halfWing.rotation.z = side * THREE.MathUtils.degToRad(2.5);
    halfWing.add(box(5.5, 0.13, 1.55, materials.wingCream, side * 2.75, 0, 0));
    halfWing.add(box(5.5, 0.02, 1.5, materials.wingUnder, side * 2.75, -0.075, 0));
    // Gradient-teal leading-edge stripe.
    halfWing.add(box(5.5, 0.135, 0.07, materials.cheatTeal, side * 2.75, 0, -0.74));
    // Sunset wingtip: teal -> coral -> gold edge.
    halfWing.add(box(0.22, 0.14, 1.5, materials.teal, side * 5.14, 0, 0));
    halfWing.add(box(0.24, 0.14, 1.5, materials.coral, side * 5.37, 0, 0));
    halfWing.add(box(0.06, 0.145, 1.5, materials.gold, side * 5.52, 0, 0));
    // Rib lines top + bottom.
    for (let x = 0.8; x < 5.2; x += 0.8) {
      halfWing.add(box(0.03, 0.012, 1.45, materials.panelLine, side * x, 0.07, 0));
      halfWing.add(box(0.03, 0.012, 1.42, materials.panelLine, side * x, -0.086, 0));
    }
    // Plain ring roundels: top + underside of each wing.
    if (roundelMat) {
      const top = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.35), roundelMat);
      top.rotation.x = -Math.PI / 2;
      top.position.set(side * 4.1, 0.072, 0);
      halfWing.add(top);
      const under = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.35), roundelMat);
      under.rotation.x = Math.PI / 2;
      under.position.set(side * 4.1, -0.087, 0);
      halfWing.add(under);
    }
    // Flap + aileron on hinge pivots.
    const flapPivot = new THREE.Group();
    flapPivot.position.set(side * 1.15, -0.02, 0.72);
    flapPivot.add(box(1.9, 0.05, 0.42, materials.cream, 0, 0, 0.21));
    halfWing.add(flapPivot);
    const aileronPivot = new THREE.Group();
    aileronPivot.position.set(side * 3.9, -0.02, 0.72);
    aileronPivot.add(box(2.6, 0.05, 0.4, materials.cream, 0, 0, 0.2));
    halfWing.add(aileronPivot);
    if (side < 0) {
      controlSurfaces.flapLeft = flapPivot;
      controlSurfaces.aileronLeft = aileronPivot;
    } else {
      controlSurfaces.flapRight = flapPivot;
      controlSurfaces.aileronRight = aileronPivot;
    }
    wing.add(halfWing);
    // V-struts, cream faired.
    wing.add(strutBetween(
      new THREE.Vector3(side * 0.5, -0.4, -0.95),
      new THREE.Vector3(side * 2.55, 1.06, -0.85), 0.04, materials.cream,
    ));
    wing.add(strutBetween(
      new THREE.Vector3(side * 0.5, -0.4, -0.05),
      new THREE.Vector3(side * 2.55, 1.06, -0.3), 0.04, materials.cream,
    ));
  }
  wing.add(strutBetween(
    new THREE.Vector3(-2.2, 1.04, -1.25),
    new THREE.Vector3(-2.2, 0.88, -1.45), 0.012, materials.hubMetal,
  ));
  return { wing, controlSurfaces };
}

// ------------------------------------------------------------------ tail

function buildTail(materials) {
  const tail = new THREE.Group();
  // Cream fin (reference render) with sun-disc badge + AP-AUR decals.
  const finShape = new THREE.Shape();
  finShape.moveTo(0.95, 0.05);
  finShape.lineTo(0.15, 1.42);
  finShape.lineTo(-0.7, 1.48);
  finShape.lineTo(-1.0, 0.1);
  finShape.lineTo(0.95, 0.05);
  const fin = new THREE.Mesh(
    new THREE.ExtrudeGeometry(finShape, { depth: 0.09, bevelEnabled: false }),
    materials.cream,
  );
  fin.rotation.y = Math.PI / 2;
  fin.position.set(-0.045, 0.1, 3.45);
  tail.add(fin);
  const finCap = box(0.1, 0.09, 0.92, materials.coral, 0, 1.54, 3.72);
  finCap.rotation.x = -0.07;
  tail.add(finCap);
  const logoTexture = createTailLogoTexture();
  if (logoTexture) {
    const mat = decalMaterial(logoTexture);
    for (const side of [-1, 1]) {
      const logo = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.15), mat);
      logo.position.set(side * 0.055, 0.95, 3.72);
      logo.rotation.y = side * (Math.PI / 2);
      tail.add(logo);
    }
  }
  // Rudder on its pivot, teal.
  const rudderPivot = new THREE.Group();
  rudderPivot.position.set(0, 0.75, 4.05);
  const rudderShape = new THREE.Shape();
  rudderShape.moveTo(0, -0.62);
  rudderShape.lineTo(-0.42, -0.6);
  rudderShape.lineTo(-0.38, 0.68);
  rudderShape.lineTo(0, 0.72);
  rudderShape.lineTo(0, -0.62);
  const rudder = new THREE.Mesh(
    new THREE.ExtrudeGeometry(rudderShape, { depth: 0.07, bevelEnabled: false }),
    materials.teal,
  );
  rudder.rotation.y = Math.PI / 2;
  rudder.position.set(-0.035, 0, 0);
  rudderPivot.add(rudder);
  tail.add(rudderPivot);
  // Stabiliser + elevator, coral tips.
  tail.add(box(3.6, 0.09, 0.85, materials.cream, 0, 0.28, 3.75));
  tail.add(box(3.6, 0.095, 0.06, materials.gold, 0, 0.28, 3.35));
  const elevatorPivot = new THREE.Group();
  elevatorPivot.position.set(0, 0.28, 4.16);
  elevatorPivot.add(box(3.4, 0.05, 0.42, materials.cream, 0, 0, 0.21));
  elevatorPivot.add(box(3.4, 0.055, 0.05, materials.coral, 0, 0, 0.42));
  tail.add(elevatorPivot);
  tail.add(box(0.3, 0.1, 0.8, materials.coral, -1.68, 0.28, 3.78));
  tail.add(box(0.3, 0.1, 0.8, materials.coral, 1.68, 0.28, 3.78));
  return { tail, rudderPivot, elevatorPivot };
}

// ------------------------------------------------------------------ gear

function buildGear(materials) {
  const gear = new THREE.Group();
  const wheels = [];
  function buildWheel(tyreRadius, tubeRadius, x, y, z) {
    const wheelGroup = new THREE.Group();
    wheelGroup.position.set(x, y, z);
    const tyre = new THREE.Mesh(new THREE.TorusGeometry(tyreRadius, tubeRadius, 12, 24), materials.tyre);
    tyre.rotation.y = Math.PI / 2;
    wheelGroup.add(tyre);
    // Orange hub disc + metal cap (reference render).
    const hubDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(tyreRadius * 0.55, tyreRadius * 0.55, tubeRadius * 1.4, 16),
      materials.orange,
    );
    hubDisc.rotation.z = Math.PI / 2;
    wheelGroup.add(hubDisc);
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(tyreRadius * 0.22, tyreRadius * 0.22, tubeRadius * 1.7, 12),
      materials.hubMetal,
    );
    cap.rotation.z = Math.PI / 2;
    wheelGroup.add(cap);
    gear.add(wheelGroup);
    wheels.push({ wheelGroup, radius: tyreRadius + tubeRadius });
    return wheelGroup;
  }
  // Big tundra mains: outer radius 0.53, centre y -0.79 -> contact -1.32.
  for (const side of [-1, 1]) {
    buildWheel(0.36, 0.17, side * 0.98, -0.79, -0.35);
    gear.add(strutBetween(
      new THREE.Vector3(side * 0.48, -0.42, -0.35),
      new THREE.Vector3(side * 0.98, -0.79, -0.35), 0.055, materials.cream,
    ));
    gear.add(strutBetween(
      new THREE.Vector3(side * 0.45, -0.5, 0.25),
      new THREE.Vector3(side * 0.98, -0.79, -0.35), 0.03, materials.strut,
    ));
    gear.add(box(0.1, 0.4, 0.18, materials.cream, side * 0.8, -0.62, -0.35));
  }
  // Nose wheel: outer radius 0.32, centre y -1.0 -> contact -1.32.
  buildWheel(0.22, 0.1, 0, -1.0, -2.95);
  gear.add(strutBetween(
    new THREE.Vector3(0, -0.35, -3.05),
    new THREE.Vector3(0, -1.0, -2.95), 0.045, materials.strut,
  ));
  gear.add(box(0.16, 0.3, 0.05, materials.strut, 0, -0.92, -2.95));
  return { gear, wheels };
}

// ------------------------------------------------------------ nav lights

// Soft radial glow sprite texture (white core fading out), tinted per light.
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

function buildNavLights() {
  const lights = new THREE.Group();
  const glowTexture = createGlowTexture();
  function addGlow(colorHex, x, y, z, scale, opacity = 0.85) {
    if (!glowTexture) return;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture, color: colorHex, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity,
    }));
    glow.position.set(x, y, z);
    glow.scale.set(scale, scale, 1);
    lights.add(glow);
  }
  function light(colorHex, x, y, z, bulbRadius = 0.045, glowScale = 0.55) {
    const mat = new THREE.MeshStandardMaterial({
      color: colorHex, emissive: colorHex, emissiveIntensity: 2.6,
      roughness: 0.25, metalness: 0.1,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(bulbRadius, 10, 8), mat);
    bulb.position.set(x, y, z);
    lights.add(bulb);
    addGlow(colorHex, x, y, z, glowScale);
  }
  // Navigation lights: red left (-X), green right (+X), white tail.
  light(0xff3b30, -5.52, 1.38, -0.55);
  light(0x7dffb2, 5.52, 1.38, -0.55);
  light(0xffffff, 0, 0.35, 4.42);
  // Red anti-collision beacon on top of the fin.
  light(0xff3b30, 0, 1.62, 3.8, 0.055, 0.7);
  // Landing/taxi lights in the wing leading edge (warm white).
  for (const side of [-1, 1]) {
    const lens = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.09, 0.04),
      new THREE.MeshStandardMaterial({
        color: 0xfff2cf, emissive: 0xffe9b0, emissiveIntensity: 3.2,
        roughness: 0.2, metalness: 0.1,
      }),
    );
    lens.position.set(side * 1.35, PLANE_V2_LAYOUT.wingCentreY + 0.06, -1.33);
    lights.add(lens);
    addGlow(0xffe9b0, side * 1.35, PLANE_V2_LAYOUT.wingCentreY + 0.06, -1.4, 0.85, 0.9);
  }
  return lights;
}

// ------------------------------------------------------------------ main

export function buildPlaneV2() {
  const materials = createMaterials();
  const group = new THREE.Group();
  group.name = 'aircraft-v2-preview';
  const fuselage = buildFuselage(materials);
  const wingBuild = buildWing(materials);
  const tailBuild = buildTail(materials);
  const gearBuild = buildGear(materials);
  const propBuild = buildPropeller(materials);
  group.add(
    fuselage,
    wingBuild.wing,
    tailBuild.tail,
    gearBuild.gear,
    propBuild.propeller,
    buildNavLights(),
  );
  group.traverse((object) => {
    if (!object.isMesh || object.material.transparent) return;
    if (object.material === materials.panelLine) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    const b = object.geometry.boundingBox;
    const volume = (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
    object.castShadow = volume >= 0.03;
  });
  propBuild.propeller.traverse((object) => {
    if (object.isMesh) object.castShadow = false;
  });
  propBuild.bladeGroup.traverse((object) => {
    if (object.isMesh) object.castShadow = true;
  });

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function setPropeller(rpm, angleRad) {
    propBuild.propeller.rotation.z = angleRad;
    const bladesVisible = rpm < 1000;
    const discOpacity = clamp((rpm - 450) / 1100, 0, 1) * 0.62;
    propBuild.bladeGroup.visible = bladesVisible;
    propBuild.blurDiscMaterial.opacity = discOpacity;
    propBuild.blurDisc.visible = discOpacity > 0.01;
    propBuild.blurDisc.rotation.z = angleRad * 0.12;
  }

  function setControls(controls = {}) {
    const pitch = clamp(controls.pitch || 0, -1, 1);
    const roll = clamp(controls.roll || 0, -1, 1);
    const yaw = clamp(controls.yaw || 0, -1, 1);
    const flaps = clamp(Math.round(controls.flaps || 0), 0, 2);
    wingBuild.controlSurfaces.aileronLeft.rotation.x = roll * 0.45;
    wingBuild.controlSurfaces.aileronRight.rotation.x = -roll * 0.45;
    wingBuild.controlSurfaces.flapLeft.rotation.x = flaps * 0.26;
    wingBuild.controlSurfaces.flapRight.rotation.x = flaps * 0.26;
    tailBuild.elevatorPivot.rotation.x = -pitch * 0.5;
    tailBuild.rudderPivot.rotation.y = yaw * 0.45;
  }

  return {
    group,
    gear: gearBuild.gear,
    wingGroup: wingBuild.wing,
    propeller: propBuild.propeller,
    bladeGroup: propBuild.bladeGroup,
    blurDisc: propBuild.blurDisc,
    blurDiscMaterial: propBuild.blurDiscMaterial,
    controlSurfaces: wingBuild.controlSurfaces,
    rudderPivot: tailBuild.rudderPivot,
    elevatorPivot: tailBuild.elevatorPivot,
    wheels: gearBuild.wheels,
    setPropeller,
    setControls,
  };
}
