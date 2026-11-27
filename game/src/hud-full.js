// AURORA POST — HUD FULL (new glass HUD, replaces round-dial concept HUD).
// HUD-V2 MERGED (hud-full-v2.js): top.js base (Zones 1–3 refined) +
// center.js drawGuidance (Zone 4) + tapes.js drawSpeedTape/drawAltTape
// (Zones 5–6) + bottom.js Blocks A/B/C (Zones 7–9). Pair with hud-v2.css.
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
  windArrow.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3 12 L18 12 M13 6 L19 12 L13 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
  // Refined to target: clock glyph + time, SCORE label over number,
  // amber combo. Outer classes unchanged (hf-cap-time/-score/-combo);
  // score splits into label + value spans for the two-tone look.
  const capClock = el('span', 'hf-cap-clock');
  capClock.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5 V12 L15.5 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const capTime = el('span', 'hf-cap-time', '00:00');
  const capScore = el('span', 'hf-cap-score');
  capScore.appendChild(el('span', 'hf-cap-score-label', 'SCORE'));
  const capScoreValue = el('span', 'hf-cap-score-value', '0');
  capScore.appendChild(capScoreValue);
  const capCombo = el('span', 'hf-cap-combo', 'x1.0 COMBO');
  capsule.appendChild(capClock);
  capsule.appendChild(capTime);
  capsule.appendChild(el('span', 'hf-cap-sep', ''));
  capsule.appendChild(capScore);
  capsule.appendChild(el('span', 'hf-cap-sep', ''));
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

  /* ZONE 4: CENTRE GUIDANCE — simplified: horizon, pitch steps, bank arc, FPM, GS/LOC diamonds (canvas) */
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
    const row = el('div', 'hf-pry-row hf-pry-' + k);
    const bar = el('span', 'hf-pry-bar');
    const stack = el('span', 'hf-pry-stack');
    stack.appendChild(el('span', 'hf-label', label));
    const v = el('span', 'hf-value hf-pry-value', '+0.0°');
    stack.appendChild(v);
    row.appendChild(bar);
    row.appendChild(stack);
    pryCard.appendChild(row);
    pryRows[k] = { row, bar, value: v };
  }

  /* ZONE 8: BOTTOM-CENTRE — systems dock + guide strip */
  const zBC = zone('hf-bc');
  const sysRow = el('div', 'hf-sys-row');
  const SYS_ICONS = {
    flaps: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 3.5v17M12 3.5v12M12 15.5l7.5-4M12 20.5l5-2.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="4.6" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 6.8v6.7M5.5 13.5h13M8 13.5v4M16 13.5v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="6.4" y="17.5" width="3.2" height="3" rx="1" fill="currentColor"/><rect x="14.4" y="17.5" width="3.2" height="3" rx="1" fill="currentColor"/></svg>',
    brakes: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    lights: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    spoilers: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 17.5L19 8.5M13.5 11.8L15 5.5l4.5 1.2-1.6 5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  function sysChip(label) {
    const c = panel(sysRow, 'hf-sys-chip');
    c.appendChild(el('div', 'hf-label', label));
    const v = el('div', 'hf-sys-value', '—');
    c.appendChild(v);
    return { chip: c, value: v };
  }
  function sysIcon(chipObj, key) {
    const ic = el('span', 'hf-sys-icon hf-sys-icon-' + key);
    ic.innerHTML = SYS_ICONS[key];
    chipObj.chip.insertBefore(ic, chipObj.chip.firstChild);
    return ic;
  }
  const flapsChip = sysChip('FLAPS');
  const gearChip = sysChip('GEAR');
  const brakesChip = sysChip('BRAKES');
  const lightsChip = sysChip('LIGHTS');
  const spoilersChip = sysChip('SPOILERS');
  sysIcon(flapsChip, 'flaps');
  sysIcon(gearChip, 'gear');
  sysIcon(brakesChip, 'brakes');
  sysIcon(lightsChip, 'lights');
  sysIcon(spoilersChip, 'spoilers');
  const gearDots = el('span', 'hf-gear-dots');
  for (let i = 0; i < 3; i++) gearDots.appendChild(el('span', 'hf-gear-dot'));
  gearChip.chip.appendChild(gearDots);
  zBC.appendChild(sysRow);
  const destBar = panel(zBC, 'hf-dest-bar');
  const destBarText = el('div', 'hf-dest-bar-text', '▲ —');
  const destProgress = el('div', 'hf-dest-progress');
  const destProgressFill = el('span', 'hf-dest-progress-fill');
  destProgress.appendChild(destProgressFill);
  destBar.appendChild(destBarText);
  destBar.appendChild(destProgress);

  /* ZONE 9: BOTTOM-RIGHT — throttle/fuel bars, telemetry grid, systems strip */
  const zBR = zone('hf-br');
  const engPanel = panel(zBR, 'hf-eng-panel');
  const thrRow = el('div', 'hf-eng-row hf-thr-row');
  const thrHead = el('div', 'hf-eng-head');
  thrHead.appendChild(el('span', 'hf-label', 'THROTTLE'));
  const thrPct = el('span', 'hf-value hf-eng-pct', '0%');
  thrHead.appendChild(thrPct);
  thrRow.appendChild(thrHead);
  const thrBar = el('span', 'hf-thr-bar');
  const thrFill = el('span', 'hf-thr-fill');
  thrBar.appendChild(thrFill);
  thrRow.appendChild(thrBar);
  engPanel.appendChild(thrRow);
  const fuelBlock = el('div', 'hf-eng-row hf-fuel-row');
  const fuelHead = el('div', 'hf-eng-head');
  fuelHead.appendChild(el('span', 'hf-label', 'FUEL'));
  const fuelValue = el('span', 'hf-value hf-eng-pct', '—');
  fuelHead.appendChild(fuelValue);
  fuelBlock.appendChild(fuelHead);
  const fuelBar = el('span', 'hf-fuel-bar');
  const fuelFill = el('span', 'hf-fuel-fill');
  fuelBar.appendChild(fuelFill);
  fuelBlock.appendChild(fuelBar);
  engPanel.appendChild(fuelBlock);
  const fuelRow = { row: fuelBlock, value: fuelValue };
  const engGrid = el('div', 'hf-eng-grid');
  function engCell(label) {
    const cell = el('div', 'hf-eng-cell');
    cell.appendChild(el('span', 'hf-label', label));
    const v = el('span', 'hf-value hf-eng-value', '—');
    cell.appendChild(v);
    engGrid.appendChild(cell);
    return { row: cell, value: v };
  }
  const rpmRow = engCell('RPM');
  const flowCell = engCell('FUEL FLOW');
  const gCell = engCell('G-LOAD');
  const acirCell = engCell('ACIR');
  const oilCell = engCell('OIL');
  const trimCell = engCell('TRIM');
  const flowValue = flowCell.value;
  const gValue = gCell.value;
  const acirValue = acirCell.value;
  const oilValue = oilCell.value;
  const trimValue = trimCell.value;
  engPanel.appendChild(engGrid);
  const sysStrip = el('div', 'hf-sys-strip');
  const sysStripText = el('span', 'hf-sys-strip-text', 'ALL SYSTEMS NOMINAL');
  const sysCheck = el('span', 'hf-sys-check', '✓');
  const cautionChip = el('span', 'hf-caution-chip', '');
  sysStrip.appendChild(sysStripText);
  sysStrip.appendChild(sysCheck);
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

  /* ZONE 3 painter: heading tape (ticks 5°, labels 30° as 090/120/150).
     Refined to target: bare tape (no panel box in CSS), labels above a
     thin baseline, ticks hanging below it, nearest 30° label in cyan,
     cyan triangle marker under the line at centre. */
  function drawHeading(headingDeg) {
    const { ctx, w, h } = HDG;
    if (!ctx || w < 10) return;
    const key = Math.round(headingDeg * 2) + ':' + w + 'x' + h;
    if (key === HDG.key) return;
    HDG.key = key;
    ctx.clearRect(0, 0, w, h);
    const pxPerDeg = w / 100; // ±50° visible
    const cx = w / 2;
    const lineY = h - 14; // baseline; labels above, marker below
    // baseline
    ctx.strokeStyle = 'rgba(62,242,255,0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, lineY);
    ctx.lineTo(w, lineY);
    ctx.stroke();
    ctx.font = '700 11px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    // nearest 30° label (highlighted cyan, as 120 in the target)
    const nearest30 = wrap360(Math.round(headingDeg / 30) * 30);
    const start = Math.floor((headingDeg - 55) / 5) * 5;
    for (let d = start; d <= headingDeg + 55; d += 5) {
      const x = cx + (d - headingDeg) * pxPerDeg;
      if (x < -20 || x > w + 20) continue;
      const wrapped = wrap360(d);
      const is30 = Math.round(wrapped) % 30 === 0;
      const is10 = Math.round(wrapped) % 10 === 0;
      const tickH = is30 ? 9 : is10 ? 6 : 3.5;
      ctx.strokeStyle = is30 ? COL.cyan : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, lineY);
      ctx.lineTo(x, lineY + tickH);
      ctx.stroke();
      if (is30) {
        const hot = Math.round(wrapped) === Math.round(nearest30);
        ctx.fillStyle = hot ? COL.cyan : 'rgba(255,255,255,0.82)';
        ctx.fillText(pad3(wrapped), x, lineY - 4);
      }
    }
    // centre marker: cyan triangle below the line, point up
    glow(ctx, COL.cyan, 6);
    ctx.fillStyle = COL.cyan;
    ctx.beginPath();
    ctx.moveTo(cx - 6, lineY + 11);
    ctx.lineTo(cx + 6, lineY + 11);
    ctx.lineTo(cx, lineY + 3);
    ctx.closePath();
    ctx.fill();
    noGlow(ctx);
    // soft edge fades (tape sits on bare sky, keep them light)
    const fadeL = ctx.createLinearGradient(0, 0, 30, 0);
    fadeL.addColorStop(0, 'rgba(10,14,22,0.55)');
    fadeL.addColorStop(1, 'rgba(10,14,22,0)');
    ctx.fillStyle = fadeL;
    ctx.fillRect(0, 0, 30, h);
    const fadeR = ctx.createLinearGradient(w, 0, w - 30, 0);
    fadeR.addColorStop(0, 'rgba(10,14,22,0.55)');
    fadeR.addColorStop(1, 'rgba(10,14,22,0)');
    ctx.fillStyle = fadeR;
    ctx.fillRect(w - 30, 0, 30, h);
  }

  /* ZONE 4 painter: centre guidance, simplified (horizon, pitch steps, bank arc, FPM, GS/LOC diamonds) */
  function drawGuidance(fs) {
    const { ctx, w, h } = GUIDE;
    if (!ctx || w < 40) return;
    const pitch = sm.pitch, roll = sm.roll;
    const fpm = fs.fpm || {};
    // Camera-mode label on the horizon line (reference: CHASE pill).
    // Producer may send any of these fields; default matches the target.
    const camLabel = String(fs.cameraLabel || fs.cameraMode || fs.viewLabel || fs.viewMode || 'CHASE');
    const key = [Math.round(pitch * 5), Math.round(roll * 5),
      Math.round(num(fpm.xDeg, 0) * 5), Math.round(num(fpm.yDeg, 0) * 5),
      Math.round(num(fs.glideslopeDev, 0) * 40), Math.round(num(fs.localizerDev, 0) * 40),
      fs.onPath || 'none', camLabel, w + 'x' + h].join(':');
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

    // Simplified centre (2026-11-28 user order): minimal ink — a short
    // horizon reference, two unlabelled pitch steps, a slim bank arc,
    // the FPV and the camera label as plain text. White ladder, cyan
    // only on the horizon, bank marker and FPV.
    const WHITE = 'rgba(255,255,255,0.85)';
    const WHITE_DIM = 'rgba(255,255,255,0.45)';
    const ls = clamp(w / 620, 0.78, 1.12); // ladder width scale (620px = design width)
    // Camera label metrics (small gap in the horizon line for the text).
    ctx.font = '600 9px ' + FONT_STACK;
    const labelW = Math.ceil(ctx.measureText(camLabel).width);
    const horizonGap = labelW / 2 + 5;

    // --- pitch ladder (rotates with roll, slides with pitch) ---
    // Two unlabelled steps only (±10 wider than ±5), no minors.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-rollRad);
    for (const deg of [-10, -5, 5, 10]) {
      const y = -(deg - pitch) * pxPerDeg;
      if (Math.abs(y) > h * 0.62) continue;
      const half = (deg % 10 === 0 ? 46 : 34) * ls;
      const gap = 12 * ls;
      ctx.beginPath();
      ctx.moveTo(-half, y); ctx.lineTo(-gap, y);
      ctx.moveTo(gap, y); ctx.lineTo(half, y);
      strokeOut(WHITE_DIM, 1, 0);
    }
    // horizon line (0°) — cyan, short, small centre gap for the label
    const hy = pitch * pxPerDeg;
    const horizonHalf = 72 * ls;
    if (Math.abs(hy) < h * 0.62) {
      ctx.beginPath();
      ctx.moveTo(-horizonHalf, hy); ctx.lineTo(-horizonGap, hy);
      ctx.moveTo(horizonGap, hy); ctx.lineTo(horizonHalf, hy);
      strokeOut(COL.cyan, 1.25, 4);
    }
    ctx.restore();

    // --- camera-mode label on the horizon line (plain text, no pill) ---
    // Drawn upright at the horizon's centre point so it stays readable
    // in a bank while tracking the line.
    if (Math.abs(hy) < h * 0.62) {
      const hx = cx + hy * Math.sin(rollRad);
      const hyS = cy + hy * Math.cos(rollRad);
      ctx.font = '600 9px ' + FONT_STACK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      textOut(camLabel, hx, hyS + 0.5, 'rgba(255,255,255,0.8)');
    }

    // --- bank arc (fixed scale, pointer rolls) ---
    // Slim version: short ±60° arc, ticks only at 0/±30/±60, small
    // fixed cyan apex marker, roll pointer just inside the arc
    // (amber/red past 30°/45° of bank).
    const arcR = Math.min(w, h) * 0.30;
    const arcCy = cy + arcR * 0.28;
    const absRoll = Math.abs(roll);
    const ptrCol = absRoll > 45 ? COL.red : absRoll > 30 ? COL.amber : WHITE;
    ctx.beginPath();
    ctx.arc(cx, arcCy, arcR, -Math.PI / 2 - Math.PI / 3, -Math.PI / 2 + Math.PI / 3);
    strokeOut(WHITE_DIM, 1, 0);
    ctx.beginPath();
    for (const deg of [-60, -30, 0, 30, 60]) {
      const a = -Math.PI / 2 + (deg * Math.PI) / 180;
      const len = deg === 0 ? 9 : 6;
      ctx.moveTo(cx + Math.cos(a) * arcR, arcCy + Math.sin(a) * arcR);
      ctx.lineTo(cx + Math.cos(a) * (arcR - len), arcCy + Math.sin(a) * (arcR - len));
    }
    strokeOut(WHITE, 1, 0);
    // fixed apex marker (cyan, points down at the arc)
    const apexY = arcCy - arcR;
    ctx.beginPath();
    ctx.moveTo(cx - 5, apexY - 9);
    ctx.lineTo(cx + 5, apexY - 9);
    ctx.lineTo(cx, apexY - 2);
    ctx.closePath();
    fillOut(COL.cyan, 4);
    // roll pointer (white triangle just inside the arc, tip outward)
    const pa = -Math.PI / 2 + rollRad;
    const dirX = Math.cos(pa), dirY = Math.sin(pa);
    const tipX = cx + dirX * (arcR - 5), tipY = arcCy + dirY * (arcR - 5);
    const baseX = cx + dirX * (arcR - 13), baseY = arcCy + dirY * (arcR - 13);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(baseX - dirY * 4.5, baseY + dirX * 4.5);
    ctx.lineTo(baseX + dirY * 4.5, baseY - dirX * 4.5);
    ctx.closePath();
    fillOut(ptrCol, absRoll > 30 ? 4 : 0);

    // No fixed boresight wings: the reference centre reference is the
    // horizon line + camera pill alone, so nothing is drawn at cx,cy.

    // --- flight path vector (glowing cyan circle-crosshair) ---
    // Reference: circle with N/S/E/W ticks standing clear of the ring
    // and a centre dot, offset from centre by the velocity vector.
    // Clamp to the centre guidance area, never the canvas corners.
    const fx = clamp(cx + num(fpm.xDeg, 0) * pxPerDeg, cx - w * 0.34, cx + w * 0.34);
    const fy = clamp(cy - num(fpm.yDeg, 0) * pxPerDeg, cy - h * 0.34, cy + h * 0.34);
    const fpmR = 11;
    ctx.beginPath();
    ctx.arc(fx, fy, fpmR, 0, Math.PI * 2);
    ctx.moveTo(fx - fpmR - 7, fy); ctx.lineTo(fx - fpmR - 2, fy);
    ctx.moveTo(fx + fpmR + 2, fy); ctx.lineTo(fx + fpmR + 7, fy);
    ctx.moveTo(fx, fy - fpmR - 7); ctx.lineTo(fx, fy - fpmR - 2);
    ctx.moveTo(fx, fy + fpmR + 2); ctx.lineTo(fx, fy + fpmR + 7);
    strokeOut(COL.cyan, 1.5, 5); // FPV cyan (spec: cyan = indicators)
    glow(ctx, COL.cyan, 5);
    ctx.fillStyle = COL.cyan;
    ctx.beginPath();
    ctx.arc(fx, fy, 1.8, 0, Math.PI * 2);
    ctx.fill();
    noGlow(ctx);

    const onPath = fs.onPath || 'none';
    if (onPath !== 'none') {
      const pathCol = onPath === 'good' ? COL.green : COL.amber;
      // --- glideslope diamond (vertical, right of centre) ---
      // Deviation cue only: a short track + diamond, no dot scale,
      // no label, no chevrons (the FPV already shows the flight path).
      const gsX = cx + Math.min(w * 0.30, 168);
      const gsHalf = h * 0.20;
      ctx.beginPath();
      ctx.moveTo(gsX, cy - gsHalf); ctx.lineTo(gsX, cy + gsHalf);
      strokeOut('rgba(255,255,255,0.4)', 1, 0);
      const gsY = cy - clamp(num(fs.glideslopeDev, 0), -1, 1) * gsHalf;
      ctx.beginPath();
      ctx.moveTo(gsX, gsY - 7); ctx.lineTo(gsX + 6, gsY); ctx.lineTo(gsX, gsY + 7); ctx.lineTo(gsX - 6, gsY);
      ctx.closePath();
      fillOut(pathCol, 5);
      // --- localizer diamond (horizontal, below centre) ---
      const locY = cy + h * 0.30;
      const locHalf = Math.min(w * 0.22, 120);
      ctx.beginPath();
      ctx.moveTo(cx - locHalf, locY); ctx.lineTo(cx + locHalf, locY);
      strokeOut('rgba(255,255,255,0.4)', 1, 0);
      const locX = cx + clamp(num(fs.localizerDev, 0), -1, 1) * locHalf;
      ctx.beginPath();
      ctx.moveTo(locX, locY - 7); ctx.lineTo(locX + 6, locY); ctx.lineTo(locX, locY + 7); ctx.lineTo(locX - 6, locY);
      ctx.closePath();
      fillOut(pathCol, 5);
    }
  }

  /* ZONE 5 painter: speed tape — refined to reference.
     Spine right, numerals left of spine, ticks right of spine.
     Green target 22–26, red stall <18 as spine edge strips. */
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
    const spineX = w - 16;
    const pxPerUnit = h / 44; // ±22 m/s visible (reference density)
    const yOf = (v) => cy - (v - speed) * pxPerUnit;
    const OUTLINE = 'rgba(6,12,20,0.72)';
    function tapeText(text, x, y, colour) {
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = colour;
      ctx.fillText(text, x, y);
    }
    // --- spine edge strips: target band + stall band (3 px, no wash) ---
    ctx.fillStyle = COL.green;
    ctx.fillRect(spineX + 1, yOf(26), 3, yOf(22) - yOf(26));
    ctx.fillStyle = COL.red;
    ctx.fillRect(spineX + 1, yOf(18), 3, h - yOf(18));
    // --- continuous glowing spine, faded at the ends ---
    const spineGrad = ctx.createLinearGradient(0, 0, 0, h);
    spineGrad.addColorStop(0, 'rgba(62,242,255,0)');
    spineGrad.addColorStop(0.12, 'rgba(62,242,255,0.9)');
    spineGrad.addColorStop(0.88, 'rgba(62,242,255,0.9)');
    spineGrad.addColorStop(1, 'rgba(62,242,255,0)');
    glow(ctx, COL.cyan, 5);
    ctx.strokeStyle = spineGrad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(spineX, 0);
    ctx.lineTo(spineX, h);
    ctx.stroke();
    noGlow(ctx);
    // --- ticks (every 2) + labels (every 10), numerals left of spine ---
    ctx.font = '600 10px ' + FONT_STACK;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const lo = Math.floor((speed - 23) / 2) * 2, hi = Math.ceil((speed + 23) / 2) * 2;
    for (let v = lo; v <= hi; v += 2) {
      if (v < 0) continue;
      const y = yOf(v);
      if (y < -6 || y > h + 6) continue;
      const major = v % 10 === 0;
      const mid = v % 5 === 0;
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(spineX, y);
      ctx.lineTo(spineX + (major ? 9 : mid ? 7 : 5), y);
      ctx.stroke();
      if (major && y >= 9 && y <= h - 9) {
        const col = v < 18 ? COL.red : v >= 22 && v <= 26 ? COL.green : 'rgba(255,255,255,0.88)';
        tapeText(String(v), spineX - 6, y, col);
      }
    }
    // --- trend bar (far left, reference's slim vertical bar) ---
    if (Math.abs(trend - speed) > 0.15) {
      const tx = 7;
      const ty = clamp(yOf(trend), 8, h - 8);
      const tCol = trend > speed ? COL.green : COL.amber;
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx, 10);
      ctx.lineTo(tx, h - 10);
      ctx.stroke();
      glow(ctx, tCol, 5);
      ctx.strokeStyle = tCol;
      ctx.fillStyle = tCol;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tx, cy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.beginPath();
      if (trend > speed) { ctx.moveTo(tx - 4, ty + 2); ctx.lineTo(tx + 4, ty + 2); ctx.lineTo(tx, ty - 5); }
      else { ctx.moveTo(tx - 4, ty - 2); ctx.lineTo(tx + 4, ty - 2); ctx.lineTo(tx, ty + 5); }
      ctx.closePath();
      ctx.fill();
      noGlow(ctx);
    }
    // --- centre caret on the spine (DOM value box points here) ---
    glow(ctx, COL.cyan, 4);
    ctx.fillStyle = COL.white;
    ctx.beginPath();
    ctx.moveTo(spineX + 11, cy - 5); ctx.lineTo(spineX + 11, cy + 5); ctx.lineTo(spineX + 4, cy);
    ctx.closePath();
    ctx.fill();
    noGlow(ctx);
  }

  /* ZONE 6 painter: altitude tape + VSI — refined to reference.
     Spine left, numerals right of spine, ticks left of spine.
     VSI track at right edge, centre-zero fill (green / amber -2 /
     red -4), ±6 m/s full scale. */
  function drawAltTape(fs) {
    const { ctx, w, h } = ALT;
    if (!ctx || w < 30) return;
    const alt = sm.alt, vs = sm.vs;
    const key = Math.round(alt * 2) + ':' + Math.round(vs * 10) + ':' + w + 'x' + h;
    if (key === ALT.key) return;
    ALT.key = key;
    ctx.clearRect(0, 0, w, h);
    const cy = h / 2;
    const spineX = 16;
    const pxPerM = h / 130; // ±65 m visible (matches reference 220–320)
    const yOf = (v) => cy - (v - alt) * pxPerM;
    const OUTLINE = 'rgba(6,12,20,0.72)';
    function tapeText(text, x, y, colour) {
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = colour;
      ctx.fillText(text, x, y);
    }
    // ground band below 0 (faint wash, tape side only)
    if (yOf(0) < h) {
      ctx.fillStyle = 'rgba(255,181,71,0.10)';
      ctx.fillRect(0, Math.max(0, yOf(0)), w - 22, h);
    }
    // --- continuous glowing spine, faded at the ends ---
    const spineGrad = ctx.createLinearGradient(0, 0, 0, h);
    spineGrad.addColorStop(0, 'rgba(62,242,255,0)');
    spineGrad.addColorStop(0.12, 'rgba(62,242,255,0.9)');
    spineGrad.addColorStop(0.88, 'rgba(62,242,255,0.9)');
    spineGrad.addColorStop(1, 'rgba(62,242,255,0)');
    glow(ctx, COL.cyan, 5);
    ctx.strokeStyle = spineGrad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(spineX, 0);
    ctx.lineTo(spineX, h);
    ctx.stroke();
    noGlow(ctx);
    // --- ticks (every 5) + labels (every 20; every 50 on short canvas) ---
    ctx.font = '600 10px ' + FONT_STACK;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelStepM = pxPerM * 20 >= 15 ? 20 : 50;
    const lo = Math.floor((alt - 70) / 5) * 5, hi = Math.ceil((alt + 70) / 5) * 5;
    for (let v = lo; v <= hi; v += 5) {
      const y = yOf(v);
      if (y < -6 || y > h + 6) continue;
      const major = v % labelStepM === 0;
      const mid = v % 10 === 0;
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(spineX - (major ? 9 : mid ? 7 : 5), y);
      ctx.lineTo(spineX, y);
      ctx.stroke();
      if (major && y >= 9 && y <= h - 9) {
        tapeText(String(v), spineX + 6, y, 'rgba(255,255,255,0.88)');
      }
    }
    // --- centre caret on the spine (DOM value box points here) ---
    glow(ctx, COL.cyan, 4);
    ctx.fillStyle = COL.white;
    ctx.beginPath();
    ctx.moveTo(spineX - 11, cy - 5); ctx.lineTo(spineX - 11, cy + 5); ctx.lineTo(spineX - 4, cy);
    ctx.closePath();
    ctx.fill();
    noGlow(ctx);
    // --- VSI strip: thin track, centre-zero fill up/down ---
    const sx = w - 13, sw = 9;
    const vsHalf = h * 0.44;
    const vsScale = vsHalf / 6; // ±6 m/s full scale
    const trackTop = cy - vsHalf, trackBot = cy + vsHalf;
    ctx.fillStyle = 'rgba(10,14,22,0.55)';
    ctx.fillRect(sx, trackTop, sw, vsHalf * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, trackTop + 0.5, sw - 1, vsHalf * 2 - 1);
    // scale ticks left of the track; centre datum longer + brighter
    for (const t of [-6, -4, -2, 0, 2, 4, 6]) {
      const y = cy - t * vsScale;
      ctx.strokeStyle = t === 0 ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = t === 0 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(sx - (t === 0 ? 5 : 3), y);
      ctx.lineTo(sx, y);
      ctx.stroke();
    }
    // centre datum line across the track
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx, cy);
    ctx.lineTo(sx + sw, cy);
    ctx.stroke();
    const vsCol = vs < -4 ? COL.red : vs < -2 ? COL.amber : COL.green;
    const vsY = cy - clamp(vs, -6, 6) * vsScale;
    glow(ctx, vsCol, 5);
    ctx.fillStyle = vsCol;
    ctx.fillRect(sx + 1, Math.min(cy, vsY), sw - 2, Math.max(2, Math.abs(vsY - cy)));
    noGlow(ctx);
    ctx.font = '700 8px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    tapeText('VSI', sx + sw / 2, trackTop - 2, 'rgba(255,255,255,0.75)');
  }

  /* ZONE 7 painter: heading-up circular minimap (plane fixed centre) */
  function drawMinimap(fs) {
    const { ctx, w, h } = MAP;
    if (!ctx || w < 30) return;
    const mm = fs.minimap || {};
    const now = performance.now();
    const sweepDeg = (now / 1000 * 36) % 360; // 10 s per revolution
    const key = [Math.round(num(mm.planeX, 0) / 5), Math.round(num(mm.planeZ, 0) / 5),
      Math.round(num(mm.headingDeg, num(fs.headingDeg, 0))),
      Math.round(num(mm.targetX, 0) / 10), Math.round(num(mm.targetZ, 0) / 10),
      mm.hasTarget ? 1 : 0, Math.round(sweepDeg / 12), w + 'x' + h].join(':');
    if (key === MAP.key && now - MAP.lastMs < 500) return;
    if (now - MAP.lastMs < 66) return; // ≤15 Hz
    MAP.key = key;
    MAP.lastMs = now;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) / 2 - 2;
    const heading = num(mm.headingDeg, num(fs.headingDeg, 0));
    const worldSize = Math.max(100, num(mm.worldSize, 8000));
    const viewRadius = worldSize * 0.38; // metres to rim
    const scale = R / viewRadius;
    const px = num(mm.planeX, 0), pz = num(mm.planeZ, 0);
    const pulse = 0.5 + 0.5 * Math.sin(now / 320);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    // sea (radial, darker at rim like the reference)
    const sea = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    sea.addColorStop(0, 'rgba(10,34,54,0.94)');
    sea.addColorStop(1, 'rgba(4,14,26,0.96)');
    ctx.fillStyle = sea;
    ctx.fillRect(0, 0, w, h);
    // rotate map so heading is up: world->screen with heading-up rotation
    ctx.translate(cx, cy);
    ctx.rotate(-(heading * Math.PI) / 180);
    // range rings (drawn in rotated frame, still circular)
    ctx.strokeStyle = 'rgba(62,242,255,0.20)';
    ctx.lineWidth = 1;
    for (const f of [0.33, 0.66, 1]) {
      ctx.beginPath();
      ctx.arc(0, 0, R * f, 0, Math.PI * 2);
      ctx.stroke();
    }
    // islands (dark landmass, pale shore outline)
    for (const isl of (mm.islands || [])) {
      const ix = (num(isl.x, 0) - px) * scale;
      const iz = (num(isl.z, 0) - pz) * scale;
      const ir = Math.max(2, num(isl.radius, 0) * scale);
      if (Math.abs(ix) > R + ir || Math.abs(iz) > R + ir) continue;
      ctx.fillStyle = 'rgba(24,52,42,0.92)';
      ctx.strokeStyle = 'rgba(150,220,235,0.40)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ix, iz, ir, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
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
    // route line + target (diamond inside, rim chevron when off-map)
    if (mm.hasTarget) {
      const tx = (num(mm.targetX, 0) - px) * scale;
      const tz = (num(mm.targetZ, 0) - pz) * scale;
      const dist = Math.hypot(tx, tz);
      ctx.strokeStyle = 'rgba(76,255,154,0.75)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(tx, tz);
      ctx.stroke();
      ctx.setLineDash([]);
      if (dist <= R - 8) {
        glow(ctx, COL.green, 5);
        ctx.fillStyle = COL.green;
        ctx.beginPath();
        ctx.moveTo(tx, tz - 7); ctx.lineTo(tx + 6, tz); ctx.lineTo(tx, tz + 7); ctx.lineTo(tx - 6, tz);
        ctx.closePath();
        ctx.fill();
        noGlow(ctx);
        ctx.strokeStyle = 'rgba(76,255,154,' + (0.35 + 0.4 * pulse).toFixed(2) + ')';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(tx, tz, 10 + 3 * pulse, 0, Math.PI * 2);
        ctx.stroke();
      } else if (dist > 0.01) {
        const ax = (tx / dist) * (R - 11), ay = (tz / dist) * (R - 11);
        const ang = Math.atan2(ay, ax);
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(ang);
        glow(ctx, COL.green, 5);
        ctx.fillStyle = COL.green;
        ctx.beginPath();
        ctx.moveTo(7, 0); ctx.lineTo(-4, -5); ctx.lineTo(-4, 5);
        ctx.closePath();
        ctx.fill();
        noGlow(ctx);
        ctx.restore();
      }
    }
    // optional traffic (small plane glyphs, relative heading)
    for (const tr of (mm.traffic || [])) {
      const tx2 = (num(tr.x, 0) - px) * scale;
      const tz2 = (num(tr.z, 0) - pz) * scale;
      if (Math.abs(tx2) > R || Math.abs(tz2) > R) continue;
      ctx.save();
      ctx.translate(tx2, tz2);
      ctx.rotate(((num(tr.headingDeg, 0) - heading) * Math.PI) / 180);
      ctx.fillStyle = 'rgba(160,240,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(0, -5); ctx.lineTo(3.5, 4); ctx.lineTo(0, 1.8); ctx.lineTo(-3.5, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // radar sweep (screen space): faint wedge + leading line
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    const sa = ((sweepDeg - 90) * Math.PI) / 180;
    ctx.fillStyle = 'rgba(62,242,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, sa - 0.5, sa);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(62,242,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sa) * R, cy + Math.sin(sa) * R);
    ctx.stroke();
    ctx.restore();

    // rim + range labels + N marker (N sits at -heading on the rim)
    ctx.strokeStyle = 'rgba(62,242,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.font = '700 8px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of [0.33, 0.66]) {
      const metres = viewRadius * f;
      const lab = metres >= 1000 ? (metres / 1000).toFixed(1) + 'k' : Math.round(metres) + '';
      ctx.fillText(lab, cx, cy - R * f + 6);
    }
    const nAng = -Math.PI / 2 - (heading * Math.PI) / 180;
    const nx = cx + Math.cos(nAng) * (R - 10);
    const ny = cy + Math.sin(nAng) * (R - 10);
    ctx.fillStyle = COL.white;
    ctx.font = '800 11px ' + FONT_STACK;
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
    // heading bug (fixed triangle at top of rim)
    ctx.fillStyle = COL.cyan;
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy - R + 1);
    ctx.lineTo(cx + 5, cy - R + 1);
    ctx.lineTo(cx, cy - R + 8);
    ctx.closePath();
    ctx.fill();
    // plane symbol (fixed centre, pointing up) + heading stalk
    ctx.strokeStyle = 'rgba(62,242,255,0.6)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 10);
    ctx.lineTo(cx, cy - 18);
    ctx.stroke();
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
    setText(capScoreValue, 'score', Math.round(num(fs.score, 0)).toLocaleString('en-US'));
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
    setText(pryRows.pitch.value, 'pry:pitch', signed1(sm.pitch));
    setText(pryRows.roll.value, 'pry:roll', signed1(sm.roll));
    setText(pryRows.yaw.value, 'pry:yaw', signed1(fs.yawDeg));

    /* ZONE 8: BOTTOM-CENTRE (update) */
    setText(flapsChip.value, 'flaps', Math.round(num(fs.flapsDeg, 0)) + '°');
    const gear = fs.gear || 'DOWN';
    setText(gearChip.value, 'gear', gear);
    setFlag(gearChip.chip, 'gear', 'hf-gear-down', gear === 'DOWN');
    setFlag(gearChip.chip, 'gear', 'hf-gear-moving', gear === 'MOVING');
    setFlag(gearChip.chip, 'gear', 'hf-gear-up', gear === 'UP');
    setFlag(gearDots, 'geardots', 'hf-dots-down', gear === 'DOWN');
    setFlag(gearDots, 'geardots', 'hf-dots-moving', gear === 'MOVING');
    setFlag(gearDots, 'geardots', 'hf-dots-up', gear === 'UP');
    setText(brakesChip.value, 'brakes', fs.brakes || 'OFF');
    setFlag(brakesChip.chip, 'brakes', 'hf-chip-on', fs.brakes === 'ON');
    setFlag(brakesChip.chip, 'brakes', 'hf-chip-amber', fs.brakes === 'ARMED');
    setFlag(brakesChip.chip, 'brakes', 'hf-chip-off', !fs.brakes || fs.brakes === 'OFF');
    setText(lightsChip.value, 'lights', fs.lights || 'OFF');
    setFlag(lightsChip.chip, 'lights', 'hf-chip-on', fs.lights === 'ON');
    setFlag(lightsChip.chip, 'lights', 'hf-chip-off', fs.lights !== 'ON');
    setText(spoilersChip.value, 'spoilers', fs.spoilers || 'OFF');
    setFlag(spoilersChip.chip, 'spoilers', 'hf-chip-amber', fs.spoilers === 'ARMED');
    setFlag(spoilersChip.chip, 'spoilers', 'hf-chip-on', fs.spoilers === 'ON' || fs.spoilers === 'DEPLOYED');
    setFlag(spoilersChip.chip, 'spoilers', 'hf-chip-off', !fs.spoilers || fs.spoilers === 'OFF');
    const destDist = fs.distM !== undefined ? num(fs.distM, 0) : num(fs.destDistM, 0);
    setText(destBarText, 'destbar', '▲ ' + (fs.destLabel || '—') + ' · ' + Math.round(destDist) + ' M');
    setStyle(destProgressFill, 'destprog', 'width', (clamp(num(fs.destProgress01, 0), 0, 1) * 100).toFixed(1) + '%');

    /* ZONE 9: BOTTOM-RIGHT (update) */
    const thrRaw = fs.throttle !== undefined ? num(fs.throttle, 0) : num(fs.throttle01, 0);
    const thr01 = thrRaw > 1 ? clamp(thrRaw / 100, 0, 1) : clamp(thrRaw, 0, 1);
    setStyle(thrFill, 'thr', 'width', (thr01 * 100).toFixed(1) + '%');
    setText(thrPct, 'thrpct', Math.round(thr01 * 100) + '%');
    setText(rpmRow.value, 'rpm', Math.round(num(fs.rpm, 0)).toLocaleString('en-US'));
    const fuelPct = clamp(num(fs.fuelPct, 0), 0, 100);
    setText(fuelRow.value, 'fuel', Math.round(fuelPct) + '% (' + Math.round(num(fs.fuelLitres, 0)) + ' L · ' + fmtFuelTime(fs.fuelTimeH) + ')');
    setStyle(fuelFill, 'fuelbar', 'width', fuelPct.toFixed(1) + '%');
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
    const acir = fs.acir !== undefined ? num(fs.acir, 0) : g;
    setText(acirValue, 'acir', acir.toFixed(2));
    const trim = num(fs.trim, 0);
    setText(trimValue, 'trim', (trim > 0 ? '+' : '') + trim.toFixed(1));
    const caution = fs.caution || null;
    const isRed = !!(caution && caution.level === 'red');
    const ok = fs.systemsOk !== false && !caution;
    setText(sysStripText, 'sysstrip', isRed ? 'SYSTEMS WARNING' : ok ? 'ALL SYSTEMS NOMINAL' : 'SYSTEMS CAUTION');
    setFlag(sysStrip, 'sysstrip', 'hf-sys-ok', ok && !isRed);
    setFlag(sysStrip, 'sysstrip', 'hf-sys-caution', !ok && !isRed);
    setFlag(sysStrip, 'sysstrip', 'hf-sys-warning', isRed);
    setFlag(sysStrip, 'sysstrip', 'hf-blink-red', isRed);
    setText(sysCheck, 'syscheck', isRed ? '!' : ok ? '✓' : '!');
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
