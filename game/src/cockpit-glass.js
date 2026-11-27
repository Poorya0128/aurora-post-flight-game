// cockpit-glass.js — glass-cockpit upgrade for the AURORA POST bush plane.
// One job: rebuild the cabin interior toward a modern glass-cockpit layout
// (exact target: cockpit-target-exact.jpg — faceted GREY panel with
// chamfered top corners, large PFD left-of-centre, centre moving-map
// display, smaller engine display right, toggle + circuit-breaker rows,
// edge knobs, placards, overhead toggle panel, side consoles; the
// canopy frame itself is the slim shell frame in aircraft.js). Single
// centre seat: the display cluster is centred on
// x = 0 and sits IN the panel face (nothing on the glareshield), so the
// panel top stays low and the runway clears the brow. The PFD covers the
// round attitude + heading gauges and the centre NAV covers the round
// altimeter + VSI (all four duplicated on the PFD page); airspeed + turn
// coordinator are off-panel too (EXACT-TARGET E2: bare faceted left
// cheek) — only the small tach/fuel/flap gauge column stays visible.
// HUD combiner removed at user order 2026-11-27 — never re-add it.
// Display only: reads PlaneState, writes nothing back. All textures are
// procedural canvas; all geometry is primitives, merged or instanced.
// No external assets.
//
// Returns { panelGroup, cockpitGroup, update(plane, timeSeconds) }.
// panelGroup items use instrument-panel-local coordinates (aircraft.js
// buildInstrumentPanelWithGauges: board front face z = 0.035, +Y up).
// cockpitGroup items use aircraft-local coordinates (eye at
// AIRCRAFT_LAYOUT.cockpitEyePoint, panel centre z = -0.88).
// Screens redraw at 4 Hz; update() allocates nothing per frame.

import * as THREE from 'three';
import { ISLANDS, STRIPS } from './config.js';

const FONT = 'AuroraSans, "Segoe UI", system-ui, Arial, sans-serif';
const MONO = '"Consolas", "SFMono-Regular", "Menlo", monospace';
const LCD_GREEN = '#7DFFB2';
const LCD_AMBER = '#FFD166';
const LCD_CYAN = '#7FD4FF';
const LCD_DIM = 'rgba(125,255,178,0.4)';
const HUD_GREEN = '#4DFF88';
const REDRAW_SECONDS = 0.25; // 4 Hz for every glass surface

// ---------------------------------------------------------------- helpers

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

// Build-time merge of pre-transformed geometries sharing one material
// (same pattern as aircraft.js D-130; no addons vendored).
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function num(value, fallback) {
  return typeof value === 'number' && !Number.isNaN(value) ? value : fallback;
}

// Diagonal glass sheen baked into every LCD face (no extra mesh).
// VD6-COCKMAT: second faint counter-band + top-edge catch-light + corner
// vignette so MFDs read as glass over a display. Alphas low — PFD/NAV
// readouts must stay crisp at 768x480.
function drawSheen(context, width, height) {
  const gradient = context.createLinearGradient(0, 0, width * 0.7, height);
  gradient.addColorStop(0, 'rgba(255,255,255,0.14)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.03)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  const counter = context.createLinearGradient(width, height * 0.6, width * 0.4, height);
  counter.addColorStop(0, 'rgba(255,240,210,0.05)');
  counter.addColorStop(1, 'rgba(255,240,210,0)');
  context.fillStyle = counter;
  context.fillRect(0, 0, width, height);
  context.fillStyle = 'rgba(255,255,255,0.10)';
  context.fillRect(0, 0, width, 2);
  const vignette = context.createRadialGradient(
    width / 2, height / 2, Math.min(width, height) * 0.42,
    width / 2, height / 2, Math.max(width, height) * 0.72,
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.16)');
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
}

// VD6-COCKMAT: shared wear/grain textures (roughness + bump variation).
// Texture-only — same meshes, richer materials, zero new draw calls.
let bezelWearCache = null;
function bezelWearTexture() {
  if (bezelWearCache) return bezelWearCache;
  const canvas = makeCanvas(256, 256);
  if (!canvas) return null;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#d9d9d9';
  context.fillRect(0, 0, 256, 256);
  let seed = 4193;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 1400; i += 1) {
    const shade = 195 + Math.floor(random() * 45);
    context.fillStyle = `rgb(${shade},${shade},${shade})`;
    context.fillRect(random() * 256, random() * 256, 1.4, 1.4);
  }
  context.strokeStyle = 'rgba(110,110,110,0.5)';
  context.lineWidth = 1;
  for (let i = 0; i < 20; i += 1) {
    const x = random() * 256;
    const y = random() * 256;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + 8 + random() * 34, y + (random() - 0.5) * 9);
    context.stroke();
  }
  context.fillStyle = 'rgba(130,130,130,0.32)';
  context.fillRect(0, 0, 256, 8);
  context.fillRect(0, 248, 256, 8);
  context.fillRect(0, 0, 8, 256);
  context.fillRect(248, 0, 8, 256);
  bezelWearCache = canvasTexture(canvas);
  bezelWearCache.wrapS = THREE.RepeatWrapping;
  bezelWearCache.wrapT = THREE.RepeatWrapping;
  return bezelWearCache;
}

let panelGrainCache = null;
function panelGrainTexture() {
  if (panelGrainCache) return panelGrainCache;
  const canvas = makeCanvas(512, 512);
  if (!canvas) return null;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#e6e6e6';
  context.fillRect(0, 0, 512, 512);
  let seed = 6521;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 4200; i += 1) {
    const shade = 205 + Math.floor(random() * 45);
    context.fillStyle = `rgb(${shade},${shade},${shade})`;
    context.fillRect(random() * 512, random() * 512, 1.6, 1.6);
  }
  for (let i = 0; i < 20; i += 1) {
    const x = random() * 512;
    const y = random() * 512;
    const r = 20 + random() * 50;
    const smudge = context.createRadialGradient(x, y, 1, x, y, r);
    smudge.addColorStop(0, 'rgba(125,125,125,0.32)');
    smudge.addColorStop(1, 'rgba(125,125,125,0)');
    context.fillStyle = smudge;
    context.fillRect(x - r, y - r, r * 2, r * 2);
  }
  panelGrainCache = canvasTexture(canvas);
  panelGrainCache.wrapS = THREE.RepeatWrapping;
  panelGrainCache.wrapT = THREE.RepeatWrapping;
  return panelGrainCache;
}

// SLING-PANEL: carbon-fibre 2x2 twill weave for the panel fascia.
// One 256px tile = 8x8 tows; each tow is a soft gradient band (light
// centre, dark edges) oriented horizontally or vertically per the
// 2/2 twill pattern ((col - row) mod 4 < 2 -> horizontal), with a
// 1px dark gap between tows and a faint diagonal sheen over the tile.
// Used as map + bumpMap on the fascia; repeat is set by the caller
// (ShapeGeometry UVs are in metres, so repeat 36 -> ~3.5 mm tows).
let carbonWeaveCache = null;
function carbonWeaveTexture() {
  if (carbonWeaveCache) return carbonWeaveCache;
  const canvas = makeCanvas(256, 256);
  if (!canvas) return null;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#101215';
  context.fillRect(0, 0, 256, 256);
  const cell = 32;
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const horizontal = (((col - row) % 4) + 4) % 4 < 2;
      const x = col * cell;
      const y = row * cell;
      const gradient = horizontal
        ? context.createLinearGradient(x, y, x, y + cell)
        : context.createLinearGradient(x, y, x + cell, y);
      // PANEL-FIX2: tow contrast raised (bright centre, deep edges) so
      // the weave survives the pilot's oblique view + 768 px shrink.
      gradient.addColorStop(0, '#050607');
      gradient.addColorStop(0.28, '#5d656f');
      gradient.addColorStop(0.5, '#c3ccd6');
      gradient.addColorStop(0.72, '#454c55');
      gradient.addColorStop(1, '#050607');
      context.fillStyle = gradient;
      context.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      // Fine fibre striations along the tow direction.
      context.fillStyle = 'rgba(0,0,0,0.16)';
      for (let s = 0; s < 5; s += 1) {
        const off = 5 + s * 5.5;
        if (horizontal) context.fillRect(x + 2, y + off, cell - 4, 1);
        else context.fillRect(x + off, y + 2, 1, cell - 4);
      }
      context.fillStyle = 'rgba(255,255,255,0.05)';
      if (horizontal) context.fillRect(x + 2, y + cell * 0.44, cell - 4, 1.5);
      else context.fillRect(x + cell * 0.44, y + 2, 1.5, cell - 4);
    }
  }
  // Subtle diagonal sheen so the weave catches the panel light.
  const sheen = context.createLinearGradient(0, 0, 256, 256);
  sheen.addColorStop(0, 'rgba(255,255,255,0.06)');
  sheen.addColorStop(0.45, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(255,255,255,0.04)');
  context.fillStyle = sheen;
  context.fillRect(0, 0, 256, 256);
  carbonWeaveCache = canvasTexture(canvas);
  carbonWeaveCache.wrapS = THREE.RepeatWrapping;
  carbonWeaveCache.wrapT = THREE.RepeatWrapping;
  // PANEL-FIX2/B3: repeat 36 -> 13 -> 7 (~17 mm tows). Audit pass 2
  // still read flat black at 768; chunky stylised tows + hard
  // light/dark contrast are what survive the shrink.
  carbonWeaveCache.repeat.set(7, 7);
  return carbonWeaveCache;
}

// EXACT-TARGET (E2): faceted grey panel skin for the fascia.
// cockpit-target-exact.jpg shows a flat-shaded low-poly GREY panel
// (large triangles, lighter toward the upper-left cheek), NOT the
// black carbon slab. One 1024x384 canvas spans the whole fascia:
// a jittered grid triangulated into big flat facets, each filled
// with a grey shade (base #6c7179, lightened toward the top-left
// where the target cheek catches the light), thin dark facet edges,
// fine grain. ShapeGeometry UVs are in metres, so repeat/offset map
// the panel extent (x -0.74..0.74, y -0.27..0.265) onto 0..1.
let facetGreyCache = null;
function facetGreyTexture() {
  if (facetGreyCache) return facetGreyCache;
  const canvas = makeCanvas(1024, 384);
  if (!canvas) return null;
  const context = canvas.getContext('2d');
  if (!context) return null;
  let seed = 90210;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const cols = 13;
  const rows = 5;
  const points = [];
  for (let r = 0; r <= rows; r += 1) {
    points.push([]);
    for (let c = 0; c <= cols; c += 1) {
      const jx = (c === 0 || c === cols) ? 0 : (random() - 0.5) * 26;
      const jy = (r === 0 || r === rows) ? 0 : (random() - 0.5) * 20;
      points[r].push([(c / cols) * 1024 + jx, (r / rows) * 384 + jy]);
    }
  }
  const facet = (p1, p2, p3) => {
    const cxF = (p1[0] + p2[0] + p3[0]) / 3;
    const cyF = (p1[1] + p2[1] + p3[1]) / 3;
    // Light falls from the upper-left in the target: facets lighten
    // toward that corner, plus per-facet random variation.
    const light = 1.08 - (cxF / 1024) * 0.14 - (cyF / 384) * 0.08 + (random() - 0.5) * 0.15;
    const shade = (base) => Math.max(48, Math.min(148, Math.round(base * light)));
    context.fillStyle = `rgb(${shade(97)},${shade(102)},${shade(110)})`;
    context.beginPath();
    context.moveTo(p1[0], p1[1]);
    context.lineTo(p2[0], p2[1]);
    context.lineTo(p3[0], p3[1]);
    context.closePath();
    context.fill();
    context.strokeStyle = 'rgba(28,30,36,0.16)';
    context.lineWidth = 1.2;
    context.stroke();
  };
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const tl = points[r][c];
      const tr = points[r][c + 1];
      const bl = points[r + 1][c];
      const br = points[r + 1][c + 1];
      if ((r + c) % 2 === 0) { facet(tl, tr, bl); facet(tr, br, bl); } else { facet(tl, tr, br); facet(tl, br, bl); }
    }
  }
  // Fine grain so the facets read as moulded panel, not flat print.
  for (let i = 0; i < 2600; i += 1) {
    context.fillStyle = random() > 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)';
    context.fillRect(random() * 1024, random() * 384, 1.5, 1.5);
  }
  facetGreyCache = canvasTexture(canvas);
  facetGreyCache.repeat.set(1 / 1.48, 1 / 0.535);
  facetGreyCache.offset.set(0.5, 0.27 / 0.535);
  return facetGreyCache;
}

// ---------------------------------------------------------------- drawing
// state = { x, z, headingDeg, pitchDeg, rollDeg, airspeed, groundSpeed,
//           altitudeMsl, altitudeAgl, verticalSpeed, throttle, fuel,
//           damage, flaps, rpm, engineOn, stalled, onGround, clock }

/** PFD page: attitude ball + pitch ladder, speed/altitude tapes, heading. */
export function drawPfdPage(context, width, height, state) {
  context.fillStyle = '#04090f';
  context.fillRect(0, 0, width, height);
  const cx = width / 2;
  // EXACT-TARGET (E2): BIG dominant attitude ball like the target PFD
  // (ball diameter ~75% of page height, tapes ride over its edges).
  const cy = height * 0.45;
  const ballR = height * 0.375;
  const pitchPx = clamp(state.pitchDeg, -30, 30) * (ballR / 30) * 0.9;
  const rollRad = (-state.rollDeg * Math.PI) / 180;

  // Attitude ball (clipped circle, horizon moves with pitch/roll).
  context.save();
  context.beginPath();
  context.arc(cx, cy, ballR, 0, Math.PI * 2);
  context.clip();
  context.translate(cx, cy);
  context.rotate(rollRad);
  context.translate(0, pitchPx);
  context.fillStyle = '#2f6fb4';
  context.fillRect(-ballR * 1.6, -ballR * 1.6, ballR * 3.2, ballR * 1.6);
  context.fillStyle = '#7a5a3a';
  context.fillRect(-ballR * 1.6, 0, ballR * 3.2, ballR * 1.6);
  context.fillStyle = '#ffffff';
  context.fillRect(-ballR * 1.6, -3, ballR * 3.2, 6); // M5: bolder horizon
  context.strokeStyle = 'rgba(255,255,255,0.95)';
  context.lineWidth = 4.5;
  context.font = '800 17px ' + FONT;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const deg of [-20, -10, 10, 20]) {
    const y = (-deg * ballR) / 30;
    const half = Math.abs(deg) === 10 ? ballR * 0.42 : ballR * 0.26;
    context.beginPath();
    context.moveTo(-half, y);
    context.lineTo(half, y);
    context.stroke();
    context.fillStyle = '#ffffff';
    context.fillText(String(Math.abs(deg)), -half - 16, y);
    context.fillText(String(Math.abs(deg)), half + 16, y);
  }
  context.restore();
  context.beginPath();
  context.arc(cx, cy, ballR, 0, Math.PI * 2);
  context.strokeStyle = 'rgba(255,255,255,0.55)';
  context.lineWidth = 2;
  context.stroke();
  // Roll pointer + fixed aircraft symbol.
  context.save();
  context.translate(cx, cy);
  context.rotate(rollRad);
  context.fillStyle = LCD_AMBER;
  context.beginPath();
  context.moveTo(0, -ballR + 4);
  context.lineTo(8, -ballR + 18);
  context.lineTo(-8, -ballR + 18);
  context.closePath();
  context.fill();
  context.restore();
  context.strokeStyle = LCD_AMBER;
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(cx - ballR * 0.62, cy);
  context.lineTo(cx - ballR * 0.18, cy);
  context.lineTo(cx - ballR * 0.18, cy + 9);
  context.moveTo(cx + ballR * 0.62, cy);
  context.lineTo(cx + ballR * 0.18, cy);
  context.lineTo(cx + ballR * 0.18, cy + 9);
  context.stroke();
  context.fillStyle = LCD_AMBER;
  context.fillRect(cx - 4, cy - 4, 8, 8);

  // Speed tape (left) and altitude tape (right).
  const tape = (x, value, step, label, format) => {
    context.fillStyle = 'rgba(4,12,20,0.85)';
    context.fillRect(x, cy - ballR, 64, ballR * 2);
    context.strokeStyle = LCD_DIM;
    context.lineWidth = 1.5;
    context.strokeRect(x, cy - ballR, 64, ballR * 2);
    context.font = '800 20px ' + MONO; // M5: tape numbers up for 768 px
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const base = Math.round(value / step) * step;
    for (let i = -3; i <= 3; i += 1) {
      const v = base + i * step;
      if (v < 0) continue;
      const y = cy - i * (ballR * 0.28) - ((value - base) / step) * ballR * 0.28;
      context.fillStyle = i === 0 ? '#ffffff' : 'rgba(220,240,255,0.7)';
      context.fillText(format(v), x + 32, y);
      context.fillRect(x + 56, y - 1, 8, 2);
    }
    context.fillStyle = 'rgba(10,30,20,0.95)';
    context.fillRect(x - 4, cy - 17, 72, 34);
    context.strokeStyle = LCD_GREEN;
    context.strokeRect(x - 4, cy - 17, 72, 34);
    context.fillStyle = LCD_GREEN;
    context.font = '800 31px ' + MONO; // M5: current-value box is THE number at 768 px
    context.fillText(format(Math.round(value)), x + 32, cy + 1);
    context.font = '800 14px ' + FONT;
    context.fillStyle = LCD_DIM;
    context.fillText(label, x + 32, cy - ballR - 12);
  };
  // M5: coarser tape steps = fewer, bigger numbers at judge size.
  tape(10, state.airspeed, 10, 'SPD M/S', (v) => String(v));
  tape(width - 74, state.altitudeMsl, 50, 'ALT M', (v) => String(v));

  // Heading strip + vertical speed + flags.
  context.fillStyle = 'rgba(4,12,20,0.9)';
  context.fillRect(cx - 110, height - 52, 220, 40);
  context.strokeStyle = LCD_DIM;
  context.strokeRect(cx - 110, height - 52, 220, 40);
  context.font = '800 28px ' + MONO; // PANEL-FIX2
  context.fillStyle = LCD_GREEN;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('HDG ' + String(Math.round(state.headingDeg) % 360).padStart(3, '0') + '°', cx, height - 31);
  context.font = '800 22px ' + MONO; // PANEL-FIX2
  context.fillStyle = Math.abs(state.verticalSpeed) > 6 ? '#FF9F1C' : LCD_CYAN;
  context.fillText('V/S ' + (state.verticalSpeed >= 0 ? '+' : '') + state.verticalSpeed.toFixed(1), width - 42, height - 31);
  context.textAlign = 'left';
  context.font = '800 15px ' + FONT;
  context.fillStyle = LCD_DIM;
  context.fillText('PFD · ATTITUDE', 10, 18);
  if (state.stalled) {
    context.fillStyle = '#FF3B30';
    context.font = '800 22px ' + FONT;
    context.fillText('STALL', 10, 44);
  } else if (!state.engineOn) {
    context.fillStyle = '#FF9F1C';
    context.font = '800 19px ' + FONT;
    context.fillText('ENG OUT', 10, 44);
  }
  drawSheen(context, width, height);
}

/** NAV page: track-up moving map with radar range rings + nearest strip. */
export function drawNavPage(context, width, height, state) {
  const headingRad = (state.headingDeg * Math.PI) / 180;
  const ownX = width / 2;
  const ownY = height * 0.58;
  const ringM = 4000;
  const pxPerM = (height * 0.4) / ringM;
  const reach = 6500 * 1.6;
  context.fillStyle = '#06131f';
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(ownX, ownY);
  context.rotate(-headingRad);
  context.strokeStyle = 'rgba(80,160,220,0.14)';
  context.lineWidth = 1;
  // M5: 2 km grid (was 1 km) — half the lines, map reads at 768.
  const firstX = Math.floor((state.x - reach) / 2000) * 2000;
  const firstZ = Math.floor((state.z - reach) / 2000) * 2000;
  for (let gx = firstX; gx <= state.x + reach; gx += 2000) {
    const sx = (gx - state.x) * pxPerM;
    context.beginPath();
    context.moveTo(sx, -reach * pxPerM);
    context.lineTo(sx, reach * pxPerM);
    context.stroke();
  }
  for (let gz = firstZ; gz <= state.z + reach; gz += 2000) {
    const sy = (gz - state.z) * pxPerM;
    context.beginPath();
    context.moveTo(-reach * pxPerM, sy);
    context.lineTo(reach * pxPerM, sy);
    context.stroke();
  }
  for (const island of ISLANDS) {
    const dx = island.centre.x - state.x;
    const dz = island.centre.z - state.z;
    if (Math.hypot(dx, dz) - island.radius > reach) continue;
    const cxI = dx * pxPerM;
    const cyI = dz * pxPerM;
    const r = island.radius * pxPerM;
    const gradient = context.createRadialGradient(cxI, cyI, r * 0.15, cxI, cyI, r);
    gradient.addColorStop(0, 'rgba(104,156,78,0.95)');
    gradient.addColorStop(0.82, 'rgba(72,120,58,0.95)');
    gradient.addColorStop(1, 'rgba(217,179,128,0.9)');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(cxI, cyI, r, 0, Math.PI * 2);
    context.fill();
  }
  context.strokeStyle = '#F2EDE4';
  context.lineCap = 'round';
  context.lineWidth = 5;
  for (const strip of STRIPS) {
    const cxS = (strip.position.x - state.x) * pxPerM;
    const cyS = (strip.position.z - state.z) * pxPerM;
    const half = Math.max(5, (strip.length / 2) * pxPerM);
    const rad = (strip.headingDeg * Math.PI) / 180;
    const ux = Math.sin(rad);
    const uy = -Math.cos(rad);
    context.beginPath();
    context.moveTo(cxS - ux * half, cyS - uy * half);
    context.lineTo(cxS + ux * half, cyS + uy * half);
    context.stroke();
  }
  context.restore();
  // Upright island labels.
  context.font = '800 17px ' + FONT; // M5
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const cosH = Math.cos(-headingRad);
  const sinH = Math.sin(-headingRad);
  for (const island of ISLANDS) {
    const dx = island.centre.x - state.x;
    const dz = island.centre.z - state.z;
    if (Math.hypot(dx, dz) - island.radius > reach) continue;
    const lx = ownX + (dx * cosH - dz * sinH) * pxPerM;
    const ly = ownY + (dx * sinH + dz * cosH) * pxPerM;
    if (lx < -30 || lx > width + 30 || ly < 40 || ly > height - 30) continue;
    context.strokeStyle = 'rgba(4,10,18,0.85)';
    context.lineWidth = 3;
    context.strokeText(island.name.toUpperCase(), lx, ly);
    context.fillStyle = 'rgba(230,255,238,0.92)';
    context.fillText(island.name.toUpperCase(), lx, ly);
  }
  // Radar-style range rings (full circles, reference right MFD).
  context.strokeStyle = 'rgba(77,255,136,0.5)';
  context.lineWidth = 1.5;
  for (const rm of [1000, 2000, 4000]) {
    context.beginPath();
    context.arc(ownX, ownY, rm * pxPerM, 0, Math.PI * 2);
    context.stroke();
  }
  context.strokeStyle = 'rgba(125,255,178,0.6)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(ownX, ownY - 18);
  context.lineTo(ownX, ownY - height * 0.32);
  context.stroke();
  context.fillStyle = LCD_GREEN;
  context.strokeStyle = '#06131f';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(ownX, ownY - 18);
  context.lineTo(ownX + 12, ownY + 12);
  context.lineTo(ownX, ownY + 6);
  context.lineTo(ownX - 12, ownY + 12);
  context.closePath();
  context.fill();
  context.stroke();
  // Nearest strip readout.
  let nearest = null;
  let nearestDist = Infinity;
  for (const strip of STRIPS) {
    const d = Math.hypot(strip.position.x - state.x, strip.position.z - state.z);
    if (d < nearestDist) { nearestDist = d; nearest = strip; }
  }
  context.fillStyle = 'rgba(4,10,18,0.9)';
  context.fillRect(0, 0, width, 38);
  context.font = '800 24px ' + MONO; // PANEL-FIX2: TRK/GS up for 768 px
  context.textAlign = 'left';
  context.fillStyle = LCD_GREEN;
  context.fillText('TRK ' + String(Math.round(state.headingDeg) % 360).padStart(3, '0') + '°', 8, 23);
  context.textAlign = 'right';
  context.fillStyle = LCD_AMBER;
  context.fillText('GS ' + Math.round(state.groundSpeed) + ' M/S', width - 8, 23);
  context.fillStyle = 'rgba(4,10,18,0.9)';
  context.fillRect(0, height - 34, width, 34);
  context.font = '800 19px ' + MONO; // PANEL-FIX2
  context.fillStyle = LCD_CYAN;
  context.textAlign = 'center';
  if (nearest) {
    const distText = nearestDist >= 1000
      ? (nearestDist / 1000).toFixed(1) + ' KM'
      : Math.round(nearestDist) + ' M';
    context.fillText('NEAREST ' + nearest.name.toUpperCase() + ' · ' + distText, width / 2, height - 17);
  }
  drawSheen(context, width, height);
}

/** Engine / system page: RPM, fuel, throttle, damage, flap, clock. */
export function drawEnginePage(context, width, height, state) {
  context.fillStyle = '#05090d';
  context.fillRect(0, 0, width, height);
  context.textBaseline = 'middle';
  context.font = '800 15px ' + FONT;
  context.textAlign = 'left';
  context.fillStyle = LCD_DIM;
  context.fillText('ENGINE · SYSTEMS', 10, 18);
  context.textAlign = 'right';
  context.font = '800 20px ' + MONO;
  context.fillStyle = LCD_AMBER;
  context.fillText(state.clock, width - 10, 18);

  const bar = (y, label, fraction, text, color) => {
    context.font = '800 17px ' + FONT; // PANEL-FIX2
    context.textAlign = 'left';
    context.fillStyle = LCD_DIM;
    context.fillText(label, 10, y);
    const bx = 110;
    const bw = width - 220;
    context.fillStyle = 'rgba(255,255,255,0.14)';
    context.fillRect(bx, y - 12, bw, 24); // M5: taller bars read at 768
    context.fillStyle = color;
    context.fillRect(bx, y - 12, bw * clamp(fraction, 0, 1), 24);
    context.fillStyle = 'rgba(5,9,13,0.8)';
    for (const tick of [0.25, 0.5, 0.75]) context.fillRect(bx + bw * tick - 1, y - 12, 2, 24);
    context.font = '800 24px ' + MONO; // PANEL-FIX2: values up for 768 px
    context.textAlign = 'right';
    context.fillStyle = '#ffffff';
    context.fillText(text, width - 10, y + 1);
  };
  bar(56, 'RPM', state.rpm / 2800, String(Math.round(state.rpm / 10) * 10),
    state.rpm > 2700 ? '#FF6B6B' : LCD_GREEN);
  bar(92, 'THR', state.throttle, Math.round(state.throttle * 100) + '%', LCD_CYAN);
  bar(128, 'FUEL', state.fuel, Math.round(state.fuel * 100) + '%',
    state.fuel < 0.25 ? '#FF9F1C' : LCD_AMBER);
  bar(164, 'DMG', state.damage, Math.round(state.damage * 100) + '%',
    state.damage >= 0.5 ? '#FF6B6B' : state.damage >= 0.25 ? '#FF9F1C' : LCD_GREEN);

  // Flap + gear + engine annunciators.
  context.font = '800 19px ' + FONT; // PANEL-FIX2
  const chip = (x, text, on, color) => {
    context.fillStyle = on ? 'rgba(20,50,35,0.95)' : 'rgba(255,255,255,0.07)';
    context.fillRect(x, height - 46, 104, 32);
    context.strokeStyle = on ? color : 'rgba(255,255,255,0.25)';
    context.lineWidth = 1.5;
    context.strokeRect(x, height - 46, 104, 32);
    context.fillStyle = on ? color : 'rgba(255,255,255,0.45)';
    context.textAlign = 'center';
    context.fillText(text, x + 52, height - 29);
  };
  chip(10, 'FLAP ' + ['UP', 'APP', 'FULL'][clamp(state.flaps, 0, 2)], state.flaps > 0, LCD_GREEN);
  chip(124, state.onGround ? 'ON GND' : 'AIRBORNE', true, LCD_CYAN);
  chip(238, state.engineOn ? 'ENG ON' : 'ENG OUT', state.engineOn, state.engineOn ? LCD_GREEN : '#FF9F1C');
  chip(352, state.stalled ? 'STALL' : 'STALL OK', !state.stalled, state.stalled ? '#FF3B30' : LCD_GREEN);
  drawSheen(context, width, height);
}

/** HUD combiner symbology on a transparent canvas (additive green). */
export function drawHudSymbology(context, width, height, state) {
  context.clearRect(0, 0, width, height);
  // VD6-COCKMAT: combiner glass tint + edge glow. Very low-alpha fill
  // (additive material) so the pane reads as tinted glass with a lit
  // edge, while the runway stays fully visible through it. A faint
  // diagonal sheen sells the glass without washing the symbology.
  // VD6-VISIBILITY: tint halved — symbology-only read, no tint block
  // between the pilot and the runway.
  const tint = context.createLinearGradient(0, 0, width * 0.6, height);
  tint.addColorStop(0, 'rgba(120,220,255,0.028)');
  tint.addColorStop(0.5, 'rgba(80,255,160,0.016)');
  tint.addColorStop(1, 'rgba(80,255,160,0.008)');
  context.fillStyle = tint;
  context.fillRect(0, 0, width, height);
  const sheen = context.createLinearGradient(0, 0, width * 0.75, height);
  sheen.addColorStop(0, 'rgba(255,255,255,0.05)');
  sheen.addColorStop(0.4, 'rgba(255,255,255,0)');
  context.fillStyle = sheen;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = 'rgba(77,255,136,0.32)';
  context.lineWidth = 2;
  context.strokeRect(3, 3, width - 6, height - 6);
  context.strokeStyle = 'rgba(77,255,136,0.55)';
  context.lineWidth = 3;
  const tick = 16;
  context.beginPath();
  context.moveTo(3, 3 + tick); context.lineTo(3, 3); context.lineTo(3 + tick, 3);
  context.moveTo(width - 3 - tick, 3); context.lineTo(width - 3, 3); context.lineTo(width - 3, 3 + tick);
  context.moveTo(width - 3, height - 3 - tick); context.lineTo(width - 3, height - 3); context.lineTo(width - 3 - tick, height - 3);
  context.moveTo(3 + tick, height - 3); context.lineTo(3, height - 3); context.lineTo(3, height - 3 - tick);
  context.stroke();
  const cx = width / 2;
  const cy = height / 2;
  const pitchPx = clamp(state.pitchDeg, -25, 25) * (height / 55);
  const rollRad = (-state.rollDeg * Math.PI) / 180;
  context.strokeStyle = HUD_GREEN;
  context.fillStyle = HUD_GREEN;
  context.lineWidth = 3;
  context.font = '800 22px ' + MONO;
  context.textBaseline = 'middle';

  // Pitch ladder (moves with pitch, rotates with roll).
  context.save();
  context.translate(cx, cy + pitchPx);
  context.rotate(rollRad);
  for (const deg of [-15, -10, -5, 5, 10, 15]) {
    const y = (-deg * height) / 55;
    const half = Math.abs(deg) === 5 ? 46 : 66;
    context.beginPath();
    if (deg > 0) {
      context.moveTo(-half, y); context.lineTo(-14, y);
      context.moveTo(14, y); context.lineTo(half, y);
    } else {
      context.moveTo(-half, y); context.lineTo(-14, y); context.lineTo(-14, y + 8);
      context.moveTo(half, y); context.lineTo(14, y); context.lineTo(14, y + 8);
    }
    context.stroke();
    context.font = '800 16px ' + MONO;
    context.textAlign = 'right';
    context.fillText(String(Math.abs(deg)), -half - 6, y);
    context.textAlign = 'left';
    context.fillText(String(Math.abs(deg)), half + 6, y);
  }
  // Horizon line.
  context.lineWidth = 3.5;
  context.beginPath();
  context.moveTo(-120, 0); context.lineTo(-22, 0);
  context.moveTo(22, 0); context.lineTo(120, 0);
  context.stroke();
  context.restore();

  // Flight-path marker (velocity vector, offset by pitch/roll).
  const fpmX = cx + clamp(-state.rollDeg, -30, 30) * 1.2;
  const fpmY = cy + clamp(-state.verticalSpeed * 4 - state.pitchDeg * 1.5, -60, 60);
  context.lineWidth = 3;
  context.beginPath();
  context.arc(fpmX, fpmY, 13, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.moveTo(fpmX - 13, fpmY); context.lineTo(fpmX - 26, fpmY);
  context.moveTo(fpmX + 13, fpmY); context.lineTo(fpmX + 26, fpmY);
  context.moveTo(fpmX, fpmY - 13); context.lineTo(fpmX, fpmY - 22);
  context.stroke();
  // Fixed aircraft reference (waterline).
  context.beginPath();
  context.moveTo(cx - 34, cy); context.lineTo(cx - 12, cy); context.lineTo(cx - 12, cy + 7);
  context.moveTo(cx + 34, cy); context.lineTo(cx + 12, cy); context.lineTo(cx + 12, cy + 7);
  context.stroke();
  context.fillRect(cx - 2.5, cy - 2.5, 5, 5);

  // Speed / altitude boxes + heading.
  context.font = '800 24px ' + MONO;
  context.textAlign = 'center';
  context.strokeRect(14, cy - 20, 86, 40);
  context.fillText(String(Math.round(state.airspeed)), 57, cy + 1);
  context.font = '800 13px ' + FONT;
  context.fillText('SPD', 57, cy - 32);
  context.font = '800 24px ' + MONO;
  context.strokeRect(width - 100, cy - 20, 86, 40);
  context.fillText(String(Math.round(state.altitudeMsl)), width - 57, cy + 1);
  context.font = '800 13px ' + FONT;
  context.fillText('ALT M', width - 57, cy - 32);
  context.font = '800 20px ' + MONO;
  context.fillText(String(Math.round(state.headingDeg) % 360).padStart(3, '0') + '°', cx, 24);
  context.beginPath();
  context.moveTo(cx - 60, 40); context.lineTo(cx + 60, 40);
  context.stroke();
  context.beginPath();
  context.moveTo(cx, 40); context.lineTo(cx - 6, 30); context.lineTo(cx + 6, 30);
  context.closePath();
  context.fill();
}

// ---------------------------------------------------------------- build

function buildScreenUnit(widthM, heightM, canvas, drawFn, options = {}) {
  const texture = canvasTexture(canvas);
  const material = options.hud
    ? new THREE.MeshBasicMaterial({
      map: texture, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    })
    : new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), material);
  const unit = { canvas, context: canvas.getContext('2d'), texture, drawFn, mesh };
  return unit;
}

// Dark bezel + soft-key buttons + knobs as one merged geometry.
// All three panel MFD bezels are baked into a single mesh (draw budget).
function buildMfdBezelGeometry(widthM, heightM) {
  const parts = [];
  parts.push(box(widthM + 0.03, heightM + 0.03, 0.024, 0, 0, -0.008));
  // Soft keys down both sides (reference MFD button columns).
  const keysPerSide = 5;
  for (let i = 0; i < keysPerSide; i += 1) {
    const y = -heightM / 2 + 0.02 + (i * (heightM - 0.04)) / (keysPerSide - 1);
    parts.push(box(0.012, 0.016, 0.01, -widthM / 2 - 0.008, y, 0.006));
    parts.push(box(0.012, 0.016, 0.01, widthM / 2 + 0.008, y, 0.006));
  }
  // Bottom knob pair.
  for (const side of [-1, 1]) {
    const knob = new THREE.CylinderGeometry(0.011, 0.011, 0.014, 12);
    knob.rotateX(Math.PI / 2);
    knob.translate(side * (widthM / 2 - 0.02), -heightM / 2 - 0.004, 0.008);
    parts.push(knob);
  }
  return mergeGeometries(parts);
}

function labelTexture(lines, width = 512, height = 128) {
  const canvas = makeCanvas(width, height);
  if (!canvas) return null;
  const context = canvas.getContext('2d');
  context.fillStyle = '#262c34'; // m5: lighter plate, text pops at distance
  context.fillRect(0, 0, width, height);
  // VD6-COCKMAT: panel grain + row divider rules + corner screws so
  // overhead/console placards read as printed metal plates, crisp
  // at panel-crop distance. Text content/positions unchanged.
  let seed = 31415;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 700; i += 1) {
    context.fillStyle = random() > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.05)';
    context.fillRect(random() * width, random() * height, 1.4, 1.4);
  }
  const lineH = height / (lines.length + 0.5);
  context.strokeStyle = 'rgba(255,217,160,0.16)';
  context.lineWidth = 1;
  for (let i = 1; i < lines.length; i += 1) {
    const y = lineH * (i + 0.25);
    context.beginPath(); context.moveTo(10, y); context.lineTo(width - 10, y); context.stroke();
  }
  context.fillStyle = 'rgba(138,143,148,0.8)';
  for (const [sx, sy] of [[8, 8], [width - 8, 8], [8, height - 8], [width - 8, height - 8]]) {
    context.beginPath();
    context.arc(sx, sy, 3, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = '#ffe9bd'; // m5: brighter placard ink
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  lines.forEach((line, i) => {
    context.font = '800 ' + Math.round(lineH * 0.5) + 'px ' + FONT;
    context.save();
    context.fillStyle = 'rgba(0,0,0,0.4)';
    context.fillText(line, width / 2, lineH * (i + 0.75) + 1.5);
    context.restore();
    context.fillStyle = '#ffe9bd'; // m5
    context.fillText(line, width / 2, lineH * (i + 0.75));
  });
  return canvasTexture(canvas);
}

export function buildGlassCockpit() {
  const panelGroup = new THREE.Group();
  panelGroup.name = 'glass-panel-items';
  const cockpitGroup = new THREE.Group();
  cockpitGroup.name = 'glass-cockpit-items';

  // VD6-COCKMAT: matte worn bezels/panels with roughness variation,
  // polished metal toggles/rivets, bakelite console knobs (warm resin,
  // low metalness) distinct from the metal switchgear.
  const bezelWear = bezelWearTexture();
  const panelGrain = panelGrainTexture();
  const bezelDarkMaterial = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.52, metalness: 0.38, envMapIntensity: 0.9 }); // MATFIX: crisper anodised edge read at pilot distance
  if (bezelWear) {
    bezelDarkMaterial.roughnessMap = bezelWear;
    bezelDarkMaterial.bumpMap = bezelWear;
    bezelDarkMaterial.bumpScale = 0.025; // MATFIX: wear relief reads under flood light
  }
  const panelDarkMaterial = new THREE.MeshStandardMaterial({ color: 0x1c2026, roughness: 0.9, metalness: 0.02, envMapIntensity: 0.35 });
  if (panelGrain) {
    panelDarkMaterial.roughnessMap = panelGrain;
    panelDarkMaterial.bumpMap = panelGrain;
    panelDarkMaterial.bumpScale = 0.035; // MATFIX: grain relief so consoles/overhead aren't flat slabs
  }
  const materials = {
    bezelDark: bezelDarkMaterial,
    panelDark: panelDarkMaterial,
    panelEdge: new THREE.MeshStandardMaterial({ color: 0x232a33, roughness: 0.78, metalness: 0.06 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.28, metalness: 0.82 }),
    frameDark: new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.55, metalness: 0.55 }),
    switchMetal: new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.28, metalness: 0.85 }),
    knobDark: new THREE.MeshStandardMaterial({ color: 0x1e1a17, roughness: 0.48, metalness: 0.06 }),
    hudGlass: new THREE.MeshStandardMaterial({
      color: 0x9fd8ff, transparent: true, opacity: 0.06, roughness: 0.03,
      metalness: 0.12, depthWrite: false, side: THREE.DoubleSide,
    }),
  };

  // ---- EXACT-TARGET (E2): faceted GREY fascia over the panel board ----
  // cockpit-target-exact.jpg: flat-shaded low-poly grey panel with
  // chamfered top corners (dark board wedges show at the corners,
  // like the target) — replaces the black carbon slab. One
  // ShapeGeometry at z = 0.038, just proud of the board front face
  // (0.035); gauges and the avionics stack emerge through it like
  // instruments mounted in the panel. Top edge y = 0.265 stays below
  // the glareshield brow (0.285) and the panel edge strip (front
  // z 0.0375, y from 0.2675) — no z-fighting.
  {
    const facetTex = facetGreyTexture();
    const fasciaMaterial = facetTex
      ? new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: facetTex, bumpMap: facetTex, bumpScale: 0.015,
        roughness: 0.82, metalness: 0.08, envMapIntensity: 0.5,
        polygonOffset: true, polygonOffsetFactor: -1,
      })
      : materials.panelDark;
    const hw = 0.74; // half width (board is 0.75)
    const yTop = 0.265;
    const yBot = -0.27;
    const rBot = 0.02;
    const shape = new THREE.Shape();
    shape.moveTo(-hw + rBot, yBot);
    shape.lineTo(hw - rBot, yBot);
    shape.quadraticCurveTo(hw, yBot, hw, yBot + rBot);
    // Chamfered top corners (target silhouette), not rounded.
    shape.lineTo(hw, yTop - 0.10);
    shape.lineTo(hw - 0.12, yTop);
    shape.lineTo(-hw + 0.12, yTop);
    shape.lineTo(-hw, yTop - 0.10);
    shape.lineTo(-hw, yBot + rBot);
    shape.quadraticCurveTo(-hw, yBot, -hw + rBot, yBot);
    const fascia = new THREE.Mesh(new THREE.ShapeGeometry(shape, 6), fasciaMaterial);
    fascia.name = 'faceted-panel-fascia';
    fascia.position.z = 0.038;
    panelGroup.add(fascia);
    // EXACT-TARGET (E2): left-cheek facet relief — the target's left
    // cheek is bare low-poly grey (no gauges). Twelve flat-shaded
    // triangles in three grey tones sit 1-2 mm proud of the fascia
    // (z ~0.0392) so the panel light rakes across them. Bounds keep
    // clear of the PFD bezel (left edge -0.495), the toggle row
    // (top y -0.182) and the left placard (top y -0.196); the edge
    // knob (-0.71, 0.2) and detail side screws (x -0.725) sit in
    // front of the facets like fittings mounted on the cheek.
    {
      const cheekPts = {
        A: [-0.735, 0.24], B: [-0.62, 0.245], C: [-0.51, 0.235],
        D: [-0.735, 0.10], E: [-0.63, 0.12], F: [-0.515, 0.09],
        G: [-0.735, -0.03], H: [-0.64, -0.01], I: [-0.52, -0.04],
        J: [-0.735, -0.145], K: [-0.63, -0.135], L: [-0.515, -0.145],
      };
      const cheekTris = [
        ['A', 'B', 'E', 0], ['A', 'E', 'D', 1], ['B', 'C', 'F', 1], ['B', 'F', 'E', 2],
        ['D', 'E', 'H', 2], ['D', 'H', 'G', 0], ['E', 'F', 'I', 0], ['E', 'I', 'H', 1],
        ['G', 'H', 'K', 1], ['G', 'K', 'J', 2], ['H', 'I', 'L', 2], ['H', 'L', 'K', 0],
      ];
      const cheekTones = [0x767d87, 0x626873, 0x51565f];
      const cheekByTone = [[], [], []];
      cheekTris.forEach(([p1, p2, p3, tone], triIndex) => {
        const positions = new Float32Array(9);
        const uvs = new Float32Array(6);
        [p1, p2, p3].forEach((key, vi) => {
          const [px, py] = cheekPts[key];
          positions[vi * 3] = px;
          positions[vi * 3 + 1] = py;
          positions[vi * 3 + 2] = 0.0392 + ((triIndex + vi) % 3) * 0.0006;
        });
        const tri = new THREE.BufferGeometry();
        tri.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        tri.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        tri.computeVertexNormals();
        cheekByTone[tone].push(tri);
      });
      cheekByTone.forEach((tris, tone) => {
        if (!tris.length) return;
        const cheek = new THREE.Mesh(
          mergeGeometries(tris),
          new THREE.MeshStandardMaterial({
            color: cheekTones[tone], roughness: 0.85, metalness: 0.05, flatShading: true,
          }),
        );
        cheek.name = 'left-cheek-facets-' + tone;
        panelGroup.add(cheek);
      });
    }
    // Angled brow roll along the fascia top edge (geometry kept from
    // PANEL-FIX2/B3; recoloured EXACT-TARGET dark slate — the target
    // shows a thin dark strip under the glareshield lip). Top edge
    // stays at y ~0.28 (below the 0.285 brow), so the runway sight
    // line is untouched.
    const brow = new THREE.Mesh(
      new THREE.BoxGeometry(1.46, 0.075, 0.006),
      new THREE.MeshStandardMaterial({
        color: 0x2e3238, roughness: 0.6, metalness: 0.3, envMapIntensity: 0.6,
      }),
    );
    brow.name = 'panel-brow-roll';
    brow.position.set(0, 0.252, 0.056);
    brow.rotation.x = -0.7;
    panelGroup.add(brow);
  }

  const units = [];
  const bezelGeometries = [];
  const addPanelScreen = (canvas, drawFn, w, h, x, y, z, rotX) => {
    if (!canvas) return;
    const bezelGeo = buildMfdBezelGeometry(w, h);
    if (rotX) bezelGeo.rotateX(rotX);
    bezelGeo.translate(x, y, z);
    bezelGeometries.push(bezelGeo);
    const unit = buildScreenUnit(w, h, canvas, drawFn);
    unit.mesh.position.set(x, y, z);
    unit.mesh.rotation.x = rotX;
    unit.mesh.translateZ(0.006);
    panelGroup.add(unit.mesh);
    units.push(unit);
  };

  // ---- SLING-PANEL: three live displays IN the panel face ----
  // Reference order left -> right: large PFD, centre map display,
  // smaller engine display, cluster centred on x = 0 for the single
  // centre seat. All three sit at z = 0.080 (bezel box spans
  // 0.060..0.084, screen plane 0.086) so they clear the round-gauge
  // glass (0.073) they overlap. Nothing rides the glareshield any
  // more: the tallest bezel top is y = 0.185, well under the brow
  // (0.285), so the runway view over the panel is unobstructed.
  //
  // PFD (large, left-of-centre): covers the round attitude (-0.33,
  // 0.08) + heading (-0.33, -0.095) gauges — both duplicated on the
  // PFD page (attitude ball + HDG strip). Bezel x -0.495..-0.145
  // clears airspeed (right edge -0.535) and altimeter (left -0.125);
  // bezel y -0.175..0.175 covers attitude top (0.165) and clears the
  // warning-light row (bottom 0.196) and maker placard (top -0.185).
  addPanelScreen(makeCanvas(512, 512), drawPfdPage, 0.32, 0.32, -0.32, 0.0, 0.08, 0);

  // Centre NAV (portrait moving map + radar rings, like the
  // reference centre display): covers the round altimeter (-0.04,
  // 0.08) + VSI (-0.04, -0.095) — both duplicated on the PFD tapes.
  // Bezel x -0.135..0.065 clears the PFD bezel (-0.145) and the
  // avionics stack (left edge 0.073, stays visible); bezel y
  // -0.185..0.185 covers altimeter top (0.165) + VSI bottom (-0.18).
  addPanelScreen(makeCanvas(320, 640), drawNavPage, 0.17, 0.34, -0.035, 0.0, 0.08, 0);

  // Engine display (smaller, right bay): bezel x 0.42..0.71 clears
  // the small tach/fuel/flap gauges (rim outer right edge 0.4162,
  // stay visible); bezel y -0.015..0.175 clears the checklist card
  // (top -0.0225 after OVERLAP-FIX2 lowered it in aircraft.js).
  // OVERLAP-FIX2 (Specialist 10): centre x 0.56 -> 0.565 — at 0.56
  // the bezel left edge (0.415) grazed the tach/fuel rim torus
  // (outer r 0.0662, right edge 0.4162) by 1.2 mm in the bezel's
  // z span; at 0.565 the gap is 3.8 mm.
  addPanelScreen(makeCanvas(512, 320), drawEnginePage, 0.26, 0.16, 0.565, 0.08, 0.08, 0);

  if (bezelGeometries.length) {
    panelGroup.add(new THREE.Mesh(mergeGeometries(bezelGeometries), materials.bezelDark));
  }

  // ---- EXACT-TARGET: coloured toggle row + breakers under displays ----
  // cockpit-target-exact.jpg: ONE hero row of 7 chunky vivid toggles
  // (RED / WHITE / GREEN / BLUE / GREEN / WHITE / RED) under the
  // centre displays, plus 3 white toggles right of the red guarded
  // switch (cockpit-detail.js ELT switch) left of the checklist.
  // No full-width silver row, no dot row above the switches in the
  // target — the previous 32-toggle row + green/amber dot row
  // (Specialist 12, old target) is replaced by this layout.
  // Hero row y = -0.204: bat tops (-0.191) clear the NAV bezel
  // bottom (-0.185); last bat (x 0.29) clears the flap gauge rim
  // (centre (0.35,-0.13), outer r 0.0662) by ~16 mm centre distance.
  // Vivid flat material (basic, toneMapped off) so instance colours
  // read pure red/green/blue/white at 768 px like the target.
  {
    const toggleGeo = new THREE.CylinderGeometry(0.008, 0.0095, 0.036, 8);
    toggleGeo.rotateX(Math.PI / 2);
    toggleGeo.translate(0, 0, 0.02);
    const heroColours = [0xff2a1e, 0xf5f7fa, 0x22e04a, 0x2266ff, 0x22e04a, 0xf5f7fa, 0xff2a1e];
    const heroToggles = heroColours.map((hex, i) => ({
      x: 0.02 + i * 0.045, hex, scale: [1.35, 1.35, 1.15], tilt: i % 2 === 0 ? 0.3 : -0.3,
    }));
    const rightToggles = [0.44, 0.475, 0.51].map((x, i) => ({
      x, hex: 0xf5f7fa, scale: [1.2, 1.2, 1.1], tilt: i % 2 === 0 ? -0.3 : 0.3,
    }));
    const allToggles = [...heroToggles, ...rightToggles];
    const toggleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const toggles = new THREE.InstancedMesh(toggleGeo, toggleMat, allToggles.length);
    toggles.name = 'panel-coloured-toggles';
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    allToggles.forEach((t, i) => {
      dummy.position.set(t.x, -0.204, 0.038);
      dummy.rotation.set(t.tilt, 0, 0);
      dummy.scale.set(t.scale[0], t.scale[1], t.scale[2]);
      dummy.updateMatrix();
      toggles.setMatrixAt(i, dummy.matrix);
      tint.setHex(t.hex);
      toggles.setColorAt(i, tint);
    });
    toggles.instanceMatrix.needsUpdate = true;
    if (toggles.instanceColor) toggles.instanceColor.needsUpdate = true;
    panelGroup.add(toggles);
    // Circuit breakers: squashed metal instances along y = -0.255
    // (unchanged from the previous build; subtle bottom row).
    const breakerCount = 41;
    const breakers = new THREE.InstancedMesh(toggleGeo, materials.switchMetal, breakerCount);
    breakers.name = 'panel-breakers';
    for (let i = 0; i < breakerCount; i += 1) {
      dummy.position.set(-0.68 + i * 0.034, -0.255, 0.038);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1.6, 1.6, 0.4);
      dummy.updateMatrix();
      breakers.setMatrixAt(i, dummy.matrix);
      tint.setHex(0xd8dce2);
      breakers.setColorAt(i, tint);
    }
    breakers.instanceMatrix.needsUpdate = true;
    if (breakers.instanceColor) breakers.instanceColor.needsUpdate = true;
    panelGroup.add(breakers);
    // Light placard strip behind the toggle row only (hero span
    // x -0.025..0.555) + full-width breaker strip. Sits on the
    // fascia (z 0.039), behind the bats (tips z ~0.082).
    const stripMat = new THREE.MeshStandardMaterial({
      color: 0xb8bec6, roughness: 0.55, metalness: 0.25,
    });
    const strips = new THREE.Mesh(mergeGeometries([
      box(0.58, 0.034, 0.002, 0.265, -0.204, 0.039),
      box(1.42, 0.028, 0.002, 0, -0.255, 0.039),
    ]), stripMat);
    strips.name = 'switch-row-placard-strips';
    panelGroup.add(strips);
    // Tiny indicator lights: one 6 mm lit dot just above each hero /
    // right toggle (y -0.187, z 0.042), coloured like its switch
    // (white switches get a green lamp). Replaces the old full-width
    // dot row at y -0.172, which the exact target does not show;
    // these read as the target's small switch lights without
    // competing with the coloured row. Dots sit behind the NAV
    // bezel plane (z 0.060..) so nothing intersects the displays.
    const dotGeo = new THREE.BoxGeometry(0.006, 0.006, 0.003);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const dots = new THREE.InstancedMesh(dotGeo, dotMat, allToggles.length);
    dots.name = 'switch-indicator-lights';
    allToggles.forEach((t, i) => {
      dummy.position.set(t.x, -0.187, 0.042);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      dots.setMatrixAt(i, dummy.matrix);
      tint.setHex(t.hex === 0xf5f7fa ? 0x39ff6a : t.hex);
      dots.setColorAt(i, tint);
    });
    dots.instanceMatrix.needsUpdate = true;
    if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
    panelGroup.add(dots);
  }

  // ---- SLING-PANEL: knobs at the panel left/right edges ----
  // Big pair flanking the toggle row (like the reference corner
  // knobs) + small pair up top; one merged mesh, bakelite material.
  {
    const knobParts = [];
    const addKnob = (radius, depth, x, y, z) => {
      const knob = new THREE.CylinderGeometry(radius, radius * 1.08, depth, 14);
      knob.rotateX(Math.PI / 2);
      knob.translate(x, y, z);
      knobParts.push(knob);
      const cap = new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, 0.005, 12);
      cap.rotateX(Math.PI / 2);
      cap.translate(x, y, z + depth / 2 + 0.002);
      knobParts.push(cap);
    };
    addKnob(0.019, 0.022, -0.71, -0.198, 0.049);
    addKnob(0.019, 0.022, 0.71, -0.198, 0.049);
    addKnob(0.012, 0.016, -0.71, 0.2, 0.046);
    addKnob(0.012, 0.016, 0.71, 0.2, 0.046);
    const edgeKnobs = new THREE.Mesh(mergeGeometries(knobParts), materials.knobDark);
    edgeKnobs.name = 'panel-edge-knobs';
    panelGroup.add(edgeKnobs);
  }

  // ---- SLING-PANEL: placards (one canvas, two UV-halved planes) ----
  // Right placard under the engine display / checklist, left placard
  // under the turn coordinator; both clear of the toggle row
  // (bottom -0.2075) and breaker row (top -0.2398: squashed
  // instances, r 0.0095 x scale 1.6 — OVERLAP-FIX2 corrected the
  // earlier -0.249 figure, which understated the breaker radius).
  {
    const placardTex = labelTexture(
      ['CB — PULL TO RESET · AURORA POST AP-01', 'LIGHTS · PITOT HEAT'],
      640, 128,
    );
    if (placardTex) {
      const mkPlacard = (w, h, x, y, vOffset) => {
        const g = new THREE.PlaneGeometry(w, h);
        const uv = g.attributes.uv;
        for (let i = 0; i < uv.count; i += 1) uv.setY(i, vOffset + uv.getY(i) * 0.5);
        // OVERLAP-FIX2 (Specialist 10): z 0.0395 -> 0.041 so the
        // placard text sits 1 mm proud of the switch-row placard
        // strips (front face z 0.040) instead of behind them.
        g.translate(x, y, 0.041);
        return g;
      };
      const placards = new THREE.Mesh(
        mergeGeometries([
          // m5: taller placards so the text survives the 768 shrink.
          // OVERLAP-FIX2: right y -0.228 -> -0.214 (bottom -0.237
          // clears the breaker tops -0.2398; was -0.251, crossing
          // them by 11 mm), left y -0.222 -> -0.216 (bottom -0.236;
          // was -0.242, grazing by 2 mm).
          mkPlacard(0.38, 0.046, 0.47, -0.214, 0.5),
          mkPlacard(0.19, 0.04, -0.61, -0.216, 0),
        ]),
        new THREE.MeshStandardMaterial({ color: 0xffffff, map: placardTex, roughness: 0.8, metalness: 0.05 }),
      );
      placards.name = 'panel-placards';
      panelGroup.add(placards);
    }
  }

  // ---- HUD combiner glass in front of the pilot (cockpit space) ----
  // Compact + far enough forward that it never blocks the runway/ring
  // over the glareshield (VD6-GLASS composition rule). Symbology plane
  // only — additive green reads as combiner glass without a pane mesh.
  const hudCanvas = makeCanvas(512, 384);
  if (hudCanvas) {
    const holder = new THREE.Group();
    // VD6-VISIBILITY: combiner compacted (0.22x0.17 -> 0.20x0.155) and
    // raised with the new eye point (y 0.80 -> 0.85) so symbology stays
    // centred on the sight line while the pane blocks less sky.
    holder.position.set(-0.32, 0.85, -0.58);
    holder.rotation.x = -0.06;
    const unit = buildScreenUnit(0.20, 0.155, hudCanvas, drawHudSymbology, { hud: true });
    unit.mesh.position.z = 0.002;
    holder.add(unit.mesh);
    // Frame: top/bottom/side rails + mounting arm down to the glareshield.
    const frame = new THREE.Mesh(mergeGeometries([
      box(0.22, 0.011, 0.01, 0, 0.0835, 0),
      box(0.22, 0.011, 0.01, 0, -0.0835, 0),
      box(0.01, 0.178, 0.01, -0.107, 0, 0),
      box(0.01, 0.178, 0.01, 0.107, 0, 0),
      box(0.022, 0.24, 0.022, 0, -0.21, 0.05, 0.5, 0, 0),
      box(0.08, 0.024, 0.07, 0, -0.33, 0.1),
    ]), materials.frameDark);
    holder.add(frame);
    // User order 2026-11-27: HUD combiner (سربالا) removed from the
    // cockpit — holder never added, unit never updated.
    void holder;
    void unit;
  }

  // ---- Overhead switch panel (cockpit space, above the windscreen) ----
  // VD6-VISIBILITY: moved UP, BACK and NARROWER (was (0, 1.07, -0.52)
  // tilt 0.72, 0.92x0.34 — a wide slab dead in the forward cone). Now
  // (0, 1.05, -0.34) tilt 0.85, 0.72x0.26: lower edge ~1.8° above the
  // eye line (upper frame, clear of the horizon/runway sector) while
  // staying under the roof ceiling sight line (~8°, roof front edge
  // eased back in aircraft.js) so two toggle rows + breakers + labels
  // stay readable; top row tucks behind the header like the reference.
  {
    const holder = new THREE.Group();
    holder.position.set(0, 1.34, 0.06); // user order 2026-11-27: up+back again after eye lowered — fully out of the forward sight cone
    holder.rotation.x = 1.15;
    const faceTex = labelTexture(
      ['BAT   ALT   IGN   FUEL PUMP', 'LAND  TAXI  NAV   STROBE   BEACON', 'PITOT HEAT   CABIN HEAT   AVIONICS'],
      640, 224,
    );
    // Plain box + separate label face plane (a 6-material box costs
    // 6 draw calls; this costs 2).
    const panelBox = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.26, 0.04), materials.panelDark);
    holder.add(panelBox);
    if (faceTex) {
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(0.70, 0.24),
        new THREE.MeshStandardMaterial({ color: 0xffffff, map: faceTex, roughness: 0.88, metalness: 0.02 }), // VD6-COCKMAT: matte placard plate
      );
      face.position.z = 0.021;
      holder.add(face);
    }
    // Toggle switches + circuit breakers: one InstancedMesh
    // (3 rows x 8 toggles, breakers as squashed instances on row 4).
    const toggleGeo = new THREE.CylinderGeometry(0.005, 0.0065, 0.026, 8);
    toggleGeo.rotateX(Math.PI / 2);
    toggleGeo.translate(0, 0, 0.016);
    const toggles = new THREE.InstancedMesh(toggleGeo, materials.switchMetal, 34);
    const dummy = new THREE.Object3D();
    let ti = 0;
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        dummy.position.set(-0.30 + col * 0.086, 0.07 - row * 0.07, 0.02);
        dummy.rotation.set((row + col) % 3 === 0 ? -0.35 : 0.3, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        toggles.setMatrixAt(ti, dummy.matrix);
        ti += 1;
      }
    }
    for (let i = 0; i < 10; i += 1) {
      dummy.position.set(-0.31 + i * 0.069, -0.10, 0.02);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1.2, 1.2, 0.35);
      dummy.updateMatrix();
      toggles.setMatrixAt(ti, dummy.matrix);
      ti += 1;
    }
    toggles.instanceMatrix.needsUpdate = true;
    holder.add(toggles);
    cockpitGroup.add(holder);
  }

  // ---- Side consoles (cockpit space) ----
  {
    const consoleParts = [];
    const knobSpots = [];
    for (const side of [-1, 1]) {
      const cxS = side * 0.60;
      consoleParts.push(box(0.24, 0.2, 0.72, cxS, -0.42, -0.02));
      consoleParts.push(box(0.26, 0.03, 0.74, cxS, -0.305, -0.02));
      for (let i = 0; i < 4; i += 1) {
        knobSpots.push([cxS + side * 0.05, -0.28, -0.28 + i * 0.16]);
        knobSpots.push([cxS - side * 0.05, -0.28, -0.2 + i * 0.16]);
      }
    }
    cockpitGroup.add(new THREE.Mesh(mergeGeometries(consoleParts), materials.panelDark));
    // Console top labels: one canvas (both strings), two UV-halved
    // planes merged into a single mesh / draw call.
    const labelTex = labelTexture(['THROTTLE · PROP · MIX', 'TRIM · FLAP · LIGHTS'], 512, 128);
    if (labelTex) {
      const mkLabel = (x, vOffset) => {
        const g = new THREE.PlaneGeometry(0.2, 0.025);
        const uv = g.attributes.uv;
        for (let i = 0; i < uv.count; i += 1) uv.setY(i, vOffset + uv.getY(i) * 0.5);
        g.rotateX(-Math.PI / 2);
        g.translate(x, -0.288, 0.26);
        return g;
      };
      const labels = new THREE.Mesh(
        mergeGeometries([mkLabel(-0.60, 0.5), mkLabel(0.60, 0)]),
        new THREE.MeshStandardMaterial({ color: 0xffffff, map: labelTex, roughness: 0.78, metalness: 0.02 }), // VD6-COCKMAT: matte placard plate
      );
      cockpitGroup.add(labels);
    }
    // Knobs: one InstancedMesh for both consoles.
    const knobGeo = new THREE.CylinderGeometry(0.014, 0.016, 0.02, 10);
    const knobs = new THREE.InstancedMesh(knobGeo, materials.knobDark, knobSpots.length);
    const dummy = new THREE.Object3D();
    knobSpots.forEach(([x, y, z], i) => {
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, i * 0.7, 0);
      dummy.updateMatrix();
      knobs.setMatrixAt(i, dummy.matrix);
    });
    knobs.instanceMatrix.needsUpdate = true;
    cockpitGroup.add(knobs);
  }

  // ---- Windscreen frame: REMOVED (frame/visibility fix) ----
  // The old riveted frame that hugged the windshield glass at
  // (0, 0.78, -1.02) doubled the slim shell frame in aircraft.js
  // (A-pillars + header rail at nearly the same stations), reading as
  // one thick trapezoid with a heavy top bar and a centre post on the
  // pilot's sight line. The reference has ONE huge wraparound pane
  // framed only by slim pale shell pillars/header, so the riveted
  // bars + rivets are deleted here; aircraft.js owns the only frame.
  // Glass/MFD/panel code above is untouched.

  panelGroup.traverse((object) => { if (object.isMesh) object.castShadow = false; });
  cockpitGroup.traverse((object) => { if (object.isMesh) object.castShadow = false; });

  // -------------------------------------------------------------- update
  const drawState = {
    x: 0, z: 0, headingDeg: 0, pitchDeg: 0, rollDeg: 0, airspeed: 0,
    groundSpeed: 0, altitudeMsl: 0, altitudeAgl: 0, verticalSpeed: 0,
    throttle: 0, fuel: 1, damage: 0, flaps: 0, rpm: 0,
    engineOn: false, stalled: false, onGround: true, clock: '06:12',
  };
  let lastDraw = -Infinity;

  function update(plane, timeSeconds) {
    if (!plane || !plane.position) return;
    const t = typeof timeSeconds === 'number' ? timeSeconds : 0;
    if (t - lastDraw < REDRAW_SECONDS && t >= lastDraw) return;
    lastDraw = t;
    drawState.x = plane.position.x;
    drawState.z = plane.position.z;
    drawState.headingDeg = num(plane.headingDeg, 0);
    drawState.pitchDeg = num(plane.pitchDeg, 0);
    drawState.rollDeg = num(plane.rollDeg, 0);
    drawState.airspeed = num(plane.airspeed, plane.velocity ? plane.velocity.length() : 0);
    drawState.groundSpeed = num(plane.groundSpeed, drawState.airspeed);
    drawState.altitudeMsl = num(plane.altitudeMsl, plane.position.y);
    drawState.altitudeAgl = num(plane.altitudeAgl, drawState.altitudeMsl);
    drawState.verticalSpeed = num(plane.verticalSpeed, plane.velocity ? plane.velocity.y : 0);
    drawState.throttle = clamp(num(plane.throttle, 0), 0, 1);
    drawState.fuel = clamp(num(plane.fuel, 1), 0, 1);
    drawState.damage = clamp(num(plane.damage, 0), 0, 1);
    drawState.flaps = clamp(Math.round(num(plane.flaps, num(plane.flapStage, 0))), 0, 2);
    drawState.engineOn = typeof plane.engineOn === 'boolean'
      ? plane.engineOn
      : drawState.fuel > 0 && drawState.damage < 1;
    drawState.rpm = drawState.engineOn ? 600 + drawState.throttle * 2100 : 0;
    drawState.stalled = plane.stalled === true;
    drawState.onGround = plane.onGround === true;
    const minutes = 6 * 60 + 12 + Math.floor(t / 60);
    drawState.clock = String(Math.floor(minutes / 60) % 24).padStart(2, '0')
      + ':' + String(minutes % 60).padStart(2, '0');
    for (const unit of units) {
      unit.drawFn(unit.context, unit.canvas.width, unit.canvas.height, drawState);
      unit.texture.needsUpdate = true;
    }
  }

  update({ position: { x: 0, z: 0, y: 0 }, headingDeg: 90, engineOn: false }, 0);
  return { panelGroup, cockpitGroup, update };
}
