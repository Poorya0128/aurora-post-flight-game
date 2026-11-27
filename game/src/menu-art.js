// menu-art.js — artwork for the menu screens: an inline SVG icon set,
// medal badges, keyboard keycaps, and the nautical mission chart
// (real height-tinted terrain with each sortie's real route drawn on
// it). Read-only: consumes mission definitions, route tables and the
// terrain height function; changes none of them.

import { ISLANDS, STRIPS } from './config.js';
import { heightAt } from './world.js';
import { MISSIONS, MISSION_ROUTES } from './missions.js';

const FONT = 'AuroraSans, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

// ------------------------------------------------------------------ icons
// 24x24 grid, 2px round strokes in currentColor (CSS picks the colour).

const ICONS = new Map(Object.entries({
  plane: '<path d="M2.5 13.5 L9.5 12 L14 4.5 L16.2 4.5 L14.4 11.4 L19.8 10.6 L21.6 8.2 L22.6 8.4 L21.8 12.6 L22.6 16.8 L21.6 17 L19.8 14.6 L14.4 13.8 L16.2 20.6 L14 20.6 L9.5 13.2 Z" fill="currentColor" stroke="none"/>',
  takeoff: '<path d="M3 20h18"/><path d="M4.5 15.5 L9 14.6 L12.6 8.6 L14.4 8.6 L13 13.6 L17.6 12.4 L19.4 9.8 L20.4 10 L19.8 13.8 L5.6 17.2 Z" fill="currentColor" stroke="none"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.2a2.7 2.7 0 1 1 3.9 2.4c-.9.4-1.3 1-1.3 1.9v.6"/><circle cx="12" cy="17.2" r="0.6" fill="currentColor"/>',
  soundOn: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18 6.5a7.8 7.8 0 0 1 0 11"/>',
  soundOff: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/><path d="M8.5 12H20"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.8 8.2l-2.2 5.4-5.4 2.2 2.2-5.4z" fill="currentColor" stroke="none"/>',
  retry: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.2 4.5v4.2h4.2"/>',
  next: '<path d="M6 5.5l6.5 6.5L6 18.5"/><path d="M12.5 5.5L19 12l-6.5 6.5"/>',
  menu: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  exit: '<path d="M13 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5H13"/><path d="M16 8l4 4-4 4"/><path d="M10 12h10"/>',
  ring: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r="0.9" fill="currentColor"/>',
  cargo: '<path d="M4 9.5a8 6 0 0 1 16 0"/><path d="M4 9.5l6 6.5M20 9.5l-6 6.5M12 3.5v12.5"/><rect x="9" y="15.5" width="6" height="5" rx="0.8" fill="currentColor" stroke="none"/>',
  delivery: '<rect x="3.5" y="6" width="17" height="12" rx="1.6"/><path d="M4 7l8 6.2L20 7"/>',
  precision: '<path d="M9 21L11 3h2l2 18z"/><path d="M12 6.5v2M12 11v2M12 15.5v2"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="1.8"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  wind: '<path d="M3 8.5h11a2.5 2.5 0 1 0-2.5-2.5"/><path d="M3 12.5h15.5a2.5 2.5 0 1 1-2.5 2.5"/><path d="M3 16.5h7"/>',
  fuel: '<path d="M5 20V5.5A1.5 1.5 0 0 1 6.5 4h6A1.5 1.5 0 0 1 14 5.5V20"/><path d="M3.5 20h12"/><path d="M14 9h2.2a1.5 1.5 0 0 1 1.5 1.5v5.2a1.3 1.3 0 0 0 2.6 0V8.5L18 6"/><rect x="7" y="7" width="5" height="4" rx="0.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  trophy: '<path d="M7.5 4.5h9v4a4.5 4.5 0 0 1-9 0z"/><path d="M7.5 6.5H4.5a3 3 0 0 0 3 3.5M16.5 6.5h3a3 3 0 0 1-3 3.5"/><path d="M12 13v3.5M8.5 20h7M9.5 20v-1.5a2.5 2.5 0 0 1 5 0V20"/>',
  wrench: '<path d="M14.5 4.2a4.5 4.5 0 0 0-4.8 6.2L4 16.1 7.9 20l5.7-5.7a4.5 4.5 0 0 0 6.2-4.8l-2.9 2.9-2.9-.6-.6-2.9z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  warning: '<path d="M12 3.5L21.5 20h-19z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r="0.6" fill="currentColor"/>',
  medal: '<circle cx="12" cy="14.5" r="5.5"/><path d="M8.5 10L6 3.5h4l2 4 2-4h4L15.5 10"/>',
  map: '<path d="M3.5 6.5l5.5-2.5 6 2.5 5.5-2.5v13.5l-5.5 2.5-6-2.5-5.5 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
}));

/** Inline SVG for a named icon; empty string when the name is unknown. */
export function iconSvg(name, size) {
  const body = ICONS.get(name);
  if (!body) return '';
  const px = size || 22;
  return `<svg class="ui-icon" viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// ----------------------------------------------------------------- medals

const TONES = {
  gold: ['#FFF3C4', '#FFD166', '#C98A12', '#8A5A06'],
  silver: ['#FFFFFF', '#D9E2EA', '#9AA6B2', '#5E6B78'],
  bronze: ['#FFE0C2', '#E8A06A', '#A8602E', '#6E3A18'],
  none: ['#5A6170', '#3A404C', '#262B34', '#171A20'],
};

/** Medal badge SVG (ribbon, rim, embossed star) for a tier name. */
export function medalSvg(tier, size) {
  const key = String(tier || 'none').toLowerCase();
  const [hi, mid, low, dark] = TONES[key] || TONES.none;
  const gid = `md-${key}-${Math.round(Math.random() * 1e6)}`;
  const px = size || 96;
  return `<svg class="medal-svg medal-${key}" viewBox="0 0 96 112" width="${px}" height="${Math.round((px * 112) / 96)}" aria-hidden="true">`
    + `<defs><radialGradient id="${gid}" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="${hi}"/><stop offset="0.45" stop-color="${mid}"/><stop offset="1" stop-color="${low}"/></radialGradient></defs>`
    + '<path d="M30 2h14l8 30h-14z" fill="#C93A36"/><path d="M52 2h14l-8 30h-14z" fill="#2B3A67"/>'
    + '<path d="M36 2h4l7 30h-4z" fill="#F2EDE4" opacity="0.8"/><path d="M56 2h4l-7 30h-4z" fill="#F2EDE4" opacity="0.8"/>'
    + `<circle cx="48" cy="70" r="38" fill="${dark}"/>`
    + `<circle cx="48" cy="68" r="36" fill="url(#${gid})"/>`
    + `<circle cx="48" cy="68" r="28" fill="none" stroke="${dark}" stroke-opacity="0.55" stroke-width="2"/>`
    + `<path d="M48 48l5.9 12 13.2 1.9-9.6 9.3 2.3 13.1L48 78.1l-11.8 6.2 2.3-13.1-9.6-9.3 13.2-1.9z" fill="${low}" opacity="0.85"/>`
    + `<path d="M48 50l5.2 10.6 11.6 1.7-8.4 8.2 2 11.5L48 76.5l-10.4 5.5 2-11.5-8.4-8.2 11.6-1.7z" fill="${hi}" opacity="0.55"/>`
    + '<path d="M22 56a28 28 0 0 1 22-20" stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="3" fill="none" stroke-linecap="round"/>'
    + '</svg>';
}

// ----------------------------------------------------------------- keycaps

const GLYPHS = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Space: 'SPACE', Enter: 'ENTER', Escape: 'ESC', Esc: 'ESC', Shift: 'SHIFT', Ctrl: 'CTRL',
  PageUp: 'PG UP', PageDown: 'PG DN', Home: 'HOME', End: 'END',
};

/**
 * Break a help label ("ArrowDown / S", "0 / 9 or Home / End") into
 * keycap tokens and joiner words for the keycap help table.
 */
export function keyTokens(label) {
  const text = String(label || '');
  const tokens = [];
  const emitChunk = (chunk) => {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    const isPhrase = /^(hold|left too|recentres?)$/i.test(trimmed)
      || (/\s/.test(trimmed) && !GLYPHS[trimmed] && !/^Mouse|^Right mouse/i.test(trimmed));
    tokens.push(isPhrase
      ? { kind: 'word', text: trimmed }
      : { kind: 'key', text: GLYPHS[trimmed] || trimmed.toUpperCase() });
  };
  const splitter = /\s*(\/|\bor\b|\(|\)|=)\s*/g;
  let last = 0;
  let m;
  while ((m = splitter.exec(text)) !== null) {
    emitChunk(text.slice(last, m.index));
    if (m[1] === '/') tokens.push({ kind: 'word', text: '/' });
    else if (/or/i.test(m[1])) tokens.push({ kind: 'word', text: 'or' });
    last = splitter.lastIndex;
  }
  emitChunk(text.slice(last));
  return tokens;
}

// --------------------------------------------------------------- missions

export const MISSION_TYPES = {
  ring: { icon: 'ring', label: 'RING COURSE', hue: '#7DFFB2' },
  cargo: { icon: 'cargo', label: 'AIR DROP', hue: '#FF9E64' },
  delivery: { icon: 'delivery', label: 'MAIL RUN', hue: '#FFD166' },
  precision: { icon: 'precision', label: 'PRECISION LANDING', hue: '#8FC8FF' },
  'free-flight': { icon: 'compass', label: 'FREE FLIGHT', hue: '#F2EDE4' },
};

export const TIER_NAMES = { 1: 'CALM DAWN', 2: 'FRESH BREEZE', 3: 'SQUALL LINE' };

/** Full mission definition for an id, or null. */
export function missionDefinition(missionId) {
  if (!Array.isArray(MISSIONS)) return null;
  return MISSIONS.find((d) => d.id === missionId) || null;
}

// ------------------------------------------------------------------ chart

const BOUNDS = { minX: -4300, maxX: 5300, minZ: -3100, maxZ: 4500 };
const CELL = 40; // metres per terrain pixel
let terrainCanvas = null; // built once, lazily

function newCanvas(w, h) {
  if (typeof document === 'undefined') return null;
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  return el;
}

function nearIsland(x, z) {
  return ISLANDS.some((isle) => {
    const dx = x - isle.centre.x;
    const dz = z - isle.centre.z;
    const reach = isle.radius * 1.22 + 80;
    return dx * dx + dz * dz < reach * reach;
  });
}

// Height -> chart colour (before hillshade).
function terrainColour(h) {
  if (h < -6) return [0, 0, 0, 0];
  if (h < 0.3) {
    const t = (h + 6) / 6.3; // shallows: deep -> bright reef teal
    return [30 + t * 40, 110 + t * 70, 140 + t * 40, Math.round(40 + t * 150)];
  }
  if (h < 3) return [222, 196, 146, 255];
  if (h < 40) {
    const t = (h - 3) / 37;
    return [92 - t * 22, 142 - t * 20, 72 - t * 16, 255];
  }
  const t = Math.min(1, (h - 40) / 70);
  return [120 + t * 70, 108 + t * 70, 96 + t * 70, 255];
}

// One pixel per 40 m cell, height-tinted with north-west hillshade;
// the chart draws it scaled with smoothing for soft coastlines.
function buildTerrain() {
  const cols = Math.ceil((BOUNDS.maxX - BOUNDS.minX) / CELL);
  const rows = Math.ceil((BOUNDS.maxZ - BOUNDS.minZ) / CELL);
  const canvas = newCanvas(cols, rows);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(cols, rows);
  const heights = new Float32Array(cols * rows).fill(-12);
  for (let row = 0; row < rows; row++) {
    const z = BOUNDS.minZ + (row + 0.5) * CELL;
    for (let col = 0; col < cols; col++) {
      const x = BOUNDS.minX + (col + 0.5) * CELL;
      if (!nearIsland(x, z)) continue;
      const h = heightAt(x, z);
      heights[row * cols + col] = Number.isFinite(h) ? h : -12;
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const h = heights[i];
      let [r, g, b, a] = terrainColour(h);
      if (h >= 0.3) {
        const west = col > 0 ? heights[i - 1] : h;
        const north = row > 0 ? heights[i - cols] : h;
        const shade = Math.max(-0.35, Math.min(0.35, ((h - west) + (h - north)) * 0.035));
        const f = 1 + shade;
        r = Math.max(0, Math.min(255, r * f));
        g = Math.max(0, Math.min(255, g * f));
        b = Math.max(0, Math.min(255, b * f));
      }
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function projector(w, h, padding) {
  const spanX = BOUNDS.maxX - BOUNDS.minX;
  const spanZ = BOUNDS.maxZ - BOUNDS.minZ;
  const scale = Math.min((w - padding * 2) / spanX, (h - padding * 2) / spanZ);
  const ox = (w - spanX * scale) / 2;
  const oy = (h - spanZ * scale) / 2;
  return {
    scale,
    x: (wx) => ox + (wx - BOUNDS.minX) * scale,
    y: (wz) => oy + (wz - BOUNDS.minZ) * scale,
  };
}

function stripById(id) {
  const wanted = String(id || '').toLowerCase();
  return STRIPS.find((s) => s.id === wanted) || STRIPS[0];
}

// ------------------------------------------------------------ chart paint

function paintStrip(ctx, project, strip, highlight) {
  const rad = (strip.headingDeg * Math.PI) / 180;
  const len = Math.max(10, strip.length * project.scale);
  const wid = Math.max(4, strip.width * project.scale * 2.2);
  ctx.save();
  ctx.translate(project.x(strip.position.x), project.y(strip.position.z));
  ctx.rotate(rad);
  if (highlight) {
    ctx.shadowColor = 'rgba(255,209,102,0.9)';
    ctx.shadowBlur = 12;
  }
  ctx.fillStyle = '#2E3236';
  ctx.fillRect(-wid / 2 - 1, -len / 2 - 1, wid + 2, len + 2);
  ctx.fillStyle = highlight ? '#FFD166' : '#F2EDE4';
  ctx.fillRect(-wid / 2, -len / 2, wid, len);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#2E3236';
  for (let k = -2; k <= 2; k++) ctx.fillRect(-0.6, k * len * 0.18 - 1, 1.2, 2);
  ctx.restore();
}

function paintLabel(ctx, text, x, y, opts = {}) {
  ctx.save();
  ctx.font = `${opts.weight || '700'} ${opts.size || 12}px ${FONT}`;
  ctx.textAlign = opts.align || 'center';
  ctx.textBaseline = 'middle';
  if (opts.letterSpacing && 'letterSpacing' in ctx) ctx.letterSpacing = opts.letterSpacing;
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(6,14,26,0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = opts.color || '#F2EDE4';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function paintMarker(ctx, x, y, number, fill, radius) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius + 2.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(6,14,26,0.85)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.font = `800 ${Math.round(radius * 1.15)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#0A0E18';
  ctx.fillText(String(number), x, y + 0.5);
  ctx.restore();
}

function paintCompass(ctx, x, y, radius) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(242,237,228,0.45)';
  ctx.lineWidth = 1;
  for (const r of [radius, radius * 0.62]) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let k = 0; k < 8; k++) {
    const long = k % 2 === 0;
    ctx.save();
    ctx.rotate((k * Math.PI) / 4);
    ctx.beginPath();
    ctx.moveTo(0, -radius * (long ? 1.05 : 0.7));
    ctx.lineTo(radius * 0.12, 0);
    ctx.lineTo(-radius * 0.12, 0);
    ctx.closePath();
    ctx.fillStyle = k === 0 ? '#FF9E64' : long ? 'rgba(242,237,228,0.85)' : 'rgba(242,237,228,0.45)';
    ctx.fill();
    ctx.restore();
  }
  paintLabel(ctx, 'N', 0, -radius - 10, { size: 12, weight: '800', color: '#FF9E64' });
  ctx.restore();
}

function paintRoute(ctx, points, color, dashed, width) {
  if (points.length < 2) return;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let k = 1; k < points.length; k++) ctx.lineTo(points[k][0], points[k][1]);
    ctx.stroke();
  };
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash(dashed ? [7, 6] : []);
  ctx.strokeStyle = 'rgba(6,14,26,0.75)';
  ctx.lineWidth = (width || 2.5) + 3;
  trace();
  ctx.strokeStyle = color;
  ctx.lineWidth = width || 2.5;
  trace();
  ctx.restore();
}

function paintArrow(ctx, from, to, color) {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  ctx.save();
  ctx.translate((from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(6, 0);
  ctx.lineTo(-5, -4.5);
  ctx.lineTo(-5, 4.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(6,14,26,0.85)';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Label placement with collision avoidance: labels are laid down in
// priority order; each tries candidate offsets around its anchor and
// takes the first box that clears everything placed and stays inside
// the chart — or the least-overlapping one. A label is never dropped.
function makeLabelPlacer(ctx, chartW, chartH) {
  const placed = [];
  const boxFor = (text, x, y, align, size, spacingPx) => {
    ctx.save();
    ctx.font = `700 ${size}px ${FONT}`;
    const w = ctx.measureText(text).width + text.length * (spacingPx || 0);
    ctx.restore();
    const h = size + 5;
    const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    return { left, top: y - h / 2, right: left + w, bottom: y + h / 2 };
  };
  const overlap = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  };
  return function place(text, ax, ay, candidates, style) {
    const size = style.size || 11;
    const spacingPx = style.letterSpacing ? parseFloat(style.letterSpacing) || 0 : 0;
    let best = null;
    for (const cand of candidates) {
      const x = ax + cand.dx;
      const y = ay + cand.dy;
      const box = boxFor(text, x, y, cand.align || 'center', size, spacingPx);
      const inside = box.left >= 5 && box.right <= chartW - 5 && box.top >= 5 && box.bottom <= chartH - 5;
      const padded = { left: box.left - 3, top: box.top - 2, right: box.right + 3, bottom: box.bottom + 2 };
      const score = placed.reduce((sum, p) => sum + overlap(padded, p), 0) + (inside ? 0 : 100000);
      if (!best || score < best.score) best = { x, y, align: cand.align || 'center', box, score };
      if (score === 0) break;
    }
    paintLabel(ctx, text, best.x, best.y, { ...style, align: best.align });
    placed.push(best.box);
  };
}

// Per-type route painters. Each returns a route label descriptor (or
// null) so the caller can place labels after the route is down.
function routeForRings(ctx, project, definition, homePt, compact) {
  const route = (MISSION_ROUTES && MISSION_ROUTES.rings && MISSION_ROUTES.rings[definition.tier]) || [];
  const points = [homePt, ...route.map((wp) => [project.x(wp.x), project.y(wp.z)])];
  paintRoute(ctx, points, '#FFD166', true, compact ? 1.6 : 2.4);
  if (!compact) for (let k = 1; k < points.length; k += 2) paintArrow(ctx, points[k - 1], points[k], '#FFD166');
  route.forEach((wp, i) => {
    paintMarker(ctx, project.x(wp.x), project.y(wp.z), compact ? '' : i + 1, i === 0 ? '#7DFFB2' : '#FFD166', compact ? 5 : 8.5);
  });
  return null;
}

function routeForCargo(ctx, project, definition, homePt, compact) {
  const zones = (definition.dropZoneKeys || [])
    .map((key) => MISSION_ROUTES && MISSION_ROUTES.dropZones && MISSION_ROUTES.dropZones[key])
    .filter(Boolean);
  const points = [homePt, ...zones.map((z) => [project.x(z.x), project.y(z.z)])];
  paintRoute(ctx, points, '#FF9E64', true, compact ? 1.6 : 2.4);
  const mr = compact ? 5 : 8.5;
  zones.forEach((zone, i) => {
    const x = project.x(zone.x);
    const y = project.y(zone.z);
    ctx.save();
    ctx.strokeStyle = '#FF9E64';
    ctx.lineWidth = compact ? 1.5 : 2.5;
    ctx.beginPath();
    ctx.arc(x, y, mr * 1.7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - mr * 2.3, y);
    ctx.lineTo(x + mr * 2.3, y);
    ctx.moveTo(x, y - mr * 2.3);
    ctx.lineTo(x, y + mr * 2.3);
    ctx.stroke();
    ctx.restore();
    paintMarker(ctx, x, y, compact ? '' : i + 1, '#FF9E64', mr * 0.85);
  });
  return null;
}

function routeForDelivery(ctx, project, definition, homePt, compact) {
  const dest = stripById(definition.destinationStripId);
  const destPt = [project.x(dest.position.x), project.y(dest.position.z)];
  const midX = (homePt[0] + destPt[0]) / 2;
  const midY = (homePt[1] + destPt[1]) / 2;
  const bend = [midX + (destPt[1] - homePt[1]) * 0.12, midY - (destPt[0] - homePt[0]) * 0.12];
  const back = [midX - (destPt[1] - homePt[1]) * 0.12, midY + (destPt[0] - homePt[0]) * 0.12];
  paintRoute(ctx, [homePt, bend, destPt], '#FFD166', false, compact ? 1.8 : 2.8);
  paintRoute(ctx, [destPt, back, homePt], 'rgba(242,237,228,0.85)', true, compact ? 1.4 : 2.2);
  if (compact) return null;
  paintArrow(ctx, homePt, bend, '#FFD166');
  paintArrow(ctx, destPt, back, '#F2EDE4');
  return { text: `MAIL TO ${dest.name.toUpperCase()}`, x: destPt[0], y: destPt[1], color: '#FFD166', stripId: dest.id };
}

function routeForPrecision(ctx, project, definition, compact) {
  const target = stripById(definition.targetStripId);
  const centre = [project.x(target.position.x), project.y(target.position.z)];
  const rad = (target.headingDeg * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const approach = compact ? 26 : 70;
  const halfLen = target.length * project.scale * 0.5;
  const threshold = [centre[0] - ux * halfLen, centre[1] - uy * halfLen];
  ctx.save();
  const g = ctx.createLinearGradient(threshold[0] - ux * approach, threshold[1] - uy * approach, threshold[0], threshold[1]);
  g.addColorStop(0, 'rgba(143,200,255,0)');
  g.addColorStop(1, 'rgba(143,200,255,0.55)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(threshold[0], threshold[1]);
  ctx.lineTo(threshold[0] - ux * approach - uy * approach * 0.32, threshold[1] - uy * approach + ux * approach * 0.32);
  ctx.lineTo(threshold[0] - ux * approach + uy * approach * 0.32, threshold[1] - uy * approach - ux * approach * 0.32);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  for (let k = 1; k <= 3; k++) {
    const d = (approach / 4) * k;
    paintArrow(ctx,
      [threshold[0] - ux * (d + 4), threshold[1] - uy * (d + 4)],
      [threshold[0] - ux * (d - 4), threshold[1] - uy * (d - 4)], '#8FC8FF');
  }
  if (compact) return null;
  return { text: `FINAL · ${target.name.toUpperCase()}`, x: centre[0], y: centre[1], color: '#8FC8FF', stripId: target.id };
}

/**
 * Draw the nautical chart for `missionLike` ({id} or a definition).
 * No mission draws the bare archipelago. Options: { compact } trims
 * labels for small thumbnails.
 */
export function drawMissionChart(ctx, width, height, missionLike, options) {
  const compact = !!(options && options.compact);
  const definition = missionLike && missionLike.id ? (missionDefinition(missionLike.id) || missionLike) : missionLike;
  const project = projector(width, height, compact ? 6 : 18);
  ctx.save();
  ctx.clearRect(0, 0, width, height);

  // Sea: deep navy light pool + kilometre grid.
  const sea = ctx.createRadialGradient(width * 0.45, height * 0.4, 10, width * 0.5, height * 0.5, Math.max(width, height) * 0.75);
  sea.addColorStop(0, '#17466a');
  sea.addColorStop(1, '#0a2238');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(143,200,255,0.10)';
  ctx.lineWidth = 1;
  for (let gx = Math.ceil(BOUNDS.minX / 1000) * 1000; gx <= BOUNDS.maxX; gx += 1000) {
    ctx.beginPath();
    ctx.moveTo(project.x(gx), 0);
    ctx.lineTo(project.x(gx), height);
    ctx.stroke();
  }
  for (let gz = Math.ceil(BOUNDS.minZ / 1000) * 1000; gz <= BOUNDS.maxZ; gz += 1000) {
    ctx.beginPath();
    ctx.moveTo(0, project.y(gz));
    ctx.lineTo(width, project.y(gz));
    ctx.stroke();
  }

  // Depth rings, then terrain (flat island discs if terrain fails).
  ctx.save();
  ctx.setLineDash([3, 5]);
  ctx.strokeStyle = 'rgba(143,200,255,0.22)';
  for (const isle of ISLANDS) {
    for (const ring of [1.28, 1.55]) {
      ctx.beginPath();
      ctx.arc(project.x(isle.centre.x), project.y(isle.centre.z), isle.radius * ring * project.scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
  if (!terrainCanvas) {
    try { terrainCanvas = buildTerrain(); } catch { terrainCanvas = null; }
  }
  if (terrainCanvas) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(terrainCanvas, project.x(BOUNDS.minX), project.y(BOUNDS.minZ),
      (BOUNDS.maxX - BOUNDS.minX) * project.scale, (BOUNDS.maxZ - BOUNDS.minZ) * project.scale);
    ctx.restore();
  } else {
    ctx.fillStyle = '#4E7A3A';
    for (const isle of ISLANDS) {
      ctx.beginPath();
      ctx.arc(project.x(isle.centre.x), project.y(isle.centre.z), isle.radius * project.scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Strips (destination/target highlighted), then the route.
  const type = definition ? definition.type : null;
  const targetStripId = definition
    ? (type === 'delivery' ? definition.destinationStripId : type === 'precision' ? definition.targetStripId : null)
    : null;
  for (const strip of STRIPS) {
    paintStrip(ctx, project, strip, !!targetStripId && strip.id === String(targetStripId).toLowerCase());
  }

  const home = STRIPS[0];
  const homePt = [project.x(home.position.x), project.y(home.position.z)];
  let routeLabel = null;
  if (type === 'ring') routeLabel = routeForRings(ctx, project, definition, homePt, compact);
  else if (type === 'cargo') routeLabel = routeForCargo(ctx, project, definition, homePt, compact);
  else if (type === 'delivery') routeLabel = routeForDelivery(ctx, project, definition, homePt, compact);
  else if (type === 'precision') routeLabel = routeForPrecision(ctx, project, definition, compact);

  // Home field badge.
  ctx.save();
  ctx.beginPath();
  ctx.arc(homePt[0], homePt[1], compact ? 4 : 7, 0, Math.PI * 2);
  ctx.fillStyle = '#C93A36';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#F2EDE4';
  ctx.stroke();
  ctx.restore();

  if (!compact) {
    const place = makeLabelPlacer(ctx, width, height);
    const islandSize = width >= 500 ? 11 : 9.5;
    const routeSize = width >= 500 ? 12 : 10.5;
    const stripSpots = [
      { dx: 0, dy: -20, align: 'center' }, { dx: 0, dy: 22, align: 'center' },
      { dx: -14, dy: 0, align: 'right' }, { dx: 14, dy: 0, align: 'left' },
      { dx: 0, dy: -34, align: 'center' }, { dx: 0, dy: 36, align: 'center' },
    ];
    if (routeLabel) {
      place(routeLabel.text, routeLabel.x, routeLabel.y, stripSpots,
        { size: routeSize, weight: '800', color: routeLabel.color });
    }
    // Skip the home label when the route label already names home.
    if (!routeLabel || routeLabel.stripId !== home.id) {
      place('AURORA FIELD', homePt[0], homePt[1],
        [{ dx: 0, dy: -16, align: 'center' }, ...stripSpots.slice(1)],
        { size: islandSize, weight: '800', color: '#FFD9A0' });
    }
    for (const isle of ISLANDS) {
      const rPx = isle.radius * project.scale;
      place(isle.name.toUpperCase(), project.x(isle.centre.x), project.y(isle.centre.z), [
        { dx: 0, dy: rPx + 11, align: 'center' },
        { dx: 0, dy: -rPx - 11, align: 'center' },
        { dx: rPx + 8, dy: 0, align: 'left' },
        { dx: -rPx - 8, dy: 0, align: 'right' },
        { dx: rPx * 0.7, dy: rPx + 11, align: 'left' },
        { dx: -rPx * 0.7, dy: rPx + 11, align: 'right' },
        { dx: rPx * 0.7, dy: -rPx - 11, align: 'left' },
        { dx: -rPx * 0.7, dy: -rPx - 11, align: 'right' },
      ], { size: islandSize, weight: '700', color: 'rgba(242,237,228,0.82)', letterSpacing: '1.5px' });
    }

    paintCompass(ctx, width - 44, 50, 22);
    // 1 km scale bar.
    const barY = height - 22;
    const km = 1000 * project.scale;
    ctx.fillStyle = 'rgba(242,237,228,0.9)';
    ctx.fillRect(20, barY, km, 4);
    ctx.fillStyle = 'rgba(6,14,26,0.9)';
    ctx.fillRect(20 + km / 2, barY, km / 2, 4);
    paintLabel(ctx, '1 KM', 20 + km + 8, barY + 2, { size: 11, align: 'left' });
  }

  // Double-rule chart frame.
  ctx.strokeStyle = 'rgba(242,237,228,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(3.5, 3.5, width - 7, height - 7);
  ctx.strokeStyle = 'rgba(255,209,102,0.35)';
  ctx.strokeRect(7.5, 7.5, width - 15, height - 15);
  ctx.restore();
}

/** A chart canvas element (2x backing store) for `missionLike`. */
export function createMissionChart(cssWidth, cssHeight, missionLike, options) {
  const canvas = newCanvas(cssWidth * 2, cssHeight * 2);
  if (!canvas) return null;
  canvas.className = 'mission-chart';
  if (canvas.style) {
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(2, 2);
    drawMissionChart(ctx, cssWidth, cssHeight, missionLike, options);
  }
  return canvas;
}

/** Redraw an existing chart canvas for another mission. */
export function redrawMissionChart(canvas, cssWidth, cssHeight, missionLike, options) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  drawMissionChart(ctx, cssWidth, cssHeight, missionLike, options);
}
