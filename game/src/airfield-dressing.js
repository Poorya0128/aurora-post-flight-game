// airfield-dressing.js — V6-AIRFIELD detail pass (tower-reference match).
// One job: dress Aurora Field toward the user's idealised tower view —
// a detailed wooden hangar/barn (plank walls, sheened metal roof, OPEN
// gable doors with interior props, lean-to), pine clusters flanking the
// strip, post-and-rail fences, small outbuildings, crates + barrels,
// worn-asphalt runway overlay + dirt taxiway/apron, glowing edge-light
// blocks with ground-glow pools, extra big sunset clouds for the tower
// sky, a prop ghost-blur disc and warm rim/fill lights. Everything is
// code-generated (canvas textures + geometry, no downloaded assets),
// visual only: nothing here is collidable, scored or read by flight.js
// (terrain heights and obstacle trees stay frozen in world.js).
//
// Collision avoidance: world.js / world-dressing.js / render.js /
// aircraft.js belong to the World Look Agent in this pass, so this
// module edits none of them. The old metal hangar and old edge markers
// are hidden at runtime by scene traversal and replaced visually here.
// Hooked from main.js (import + build + one update call).
//
// Cost: 8 airfield draw calls (wooden structures merged 1, metal roofs
// merged 1, props merged 1, pines instanced 1, edge blocks instanced 1,
// glow instanced 1, runway overlay merged 1, taxiway/apron merged 1)
// + clouds 1 + prop disc 1. No per-frame allocation.

import * as THREE from 'three';

// ---------------------------------------------------------------- helpers

function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
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
  texture.anisotropy = 4;
  return texture;
}

// Merge geometries carrying position/normal/uv (same pattern as
// world.js mergeStaticGeometries; not exported there, so local copy).
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

// Merge geometries with a flat colour per part (vertex colours).
function mergeColored(entries) {
  const parts = entries.map((entry) => {
    const geometry = entry.geometry.index ? entry.geometry.toNonIndexed() : entry.geometry;
    const color = new THREE.Color(entry.color);
    const count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  });
  let vertexCount = 0;
  for (const part of parts) vertexCount += part.attributes.position.count;
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  let offset = 0;
  for (const part of parts) {
    position.set(part.attributes.position.array, offset * 3);
    normal.set(part.attributes.normal.array, offset * 3);
    color.set(part.attributes.color.array, offset * 3);
    offset += part.attributes.position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return merged;
}

function scaleUV(geometry, su, sv) {
  const uv = geometry.attributes.uv;
  if (!uv) return geometry;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geometry;
}

// Box with UVs scaled so a wrapping texture tiles roughly every
// `tileM` metres on the largest face (planks stay plank-sized).
function plankBox(w, h, d, tileM) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  const s = Math.max(w, h, d) / (tileM || 4.5);
  return scaleUV(geometry, s, s);
}

const _obj = new THREE.Object3D();
function place(geometry, x, y, z, ry, rx, rz) {
  _obj.position.set(x, y, z);
  _obj.rotation.set(rx || 0, ry || 0, rz || 0);
  _obj.scale.set(1, 1, 1);
  _obj.updateMatrix();
  geometry.applyMatrix4(_obj.matrix);
  return geometry;
}

// ---------------------------------------------------------------- textures

// Weathered vertical barn planks: per-board tone, dark gaps, grain
// streaks, knots, nail dots, grime toward the bottom edge.
function makePlankTexture() {
  const texture = canvasTexture(512, 512, (ctx, w, h) => {
    const rng = seededRandom(7411);
    ctx.fillStyle = '#7d6248';
    ctx.fillRect(0, 0, w, h);
    const boards = 8;
    const bw = w / boards;
    for (let b = 0; b < boards; b++) {
      const tone = 0.82 + rng() * 0.36;
      const r = Math.round(138 * tone);
      const g = Math.round(108 * tone);
      const bl = Math.round(76 * tone);
      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + bl + ')';
      ctx.fillRect(b * bw, 0, bw, h);
      // Grain streaks down the board.
      for (let s = 0; s < 26; s++) {
        const gx = b * bw + rng() * bw;
        ctx.fillStyle = rng() > 0.5 ? 'rgba(60,42,24,0.16)' : 'rgba(235,215,180,0.10)';
        ctx.fillRect(gx, rng() * h * 0.4, 1.4, 60 + rng() * 220);
      }
      // Knot.
      if (rng() > 0.45) {
        const kx = b * bw + bw * (0.3 + rng() * 0.4);
        const ky = rng() * h;
        ctx.fillStyle = 'rgba(52,36,20,0.55)';
        ctx.beginPath();
        ctx.ellipse(kx, ky, 4.5, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(30,20,10,0.6)';
        ctx.beginPath();
        ctx.ellipse(kx, ky, 2, 3.2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // Gap shadow + highlight edge.
      ctx.fillStyle = 'rgba(24,16,8,0.85)';
      ctx.fillRect(b * bw, 0, 3, h);
      ctx.fillStyle = 'rgba(255,240,210,0.13)';
      ctx.fillRect(b * bw + 3, 0, 2, h);
      // Nails near top/bottom.
      ctx.fillStyle = 'rgba(35,30,28,0.8)';
      ctx.beginPath(); ctx.arc(b * bw + bw / 2, 26, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(b * bw + bw / 2, h - 26, 2.2, 0, Math.PI * 2); ctx.fill();
    }
    // Wear: sun-bleach blotches + bottom grime.
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(230,215,190,0.06)' : 'rgba(40,28,16,0.07)';
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 24 + rng() * 60, 10 + rng() * 26, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const grime = ctx.createLinearGradient(0, h * 0.72, 0, h);
    grime.addColorStop(0, 'rgba(30,22,12,0)');
    grime.addColorStop(1, 'rgba(30,22,12,0.4)');
    ctx.fillStyle = grime;
    ctx.fillRect(0, h * 0.72, w, h * 0.28);
  });
  if (texture) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  return texture;
}

// Standing-seam metal roof: blue-grey panels, seam ribs, rust weep,
// broad sheen band so the low sun streaks across it.
function makeMetalRoofTexture() {
  const texture = canvasTexture(512, 256, (ctx, w, h) => {
    const rng = seededRandom(913);
    ctx.fillStyle = '#7e8a96';
    ctx.fillRect(0, 0, w, h);
    const panels = 10;
    const pw = w / panels;
    for (let p = 0; p < panels; p++) {
      const tone = 0.88 + rng() * 0.24;
      ctx.fillStyle = 'rgb(' + Math.round(126 * tone) + ',' + Math.round(138 * tone) + ',' + Math.round(150 * tone) + ')';
      ctx.fillRect(p * pw, 0, pw, h);
      // Seam rib: dark line + bright edge.
      ctx.fillStyle = 'rgba(38,44,52,0.75)';
      ctx.fillRect(p * pw, 0, 3, h);
      ctx.fillStyle = 'rgba(235,242,248,0.5)';
      ctx.fillRect(p * pw + 3, 0, 2, h);
      // Rust weep from a seam screw.
      if (rng() > 0.5) {
        const rx = p * pw + pw * 0.5;
        const ry = rng() * h * 0.5;
        const grad = ctx.createLinearGradient(0, ry, 0, ry + 60 + rng() * 60);
        grad.addColorStop(0, 'rgba(140,84,44,0.5)');
        grad.addColorStop(1, 'rgba(140,84,44,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(rx - 3, ry, 6, 60 + rng() * 60);
      }
    }
    // Sheen band across the slope.
    const sheen = ctx.createLinearGradient(0, 0, 0, h);
    sheen.addColorStop(0, 'rgba(255,240,220,0.16)');
    sheen.addColorStop(0.45, 'rgba(255,240,220,0.02)');
    sheen.addColorStop(1, 'rgba(30,36,44,0.14)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(30,36,44,0.06)';
      ctx.fillRect(rng() * w, rng() * h, 2, 2);
    }
  });
  if (texture) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  return texture;
}

// Worn-asphalt overlay (transparent): overall darkening wash, tar
// patches, cracks, oil stains and tyre streaks. Canvas x = across the
// strip, y = along it; touchdown streaks sit near both y ends.
function makeWornRunwayTexture() {
  const texture = canvasTexture(256, 1024, (ctx, w, h) => {
    const rng = seededRandom(20261);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(44,42,40,0.20)';
    ctx.fillRect(0, 0, w, h);
    // Large tonal patches (repairs / resurfacing).
    for (let i = 0; i < 26; i++) {
      const px = rng() * w;
      const py = rng() * h;
      const pw = 26 + rng() * 70;
      const ph = 40 + rng() * 130;
      ctx.fillStyle = rng() > 0.45 ? 'rgba(30,29,28,0.20)' : 'rgba(96,90,80,0.16)';
      ctx.fillRect(px - pw / 2, py - ph / 2, pw, ph);
      ctx.strokeStyle = 'rgba(20,19,18,0.25)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px - pw / 2, py - ph / 2, pw, ph);
    }
    // Cracks: wandering dark polylines.
    ctx.strokeStyle = 'rgba(18,17,16,0.5)';
    for (let c = 0; c < 34; c++) {
      let x = rng() * w;
      let y = rng() * h;
      ctx.lineWidth = 1 + rng() * 1.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const steps = 4 + Math.floor(rng() * 6);
      for (let s = 0; s < steps; s++) {
        x += (rng() - 0.5) * 34;
        y += (rng() - 0.5) * 60;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Oil stains.
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = 'rgba(14,13,12,' + (0.14 + rng() * 0.18).toFixed(2) + ')';
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 5 + rng() * 13, 9 + rng() * 22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Tyre streaks: paired wheel tracks either side of centre,
    // strongest in the touchdown zones at both ends.
    for (let end = 0; end < 2; end++) {
      const y0 = end === 0 ? 60 : h - 60;
      const y1 = end === 0 ? 330 : h - 330;
      for (const fx of [0.38, 0.62]) {
        const grad = ctx.createLinearGradient(0, y0, 0, y1);
        grad.addColorStop(0, 'rgba(16,15,14,0.42)');
        grad.addColorStop(1, 'rgba(16,15,14,0)');
        ctx.fillStyle = grad;
        const top = Math.min(y0, y1);
        ctx.fillRect(w * fx - 5, top, 10, Math.abs(y1 - y0));
      }
    }
    // Centre wear polish + edge dirt creep.
    const centre = ctx.createLinearGradient(0, 0, w, 0);
    centre.addColorStop(0, 'rgba(70,58,40,0.22)');
    centre.addColorStop(0.18, 'rgba(70,58,40,0)');
    centre.addColorStop(0.82, 'rgba(70,58,40,0)');
    centre.addColorStop(1, 'rgba(70,58,40,0.22)');
    ctx.fillStyle = centre;
    ctx.fillRect(0, 0, w, h);
    // Grit speckle.
    for (let i = 0; i < 2400; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(20,19,18,0.18)' : 'rgba(210,200,180,0.10)';
      ctx.fillRect(rng() * w, rng() * h, 1.6, 1.6);
    }
  });
  if (texture) {
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
  }
  return texture;
}

// Packed-dirt taxiway/apron: brown-grey, tyre tracks along v, stones.
function makeDirtTexture() {
  const texture = canvasTexture(256, 256, (ctx, w, h) => {
    const rng = seededRandom(555);
    ctx.fillStyle = '#8a7a5e';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(96,80,56,0.16)' : 'rgba(178,160,128,0.14)';
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 14 + rng() * 34, 7 + rng() * 16, rng() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // Wheel ruts along v (canvas y).
    for (const fx of [0.34, 0.66]) {
      ctx.fillStyle = 'rgba(58,46,30,0.30)';
      ctx.fillRect(w * fx - 7, 0, 14, h);
      ctx.fillStyle = 'rgba(200,182,148,0.16)';
      ctx.fillRect(w * fx - 10, 0, 3, h);
      ctx.fillRect(w * fx + 7, 0, 3, h);
    }
    for (let i = 0; i < 1600; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(52,42,28,0.22)' : 'rgba(220,205,175,0.18)';
      ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 2.4, 1 + rng() * 2.4);
    }
  });
  if (texture) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  return texture;
}

// Soft radial glow (edge-light pools, hangar door spill).
function makeGlowTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.38)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  });
}

// Prop ghost-blur disc: translucent radial smear + three ghost blades
// + tip arc, so the spinning prop reads as blur with blade ghosts
// (reference) instead of a flat dark circle.
function makePropGhostTexture() {
  return canvasTexture(256, 256, (ctx, w, h) => {
    const rng = seededRandom(77);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    // Radial smear rings.
    for (let r = 18; r < 124; r += 3) {
      const a = 0.05 + 0.10 * Math.sin((r / 124) * Math.PI) + rng() * 0.03;
      ctx.strokeStyle = 'rgba(40,38,36,' + a.toFixed(3) + ')';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Ghost blades (3), soft wedges with bright tips.
    for (let b = 0; b < 3; b++) {
      const ang = (b / 3) * Math.PI * 2 + 0.5;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      const bladeGrad = ctx.createLinearGradient(0, -16, 0, -122);
      bladeGrad.addColorStop(0, 'rgba(30,28,26,0.42)');
      bladeGrad.addColorStop(0.8, 'rgba(30,28,26,0.30)');
      bladeGrad.addColorStop(1, 'rgba(255,209,102,0.55)');
      ctx.fillStyle = bladeGrad;
      ctx.beginPath();
      ctx.moveTo(-7, -14);
      ctx.lineTo(7, -14);
      ctx.lineTo(4.5, -122);
      ctx.lineTo(-4.5, -122);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // Tip arc.
    ctx.strokeStyle = 'rgba(255,209,102,0.30)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, 120, 0, Math.PI * 2);
    ctx.stroke();
    // Hub shadow.
    const hub = ctx.createRadialGradient(cx, cy, 0, cx, cy, 20);
    hub.addColorStop(0, 'rgba(20,18,16,0.55)');
    hub.addColorStop(1, 'rgba(20,18,16,0)');
    ctx.fillStyle = hub;
    ctx.fillRect(cx - 20, cy - 20, 40, 40);
  });
}

// ---------------------------------------------------------------- build

export function buildAirfieldDressing(options) {
  const { scene, world, aircraftGroup } = options;
  const group = new THREE.Group();
  group.name = 'airfield-dressing';
  const rng = seededRandom(20261126);

  const homeStrip = world.strips[0];
  const E = homeStrip.elevation;
  const F = homeStrip.forward; // {x, z}
  const R = homeStrip.right; // {x, z} — apron (south) side
  const C = homeStrip.centre; // {x, z}
  // Yaw mapping building-local +X onto strip forward, +Z onto right.
  const stripYaw = Math.atan2(-F.z, F.x);

  function stripPoint(along, across) {
    return {
      x: C.x + F.x * along + R.x * across,
      z: C.z + F.z * along + R.z * across,
    };
  }
  function groundY(x, z) {
    return typeof world.heightAt === 'function' ? world.heightAt(x, z) : E;
  }

  // ---- hide the old metal hangar + old edge markers (replaced below)
  let hidOldHangar = false;
  let hidOldMarkers = false;
  const hangarLandmark = world.landmarks && world.landmarks.hangar
    ? world.landmarks.hangar.position : null;
  if (world.group) {
    world.group.traverse((node) => {
      if (node.name === 'home-airfield-buildings' && hangarLandmark) {
        for (const child of node.children) {
          if (child.isGroup
            && Math.abs(child.position.x - hangarLandmark.x) < 1
            && Math.abs(child.position.z - hangarLandmark.z) < 1) {
            child.visible = false;
            hidOldHangar = true;
          }
        }
      }
      if (node.name === 'strip-markers' && node.children.length > 0) {
        node.children[0].visible = false; // old edge-marker InstancedMesh
        hidOldMarkers = true;
      }
    });
  }

  // ---- shared materials
  const plankTexture = makePlankTexture();
  const plankMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.92, metalness: 0.0, flatShading: true,
  });
  if (plankTexture) plankMaterial.map = plankTexture;
  else plankMaterial.color.setHex(0x8a6f52);

  const roofTexture = makeMetalRoofTexture();
  const roofMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.34, metalness: 0.62, flatShading: true,
  });
  if (roofTexture) roofMaterial.map = roofTexture;
  else roofMaterial.color.setHex(0x7e8a96);

  const propsMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.88, metalness: 0.04, flatShading: true,
  });

  const woodParts = []; // plank-textured geometries (world space)
  const roofParts = []; // metal-textured geometries (world space)
  const propParts = []; // {geometry, color} vertex-coloured (world space)

  // ============================================================ hangar
  // Local frame: +X along strip forward, +Z toward apron (south),
  // origin at hangar centre on strip elevation. 22 x 14 m, walls 5.5 m,
  // gable peak +3.4 m, open doors on the west (-X) gable end.
  const hangarCentre = stripPoint(-30, 55);
  const hangarMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(hangarCentre.x, E, hangarCentre.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, stripYaw, 0)),
    new THREE.Vector3(1, 1, 1),
  );
  const HW = 22; // length (X)
  const HD = 14; // depth (Z)
  const WH = 5.5; // wall height
  const PEAK = 3.4; // gable rise above walls

  function hangarWood(geometry) {
    geometry.applyMatrix4(hangarMatrix);
    woodParts.push(geometry);
  }
  function hangarRoof(geometry) {
    geometry.applyMatrix4(hangarMatrix);
    roofParts.push(geometry);
  }
  function hangarProp(geometry, color) {
    geometry.applyMatrix4(hangarMatrix);
    propParts.push({ geometry, color });
  }

  // Long walls (north faces the strip, south carries the lean-to).
  hangarWood(place(plankBox(HW, WH, 0.3), 0, WH / 2, -HD / 2));
  hangarWood(place(plankBox(HW, WH, 0.3), 0, WH / 2, HD / 2));
  // East gable wall (solid) + west gable wall with 8 x 4.2 m door opening.
  hangarWood(place(plankBox(0.3, WH, HD), HW / 2, WH / 2, 0));
  hangarWood(place(plankBox(0.3, WH, 3), -HW / 2, WH / 2, -5.5));
  hangarWood(place(plankBox(0.3, WH, 3), -HW / 2, WH / 2, 5.5));
  hangarWood(place(plankBox(0.3, WH - 4.2, 8), -HW / 2, 4.2 + (WH - 4.2) / 2, 0));
  // Gable triangles (extruded prism, plank UVs in metres -> scale).
  for (const endX of [-HW / 2, HW / 2]) {
    const shape = new THREE.Shape();
    shape.moveTo(-HD / 2, 0);
    shape.lineTo(HD / 2, 0);
    shape.lineTo(0, PEAK);
    shape.closePath();
    const gable = new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false });
    scaleUV(gable, 0.22, 0.22);
    gable.rotateY(Math.PI / 2); // shape X (depth) -> world Z, extrude -> X
    gable.translate(endX - 0.15, WH, 0);
    hangarWood(gable);
  }
  // Corner posts + eaves beams (slightly proud, same plank texture).
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      hangarWood(place(plankBox(0.42, WH, 0.42, 2), sx * (HW / 2 - 0.1), WH / 2, sz * (HD / 2 - 0.1)));
    }
  }
  for (const sz of [-1, 1]) {
    hangarWood(place(plankBox(HW + 0.4, 0.34, 0.34, 2), 0, WH + 0.05, sz * (HD / 2 + 0.05)));
  }
  // Open gable doors, swung outward ~115 degrees. Panel spans from
  // its hinge (z = side*4) toward the centre when closed, so the
  // geometry extends -side*2 from the hinge; rotation.y = side*2.0
  // swings the free edge west, out over the apron.
  for (const side of [-1, 1]) {
    const door = plankBox(0.16, 4.2, 4, 3);
    door.translate(0, 2.1, -side * 2); // hinge edge at local origin
    const doorObj = new THREE.Object3D();
    doorObj.position.set(-HW / 2, 0, side * 4);
    doorObj.rotation.y = side * 2.0; // swing out toward the apron
    doorObj.updateMatrix();
    door.applyMatrix4(doorObj.matrix);
    hangarWood(door);
    // Door ledges (dark wood) ride with the panel.
    for (const ly of [0.7, 2.1, 3.5]) {
      const ledge = new THREE.BoxGeometry(0.1, 0.3, 3.7);
      ledge.translate(-0.14, ly, -side * 2);
      ledge.applyMatrix4(doorObj.matrix);
      hangarProp(ledge, 0x4a3826);
    }
  }
  // Roof: two sheened metal slopes + ridge cap.
  const slopeLen = Math.sqrt((HD / 2 + 0.7) ** 2 + PEAK ** 2);
  const slopeAng = Math.atan2(PEAK, HD / 2 + 0.7);
  for (const side of [-1, 1]) {
    const panel = new THREE.BoxGeometry(HW + 1.4, 0.16, slopeLen);
    scaleUV(panel, (HW + 1.4) / 7, slopeLen / 7);
    place(panel, 0, WH + PEAK / 2 + 0.06, side * (HD / 4 + 0.18), 0, side * slopeAng, 0);
    hangarRoof(panel);
  }
  const ridge = new THREE.BoxGeometry(HW + 1.4, 0.22, 0.5);
  scaleUV(ridge, (HW + 1.4) / 7, 0.2);
  hangarRoof(place(ridge, 0, WH + PEAK + 0.08, 0));

  // Lean-to on the south wall: posts, sloped metal roof, half side walls.
  for (const px of [-6, -2, 2, 6]) {
    hangarWood(place(plankBox(0.3, 3.1, 0.3, 2), px, 1.55, HD / 2 + 3.4));
  }
  const leanRoof = new THREE.BoxGeometry(13.4, 0.14, 4.4);
  scaleUV(leanRoof, 13.4 / 7, 4.4 / 7);
  place(leanRoof, 0, 3.75, HD / 2 + 1.85, 0, 0.24, 0);
  hangarRoof(leanRoof);
  for (const sx of [-1, 1]) {
    hangarWood(place(plankBox(0.24, 2.2, 3.6, 3), sx * 6.6, 1.1, HD / 2 + 1.8));
  }

  // Interior lining (dark) so the open doors read as a real interior.
  hangarProp(place(new THREE.BoxGeometry(0.2, WH, HD - 0.6), HW / 2 - 0.35, WH / 2, 0), 0x2a1e14);
  hangarProp(place(new THREE.BoxGeometry(HW - 0.6, 0.2, HD - 0.6), 0, WH - 0.1, 0), 0x241a12);
  hangarProp(place(new THREE.BoxGeometry(HW - 0.4, 0.16, HD - 0.4), 0, 0.08, 0), 0x6b5f4e);
  for (const sz of [-1, 1]) {
    hangarProp(place(new THREE.BoxGeometry(HW - 0.6, WH, 0.16), 0, WH / 2, sz * (HD / 2 - 0.32)), 0x33261a);
  }
  // Interior props: crate stacks, barrels, workbench, ladder, tyres,
  // tool board, spare prop blade, drums — silhouettes in warm light.
  function crateAt(x, y, z, s, ry, parent) {
    const crate = new THREE.BoxGeometry(s, s, s);
    place(crate, x, y, z, ry || 0);
    (parent || hangarProp)(crate, 0x9a7a4e);
    const batten = new THREE.BoxGeometry(s * 1.04, s * 0.16, s * 1.04);
    place(batten, x, y + s * 0.3, z, ry || 0);
    (parent || hangarProp)(batten, 0x5a4230);
  }
  function barrelAt(x, y, z, color, parent) {
    const barrel = new THREE.CylinderGeometry(0.42, 0.42, 1.05, 9);
    place(barrel, x, y, z);
    (parent || hangarProp)(barrel, color);
    const band = new THREE.CylinderGeometry(0.445, 0.445, 0.16, 9);
    place(band, x, y + 0.1, z);
    (parent || hangarProp)(band, 0xf2ede4);
  }
  crateAt(6.5, 0.85, -4.2, 1.4, 0.2);
  crateAt(6.6, 2.25, -4.1, 1.4, -0.15);
  crateAt(8.2, 0.85, -4.4, 1.4, 0.5);
  crateAt(4.6, 0.7, 4.6, 1.1, 0.3);
  crateAt(4.7, 1.8, 4.5, 1.1, -0.2);
  barrelAt(8.6, 0.65, 3.4, 0xd64541);
  barrelAt(7.6, 0.65, 4.3, 0x3e5a78);
  barrelAt(8.8, 0.65, 4.6, 0xd64541);
  // Workbench along the north wall + tool board.
  hangarProp(place(new THREE.BoxGeometry(5.4, 0.18, 1.1), 1.5, 1.05, -6.1), 0x7a5c38);
  for (const lx of [-0.9, 3.9]) {
    hangarProp(place(new THREE.BoxGeometry(0.16, 1.0, 0.9), lx, 0.5, -6.1), 0x4a3826);
  }
  hangarProp(place(new THREE.BoxGeometry(4.6, 1.7, 0.1), 1.5, 2.6, -6.55), 0x3a2c1c);
  for (let t = 0; t < 5; t++) {
    hangarProp(place(new THREE.BoxGeometry(0.14, 0.7 + (t % 3) * 0.22, 0.08), -0.2 + t * 0.85, 2.55, -6.44), 0x8a8f94);
  }
  // Ladder leaning on the south wall, tyre stack, spare prop blade.
  for (const lx of [-0.28, 0.28]) {
    hangarProp(place(new THREE.BoxGeometry(0.09, 4.4, 0.09), -3.5 + lx, 2.05, 5.9, 0, 0.22, 0), 0x7a5c38);
  }
  for (let rI = 0; rI < 6; rI++) {
    hangarProp(place(new THREE.BoxGeometry(0.62, 0.07, 0.07), -3.5, 0.5 + rI * 0.68, 6.15 - rI * 0.15), 0x7a5c38);
  }
  for (let tI = 0; tI < 3; tI++) {
    hangarProp(place(new THREE.CylinderGeometry(0.55, 0.55, 0.34, 10), -6.2, 0.3 + tI * 0.36, -4.8), 0x232326);
  }
  hangarProp(place(new THREE.BoxGeometry(0.1, 2.6, 0.34), -8.6, 1.25, 5.2, 0.4, 0, 0.28), 0x2b2b30);
  // Hanging lamp shade over the bench (glow plane + point light below).
  hangarProp(place(new THREE.ConeGeometry(0.42, 0.4, 8), 1.5, 3.4, -4.5), 0x2e3236);
  hangarProp(place(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 4), 1.5, 4.4, -4.5), 0x232326);
  // Exterior props: crates + barrels by the doors, under the lean-to,
  // firewood pile, mail sacks, hand cart.
  crateAt(-13.6, 0.75, -3.2, 1.3, 0.3);
  crateAt(-13.5, 2.05, -3.1, 1.3, -0.2);
  crateAt(-13.8, 0.65, -1.4, 1.1, 0.6);
  barrelAt(-13.4, 0.62, 2.6, 0xd64541);
  barrelAt(-12.4, 0.62, 3.4, 0x3e5a78);
  crateAt(-3.5, 0.7, HD / 2 + 2.2, 1.2, 0.15);
  crateAt(0.5, 0.7, HD / 2 + 2.4, 1.2, -0.3);
  barrelAt(3.6, 0.62, HD / 2 + 2.3, 0xd64541);
  for (let log = 0; log < 8; log++) {
    const logGeo = new THREE.CylinderGeometry(0.16, 0.16, 1.6, 6);
    place(logGeo, 5.6, 0.2 + Math.floor(log / 4) * 0.34, HD / 2 + 2.0 + (log % 4) * 0.36, 0, 0, Math.PI / 2);
    hangarProp(logGeo, 0x6b4e30);
  }
  for (let sack = 0; sack < 3; sack++) {
    const sackGeo = new THREE.SphereGeometry(0.55, 7, 5);
    sackGeo.scale(1, 0.72, 0.85);
    place(sackGeo, -12.6 + sack * 0.9, 0.42, -5.6 + (sack % 2) * 0.7, sack * 0.7);
    hangarProp(sackGeo, 0xb9a888);
  }
  hangarProp(place(new THREE.BoxGeometry(1.9, 0.14, 1.1), -14.6, 0.62, 0.4, 0.35), 0x7a5c38);
  for (const wz of [-0.45, 0.45]) {
    hangarProp(place(new THREE.CylinderGeometry(0.34, 0.34, 0.1, 8), -14.6, 0.34, 0.4 + wz, 0, Math.PI / 2, 0), 0x232326);
  }
  // Windows: dark glass + cream frames on the north (strip) wall and
  // the east gable; one warm-lit window by the doors.
  for (const wx of [-7, 0, 7]) {
    hangarProp(place(new THREE.BoxGeometry(1.5, 1.1, 0.1), wx, 3.3, -HD / 2 - 0.16), 0x1a2634);
    hangarProp(place(new THREE.BoxGeometry(1.7, 0.14, 0.12), wx, 3.92, -HD / 2 - 0.17), 0xf2ede4);
    hangarProp(place(new THREE.BoxGeometry(1.7, 0.14, 0.12), wx, 2.68, -HD / 2 - 0.17), 0xf2ede4);
  }
  hangarProp(place(new THREE.BoxGeometry(0.1, 1.1, 1.5), HW / 2 + 0.16, 3.3, 0), 0x1a2634);
  hangarProp(place(new THREE.BoxGeometry(0.1, 1.0, 1.3), -HW / 2 - 0.16, 3.4, 5.5), 0xffd9a0);

  // Warm interior point light (no draw call).
  const hangarLightPos = new THREE.Vector3(0, 3.2, -1).applyMatrix4(hangarMatrix);
  const hangarLight = new THREE.PointLight(0xffb066, 34, 24, 2);
  hangarLight.position.copy(hangarLightPos);
  group.add(hangarLight);

  // ============================================================ outbuildings
  function shed(along, across, w, d, wallH, yawExtra) {
    const p = stripPoint(along, across);
    const baseY = groundY(p.x, p.z) - 0.12;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(p.x, baseY, p.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, stripYaw + (yawExtra || 0), 0)),
      new THREE.Vector3(1, 1, 1),
    );
    const walls = plankBox(w, wallH, d);
    place(walls, 0, wallH / 2, 0);
    walls.applyMatrix4(m);
    woodParts.push(walls);
    const rise = d * 0.34;
    const sLen = Math.sqrt((d / 2 + 0.4) ** 2 + rise ** 2);
    const sAng = Math.atan2(rise, d / 2 + 0.4);
    for (const side of [-1, 1]) {
      const panel = new THREE.BoxGeometry(w + 0.8, 0.12, sLen);
      scaleUV(panel, (w + 0.8) / 7, sLen / 7);
      place(panel, 0, wallH + rise / 2, side * (d / 4 + 0.1), 0, side * sAng, 0);
      panel.applyMatrix4(m);
      roofParts.push(panel);
    }
    const door = new THREE.BoxGeometry(0.9, 1.9, 0.1);
    place(door, -w / 4, 0.95, -d / 2 - 0.06);
    door.applyMatrix4(m);
    propParts.push({ geometry: door, color: 0x1a2634 });
    const win = new THREE.BoxGeometry(0.8, 0.7, 0.1);
    place(win, w / 4, 1.7, -d / 2 - 0.06);
    win.applyMatrix4(m);
    propParts.push({ geometry: win, color: 0xffd9a0 });
  }
  shed(-98, 36, 5.2, 4.2, 2.9, 0.18); // small outbuilding, west foreground
  shed(72, 47, 4.4, 3.6, 2.6, -0.12); // fuel store east of the tower

  // ============================================================ fences
  // Post-and-rail runs merged into the plank geometry (world space).
  function fenceRun(alongFrom, alongTo, across, perpendicular) {
    const step = 6;
    const count = Math.max(1, Math.round(Math.abs(alongTo - alongFrom) / step));
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : i / (count - 1);
      const along = alongFrom + (alongTo - alongFrom) * t;
      const p = perpendicular
        ? stripPoint(across, alongFrom + (alongTo - alongFrom) * t)
        : stripPoint(along, across);
      const y = groundY(p.x, p.z);
      const yaw = perpendicular ? stripYaw + Math.PI / 2 : stripYaw;
      for (const postOff of [-2.9, 2.9]) {
        const post = plankBox(0.15, 1.15, 0.15, 1.5);
        // Offset along the fence direction in world space:
        const dirX = perpendicular ? R.x : F.x;
        const dirZ = perpendicular ? R.z : F.z;
        place(post, p.x + dirX * postOff, y + 0.57, p.z + dirZ * postOff, yaw);
        woodParts.push(post);
      }
      for (const railY of [0.62, 1.02]) {
        const rail = plankBox(6, 0.1, 0.07, 3);
        place(rail, p.x, y + railY, p.z, yaw);
        woodParts.push(rail);
      }
    }
  }
  fenceRun(-165, 165, -24, false); // north forest-edge fence
  fenceRun(-140, -38, 30, false); // south apron fence (taxiway gap)
  fenceRun(-22, 140, 30, false);
  fenceRun(-72, 8, 40, false); // hangar frontage
  fenceRun(-24, 40, -122, true); // west cross fence

  // ============================================================ merged meshes
  const woodMesh = new THREE.Mesh(mergeGeometries(woodParts), plankMaterial);
  woodMesh.name = 'airfield-wooden-structures';
  woodMesh.castShadow = true;
  woodMesh.receiveShadow = true;
  group.add(woodMesh);

  const roofMesh = new THREE.Mesh(mergeGeometries(roofParts), roofMaterial);
  roofMesh.name = 'airfield-metal-roofs';
  roofMesh.castShadow = true;
  roofMesh.receiveShadow = true;
  group.add(roofMesh);

  const propsMesh = new THREE.Mesh(mergeColored(propParts), propsMaterial);
  propsMesh.name = 'airfield-props';
  propsMesh.castShadow = true;
  propsMesh.receiveShadow = true;
  group.add(propsMesh);

  // ============================================================ pines
  // Two-tier pines (trunk + 2 cones, vertex-coloured) instanced in
  // clustered stands flanking the home strip. Visual only.
  const pineParts = [];
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.27, 2.3, 5);
  trunkGeo.translate(0, 1.15, 0);
  pineParts.push({ geometry: trunkGeo, color: 0x5a4230 });
  const lowerCone = new THREE.ConeGeometry(1.75, 3.3, 6);
  lowerCone.translate(0, 3.7, 0);
  pineParts.push({ geometry: lowerCone, color: 0x2f5d2a });
  const upperCone = new THREE.ConeGeometry(1.18, 2.7, 6);
  upperCone.translate(0, 5.4, 0);
  pineParts.push({ geometry: upperCone, color: 0x38682f });
  const pineGeometry = mergeColored(pineParts);

  const pineSpots = [];
  function pineClear(along, across) {
    if (Math.abs(across) < 29) return false; // clear of strip + shoulders
    if (along > -48 && along < -12 && across > 8 && across < 58) return false; // taxiway/hangar apron
    const hp = stripPoint(along, across);
    const dh = Math.hypot(hp.x - hangarCentre.x, hp.z - hangarCentre.z);
    if (dh < 24) return false;
    const towerP = stripPoint(45, 42);
    if (Math.hypot(hp.x - towerP.x, hp.z - towerP.z) < 16) return false;
    return true;
  }
  function pineStand(centreAlong, centreAcross, count, spread) {
    for (let i = 0; i < count; i++) {
      const along = centreAlong + (rng() + rng() - 1) * spread;
      const across = centreAcross + (rng() + rng() - 1) * spread * 0.7;
      if (!pineClear(along, across)) continue;
      const p = stripPoint(along, across);
      pineSpots.push({
        x: p.x, z: p.z, y: groundY(p.x, p.z) - 0.2,
        scale: 0.95 + rng() * 0.95, yaw: rng() * Math.PI * 2, tint: 0.82 + rng() * 0.36,
      });
    }
  }
  // North band (dense forest wall in the reference, left of frame).
  for (const a of [-210, -150, -95, -40, 15, 70, 125, 180]) {
    pineStand(a, -52 - rng() * 22, 11, 26);
  }
  // South band beyond the hangar + west approach cluster.
  for (const a of [-170, -110, 30, 95, 160]) {
    pineStand(a, 82 + rng() * 26, 8, 24);
  }
  pineStand(-225, -18, 9, 22);
  pineStand(-235, 26, 7, 20);

  const pines = new THREE.InstancedMesh(pineGeometry, propsMaterial, Math.max(1, pineSpots.length));
  pines.name = 'airfield-pines';
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _s = new THREE.Vector3();
  const _c = new THREE.Color();
  for (let i = 0; i < pineSpots.length; i++) {
    const spot = pineSpots[i];
    _p.set(spot.x, spot.y, spot.z);
    _e.set(0, spot.yaw, 0);
    _q.setFromEuler(_e);
    _s.set(spot.scale, spot.scale * (0.92 + (i % 5) * 0.05), spot.scale);
    _m.compose(_p, _q, _s);
    pines.setMatrixAt(i, _m);
    _c.setRGB(spot.tint * 0.95, spot.tint, spot.tint * 0.9);
    pines.setColorAt(i, _c);
  }
  pines.instanceMatrix.needsUpdate = true;
  if (pines.instanceColor) pines.instanceColor.needsUpdate = true;
  pines.castShadow = true;
  pines.frustumCulled = false;
  group.add(pines);

  // ============================================================ edge lights + glow
  const edgeLightPositions = [];
  for (const strip of world.strips) {
    const yaw = Math.atan2(strip.forward.x, strip.forward.z);
    for (let along = -strip.length / 2; along <= strip.length / 2; along += 25) {
      for (const side of [-1, 1]) {
        edgeLightPositions.push({
          x: strip.centre.x + strip.forward.x * along + strip.right.x * side * (strip.width / 2 + 1.6),
          y: strip.elevation + 0.35,
          z: strip.centre.z + strip.forward.z * along + strip.right.z * side * (strip.width / 2 + 1.6),
          yaw,
        });
      }
    }
  }
  let edgeBlocks = null;
  if (hidOldMarkers) {
    const blockGeo = new THREE.BoxGeometry(0.85, 0.7, 0.85);
    const blockMat = new THREE.MeshStandardMaterial({
      color: 0x3a2c18, emissive: 0xffd9a0, emissiveIntensity: 1.25, roughness: 0.5,
    });
    edgeBlocks = new THREE.InstancedMesh(blockGeo, blockMat, edgeLightPositions.length);
    edgeBlocks.name = 'airfield-edge-lights';
    for (let i = 0; i < edgeLightPositions.length; i++) {
      const l = edgeLightPositions[i];
      _p.set(l.x, l.y, l.z);
      _e.set(0, l.yaw, 0);
      _q.setFromEuler(_e);
      _s.set(1, 1, 1);
      _m.compose(_p, _q, _s);
      edgeBlocks.setMatrixAt(i, _m);
    }
    edgeBlocks.instanceMatrix.needsUpdate = true;
    edgeBlocks.frustumCulled = false;
    group.add(edgeBlocks);
  }

  // Glow pools: one instanced additive plane per edge light (flat),
  // plus the hangar interior spill (vertical, facing the doors) and
  // two apron pools in front of the open doors.
  const glowTexture = makeGlowTexture();
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffc98a, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  if (glowTexture) glowMaterial.map = glowTexture;
  const glowCount = edgeLightPositions.length + 3;
  const glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMaterial, glowCount);
  glows.name = 'airfield-glows';
  glows.renderOrder = 3;
  glows.frustumCulled = false;
  for (let i = 0; i < edgeLightPositions.length; i++) {
    const l = edgeLightPositions[i];
    _p.set(l.x, l.y - 0.16, l.z);
    _e.set(-Math.PI / 2, 0, 0);
    _q.setFromEuler(_e);
    _s.set(3.6, 3.6, 1);
    _m.compose(_p, _q, _s);
    glows.setMatrixAt(i, _m);
  }
  // Interior spill through the open west doors.
  const spillPos = new THREE.Vector3(-7.5, 2.3, 0).applyMatrix4(hangarMatrix);
  _p.copy(spillPos);
  _e.set(0, stripYaw - Math.PI / 2, 0);
  _q.setFromEuler(_e);
  _s.set(7.5, 3.6, 1);
  _m.compose(_p, _q, _s);
  glows.setMatrixAt(edgeLightPositions.length, _m);
  // Apron pools outside the doors.
  for (let k = 0; k < 2; k++) {
    const poolPos = new THREE.Vector3(-14.5 - k * 3.5, 0.22, -2 + k * 4).applyMatrix4(hangarMatrix);
    _p.copy(poolPos);
    _e.set(-Math.PI / 2, 0, 0);
    _q.setFromEuler(_e);
    _s.set(6.5, 6.5, 1);
    _m.compose(_p, _q, _s);
    glows.setMatrixAt(edgeLightPositions.length + 1 + k, _m);
  }
  glows.instanceMatrix.needsUpdate = true;
  group.add(glows);

  // ============================================================ runway wear overlay
  const wornTexture = makeWornRunwayTexture();
  const overlayParts = [];
  for (const strip of world.strips) {
    const yaw = Math.atan2(strip.forward.x, strip.forward.z);
    const plane = new THREE.PlaneGeometry(strip.width, strip.length);
    plane.rotateX(-Math.PI / 2);
    plane.rotateY(yaw);
    plane.translate(strip.centre.x, strip.elevation + 0.2, strip.centre.z);
    overlayParts.push(plane);
  }
  const overlayMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1.0, metalness: 0.0,
    transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  if (wornTexture) overlayMaterial.map = wornTexture;
  const overlay = new THREE.Mesh(mergeGeometries(overlayParts), overlayMaterial);
  overlay.name = 'runway-wear-overlay';
  overlay.receiveShadow = true;
  overlay.renderOrder = 1;
  group.add(overlay);

  // ============================================================ taxiway + apron (draped dirt)
  const dirtTexture = makeDirtTexture();
  function drapedPlane(centreAlong, centreAcross, sizeAlong, sizeAcross, segA, segB) {
    const p = stripPoint(centreAlong, centreAcross);
    const geo = new THREE.PlaneGeometry(sizeAlong, sizeAcross, segA, segB);
    scaleUV(geo, sizeAlong / 9, sizeAcross / 9);
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(stripYaw);
    geo.translate(p.x, 0, p.z);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, groundY(pos.getX(i), pos.getZ(i)) + 0.09);
    }
    geo.computeVertexNormals();
    return geo;
  }
  const dirtParts = [
    drapedPlane(-30, 27, 8, 40, 2, 10), // taxiway: strip edge -> hangar front
    drapedPlane(-52, 55, 30, 26, 8, 7), // apron west of the hangar doors
    drapedPlane(-30, 47, 26, 18, 7, 5), // hangar frontage pad
  ];
  const dirtMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1.0, metalness: 0.0, flatShading: true,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  if (dirtTexture) dirtMaterial.map = dirtTexture;
  else dirtMaterial.color.setHex(0x8a7a5e);
  const dirt = new THREE.Mesh(mergeGeometries(dirtParts), dirtMaterial);
  dirt.name = 'airfield-taxiway-apron';
  dirt.receiveShadow = true;
  group.add(dirt);

  // ============================================================ tower-sky clouds
  // A few extra-large soft cumulus masses for the tower view (the
  // existing cloud field in render.js stays untouched).
  const cloudParts = [];
  const cloudClusters = [
    { x: -1900, y: 340, z: -1000, s: 1.15 },
    { x: -2700, y: 440, z: 250, s: 1.4 },
    { x: -1250, y: 280, z: -1950, s: 0.95 },
    { x: 700, y: 400, z: -2500, s: 1.25 },
    { x: -3200, y: 520, z: -1600, s: 1.6 },
  ];
  for (const cluster of cloudClusters) {
    const puffs = 6 + Math.floor(rng() * 3);
    for (let i = 0; i < puffs; i++) {
      const puff = new THREE.SphereGeometry(1, 18, 12);
      const rx = (90 + rng() * 130) * cluster.s;
      const ry = (30 + rng() * 26) * cluster.s;
      const rz = (60 + rng() * 80) * cluster.s;
      puff.scale(rx, ry, rz);
      puff.translate(
        cluster.x + (rng() - 0.5) * 340 * cluster.s,
        cluster.y + (rng() - 0.5) * 46 + (i % 3) * 16,
        cluster.z + (rng() - 0.5) * 220 * cluster.s,
      );
      cloudParts.push(puff);
    }
  }
  const cloudMaterial = new THREE.MeshStandardMaterial({
    color: 0xffc4a3, emissive: 0xffb08a, emissiveIntensity: 0.34,
    roughness: 1.0, metalness: 0.0, flatShading: false,
  });
  const clouds = new THREE.Mesh(mergeGeometries(cloudParts), cloudMaterial);
  clouds.name = 'airfield-tower-clouds';
  clouds.frustumCulled = false;
  group.add(clouds);

  // ============================================================ warm rim light
  // Low warm fill from the north-west so north-facing surfaces (the
  // ones the tower camera sees) carry a sunset rim. No shadows.
  const rimLight = new THREE.DirectionalLight(0xff9a5c, 0.5);
  rimLight.position.set(C.x - 420, E + 170, C.z - 520);
  rimLight.target.position.set(C.x, E, C.z);
  group.add(rimLight);
  group.add(rimLight.target);

  // ============================================================ prop ghost disc
  let propDisc = null;
  let propDiscMaterial = null;
  let propOpacity = 0;
  if (aircraftGroup) {
    const ghostTexture = makePropGhostTexture();
    propDiscMaterial = new THREE.MeshBasicMaterial({
      color: 0xd8cfc4, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide,
    });
    if (ghostTexture) propDiscMaterial.map = ghostTexture;
    propDisc = new THREE.Mesh(new THREE.CircleGeometry(1.09, 40), propDiscMaterial);
    propDisc.name = 'airfield-prop-ghost-disc';
    propDisc.position.set(0, 0.05, -4.34); // AIRCRAFT_LAYOUT.propellerCentre
    propDisc.renderOrder = 4;
    aircraftGroup.add(propDisc);
  }

  let time = 0;
  function update(dt, plane) {
    const step = typeof dt === 'number' && dt > 0 ? dt : 0;
    time += step;
    // Edge-light glow breathes very slightly (static in shot mode: dt 0
    // from a frozen pose still shows the base opacity).
    glowMaterial.opacity = 0.5 + Math.sin(time * 1.7) * 0.05;
    if (propDisc && plane) {
      const throttle = typeof plane.throttle === 'number' ? plane.throttle : 0;
      const running = plane.engineOn !== false && throttle > 0.02;
      const target = running ? 0.14 + throttle * 0.5 : 0;
      propOpacity += (target - propOpacity) * Math.min(1, step * 3.5);
      propDiscMaterial.opacity = propOpacity;
      propDisc.visible = propOpacity > 0.01;
      if (propDisc.visible) propDisc.rotation.z -= step * (5 + throttle * 26);
    }
  }
  update(0, null);

  const drawCalls = 2 /* wood+roof */ + 1 /* props */ + 1 /* pines */
    + (edgeBlocks ? 1 : 0) + 1 /* glow */ + 1 /* overlay */ + 1 /* dirt */
    + 1 /* clouds */ + (propDisc ? 1 : 0);

  return {
    group,
    update,
    stats: {
      drawCalls,
      airfieldDrawCalls: drawCalls - 1 /* clouds */ - (propDisc ? 1 : 0),
      pines: pineSpots.length,
      edgeLights: edgeLightPositions.length,
      hidOldHangar,
      hidOldMarkers,
    },
  };
}
