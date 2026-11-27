// hud-instruments.js — glass flight instruments + the target bracket.
//
// Two groups of pure canvas draw functions (context, size, values):
//   * the chase/tower pair — attitude indicator and engine tachometer,
//     wired to live panels by createHudInstruments below;
//   * the concept gauges — altimeter/V-S dial, airspeed dial, flaps
//     gauge, labelled bar, radar minimap — neon cyan/gold on dark
//     glass, drawn into backing-store pixels like the pair above.
// Plus a screen-space bracket that locks onto the next target in the
// 3D view. Display only: reads plane state and the render camera,
// writes neither. Panels redraw only when a shown value moves, at
// most ~30 times a second.

import { cameraLink } from './camera-link.js';

const STAGE_W = 1280;
const STAGE_H = 720;
const ADI_PX = 132;
const ENG_W = 132;
const ENG_H = 108;
const BACKING = 2; // 2x backing store keeps lines crisp at any stage scale
const REDRAW_MS = 33;
const RPM_MAX = 2800;
const FONT = 'AuroraSans, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

const C = {
  skyTop: '#16407e',
  skyHorizon: '#5f9fe0',
  groundHorizon: '#9a6a3c',
  groundBottom: '#4b301b',
  ink: '#FFFFFF',
  amber: '#FFD166',
  amberDeep: '#FF9F1C',
  green: '#7DFFB2',
  red: '#FF3B30',
  bezelLight: '#5b636e',
  bezelDark: '#0c0f14',
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rad = (deg) => (deg * Math.PI) / 180;
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const font = (weight, px) => `${weight} ${Math.max(6, Math.round(px))}px ${FONT}`;

// ------------------------------------------------------------ shared bits

// Brushed dark bezel ring with four slotted screws.
function bezel(ctx, cx, cy, outerR, innerR) {
  const g = ctx.createLinearGradient(cx - outerR, cy - outerR, cx + outerR, cy + outerR);
  g.addColorStop(0, C.bezelLight);
  g.addColorStop(0.45, '#2a3038');
  g.addColorStop(1, C.bezelDark);
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.arc(cx, cy, outerR - 0.75, Math.PI * 1.05, Math.PI * 1.7);
  ctx.stroke();
  const midR = (outerR + innerR) / 2;
  const screwR = (outerR - innerR) * 0.22;
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const sx = cx + Math.cos(a) * midR;
    const sy = cy + Math.sin(a) * midR;
    ctx.beginPath();
    ctx.arc(sx, sy, screwR, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1e24';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx - screwR * 0.7, sy);
    ctx.lineTo(sx + screwR * 0.7, sy);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.stroke();
  }
}

// Diagonal glass sheen + edge vignette, clipped to a circle.
function sheen(ctx, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  const g = ctx.createLinearGradient(0, cy - r, 0, cy + r * 0.2);
  g.addColorStop(0, 'rgba(255,255,255,0.16)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.03)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.15, cy - r * 0.45, r * 0.95, r * 0.55, -0.25, 0, Math.PI * 2);
  ctx.fill();
  const v = ctx.createRadialGradient(cx, cy, r * 0.7, cx, cy, r);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = v;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

// Centred text at a point.
function text(ctx, str, x, y, px, color, weight = '800') {
  ctx.fillStyle = color;
  ctx.font = font(weight, px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
}

// One radial tick line between two radii at an angle.
function tick(ctx, cx, cy, angle, r1, r2) {
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
  ctx.lineTo(cx + Math.cos(angle) * r2, cy + Math.sin(angle) * r2);
  ctx.stroke();
}

// ------------------------------------------------------- attitude (ADI)

/**
 * Attitude indicator. pitchDeg nose-up positive; rollDeg right-bank
 * positive. The horizon rolls against the bank and slides down as the
 * nose rises; the roll pointer rides with the sky.
 */
export function drawAttitudeIndicator(ctx, size, pitchDeg, rollDeg) {
  const c = size / 2;
  const outer = size * 0.48;
  const r = size * 0.39;
  const pxPerDeg = r / 28;
  const roll = rad(clamp(rollDeg, -180, 180));
  const pitch = clamp(pitchDeg, -60, 60);
  ctx.clearRect(0, 0, size, size);

  // Ball: sky / ground / horizon / ladder in the rolled frame.
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(c, c);
  ctx.rotate(-roll);
  ctx.translate(0, pitch * pxPerDeg);
  const span = r * 4;
  const sky = ctx.createLinearGradient(0, -span / 2, 0, 0);
  sky.addColorStop(0, C.skyTop);
  sky.addColorStop(1, C.skyHorizon);
  ctx.fillStyle = sky;
  ctx.fillRect(-span, -span, span * 2, span);
  const ground = ctx.createLinearGradient(0, 0, 0, span / 2);
  ground.addColorStop(0, C.groundHorizon);
  ground.addColorStop(1, C.groundBottom);
  ctx.fillStyle = ground;
  ctx.fillRect(-span, 0, span * 2, span);
  ctx.fillStyle = C.ink;
  ctx.fillRect(-span, -1.5, span * 2, 3);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 2;
  ctx.font = font('800', size * 0.07);
  ctx.textBaseline = 'middle';
  for (let deg = -40; deg <= 40; deg += 5) {
    if (deg === 0) continue;
    const y = -deg * pxPerDeg;
    const major = deg % 10 === 0;
    const half = major ? r * 0.3 : r * 0.14;
    ctx.globalAlpha = Math.abs(y + pitch * pxPerDeg) > r * 0.9 ? 0.35 : 1;
    ctx.beginPath();
    ctx.moveTo(-half, y);
    ctx.lineTo(half, y);
    ctx.stroke();
    if (major) {
      const label = String(Math.abs(deg));
      ctx.textAlign = 'right';
      ctx.fillText(label, -half - 4, y);
      ctx.textAlign = 'left';
      ctx.fillText(label, half + 4, y);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // Fixed bank scale, amber zero chevron, sky-riding roll pointer.
  ctx.save();
  ctx.translate(c, c);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 2;
  for (const t of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const long = Math.abs(t) === 30 || Math.abs(t) === 60;
    tick(ctx, 0, 0, rad(t) - Math.PI / 2, r - 1, r - (long ? r * 0.16 : r * 0.09));
  }
  ctx.fillStyle = C.amber;
  ctx.beginPath();
  ctx.moveTo(0, -r + r * 0.13);
  ctx.lineTo(-r * 0.07, -r + 1);
  ctx.lineTo(r * 0.07, -r + 1);
  ctx.closePath();
  ctx.fill();
  ctx.rotate(-roll);
  ctx.fillStyle = C.ink;
  ctx.beginPath();
  ctx.moveTo(0, -r + r * 0.15);
  ctx.lineTo(-r * 0.075, -r + r * 0.29);
  ctx.lineTo(r * 0.075, -r + r * 0.29);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Fixed aircraft symbol: amber wings, dark outline, centre dot.
  ctx.save();
  ctx.translate(c, c);
  ctx.lineJoin = 'round';
  const wing = r * 0.5;
  const drop = r * 0.1;
  const wings = () => {
    ctx.beginPath();
    ctx.moveTo(-wing, 0);
    ctx.lineTo(-wing * 0.38, 0);
    ctx.lineTo(-wing * 0.2, drop);
    ctx.moveTo(wing, 0);
    ctx.lineTo(wing * 0.38, 0);
    ctx.lineTo(wing * 0.2, drop);
  };
  wings();
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 7;
  ctx.stroke();
  wings();
  ctx.strokeStyle = C.amber;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.055, 0, Math.PI * 2);
  ctx.fillStyle = C.amber;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.stroke();
  ctx.restore();

  sheen(ctx, c, c, r);
  bezel(ctx, c, c, outer, r);
}

// -------------------------------------------------------- engine gauge

/** Tachometer: 240° sweep, green/red arcs, needle, digital RPM + RUN/OFF. */
export function drawEngineGauge(ctx, width, height, rpm, engineOn) {
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2;
  const cy = height * 0.585; // caption (CSS) owns the top ~18%
  const r = Math.min(width * 0.34, height * 0.37);
  const START = Math.PI * (5 / 6);
  const SWEEP = Math.PI * (4 / 3);
  const at = (v) => START + (clamp(v, 0, RPM_MAX) / RPM_MAX) * SWEEP;

  const face = ctx.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r * 1.15);
  face.addColorStop(0, '#1d2530');
  face.addColorStop(1, '#07090d');
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.08, 0, Math.PI * 2);
  ctx.fillStyle = face;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.stroke();

  const band = (from, to, color) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.94, at(from), at(to));
    ctx.strokeStyle = color;
    ctx.lineWidth = r * 0.11;
    ctx.stroke();
  };
  // Full throttle is 2700 RPM (600 + 2100): redline sits above it so a
  // normal takeoff never reads as an over-rev fault.
  band(1800, 2600, C.green);
  band(2750, RPM_MAX, C.red);

  ctx.strokeStyle = C.ink;
  ctx.fillStyle = C.ink;
  ctx.font = font('800', r * 0.26);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let v = 0; v <= RPM_MAX; v += 200) {
    const major = v % 1000 === 0;
    ctx.lineWidth = major ? 3 : 1.5;
    tick(ctx, cx, cy, at(v), r * 0.84, r * (major ? 0.66 : 0.75));
    if (major) {
      const a = at(v);
      ctx.fillText(String(v / 100), cx + Math.cos(a) * r * 0.48, cy + Math.sin(a) * r * 0.48);
    }
  }

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(at(rpm));
  ctx.shadowColor = 'rgba(255,209,102,0.8)';
  ctx.shadowBlur = 8;
  ctx.fillStyle = C.amber;
  ctx.beginPath();
  ctx.moveTo(-r * 0.14, -r * 0.045);
  ctx.lineTo(r * 0.9, 0);
  ctx.lineTo(-r * 0.14, r * 0.045);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.1, 0, Math.PI * 2);
  ctx.fillStyle = '#2a3038';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  text(ctx, String(Math.round(rpm / 10) * 10), cx, cy + r * 0.52, r * 0.34, rpm > 2750 ? C.red : C.ink);
  text(ctx, engineOn ? 'RUN' : 'OFF', cx, cy + r * 0.84, r * 0.19, engineOn ? C.green : C.amberDeep);
}

// --------------------------------------------------------- concept dials
// Neon cyan/gold on dark glass. Every function is pure and bounded:
// fixed tick counts, no state beyond its arguments.

const NEON = {
  cyan: '#3FE8FF',
  cyanBright: '#A8F6FF',
  cyanDim: 'rgba(63,232,255,0.35)',
  cyanFaint: 'rgba(63,232,255,0.16)',
  gold: '#FFC94D',
  goldBright: '#FFE9A8',
  goldDeep: '#FF9F1C',
  faceTop: '#18242f',
  faceBottom: '#04070c',
  panelTop: 'rgba(10,18,28,0.92)',
  panelBottom: 'rgba(3,6,11,0.94)',
  seaTop: '#0a2e42',
  seaBottom: '#020a12',
};

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

// Panel screw: dark head, bright rim, slot at a parked angle.
function screw(ctx, x, y, r, slotAngle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = '#141a21';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = Math.max(0.75, r * 0.14);
  ctx.stroke();
  ctx.rotate(slotAngle);
  ctx.beginPath();
  ctx.moveTo(-r * 0.68, 0);
  ctx.lineTo(r * 0.68, 0);
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth = Math.max(1, r * 0.22);
  ctx.stroke();
  ctx.restore();
}

// Dark glass face with two faint machined rings.
function dialFace(ctx, cx, cy, r) {
  const g = ctx.createRadialGradient(cx, cy - r * 0.35, r * 0.08, cx, cy, r * 1.12);
  g.addColorStop(0, NEON.faceTop);
  g.addColorStop(0.65, '#0a1119');
  g.addColorStop(1, NEON.faceBottom);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (const f of [0.62, 0.82]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * f, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Glowing cyan rim + gold pinstripe outside the bezel.
function neonRim(ctx, cx, cy, outerR) {
  ctx.save();
  ctx.shadowColor = 'rgba(63,232,255,0.65)';
  ctx.shadowBlur = Math.max(4, outerR * 0.1);
  ctx.beginPath();
  ctx.arc(cx, cy, outerR - Math.max(1, outerR * 0.012), 0, Math.PI * 2);
  ctx.strokeStyle = NEON.cyan;
  ctx.lineWidth = Math.max(1.5, outerR * 0.022);
  ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, outerR * 0.985, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,201,77,0.55)';
  ctx.lineWidth = Math.max(0.75, outerR * 0.008);
  ctx.stroke();
}

// Tapered needle along +X after rotation, counterweight disc at the tail.
function needle(ctx, cx, cy, angle, len, tail, halfW, color, glow) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = Math.max(3, len * 0.07);
  }
  ctx.beginPath();
  ctx.moveTo(len, 0);
  ctx.lineTo(-tail * 0.4, -halfW);
  ctx.lineTo(-tail * 0.4, halfW);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.lineWidth = Math.max(0.75, halfW * 0.22);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-tail, 0, halfW * 1.55, 0, Math.PI * 2);
  ctx.fillStyle = '#10161e';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = Math.max(0.75, halfW * 0.2);
  ctx.stroke();
  ctx.restore();
}

// Machined hub with a gold centre pip and a slot line.
function hub(ctx, cx, cy, r) {
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#4a545f');
  g.addColorStop(0.55, '#232b34');
  g.addColorStop(1, '#0b0f14');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = Math.max(0.75, r * 0.09);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.34, 0, Math.PI * 2);
  ctx.fillStyle = NEON.gold;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.55, cy);
  ctx.lineTo(cx + r * 0.55, cy);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = Math.max(0.75, r * 0.12);
  ctx.stroke();
}

// Inset digital window: dark glass, cyan edge, glowing figures.
function digitalWindow(ctx, cx, cy, w, h, main, sub, color) {
  const x = cx - w / 2;
  const y = cy - h / 2;
  roundedRect(ctx, x, y, w, h, h * 0.22);
  ctx.fillStyle = 'rgba(2,6,10,0.88)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(63,232,255,0.5)';
  ctx.lineWidth = Math.max(1, h * 0.045);
  ctx.stroke();
  ctx.save();
  ctx.shadowColor = 'rgba(63,232,255,0.55)';
  ctx.shadowBlur = h * 0.22;
  ctx.fillStyle = color || NEON.cyanBright;
  ctx.font = font('800', h * (sub ? 0.46 : 0.58));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(main, cx, sub ? cy - h * 0.14 : cy + 1);
  ctx.restore();
  if (sub) text(ctx, sub, cx, cy + h * 0.28, h * 0.26, 'rgba(255,233,168,0.85)', '700');
}

// Standard round-dial frame: face … sheen, bezel, neon rim.
function dialFrame(ctx, size) {
  const c = size / 2;
  const outer = size * 0.48;
  const r = size * 0.395;
  ctx.clearRect(0, 0, size, size);
  dialFace(ctx, c, c, r);
  return {
    c, r,
    finish() {
      sheen(ctx, c, c, r);
      bezel(ctx, c, c, outer, r);
      neonRim(ctx, c, c, outer);
    },
  };
}

/**
 * Altimeter + vertical-speed dial. Long needle: one turn = 1000 m
 * (numerals are hundreds); short needle: one turn = 10,000 m. Cyan
 * V/S needle rides the right-hand arc (-20…+10 m/s).
 */
export function drawAltVsDial(ctx, size, altM, vsMs) {
  const altitude = Math.max(0, num(altM, 0));
  const vs = clamp(num(vsMs, 0), -20, 10);
  const { c, r, finish } = dialFrame(ctx, size);

  const altAt = (m) => -Math.PI / 2 + (m / 1000) * Math.PI * 2;
  const vsAt = (v) => rad(-55 + ((10 - v) / 30) * 110);

  const vsBand = (from, to, color) => {
    ctx.beginPath();
    ctx.arc(c, c, r * 0.8, vsAt(from), vsAt(to));
    ctx.strokeStyle = color;
    ctx.lineWidth = r * 0.055;
    ctx.stroke();
  };
  vsBand(10, 0, 'rgba(63,232,255,0.75)');
  vsBand(0, -10, 'rgba(255,201,77,0.8)');
  vsBand(-10, -20, 'rgba(255,59,48,0.85)');

  // Altitude ticks, one batched path per weight class.
  ctx.strokeStyle = C.ink;
  const groups = [
    { match: (m) => m % 100 === 0, r2: 0.86, alpha: 1, w: Math.max(1.75, size * 0.008) },
    { match: (m) => m % 100 !== 0 && m % 20 === 0, r2: 0.905, alpha: 0.85, w: Math.max(1, size * 0.004) },
    { match: (m) => m % 20 !== 0, r2: 0.94, alpha: 0.45, w: Math.max(1, size * 0.004) },
  ];
  for (const g of groups) {
    ctx.globalAlpha = g.alpha;
    ctx.lineWidth = g.w;
    ctx.beginPath();
    for (let m = 0; m < 1000; m += 10) {
      if (!g.match(m)) continue;
      const a = altAt(m);
      ctx.moveTo(c + Math.cos(a) * r * 0.985, c + Math.sin(a) * r * 0.985);
      ctx.lineTo(c + Math.cos(a) * r * g.r2, c + Math.sin(a) * r * g.r2);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (let n = 0; n < 10; n++) {
    const a = altAt(n * 100);
    text(ctx, String(n), c + Math.cos(a) * r * 0.66, c + Math.sin(a) * r * 0.66, size * 0.088, C.ink);
  }

  ctx.strokeStyle = NEON.cyanBright;
  for (const v of [10, 5, 0, -5, -10, -15, -20]) {
    const a = vsAt(v);
    const major = v % 10 === 0;
    ctx.lineWidth = major ? Math.max(1.5, size * 0.006) : Math.max(1, size * 0.004);
    tick(ctx, c, c, a, r * 0.845, r * (major ? 0.775 : 0.8));
    if (major) {
      text(ctx, (v > 0 ? '+' : '') + v, c + Math.cos(a) * r * 0.885, c + Math.sin(a) * r * 0.885, size * 0.038, NEON.cyanBright, '700');
    }
  }

  text(ctx, 'ALT', c, c - r * 0.44, size * 0.062, NEON.cyanBright);
  text(ctx, 'x100 M', c, c - r * 0.32, size * 0.036, 'rgba(255,255,255,0.55)', '700');
  text(ctx, 'V/S', c + r * 0.52, c + r * 0.34, size * 0.04, NEON.cyan);
  text(ctx, 'AURORA POST', c, c + r * 0.8, size * 0.03, 'rgba(255,255,255,0.35)', '700');

  needle(ctx, c, c, vsAt(vs), r * 0.8, r * 0.16, r * 0.016, NEON.cyan, 'rgba(63,232,255,0.8)');
  needle(ctx, c, c, -Math.PI / 2 + (altitude / 10000) * Math.PI * 2, r * 0.5, r * 0.18, r * 0.045, NEON.goldDeep, 'rgba(255,159,28,0.55)');
  needle(ctx, c, c, altAt(altitude % 1000), r * 0.9, r * 0.2, r * 0.026, NEON.goldBright, 'rgba(255,201,77,0.8)');
  hub(ctx, c, c, r * 0.085);

  // Narrow + low so the 5/6 numerals stay clear of the window.
  digitalWindow(ctx, c, c + r * 0.6, r * 0.74, r * 0.32,
    `${Math.round(altitude)} M`, `V/S ${vs > 0 ? '+' : ''}${vs.toFixed(1)}`, NEON.cyanBright);
  finish();
}

/**
 * Airspeed dial: 240° sweep from lower-left. Arcs follow the game's
 * speeds — approach 18-25, green 25-58, amber 58-65, red 65-max m/s.
 * maxSpeedMs falls back to 80 when missing or implausible.
 */
export function drawSpeedDial(ctx, size, speedMs, maxSpeedMs) {
  const speed = Math.max(0, num(speedMs, 0));
  let maxSpeed = num(maxSpeedMs, 80);
  if (maxSpeed < 40 || maxSpeed > 200) maxSpeed = 80;
  const { c, r, finish } = dialFrame(ctx, size);
  const START = Math.PI * (5 / 6);
  const SWEEP = Math.PI * (4 / 3);
  const at = (v) => START + (clamp(v, 0, maxSpeed) / maxSpeed) * SWEEP;

  const band = (from, to, color) => {
    if (to <= from) return;
    ctx.beginPath();
    ctx.arc(c, c, r * 0.9, at(from), at(Math.min(to, maxSpeed)));
    ctx.strokeStyle = color;
    ctx.lineWidth = r * 0.085;
    ctx.stroke();
  };
  band(18, 25, 'rgba(255,201,77,0.75)');
  band(25, 58, 'rgba(125,255,178,0.8)');
  band(58, 65, 'rgba(255,201,77,0.9)');
  band(65, maxSpeed, 'rgba(255,59,48,0.9)');

  ctx.strokeStyle = C.ink;
  for (let v = 0; v <= maxSpeed; v += 2) {
    const major = v % 10 === 0;
    const minor = v % 5 === 0;
    ctx.globalAlpha = major ? 1 : minor ? 0.85 : 0.4;
    ctx.lineWidth = major ? Math.max(1.75, size * 0.008) : Math.max(1, size * 0.004);
    tick(ctx, c, c, at(v), r * 0.82, r * (major ? 0.68 : minor ? 0.74 : 0.78));
    if (major) {
      ctx.globalAlpha = 1;
      const a = at(v);
      text(ctx, String(v), c + Math.cos(a) * r * 0.53, c + Math.sin(a) * r * 0.53, size * 0.062, C.ink);
    }
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = C.red;
  ctx.lineWidth = Math.max(2, size * 0.009);
  for (const v of [18, 65]) {
    if (v > maxSpeed) continue;
    tick(ctx, c, c, at(v), r * 0.96, r * 0.82);
  }

  text(ctx, 'SPD', c, c - r * 0.34, size * 0.066, NEON.cyanBright);
  text(ctx, 'M/S', c, c - r * 0.22, size * 0.036, 'rgba(255,255,255,0.55)', '700');
  if (speed > 0 && speed < 18) text(ctx, 'STALL', c, c + r * 0.3, size * 0.045, C.red);
  else if (speed > 65) text(ctx, 'OVERSPEED', c, c + r * 0.3, size * 0.04, C.red);
  text(ctx, 'AURORA POST', c, c + r * 0.8, size * 0.03, 'rgba(255,255,255,0.35)', '700');

  needle(ctx, c, c, at(speed), r * 0.86, r * 0.22, r * 0.03, NEON.goldBright, 'rgba(255,201,77,0.8)');
  hub(ctx, c, c, r * 0.085);
  digitalWindow(ctx, c, c + r * 0.56, r * 0.92, r * 0.3,
    `${Math.round(speed)} M/S`, null, speed > 65 ? '#FF8A80' : NEON.cyanBright);
  finish();
}

// ------------------------------------------------------------ flaps gauge

/**
 * Vertical FLAPS gauge. flap01: 0 = UP, 0.5 = APPROACH, 1 = FULL
 * (the game's three stages; values between ride between detents).
 */
export function drawFlapsGauge(ctx, width, height, flap01) {
  const flap = clamp(num(flap01, 0), 0, 1);
  ctx.clearRect(0, 0, width, height);
  const pad = Math.max(2, Math.min(width, height) * 0.03);
  const panelR = Math.min(width, height) * 0.08;

  const panel = ctx.createLinearGradient(0, 0, 0, height);
  panel.addColorStop(0, NEON.panelTop);
  panel.addColorStop(1, NEON.panelBottom);
  roundedRect(ctx, pad, pad, width - pad * 2, height - pad * 2, panelR);
  ctx.fillStyle = panel;
  ctx.fill();
  ctx.save();
  ctx.shadowColor = 'rgba(63,232,255,0.45)';
  ctx.shadowBlur = Math.max(3, width * 0.04);
  ctx.strokeStyle = NEON.cyanDim;
  ctx.lineWidth = Math.max(1, width * 0.012);
  ctx.stroke();
  ctx.restore();
  const sr = Math.max(2, width * 0.035);
  const inset = pad + sr * 1.4;
  screw(ctx, inset, inset, sr, 0.6);
  screw(ctx, width - inset, inset, sr, 2.1);
  screw(ctx, inset, height - inset, sr, 1.2);
  screw(ctx, width - inset, height - inset, sr, 2.8);

  text(ctx, 'FLAPS', width / 2, height * 0.1, Math.min(width * 0.17, height * 0.1), NEON.cyanBright);

  // Tiny airfoil, flap segment deflected by the current setting.
  const wingX = width * 0.5;
  const wingY = height * 0.185;
  const chord = width * 0.52;
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = Math.max(1.25, width * 0.016);
  ctx.beginPath();
  ctx.moveTo(wingX - chord / 2, wingY);
  ctx.quadraticCurveTo(wingX - chord * 0.1, wingY - height * 0.035, wingX + chord * 0.18, wingY);
  ctx.stroke();
  const flapA = flap * rad(38);
  ctx.strokeStyle = NEON.gold;
  ctx.beginPath();
  ctx.moveTo(wingX + chord * 0.18, wingY);
  ctx.lineTo(wingX + chord * 0.18 + Math.cos(flapA) * chord * 0.3, wingY + Math.sin(flapA) * chord * 0.3);
  ctx.stroke();

  const trackX = width * 0.3;
  const trackW = Math.max(6, width * 0.16);
  const trackTop = height * 0.26;
  const trackBottom = height * 0.8;
  const trackH = trackBottom - trackTop;
  const yFor = (v) => trackBottom - v * trackH;

  roundedRect(ctx, trackX, trackTop, trackW, trackH, trackW * 0.3);
  ctx.fillStyle = 'rgba(2,6,10,0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = Math.max(1, width * 0.01);
  ctx.stroke();

  if (flap > 0.001) {
    const fill = ctx.createLinearGradient(0, trackBottom, 0, trackTop);
    fill.addColorStop(0, NEON.cyan);
    fill.addColorStop(0.55, '#7DFFB2');
    fill.addColorStop(1, NEON.gold);
    ctx.save();
    ctx.shadowColor = 'rgba(63,232,255,0.7)';
    ctx.shadowBlur = Math.max(3, width * 0.05);
    roundedRect(ctx, trackX + 1.5, yFor(flap), trackW - 3, trackBottom - yFor(flap) - 1.5, trackW * 0.24);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  for (let s = 0; s <= 10; s++) {
    const major = s % 5 === 0;
    ctx.lineWidth = major ? Math.max(1.5, width * 0.014) : Math.max(1, width * 0.008);
    ctx.beginPath();
    ctx.moveTo(trackX - (major ? width * 0.09 : width * 0.055), yFor(s / 10));
    ctx.lineTo(trackX - width * 0.015, yFor(s / 10));
    ctx.stroke();
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const [v, name] of [[0, 'UP'], [0.5, 'APPR'], [1, 'FULL']]) {
    const y = yFor(v);
    const active = Math.abs(flap - v) < 0.04;
    ctx.strokeStyle = active ? NEON.gold : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = Math.max(1.25, width * 0.012);
    ctx.beginPath();
    ctx.moveTo(trackX + trackW + width * 0.02, y);
    ctx.lineTo(trackX + trackW + width * 0.1, y);
    ctx.stroke();
    ctx.fillStyle = active ? NEON.goldBright : 'rgba(255,255,255,0.65)';
    ctx.font = font('800', Math.min(width * 0.13, height * 0.075));
    ctx.fillText(name, trackX + trackW + width * 0.13, y);
  }

  // Gold pointer riding the track's right edge.
  const py = yFor(flap);
  ctx.save();
  ctx.shadowColor = 'rgba(255,201,77,0.85)';
  ctx.shadowBlur = Math.max(3, width * 0.05);
  ctx.fillStyle = NEON.gold;
  ctx.beginPath();
  ctx.moveTo(trackX + trackW + width * 0.015, py);
  ctx.lineTo(trackX + trackW + width * 0.11, py - height * 0.022);
  ctx.lineTo(trackX + trackW + width * 0.11, py + height * 0.022);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const stageNames = ['UP', 'APPROACH', 'FULL'];
  const readout = `${stageNames[clamp(Math.round(flap * 2), 0, 2)]} · ${Math.round(flap * 100)}%`;
  let readoutPx = Math.min(width * 0.13, height * 0.08);
  ctx.font = font('800', readoutPx);
  while (readoutPx > 6 && ctx.measureText(readout).width > width * 0.86) {
    readoutPx -= 1;
    ctx.font = font('800', readoutPx);
  }
  text(ctx, readout, width / 2, height * 0.905, readoutPx, NEON.goldBright);

  ctx.save();
  roundedRect(ctx, pad, pad, width - pad * 2, height - pad * 2, panelR);
  ctx.clip();
  const g = ctx.createLinearGradient(0, 0, width * 0.5, height);
  g.addColorStop(0, 'rgba(255,255,255,0.09)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.015)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

// ------------------------------------------------------------ labelled bar

/**
 * Horizontal labelled bar (THROTTLE / WIND / RPM style). value01 is
 * clamped to 0..1, valueText drawn verbatim top-right, color any CSS
 * colour (defaults to neon cyan).
 */
export function drawLabelledBar(ctx, width, height, label, value01, valueText, color) {
  const value = clamp(num(value01, 0), 0, 1);
  const barColor = typeof color === 'string' && color ? color : NEON.cyan;
  ctx.clearRect(0, 0, width, height);
  const padX = Math.max(2, width * 0.015);
  ctx.textBaseline = 'middle';
  ctx.font = font('800', Math.max(7, Math.min(height * 0.34, width * 0.085)));
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.textAlign = 'left';
  ctx.fillText(String(label || '').toUpperCase(), padX, height * 0.26);
  ctx.fillStyle = NEON.goldBright;
  ctx.textAlign = 'right';
  ctx.fillText(String(valueText == null ? '' : valueText), width - padX, height * 0.26);

  const trackW = width - padX * 2;
  const trackH = Math.max(4, height * 0.3);
  const trackY = height * 0.52;
  roundedRect(ctx, padX, trackY, trackW, trackH, trackH * 0.35);
  ctx.fillStyle = 'rgba(2,6,10,0.8)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = Math.max(1, height * 0.02);
  ctx.stroke();

  if (value > 0.001) {
    ctx.save();
    ctx.shadowColor = barColor;
    ctx.shadowBlur = Math.max(3, height * 0.16);
    roundedRect(ctx, padX + 1.5, trackY + 1.5, Math.max(2, value * trackW - 3), trackH - 3, trackH * 0.28);
    ctx.fillStyle = barColor;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(padX + 2, trackY + 2, Math.max(0, value * trackW - 4), Math.max(1, trackH * 0.22));
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(padX + value * trackW - Math.max(1, height * 0.03), trackY + 1, Math.max(1.5, height * 0.045), trackH - 2);
  }

  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  for (let s = 1; s < 20; s++) {
    ctx.fillRect(padX + (s / 20) * trackW, trackY + 1.5, 1, trackH - 3);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = Math.max(1, height * 0.02);
  for (let s = 0; s <= 4; s++) {
    const x = padX + (s / 4) * trackW;
    ctx.beginPath();
    ctx.moveTo(x, trackY + trackH + height * 0.04);
    ctx.lineTo(x, trackY + trackH + height * 0.13);
    ctx.stroke();
  }
}

// ------------------------------------------------------------ radar scope

/**
 * Circular north-up radar minimap (independent of holo-map.js).
 * state = { planeX, planeZ, headingDeg, targetX, targetZ,
 *   hasTargetPosition, target: {x,z}, islands, strips, worldSize,
 *   sweepDeg | timeMs | timeSeconds } — every field optional.
 */
export function drawRadarMinimap(ctx, size, state) {
  const s = state || {};
  const planeX = num(s.planeX, 0);
  const planeZ = num(s.planeZ, 0);
  const headingDeg = num(s.headingDeg, 0);
  const worldSize = Math.max(1000, num(s.worldSize, 12000));
  const islands = Array.isArray(s.islands) ? s.islands : [];
  const strips = Array.isArray(s.strips) ? s.strips : [];
  const targetPos = s.target && typeof s.target.x === 'number' && typeof s.target.z === 'number' ? s.target : null;
  const hasTarget = s.hasTargetPosition === true || targetPos !== null;
  const targetX = targetPos ? targetPos.x : num(s.targetX, 0);
  const targetZ = targetPos ? targetPos.z : num(s.targetZ, 0);
  const timeMs = num(s.timeMs, num(s.timeSeconds, 0) * 1000);
  const sweepDeg = typeof s.sweepDeg === 'number' && Number.isFinite(s.sweepDeg)
    ? s.sweepDeg : ((timeMs / 45) % 360 + 360) % 360;
  const sweepRad = rad(sweepDeg); // compass: 0 = north, clockwise

  const { c, r, finish } = (() => {
    const cc = size / 2;
    const outer = size * 0.48;
    const rr = size * 0.395;
    ctx.clearRect(0, 0, size, size);
    return {
      c: cc, r: rr,
      finish() {
        sheen(ctx, cc, cc, rr);
        bezel(ctx, cc, cc, outer, rr);
        neonRim(ctx, cc, cc, outer);
      },
    };
  })();
  const scale = (r * 2) / worldSize;
  const toScope = (x, z) => ({ x: c + x * scale, y: c + z * scale });

  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.clip();
  const sea = ctx.createRadialGradient(c, c, r * 0.05, c, c, r);
  sea.addColorStop(0, NEON.seaTop);
  sea.addColorStop(1, NEON.seaBottom);
  ctx.fillStyle = sea;
  ctx.fillRect(c - r, c - r, r * 2, r * 2);

  ctx.strokeStyle = NEON.cyanFaint;
  ctx.lineWidth = Math.max(1, size * 0.003);
  for (const f of [1 / 3, 2 / 3, 1]) {
    ctx.beginPath();
    ctx.arc(c, c, r * f, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let spoke = 0; spoke < 8; spoke++) {
    const a = (spoke * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    ctx.stroke();
  }

  // Sweep: fading trail sectors behind the leading edge.
  const sweepCanvas = sweepRad - Math.PI / 2;
  const trailSteps = 22;
  const trailSpan = rad(75);
  for (let step = trailSteps; step >= 1; step--) {
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, r, sweepCanvas - (step / trailSteps) * trailSpan, sweepCanvas - ((step - 1) / trailSteps) * trailSpan);
    ctx.closePath();
    ctx.fillStyle = `rgba(63,232,255,${(0.16 * (1 - step / (trailSteps + 1))).toFixed(3)})`;
    ctx.fill();
  }
  ctx.save();
  ctx.shadowColor = 'rgba(63,232,255,0.9)';
  ctx.shadowBlur = Math.max(3, size * 0.012);
  ctx.strokeStyle = NEON.cyanBright;
  ctx.lineWidth = Math.max(1.5, size * 0.005);
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.lineTo(c + Math.cos(sweepCanvas) * r, c + Math.sin(sweepCanvas) * r);
  ctx.stroke();
  ctx.restore();

  const sweepGlow = (pt) => {
    const blip = Math.atan2(pt.x - c, -(pt.y - c));
    let diff = (sweepRad - blip) % (Math.PI * 2);
    if (diff < 0) diff += Math.PI * 2;
    return diff < trailSpan ? 1 - diff / trailSpan : 0;
  };

  // Island blips: sand underlay + green lobes + cyan rim, brightening
  // as the sweep passes. Satellite lobes (seeded by index) break the
  // perfect-circle read.
  islands.forEach((isle, index) => {
    const pos = isle.centre || isle.center || isle.position || { x: 0, z: 0 };
    const pt = toScope(num(pos.x, 0), num(pos.z, 0));
    const rPx = Math.max(2.5, num(isle.radius, 0) * scale * 0.88);
    const glow = sweepGlow(pt);
    const lobes = [
      [0, 0, 1],
      [Math.cos(index * 2.39) * 0.55, Math.sin(index * 2.39) * 0.55, 0.55],
      [Math.cos(index * 4.71 + 1.3) * 0.5, Math.sin(index * 4.71 + 1.3) * 0.5, 0.45],
    ];
    const blob = (grow) => {
      for (const [dx, dy, f] of lobes) {
        ctx.beginPath();
        ctx.arc(pt.x + dx * rPx, pt.y + dy * rPx, rPx * f + grow, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    ctx.fillStyle = `rgba(217,179,128,${(0.75 + glow * 0.25).toFixed(3)})`;
    blob(1.5);
    ctx.fillStyle = glow > 0.5 ? '#6fae4e' : '#4E7A3A';
    blob(0);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, rPx, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(63,232,255,${(0.35 + glow * 0.55).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, size * 0.003);
    ctx.stroke();
  });

  ctx.fillStyle = NEON.goldBright;
  for (const strip of strips) {
    const pos = strip.position || strip.centre || strip.center || { x: 0, z: 0 };
    const pt = toScope(num(pos.x, 0), num(pos.z, 0));
    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(rad(num(strip.headingDeg, 0)));
    const len = Math.max(5, size * 0.028);
    ctx.fillRect(-Math.max(1, size * 0.004), -len / 2, Math.max(2, size * 0.008), len);
    ctx.restore();
  }

  if (hasTarget) {
    const pt = toScope(targetX, targetZ);
    const pulse = 0.5 + 0.5 * Math.sin(timeMs / 320);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, size * 0.02 + pulse * size * 0.012, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(125,255,178,${(0.85 - pulse * 0.45).toFixed(3)})`;
    ctx.lineWidth = Math.max(1.25, size * 0.004);
    ctx.stroke();
    const d = Math.max(3.5, size * 0.016);
    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = C.green;
    ctx.fillRect(-d / 1.6, -d / 1.6, d * 1.25, d * 1.25);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = Math.max(1, size * 0.003);
    ctx.strokeRect(-d / 1.6, -d / 1.6, d * 1.25, d * 1.25);
    ctx.restore();
  }

  // Own-ship wedge + heading ray.
  const ship = toScope(planeX, planeZ);
  const hdg = rad(headingDeg);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = Math.max(1, size * 0.003);
  ctx.beginPath();
  ctx.moveTo(ship.x, ship.y);
  ctx.lineTo(ship.x + Math.sin(hdg) * r * 0.22, ship.y - Math.cos(hdg) * r * 0.22);
  ctx.stroke();
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(hdg);
  const wedge = Math.max(5, size * 0.028);
  ctx.beginPath();
  ctx.moveTo(0, -wedge);
  ctx.lineTo(wedge * 0.72, wedge * 0.85);
  ctx.lineTo(0, wedge * 0.38);
  ctx.lineTo(-wedge * 0.72, wedge * 0.85);
  ctx.closePath();
  ctx.fillStyle = '#F2EDE4';
  ctx.fill();
  ctx.strokeStyle = '#D64541';
  ctx.lineWidth = Math.max(1, size * 0.004);
  ctx.stroke();
  ctx.restore();
  ctx.restore();

  // Rim degree ticks + cardinal letters (outside the clip).
  ctx.strokeStyle = NEON.cyanDim;
  for (let deg = 0; deg < 360; deg += 10) {
    const a = rad(deg) - Math.PI / 2;
    const major = deg % 30 === 0;
    ctx.lineWidth = major ? Math.max(1.5, size * 0.005) : Math.max(1, size * 0.003);
    tick(ctx, c, c, a, r * 0.985, r * (major ? 0.9 : 0.94));
    if (major && deg % 90 !== 0) {
      text(ctx, String(deg / 10), c + Math.cos(a) * r * 0.82, c + Math.sin(a) * r * 0.82, size * 0.034, 'rgba(168,246,255,0.65)', '700');
    }
  }
  text(ctx, 'N', c, c - r * 0.84, size * 0.055, NEON.gold);
  text(ctx, 'E', c + r * 0.84, c, size * 0.045, NEON.cyanBright);
  text(ctx, 'S', c, c + r * 0.84, size * 0.045, NEON.cyanBright);
  text(ctx, 'W', c - r * 0.84, c, size * 0.045, NEON.cyanBright);
  ctx.fillStyle = NEON.gold;
  ctx.beginPath();
  ctx.moveTo(c, c - r * 0.99);
  ctx.lineTo(c - size * 0.018, c - r * 0.93);
  ctx.lineTo(c + size * 0.018, c - r * 0.93);
  ctx.closePath();
  ctx.fill();
  text(ctx, `RNG ${Math.round(worldSize / 2000)} KM`, c, c + r * 0.68, size * 0.032, 'rgba(168,246,255,0.6)', '700');

  finish();
}

// ------------------------------------------------- panels + target bracket

function instrumentPanel(stage, id, cssW, cssH, label) {
  const panel = document.createElement('div');
  panel.className = 'hud-panel hud-flight-only hud-secondary hud-instrument';
  panel.id = id;
  const canvas = document.createElement('canvas');
  canvas.width = cssW * BACKING;
  canvas.height = cssH * BACKING;
  canvas.className = 'hud-instrument-canvas';
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  panel.appendChild(canvas);
  if (label) {
    const caption = document.createElement('div');
    caption.className = 'hud-instrument-label';
    caption.textContent = label;
    panel.appendChild(caption);
  }
  stage.appendChild(panel);
  return { panel, canvas, context: canvas.getContext('2d') };
}

// Project a world point through the live camera onto the 1280x720
// stage. Null when behind the camera or no camera is linked. The
// result object is reused — read it before the next call.
const projected = { x: 0, y: 0, depth: 0, focal: 0 };
function projectToStage(camera, x, y, z) {
  if (!camera || !camera.matrixWorldInverse || !camera.projectionMatrix) return null;
  const v = camera.matrixWorldInverse.elements;
  const p = camera.projectionMatrix.elements;
  const vx = v[0] * x + v[4] * y + v[8] * z + v[12];
  const vy = v[1] * x + v[5] * y + v[9] * z + v[13];
  const vz = v[2] * x + v[6] * y + v[10] * z + v[14];
  if (vz > -1) return null;
  const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
  if (!(cw > 0)) return null;
  const ndcX = (p[0] * vx + p[4] * vy + p[8] * vz + p[12]) / cw;
  const ndcY = (p[1] * vx + p[5] * vy + p[9] * vz + p[13]) / cw;
  const winW = window.innerWidth || STAGE_W;
  const winH = window.innerHeight || STAGE_H;
  const scale = Math.min(winW / STAGE_W, winH / STAGE_H) || 1;
  projected.x = (((ndcX + 1) / 2) * winW - (winW - STAGE_W * scale) / 2) / scale;
  projected.y = (((1 - ndcY) / 2) * winH - (winH - STAGE_H * scale) / 2) / scale;
  projected.depth = -vz;
  projected.focal = (p[5] * winH) / 2 / scale; // stage px per unit at depth 1
  return projected;
}

// World-space radius the bracket should hug, by target kind.
function targetRadius(label) {
  const t = String(label || '');
  if (/^ring/i.test(t)) return 10.5;
  if (/strip|field/i.test(t)) return 20;
  return 25;
}

/**
 * Build the instruments onto the HUD stage. Returns
 * { update(state, plane) } — `state` is hud.js's extracted HUD state,
 * `plane` the raw PlaneState (pitchDeg / rollDeg / throttle / engineOn).
 */
export function createHudInstruments(stage) {
  const adi = instrumentPanel(stage, 'hud-adi-panel', ADI_PX, ADI_PX, '');
  const engine = instrumentPanel(stage, 'hud-engine-panel', ENG_W, ENG_H, 'ENGINE RPM');

  const bracket = document.createElement('div');
  bracket.id = 'hud-target-bracket';
  bracket.className = 'hud-flight-only';
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    const piece = document.createElement('span');
    piece.className = `bracket-corner bracket-${corner}`;
    bracket.appendChild(piece);
  }
  const tag = document.createElement('div');
  tag.className = 'bracket-tag';
  bracket.appendChild(tag);
  stage.appendChild(bracket);

  let lastDrawMs = -Infinity;
  let lastAdiKey = '';
  let lastEngineKey = '';
  let lastBracketKey = '';
  let lastPanelsDisplay = null;

  function updateBracket(state) {
    const camera = cameraLink.camera;
    const target = state.targetWorld;
    let visible = false;
    let coversCentre = false;
    if (camera && target && state.cameraMode !== 'tower') {
      const pt = projectToStage(camera, target.x, target.y, target.z);
      if (pt) {
        // Cap the bracket at 240px across so it cannot swallow the
        // flight-path marker and toast.
        const half = clamp((targetRadius(state.targetLabel) / pt.depth) * pt.focal * 1.18, 16, 120);
        if (pt.x > -half && pt.x < STAGE_W + half && pt.y > -half && pt.y < STAGE_H + half) {
          visible = true;
          coversCentre = Math.abs(pt.x - STAGE_W / 2) < half && Math.abs(pt.y - STAGE_H / 2) < half;
          const key = `${Math.round(pt.x)},${Math.round(pt.y)},${Math.round(half)}`;
          if (key !== lastBracketKey) {
            lastBracketKey = key;
            bracket.style.transform = `translate(${Math.round(pt.x * 10) / 10}px,${Math.round(pt.y * 10) / 10}px)`;
            bracket.style.width = `${Math.round(half * 2)}px`;
            bracket.style.height = `${Math.round(half * 2)}px`;
            bracket.style.marginLeft = `${-Math.round(half)}px`;
            bracket.style.marginTop = `${-Math.round(half)}px`;
          }
          const metres = state.targetDistanceMetres;
          const tagText = typeof metres === 'number' && Number.isFinite(metres)
            ? (metres >= 1000 ? `${(metres / 1000).toFixed(1)} KM` : `${Math.round(metres)} M`)
            : '';
          if (tag.textContent !== tagText) tag.textContent = tagText;
          // Low on screen the tag flips above the box so it never
          // prints across the cockpit gauges. Threshold 520 keeps it
          // below at both 1280x720 and 768x480 (where the bracket is
          // larger in stage px and the box bottom lands lower).
          const tagAbove = pt.y + half > 520;
          if (tag.classList.contains('tag-above') !== tagAbove) tag.classList.toggle('tag-above', tagAbove);
        }
      }
    }
    const display = visible ? '' : 'none';
    if (bracket.style.display !== display) bracket.style.display = display;
    // One centre cue at a time: hide the flight-path marker (via
    // visibility, leaving hud.js display logic alone) while the
    // bracket covers screen centre.
    const marker = stage.querySelector('#hud-flightpath');
    if (marker) {
      const vis = coversCentre ? 'hidden' : '';
      if (marker.style.visibility !== vis) marker.style.visibility = vis;
    }
  }

  function update(state, plane) {
    updateBracket(state);
    // The cockpit has its own lit six-pack; the glass pair is for the
    // outside views only.
    const panelsDisplay = state.cameraMode === 'cockpit' ? 'none' : '';
    if (panelsDisplay !== lastPanelsDisplay) {
      lastPanelsDisplay = panelsDisplay;
      adi.panel.style.display = panelsDisplay;
      engine.panel.style.display = panelsDisplay;
    }
    if (panelsDisplay === 'none') return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastDrawMs < REDRAW_MS && state.forceHud !== true) return;
    lastDrawMs = now;

    const pitchDeg = plane && typeof plane.pitchDeg === 'number' ? plane.pitchDeg : 0;
    const rollDeg = plane && typeof plane.rollDeg === 'number' ? plane.rollDeg : 0;
    const adiKey = `${pitchDeg.toFixed(1)}/${rollDeg.toFixed(1)}`;
    if (adi.context && adiKey !== lastAdiKey) {
      lastAdiKey = adiKey;
      adi.context.setTransform(1, 0, 0, 1, 0, 0);
      drawAttitudeIndicator(adi.context, ADI_PX * BACKING, pitchDeg, rollDeg);
    }

    const engineOn = !plane || plane.engineOn !== false;
    const throttle = plane && typeof plane.throttle === 'number' ? plane.throttle : 0;
    const rpm = engineOn ? 600 + clamp(throttle, 0, 1) * 2100 : 0;
    const engineKey = `${Math.round(rpm / 10)}${engineOn ? 'on' : 'off'}`;
    if (engine.context && engineKey !== lastEngineKey) {
      lastEngineKey = engineKey;
      engine.context.setTransform(1, 0, 0, 1, 0, 0);
      drawEngineGauge(engine.context, ENG_W * BACKING, ENG_H * BACKING, rpm, engineOn);
    }
  }

  return { update };
}
