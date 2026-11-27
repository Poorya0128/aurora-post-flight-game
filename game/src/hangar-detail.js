// hangar-detail.js — V6-HANGAR realism pass (VD6-HANGAR).
// One job: replace the flat vertex-coloured home hangar with a detailed
// corrugated-metal hangar matching env6 (runway approach) — weathered
// grey ribbed metal walls with rust streaks + roughness variation,
// corrugated metal roof with overhang + fascia, glass ridge cupola,
// framed windows, open sliding doors with a dark furnished interior,
// lean-to office annex, plus airfield props (crates, fuel drums,
// fences, shed, windsock). Timber is kept for posts/fences/shed.
// Everything is code-generated (canvas textures + merged/instanced
// geometry, no assets). Visual only: nothing here is collidable, scored or
// read by flight.js / missions.js. The old world.js hangar subgroup is
// hidden at runtime by traversal (tower + beacon stay); world.js itself is
// not edited. Draw budget: 8 new draws - 3 hidden = +5 net.
// Capture helpers: the build is OPT-IN via ?hangardetail=on (see below);
// ?hangarview=close|tower|front locks a verification camera.

import * as THREE from 'three';

// ---------------------------------------------------------------- helpers

function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function canvasTexture(width, height, draw, repeat) {
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
  if (repeat) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  return texture;
}

function scaleUV(geometry, sx, sy) {
  const uv = geometry.attributes.uv;
  if (!uv) return geometry;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
  return geometry;
}

// Merge geometries that share one material. All inputs must be non-indexed
// or indexed consistently — toNonIndexed() normalises (same approach as
// world.js mergeStaticGeometries, kept local so world.js stays untouched).
function mergeGeometries(parts) {
  let total = 0;
  const prepared = parts.map((geometry) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    total += g.attributes.position.count;
    return g;
  });
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  let offset = 0;
  for (const g of prepared) {
    positions.set(g.attributes.position.array, offset * 3);
    normals.set(g.attributes.normal.array, offset * 3);
    if (g.attributes.uv) uvs.set(g.attributes.uv.array, offset * 2);
    offset += g.attributes.position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return merged;
}

// Same merge, but each part carries a flat vertex colour (props/interior).
function mergeColored(parts) {
  let total = 0;
  const prepared = parts.map(({ geometry, color }) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    total += g.attributes.position.count;
    return { g, color: new THREE.Color(color) };
  });
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  let offset = 0;
  for (const { g, color } of prepared) {
    positions.set(g.attributes.position.array, offset * 3);
    normals.set(g.attributes.normal.array, offset * 3);
    for (let i = 0; i < g.attributes.position.count; i++) {
      colors[(offset + i) * 3] = color.r;
      colors[(offset + i) * 3 + 1] = color.g;
      colors[(offset + i) * 3 + 2] = color.b;
    }
    offset += g.attributes.position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return merged;
}

function box(w, h, d, x, y, z, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

function plane(w, h, x, y, z, ry = 0, rx = 0) {
  const g = new THREE.PlaneGeometry(w, h);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

// ---------------------------------------------------------------- textures

// Weathered horizontal planks: grain streaks, knots, nail dots, paint fade.
function makePlankTexture() {
  return canvasTexture(512, 512, (ctx, w, h) => {
    const rand = seededRandom(7411);
    ctx.fillStyle = '#7d6248';
    ctx.fillRect(0, 0, w, h);
    const rows = 8;
    const rowH = h / rows;
    for (let r = 0; r < rows; r++) {
      const tone = 0.82 + rand() * 0.36;
      const base = [125 * tone, 98 * tone, 72 * tone];
      ctx.fillStyle = `rgb(${base[0] | 0},${base[1] | 0},${base[2] | 0})`;
      ctx.fillRect(0, r * rowH, w, rowH);
      // grain streaks
      for (let i = 0; i < 46; i++) {
        const gy = r * rowH + rand() * rowH;
        const len = 40 + rand() * 220;
        const gx = rand() * w;
        ctx.strokeStyle = rand() > 0.5
          ? 'rgba(52,38,24,0.20)' : 'rgba(196,164,120,0.16)';
        ctx.lineWidth = 1 + rand() * 1.6;
        ctx.beginPath();
        ctx.moveTo(gx, gy);
        ctx.lineTo(gx + len, gy + (rand() - 0.5) * 3);
        ctx.stroke();
      }
      // knots
      for (let i = 0; i < 3; i++) {
        if (rand() > 0.55) continue;
        const kx = rand() * w;
        const ky = r * rowH + rowH * (0.3 + rand() * 0.4);
        for (let ring = 5; ring > 0; ring--) {
          ctx.fillStyle = `rgba(46,32,18,${0.10 + (5 - ring) * 0.08})`;
          ctx.beginPath();
          ctx.ellipse(kx, ky, ring * 2.1, ring * 1.3, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // plank gap + top highlight
      ctx.fillStyle = 'rgba(24,16,9,0.85)';
      ctx.fillRect(0, (r + 1) * rowH - 2, w, 2);
      ctx.fillStyle = 'rgba(230,205,165,0.20)';
      ctx.fillRect(0, r * rowH, w, 2);
      // nail dots near ends
      ctx.fillStyle = 'rgba(30,26,24,0.8)';
      for (const nx of [14, w - 14]) {
        ctx.beginPath();
        ctx.arc(nx, r * rowH + rowH / 2, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      // vertical butt joint
      const jointX = rand() * w;
      ctx.fillStyle = 'rgba(24,16,9,0.55)';
      ctx.fillRect(jointX, r * rowH, 2, rowH);
    }
    // paint fade / weather streaks running down
    for (let i = 0; i < 60; i++) {
      const x = rand() * w;
      const y = rand() * h * 0.6;
      const len = 40 + rand() * 180;
      ctx.fillStyle = rand() > 0.45
        ? 'rgba(214,198,168,0.07)' : 'rgba(40,30,20,0.09)';
      ctx.fillRect(x, y, 3 + rand() * 10, len);
    }
    // sun-bleached patches
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = 'rgba(226,208,176,0.06)';
      ctx.beginPath();
      ctx.ellipse(rand() * w, rand() * h, 40 + rand() * 90, 16 + rand() * 30, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }, true);
}

// Corrugated metal: vertical ribs with highlight/shadow, rust, seams, screws.
function makeCorrugatedTexture() {
  return canvasTexture(512, 512, (ctx, w, h) => {
    const rand = seededRandom(9137);
    ctx.fillStyle = '#8f979e';
    ctx.fillRect(0, 0, w, h);
    const ribs = 16;
    const ribW = w / ribs;
    for (let i = 0; i < ribs; i++) {
      const x = i * ribW;
      const grad = ctx.createLinearGradient(x, 0, x + ribW, 0);
      grad.addColorStop(0, '#6d757c');
      grad.addColorStop(0.35, '#aeb6bd');
      grad.addColorStop(0.55, '#c9d1d8');
      grad.addColorStop(0.8, '#7c848b');
      grad.addColorStop(1, '#5d646a');
      ctx.fillStyle = grad;
      ctx.fillRect(x, 0, ribW, h);
    }
    // panel seams (horizontal) + screws
    for (const sy of [h * 0.34, h * 0.67]) {
      ctx.fillStyle = 'rgba(40,44,48,0.55)';
      ctx.fillRect(0, sy, w, 3);
      ctx.fillStyle = 'rgba(230,236,240,0.35)';
      ctx.fillRect(0, sy + 3, w, 2);
      ctx.fillStyle = 'rgba(52,56,60,0.9)';
      for (let x = ribW / 2; x < w; x += ribW * 2) {
        ctx.beginPath();
        ctx.arc(x, sy - 8, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // rust streaks + grime
    for (let i = 0; i < 42; i++) {
      const x = rand() * w;
      const y = rand() * h * 0.7;
      const len = 30 + rand() * 160;
      ctx.fillStyle = `rgba(146,84,44,${0.05 + rand() * 0.13})`;
      ctx.fillRect(x, y, 2 + rand() * 6, len);
    }
    for (let i = 0; i < 26; i++) {
      ctx.fillStyle = `rgba(58,56,50,${0.04 + rand() * 0.08})`;
      ctx.beginPath();
      ctx.ellipse(rand() * w, rand() * h, 14 + rand() * 50, 8 + rand() * 22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }, true);
}

// Weathered corrugated metal WALLS (env6): vertical ribs with
// highlight/shadow, horizontal panel seams + screws, rust streaks
// weeping from seams, grime at the base. 1024x512.
function makeMetalWallTexture() {
  return canvasTexture(1024, 512, (ctx, w, h) => {
    const rand = seededRandom(2718);
    ctx.fillStyle = '#9AA3A8';
    ctx.fillRect(0, 0, w, h);
    const ribs = 32;
    const ribW = w / ribs;
    for (let i = 0; i < ribs; i++) {
      const x = i * ribW;
      const tone = 0.9 + rand() * 0.2;
      const grad = ctx.createLinearGradient(x, 0, x + ribW, 0);
      grad.addColorStop(0, 'rgb(' + Math.round(104 * tone) + ',' + Math.round(112 * tone) + ',' + Math.round(118 * tone) + ')');
      grad.addColorStop(0.35, 'rgb(' + Math.round(168 * tone) + ',' + Math.round(176 * tone) + ',' + Math.round(182 * tone) + ')');
      grad.addColorStop(0.55, 'rgb(' + Math.round(196 * tone) + ',' + Math.round(204 * tone) + ',' + Math.round(210 * tone) + ')');
      grad.addColorStop(0.8, 'rgb(' + Math.round(122 * tone) + ',' + Math.round(130 * tone) + ',' + Math.round(136 * tone) + ')');
      grad.addColorStop(1, 'rgb(' + Math.round(90 * tone) + ',' + Math.round(97 * tone) + ',' + Math.round(103 * tone) + ')');
      ctx.fillStyle = grad;
      ctx.fillRect(x, 0, ribW, h);
    }
    // Panel seams + screw rows.
    for (const sy of [h * 0.34, h * 0.67]) {
      ctx.fillStyle = 'rgba(40,44,48,0.6)';
      ctx.fillRect(0, sy, w, 3);
      ctx.fillStyle = 'rgba(230,236,240,0.35)';
      ctx.fillRect(0, sy + 3, w, 2);
      ctx.fillStyle = 'rgba(52,56,60,0.9)';
      for (let x = ribW / 2; x < w; x += ribW * 2) {
        ctx.beginPath();
        ctx.arc(x, sy - 9, 2.6, 0, Math.PI * 2);
        ctx.fill();
        // rust weep under each screw
        ctx.fillStyle = 'rgba(146,84,44,0.28)';
        ctx.fillRect(x - 2, sy - 6, 4, 26 + rand() * 40);
        ctx.fillStyle = 'rgba(52,56,60,0.9)';
      }
    }
    // Rust streaks + grime blotches.
    for (let i = 0; i < 64; i++) {
      const x = rand() * w;
      const y = rand() * h * 0.7;
      ctx.fillStyle = 'rgba(146,84,44,' + (0.05 + rand() * 0.14).toFixed(2) + ')';
      ctx.fillRect(x, y, 2 + rand() * 7, 30 + rand() * 180);
    }
    for (let i = 0; i < 34; i++) {
      ctx.fillStyle = 'rgba(58,56,50,' + (0.04 + rand() * 0.09).toFixed(2) + ')';
      ctx.beginPath();
      ctx.ellipse(rand() * w, rand() * h, 16 + rand() * 60, 9 + rand() * 26, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const grime = ctx.createLinearGradient(0, h * 0.82, 0, h);
    grime.addColorStop(0, 'rgba(44,40,34,0)');
    grime.addColorStop(1, 'rgba(44,40,34,0.45)');
    ctx.fillStyle = grime;
    ctx.fillRect(0, h * 0.82, w, h * 0.18);
  }, true);
}

// Roughness companion for the metal walls: clean galvanised ribs are
// smoother (darker), rust/grime rougher (brighter). 512x256 greyscale.
function makeMetalRoughnessTexture() {
  const texture = canvasTexture(512, 256, (ctx, w, h) => {
    const rand = seededRandom(1618);
    ctx.fillStyle = '#8C8C8C';
    ctx.fillRect(0, 0, w, h);
    const ribs = 16;
    const ribW = w / ribs;
    for (let i = 0; i < ribs; i++) {
      const grad = ctx.createLinearGradient(i * ribW, 0, (i + 1) * ribW, 0);
      grad.addColorStop(0, '#9A9A9A');
      grad.addColorStop(0.5, '#6E6E6E');
      grad.addColorStop(1, '#9A9A9A');
      ctx.fillStyle = grad;
      ctx.fillRect(i * ribW, 0, ribW, h);
    }
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = 'rgba(235,235,235,' + (0.1 + rand() * 0.25).toFixed(2) + ')';
      ctx.beginPath();
      ctx.ellipse(rand() * w, rand() * h, 8 + rand() * 40, 5 + rand() * 18, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const grime = ctx.createLinearGradient(0, h * 0.8, 0, h);
    grime.addColorStop(0, 'rgba(240,240,240,0)');
    grime.addColorStop(1, 'rgba(240,240,240,0.7)');
    ctx.fillStyle = grime;
    ctx.fillRect(0, h * 0.8, w, h * 0.2);
  }, true);
  if (texture) texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

// Hangar name board above the sliding doors.
function makeHangarSignTexture() {
  return canvasTexture(512, 96, (ctx, w, h) => {
    ctx.fillStyle = '#232A33';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#F2EDE4';
    ctx.lineWidth = 5;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.fillStyle = '#F2EDE4';
    ctx.font = '800 44px "Segoe UI", system-ui, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('AURORA POST', w / 2, h / 2 + 2);
  }, false);
}

// Soft dark radial disc for baked contact AO under the hangar.
function makeAODiscTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const grad = ctx.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(14,9,6,0.85)');
    grad.addColorStop(0.55, 'rgba(14,9,6,0.5)');
    grad.addColorStop(0.85, 'rgba(14,9,6,0.18)');
    grad.addColorStop(1, 'rgba(14,9,6,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }, false);
}

// Crate face: pale wood, battens, stencil labels.
function makeCrateTexture() {
  return canvasTexture(256, 256, (ctx, w, h) => {
    const rand = seededRandom(3301);
    ctx.fillStyle = '#a8845c';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      ctx.strokeStyle = rand() > 0.5 ? 'rgba(90,64,36,0.18)' : 'rgba(210,178,132,0.16)';
      ctx.lineWidth = 1 + rand() * 1.4;
      const y = rand() * h;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y + (rand() - 0.5) * 6);
      ctx.stroke();
    }
    // battens
    ctx.fillStyle = '#8a6a44';
    ctx.fillRect(0, 0, w, 26);
    ctx.fillRect(0, h - 26, w, 26);
    ctx.fillRect(0, 0, 26, h);
    ctx.fillRect(w - 26, 0, 26, h);
    ctx.strokeStyle = 'rgba(40,28,16,0.6)';
    ctx.lineWidth = 3;
    ctx.strokeRect(13, 13, w - 26, h - 26);
    // stencil
    ctx.fillStyle = 'rgba(38,34,30,0.82)';
    ctx.font = 'bold 30px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('AURORA', w / 2, h / 2 - 22);
    ctx.fillText('POST', w / 2, h / 2 + 12);
    ctx.font = 'bold 17px monospace';
    ctx.fillStyle = 'rgba(150,44,36,0.85)';
    ctx.fillText('FRAGILE ↑', w / 2, h / 2 + 48);
  }, false);
}

// Fuel drum wrap: rusty steel, ribs, cream band, stencil.
function makeBarrelTexture() {
  return canvasTexture(256, 256, (ctx, w, h) => {
    const rand = seededRandom(5519);
    ctx.fillStyle = '#5e2f26';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = `rgba(${90 + rand() * 70 | 0},${44 + rand() * 30 | 0},26,${0.08 + rand() * 0.14})`;
      ctx.beginPath();
      ctx.ellipse(rand() * w, rand() * h, 4 + rand() * 22, 3 + rand() * 12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // rolled ribs
    for (const ry of [h * 0.22, h * 0.5, h * 0.78]) {
      ctx.fillStyle = 'rgba(30,18,14,0.5)';
      ctx.fillRect(0, ry, w, 5);
      ctx.fillStyle = 'rgba(230,190,160,0.28)';
      ctx.fillRect(0, ry + 5, w, 3);
    }
    // cream stencil band
    ctx.fillStyle = '#cfc3a6';
    ctx.fillRect(0, h * 0.42, w, h * 0.16);
    ctx.fillStyle = 'rgba(40,36,32,0.9)';
    ctx.font = 'bold 26px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('FUEL', w / 2, h * 2 / 4 - 2);
    ctx.font = 'bold 15px monospace';
    ctx.fillText('100LL · 200L', w / 2, h * 2 / 4 + 22);
  }, true);
}

// Soft radial glow for the hanging lamp sprite.
function makeGlowTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const grad = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,230,180,1)');
    grad.addColorStop(0.25, 'rgba(255,196,110,0.55)');
    grad.addColorStop(0.6, 'rgba(255,160,70,0.16)');
    grad.addColorStop(1, 'rgba(255,150,60,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }, false);
}

// ---------------------------------------------------------------- build

const WALL_H = 5.2;
const HALF_W = 10; // half length along X (20 m)
const HALF_D = 7; // half depth along Z (14 m)
const ROOF_RISE = 3.4;
const DOOR_W = 11;
const DOOR_H = 4.2;

function gableTriangle(halfDepth, wallH, rise, x, flip) {
  // Triangle in the YZ plane at x = ±HALF_W, UVs scaled to plank size.
  const shape = new THREE.Shape();
  shape.moveTo(-halfDepth, wallH);
  shape.lineTo(halfDepth, wallH);
  shape.lineTo(0, wallH + rise);
  shape.closePath();
  const g = new THREE.ShapeGeometry(shape);
  g.rotateY(flip ? -Math.PI / 2 : Math.PI / 2);
  g.translate(x, 0, 0);
  return scaleUV(g, 0.14, 0.14);
}

function buildHangarDetail(scene, world, renderer) {
  const params = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search) : new URLSearchParams();
  // VD6-HANGAR stand-down: V6-AIRFIELD's airfield-dressing.js (the original
  // claimant for the hangar) landed a complete hangar at this same spot
  // while this module was in flight. Running both duplicates the shell and
  // props, so this build is opt-in only (?hangardetail=on) for coordinator
  // A/B comparison; the shipped game uses airfield-dressing's hangar.
  if (params.get('hangardetail') !== 'on') return null;

  const landmarks = (world && world.landmarks) || {};
  const hangarPos = landmarks.hangar && landmarks.hangar.position
    ? landmarks.hangar.position : new THREE.Vector3(-30, 0, 55);
  const groundY = typeof hangarPos.y === 'number' ? hangarPos.y : 0;

  // Hide the old flat hangar subgroup (first child of the buildings group)
  // plus its plain instanced drums/crates (replaced by detailed ones here);
  // tower + beacon stay.
  if (scene) {
    scene.traverse((node) => {
      if (node.name === 'home-airfield-buildings' && node.children.length > 0) {
        const old = node.children[0];
        if (old && old.isGroup) old.visible = false;
        for (const child of node.children) {
          if (child.isInstancedMesh) child.visible = false;
        }
      }
    });
  }

  const group = new THREE.Group();
  group.name = 'hangar-detail';
  group.position.set(hangarPos.x, groundY, hangarPos.z);
  const rand = seededRandom(20261126);

  const plankTexture = makePlankTexture();
  const roofTexture = makeCorrugatedTexture();
  const plankMaterial = new THREE.MeshStandardMaterial({
    map: plankTexture, roughness: 0.88, metalness: 0.0,
  });
  const metalWallTexture = makeMetalWallTexture();
  const metalRoughnessTexture = makeMetalRoughnessTexture();
  const metalWallMaterial = new THREE.MeshStandardMaterial({
    map: metalWallTexture, roughness: 0.85, metalness: 0.55,
  });
  if (metalRoughnessTexture) metalWallMaterial.roughnessMap = metalRoughnessTexture;
  const roofMaterial = new THREE.MeshStandardMaterial({
    map: roofTexture, roughness: 0.38, metalness: 0.85, side: THREE.DoubleSide,
  });

  // ---- geometry: metal walls/gables/doors + timber posts/fences/shed
  const plankParts = [];
  const metalParts = [];
  const plankScale = 0.16; // texture tiles ~ every 6 m of wall
  const wall = (w, h, x, y, z, ry) => {
    plankParts.push(scaleUV(plane(w, h, x, y, z, ry), w * plankScale, h * plankScale));
  };
  const metalWall = (w, h, x, y, z, ry) => {
    metalParts.push(scaleUV(plane(w, h, x, y, z, ry), w * plankScale, h * plankScale));
  };
  // South wall (full) + north wall segments around the door opening.
  metalWall(HALF_W * 2, WALL_H, 0, WALL_H / 2, HALF_D, 0);
  const segW = HALF_W - DOOR_W / 2;
  metalWall(segW, WALL_H, -(DOOR_W / 2 + segW / 2), WALL_H / 2, -HALF_D, Math.PI);
  metalWall(segW, WALL_H, DOOR_W / 2 + segW / 2, WALL_H / 2, -HALF_D, Math.PI);
  metalWall(DOOR_W, WALL_H - DOOR_H, 0, DOOR_H + (WALL_H - DOOR_H) / 2, -HALF_D, Math.PI);
  // East / west walls + gables.
  metalWall(HALF_D * 2, WALL_H, HALF_W, WALL_H / 2, 0, Math.PI / 2);
  metalWall(HALF_D * 2, WALL_H, -HALF_W, WALL_H / 2, 0, -Math.PI / 2);
  metalParts.push(gableTriangle(HALF_D, WALL_H, ROOF_RISE, HALF_W, false));
  metalParts.push(gableTriangle(HALF_D, WALL_H, ROOF_RISE, -HALF_W, true));
  // Corner posts + door frame + sliding rail.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      plankParts.push(scaleUV(box(0.42, WALL_H, 0.42, sx * HALF_W, WALL_H / 2, sz * HALF_D), 0.3, 1));
    }
    plankParts.push(scaleUV(box(0.4, DOOR_H, 0.3, sx * (DOOR_W / 2), DOOR_H / 2, -HALF_D - 0.05), 0.3, 1));
  }
  plankParts.push(scaleUV(box(DOOR_W + 1.2, 0.4, 0.3, 0, DOOR_H + 0.2, -HALF_D - 0.05), 1, 0.3));
  plankParts.push(scaleUV(box(HALF_W * 2, 0.18, 0.18, 0, DOOR_H + 0.55, -HALF_D - 0.22), 1, 0.2));
  // Sliding doors, slid open over the wall segments (one slightly ajar).
  const doorPanel = (cx, ry) => {
    const panel = new THREE.Group();
    const g = plane(DOOR_W / 2 + 0.4, DOOR_H, 0, DOOR_H / 2, 0, Math.PI);
    scaleUV(g, 1, 1);
    const parts = [g];
    // cross braces
    for (const by of [0.5, DOOR_H - 0.5]) {
      parts.push(box(DOOR_W / 2 + 0.4, 0.28, 0.1, 0, by, -0.08));
    }
    const diag = box(DOOR_W / 2 + 0.2, 0.26, 0.1, 0, 0, 0);
    diag.rotateZ(0.62);
    diag.translate(0, DOOR_H / 2, -0.08);
    parts.push(diag);
    const merged = mergeGeometries(parts);
    merged.rotateY(ry);
    merged.translate(cx, 0, -HALF_D - 0.28);
    return merged;
  };
  metalParts.push(doorPanel(-(DOOR_W / 2 + 3.1), 0.06));
  metalParts.push(doorPanel(DOOR_W / 2 + 3.1, -0.16));
  // Personnel door (east wall) + small window frames.
  plankParts.push(scaleUV(box(0.12, 2.2, 1.0, HALF_W + 0.05, 1.1, 3.4), 0.3, 1));
  // Lean-to on the east side: posts + back beam (roof in roof geometry).
  for (const pz of [-4.5, -1.5, 1.5, 4.5]) {
    plankParts.push(scaleUV(box(0.3, 3.1, 0.3, HALF_W + 3.4, 1.55, pz), 0.3, 1));
  }
  plankParts.push(scaleUV(box(0.3, 0.3, 10.4, HALF_W + 3.4, 3.15, 0), 0.3, 1));
  // Outbuilding shed to the west.
  const shed = { x: -HALF_W - 7.5, z: 2.5, w: 4.4, d: 3.4, h: 2.6 };
  wall(shed.w, shed.h, shed.x, shed.h / 2, shed.z + shed.d / 2, 0);
  wall(shed.w, shed.h, shed.x, shed.h / 2, shed.z - shed.d / 2, Math.PI);
  wall(shed.d, shed.h, shed.x + shed.w / 2, shed.h / 2, shed.z, Math.PI / 2);
  wall(shed.d, shed.h, shed.x - shed.w / 2, shed.h / 2, shed.z, -Math.PI / 2);
  plankParts.push(scaleUV(box(1.0, 2.0, 0.12, shed.x + 0.6, 1.0, shed.z - shed.d / 2 - 0.05), 0.3, 1));
  // Post-and-rail fences: south apron edge + west run toward the shed.
  const fenceRun = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(2, Math.round(len / 2.6));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      plankParts.push(scaleUV(box(0.16, 1.15, 0.16,
        x0 + (x1 - x0) * t, 0.57, z0 + (z1 - z0) * t), 0.2, 0.4));
    }
    const yaw = Math.atan2(x1 - x0, z1 - z0);
    for (const ry of [0.55, 1.0]) {
      const rail = box(0.08, 0.14, len, 0, 0, 0);
      rail.rotateY(yaw);
      rail.translate((x0 + x1) / 2, ry, (z0 + z1) / 2);
      plankParts.push(scaleUV(rail, 0.2, 0.2));
    }
  };
  fenceRun(-HALF_W - 2, HALF_D + 4.5, HALF_W + 5, HALF_D + 4.5);
  fenceRun(-HALF_W - 2, HALF_D + 4.5, -HALF_W - 2, -HALF_D - 3);
  // Windsock pole (cone is separate, animated).
  const pole = new THREE.CylinderGeometry(0.07, 0.1, 6.4, 6);
  pole.translate(HALF_W + 6.5, 3.2, -HALF_D - 4);
  plankParts.push(scaleUV(pole, 0.2, 1));

  const plankMesh = new THREE.Mesh(mergeGeometries(plankParts), plankMaterial);
  plankMesh.castShadow = true;
  plankMesh.receiveShadow = true;
  group.add(plankMesh);

  const metalMesh = new THREE.Mesh(mergeGeometries(metalParts), metalWallMaterial);
  metalMesh.name = 'hangar-metal-walls';
  metalMesh.castShadow = true;
  metalMesh.receiveShadow = true;
  group.add(metalMesh);

  // ---- roof geometry: two slopes + ridge + lean-to + shed roofs
  // Clean construction: lay the plane flat (rotateX -90deg, normal +Y,
  // height along Z), tilt around X by the slope angle, then translate.
  const roofParts = [];
  const eaveZ = HALF_D + 0.7;
  const slopeLen = Math.hypot(eaveZ, ROOF_RISE) + 0.3;
  const slopeAngle = Math.atan2(ROOF_RISE, eaveZ);
  for (const side of [-1, 1]) {
    const g = plane(HALF_W * 2 + 1.2, slopeLen, 0, 0, 0);
    scaleUV(g, 3.2, 1.4);
    g.rotateX(-Math.PI / 2 + side * slopeAngle);
    g.translate(0, WALL_H + ROOF_RISE / 2 + 0.05, side * eaveZ / 2);
    roofParts.push(g);
  }
  roofParts.push(scaleUV(box(HALF_W * 2 + 1.3, 0.22, 0.5, 0, WALL_H + ROOF_RISE + 0.1, 0), 3, 0.3));
  // lean-to roof (slopes down away from the east wall, ridge along Z)
  const lean = plane(4.2, 10.6, 0, 0, 0);
  scaleUV(lean, 1, 2);
  lean.rotateX(-Math.PI / 2);
  lean.rotateZ(-0.22);
  lean.translate(HALF_W + 1.9, 3.55, 0);
  roofParts.push(lean);
  // shed roof: single slope
  const shedRoof = plane(shed.w + 0.7, shed.d + 0.9, 0, 0, 0);
  scaleUV(shedRoof, 1.4, 1);
  shedRoof.rotateX(-Math.PI / 2 + 0.28);
  shedRoof.translate(shed.x, shed.h + 0.42, shed.z);
  roofParts.push(shedRoof);

  const roofMesh = new THREE.Mesh(mergeGeometries(roofParts), roofMaterial);
  roofMesh.castShadow = true;
  roofMesh.receiveShadow = true;
  group.add(roofMesh);

  // ---- interior shell (dark, BackSide) + merged props / floor / apron
  const interiorMaterial = new THREE.MeshStandardMaterial({
    color: 0x171008, roughness: 0.95, side: THREE.BackSide,
  });
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(HALF_W * 2 - 0.3, WALL_H - 0.2, HALF_D * 2 - 0.3),
    interiorMaterial,
  );
  shell.position.y = (WALL_H - 0.2) / 2;
  group.add(shell);

  const propParts = [];
  // dirt apron (vertex-coloured, stains via darker quads)
  propParts.push({ geometry: plane(34, 28, 0, 0.04, 0, 0, -Math.PI / 2), color: 0x8a7a5e });
  propParts.push({ geometry: plane(12, 9, -3, 0.055, -2, 0, -Math.PI / 2), color: 0x77664e });
  propParts.push({ geometry: plane(7, 5, 6, 0.06, 3, 0, -Math.PI / 2), color: 0x6b5a44 });
  // interior floor (concrete) + oil stains
  propParts.push({ geometry: plane(HALF_W * 2 - 0.4, HALF_D * 2 - 0.4, 0, 0.09, 0, 0, -Math.PI / 2), color: 0x6e6a62 });
  propParts.push({ geometry: plane(3.4, 2.2, 1.5, 0.105, -1, 0, -Math.PI / 2), color: 0x3c3833 });
  // interior crates / barrels / workbench / tools (silhouettes)
  const inCrate = (x, y, z, s, ry) => propParts.push({ geometry: box(s, s, s, x, y, z, ry), color: 0x8a6a44 });
  inCrate(-6.5, 0.75, 3.5, 1.5, 0.2);
  inCrate(-6.3, 2.2, 3.6, 1.4, -0.15);
  inCrate(-4.8, 0.65, 4.2, 1.3, 0.5);
  inCrate(6.8, 0.75, 4.0, 1.5, -0.3);
  inCrate(8.2, 0.6, 2.2, 1.2, 0.1);
  inCrate(-3.6, 0.7, -3.4, 1.4, 0.25); // silhouettes just inside the doors
  inCrate(-3.4, 2.05, -3.5, 1.3, -0.1);
  inCrate(3.8, 0.65, -3.8, 1.3, 0.4);
  for (const [bx, bz] of [[7.6, 5.2], [8.8, 5.0], [-8.2, 5.0]]) {
    const drum = new THREE.CylinderGeometry(0.55, 0.55, 1.15, 10);
    drum.translate(bx, 0.66, bz);
    propParts.push({ geometry: drum, color: 0x6e3a30 });
  }
  // workbench + vise + tool shapes along the south wall
  propParts.push({ geometry: box(4.2, 0.18, 1.1, -2, 1.05, 5.9), color: 0x7a5c3a });
  for (const lx of [-3.9, -0.1]) propParts.push({ geometry: box(0.16, 1.0, 1.0, lx, 0.5, 5.9), color: 0x5a4230 });
  propParts.push({ geometry: box(0.5, 0.35, 0.4, -3.2, 1.32, 5.9), color: 0x3a3f45 });
  propParts.push({ geometry: box(0.9, 0.12, 0.3, -1.4, 1.2, 5.8, 0.4), color: 0x4a4f55 });
  // leaning spare propeller + ladder + tyre stack
  const propBlade = box(0.28, 3.4, 0.1, 0, 0, 0);
  propBlade.rotateZ(0.35);
  propBlade.translate(4.6, 1.6, 6.2);
  propParts.push({ geometry: propBlade, color: 0x4a3421 });
  for (const lx of [0, 0.55]) {
    const rail = box(0.09, 4.4, 0.09, 0, 0, 0);
    rail.rotateX(-0.22);
    rail.translate(-8.6 + lx, 2.1, -5.6);
    propParts.push({ geometry: rail, color: 0x6b4e32 });
  }
  for (let i = 0; i < 4; i++) {
    propParts.push({ geometry: box(0.6, 0.08, 0.08, -8.32, 0.7 + i * 0.95, -5.6 + i * 0.21), color: 0x6b4e32 });
  }
  for (let i = 0; i < 3; i++) {
    const tyre = new THREE.TorusGeometry(0.42, 0.16, 6, 12);
    tyre.rotateX(Math.PI / 2);
    tyre.translate(8.6, 0.24 + i * 0.34, -3.4);
    propParts.push({ geometry: tyre, color: 0x24262a });
  }
  // lamp cord from the ridge beam
  propParts.push({ geometry: box(0.05, 1.9, 0.05, 0, 4.9, -4.4), color: 0x1c1c1e });
  // Framed windows on the south wall (one warm-lit) + eave fascia.
  for (const wx of [-6, 0, 6]) {
    propParts.push({ geometry: box(1.5, 1.1, 0.1, wx, 3.3, HALF_D + 0.06), color: wx === 0 ? 0xffd9a0 : 0x1a2634 });
    propParts.push({ geometry: box(1.7, 0.14, 0.12, wx, 3.92, HALF_D + 0.07), color: 0xf2ede4 });
    propParts.push({ geometry: box(1.7, 0.14, 0.12, wx, 2.68, HALF_D + 0.07), color: 0xf2ede4 });
    propParts.push({ geometry: box(0.07, 1.1, 0.11, wx, 3.3, HALF_D + 0.08), color: 0xf2ede4 });
    propParts.push({ geometry: box(1.5, 0.07, 0.11, wx, 3.3, HALF_D + 0.08), color: 0xf2ede4 });
  }
  for (const sz of [-1, 1]) {
    propParts.push({ geometry: box(HALF_W * 2 + 1.2, 0.3, 0.12, 0, WALL_H + 0.05, sz * (HALF_D + 0.62)), color: 0xf2ede4 });
  }
  // Office-annex door + window on the east wall under the lean-to.
  propParts.push({ geometry: box(0.12, 2.1, 1.0, HALF_W + 0.06, 1.05, -2.5), color: 0x1a2634 });
  propParts.push({ geometry: box(0.1, 0.9, 1.1, HALF_W + 0.06, 2.2, 1.8), color: 0xffd9a0 });
  // exterior: pallet stacks + logs by the shed, chocks by the doors
  inCrate(-HALF_W - 4.2, 0.6, -1.5, 1.2, 0.3);
  inCrate(-HALF_W - 4.0, 1.75, -1.4, 1.1, -0.2);
  for (let i = 0; i < 4; i++) {
    const log = new THREE.CylinderGeometry(0.22, 0.24, 2.6, 7);
    log.rotateZ(Math.PI / 2);
    log.translate(shed.x - 3.4, 0.24 + Math.floor(i / 2) * 0.42, shed.z + 3 + (i % 2) * 0.5);
    propParts.push({ geometry: log, color: 0x5f4630 });
  }
  for (const cx of [-2.2, 2.2]) {
    propParts.push({ geometry: box(0.5, 0.3, 0.35, cx, 0.15, -HALF_D - 2.2, 0.2), color: 0xd8b13c });
  }

  const propsMesh = new THREE.Mesh(
    mergeColored(propParts),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
  );
  propsMesh.castShadow = true;
  propsMesh.receiveShadow = true;
  group.add(propsMesh);

  // Glass ridge cupola (env6): dark frame + warm glass band + cap.
  const cupola = new THREE.Group();
  cupola.name = 'hangar-cupola';
  const cupolaBase = new THREE.Mesh(
    new THREE.BoxGeometry(3.4, 0.4, 2.4),
    new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.6, metalness: 0.4 }),
  );
  cupolaBase.position.y = WALL_H + ROOF_RISE + 0.15;
  cupolaBase.castShadow = true;
  cupola.add(cupolaBase);
  const cupolaGlass = new THREE.Mesh(
    new THREE.BoxGeometry(3.0, 1.1, 2.0),
    new THREE.MeshStandardMaterial({
      color: 0x33434e, emissive: 0xffb45e, emissiveIntensity: 0.9,
      roughness: 0.22, metalness: 0.15,
    }),
  );
  cupolaGlass.position.y = WALL_H + ROOF_RISE + 0.9;
  cupola.add(cupolaGlass);
  const cupolaCap = new THREE.Mesh(
    new THREE.ConeGeometry(2.2, 0.9, 4),
    new THREE.MeshStandardMaterial({ color: 0x2e3236, roughness: 0.5, metalness: 0.5, flatShading: true }),
  );
  cupolaCap.rotation.y = Math.PI / 4;
  cupolaCap.scale.set(1.15, 1, 0.8);
  cupolaCap.position.y = WALL_H + ROOF_RISE + 1.9;
  cupolaCap.castShadow = true;
  cupola.add(cupolaCap);
  group.add(cupola);

  // Name board above the sliding doors (north face).
  const signTexture = makeHangarSignTexture();
  const signMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.2 });
  if (signTexture) signMaterial.map = signTexture;
  else signMaterial.color.setHex(0x232a33);
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.2), signMaterial);
  signMesh.position.set(0, DOOR_H + 1.0, -HALF_D - 0.12);
  signMesh.rotation.y = Math.PI;
  group.add(signMesh);

  // Baked AO disc grounding the hangar footprint.
  const aoTexture = makeAODiscTexture();
  const aoMaterial = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.42, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  if (aoTexture) aoMaterial.map = aoTexture;
  const aoGeo = new THREE.PlaneGeometry(26, 19);
  aoGeo.rotateX(-Math.PI / 2);
  const aoMesh = new THREE.Mesh(aoGeo, aoMaterial);
  aoMesh.position.y = 0.07;
  aoMesh.renderOrder = 1;
  group.add(aoMesh);

  // ---- hanging lamp: glow sprite + warm point light inside the doors
  const lampSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowTexture(), blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, opacity: 0.9,
  }));
  lampSprite.position.set(0, 3.9, -4.4);
  lampSprite.scale.set(6.0, 6.0, 1);
  group.add(lampSprite);
  const lampLight = new THREE.PointLight(0xffb45e, 90, 30, 1.8);
  lampLight.position.copy(lampSprite.position);
  group.add(lampLight);

  // ---- instanced exterior crates + fuel drums (stencil labels)
  const crateTexture = makeCrateTexture();
  const crateMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.25, 1.25, 1.25),
    new THREE.MeshStandardMaterial({ map: crateTexture, roughness: 0.85 }),
    14,
  );
  const crateSpots = [
    [-8.6, -9.6, 0], [-7.2, -9.8, 0.4], [-8.0, -9.7, 0.15, 1], // by west door
    [8.8, -9.4, -0.3], [10.1, -9.7, 0.2], // by east door
    [HALF_W + 1.8, -3.2, 0.1], [HALF_W + 1.9, -1.8, -0.2], [HALF_W + 1.85, -2.5, 0.3, 1], // lean-to
    [shed.x + 3.2, shed.z - 2.6, 0.5], [shed.x + 4.5, shed.z - 2.4, -0.1],
    [-HALF_W - 3.4, 5.8, 0.2], [3.5, HALF_D + 3.2, -0.4], [-5.5, HALF_D + 3.4, 0.15],
    [HALF_W + 4.6, 3.8, 0.35],
  ];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  crateSpots.forEach(([cx, cz, ry, stack], i) => {
    e.set(0, ry, 0);
    q.setFromEuler(e);
    m.compose(
      new THREE.Vector3(cx, 0.63 + (stack ? 1.26 : 0), cz),
      q, new THREE.Vector3(1, 1, 1),
    );
    crateMesh.setMatrixAt(i, m);
  });
  crateMesh.instanceMatrix.needsUpdate = true;
  crateMesh.castShadow = true;
  crateMesh.receiveShadow = true;
  group.add(crateMesh);

  const barrelTexture = makeBarrelTexture();
  const barrelMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.56, 0.56, 1.16, 12),
    new THREE.MeshStandardMaterial({ map: barrelTexture, roughness: 0.62, metalness: 0.45 }),
    12,
  );
  const barrelSpots = [
    [HALF_W + 2.2, 1.6], [HALF_W + 3.4, 1.7], [HALF_W + 2.8, 2.8], [HALF_W + 1.7, 2.7],
    [HALF_W + 3.9, 2.9], // lean-to fuel cluster
    [-HALF_W - 2.6, -6.2], [-HALF_W - 3.8, -6.0], [-HALF_W - 3.2, -7.3], // west wall
    [shed.x - 3.0, shed.z - 1.2], [shed.x - 3.0, shed.z - 2.4],
    [6.4, -HALF_D - 2.6], [-6.8, -HALF_D - 2.8], // by the doors
  ];
  barrelSpots.forEach(([bx, bz], i) => {
    e.set(0, rand() * Math.PI * 2, 0);
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(bx, 0.58, bz), q, new THREE.Vector3(1, 1, 1));
    barrelMesh.setMatrixAt(i, m);
  });
  barrelMesh.instanceMatrix.needsUpdate = true;
  barrelMesh.castShadow = true;
  barrelMesh.receiveShadow = true;
  group.add(barrelMesh);

  // ---- windsock (animated in update)
  const sockPivot = new THREE.Group();
  sockPivot.position.set(HALF_W + 6.5, 6.3, -HALF_D - 4);
  const sockGeometry = new THREE.CylinderGeometry(0.14, 0.48, 2.3, 8, 1, true);
  const sockColors = new Float32Array(sockGeometry.attributes.position.count * 3);
  const sockOrange = new THREE.Color(0xf07830);
  const sockWhite = new THREE.Color(0xffffff);
  for (let i = 0; i < sockGeometry.attributes.position.count; i++) {
    const sy = sockGeometry.attributes.position.getY(i);
    const band = sy > 0.55 ? sockOrange : (sy > -0.35 ? sockWhite : sockOrange);
    sockColors[i * 3] = band.r;
    sockColors[i * 3 + 1] = band.g;
    sockColors[i * 3 + 2] = band.b;
  }
  sockGeometry.setAttribute('color', new THREE.BufferAttribute(sockColors, 3));
  const sock = new THREE.Mesh(sockGeometry, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.8, side: THREE.DoubleSide,
  }));
  sock.position.y = -1.15;
  sockPivot.add(sock);
  group.add(sockPivot);
  // Small lamp on the windsock pole (emissive head + glow sprite).
  const poleLamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 8, 6),
    new THREE.MeshStandardMaterial({
      color: 0x442f16, emissive: 0xffc98a, emissiveIntensity: 1.9, roughness: 0.4,
    }),
  );
  poleLamp.position.set(HALF_W + 6.5, 5.6, -HALF_D - 4);
  group.add(poleLamp);
  const poleLampGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowTexture(), color: 0xffc98a, blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, opacity: 0.7,
  }));
  poleLampGlow.position.copy(poleLamp.position);
  poleLampGlow.scale.set(2.6, 2.6, 1);
  group.add(poleLampGlow);

  if (scene) scene.add(group);
  if (typeof window !== 'undefined') window.__hangarDebug = { group, scene };

  // ---- capture-only camera presets + draw-call evidence
  const view = params.get('hangarview');
  if (view && renderer) {
    const presets = {
      close: { pos: [17, 4.2, -21], look: [0, 2.4, -2], fov: 50 },
      tower: { pos: [40, 21, -36], look: [-2, 1.5, 2], fov: 50 },
      front: { pos: [0, 3.2, -26], look: [0, 2.6, 0], fov: 50 },
    };
    const preset = presets[view] || presets.close;
    const camPos = new THREE.Vector3(
      hangarPos.x + preset.pos[0], groundY + preset.pos[1], hangarPos.z + preset.pos[2],
    );
    const camLook = new THREE.Vector3(
      hangarPos.x + preset.look[0], groundY + preset.look[1], hangarPos.z + preset.look[2],
    );
    const originalRender = renderer.render.bind(renderer);
    renderer.render = (renderScene, renderCamera) => {
      renderCamera.position.copy(camPos);
      renderCamera.lookAt(camLook);
      if (renderCamera.fov !== preset.fov) {
        renderCamera.fov = preset.fov;
        renderCamera.updateProjectionMatrix();
      }
      originalRender(renderScene, renderCamera);
      // Capture evidence without a compositor screenshot: grab the canvas
      // in the same task (drawing buffer still valid), once, for tools.
      if (!window.__hangarShotData && renderer.domElement) {
        try { window.__hangarShotData = renderer.domElement.toDataURL('image/jpeg', 0.85); } catch (e) { /* capture only */ }
      }
      if (renderer.info && renderer.info.render) {
        window.__hangarDetailInfo = {
          calls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
        };
      }
      window.__hangarViewReady = true;
    };
  }

  let elapsed = 0;
  function update(dt) {
    elapsed += dt || 0;
    // Windsock sway + gentle lamp flicker. No allocation.
    sockPivot.rotation.y = 0.7 + Math.sin(elapsed * 0.6) * 0.35;
    sock.rotation.z = 0.25 + Math.sin(elapsed * 1.7) * 0.08;
    lampSprite.material.opacity = 0.86 + Math.sin(elapsed * 7.3) * 0.05;
  }

  return { group, update };
}

export { buildHangarDetail };
