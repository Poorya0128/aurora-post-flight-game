// runway-detail.js — V6-RUNWAY realism pass (code-generated only).
// Dark-asphalt runway texture (cracks, patches, tar snakes, skid marks,
// aggregate) with crisp WHITE markings (piano-key threshold bars,
// chevrons, numbers, aiming + touchdown bars, centreline) sized from
// the strip's real length/width — env6 runway-approach reference.
// Worn apron/parking texture, home-field taxiway, and edge-light glow
// (additive Points sprites + merged light pools), tuned bright for the
// permanent dawn/dusk light.
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
    // Metre-true marking geometry: canvas x = along strip, y = across.
    const pxPerM = w / Math.max(60, strip.length || 350);
    const pyPerM = h / Math.max(6, strip.width || 18);
    const M = (m) => m * pxPerM; // metres along -> px
    const A = (m) => m * pyPerM; // metres across -> px
    // --- dark asphalt base (env6: wet-look dawn asphalt) ---
    ctx.fillStyle = '#3F4045';
    ctx.fillRect(0, 0, w, h);
    // Large tonal slabs (resurfaced pours) with varied tone.
    for (let x = 0; x < w; x += 256) {
      const tone = 0.92 + rng() * 0.16;
      ctx.fillStyle = `rgba(${Math.round(63 * tone)},${Math.round(64 * tone)},${Math.round(69 * tone)},0.6)`;
      ctx.fillRect(x, 0, 256, h);
    }
    // Broad weather blotches + faint warm dawn sheen patches.
    for (let i = 0; i < 110; i++) {
      ctx.fillStyle = rng() > 0.55 ? 'rgba(18,18,20,0.10)' : 'rgba(158,160,168,0.06)';
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 40 + rng() * 130, 12 + rng() * 32, rng() * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Repair patches: darker rectangles with a worn lighter rim.
    for (let i = 0; i < 16; i++) {
      const px = rng() * (w - 220);
      const py = 20 + rng() * (h - 90);
      const pw = 90 + rng() * 170;
      const ph = 34 + rng() * 46;
      ctx.fillStyle = 'rgba(22,22,25,0.34)';
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = 'rgba(10,10,12,0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, pw, ph);
      ctx.fillStyle = 'rgba(190,192,198,0.07)';
      ctx.fillRect(px + 3, py + 3, pw - 6, 5);
    }
    // Oil / rubber stains near the centreline.
    for (let i = 0; i < 22; i++) {
      ctx.fillStyle = 'rgba(8,8,9,0.20)';
      ctx.beginPath();
      ctx.ellipse(rng() * w, cy + (rng() - 0.5) * A(5), 22 + rng() * 60, 6 + rng() * 12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Aggregate noise: dense grit, dark + light.
    for (let i = 0; i < 11000; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(14,14,16,0.28)' : 'rgba(185,188,195,0.20)';
      ctx.fillRect(rng() * w, rng() * h, 2, 2);
    }
    for (let i = 0; i < 1000; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(10,10,12,0.34)' : 'rgba(220,222,228,0.28)';
      ctx.fillRect(rng() * w, rng() * h, 3, 2);
    }
    // Expansion joints: transverse every ~30 m + two longitudinal.
    ctx.fillStyle = 'rgba(12,12,14,0.5)';
    for (let x = M(30); x < w; x += M(30)) ctx.fillRect(x, 0, 3, h);
    ctx.fillRect(0, A(4.5), w, 3);
    ctx.fillRect(0, h - A(4.5) - 3, w, 3);
    // Cracks: random walks with occasional branches + tar snakes
    // (sealed cracks read as glossy dark worms).
    ctx.strokeStyle = 'rgba(6,6,7,0.55)';
    for (let i = 0; i < 30; i++) {
      let x = rng() * w;
      let y = rng() * h;
      let angle = rng() * Math.PI * 2;
      ctx.lineWidth = 1.4 + rng() * 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const steps = 6 + Math.floor(rng() * 10);
      for (let st = 0; st < steps; st++) {
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
    ctx.strokeStyle = 'rgba(16,15,14,0.8)';
    ctx.lineCap = 'round';
    for (let i = 0; i < 10; i++) {
      let x = rng() * w;
      let y = rng() * h;
      let angle = rng() * Math.PI * 2;
      ctx.lineWidth = 5 + rng() * 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let st = 0; st < 6; st++) {
        angle += (rng() - 0.5) * 1.1;
        x += Math.cos(angle) * (18 + rng() * 26);
        y += Math.sin(angle) * (10 + rng() * 16);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    // Dirt ingress along both edges.
    const edgeGradL = ctx.createLinearGradient(0, 0, 0, A(1.8));
    edgeGradL.addColorStop(0, 'rgba(84,74,56,0.4)');
    edgeGradL.addColorStop(1, 'rgba(84,74,56,0)');
    ctx.fillStyle = edgeGradL;
    ctx.fillRect(0, 0, w, A(1.8));
    const edgeGradR = ctx.createLinearGradient(0, h, 0, h - A(1.8));
    edgeGradR.addColorStop(0, 'rgba(84,74,56,0.4)');
    edgeGradR.addColorStop(1, 'rgba(84,74,56,0)');
    ctx.fillStyle = edgeGradR;
    ctx.fillRect(0, h - A(1.8), w, A(1.8));
    // --- tyre skid / touchdown rubber (under markings) ---
    for (let end = 0; end < 2; end++) {
      const fromX = end === 0 ? M(26) : w - M(26);
      const toX = end === 0 ? M(96) : w - M(96);
      const gradient = ctx.createLinearGradient(fromX, 0, toX, 0);
      gradient.addColorStop(0, 'rgba(8,8,9,0.5)');
      gradient.addColorStop(0.55, 'rgba(8,8,9,0.26)');
      gradient.addColorStop(1, 'rgba(8,8,9,0)');
      ctx.fillStyle = gradient;
      const rectX = Math.min(fromX, toX);
      const rectW = Math.abs(toX - fromX);
      ctx.fillRect(rectX, cy - A(3.2), rectW, A(1.6));
      ctx.fillRect(rectX, cy + A(1.6), rectW, A(1.6));
      // Wavy skid tails: thin streaks wandering off the main tracks.
      ctx.fillStyle = 'rgba(8,8,9,0.2)';
      for (let t = 0; t < 5; t++) {
        const ty = cy + (rng() - 0.5) * A(6.5);
        const tx = end === 0 ? M(34) + rng() * M(44) : w - M(78) + rng() * M(44);
        ctx.fillRect(tx, ty, M(15) + rng() * M(26), 3 + rng() * 3);
      }
    }
    // Faint centre rubber deposit along the middle third.
    ctx.fillStyle = 'rgba(10,10,11,0.1)';
    ctx.fillRect(w * 0.34, cy - A(2.1), w * 0.32, A(4.2));
    // --- markings (crisp white on dark asphalt, env6) ---
    ctx.fillStyle = '#F2EDE4';
    // Edge lines: 0.9 m wide, inset 0.3 m.
    ctx.fillRect(0, A(0.3), w, A(0.9));
    ctx.fillRect(0, h - A(1.2), w, A(0.9));
    // Threshold chevrons (blast-pad arrows pointing down-runway).
    for (let end = 0; end < 2; end++) {
      const dir = end === 0 ? 1 : -1;
      const baseX = end === 0 ? M(1) : w - M(1);
      ctx.strokeStyle = '#F2EDE4';
      ctx.lineWidth = A(0.9);
      ctx.lineJoin = 'miter';
      for (let c = 0; c < 2; c++) {
        const tipX = baseX + dir * M(9);
        const backX = baseX + dir * (M(1) + c * M(5));
        const topY = A(2.4) + c * A(0.4);
        const botY = h - A(2.4) - c * A(0.4);
        ctx.beginPath();
        ctx.moveTo(backX, topY);
        ctx.lineTo(tipX, cy);
        ctx.lineTo(backX, botY);
        ctx.stroke();
      }
    }
    // Threshold piano-key bars: 6 bars, 18 m long, 2 m wide, 0.55 m gaps.
    for (let end = 0; end < 2; end++) {
      const baseX = end === 0 ? M(14) : w - M(14) - M(18);
      for (let bar = 0; bar < 6; bar++) {
        ctx.fillRect(baseX, A(1.9) + bar * A(2.55), M(18), A(2));
      }
    }
    // Runway numbers: 12 m tall, crisp at altitude.
    const nearNumber = String(Math.round(strip.headingDeg / 10) % 36 || 36).padStart(2, '0');
    const farNumber = String(((Math.round(strip.headingDeg / 10) + 18) % 36) || 36).padStart(2, '0');
    ctx.font = `800 ${Math.round(A(12))}px "Segoe UI", system-ui, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(M(51), cy);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(nearNumber, 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(w - M(51), cy);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(farNumber, 0, 0);
    ctx.restore();
    // Aiming-point bars either side of centreline (20 m x 2.3 m).
    for (let end = 0; end < 2; end++) {
      const baseX = end === 0 ? M(80) : w - M(80) - M(20);
      ctx.fillRect(baseX, A(3.7), M(20), A(2.3));
      ctx.fillRect(baseX, h - A(6), M(20), A(2.3));
    }
    // Touchdown-zone bar pairs (two per end, 14 m x 1.8 m).
    for (let end = 0; end < 2; end++) {
      for (let pair = 0; pair < 2; pair++) {
        const baseX = end === 0 ? M(116) + pair * M(32) : w - M(116) - pair * M(32) - M(14);
        ctx.fillRect(baseX, A(4.1), M(14), A(1.8));
        ctx.fillRect(baseX, h - A(5.9), M(14), A(1.8));
      }
    }
    // Centreline dashes: 15 m x 2.3 m, 7.5 m gaps.
    for (let x = M(109); x < w - M(123); x += M(22.5)) {
      ctx.fillRect(x, cy - A(1.15), M(15), A(2.3));
    }
    // --- paint wear: asphalt-tone speckle concentrated on marking bands ---
    const wearBands = [
      { y0: 0, y1: A(2) }, { y0: h - A(2), y1: h }, // edge lines
      { y0: cy - A(1.4), y1: cy + A(1.4) }, // centreline
      { y0: A(1.7), y1: h - A(1.7), x0: 0, x1: M(72) }, // near threshold + numbers
      { y0: A(1.7), y1: h - A(1.7), x0: w - M(72), x1: w }, // far threshold + numbers
      { y0: A(3.4), y1: A(6.2) }, { y0: h - A(6.2), y1: h - A(3.4) }, // aiming / TDZ bars
    ];
    for (const band of wearBands) {
      const bx0 = band.x0 || 0;
      const bx1 = band.x1 || w;
      const count = band.x0 ? 800 : 1000;
      for (let i = 0; i < count; i++) {
        ctx.fillStyle = rng() > 0.4 ? 'rgba(63,64,69,0.55)' : 'rgba(38,38,42,0.5)';
        ctx.fillRect(bx0 + rng() * (bx1 - bx0), band.y0 + rng() * (band.y1 - band.y0), 2 + rng() * 4, 2 + rng() * 3);
      }
    }
    // Scuff scratches across the paint.
    ctx.strokeStyle = 'rgba(63,64,69,0.35)';
    for (let i = 0; i < 44; i++) {
      const sx = rng() * w;
      const sy = rng() * h;
      ctx.lineWidth = 1 + rng() * 1.5;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 20 + rng() * 50, sy + (rng() - 0.5) * 10);
      ctx.stroke();
    }
    // Final light grit over everything so paint sits in the surface.
    for (let i = 0; i < 1800; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(12,12,14,0.14)' : 'rgba(200,202,208,0.10)';
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
    ctx.fillStyle = '#5D5A52';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(28,27,24,0.12)' : 'rgba(200,196,184,0.07)';
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 18 + rng() * 40, 8 + rng() * 18, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 1600; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(20,19,17,0.26)' : 'rgba(210,206,194,0.20)';
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
    ctx.fillStyle = 'rgba(10,10,9,0.3)';
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
    ctx.strokeStyle = '#F2EDE4';
    ctx.lineWidth = 9;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.fillStyle = '#D64541';
    ctx.font = '800 96px "Segoe UI", system-ui, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('P', w / 2, h / 2 + 4);
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = 'rgba(93,90,82,0.6)';
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
    ctx.fillStyle = '#4A4A4E';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(20,20,22,0.14)' : 'rgba(170,172,178,0.07)';
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 24 + rng() * 50, 8 + rng() * 14, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 2200; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(14,14,16,0.3)' : 'rgba(185,188,195,0.2)';
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
      ctx.fillStyle = 'rgba(74,74,78,0.6)';
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
    color: 0x4a4a4e, roughness: 0.97, metalness: 0.0, flatShading: true,
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
    size: 7.5,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  }));
  points.frustumCulled = false;
  group.add(points);
  // Ground light pools: one merged quad per lamp, additive.
  const poolSize = 8.5;
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
    opacity: 0.42,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  pools.frustumCulled = false;
  group.add(pools);
  return group;
}
