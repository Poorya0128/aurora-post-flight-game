// runway-detail.js — V6-RUNWAY realism pass (code-generated only).
// Worn-asphalt runway texture (cracks, patches, skid marks, aggregate),
// worn markings (threshold bars, chevrons, numbers, aiming + touchdown
// bars, centreline), worn apron/parking texture, home-field taxiway,
// and edge-light glow (additive Points sprites + merged light pools).
// Logic, terrain heights and strip geometry are untouched; world.js
// keeps its original texture builders as fallback. Draw calls added:
// glow Points (1) + merged pools (1) + taxiway (1) = +3 (budget ≤ +4).

import * as THREE from 'three';

// Same seeded RNG family as world.js (deterministic every load).
function seededRandom(seed) {
  let state = seed >>> 0;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stripSeed(strip) {
  let h = 4242 + Math.round(strip.length) * 31 + Math.round(strip.headingDeg) * 131;
  const id = String(strip.id || '');
  for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) >>> 0;
  return h;
}

function canvasTexture(width, height, drawFn) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    drawFn(ctx, width, height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runway texture: 2048×256 (was 1024×128). Canvas x = along strip
// (5.85 px/m on the 350 m home strip), y = across (14.2 px/m on 18 m).
// Pale worn concrete base keeps the VD-11 altitude-legibility ruling;
// realism comes from wear, not a darker surface. Markings stay dark
// #2E3236 and bolder than before so they read at 768×480 on final.
// ---------------------------------------------------------------------------
export function makeDetailedRunwayTexture(strip) {
  const texture = canvasTexture(2048, 256, (ctx, w, h) => {
    const rng = seededRandom(stripSeed(strip));
    const cy = h / 2;
    // --- worn concrete base ---
    ctx.fillStyle = '#C6BFA9';
    ctx.fillRect(0, 0, w, h);
    // Large tonal slabs (concrete pours) with slightly varied tone.
    for (let x = 0; x < w; x += 256) {
      const tone = 0.96 + rng() * 0.07;
      ctx.fillStyle = `rgba(${Math.round(198 * tone)},${Math.round(191 * tone)},${Math.round(169 * tone)},0.55)`;
      ctx.fillRect(x, 0, 256, h);
    }
    // Broad weather blotches.
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(110,100,80,0.07)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 40 + rng() * 120, 12 + rng() * 30, rng() * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Repair patches: darker rectangles with a worn lighter rim.
    for (let i = 0; i < 14; i++) {
      const px = rng() * (w - 220);
      const py = 20 + rng() * (h - 90);
      const pw = 90 + rng() * 160;
      const ph = 34 + rng() * 44;
      ctx.fillStyle = 'rgba(88,82,68,0.20)';
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = 'rgba(60,55,45,0.28)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, pw, ph);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(px + 3, py + 3, pw - 6, 5);
    }
    // Oil / rubber stains near the centreline.
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = 'rgba(45,44,40,0.10)';
      ctx.beginPath();
      ctx.ellipse(rng() * w, cy + (rng() - 0.5) * 70, 22 + rng() * 60, 6 + rng() * 12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Aggregate noise: dense grit, dark + light.
    for (let i = 0; i < 9000; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(85,76,58,0.20)' : 'rgba(255,255,255,0.26)';
      ctx.fillRect(rng() * w, rng() * h, 2, 2);
    }
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(70,62,48,0.30)' : 'rgba(255,252,240,0.34)';
      ctx.fillRect(rng() * w, rng() * h, 3, 2);
    }
    // Expansion joints: transverse every ~30 m + two longitudinal.
    ctx.fillStyle = 'rgba(52,50,44,0.30)';
    for (let x = 175; x < w; x += 175) ctx.fillRect(x, 0, 3, h);
    ctx.fillRect(0, 63, w, 3);
    ctx.fillRect(0, h - 66, w, 3);
    // Cracks: random walks with occasional branches.
    ctx.strokeStyle = 'rgba(42,40,36,0.50)';
    for (let i = 0; i < 26; i++) {
      let x = rng() * w;
      let y = rng() * h;
      let angle = rng() * Math.PI * 2;
      ctx.lineWidth = 1.4 + rng() * 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const steps = 6 + Math.floor(rng() * 10);
      for (let s = 0; s < steps; s++) {
        angle += (rng() - 0.5) * 0.9;
        x += Math.cos(angle) * (14 + rng() * 22);
        y += Math.sin(angle) * (8 + rng() * 14);
        ctx.lineTo(x, y);
        if (rng() > 0.78) { // branch
          const bx = x + Math.cos(angle + 1.1) * 26;
          const by = y + Math.sin(angle + 1.1) * 16;
          ctx.moveTo(x, y);
          ctx.lineTo(bx, by);
          ctx.moveTo(x, y);
        }
      }
      ctx.stroke();
    }
    // Dirt ingress along both edges.
    const edgeGradL = ctx.createLinearGradient(0, 0, 0, 26);
    edgeGradL.addColorStop(0, 'rgba(84,74,56,0.34)');
    edgeGradL.addColorStop(1, 'rgba(84,74,56,0)');
    ctx.fillStyle = edgeGradL;
    ctx.fillRect(0, 0, w, 26);
    const edgeGradR = ctx.createLinearGradient(0, h, 0, h - 26);
    edgeGradR.addColorStop(0, 'rgba(84,74,56,0.34)');
    edgeGradR.addColorStop(1, 'rgba(84,74,56,0)');
    ctx.fillStyle = edgeGradR;
    ctx.fillRect(0, h - 26, w, 26);
    // --- tyre skid / touchdown rubber (under markings) ---
    for (let end = 0; end < 2; end++) {
      const fromX = end === 0 ? 150 : w - 150;
      const toX = end === 0 ? 560 : w - 560;
      const gradient = ctx.createLinearGradient(fromX, 0, toX, 0);
      gradient.addColorStop(0, 'rgba(34,36,38,0.42)');
      gradient.addColorStop(0.55, 'rgba(34,36,38,0.20)');
      gradient.addColorStop(1, 'rgba(34,36,38,0)');
      ctx.fillStyle = gradient;
      const rectX = Math.min(fromX, toX);
      const rectW = Math.abs(toX - fromX);
      ctx.fillRect(rectX, cy - 46, rectW, 22);
      ctx.fillRect(rectX, cy + 24, rectW, 22);
      // Wavy skid tails: thin streaks wandering off the main tracks.
      ctx.fillStyle = 'rgba(34,36,38,0.16)';
      for (let t = 0; t < 5; t++) {
        const ty = cy + (rng() - 0.5) * 90;
        const tx = end === 0 ? 200 + rng() * 260 : w - 460 + rng() * 260;
        ctx.fillRect(tx, ty, 90 + rng() * 150, 3 + rng() * 3);
      }
    }
    // Faint centre rubber deposit along the middle third.
    ctx.fillStyle = 'rgba(40,42,44,0.07)';
    ctx.fillRect(w * 0.34, cy - 30, w * 0.32, 60);
    // --- markings (dark on pale, bold for 768×480) ---
    ctx.fillStyle = '#2E3236';
    // Edge lines: 20 px ≈ 1.4 m.
    ctx.fillRect(0, 4, w, 20);
    ctx.fillRect(0, h - 24, w, 20);
    // Threshold chevrons (blast-pad arrows pointing down-runway).
    for (let end = 0; end < 2; end++) {
      const dir = end === 0 ? 1 : -1;
      const baseX = end === 0 ? 6 : w - 6;
      ctx.strokeStyle = '#2E3236';
      ctx.lineWidth = 13;
      ctx.lineJoin = 'miter';
      for (let c = 0; c < 2; c++) {
        const tipX = baseX + dir * (52 - c * 0);
        const backX = baseX + dir * (6 + c * 30);
        const topY = 34 + c * 6;
        const botY = h - 34 - c * 6;
        ctx.beginPath();
        ctx.moveTo(backX, topY);
        ctx.lineTo(tipX, cy);
        ctx.lineTo(backX, botY);
        ctx.stroke();
      }
    }
    // Threshold piano-key bars: 6 bars, 104 px long ≈ 18 m.
    for (let end = 0; end < 2; end++) {
      const baseX = end === 0 ? 84 : w - 84 - 104;
      for (let bar = 0; bar < 6; bar++) {
        ctx.fillRect(baseX, 28 + bar * 36, 104, 28);
      }
    }
    // Runway numbers: 176 px ≈ 12.4 m tall, crisp at altitude.
    const nearNumber = String(Math.round(strip.headingDeg / 10) % 36 || 36).padStart(2, '0');
    const farNumber = String(((Math.round(strip.headingDeg / 10) + 18) % 36) || 36).padStart(2, '0');
    ctx.font = '800 176px "Segoe UI", system-ui, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(300, cy);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(nearNumber, 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(w - 300, cy);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(farNumber, 0, 0);
    ctx.restore();
    // Aiming-point bars either side of centreline.
    for (let end = 0; end < 2; end++) {
      const baseX = end === 0 ? 470 : w - 470 - 120;
      ctx.fillRect(baseX, 52, 120, 32);
      ctx.fillRect(baseX, h - 84, 120, 32);
    }
    // Touchdown-zone bar pairs (two per end, smaller than aiming bars).
    for (let end = 0; end < 2; end++) {
      for (let pair = 0; pair < 2; pair++) {
        const baseX = end === 0 ? 680 + pair * 190 : w - 680 - pair * 190 - 84;
        ctx.fillRect(baseX, 58, 84, 26);
        ctx.fillRect(baseX, h - 84, 84, 26);
      }
    }
    // Centreline dashes: 88×32 px ≈ 15 m × 2.3 m.
    for (let x = 640; x < w - 720; x += 132) {
      ctx.fillRect(x, cy - 16, 88, 32);
    }
    // --- paint wear: base-tone speckle concentrated on marking bands ---
    const wearBands = [
      { y0: 0, y1: 28 }, { y0: h - 28, y1: h }, // edge lines
      { y0: cy - 20, y1: cy + 20 }, // centreline
      { y0: 24, y1: h - 24, x0: 0, x1: 420 }, // near threshold + numbers
      { y0: 24, y1: h - 24, x0: w - 420, x1: w }, // far threshold + numbers
      { y0: 48, y1: 88 }, { y0: h - 88, y1: h - 48 }, // aiming / TDZ bars
    ];
    for (const band of wearBands) {
      const bx0 = band.x0 || 0;
      const bx1 = band.x1 || w;
      const count = band.x0 ? 700 : 900;
      for (let i = 0; i < count; i++) {
        ctx.fillStyle = rng() > 0.4 ? 'rgba(198,191,169,0.55)' : 'rgba(168,160,140,0.50)';
        ctx.fillRect(bx0 + rng() * (bx1 - bx0), band.y0 + rng() * (band.y1 - band.y0), 2 + rng() * 4, 2 + rng() * 3);
      }
    }
    // Scuff scratches across the paint.
    ctx.strokeStyle = 'rgba(198,191,169,0.35)';
    for (let i = 0; i < 40; i++) {
      const sx = rng() * w;
      const sy = rng() * h;
      ctx.lineWidth = 1 + rng() * 1.5;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 20 + rng() * 50, sy + (rng() - 0.5) * 10);
      ctx.stroke();
    }
    // Final light grit over everything so paint sits in the surface.
    for (let i = 0; i < 1600; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(90,82,64,0.12)' : 'rgba(255,255,255,0.10)';
      ctx.fillRect(rng() * w, rng() * h, 2, 2);
    }
  });
  if (texture) {
    texture.center.set(0.5, 0.5);
    texture.rotation = -Math.PI / 2;
  }
  return texture;
}

// ---------------------------------------------------------------------------
// Apron / parking-box texture: worn concrete slabs (256×256).
// ---------------------------------------------------------------------------
export function makeDetailedParkingTexture() {
  return canvasTexture(256, 256, (ctx, w, h) => {
    const rng = seededRandom(777001);
    ctx.fillStyle = '#B4AC99';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(100,92,72,0.08)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 18 + rng() * 40, 8 + rng() * 18, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 1600; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(82,74,56,0.20)' : 'rgba(255,255,255,0.24)';
      ctx.fillRect(rng() * w, rng() * h, 2, 2);
    }
    // Slab joints (2×2 pours) + cracks.
    ctx.fillStyle = 'rgba(52,50,44,0.35)';
    ctx.fillRect(w / 2 - 1, 0, 3, h);
    ctx.fillRect(0, h / 2 - 1, w, 3);
    ctx.strokeStyle = 'rgba(42,40,36,0.45)';
    for (let i = 0; i < 6; i++) {
      let x = rng() * w;
      let y = rng() * h;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 5; s++) {
        x += (rng() - 0.5) * 44;
        y += (rng() - 0.5) * 44;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Oil stain + tie-down rings.
    ctx.fillStyle = 'rgba(45,44,40,0.16)';
    ctx.beginPath();
    ctx.ellipse(w * 0.62, h * 0.38, 30, 14, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(46,50,54,0.55)';
    ctx.lineWidth = 3;
    for (const [tx, ty] of [[36, 36], [w - 36, 36], [36, h - 36], [w - 36, h - 36]]) {
      ctx.beginPath();
      ctx.arc(tx, ty, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Worn border + red P (wear speckle over both).
    ctx.strokeStyle = '#2E3236';
    ctx.lineWidth = 9;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.fillStyle = '#D64541';
    ctx.font = '800 96px "Segoe UI", system-ui, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('P', w / 2, h / 2 + 4);
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = 'rgba(180,172,153,0.55)';
      const onBorder = rng() > 0.5;
      const x = onBorder ? (rng() > 0.5 ? rng() * w : (rng() > 0.5 ? 4 + rng() * 14 : w - 18 + rng() * 14))
        : w / 2 + (rng() - 0.5) * 90;
      const y = onBorder ? (rng() > 0.5 ? 4 + rng() * 14 : h - 18 + rng() * 14) : h / 2 + (rng() - 0.5) * 110;
      ctx.fillRect(x, y, 2 + rng() * 3, 2 + rng() * 3);
    }
  });
}

// ---------------------------------------------------------------------------
// Taxiway texture (512×128): worn asphalt, solid yellow centreline.
// Canvas x = along taxiway, y = across.
// ---------------------------------------------------------------------------
function makeTaxiwayTexture() {
  return canvasTexture(512, 128, (ctx, w, h) => {
    const rng = seededRandom(31337);
    ctx.fillStyle = '#A79F89';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(90,82,64,0.10)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 24 + rng() * 50, 8 + rng() * 14, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 2200; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(78,70,54,0.22)' : 'rgba(255,255,255,0.22)';
      ctx.fillRect(rng() * w, rng() * h, 2, 2);
    }
    ctx.fillStyle = 'rgba(52,50,44,0.30)';
    for (let x = 85; x < w; x += 85) ctx.fillRect(x, 0, 3, h);
    ctx.strokeStyle = 'rgba(42,40,36,0.45)';
    for (let i = 0; i < 8; i++) {
      let x = rng() * w;
      let y = rng() * h;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 5; s++) {
        x += (rng() - 0.5) * 50;
        y += (rng() - 0.5) * 24;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Tyre tracks either side of the centreline.
    ctx.fillStyle = 'rgba(40,42,44,0.14)';
    ctx.fillRect(0, h / 2 - 20, w, 8);
    ctx.fillRect(0, h / 2 + 12, w, 8);
    // Edge lines + worn yellow centreline.
    ctx.fillStyle = '#E9E2D2';
    ctx.fillRect(0, 3, w, 5);
    ctx.fillRect(0, h - 8, w, 5);
    ctx.fillStyle = '#D9A92E';
    ctx.fillRect(0, h / 2 - 4, w, 8);
    for (let i = 0; i < 700; i++) {
      ctx.fillStyle = 'rgba(167,159,137,0.55)';
      ctx.fillRect(rng() * w, h / 2 - 6 + rng() * 12, 2 + rng() * 3, 2);
    }
  });
}

// Home-field taxiway: strip edge → hangar apron (visual only, flat).
// Hangar sits at centre -forward*30 + right*55 (world.js); its apron
// slab spans 26×21, near edge at right*44.5. Taxiway runs across
// (right direction) at along=-30, from right*8 to right*46.
// Height: +0.17 (above asphalt +0.12 and the airfield-dressing dirt
// taxiway draped at ground+0.09 on the same along/across footprint)
// so the paved slab reads over the dirt instead of z-fighting it;
// polygonOffset as belt-and-braces on the flattened plateau.
export function buildTaxiway(strip) {
  const yaw = Math.atan2(strip.forward.x, strip.forward.z);
  const texture = makeTaxiwayTexture();
  const params = {
    color: 0xa79f89, roughness: 0.97, metalness: 0.0, flatShading: true,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  };
  if (texture) { params.map = texture; params.color = 0xffffff; }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(38, 8),
    new THREE.MeshStandardMaterial(params));
  mesh.rotation.x = -Math.PI / 2;
  const pivot = new THREE.Group();
  pivot.add(mesh);
  pivot.rotation.y = yaw;
  const along = -30;
  const across = 27;
  pivot.position.set(
    strip.centre.x + strip.forward.x * along + strip.right.x * across,
    strip.elevation + 0.17,
    strip.centre.z + strip.forward.z * along + strip.right.z * across);
  mesh.receiveShadow = true;
  const group = new THREE.Group();
  group.name = 'home-taxiway';
  group.add(pivot);
  return group;
}

// ---------------------------------------------------------------------------
// Edge-light glow: additive Points sprites (1 draw) + merged ground
// light pools (1 draw) for every edge marker + approach light.
// ---------------------------------------------------------------------------
function makeGlowTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const gradient = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.25, 'rgba(255,240,210,0.55)');
    gradient.addColorStop(0.6, 'rgba(255,220,160,0.18)');
    gradient.addColorStop(1, 'rgba(255,210,140,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
  });
}

export function buildRunwayGlow(shared) {
  const group = new THREE.Group();
  group.name = 'runway-edge-glow';
  const glowTexture = makeGlowTexture();
  if (!glowTexture) return group;
  const markers = shared.edgeMarkers || [];
  const approach = shared.approachLights || [];
  const all = markers.concat(approach);
  if (all.length === 0) return group;
  // Halo sprites at lamp height.
  const positions = new Float32Array(all.length * 3);
  for (let i = 0; i < all.length; i++) {
    positions[i * 3] = all[i].x;
    positions[i * 3 + 1] = all[i].y + 0.15;
    positions[i * 3 + 2] = all[i].z;
  }
  const pointsGeometry = new THREE.BufferGeometry();
  pointsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const points = new THREE.Points(pointsGeometry, new THREE.PointsMaterial({
    map: glowTexture,
    color: 0xffd9a0,
    size: 5.5,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  }));
  points.frustumCulled = false;
  group.add(points);
  // Ground light pools: one merged quad per lamp, additive.
  const poolSize = 7;
  const half = poolSize / 2;
  const quadCount = all.length;
  const pPos = new Float32Array(quadCount * 4 * 3);
  const pUv = new Float32Array(quadCount * 4 * 2);
  const pNorm = new Float32Array(quadCount * 4 * 3);
  const pIdx = new Uint32Array(quadCount * 6);
  for (let i = 0; i < quadCount; i++) {
    const cx = all[i].x;
    const cz = all[i].z;
    const y = all[i].y - 0.16; // just above shoulder/asphalt plane
    const corners = [
      [cx - half, cz - half, 0, 0],
      [cx + half, cz - half, 1, 0],
      [cx + half, cz + half, 1, 1],
      [cx - half, cz + half, 0, 1],
    ];
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      pPos[v * 3] = corners[c][0];
      pPos[v * 3 + 1] = y;
      pPos[v * 3 + 2] = corners[c][1];
      pUv[v * 2] = corners[c][2];
      pUv[v * 2 + 1] = corners[c][3];
      pNorm[v * 3 + 1] = 1;
    }
    const b = i * 4;
    pIdx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  }
  const poolGeometry = new THREE.BufferGeometry();
  poolGeometry.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  poolGeometry.setAttribute('uv', new THREE.BufferAttribute(pUv, 2));
  poolGeometry.setAttribute('normal', new THREE.BufferAttribute(pNorm, 3));
  poolGeometry.setIndex(new THREE.BufferAttribute(pIdx, 1));
  const pools = new THREE.Mesh(poolGeometry, new THREE.MeshBasicMaterial({
    map: glowTexture,
    color: 0xffc98a,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  pools.frustumCulled = false;
  group.add(pools);
  return group;
}
