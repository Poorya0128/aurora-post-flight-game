// holo-map.js — holographic map + radar for AURORA POST menus/HUD.
// Display only: reads real geography (config ISLANDS/STRIPS, world
// heightAt) and real sortie routes (missions MISSIONS/MISSION_ROUTES),
// never changes any of them. Canvas 2D, procedural, offline.
//
// Exports:
//   drawHoloMap(canvas, missionLike, options) -> { draw(timeMs), stop() }
//     Isometric holographic archipelago: wireframe heightfields with
//     contour lines over a cyan grid floor, raised route arcs with
//     animated dashes, numbered pulsing pins, real name labels,
//     compass ticks, scanline sweep. Draws one frame immediately and
//     returns a controller; call draw(timeMs) per frame to animate,
//     or pass { animate: true } to run its own rAF loop (stop() ends it).
//     options: { timeMs, animate, compact, showLabels, heightScale }
//   drawRadar(canvas, state, timeMs)
//     Circular radar: range rings, degree ticks + labels, rotating
//     sweep with fading trail, terrain blobs, strip/island blips that
//     flare as the sweep passes, centre aircraft marker.
//     state: { plane: {x, z} | {position:{x,z}}, headingDeg, range,
//              northUp (default true), target: {x, z, label},
//              missionLike } — every field optional; without a plane
//              the radar centres on Aurora Field.

import { ISLANDS, STRIPS } from './config.js';
import { heightAt } from './world.js';
import { MISSIONS, MISSION_ROUTES } from './missions.js';

const FONT = 'AuroraSans, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

const C = {
  bgDeep: '#030d18',
  bgMid: '#062036',
  cyan: '#22d3ee',
  cyanBright: '#a5f3fc',
  cyanDim: 'rgba(34,211,238,0.35)',
  cyanFaint: 'rgba(34,211,238,0.14)',
  green: '#7dffb2',
  amber: '#ffd166',
  orange: '#ff9e64',
  red: '#ff6b5e',
  cream: '#f2ede4',
  ink: 'rgba(2,10,20,0.85)',
};

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

// Height -> hologram colour ramp (deep cyan shore -> cyan -> green ->
// amber summit), returned as [r, g, b].
function heightRgb(h, peak) {
  const t = clamp(h / Math.max(peak, 1), 0, 1);
  if (t < 0.45) {
    const k = t / 0.45;
    return [Math.round(lerp(14, 34, k)), Math.round(lerp(116, 211, k)), Math.round(lerp(144, 238, k))];
  }
  if (t < 0.75) {
    const k = (t - 0.45) / 0.3;
    return [Math.round(lerp(34, 125, k)), Math.round(lerp(211, 255, k)), Math.round(lerp(238, 178, k))];
  }
  const k = (t - 0.75) / 0.25;
  return [Math.round(lerp(125, 255, k)), Math.round(lerp(255, 209, k)), Math.round(lerp(178, 102, k))];
}
function rgba(rgb, a) { return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')'; }

// ------------------------------------------------------------------ data

function missionDefinition(missionLike) {
  if (!missionLike) return null;
  if (missionLike.type) return missionLike;
  const id = missionLike.id || missionLike;
  if (Array.isArray(MISSIONS)) {
    for (const def of MISSIONS) if (def.id === id) return def;
  }
  return null;
}

function stripById(stripId) {
  const wanted = String(stripId || '').toLowerCase();
  for (const strip of STRIPS) if (strip.id === wanted) return strip;
  return STRIPS[0];
}

function stripPos(strip) {
  const p = strip.position || strip.centre || { x: 0, z: 0 };
  return { x: p.x, z: p.z };
}

// Ordered route waypoints for a sortie, mirroring menu-art.js logic.
// Each: { x, z, label, kind: 'ring'|'drop'|'dest'|'target' }.
function routeWaypoints(definition) {
  const out = [];
  if (!definition || !MISSION_ROUTES) return out;
  if (definition.type === 'ring' && MISSION_ROUTES.rings) {
    const route = MISSION_ROUTES.rings[definition.tier] || [];
    route.forEach((wp, i) => out.push({ x: wp.x, z: wp.z, label: 'RING ' + (i + 1), kind: 'ring' }));
  } else if (definition.type === 'cargo' && MISSION_ROUTES.dropZones) {
    (definition.dropZoneKeys || []).forEach((key, i) => {
      const zone = MISSION_ROUTES.dropZones[key];
      if (zone) out.push({ x: zone.x, z: zone.z, label: (zone.name || 'DROP ' + (i + 1)).toUpperCase(), kind: 'drop' });
    });
  } else if (definition.type === 'delivery') {
    const dest = stripById(definition.destinationStripId);
    const p = stripPos(dest);
    out.push({ x: p.x, z: p.z, label: dest.name.toUpperCase(), kind: 'dest' });
  } else if (definition.type === 'precision') {
    const target = stripById(definition.targetStripId);
    const p = stripPos(target);
    out.push({ x: p.x, z: p.z, label: target.name.toUpperCase(), kind: 'target' });
  }
  return out;
}

// ------------------------------------------------------- terrain sampling
// Per-island height grids, sampled once from the real heightAt() and
// cached for the module lifetime (menus redraw the map every frame).

const GRID_N = 28; // vertices per side per island
const islandGrids = [];

function buildIslandGrids() {
  if (islandGrids.length) return islandGrids;
  for (const island of ISLANDS) {
    const reach = island.radius * 1.18;
    const step = (reach * 2) / (GRID_N - 1);
    const heights = new Float32Array(GRID_N * GRID_N);
    for (let j = 0; j < GRID_N; j++) {
      for (let i = 0; i < GRID_N; i++) {
        const x = island.centre.x - reach + i * step;
        const z = island.centre.z - reach + j * step;
        let h = -8;
        try { h = heightAt(x, z); } catch (e) { h = -8; }
        heights[j * GRID_N + i] = Number.isFinite(h) ? h : -8;
      }
    }
    islandGrids.push({ island, reach, step, heights });
  }
  return islandGrids;
}

// ------------------------------------------------------------ iso project

const WORLD_BOUNDS = { minX: -4300, maxX: 5300, minZ: -3100, maxZ: 4500 };

function makeIsoProjector(width, height, heightScale) {
  // Classic 2:1 isometric: screen = ((x - z) * cos30, (x + z) * sin30 - y).
  const cos = Math.cos(Math.PI / 6);
  const sin = Math.sin(Math.PI / 6);
  const corners = [
    [WORLD_BOUNDS.minX, WORLD_BOUNDS.minZ], [WORLD_BOUNDS.maxX, WORLD_BOUNDS.minZ],
    [WORLD_BOUNDS.minX, WORLD_BOUNDS.maxZ], [WORLD_BOUNDS.maxX, WORLD_BOUNDS.maxZ],
  ];
  let minSx = Infinity, maxSx = -Infinity, minSy = Infinity, maxSy = -Infinity;
  for (const [x, z] of corners) {
    const sx = (x - z) * cos;
    const sy = (x + z) * sin;
    if (sx < minSx) minSx = sx;
    if (sx > maxSx) maxSx = sx;
    if (sy < minSy) minSy = sy;
    if (sy > maxSy) maxSy = sy;
  }
  const pad = Math.min(width, height) * 0.07;
  const peakLift = 130 * heightScale; // tallest summit (Signal Hill 120 m)
  const scale = Math.min(
    (width - pad * 2) / (maxSx - minSx),
    (height - pad * 2) / (maxSy - minSy + peakLift),
  );
  const ox = (width - (maxSx - minSx) * scale) / 2 - minSx * scale;
  const oy = (height - (maxSy - minSy + peakLift) * scale) / 2 - minSy * scale + peakLift * scale;
  return {
    scale,
    project(x, y, z) {
      return [ox + (x - z) * cos * scale, oy + ((x + z) * sin - y * heightScale) * scale];
    },
  };
}

// ------------------------------------------------------------ holo pieces

function drawCornerBrackets(ctx, w, h, inset, len, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  const pts = [
    [inset, inset, 1, 1], [w - inset, inset, -1, 1],
    [inset, h - inset, 1, -1], [w - inset, h - inset, -1, -1],
  ];
  for (const [x, y, dx, dy] of pts) {
    ctx.beginPath();
    ctx.moveTo(x + dx * len, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * len);
    ctx.stroke();
  }
  ctx.restore();
}

function drawScanlines(ctx, w, h, timeMs) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.13)';
  for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
  // Travelling bright sweep band (additive).
  const period = 5200;
  const t = ((timeMs % period) + period) % period / period;
  const y = t * (h + 80) - 40;
  const grad = ctx.createLinearGradient(0, y - 34, 0, y + 34);
  grad.addColorStop(0, 'rgba(103,232,249,0)');
  grad.addColorStop(0.5, 'rgba(103,232,249,0.10)');
  grad.addColorStop(1, 'rgba(103,232,249,0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = grad;
  ctx.fillRect(0, y - 34, w, 68);
  ctx.restore();
}

function drawGridFloor(ctx, proj) {
  ctx.save();
  ctx.lineWidth = 1;
  const minor = 500, major = 1000;
  for (let x = Math.ceil(WORLD_BOUNDS.minX / minor) * minor; x <= WORLD_BOUNDS.maxX; x += minor) {
    const isMajor = ((x % major) + major) % major === 0;
    ctx.strokeStyle = isMajor ? 'rgba(34,211,238,0.20)' : 'rgba(34,211,238,0.07)';
    const a = proj.project(x, 0, WORLD_BOUNDS.minZ);
    const b = proj.project(x, 0, WORLD_BOUNDS.maxZ);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
  for (let z = Math.ceil(WORLD_BOUNDS.minZ / minor) * minor; z <= WORLD_BOUNDS.maxZ; z += minor) {
    const isMajor = ((z % major) + major) % major === 0;
    ctx.strokeStyle = isMajor ? 'rgba(34,211,238,0.20)' : 'rgba(34,211,238,0.07)';
    const a = proj.project(WORLD_BOUNDS.minX, 0, z);
    const b = proj.project(WORLD_BOUNDS.maxX, 0, z);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
  // Glowing border diamond + kilometre ticks.
  const c = [
    proj.project(WORLD_BOUNDS.minX, 0, WORLD_BOUNDS.minZ),
    proj.project(WORLD_BOUNDS.maxX, 0, WORLD_BOUNDS.minZ),
    proj.project(WORLD_BOUNDS.maxX, 0, WORLD_BOUNDS.maxZ),
    proj.project(WORLD_BOUNDS.minX, 0, WORLD_BOUNDS.maxZ),
  ];
  ctx.strokeStyle = 'rgba(103,232,249,0.55)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(c[0][0], c[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(c[i][0], c[i][1]);
  ctx.closePath(); ctx.stroke();
  ctx.restore();
}

function drawIslandWireframe(ctx, proj, grid) {
  const { island, reach, step, heights } = grid;
  const n = GRID_N;
  const peak = island.peak;
  // Projected vertices (allocated per draw; grids are small).
  const px = new Float32Array(n * n);
  const py = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = island.centre.x - reach + i * step;
      const z = island.centre.z - reach + j * step;
      const h = Math.max(heights[j * n + i], 0);
      const p = proj.project(x, h, z);
      px[j * n + i] = p[0];
      py[j * n + i] = p[1];
    }
  }
  ctx.save();
  ctx.lineJoin = 'round';
  // Translucent facets first (back rows first for a soft painter sort).
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
      const hAvg = (heights[a] + heights[b] + heights[d] + heights[e]) / 4;
      if (hAvg < 0.4) continue;
      ctx.fillStyle = rgba(heightRgb(hAvg, peak), 0.10 + clamp(hAvg / peak, 0, 1) * 0.16);
      ctx.beginPath();
      ctx.moveTo(px[a], py[a]); ctx.lineTo(px[b], py[b]);
      ctx.lineTo(px[e], py[e]); ctx.lineTo(px[d], py[d]);
      ctx.closePath(); ctx.fill();
    }
  }
  // Wireframe rows + columns, coloured by height.
  ctx.lineWidth = 1;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1;
      const hAvg = (heights[a] + heights[b]) / 2;
      if (hAvg < 0.3) continue;
      ctx.strokeStyle = rgba(heightRgb(hAvg, peak), 0.55);
      ctx.beginPath(); ctx.moveTo(px[a], py[a]); ctx.lineTo(px[b], py[b]); ctx.stroke();
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = j * n + i, b = a + n;
      const hAvg = (heights[a] + heights[b]) / 2;
      if (hAvg < 0.3) continue;
      ctx.strokeStyle = rgba(heightRgb(hAvg, peak), 0.55);
      ctx.beginPath(); ctx.moveTo(px[a], py[a]); ctx.lineTo(px[b], py[b]); ctx.stroke();
    }
  }
  // Contour lines (marching squares) every 15 m, brighter.
  const levels = [];
  for (let lv = 15; lv < peak; lv += 15) levels.push(lv);
  ctx.lineWidth = 1.1;
  for (const lv of levels) {
    ctx.strokeStyle = rgba(heightRgb(lv, peak), 0.85);
    ctx.beginPath();
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const idx = [j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i];
        const hs = idx.map((k) => heights[k]);
        // Edge crossing points (top, right, bottom, left).
        const cross = [];
        for (let e = 0; e < 4; e++) {
          const h1 = hs[e], h2 = hs[(e + 1) % 4];
          if ((h1 < lv && h2 >= lv) || (h1 >= lv && h2 < lv)) {
            const t = (lv - h1) / (h2 - h1);
            const k1 = idx[e], k2 = idx[(e + 1) % 4];
            cross.push([lerp(px[k1], px[k2], t), lerp(py[k1], py[k2], t)]);
          }
        }
        if (cross.length >= 2) {
          ctx.moveTo(cross[0][0], cross[0][1]);
          ctx.lineTo(cross[1][0], cross[1][1]);
          if (cross.length >= 4) {
            ctx.moveTo(cross[2][0], cross[2][1]);
            ctx.lineTo(cross[3][0], cross[3][1]);
          }
        }
      }
    }
    ctx.stroke();
  }
  // Shoreline glow: sea-level contour in bright cyan.
  ctx.strokeStyle = 'rgba(165,243,252,0.9)';
  ctx.lineWidth = 1.4;
  ctx.shadowColor = 'rgba(34,211,238,0.8)';
  ctx.shadowBlur = 5;
  ctx.beginPath();
  const lv = 0.4;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const idx = [j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i];
      const hs = idx.map((k) => heights[k]);
      const cross = [];
      for (let e = 0; e < 4; e++) {
        const h1 = hs[e], h2 = hs[(e + 1) % 4];
        if ((h1 < lv && h2 >= lv) || (h1 >= lv && h2 < lv)) {
          const t = (lv - h1) / (h2 - h1);
          const k1 = idx[e], k2 = idx[(e + 1) % 4];
          cross.push([lerp(px[k1], px[k2], t), lerp(py[k1], py[k2], t)]);
        }
      }
      if (cross.length >= 2) {
        ctx.moveTo(cross[0][0], cross[0][1]);
        ctx.lineTo(cross[1][0], cross[1][1]);
      }
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawStripIso(ctx, proj, strip, highlight) {
  const p = stripPos(strip);
  const rad = ((strip.headingDeg || 0) * Math.PI) / 180;
  const fwd = { x: Math.sin(rad), z: -Math.cos(rad) };
  const right = { x: Math.cos(rad), z: Math.sin(rad) };
  const halfL = (strip.length || 300) / 2;
  const halfW = Math.max((strip.width || 18) / 2, 26); // widened so it reads at map scale
  let elev = 4;
  try { elev = Math.max(heightAt(p.x, p.z), 1); } catch (e) { elev = 4; }
  const corner = (a, b) => proj.project(p.x + fwd.x * a + right.x * b, elev, p.z + fwd.z * a + right.z * b);
  const c1 = corner(-halfL, -halfW), c2 = corner(halfL, -halfW);
  const c3 = corner(halfL, halfW), c4 = corner(-halfL, halfW);
  ctx.save();
  if (highlight) { ctx.shadowColor = 'rgba(255,209,102,0.9)'; ctx.shadowBlur = 10; }
  ctx.fillStyle = highlight ? 'rgba(255,209,102,0.85)' : 'rgba(242,237,228,0.75)';
  ctx.beginPath();
  ctx.moveTo(c1[0], c1[1]); ctx.lineTo(c2[0], c2[1]); ctx.lineTo(c3[0], c3[1]); ctx.lineTo(c4[0], c4[1]);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(2,10,20,0.8)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  const m1 = corner(-halfL, 0), m2 = corner(halfL, 0);
  ctx.beginPath(); ctx.moveTo(m1[0], m1[1]); ctx.lineTo(m2[0], m2[1]); ctx.stroke();
  ctx.restore();
}

// Raised quadratic arc between two ground points (3D bezier, projected).
function drawRouteArc(ctx, proj, from, to, color, timeMs, dashed) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const apex = 260 + dist * 0.14;
  const mid = { x: (from.x + to.x) / 2, y: apex, z: (from.z + to.z) / 2 };
  const steps = 28;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * mid.x + t * t * to.x;
    const y = 2 * (1 - t) * t * mid.y + 30;
    const z = (1 - t) * (1 - t) * from.z + 2 * (1 - t) * t * mid.z + t * t * to.z;
    pts.push(proj.project(x, y, z));
  }
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Halo pass (cheap glow without shadowBlur on the whole path).
  ctx.strokeStyle = color.replace(')', ',0.18)').replace('rgb', 'rgba');
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts) ctx.lineTo(p[0], p[1]);
  ctx.stroke();
  // Core pass with animated dashes.
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  if (dashed) {
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -((timeMs / 40) % 12);
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts) ctx.lineTo(p[0], p[1]);
  ctx.stroke();
  ctx.restore();
  return pts;
}

function drawPin(ctx, x, y, groundY, number, color, timeMs, phase) {
  ctx.save();
  // Leader line down to the terrain.
  ctx.strokeStyle = 'rgba(165,243,252,0.5)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, groundY); ctx.stroke();
  ctx.setLineDash([]);
  // Ground pulse rings.
  const period = 1800;
  for (let k = 0; k < 2; k++) {
    const t = (((timeMs + phase + k * period / 2) % period) + period) % period / period;
    ctx.strokeStyle = 'rgba(103,232,249,' + (0.55 * (1 - t)).toFixed(3) + ')';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(x, groundY, 4 + t * 20, (4 + t * 20) * 0.45, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Halo + head.
  const halo = ctx.createRadialGradient(x, y, 0, x, y, 16);
  halo.addColorStop(0, 'rgba(165,243,252,0.35)');
  halo.addColorStop(1, 'rgba(165,243,252,0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(2,10,20,0.85)';
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#04121f';
  ctx.font = '800 10px ' + FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), x, y + 0.5);
  ctx.restore();
}

function drawHoloLabel(ctx, text, x, y, color, size, align) {
  ctx.save();
  ctx.font = '700 ' + size + 'px ' + FONT;
  ctx.textAlign = align || 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = C.ink;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawCompass(ctx, x, y, r, proj) {
  // Iso compass: project unit north/east vectors so the rose matches
  // the map's true directions.
  const origin = proj.project(0, 0, 0);
  const north = proj.project(0, 0, -1000);
  const east = proj.project(1000, 0, 0);
  const nAng = Math.atan2(north[1] - origin[1], north[0] - origin[0]);
  const eAng = Math.atan2(east[1] - origin[1], east[0] - origin[0]);
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(103,232,249,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.66, 0, Math.PI * 2); ctx.stroke();
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const long = k % 6 === 0;
    ctx.strokeStyle = long ? 'rgba(165,243,252,0.8)' : 'rgba(103,232,249,0.35)';
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * (long ? 0.82 : 0.9), Math.sin(a) * r * (long ? 0.82 : 0.9));
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.stroke();
  }
  const arrow = (ang, color, len) => {
    ctx.save();
    ctx.rotate(ang);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(len, 0); ctx.lineTo(-len * 0.25, -3.2); ctx.lineTo(-len * 0.25, 3.2);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  };
  arrow(nAng, C.orange, r * 0.95);
  arrow(eAng, 'rgba(242,237,228,0.75)', r * 0.7);
  arrow(nAng + Math.PI, 'rgba(242,237,228,0.4)', r * 0.55);
  arrow(eAng + Math.PI, 'rgba(242,237,228,0.4)', r * 0.45);
  ctx.fillStyle = C.orange;
  ctx.font = '800 10px ' + FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', Math.cos(nAng) * (r + 9), Math.sin(nAng) * (r + 9));
  ctx.restore();
}

// ------------------------------------------------------------- holo map

export function drawHoloMap(canvas, missionLike, options) {
  const opts = options || {};
  if (!canvas || typeof canvas.getContext !== 'function') return { draw() {}, stop() {} };
  const ctx = canvas.getContext('2d');
  if (!ctx) return { draw() {}, stop() {} };
  const definition = missionDefinition(missionLike);
  const waypoints = routeWaypoints(definition);
  const homeStrip = STRIPS[0];
  const homePos = stripPos(homeStrip);
  const targetStripId = definition
    ? (definition.type === 'delivery' ? definition.destinationStripId
      : definition.type === 'precision' ? definition.targetStripId : null)
    : null;
  const grids = buildIslandGrids();
  let rafId = 0;
  let stopped = false;
  // Static layer cache: backdrop + grid + terrain + strips + fixed
  // labels are rendered once per (size, mission, options) into an
  // offscreen canvas; per-frame work is then just arcs/pins/scanlines.
  let staticCanvas = null;
  let staticKey = '';

  function renderStatic(sctx, w, h, proj, compact, showLabels) {
    const bg = sctx.createRadialGradient(w * 0.5, h * 0.42, 10, w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
    bg.addColorStop(0, C.bgMid);
    bg.addColorStop(1, C.bgDeep);
    sctx.fillStyle = bg;
    sctx.fillRect(0, 0, w, h);
    drawGridFloor(sctx, proj);
    // Terrain back-to-front (north-west first in iso depth).
    const sorted = grids.slice().sort((a, b) =>
      (a.island.centre.x + a.island.centre.z) - (b.island.centre.x + b.island.centre.z));
    for (const grid of sorted) drawIslandWireframe(sctx, proj, grid);
    for (const strip of STRIPS) {
      drawStripIso(sctx, proj, strip, !!targetStripId && strip.id === String(targetStripId).toLowerCase());
    }
    if (showLabels) {
      for (const island of ISLANDS) {
        const p = proj.project(island.centre.x, island.peak * 0.9, island.centre.z);
        drawHoloLabel(sctx, island.name.toUpperCase(), p[0], p[1] - 14, 'rgba(165,243,252,0.85)', w >= 640 ? 10.5 : 9);
      }
    }
    if (definition && definition.title) {
      sctx.save();
      sctx.font = '800 ' + (compact ? 11 : 13) + 'px ' + FONT;
      sctx.textAlign = 'left';
      sctx.textBaseline = 'top';
      sctx.fillStyle = C.cyanBright;
      sctx.fillText(definition.title.toUpperCase(), 14, 12);
      sctx.font = '700 9px ' + FONT;
      sctx.fillStyle = 'rgba(103,232,249,0.7)';
      const sub = (definition.type || '').toUpperCase() + (definition.tier ? ' · TIER ' + definition.tier : '');
      sctx.fillText(sub, 14, compact ? 27 : 30);
      sctx.restore();
    }
    drawCompass(sctx, w - 42, 46, 24, proj);
    const s0 = proj.project(WORLD_BOUNDS.minX + 200, 0, WORLD_BOUNDS.maxZ - 200);
    const s1 = proj.project(WORLD_BOUNDS.minX + 1200, 0, WORLD_BOUNDS.maxZ - 200);
    sctx.save();
    sctx.strokeStyle = 'rgba(165,243,252,0.8)';
    sctx.lineWidth = 2;
    sctx.beginPath(); sctx.moveTo(s0[0], s0[1]); sctx.lineTo(s1[0], s1[1]); sctx.stroke();
    drawHoloLabel(sctx, '1 KM', (s0[0] + s1[0]) / 2, s0[1] + 11, 'rgba(165,243,252,0.8)', 9);
    sctx.restore();
  }

  function draw(timeMs) {
    const t = typeof timeMs === 'number' ? timeMs : (typeof opts.timeMs === 'number' ? opts.timeMs : performance.now());
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    const compact = !!opts.compact || w < 420;
    const showLabels = opts.showLabels !== false && !compact;
    const heightScale = typeof opts.heightScale === 'number' ? opts.heightScale : 6;
    const proj = makeIsoProjector(w, h, heightScale);

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    const key = w + 'x' + h + '|' + (definition ? definition.id : '') + '|' + compact + '|' + showLabels + '|' + heightScale;
    if (typeof document !== 'undefined') {
      if (key !== staticKey || !staticCanvas) {
        staticCanvas = document.createElement('canvas');
        staticCanvas.width = w;
        staticCanvas.height = h;
        const sctx = staticCanvas.getContext('2d');
        if (sctx) renderStatic(sctx, w, h, proj, compact, showLabels);
        staticKey = key;
      }
      ctx.drawImage(staticCanvas, 0, 0);
    } else {
      renderStatic(ctx, w, h, proj, compact, showLabels);
    }

    // Route arcs: home -> each waypoint in order (+ return leg for delivery).
    const arcColor = definition && definition.type === 'cargo' ? 'rgb(255,158,100)'
      : definition && definition.type === 'precision' ? 'rgb(143,200,255)' : 'rgb(255,209,102)';
    const chain = [homePos].concat(waypoints);
    for (let i = 1; i < chain.length; i++) {
      drawRouteArc(ctx, proj, chain[i - 1], chain[i], arcColor, t, true);
    }
    if (definition && definition.type === 'delivery' && waypoints.length) {
      drawRouteArc(ctx, proj, waypoints[0], homePos, 'rgb(242,237,228)', t, true);
    }

    // Pins: home first (red, "H"), then numbered waypoints.
    const pinLift = 46;
    const homeGround = proj.project(homePos.x, 0, homePos.z);
    drawPin(ctx, homeGround[0], homeGround[1] - pinLift, homeGround[1], 'H', C.red, t, 0);
    waypoints.forEach((wp, i) => {
      const g = proj.project(wp.x, 0, wp.z);
      const color = i === 0 ? C.green : (wp.kind === 'drop' ? C.orange : C.amber);
      drawPin(ctx, g[0], g[1] - pinLift, g[1], i + 1, color, t, i * 260);
    });

    // Pin labels (island names / title / compass live in the static layer).
    if (showLabels) {
      const hp = proj.project(homePos.x, 0, homePos.z);
      drawHoloLabel(ctx, 'AURORA FIELD', hp[0], hp[1] - pinLift - 20, '#ffd9a0', 10.5);
      const islandNames = new Set(ISLANDS.map((isl) => isl.name.toUpperCase()));
      waypoints.forEach((wp) => {
        if (wp.kind === 'ring') return; // numbered pins carry ring order
        if (islandNames.has(wp.label)) return; // island label already names it
        const g = proj.project(wp.x, 0, wp.z);
        drawHoloLabel(ctx, wp.label, g[0], g[1] - pinLift - 20, wp.kind === 'drop' ? C.orange : C.amber, 10);
      });
    }

    drawScanlines(ctx, w, h, t);
    drawCornerBrackets(ctx, w, h, 7, 18, 'rgba(103,232,249,0.7)');
    ctx.restore();
  }

  draw(typeof opts.timeMs === 'number' ? opts.timeMs : undefined);
  if (opts.animate) {
    const loop = (now) => { if (!stopped) { draw(now); rafId = requestAnimationFrame(loop); } };
    rafId = requestAnimationFrame(loop);
  }
  return {
    draw,
    stop() { stopped = true; if (rafId) cancelAnimationFrame(rafId); },
  };
}

// ---------------------------------------------------------------- radar

export function drawRadar(canvas, state, timeMs) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const s = state || {};
  const t = typeof timeMs === 'number' ? timeMs : performance.now();
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return;
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 16;
  const range = typeof s.range === 'number' && s.range > 0 ? s.range : 6000;
  const northUp = s.northUp !== false;
  const headingDeg = typeof s.headingDeg === 'number' ? s.headingDeg : 0;
  const planeRaw = s.plane || s.planePosition || null;
  const plane = planeRaw
    ? { x: (planeRaw.position ? planeRaw.position.x : planeRaw.x) || 0, z: (planeRaw.position ? planeRaw.position.z : planeRaw.z) || 0 }
    : stripPos(STRIPS[0]);
  const rot = northUp ? 0 : (-headingDeg * Math.PI) / 180;
  // World offset -> radar screen point (north up, +x east).
  const toScreen = (wx, wz) => {
    const dx = wx - plane.x;
    const dz = wz - plane.z;
    const rx = dx * Math.cos(rot) - dz * Math.sin(rot);
    const rz = dx * Math.sin(rot) + dz * Math.cos(rot);
    return [cx + (rx / range) * R, cy + (rz / range) * R, Math.sqrt(dx * dx + dz * dz)];
  };
  const sweepPeriod = 6000;
  const sweepAng = -Math.PI / 2 + (((t % sweepPeriod) + sweepPeriod) % sweepPeriod / sweepPeriod) * Math.PI * 2;

  ctx.save();
  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createRadialGradient(cx, cy, 4, cx, cy, R * 1.15);
  bg.addColorStop(0, '#07304a');
  bg.addColorStop(0.7, '#041a2e');
  bg.addColorStop(1, C.bgDeep);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Terrain blobs (island discs) under the rings.
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  for (const island of ISLANDS) {
    const [ix, iy, dist] = toScreen(island.centre.x, island.centre.z);
    const ir = (island.radius / range) * R;
    if (dist > range + island.radius) continue;
    const grad = ctx.createRadialGradient(ix, iy, 0, ix, iy, ir);
    grad.addColorStop(0, 'rgba(34,211,238,0.20)');
    grad.addColorStop(0.75, 'rgba(34,211,238,0.10)');
    grad.addColorStop(1, 'rgba(34,211,238,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(ix, iy, ir, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(103,232,249,0.30)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(ix, iy, ir * 0.62, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(ix, iy, ir * 0.32, 0, Math.PI * 2); ctx.stroke();
  }

  // Sweep trail: layered wedges behind the leading edge.
  const trailSteps = 26;
  const trailSpan = Math.PI * 0.85;
  for (let i = trailSteps; i >= 1; i--) {
    const a0 = sweepAng - (i / trailSteps) * trailSpan;
    const a1 = sweepAng - ((i - 1) / trailSteps) * trailSpan;
    const alpha = 0.16 * (1 - i / trailSteps);
    ctx.fillStyle = 'rgba(34,211,238,' + alpha.toFixed(3) + ')';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, a0, a1);
    ctx.closePath();
    ctx.fill();
  }
  // Leading sweep line with glow.
  ctx.strokeStyle = 'rgba(165,243,252,0.95)';
  ctx.lineWidth = 1.8;
  ctx.shadowColor = 'rgba(34,211,238,0.9)';
  ctx.shadowBlur = 7;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sweepAng) * R, cy + Math.sin(sweepAng) * R);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Blips: strips (amber squares) + island peaks (cyan dots). Brightness
  // flares just after the sweep passes their bearing.
  const blipAlpha = (bx, by) => {
    const ang = Math.atan2(by - cy, bx - cx);
    let diff = sweepAng - ang;
    diff = ((diff % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return 0.25 + 0.75 * Math.exp(-diff * 1.6);
  };
  for (const island of ISLANDS) {
    const [bx, by, dist] = toScreen(island.centre.x, island.centre.z);
    if (dist > range) continue;
    const a = blipAlpha(bx, by);
    ctx.fillStyle = 'rgba(103,232,249,' + (0.35 * a).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(bx, by, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(165,243,252,' + a.toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(bx, by, 2.4, 0, Math.PI * 2); ctx.fill();
  }
  for (const strip of STRIPS) {
    const p = stripPos(strip);
    const [bx, by, dist] = toScreen(p.x, p.z);
    if (dist > range) continue;
    const a = blipAlpha(bx, by);
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(((strip.headingDeg || 0) * Math.PI) / 180 + rot);
    ctx.fillStyle = 'rgba(255,209,102,' + (0.3 * a).toFixed(3) + ')';
    ctx.fillRect(-7, -7, 14, 14);
    ctx.fillStyle = 'rgba(255,209,102,' + a.toFixed(3) + ')';
    ctx.fillRect(-4.5, -1.4, 9, 2.8);
    ctx.restore();
  }
  // Mission waypoints (green diamonds) + optional live target.
  const definition = missionDefinition(s.missionLike);
  for (const wp of routeWaypoints(definition)) {
    const [bx, by, dist] = toScreen(wp.x, wp.z);
    if (dist > range) continue;
    const a = blipAlpha(bx, by);
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = 'rgba(125,255,178,' + a.toFixed(3) + ')';
    ctx.fillRect(-3, -3, 6, 6);
    ctx.restore();
  }
  if (s.target && typeof s.target.x === 'number') {
    const [bx, by, dist] = toScreen(s.target.x, s.target.z);
    if (dist <= range) {
      const pulse = 6 + 3 * Math.sin(t / 280);
      ctx.strokeStyle = 'rgba(125,255,178,0.9)';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(bx, by, pulse, 0, Math.PI * 2); ctx.stroke();
      if (s.target.label) drawHoloLabel(ctx, String(s.target.label).toUpperCase(), bx, by - 14, C.green, 9);
    }
  }
  ctx.restore(); // unclip

  // Range rings + labels.
  ctx.save();
  for (let ring = 1; ring <= 4; ring++) {
    const rr = (ring / 4) * R;
    ctx.strokeStyle = ring === 4 ? 'rgba(103,232,249,0.85)' : 'rgba(34,211,238,0.38)';
    ctx.lineWidth = ring === 4 ? 1.8 : 1;
    if (ring === 4) { ctx.shadowColor = 'rgba(34,211,238,0.7)'; ctx.shadowBlur = 6; }
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
    const km = (range * ring / 4 / 1000);
    drawHoloLabel(ctx, (Number.isInteger(km) ? km : km.toFixed(1)) + '', cx + rr * 0.72, cy - rr * 0.72, 'rgba(103,232,249,0.75)', 8);
  }
  // Cross hairs.
  ctx.strokeStyle = 'rgba(34,211,238,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();
  // Degree ticks + outer labels (0 = north at top).
  for (let deg = 0; deg < 360; deg += 5) {
    const a = -Math.PI / 2 + (deg * Math.PI) / 180 + rot;
    const long = deg % 30 === 0;
    const mid = deg % 10 === 0;
    const r0 = R - (long ? 9 : mid ? 6 : 3.5);
    ctx.strokeStyle = long ? 'rgba(165,243,252,0.85)' : 'rgba(103,232,249,0.4)';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.stroke();
    if (long) {
      const lx = cx + Math.cos(a) * (R + 10);
      const ly = cy + Math.sin(a) * (R + 10);
      const label = deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : deg === 270 ? 'W' : String(deg).padStart(3, '0');
      drawHoloLabel(ctx, label, lx, ly, deg === 0 ? C.orange : 'rgba(165,243,252,0.8)', deg % 90 === 0 ? 10 : 8);
    }
  }
  // Range caption.
  drawHoloLabel(ctx, 'RNG ' + (range / 1000) + ' KM', cx, cy + R + 12 > h - 6 ? h - 8 : cy + R + 12, 'rgba(103,232,249,0.7)', 8.5);
  ctx.restore();

  // Centre aircraft marker.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(northUp ? (headingDeg * Math.PI) / 180 : 0);
  ctx.shadowColor = 'rgba(255,158,100,0.9)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = C.orange;
  ctx.beginPath();
  ctx.moveTo(0, -8); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  drawScanlines(ctx, w, h, t);
  drawCornerBrackets(ctx, w, h, 6, 14, 'rgba(103,232,249,0.6)');
  ctx.restore();
}
