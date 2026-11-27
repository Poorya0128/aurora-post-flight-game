// AURORA POST — HUD FULL (new glass HUD, replaces round-dial concept HUD).
// Pure view: every displayed value comes from the flightState object `fs`
// passed to update(). This module never reads sim/plane/mission state.
// Spec: hud-spec-fa.md (2026-11-27) + hud-target-full.png.
// API: createFullHud(rootEl) -> { update(fs), setMode(mode), getMode(), dispose() }
// mode ∈ 'FULL' | 'MINIMAL' | 'OFF'. Styling lives in concept-ui.css
// (/* === CONCEPT: HUD FULL === */). Canvas: heading tape, centre guidance,
// speed tape, altitude tape + VS strip, circular minimap. DOM text is
// written only when the rendered string changes; canvases redraw only
// when their value key changes (minimap additionally capped at ~15 Hz).

const FONT_STACK = '"AuroraSans", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const COL = {
  cyan: '#3EF2FF',
  green: '#4CFF9A',
  amber: '#FFB547',
  red: '#FF5A5A',
  white: '#FFFFFF',
  label: 'rgba(255,255,255,0.60)',
  dim: 'rgba(255,255,255,0.35)',
  panelLine: 'rgba(255,255,255,0.12)',
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
function wrap360(d) { d %= 360; return d < 0 ? d + 360 : d; }
function wrap180(d) { d = wrap360(d); return d > 180 ? d - 360 : d; }
function pad2(v) { return v < 10 ? '0' + v : String(v); }
function pad3(v) { const s = String(Math.round(v)); return s.length >= 3 ? s : ('00' + s).slice(-3); }
function fmtClock(sec) {
  const s = Math.max(0, Math.floor(num(sec, 0)));
  return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
}
function fmtDist(m) {
  m = num(m, 0);
  if (m >= 1000) return (m / 1000).toFixed(1) + ' km';
  return Math.round(m) + ' m';
}
function fmtEta(sec) {
  const s = Math.max(0, Math.round(num(sec, 0)));
  return Math.floor(s / 60) + ':' + pad2(s % 60);
}
function fmtFuelTime(h) {
  const totalMin = Math.max(0, Math.round(num(h, 0) * 60));
  return Math.floor(totalMin / 60) + ':' + pad2(totalMin % 60) + ' h';
}
function signed1(v) { const r = Math.round(num(v, 0) * 10) / 10; return (r > 0 ? '+' : '') + r.toFixed(1) + '°'; }

export function createFullHud(rootEl) {
  if (!rootEl) throw new Error('createFullHud requires a root element');

  let mode = 'FULL';
  let disposed = false;
  const cache = new Map();
  function setText(node, key, text) {
    const v = String(text);
    if (cache.get(key) === v) return;
    cache.set(key, v);
    node.textContent = v;
  }
  function setStyle(node, key, prop, value) {
    const k = key + ':' + prop;
    if (cache.get(k) === value) return;
    cache.set(k, value);
    node.style[prop] = value;
  }
  function setFlag(node, key, cls, on) {
    const k = key + ':cls:' + cls;
    const v = on ? '1' : '0';
    if (cache.get(k) === v) return;
    cache.set(k, v);
    node.classList.toggle(cls, !!on);
  }

  // ---------- DOM build ----------
  const root = el('div', 'hf-root hf-mode-full');
  root.setAttribute('aria-hidden', 'true');
  rootEl.appendChild(root);

  function zone(cls) { const z = el('div', 'hf-zone ' + cls); root.appendChild(z); return z; }
  function panel(parent, cls) { const p = el('div', 'hf-panel' + (cls ? ' ' + cls : '')); parent.appendChild(p); return p; }
  function screws(p) {
    for (const pos of ['tl', 'tr', 'bl', 'br']) p.appendChild(el('span', 'hf-screw hf-screw-' + pos));
  }
  function canvasIn(parent, cls) {
    const c = document.createElement('canvas');
    c.className = 'hf-canvas ' + cls;
    parent.appendChild(c);
    return c;
  }

  /* ZONE 1: TOP-LEFT — mode chip, AP/A/T/FD chips, wind, OAT/QNH */
  const zTL = zone('hf-tl');
  const tlRow1 = el('div', 'hf-row');
  const modeChip = el('div', 'hf-chip hf-chip-mode', 'APPROACH');
  tlRow1.appendChild(modeChip);
  const apGroup = panel(tlRow1, 'hf-ap-group');
  const apChips = {};
  for (const [k, label] of [['ap', 'AP'], ['at', 'A/T'], ['fd', 'FD']]) {
    const c = el('span', 'hf-ap-chip');
    c.appendChild(el('span', 'hf-ap-name', label));
    c.appendChild(el('span', 'hf-ap-state', 'OFF'));
    apGroup.appendChild(c);
    apChips[k] = c;
  }
  zTL.appendChild(tlRow1);
  const tlRow2 = el('div', 'hf-row');
  const windPanel = panel(tlRow2, 'hf-wind-panel');
  screws(windPanel);
  const windArrow = el('span', 'hf-wind-arrow');
  windArrow.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3 12 L18 12 M13 6 L19 12 L13 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const windTextBox = el('span', 'hf-wind-textbox');
  windTextBox.appendChild(el('span', 'hf-label', 'WIND'));
  const windValue = el('span', 'hf-value', '270° / 6 kt');
  windTextBox.appendChild(windValue);
  windPanel.appendChild(windArrow);
  windPanel.appendChild(windTextBox);
  const oatPanel = panel(tlRow2, 'hf-oat-panel');
  const oatLine = el('div', 'hf-kv');
  oatLine.appendChild(el('span', 'hf-label', 'OAT'));
  const oatValue = el('span', 'hf-value', '18°C');
  oatLine.appendChild(oatValue);
  const qnhLine = el('div', 'hf-kv');
  qnhLine.appendChild(el('span', 'hf-label', 'QNH'));
  const qnhValue = el('span', 'hf-value', '1013');
  qnhLine.appendChild(qnhValue);
  oatPanel.appendChild(oatLine);
  oatPanel.appendChild(qnhLine);
  zTL.appendChild(tlRow2);

  /* ZONE 2: TOP-CENTRE — score capsule + mission card */
  const zTC = zone('hf-tc');
  const capsule = panel(zTC, 'hf-capsule');
  const capTime = el('span', 'hf-cap-time', '00:00');
  const capScore = el('span', 'hf-cap-score', 'SCORE 0');
  const capCombo = el('span', 'hf-cap-combo', 'x1.0 COMBO');
  capsule.appendChild(capTime);
  capsule.appendChild(el('span', 'hf-cap-sep', '·'));
  capsule.appendChild(capScore);
  capsule.appendChild(el('span', 'hf-cap-sep', '·'));
  capsule.appendChild(capCombo);
  const missionCard = panel(zTC, 'hf-mission-card');
  screws(missionCard);
  const missionTitle = el('div', 'hf-mission-title', '—');
  const missionSub = el('div', 'hf-mission-sub', '');
  missionCard.appendChild(missionTitle);
  missionCard.appendChild(missionSub);
  const goalRows = [];
  for (let i = 0; i < 3; i++) {
    const row = el('div', 'hf-goal');
    const box = el('span', 'hf-goal-box', '');
    const lab = el('span', 'hf-goal-label', '');
    row.appendChild(box);
    row.appendChild(lab);
    missionCard.appendChild(row);
    goalRows.push({ row, box, lab });
  }

  /* ZONE 3: TOP-RIGHT — heading tape + destination card */
  const zTR = zone('hf-tr');
  const hdgPanel = panel(zTR, 'hf-hdg-panel');
  const hdgCanvas = canvasIn(hdgPanel, 'hf-hdg-canvas');
  const hdgValueBox = el('div', 'hf-hdg-value', '000°');
  hdgPanel.appendChild(hdgValueBox);
  const destCard = panel(zTR, 'hf-dest-card');
  const destRwy = el('div', 'hf-kv');
  destRwy.appendChild(el('span', 'hf-label', 'RWY'));
  const rwyValue = el('span', 'hf-value hf-cyan', '01');
  destRwy.appendChild(rwyValue);
  const destDist = el('div', 'hf-kv');
  destDist.appendChild(el('span', 'hf-label', 'DIST'));
  const distValue = el('span', 'hf-value', '—');
  destDist.appendChild(distValue);
  const destEta = el('div', 'hf-kv');
  destEta.appendChild(el('span', 'hf-label', 'ETA'));
  const etaValue = el('span', 'hf-value hf-cyan', '—');
  destEta.appendChild(etaValue);
  destCard.appendChild(destRwy);
  destCard.appendChild(destDist);
  destCard.appendChild(destEta);

  /* ZONE 4: CENTRE GUIDANCE — FPM, pitch ladder, bank arc, GS/LOC, chevrons (canvas) */
  const zC = zone('hf-centre');
  const guideCanvas = canvasIn(zC, 'hf-guide-canvas');

  /* ZONE 5: LEFT EDGE — speed tape + GS/MACH */
  const zL = zone('hf-left');
  const spdPanel = panel(zL, 'hf-tape-panel hf-spd-panel');
  const spdCanvas = canvasIn(spdPanel, 'hf-spd-canvas');
  const spdValueBox = el('div', 'hf-tape-value hf-spd-value', '0 m/s');
  spdPanel.appendChild(spdValueBox);
  const gsPanel = panel(zL, 'hf-gs-panel');
  const gsLine = el('div', 'hf-kv');
  gsLine.appendChild(el('span', 'hf-label', 'GS'));
  const gsValue = el('span', 'hf-value', '0.0 m/s');
  gsLine.appendChild(gsValue);
  const machLine = el('div', 'hf-kv');
  machLine.appendChild(el('span', 'hf-label', 'MACH'));
  const machValue = el('span', 'hf-value', '0.00');
  machLine.appendChild(machValue);
  gsPanel.appendChild(gsLine);
  gsPanel.appendChild(machLine);

  /* ZONE 6: RIGHT EDGE — altitude tape + VS strip + RA + AoA */
  const zR = zone('hf-right');
  const altPanel = panel(zR, 'hf-tape-panel hf-alt-panel');
  const altCanvas = canvasIn(altPanel, 'hf-alt-canvas');
  const altValueBox = el('div', 'hf-tape-value hf-alt-value', '0 m');
  altPanel.appendChild(altValueBox);
  const raPanel = panel(zR, 'hf-ra-panel');
  const raLine = el('div', 'hf-kv');
  raLine.appendChild(el('span', 'hf-label', 'RA'));
  const raValue = el('span', 'hf-value', '— m');
  raLine.appendChild(raValue);
  raPanel.appendChild(raLine);
  const aoaPanel = panel(zR, 'hf-aoa-panel');
  aoaPanel.appendChild(el('div', 'hf-label', 'AoA'));
  const aoaValue = el('div', 'hf-value hf-aoa-value', '0.0°');
  aoaPanel.appendChild(aoaValue);

  /* ZONE 7: BOTTOM-LEFT — circular minimap + PITCH/ROLL/YAW card */
  const zBL = zone('hf-bl');
  const mapPanel = panel(zBL, 'hf-map-panel');
  const mapCanvas = canvasIn(mapPanel, 'hf-map-canvas');
  const pryCard = panel(zBL, 'hf-pry-card');
  const pryRows = {};
  for (const [k, label] of [['pitch', 'PITCH'], ['roll', 'ROLL'], ['yaw', 'YAW']]) {
    const row = el('div', 'hf-kv');
    row.appendChild(el('span', 'hf-label hf-cyan', label));
    const v = el('span', 'hf-value', '+0.0°');
    row.appendChild(v);
    pryCard.appendChild(row);
    pryRows[k] = v;
  }

  /* ZONE 8: BOTTOM-CENTRE — system chips + destination bar (ONLY dest bar) */
  const zBC = zone('hf-bc');
  const sysRow = el('div', 'hf-sys-row');
  function sysChip(label) {
    const c = panel(sysRow, 'hf-sys-chip');
    c.appendChild(el('div', 'hf-label', label));
    const v = el('div', 'hf-sys-value', '—');
    c.appendChild(v);
    return { chip: c, value: v };
  }
  const flapsChip = sysChip('FLAPS');
  const gearChip = sysChip('GEAR');
  const brakesChip = sysChip('BRAKES');
  const lightsChip = sysChip('LIGHTS');
  const spoilersChip = sysChip('SPOILERS');
  zBC.appendChild(sysRow);
  const destBar = panel(zBC, 'hf-dest-bar');
  const destBarText = el('div', 'hf-dest-bar-text', '▲ —');
  const destProgress = el('div', 'hf-dest-progress');
  const destProgressFill = el('span', 'hf-dest-progress-fill');
  destProgress.appendChild(destProgressFill);
  destBar.appendChild(destBarText);
  destBar.appendChild(destProgress);

  /* ZONE 9: BOTTOM-RIGHT — throttle/RPM/fuel/oil/G/trim + systems strip + caution */
  const zBR = zone('hf-br');
  const engPanel = panel(zBR, 'hf-eng-panel');
  screws(engPanel);
  const thrRow = el('div', 'hf-eng-row hf-thr-row');
  thrRow.appendChild(el('span', 'hf-label hf-cyan', 'THROTTLE'));
  const thrBar = el('span', 'hf-thr-bar');
  const thrFill = el('span', 'hf-thr-fill');
  thrBar.appendChild(thrFill);
  thrRow.appendChild(thrBar);
  const thrPct = el('span', 'hf-value', '0%');
  thrRow.appendChild(thrPct);
  engPanel.appendChild(thrRow);
  function engRow(label, cls) {
    const row = el('div', 'hf-eng-row' + (cls ? ' ' + cls : ''));
    row.appendChild(el('span', 'hf-label hf-cyan', label));
    const v = el('span', 'hf-value hf-eng-value', '—');
    row.appendChild(v);
    engPanel.appendChild(row);
    return { row, value: v };
  }
  const rpmRow = engRow('RPM');
  const fuelRow = engRow('FUEL');
  const flowOilRow = el('div', 'hf-eng-row hf-eng-row-split');
  flowOilRow.appendChild(el('span', 'hf-label hf-cyan', 'FUEL FLOW'));
  const flowValue = el('span', 'hf-value', '— L/h');
  flowOilRow.appendChild(flowValue);
  flowOilRow.appendChild(el('span', 'hf-label hf-cyan', 'OIL'));
  const oilValue = el('span', 'hf-value', '—°C');
  flowOilRow.appendChild(oilValue);
  engPanel.appendChild(flowOilRow);
  const gTrimRow = el('div', 'hf-eng-row hf-eng-row-split');
  gTrimRow.appendChild(el('span', 'hf-label hf-cyan', 'G-LOAD'));
  const gValue = el('span', 'hf-value', '1.00 g');
  gTrimRow.appendChild(gValue);
  gTrimRow.appendChild(el('span', 'hf-label hf-cyan', 'TRIM'));
  const trimValue = el('span', 'hf-value', '+0.0');
  gTrimRow.appendChild(trimValue);
  engPanel.appendChild(gTrimRow);
  const sysStrip = el('div', 'hf-sys-strip');
  const sysStripText = el('span', 'hf-sys-strip-text', 'ALL SYSTEMS NOMINAL');
  const cautionChip = el('span', 'hf-caution-chip', '');
  sysStrip.appendChild(sysStripText);
  sysStrip.appendChild(cautionChip);
  engPanel.appendChild(sysStrip);

  // ---------- canvas sizing ----------
  const canvases = [
    { c: hdgCanvas, ctx: hdgCanvas.getContext('2d'), w: 0, h: 0, key: '' },
    { c: guideCanvas, ctx: guideCanvas.getContext('2d'), w: 0, h: 0, key: '' },
    { c: spdCanvas, ctx: spdCanvas.getContext('2d'), w: 0, h: 0, key: '' },
    { c: altCanvas, ctx: altCanvas.getContext('2d'), w: 0, h: 0, key: '' },
    { c: mapCanvas, ctx: mapCanvas.getContext('2d'), w: 0, h: 0, key: '', lastMs: 0 },
  ];
  const [HDG, GUIDE, SPD, ALT, MAP] = canvases;
  function sizeCanvases() {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    for (const s of canvases) {
      const r = s.c.getBoundingClientRect();
      const w = Math.max(2, Math.round(r.width));
      const h = Math.max(2, Math.round(r.height));
      if (w !== s.w || h !== s.h) {
        s.w = w; s.h = h;
        s.c.width = Math.round(w * dpr);
        s.c.height = Math.round(h * dpr);
        s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        s.key = ''; // force redraw at new size
      }
    }
  }
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { sizeCanvases(); });
    ro.observe(root);
  }
  window.addEventListener('resize', sizeCanvases);

  // ---------- smoothed display values (~100 ms lerp) ----------
  const sm = { speed: null, alt: null, heading: null, pitch: null, roll: null, vs: null, ra: null, aoa: null };
  let lastMs = 0;
  function smooth(fs) {
    const now = performance.now();
    const dt = lastMs ? clamp((now - lastMs) / 1000, 0, 0.25) : 0;
    lastMs = now;
    const a = dt > 0 ? 1 - Math.exp(-dt / 0.1) : 1;
    function lerp(key, target) {
      if (sm[key] === null || a >= 1) sm[key] = target;
      else sm[key] += (target - sm[key]) * a;
      return sm[key];
    }
    lerp('speed', num(fs.speedMs, 0));
    lerp('alt', num(fs.altM, 0));
    // heading: shortest-path lerp
    const hTarget = wrap360(num(fs.headingDeg, 0));
    if (sm.heading === null || a >= 1) sm.heading = hTarget;
    else sm.heading = wrap360(sm.heading + wrap180(hTarget - sm.heading) * a);
    lerp('pitch', num(fs.pitchDeg, 0));
    lerp('roll', num(fs.rollDeg, 0));
    lerp('vs', num(fs.vsMs, 0));
    lerp('ra', num(fs.raM, 0));
    lerp('aoa', num(fs.aoaDeg, 0));
  }

  // ---------- canvas painters ----------
  function glow(ctx, colour, blur) { ctx.shadowColor = colour; ctx.shadowBlur = blur; }
  function noGlow(ctx) { ctx.shadowBlur = 0; }

  /* ZONE 3 painter: heading tape (ticks 5°, labels 30° as 330/000/030) */
  function drawHeading(headingDeg) {
    const { ctx, w, h } = HDG;
    if (!ctx || w < 10) return;
    const key = Math.round(headingDeg * 2) + ':' + w + 'x' + h;
    if (key === HDG.key) return;
    HDG.key = key;
    ctx.clearRect(0, 0, w, h);
    const pxPerDeg = w / 100; // ±50° visible
    const cx = w / 2;
    ctx.font = '700 11px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const start = Math.floor((headingDeg - 55) / 5) * 5;
    for (let d = start; d <= headingDeg + 55; d += 5) {
      const x = cx + (d - headingDeg) * pxPerDeg;
      if (x < -20 || x > w + 20) continue;
      const wrapped = wrap360(d);
      const is30 = Math.round(wrapped) % 30 === 0;
      const is10 = Math.round(wrapped) % 10 === 0;
      const tickH = is30 ? 10 : is10 ? 7 : 4;
      ctx.strokeStyle = is30 ? COL.white : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, h - 2);
      ctx.lineTo(x, h - 2 - tickH);
      ctx.stroke();
      if (is30) {
        ctx.fillStyle = COL.white;
        ctx.fillText(pad3(wrapped), x, 2);
      }
    }
    // centre caret
    glow(ctx, COL.cyan, 5);
    ctx.fillStyle = COL.cyan;
    ctx.beginPath();
    ctx.moveTo(cx - 6, h - 14);
    ctx.lineTo(cx + 6, h - 14);
    ctx.lineTo(cx, h - 5);
    ctx.closePath();
    ctx.fill();
    noGlow(ctx);
    // edge fades
    const fadeL = ctx.createLinearGradient(0, 0, 26, 0);
    fadeL.addColorStop(0, 'rgba(10,14,22,0.9)');
    fadeL.addColorStop(1, 'rgba(10,14,22,0)');
    ctx.fillStyle = fadeL;
    ctx.fillRect(0, 0, 26, h);
    const fadeR = ctx.createLinearGradient(w, 0, w - 26, 0);
    fadeR.addColorStop(0, 'rgba(10,14,22,0.9)');
    fadeR.addColorStop(1, 'rgba(10,14,22,0)');
    ctx.fillStyle = fadeR;
    ctx.fillRect(w - 26, 0, 26, h);
  }

  /* ZONE 4 painter: centre guidance (ladder, bank arc, FPM, GS/LOC, chevrons) */
  function drawGuidance(fs) {
    const { ctx, w, h } = GUIDE;
    if (!ctx || w < 40) return;
    const pitch = sm.pitch, roll = sm.roll;
    const fpm = fs.fpm || {};
    const key = [Math.round(pitch * 5), Math.round(roll * 5),
      Math.round(num(fpm.xDeg, 0) * 5), Math.round(num(fpm.yDeg, 0) * 5),
      Math.round(num(fs.glideslopeDev, 0) * 40), Math.round(num(fs.localizerDev, 0) * 40),
      fs.onPath || 'none', w + 'x' + h].join(':');
    if (key === GUIDE.key) return;
    GUIDE.key = key;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const pxPerDeg = h / 60; // ±30° vertical span (keeps ±10 lines clear of the bank arc)
    const rollRad = (roll * Math.PI) / 180;
    // Bright-sky legibility: every guidance stroke gets a dark under-stroke
    // beneath the 1.5px colour line + soft glow; labels get a dark outline.
    const OUTLINE = 'rgba(6,12,20,0.62)';
    function strokeOut(colour, width, blur) {
      noGlow(ctx);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = width + 2.2;
      ctx.stroke();
      glow(ctx, colour, blur);
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.stroke();
      noGlow(ctx);
    }
    function fillOut(colour, blur) {
      glow(ctx, colour, blur);
      ctx.fillStyle = colour;
      ctx.fill();
      noGlow(ctx);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    function textOut(text, x, y, colour) {
      ctx.strokeStyle = 'rgba(6,12,20,0.78)';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = colour;
      ctx.fillText(text, x, y);
    }

    // --- pitch ladder (rotates with roll, slides with pitch) ---
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-rollRad);
    ctx.font = '700 11px ' + FONT_STACK;
    ctx.textBaseline = 'middle';
    for (const deg of [-10, -5, 5, 10]) {
      const y = -(deg - pitch) * pxPerDeg;
      if (Math.abs(y) > h * 0.62) continue;
      const half = deg % 10 === 0 ? 58 : 44;
      const gap = 14;
      ctx.setLineDash(deg < 0 ? [7, 5] : []);
      ctx.beginPath();
      ctx.moveTo(-half, y); ctx.lineTo(-gap, y);
      ctx.moveTo(gap, y); ctx.lineTo(half, y);
      strokeOut(COL.cyan, 1.5, 4);
      ctx.setLineDash([]);
      const label = (deg > 0 ? '+' : '') + deg;
      ctx.textAlign = 'right';
      textOut(label, -half - 5, y, COL.cyan);
      ctx.textAlign = 'left';
      textOut(label, half + 5, y, COL.cyan);
    }
    // horizon line (0°) — longer, with centre gap
    const hy = pitch * pxPerDeg;
    if (Math.abs(hy) < h * 0.62) {
      ctx.beginPath();
      ctx.moveTo(-86, hy); ctx.lineTo(-16, hy);
      ctx.moveTo(16, hy); ctx.lineTo(86, hy);
      strokeOut(COL.cyan, 1.5, 4);
    }
    ctx.restore();

    // --- bank arc (fixed scale, pointer rolls) ---
    const arcR = Math.min(w, h) * 0.36;
    const arcCy = cy + arcR * 0.28;
    const absRoll = Math.abs(roll);
    const bankCol = absRoll > 45 ? COL.red : absRoll > 30 ? COL.amber : COL.cyan;
    ctx.beginPath();
    ctx.arc(cx, arcCy, arcR, Math.PI * 1.22, Math.PI * 1.78);
    strokeOut(bankCol, 1.5, 4);
    ctx.beginPath();
    for (const deg of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
      const a = -Math.PI / 2 + (deg * Math.PI) / 180;
      const len = deg === 0 ? 12 : Math.abs(deg) % 30 === 0 ? 10 : 6;
      ctx.moveTo(cx + Math.cos(a) * arcR, arcCy + Math.sin(a) * arcR);
      ctx.lineTo(cx + Math.cos(a) * (arcR - len), arcCy + Math.sin(a) * (arcR - len));
    }
    strokeOut(bankCol, 1.5, 4);
    // roll pointer (triangle at current roll)
    const pa = -Math.PI / 2 + rollRad;
    const px = cx + Math.cos(pa) * (arcR - 16);
    const py = arcCy + Math.sin(pa) * (arcR - 16);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(pa + 2.5) * 9, py + Math.sin(pa + 2.5) * 9);
    ctx.lineTo(px + Math.cos(pa - 2.5) * 9, py + Math.sin(pa - 2.5) * 9);
    ctx.closePath();
    fillOut(bankCol, 4);

    // --- fixed boresight (aircraft symbol) ---
    ctx.beginPath();
    ctx.moveTo(cx - 26, cy); ctx.lineTo(cx - 8, cy);
    ctx.moveTo(cx + 8, cy); ctx.lineTo(cx + 26, cy);
    strokeOut('rgba(255,255,255,0.9)', 1.5, 0);
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(cx - 2, cy - 2, 4, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(cx - 1, cy - 1, 2, 2);

    // --- flight path marker (circle + 2 wings) ---
    // Clamp to the centre guidance area, never the canvas corners.
    const fx = clamp(cx + num(fpm.xDeg, 0) * pxPerDeg, cx - w * 0.34, cx + w * 0.34);
    const fy = clamp(cy - num(fpm.yDeg, 0) * pxPerDeg, cy - h * 0.34, cy + h * 0.34);
    ctx.beginPath();
    ctx.arc(fx, fy, 9, 0, Math.PI * 2);
    ctx.moveTo(fx - 22, fy); ctx.lineTo(fx - 10, fy);
    ctx.moveTo(fx + 10, fy); ctx.lineTo(fx + 22, fy);
    ctx.moveTo(fx, fy - 16); ctx.lineTo(fx, fy - 10);
    strokeOut(COL.cyan, 1.5, 6); // FPM cyan per target image (spec: cyan = indicators)

    const onPath = fs.onPath || 'none';
    if (onPath !== 'none') {
      const pathCol = onPath === 'good' ? COL.green : COL.amber;
      // --- glideslope (vertical, right of centre) ---
      const gsX = cx + Math.min(w * 0.30, 168);
      const gsHalf = h * 0.20;
      ctx.beginPath();
      ctx.moveTo(gsX, cy - gsHalf); ctx.lineTo(gsX, cy + gsHalf);
      for (const t of [-1, -0.5, 0, 0.5, 1]) {
        const y = cy - t * gsHalf;
        ctx.moveTo(gsX + (t === 0 ? 3.5 : 2.5), y);
        ctx.arc(gsX, y, t === 0 ? 3.5 : 2.5, 0, Math.PI * 2);
      }
      strokeOut('rgba(255,255,255,0.55)', 1.5, 0);
      const gsY = cy - clamp(num(fs.glideslopeDev, 0), -1, 1) * gsHalf;
      ctx.beginPath();
      ctx.moveTo(gsX, gsY - 8); ctx.lineTo(gsX + 7, gsY); ctx.lineTo(gsX, gsY + 8); ctx.lineTo(gsX - 7, gsY);
      ctx.closePath();
      fillOut(pathCol, 6);
      ctx.font = '700 9px ' + FONT_STACK;
      ctx.textAlign = 'center';
      textOut('GS', gsX, cy - gsHalf - 12, COL.label);

      // --- localizer (horizontal, below centre) ---
      const locY = cy + h * 0.30;
      const locHalf = Math.min(w * 0.22, 120);
      ctx.beginPath();
      ctx.moveTo(cx - locHalf, locY); ctx.lineTo(cx + locHalf, locY);
      for (const t of [-1, -0.5, 0, 0.5, 1]) {
        ctx.moveTo(cx + t * locHalf + (t === 0 ? 3.5 : 2.5), locY);
        ctx.arc(cx + t * locHalf, locY, t === 0 ? 3.5 : 2.5, 0, Math.PI * 2);
      }
      strokeOut('rgba(255,255,255,0.55)', 1.5, 0);
      const locX = cx + clamp(num(fs.localizerDev, 0), -1, 1) * locHalf;
      ctx.beginPath();
      ctx.moveTo(locX, locY - 8); ctx.lineTo(locX + 7, locY); ctx.lineTo(locX, locY + 8); ctx.lineTo(locX - 7, locY);
      ctx.closePath();
      fillOut(pathCol, 6);
      textOut('LOC', cx, locY + 16, COL.label);

      // --- runway chevrons (below FPM, pointing up-path) ---
      // Spacing scales with canvas height so the stack never reaches the
      // localizer scale on short canvases (768x480).
      const chevStep = Math.min(13, h * 0.04);
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const yBase = cy + h * 0.15 + i * chevStep;
        const half = 20 - i * 3;
        ctx.moveTo(cx - half, yBase + 8);
        ctx.lineTo(cx, yBase);
        ctx.lineTo(cx + half, yBase + 8);
      }
      strokeOut(pathCol, 2, 5);
    }
  }

  /* ZONE 5 painter: speed tape (green 22-26, red stall <18, trend arrow) */
  function drawSpeedTape(fs) {
    const { ctx, w, h } = SPD;
    if (!ctx || w < 20) return;
    const speed = sm.speed;
    const trend = num(fs.speedTrendMs, speed);
    const key = Math.round(speed * 4) + ':' + Math.round(trend * 4) + ':' + w + 'x' + h;
    if (key === SPD.key) return;
    SPD.key = key;
    ctx.clearRect(0, 0, w, h);
    const cy = h / 2;
    const pxPerUnit = h / 17; // ±8.5 m/s visible
    const yOf = (v) => cy - (v - speed) * pxPerUnit;
    // bands: green target 22–26, red stall <18
    ctx.fillStyle = 'rgba(76,255,154,0.20)';
    ctx.fillRect(0, yOf(26), w, yOf(22) - yOf(26));
    ctx.fillStyle = 'rgba(255,90,90,0.20)';
    ctx.fillRect(0, yOf(18), w, h - yOf(18));
    ctx.fillStyle = COL.green;
    ctx.fillRect(w - 4, yOf(26), 4, yOf(22) - yOf(26));
    ctx.fillStyle = COL.red;
    ctx.fillRect(w - 4, yOf(18), 4, h - yOf(18));
    // ticks + labels (label step widens on short canvases so 11px labels
    // never overlap: every 2 m/s normally, every 5 m/s when pitch < 15px)
    ctx.font = '700 11px ' + FONT_STACK;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelStep = pxPerUnit * 2 >= 15 ? 2 : 5;
    const lo = Math.floor(speed - 9), hi = Math.ceil(speed + 9);
    for (let v = lo; v <= hi; v++) {
      if (v < 0) continue;
      const y = yOf(v);
      if (y < -6 || y > h + 6) continue;
      const major = v % labelStep === 0;
      ctx.strokeStyle = major ? COL.white : 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(w - (major ? 12 : 7), y);
      ctx.lineTo(w, y);
      ctx.stroke();
      if (major && y >= 7 && y <= h - 7) {
        ctx.fillStyle = v < 18 ? COL.red : v >= 22 && v <= 26 ? COL.green : COL.white;
        ctx.fillText(String(v), 3, y);
      }
    }
    // trend arrow (to predicted speed)
    const ty = clamp(yOf(trend), 8, h - 8);
    if (Math.abs(trend - speed) > 0.15) {
      const tCol = trend > speed ? COL.green : COL.amber;
      glow(ctx, tCol, 5);
      ctx.strokeStyle = tCol;
      ctx.fillStyle = tCol;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w - 8, cy);
      ctx.lineTo(w - 8, ty);
      ctx.stroke();
      ctx.beginPath();
      if (trend > speed) { ctx.moveTo(w - 12, ty + 2); ctx.lineTo(w - 4, ty + 2); ctx.lineTo(w - 8, ty - 5); }
      else { ctx.moveTo(w - 12, ty - 2); ctx.lineTo(w - 4, ty - 2); ctx.lineTo(w - 8, ty + 5); }
      ctx.closePath();
      ctx.fill();
      noGlow(ctx);
    }
    // centre caret (value box is DOM, aligned to this line)
    ctx.fillStyle = COL.white;
    ctx.beginPath();
    ctx.moveTo(w, cy - 6); ctx.lineTo(w, cy + 6); ctx.lineTo(w - 7, cy);
    ctx.closePath();
    ctx.fill();
  }

  /* ZONE 6 painter: altitude tape + VS strip (green -2, amber -4, red beyond) */
  function drawAltTape(fs) {
    const { ctx, w, h } = ALT;
    if (!ctx || w < 30) return;
    const alt = sm.alt, vs = sm.vs;
    const key = Math.round(alt * 2) + ':' + Math.round(vs * 10) + ':' + w + 'x' + h;
    if (key === ALT.key) return;
    ALT.key = key;
    ctx.clearRect(0, 0, w, h);
    const cy = h / 2;
    const tapeW = w - 16; // VS strip occupies right 12 px
    const pxPerM = h / 130; // ±65 m visible
    const yOf = (v) => cy - (v - alt) * pxPerM;
    // ground band below 0
    if (yOf(0) < h) {
      ctx.fillStyle = 'rgba(255,181,71,0.14)';
      ctx.fillRect(0, Math.max(0, yOf(0)), tapeW, h);
    }
    ctx.font = '700 11px ' + FONT_STACK;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    // label step widens on short canvases (every 20 m normally, every 50 m
    // when pitch < 15px) so 11px labels never overlap or clip at the edges
    const labelStepM = pxPerM * 20 >= 15 ? 20 : 50;
    const lo = Math.floor((alt - 70) / 10) * 10, hi = Math.ceil((alt + 70) / 10) * 10;
    for (let v = lo; v <= hi; v += 10) {
      const y = yOf(v);
      if (y < -6 || y > h + 6) continue;
      const major = v % labelStepM === 0;
      ctx.strokeStyle = major ? COL.white : 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(major ? 12 : 7, y);
      ctx.stroke();
      if (major && y >= 7 && y <= h - 7) {
        ctx.fillStyle = COL.white;
        ctx.fillText(String(v), tapeW - 3, y);
      }
    }
    // centre caret
    ctx.fillStyle = COL.white;
    ctx.beginPath();
    ctx.moveTo(0, cy - 6); ctx.lineTo(0, cy + 6); ctx.lineTo(7, cy);
    ctx.closePath();
    ctx.fill();
    // --- VS strip ---
    const sx = w - 11, sw = 8;
    const vsHalf = h * 0.42;
    const vsScale = vsHalf / 6; // ±6 m/s full scale
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx, cy - vsHalf, sw, vsHalf * 2);
    for (const t of [-6, -4, -2, 0, 2, 4, 6]) {
      const y = cy - t * vsScale;
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.moveTo(sx - 3, y); ctx.lineTo(sx, y);
      ctx.stroke();
    }
    const vsCol = vs < -4 ? COL.red : vs < -2 ? COL.amber : COL.green;
    const vsY = cy - clamp(vs, -6, 6) * vsScale;
    glow(ctx, vsCol, 4);
    ctx.fillStyle = vsCol;
    ctx.fillRect(sx + 1, Math.min(cy, vsY), sw - 2, Math.max(2, Math.abs(vsY - cy)));
    noGlow(ctx);
    ctx.fillStyle = COL.label;
    ctx.font = '700 8px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.fillText('VS', sx + sw / 2, cy - vsHalf - 7);
  }

  /* ZONE 7 painter: heading-up circular minimap (plane fixed centre) */
  function drawMinimap(fs) {
    const { ctx, w, h } = MAP;
    if (!ctx || w < 30) return;
    const mm = fs.minimap || {};
    const now = performance.now();
    const key = [Math.round(num(mm.planeX, 0) / 5), Math.round(num(mm.planeZ, 0) / 5),
      Math.round(num(mm.headingDeg, 0)), Math.round(num(mm.targetX, 0) / 10),
      Math.round(num(mm.targetZ, 0) / 10), mm.hasTarget ? 1 : 0, w + 'x' + h].join(':');
    if (key === MAP.key && now - MAP.lastMs < 500) return;
    if (now - MAP.lastMs < 66) return; // ≤15 Hz
    MAP.key = key;
    MAP.lastMs = now;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) / 2 - 2;
    const heading = num(mm.headingDeg, 0);
    const worldSize = Math.max(100, num(mm.worldSize, 8000));
    const viewRadius = worldSize * 0.38; // metres to rim
    const scale = R / viewRadius;
    const px = num(mm.planeX, 0), pz = num(mm.planeZ, 0);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    // sea
    ctx.fillStyle = 'rgba(8,26,44,0.92)';
    ctx.fillRect(0, 0, w, h);
    // rotate map so heading is up: world->screen with heading-up rotation
    ctx.translate(cx, cy);
    ctx.rotate(-(heading * Math.PI) / 180);
    // range rings (drawn in rotated frame, still circular)
    ctx.strokeStyle = 'rgba(62,242,255,0.18)';
    ctx.lineWidth = 1;
    for (const f of [0.33, 0.66, 1]) {
      ctx.beginPath();
      ctx.arc(0, 0, R * f, 0, Math.PI * 2);
      ctx.stroke();
    }
    // islands
    for (const isl of (mm.islands || [])) {
      const ix = (num(isl.x, 0) - px) * scale;
      const iz = (num(isl.z, 0) - pz) * scale;
      const ir = Math.max(2, num(isl.radius, 0) * scale);
      if (Math.abs(ix) > R + ir || Math.abs(iz) > R + ir) continue;
      ctx.fillStyle = 'rgba(217,179,128,0.85)';
      ctx.beginPath();
      ctx.arc(ix, iz, ir + 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(78,122,58,0.95)';
      ctx.beginPath();
      ctx.arc(ix, iz, ir, 0, Math.PI * 2);
      ctx.fill();
    }
    // strips
    for (const st of (mm.strips || [])) {
      const sx = (num(st.x, 0) - px) * scale;
      const sz = (num(st.z, 0) - pz) * scale;
      if (Math.abs(sx) > R + 12 || Math.abs(sz) > R + 12) continue;
      ctx.save();
      ctx.translate(sx, sz);
      ctx.rotate((num(st.headingDeg, 0) * Math.PI) / 180);
      ctx.fillStyle = '#E8E2D2';
      ctx.fillRect(-2, -9, 4, 18);
      ctx.fillStyle = 'rgba(10,14,22,0.8)';
      ctx.fillRect(-0.5, -7, 1, 14);
      ctx.restore();
    }
    // route line + target
    if (mm.hasTarget) {
      const tx = (num(mm.targetX, 0) - px) * scale;
      const tz = (num(mm.targetZ, 0) - pz) * scale;
      ctx.strokeStyle = 'rgba(76,255,154,0.75)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(tx, tz);
      ctx.stroke();
      ctx.setLineDash([]);
      if (Math.abs(tx) <= R && Math.abs(tz) <= R) {
        glow(ctx, COL.green, 5);
        ctx.fillStyle = COL.green;
        ctx.beginPath();
        ctx.moveTo(tx, tz - 7); ctx.lineTo(tx + 6, tz); ctx.lineTo(tx, tz + 7); ctx.lineTo(tx - 6, tz);
        ctx.closePath();
        ctx.fill();
        noGlow(ctx);
      }
    }
    ctx.restore();

    // rim + N marker (N sits at -heading on the rim, heading-up map)
    ctx.strokeStyle = 'rgba(62,242,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    const nAng = -Math.PI / 2 - (heading * Math.PI) / 180;
    const nx = cx + Math.cos(nAng) * (R - 10);
    const ny = cy + Math.sin(nAng) * (R - 10);
    ctx.fillStyle = COL.white;
    ctx.font = '800 11px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny);
    // rim ticks every 30° of map rotation
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    for (let d = 0; d < 360; d += 30) {
      const a = -Math.PI / 2 + ((d - heading) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.lineTo(cx + Math.cos(a) * (R - 5), cy + Math.sin(a) * (R - 5));
      ctx.stroke();
    }
    // plane symbol (fixed centre, pointing up)
    glow(ctx, COL.cyan, 5);
    ctx.fillStyle = COL.cyan;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 9);
    ctx.lineTo(cx + 6, cy + 7);
    ctx.lineTo(cx, cy + 3);
    ctx.lineTo(cx - 6, cy + 7);
    ctx.closePath();
    ctx.fill();
    noGlow(ctx);
  }

  // ---------- update ----------
  let pulseTimer = null;
  function update(fs) {
    if (disposed || !fs) return;
    sizeCanvases();
    smooth(fs);

    /* ZONE 1: TOP-LEFT (update) */
    setText(modeChip, 'mode', fs.mode || '—');
    // AP/A/T/FD states come from fs when provided; defaults match the
    // target image (AP OFF, A/T OFF, FD ON) so older producers still work.
    const apStates = {
      ap: fs.ap !== undefined ? !!fs.ap : false,
      at: fs.at !== undefined ? !!fs.at : false,
      fd: fs.fd !== undefined ? !!fs.fd : true,
    };
    for (const k of ['ap', 'at', 'fd']) {
      const on = apStates[k];
      setFlag(apChips[k], 'ap:' + k, 'hf-on', on);
      setFlag(apChips[k], 'ap:' + k, 'hf-off', !on);
      setText(apChips[k].children[1], 'apstate:' + k, on ? 'ON' : 'OFF');
    }
    // windRelDeg contract: wind blow-TO bearing minus heading (0 = tailwind).
    // Arrow glyph points east at rotate(0); -90 makes it nose-up relative.
    setStyle(windArrow, 'wind-arrow', 'transform', 'rotate(' + Math.round(num(fs.windRelDeg, 0) - 90) + 'deg)');
    setText(windValue, 'wind', pad3(wrap360(Math.round(num(fs.windDirDeg, 0)))) + '° / ' + Math.round(num(fs.windKt, 0)) + ' kt');
    setText(oatValue, 'oat', Math.round(num(fs.oatC, 0)) + '°C');
    setText(qnhValue, 'qnh', Math.round(num(fs.qnh, 1013)));

    /* ZONE 2: TOP-CENTRE (update) */
    setText(capTime, 'time', fmtClock(fs.timeSeconds));
    setText(capScore, 'score', 'SCORE ' + Math.round(num(fs.score, 0)).toLocaleString('en-US'));
    setText(capCombo, 'combo', 'x' + num(fs.combo, 1).toFixed(1) + ' COMBO');
    if (fs.scorePulse) {
      capsule.classList.remove('hf-pulse');
      void capsule.offsetWidth;
      capsule.classList.add('hf-pulse');
      if (pulseTimer) clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => capsule.classList.remove('hf-pulse'), 220);
    }
    setText(missionTitle, 'mtitle', fs.missionTitle || 'FREE FLIGHT');
    setText(missionSub, 'msub', fs.missionSub || '');
    const goals = Array.isArray(fs.goals) ? fs.goals : [];
    for (let i = 0; i < 3; i++) {
      const g = goals[i];
      setStyle(goalRows[i].row, 'goal:' + i, 'display', g ? '' : 'none');
      if (g) {
        setText(goalRows[i].lab, 'goallab:' + i, g.label || '');
        setText(goalRows[i].box, 'goalbox:' + i, g.done ? '✓' : '');
        setFlag(goalRows[i].row, 'goal:' + i, 'hf-goal-done', !!g.done);
      }
    }

    /* ZONE 3: TOP-RIGHT (update) */
    drawHeading(sm.heading);
    setText(hdgValueBox, 'hdgval', pad3(wrap360(Math.round(sm.heading))) + '°');
    setText(rwyValue, 'rwy', fs.rwyLabel || '—');
    setText(distValue, 'dist', fmtDist(fs.distM));
    setText(etaValue, 'eta', fmtEta(fs.etaSec));

    /* ZONE 4: CENTRE GUIDANCE (update) */
    drawGuidance(fs);

    /* ZONE 5: LEFT EDGE (update) */
    drawSpeedTape(fs);
    setText(spdValueBox, 'spdval', Math.round(sm.speed) + ' m/s');
    setFlag(spdValueBox, 'spdval', 'hf-warn-red', sm.speed < 18);
    setFlag(spdValueBox, 'spdval', 'hf-ok-green', sm.speed >= 22 && sm.speed <= 26);
    setText(gsValue, 'gs', num(fs.gsMs, 0).toFixed(1) + ' m/s');
    setText(machValue, 'mach', num(fs.mach, 0).toFixed(2));

    /* ZONE 6: RIGHT EDGE (update) */
    drawAltTape(fs);
    setText(altValueBox, 'altval', Math.round(sm.alt) + ' m');
    setText(raValue, 'ra', Math.round(sm.ra) + ' m');
    setFlag(raPanel, 'ra', 'hf-ra-low', sm.ra < 30);
    setText(aoaValue, 'aoa', sm.aoa.toFixed(1) + '°');
    setFlag(aoaPanel, 'aoa', 'hf-warn-amber', sm.aoa > 12 && sm.aoa <= 15);
    setFlag(aoaPanel, 'aoa', 'hf-warn-red', sm.aoa > 15);

    /* ZONE 7: BOTTOM-LEFT (update) */
    drawMinimap(fs);
    setText(pryRows.pitch, 'pry:pitch', signed1(sm.pitch));
    setText(pryRows.roll, 'pry:roll', signed1(sm.roll));
    setText(pryRows.yaw, 'pry:yaw', signed1(fs.yawDeg));

    /* ZONE 8: BOTTOM-CENTRE (update) */
    setText(flapsChip.value, 'flaps', Math.round(num(fs.flapsDeg, 0)) + '°');
    const gear = fs.gear || 'DOWN';
    setText(gearChip.value, 'gear', gear === 'DOWN' ? 'DOWN ●●●' : gear);
    setFlag(gearChip.chip, 'gear', 'hf-gear-down', gear === 'DOWN');
    setFlag(gearChip.chip, 'gear', 'hf-gear-moving', gear === 'MOVING');
    setFlag(gearChip.chip, 'gear', 'hf-gear-up', gear === 'UP');
    setText(brakesChip.value, 'brakes', fs.brakes || 'OFF');
    setFlag(brakesChip.chip, 'brakes', 'hf-chip-on', fs.brakes === 'ON');
    setFlag(brakesChip.chip, 'brakes', 'hf-chip-amber', fs.brakes === 'ARMED');
    setText(lightsChip.value, 'lights', fs.lights || 'OFF');
    setFlag(lightsChip.chip, 'lights', 'hf-chip-on', fs.lights === 'ON');
    setText(spoilersChip.value, 'spoilers', fs.spoilers || 'OFF');
    setFlag(spoilersChip.chip, 'spoilers', 'hf-chip-amber', fs.spoilers === 'ARMED');
    setText(destBarText, 'destbar', '▲ ' + (fs.destLabel || '—') + ' · ' + Math.round(num(fs.destDistM, 0)) + ' M');
    setStyle(destProgressFill, 'destprog', 'width', (clamp(num(fs.destProgress01, 0), 0, 1) * 100).toFixed(1) + '%');

    /* ZONE 9: BOTTOM-RIGHT (update) */
    const thr01 = clamp(num(fs.throttle01, 0), 0, 1);
    setStyle(thrFill, 'thr', 'width', (thr01 * 100).toFixed(1) + '%');
    setText(thrPct, 'thrpct', Math.round(thr01 * 100) + '%');
    setText(rpmRow.value, 'rpm', Math.round(num(fs.rpm, 0)).toLocaleString('en-US'));
    const fuelPct = clamp(num(fs.fuelPct, 0), 0, 100);
    setText(fuelRow.value, 'fuel', Math.round(fuelPct) + '% · ' + Math.round(num(fs.fuelLitres, 0)) + ' L · ' + fmtFuelTime(fs.fuelTimeH));
    setFlag(fuelRow.row, 'fuel', 'hf-warn-amber', fuelPct < 20 && fuelPct >= 10);
    setFlag(fuelRow.row, 'fuel', 'hf-warn-red', fuelPct < 10);
    setFlag(fuelRow.row, 'fuel', 'hf-blink-red', fuelPct < 10);
    setText(flowValue, 'flow', Math.round(num(fs.fuelFlowLh, 0)) + ' L/h');
    const oil = num(fs.oilC, 0);
    setText(oilValue, 'oil', Math.round(oil) + '°C');
    setFlag(oilValue, 'oil', 'hf-warn-red', oil > 110);
    setFlag(oilValue, 'oil', 'hf-blink-red', oil > 110);
    const g = num(fs.gLoad, 1);
    setText(gValue, 'gload', g.toFixed(2) + ' g');
    setFlag(gValue, 'gload', 'hf-warn-amber', g > 3);
    const trim = num(fs.trim, 0);
    setText(trimValue, 'trim', (trim > 0 ? '+' : '') + trim.toFixed(1));
    const caution = fs.caution || null;
    const ok = fs.systemsOk !== false;
    setText(sysStripText, 'sysstrip', ok ? 'ALL SYSTEMS NOMINAL' : 'SYSTEMS CAUTION');
    setFlag(sysStrip, 'sysstrip', 'hf-sys-ok', ok);
    setFlag(sysStrip, 'sysstrip', 'hf-sys-caution', !ok);
    if (caution) {
      setText(cautionChip, 'caution', caution.label || 'CAUTION');
      setStyle(cautionChip, 'caution', 'display', '');
      setFlag(cautionChip, 'caution', 'hf-caution-red', caution.level === 'red');
      setFlag(cautionChip, 'caution', 'hf-caution-amber', caution.level !== 'red');
      setFlag(cautionChip, 'caution', 'hf-blink-red', caution.level === 'red');
    } else {
      setStyle(cautionChip, 'caution', 'display', 'none');
    }
  }

  function setMode(next) {
    if (next !== 'FULL' && next !== 'MINIMAL' && next !== 'OFF') return mode;
    mode = next;
    root.classList.remove('hf-mode-full', 'hf-mode-minimal', 'hf-mode-off');
    root.classList.add('hf-mode-' + next.toLowerCase());
    for (const s of canvases) s.key = ''; // repaint visible canvases
    sizeCanvases();
    return mode;
  }
  function getMode() { return mode; }
  function dispose() {
    disposed = true;
    if (ro) ro.disconnect();
    window.removeEventListener('resize', sizeCanvases);
    if (pulseTimer) clearTimeout(pulseTimer);
    root.remove();
  }

  sizeCanvases();
  return { update, setMode, getMode, dispose };
}
