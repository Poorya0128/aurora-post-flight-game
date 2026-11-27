// AURORA POST — HUD and menu screens (A8, per ui_spec.md and design.md §7.3).
// DOM/CSS overlay over the WebGL canvas. All dynamic text via textContent.
// createHud(rootEl) -> { update(sim), showScreen(name, data), toast(msg),
//                        onAction(handler), setActionHandler(handler), destroy() }
//
// The flight readouts, ribbon scale, AIRFRAME integrity display,
// bottom-centre target panel, progress wording and minimap are
// display-only (visual_spec.md §4 HUD lock): no flight/mission/
// scoring/input state is read beyond the sim fields already consumed
// here, plus plane/target positions and the static config island/
// strip tables for the minimap backdrop.

import { ISLANDS as CONFIG_ISLANDS, STRIPS as CONFIG_STRIPS, WORLD_SIZE as CONFIG_WORLD_SIZE } from './config.js';
import * as hudInstrumentsModule from './hud-instruments.js';
import { createFullHud } from './hud-full.js';
import * as lensFlareModule from './lens-flare.js';
import * as menuArtModule from './menu-art.js';
import { MISSIONS as MENU_MISSIONS } from './missions.js';
import { drawRadar, drawHoloMap } from './holo-map.js';

const STAGE_WIDTH = 1280;
const STAGE_HEIGHT = 720;

// FULL HUD wiring (2026-11-27, hud-spec-fa.md): the glass HUD in
// hud-full.js replaces the concept dial cluster + digital panels +
// radar minimap in every camera mode. This file only adapts sim state
// into the flightState contract hud-full.js renders.
const FS_SMOOTH_TAU_S = 0.1; // ~100 ms lerp on continuous values
const FS_SPEED_HISTORY_S = 5; // speed-trend lookback window
const FS_COMBO_WINDOW_S = 12; // combo streak survives this long without an event
const MS_TO_KT = 1.944;

// hud-full.js minimap reads flat {x, z, radius} / {x, z, headingDeg}
// tables; config.js stores centre/position objects — map once here.
const FS_MINIMAP_ISLANDS = (CONFIG_ISLANDS || []).map((island) => {
  const c = island.centre || island.center || island.position || { x: 0, z: 0 };
  return { x: c.x || 0, z: c.z || 0, radius: island.radius || 0 };
});
const FS_MINIMAP_STRIPS = (CONFIG_STRIPS || []).map((strip) => {
  const p = strip.position || strip.centre || strip.center || { x: 0, z: 0 };
  return { x: p.x || 0, z: p.z || 0, headingDeg: strip.headingDeg || 0 };
});

function makeNode(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function wrapDegrees360(degrees) {
  let wrapped = degrees % 360;
  if (wrapped < 0) wrapped += 360;
  return wrapped;
}

function wrapDegrees180(degrees) {
  let wrapped = wrapDegrees360(degrees);
  if (wrapped > 180) wrapped -= 360;
  return wrapped;
}

function padTwoDigits(value) {
  return value < 10 ? '0' + value : String(value);
}

function padThreeDigits(value) {
  const digits = String(value);
  if (digits.length >= 3) return digits;
  return digits.length === 2 ? '0' + digits : '00' + digits;
}

// Progress wording (visual_spec §4.2): the objective line names the
// NEXT ring while the progress line counts CLEARED rings, so the
// two numbers can never read as a disagreement. missions.js and
// shots.js still emit the legacy "Ring 3/10" / "Parcels 2/4"
// strings; they are normalised here at the display layer only —
// no mission logic is touched.
function normaliseProgressLine(line) {
  if (!line) return line;
  const text = String(line).trim();
  const ringsMatch = /^rings?\s+(\d+)\s*\/\s*\d+$/i.exec(text);
  if (ringsMatch) return ringsMatch[1] + ' cleared';
  const parcelsMatch = /^parcels\s+(\d+)\s*\/\s*(\d+)$/i.exec(text);
  if (parcelsMatch) return 'Parcels ' + parcelsMatch[1] + '/' + parcelsMatch[2] + ' delivered';
  return line;
}

function formatClock(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return padTwoDigits(minutes) + ':' + padTwoDigits(seconds);
}

function formatScore(score) {
  const safeScore = Math.round(score || 0);
  return safeScore.toLocaleString('en-US');
}

function formatDistance(distanceMetres) {
  if (distanceMetres === null || distanceMetres === undefined || !isFinite(distanceMetres)) return '--';
  if (distanceMetres >= 1000) return (distanceMetres / 1000).toFixed(2) + ' KM';
  return Math.round(distanceMetres) + ' M';
}

// Accept 0..1 fractions (PlaneState) or 0..100 percents.
function toPercent(value) {
  if (value === null || value === undefined || !isFinite(value)) return 0;
  return value <= 1 ? value * 100 : value;
}

function firstDefined() {
  for (let i = 0; i < arguments.length; i++) {
    if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
  }
  return null;
}

// FULL HUD adapter helpers (pure).
function numOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value, low, high) {
  return value < low ? low : (value > high ? high : value);
}

// Runway designator from strip heading: 90° -> '09', 0° -> '36'.
function runwayLabelForHeading(headingDeg) {
  let n = Math.round(wrapDegrees360(numOr(headingDeg, 0)) / 10) % 36;
  if (n === 0) n = 36;
  return padTwoDigits(n);
}

export function createHud(rootEl) {
  if (!rootEl) throw new Error('createHud requires a root element');

  let actionHandler = null;
  let currentScreenName = null;
  let currentScreenData = null;
  let toastTimerId = null;
  let viewLabelTimerId = null;
  let lastViewLabel = '';
  // FULL HUD adapter state (mode, smoothing, combo…) lives with
  // buildFlightState below.

  // Cache of last-written strings/styles so update() only touches the DOM
  // when a displayed value actually changes.
  const domCache = new Map();

  function setText(node, key, text) {
    const value = String(text);
    if (domCache.get(key) === value) return;
    domCache.set(key, value);
    node.textContent = value;
  }

  function setStyle(node, key, property, value) {
    const cacheKey = key + ':' + property;
    if (domCache.get(cacheKey) === value) return;
    domCache.set(cacheKey, value);
    node.style[property] = value;
  }

  function setClassFlag(node, key, className, enabled) {
    const cacheKey = key + ':class:' + className;
    const value = enabled ? 'on' : 'off';
    if (domCache.get(cacheKey) === value) return;
    domCache.set(cacheKey, value);
    node.classList.toggle(className, enabled);
  }

  // main.js (A7) listens for window 'aurora:action' events with its own
  // action vocabulary; onAction consumers receive the semantic HUD names.
  const mainActionNames = {
    fly: 'confirm',
    sound: 'mute',
    back: 'menu',
    resume: 'pause',
    retry: 'restart',
    next: 'confirm',
    start: 'launch',
  };

  function emitAction(actionName, payload) {
    const safePayload = payload || {};
    if (typeof actionHandler === 'function') actionHandler(actionName, safePayload);
    const mainActionName = mainActionNames[actionName] || actionName;
    window.dispatchEvent(new CustomEvent('aurora:action', {
      detail: Object.assign({ action: mainActionName }, safePayload),
    }));
  }

  // onAction registers the handler main.js uses for button/keyboard actions.
  function onAction(handler) {
    if (typeof handler === 'function') actionHandler = handler;
  }

  // Buttons may carry an icon, a sub-label and a keycap; with none
  // of those they stay the plain text buttons the flight overlays
  // use. Rich buttons expose labelElement/iconElement so callers
  // can relabel them without rebuilding.
  function makeButton(label, actionName, payload, extraClass, options) {
    const opts = options || {};
    const isRich = !!(opts.icon || opts.key || opts.sub);
    const button = makeNode('button',
      'btn' + (extraClass ? ' ' + extraClass : '') + (isRich ? ' btn-rich' : ''));
    button.type = 'button';
    if (isRich) {
      let iconElement = null;
      if (opts.icon) {
        iconElement = makeNode('span', 'btn-icon');
        iconElement.innerHTML = menuArtModule.iconSvg(opts.icon, 20);
        button.appendChild(iconElement);
      }
      const textBox = makeNode('span', 'btn-text');
      const labelElement = makeNode('span', 'btn-label', label);
      textBox.appendChild(labelElement);
      if (opts.sub) textBox.appendChild(makeNode('span', 'btn-sub', opts.sub));
      button.appendChild(textBox);
      if (opts.key) button.appendChild(makeNode('kbd', 'btn-key', opts.key));
      button.labelElement = labelElement;
      button.iconElement = iconElement;
    } else {
      button.textContent = label;
    }
    button.addEventListener('click', () => emitAction(actionName, payload));
    return button;
  }

  function setButtonLabel(button, label) {
    if (button.labelElement) button.labelElement.textContent = label;
    else button.textContent = label;
  }

  // ---------- stage + scaling ----------

  const stage = makeNode('div');
  stage.id = 'hud-stage';
  rootEl.appendChild(stage);

  function fitStageToWindow() {
    const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
    stage.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
  }
  window.addEventListener('resize', fitStageToWindow);
  fitStageToWindow();

  // ---------- flight HUD construction (FULL HUD) ----------

  // The glass HUD (hud-full.js, hud-spec-fa.md 2026-11-27) owns every
  // flight readout in every camera mode: mode/wind/OAT, score capsule,
  // heading tape + destination card, centre guidance (FPM, pitch
  // ladder, bank arc, GS/LOC), speed/altitude tapes, minimap, system
  // chips and the engine/fuel panel. It mounts on the HUD root
  // (viewport-relative zones, concept-ui.css /* === CONCEPT: HUD FULL
  // === */), not the scaled stage. hud.js keeps only the transient
  // overlays the new HUD does not cover: warning pills, toast, view
  // label, keys hint and the 3D target bracket (hud-instruments.js;
  // its ADI/engine panels are hidden by concept-ui.css
  // /* === CONCEPT: HUD FULL WIRING === */). The flight-path marker
  // and HUD combiner stay removed.
  let fullHud = null;
  try {
    fullHud = createFullHud(rootEl);
  } catch (error) {
    fullHud = null; // flight HUD is dressing; the game must still boot
  }

  // Warnings stack
  const warningsBox = makeNode('div', 'hud-flight-only');
  warningsBox.id = 'hud-warnings';
  stage.appendChild(warningsBox);
  const warningPills = new Map(); // warning key -> pill element

  // View label, flight-path marker, keys hint, minimap, toast.
  // VD-06: view label + keys hint sit on .hud-panel scrims — no bare
  // text over the 3D scene (visual_spec §4.2/§4.3).
  const viewLabel = makeNode('div', 'hud-panel hud-flight-only');
  viewLabel.id = 'hud-view-label';
  stage.appendChild(viewLabel);

  const keysHint = makeNode('div', 'hud-panel hud-flight-only hud-secondary', 'C CAMERA · P PAUSE · R RESTART · H HUD');
  keysHint.id = 'hud-keys-hint';
  stage.appendChild(keysHint);

  // Glass instruments (hud-instruments.js): attitude indicator +
  // engine RPM in the side columns, and the 3D target bracket.
  let instruments = null;
  try {
    instruments = hudInstrumentsModule.createHudInstruments(stage);
  } catch (error) {
    instruments = null; // the HUD stands alone without them
  }
  let lensFlare = null;
  try {
    lensFlare = lensFlareModule.createLensFlare(stage);
  } catch (error) {
    lensFlare = null; // optical dressing only
  }

  const toastBox = makeNode('div');
  toastBox.id = 'hud-toast';
  stage.appendChild(toastBox);

  function toast(message, durationMs) {
    toastBox.textContent = String(message || '');
    toastBox.classList.add('visible');
    if (toastTimerId) clearTimeout(toastTimerId);
    toastTimerId = setTimeout(() => toastBox.classList.remove('visible'), durationMs || 3000);
  }

  // ---------- warnings ----------

  function syncWarnings(activeWarnings) {
    // activeWarnings: array of { key, text, red, blink }
    const activeKeys = new Set(activeWarnings.map((warning) => warning.key));
    for (const [key, pill] of warningPills) {
      if (!activeKeys.has(key)) {
        pill.remove();
        warningPills.delete(key);
      }
    }
    for (const warning of activeWarnings) {
      let pill = warningPills.get(warning.key);
      if (!pill) {
        pill = makeNode('div', 'warning-pill');
        warningPills.set(warning.key, pill);
        warningsBox.appendChild(pill);
      }
      setText(pill, 'warning:' + warning.key, warning.text);
      setClassFlag(pill, 'warning:' + warning.key, 'warning-red', !!warning.red);
      setClassFlag(pill, 'warning:' + warning.key, 'warning-blink', !!warning.blink);
    }
  }

  // ---------- sim field extraction (defensive: contracts in interfaces.md) ----------

  // D-134: extractHudState runs every frame; the state object, warnings
  // array and warning entries are scratch reused across frames (update()
  // reads them synchronously and retains nothing). DOM writes were
  // already value-cached via domCache.
  const hudState = {
    phase: 'flying', timeSeconds: 0, score: 0, cameraMode: 'chase',
    hudMinimal: false, forceHud: false,
    altitudeMetres: 0, airspeedMps: 0, headingDeg: 0, verticalSpeedMps: 0,
    fuelPercent: 0, damagePercent: 0, throttlePercent: 0, flapStage: 0,
    windSpeedMps: 0, windDirectionDeg: 0, hasWind: false,
    objectiveLine: '', progressLine: '',
    targetLabel: '', targetDistanceMetres: null, targetRelativeBearingDeg: null,
    planeX: 0, planeZ: 0, targetX: 0, targetZ: 0, hasTargetPosition: false,
    warnings: [],
  };
  const warningPool = [];

  function pushWarning(key, text, red, blink) {
    const index = hudState.warnings.length;
    let warning = warningPool[index];
    if (!warning) {
      warning = { key: '', text: '', red: false, blink: false };
      warningPool[index] = warning;
    }
    warning.key = key;
    warning.text = text;
    warning.red = !!red;
    warning.blink = !!blink;
    hudState.warnings.push(warning);
  }

  function extractHudState(sim) {
    const plane = (sim && sim.plane) || sim || {};
    const mission = (sim && sim.mission) || {};
    const controls = (sim && sim.controls) || {};

    const altitudeMetres = firstDefined(plane.altitudeAgl, plane.altitudeMsl, plane.altitude,
      plane.position && plane.position.y, 0);
    const airspeedMps = firstDefined(plane.airspeed, plane.speed, 0);
    const headingDeg = wrapDegrees360(firstDefined(plane.headingDeg, plane.heading, 0));
    const verticalSpeedMps = firstDefined(plane.verticalSpeed, plane.verticalSpeedMps,
      plane.velocity && plane.velocity.y, 0);
    const fuelPercent = toPercent(firstDefined(plane.fuel, 1));
    const damagePercent = toPercent(firstDefined(plane.damage, 0));
    const throttlePercent = toPercent(firstDefined(plane.throttle, controls.throttle, 0));
    const flapStage = firstDefined(plane.flaps, plane.flapStage, controls.flaps, 0);

    const wind = firstDefined(sim && sim.wind, mission.wind, plane.wind, null);
    const windSpeedMps = wind ? firstDefined(wind.speed, wind.speedMps, wind.mps, 0) : 0;
    const windDirectionDeg = wind ? wrapDegrees360(firstDefined(wind.directionDeg, wind.dirDeg, wind.direction, 0)) : 0;

    const objectiveLine = firstDefined(mission.objectiveLine, mission.objective, sim && sim.objective, '');
    let progressLine = firstDefined(mission.progressText, mission.progressLine, '');
    if (!progressLine && mission.progress && typeof mission.progress === 'object') {
      const progress = mission.progress;
      if (progress.total !== undefined) {
        progressLine = (progress.label ? progress.label + ' ' : '') + (progress.current || 0) + '/' + progress.total;
      }
    }
    if (!progressLine && mission.ringsTotal !== undefined) {
      progressLine = (mission.ringsHit || 0) + ' cleared';
    }
    if (!progressLine && mission.parcelsTotal !== undefined) {
      progressLine = 'Parcels ' + (mission.parcelsDelivered || 0) + '/' + mission.parcelsTotal + ' delivered';
    }
    progressLine = normaliseProgressLine(progressLine);

    const target = firstDefined(mission.target, sim && sim.target, mission.nextTarget, null);
    let targetLabel = '';
    let targetDistanceMetres = null;
    let targetRelativeBearingDeg = null;
    let targetX = 0;
    let targetZ = 0;
    let hasTargetPosition = false;
    if (target) {
      targetLabel = firstDefined(target.label, target.name, 'TARGET');
      targetDistanceMetres = firstDefined(target.distance, target.distanceMetres, null);
      targetRelativeBearingDeg = firstDefined(target.relativeBearingDeg, null);
      const targetPosition = target.position;
      if (targetPosition && typeof targetPosition.x === 'number' && typeof targetPosition.z === 'number') {
        targetX = targetPosition.x;
        targetZ = targetPosition.z;
        hasTargetPosition = true;
      }
      if (targetRelativeBearingDeg === null && target.bearingDeg !== undefined) {
        targetRelativeBearingDeg = wrapDegrees180(target.bearingDeg - headingDeg);
      }
      if (targetPosition && plane.position) {
        const dx = targetPosition.x - plane.position.x;
        const dz = targetPosition.z - plane.position.z;
        if (targetDistanceMetres === null) targetDistanceMetres = Math.sqrt(dx * dx + dz * dz);
        if (targetRelativeBearingDeg === null) {
          // Heading 0 = north (-Z), clockwise: bearing = atan2(east, -north)
          const bearingDeg = wrapDegrees360(Math.atan2(dx, -dz) * 180 / Math.PI);
          targetRelativeBearingDeg = wrapDegrees180(bearingDeg - headingDeg);
        }
      }
    }

    hudState.warnings.length = 0;
    const extraWarnings = firstDefined(sim && sim.warnings, mission.warnings, null);
    if (Array.isArray(extraWarnings)) {
      extraWarnings.forEach((warning, index) => {
        if (typeof warning === 'string') pushWarning('extra-' + index, warning, false, false);
        else if (warning && warning.text) {
          pushWarning(warning.key || 'extra-' + index, warning.text, warning.red, warning.blink);
        }
      });
    }
    if (plane.stalled) pushWarning('stall', 'STALL', true, true);
    if (airspeedMps > 65) pushWarning('overspeed', 'OVERSPEED', true, false);
    if (fuelPercent <= 0 && plane.engineOn === false) {
      pushWarning('engine-out', 'ENGINE OUT — GLIDE TO A STRIP', false, false);
    } else if (fuelPercent < 10) {
      pushWarning('fuel-critical', 'FUEL CRITICAL', true, true);
    } else if (fuelPercent < 25) {
      pushWarning('fuel-low', 'FUEL LOW', false, false);
    }
    if (damagePercent >= 75) pushWarning('airframe-critical', 'AIRFRAME CRITICAL — PUT IT DOWN', true, false);
    else if (damagePercent >= 50) pushWarning('damage', 'DAMAGE', false, false);
    const singleWarning = firstDefined(sim && sim.warning, mission.warning, null);
    if (typeof singleWarning === 'string' && singleWarning) {
      pushWarning('single', singleWarning, false, false);
    }

    hudState.phase = firstDefined(sim && sim.phase, 'flying');
    hudState.timeSeconds = firstDefined(sim && sim.time, 0);
    hudState.score = firstDefined(sim && sim.score, mission.score, 0);
    hudState.cameraMode = String(firstDefined(sim && sim.cameraMode, sim && sim.view, sim && sim.camera, 'chase')).toLowerCase();
    hudState.hudMinimal = !!(sim && (sim.hudMinimal || sim.minimalHud));
    hudState.forceHud = !!(sim && sim.forceHud);
    hudState.altitudeMetres = altitudeMetres;
    hudState.airspeedMps = airspeedMps;
    hudState.headingDeg = headingDeg;
    hudState.verticalSpeedMps = verticalSpeedMps;
    hudState.fuelPercent = fuelPercent;
    hudState.damagePercent = damagePercent;
    hudState.throttlePercent = throttlePercent;
    hudState.flapStage = flapStage;
    hudState.windSpeedMps = windSpeedMps;
    hudState.windDirectionDeg = windDirectionDeg;
    hudState.hasWind = !!wind;
    hudState.objectiveLine = objectiveLine ? String(objectiveLine) : '';
    hudState.progressLine = progressLine ? String(progressLine) : '';
    hudState.targetLabel = targetLabel;
    hudState.targetDistanceMetres = targetDistanceMetres;
    hudState.targetRelativeBearingDeg = targetRelativeBearingDeg;
    hudState.planeX = plane.position && typeof plane.position.x === 'number' ? plane.position.x : 0;
    hudState.planeZ = plane.position && typeof plane.position.z === 'number' ? plane.position.z : 0;
    hudState.targetX = targetX;
    hudState.targetZ = targetZ;
    hudState.hasTargetPosition = hasTargetPosition;
    // Full 3D target point for the screen-space bracket: handed over
    // only when the target carries a finite height, so nothing is
    // ever guessed at.
    const targetPoint = target && target.position;
    hudState.targetWorld = targetPoint
      && typeof targetPoint.x === 'number' && typeof targetPoint.y === 'number'
      && typeof targetPoint.z === 'number' && Number.isFinite(targetPoint.y)
      ? targetPoint : null;
    return hudState;
  }

  // ---------- FULL HUD flightState adapter ----------
  //
  // Builds the flightState contract hud-full.js renders, from sim +
  // the extracted hud state. Continuous values get a ~100 ms lerp
  // (FS_SMOOTH_TAU_S); discrete states (mode, gear, caution, goals…)
  // pass through immediately. hud-full.js smooths speed/alt/heading/
  // pitch/roll/vs/ra/aoa itself (sm.*), so those pass through raw
  // here — smoothing them in both layers cascaded to ~200 ms lag.
  // Real-vs-derived per field is documented in the
  // wiring report; derived values: combo, speedTrendMs, fpm, aoaDeg,
  // yawDeg (slip/drift), glideslope/localizer deviations, oatC,
  // fuel litres/flow/time, oilC, gLoad, trim, destProgress01.

  const flightState = {
    mode: 'TAXI', timeSeconds: 0, score: 0, combo: 1, scorePulse: false,
    ap: false, at: false, fd: true, // no autopilot/autothrottle in sim; FD on (target image)
    windDirDeg: 0, windKt: 0, windRelDeg: 0, oatC: 18, qnh: 1013,
    missionTitle: 'FREE FLIGHT', missionSub: '',
    goals: [
      { label: '', done: false }, { label: '', done: false }, { label: '', done: false },
    ],
    headingDeg: 0, rwyLabel: '', distM: 0, etaSec: 0,
    fpm: { xDeg: 0, yDeg: 0 }, pitchDeg: 0, rollDeg: 0, yawDeg: 0,
    glideslopeDev: 0, localizerDev: 0, onPath: 'none',
    speedMs: 0, speedTrendMs: 0, gsMs: 0, mach: 0, altM: 0, vsMs: 0, raM: 0, aoaDeg: 0,
    minimap: {
      planeX: 0, planeZ: 0, headingDeg: 0, targetX: 0, targetZ: 0, hasTarget: false,
      strips: FS_MINIMAP_STRIPS, islands: FS_MINIMAP_ISLANDS, worldSize: CONFIG_WORLD_SIZE,
    },
    flapsDeg: 0, gear: 'DOWN', brakes: 'OFF', lights: 'ON', spoilers: 'OFF',
    destLabel: '', destDistM: 0, destProgress01: 0,
    throttle01: 0, rpm: 0, fuelPct: 0, fuelLitres: 0, fuelTimeH: 0, fuelFlowLh: 0,
    oilC: 20, gLoad: 1, trim: 0,
    caution: null, systemsOk: true,
  };
  const fsCaution = { level: 'amber', label: '' }; // reused; hud-full reads label+level
  const fsSmooth = {
    speedMs: null, gsMs: null, altM: null, vsMs: null, pitchDeg: null, rollDeg: null,
    headingDeg: null, windDirDeg: null, windKt: null, throttle01: null, rpm: null,
    fuelPct: null, oilC: null, gLoad: null, fpmX: null, fpmY: null,
    glideslopeDev: null, localizerDev: null, aoaDeg: null, speedTrendMs: null,
  };

  let lastFsMs = 0;
  let lastFsTime = null;
  let lastMissionKey = null;
  let prevScoreFs = null;
  let comboStreak = 0;
  let comboLastCount = 0;
  let comboLastEventTime = -Infinity;
  const speedHistory = []; // {t, v} samples for the 5 s trend
  let destInitialKey = '';
  let destInitialDist = 0;
  let prevVsFs = 0;
  let prevGsFs = 0;
  let fsHasFlown = false;

  let hudDisplayMode = 'FULL'; // FULL | MINIMAL | OFF (H key, in flight)
  let lastAppliedHudMode = null;
  let lastSimPhase = 'menu';
  let lastHideFlightHud = true;

  function lerpFs(key, raw, alpha) {
    const prev = fsSmooth[key];
    const next = prev === null ? raw : prev + (raw - prev) * alpha;
    fsSmooth[key] = next;
    return next;
  }

  function lerpAngleFs(key, raw, alpha) {
    const prev = fsSmooth[key];
    if (prev === null) { fsSmooth[key] = raw; return raw; }
    const next = wrapDegrees360(prev + wrapDegrees180(raw - prev) * alpha);
    fsSmooth[key] = next;
    return next;
  }

  function resetFsTrackers(mission, state) {
    for (const key of Object.keys(fsSmooth)) fsSmooth[key] = null;
    prevScoreFs = state ? state.score : null;
    comboStreak = 0;
    comboLastCount = mission ? (numOr(mission.ringsHit, 0) + numOr(mission.parcelsDelivered, 0)) : 0;
    comboLastEventTime = -Infinity;
    speedHistory.length = 0;
    destInitialKey = '';
    destInitialDist = 0;
    prevVsFs = state ? state.verticalSpeedMps : 0;
    prevGsFs = 0;
    fsHasFlown = false;
  }

  function normaliseFsStrip(strip) {
    if (!strip) return null;
    const p = strip.position || strip.centre || strip.center || { x: 0, z: 0 };
    return {
      id: strip.id || '', name: strip.name || strip.id || 'Strip',
      headingDeg: numOr(strip.headingDeg, 0), x: p.x || 0, z: p.z || 0,
    };
  }

  // Which strip (if any) the current target is. Type-based primary
  // (missions.js target semantics), then position/label match against
  // mission + config strips (covers staged shot targets).
  function findTargetStrip(mission, state) {
    let strip = null;
    if (mission) {
      if (mission.type === 'precision') strip = mission.targetStrip || null;
      else if (mission.type === 'delivery') strip = mission.unloaded ? (mission.homeStrip || null) : (mission.destinationStrip || null);
      else if (mission.type === 'ring' && Array.isArray(mission.rings) && numOr(mission.nextRingIndex, 0) >= mission.rings.length) strip = mission.homeStrip || null;
      else if (mission.type === 'cargo' && Array.isArray(mission.dropZones) && numOr(mission.activeZoneIndex, 0) >= mission.dropZones.length) strip = mission.homeStrip || null;
    }
    if (strip) return normaliseFsStrip(strip);
    if (state.hasTargetPosition) {
      const pools = [];
      if (mission && Array.isArray(mission.strips)) pools.push(...mission.strips);
      pools.push(...(CONFIG_STRIPS || []));
      for (const candidate of pools) {
        const n = normaliseFsStrip(candidate);
        if (!n) continue;
        const dx = n.x - state.targetX;
        const dz = n.z - state.targetZ;
        if (dx * dx + dz * dz <= 60 * 60) return n;
      }
      const label = (state.targetLabel || '').toLowerCase();
      if (label) {
        for (const candidate of pools) {
          const n = normaliseFsStrip(candidate);
          if (n && n.name && n.name.toLowerCase() === label) return n;
        }
      }
    }
    return null;
  }

  function setGoal(index, label, done) {
    flightState.goals[index].label = label;
    flightState.goals[index].done = !!done;
  }

  function buildFsGoals(mission, plane, state, elapsed) {
    if (!mission) {
      setGoal(0, 'TAKE OFF', fsHasFlown);
      setGoal(1, 'LAND AT ANY STRIP', fsHasFlown && !!plane.onGround);
      setGoal(2, 'REFUEL TO 100%', state.fuelPercent >= 99.5);
      return;
    }
    const par = numOr(mission.parTime, 0);
    const parDone = !!mission.complete && par > 0 && elapsed <= par;
    if (mission.type === 'ring') {
      const total = Array.isArray(mission.rings) ? mission.rings.length : 0;
      const hit = numOr(mission.ringsHit, 0);
      setGoal(0, 'RINGS ' + hit + '/' + total, total > 0 && numOr(mission.nextRingIndex, 0) >= total);
      setGoal(1, 'LAND AT ANY STRIP', mission.complete);
      setGoal(2, par > 0 ? 'PAR ' + formatClock(par) : 'HOME STRIP BONUS', parDone);
    } else if (mission.type === 'cargo') {
      const total = Array.isArray(mission.dropZones) ? mission.dropZones.length : 0;
      const delivered = numOr(mission.parcelsDelivered, 0);
      setGoal(0, 'PARCELS ' + delivered + '/' + total, total > 0 && delivered >= total);
      setGoal(1, 'ZONES ' + numOr(mission.activeZoneIndex, 0) + '/' + total, total > 0 && numOr(mission.activeZoneIndex, 0) >= total);
      setGoal(2, 'LAND AT ANY STRIP', mission.complete);
    } else if (mission.type === 'delivery') {
      const destName = mission.destinationStrip && mission.destinationStrip.name ? mission.destinationStrip.name : 'DESTINATION';
      const homeName = mission.homeStrip && mission.homeStrip.name ? mission.homeStrip.name : 'HOME';
      setGoal(0, 'DELIVER TO ' + String(destName).toUpperCase(), mission.unloaded);
      setGoal(1, 'FLY HOME — ' + String(homeName).toUpperCase(), mission.complete);
      setGoal(2, par > 0 ? 'PAR ' + formatClock(par) : 'SAFE LANDING', parDone);
    } else if (mission.type === 'precision') {
      const stripName = mission.targetStrip && mission.targetStrip.name ? mission.targetStrip.name : 'TARGET STRIP';
      const grade = mission.touchdownGrade || null;
      const onTargetStrip = !!(grade && grade.onStrip && mission.targetStrip && grade.stripId === mission.targetStrip.id);
      setGoal(0, 'LAND ON ' + String(stripName).toUpperCase(), onTargetStrip);
      setGoal(1, 'GRADE A OR BETTER', !!(grade && numOr(grade.total, 0) >= 700));
      setGoal(2, 'TOUCHDOWN 22–26 M/S', !!(grade && numOr(grade.touchdownSpeed, 0) >= 22 && numOr(grade.touchdownSpeed, 0) <= 26));
    } else {
      setGoal(0, state.progressLine || 'OBJECTIVE', mission.complete);
      setGoal(1, 'LAND AT ANY STRIP', mission.complete);
      setGoal(2, par > 0 ? 'PAR ' + formatClock(par) : 'SAFE LANDING', parDone);
    }
  }

  function buildFlightState(sim, state) {
    const plane = (sim && sim.plane) || {};
    const mission = (sim && sim.mission) || null;
    const controls = (sim && sim.controls) || {};
    const fs = flightState;

    const nowMs = performance.now();
    const dt = lastFsMs ? clampNumber((nowMs - lastFsMs) / 1000, 0, 0.25) : 0;
    lastFsMs = nowMs;

    const missionKey = mission ? (mission.id || 'mission') : 'free-flight';
    const timeReset = lastFsTime !== null && state.timeSeconds < lastFsTime - 0.001;
    if (missionKey !== lastMissionKey || timeReset) {
      lastMissionKey = missionKey;
      resetFsTrackers(mission, state);
    }
    lastFsTime = state.timeSeconds;
    const snap = fsSmooth.gsMs === null;
    const alpha = snap || dt <= 0 ? 1 : 1 - Math.exp(-dt / FS_SMOOTH_TAU_S);

    // Raw flight values.
    const pitchRaw = numOr(plane.pitchDeg, 0);
    const rollRaw = numOr(plane.rollDeg, 0);
    const velocity = plane.velocity || {};
    const vx = numOr(velocity.x, 0);
    const vy = numOr(velocity.y, state.verticalSpeedMps);
    const vz = numOr(velocity.z, 0);
    const horizSpeed = Math.hypot(vx, vz);
    const gsRaw = numOr(plane.groundSpeed, horizSpeed);
    const speedRaw = state.airspeedMps;
    const altRaw = state.altitudeMetres; // AGL (hudState prefers it)
    const altMsl = numOr(plane.altitudeMsl, plane.position ? numOr(plane.position.y, altRaw) : altRaw);
    const vsRaw = state.verticalSpeedMps;
    const headingRaw = state.headingDeg;
    const onGround = !!plane.onGround;
    if (!onGround) fsHasFlown = true;
    const elapsed = mission ? numOr(mission.elapsed, state.timeSeconds) : state.timeSeconds;

    // Flight-path marker angles (deg): FPA vs pitch, velocity track vs heading.
    const fpaDeg = horizSpeed > 0.5 ? (Math.atan2(vy, horizSpeed) * 180) / Math.PI : 0;
    const velHeadingDeg = horizSpeed > 0.5 ? wrapDegrees360((Math.atan2(vx, -vz) * 180) / Math.PI) : headingRaw;
    const fpmXRaw = clampNumber(wrapDegrees180(velHeadingDeg - headingRaw), -45, 45);
    const fpmYRaw = clampNumber(fpaDeg - pitchRaw, -45, 45);
    const aoaRaw = pitchRaw - fpaDeg;

    // Target / destination (existing hud target logic).
    const distRaw = state.targetDistanceMetres === null ? 0 : state.targetDistanceMetres;
    const targetStrip = findTargetStrip(mission, state);
    const targetIsStrip = !!targetStrip;

    // Approach guidance (strip targets only).
    let gsDevRaw = 0;
    let locDevRaw = 0;
    if (targetIsStrip) {
      const desiredAlt = distRaw * Math.tan((3 * Math.PI) / 180);
      gsDevRaw = clampNumber((altRaw - desiredAlt) / 30, -1, 1);
      // hudState carries the RELATIVE bearing (already wrapped ±180);
      // reading a nonexistent absolute field here produced NaN dev.
      const relBearing = state.targetRelativeBearingDeg === null || state.targetRelativeBearingDeg === undefined
        ? 0 : state.targetRelativeBearingDeg;
      locDevRaw = clampNumber(relBearing / 10, -1, 1);
    }

    // Speed trend from the 5 s history.
    speedHistory.push({ t: state.timeSeconds, v: speedRaw });
    while (speedHistory.length && speedHistory[0].t < state.timeSeconds - FS_SPEED_HISTORY_S - 0.5) speedHistory.shift();
    let trendRaw = speedRaw;
    if (speedHistory.length > 1) {
      const oldest = speedHistory[0];
      const span = state.timeSeconds - oldest.t;
      if (span >= 1) trendRaw = Math.max(0, speedRaw + ((speedRaw - oldest.v) / span) * FS_SPEED_HISTORY_S);
    }

    // Combo: streak of ring/parcel events, 12 s decay, cap x3.0.
    const eventCount = mission ? (numOr(mission.ringsHit, 0) + numOr(mission.parcelsDelivered, 0)) : 0;
    if (eventCount > comboLastCount) {
      comboStreak += eventCount - comboLastCount;
      comboLastEventTime = state.timeSeconds;
    }
    comboLastCount = eventCount;
    if (state.timeSeconds - comboLastEventTime > FS_COMBO_WINDOW_S) comboStreak = 0;

    // Engine/fuel derived family (from smoothed throttle below).
    const throttleRaw = clampNumber((state.throttlePercent || 0) / 100, 0, 1);
    const rpmRaw = plane.engineOn === false ? 0 : 600 + throttleRaw * 2100;
    const oilRaw = clampNumber(
      20 + 62 * (1 - Math.exp(-elapsed / 180)) + (Math.max(0, rpmRaw - 600) / 2100) * 8,
      20, 98
    );
    const rollRad = (rollRaw * Math.PI) / 180;
    const gBase = 1 / Math.max(Math.cos(rollRad), 0.2);
    const gVs = dt > 0 ? ((vsRaw - prevVsFs) / dt / 9.81) * 0.5 : 0;
    const gRaw = clampNumber(gBase + gVs, 0, 4);
    prevVsFs = vsRaw;

    // Smooth continuous values (~100 ms lerp). hud-full.js smooths
    // speed/alt/heading/pitch/roll/vs/ra/aoa itself (sm.*), so those
    // pass through raw here; the adapter smooths only the fields
    // hud-full renders raw (gs, wind, throttle, rpm, fuel, oil, g,
    // fpm, GS/LOC dev, trend).
    fs.speedMs = speedRaw;
    fs.gsMs = lerpFs('gsMs', gsRaw, alpha);
    fs.altM = altRaw;
    fs.raM = fs.altM;
    fs.vsMs = vsRaw;
    fs.pitchDeg = pitchRaw;
    fs.rollDeg = rollRaw;
    fs.headingDeg = headingRaw;
    fs.windDirDeg = lerpAngleFs('windDirDeg', state.windDirectionDeg, alpha);
    // Gust swing mirrors main.js world wind (sin(time*0.7) * gustAmp).
    const gustAmp = sim && sim.wind ? numOr(sim.wind.gustAmp, 0) : 0;
    const windSpeedGusted = Math.max(0, (state.windSpeedMps || 0) + Math.sin(state.timeSeconds * 0.7) * gustAmp);
    fs.windKt = lerpFs('windKt', windSpeedGusted * MS_TO_KT, alpha);
    fs.throttle01 = lerpFs('throttle01', throttleRaw, alpha);
    fs.rpm = lerpFs('rpm', rpmRaw, alpha);
    fs.fuelPct = lerpFs('fuelPct', state.fuelPercent, alpha);
    fs.oilC = lerpFs('oilC', oilRaw, alpha);
    fs.gLoad = lerpFs('gLoad', gRaw, alpha);
    fs.fpm.xDeg = lerpFs('fpmX', fpmXRaw, alpha);
    fs.fpm.yDeg = lerpFs('fpmY', fpmYRaw, alpha);
    fs.glideslopeDev = lerpFs('glideslopeDev', gsDevRaw, alpha);
    fs.localizerDev = lerpFs('localizerDev', locDevRaw, alpha);
    fs.aoaDeg = aoaRaw; // hud-full smooths aoa itself (sm.aoa)
    fs.speedTrendMs = lerpFs('speedTrendMs', trendRaw, alpha);

    // Discrete / immediate values.
    fs.timeSeconds = state.timeSeconds;
    fs.score = state.score;
    fs.scorePulse = prevScoreFs !== null && state.score > prevScoreFs;
    prevScoreFs = state.score;
    fs.combo = Math.min(3, 1 + 0.5 * comboStreak);
    fs.ap = false; fs.at = false; fs.fd = true; // explicit contract: no AP/A/T in sim, FD on
    fs.windRelDeg = wrapDegrees180(fs.windDirDeg - fs.headingDeg);
    fs.oatC = Math.round(18 - altMsl * 0.0065);
    fs.qnh = 1013;
    fs.mach = fs.gsMs / 343;
    fs.yawDeg = fs.fpm.xDeg; // slip/drift angle (velocity track − heading)
    fs.distM = distRaw;
    fs.etaSec = distRaw / Math.max(fs.gsMs, 1);
    fs.rwyLabel = targetStrip ? runwayLabelForHeading(targetStrip.headingDeg) : '';

    if (onGround && gsRaw < 2) fs.mode = mission && mission.complete ? 'LANDED' : 'TAXI';
    else if (onGround) fs.mode = 'TAKEOFF';
    else if (vsRaw > 1) fs.mode = 'CLIMB';
    else if (vsRaw < -1 || (targetIsStrip && distRaw < 3000)) fs.mode = 'APPROACH';
    else fs.mode = 'CRUISE';

    fs.onPath = !targetIsStrip ? 'none'
      : (Math.abs(fs.glideslopeDev) < 0.35 && Math.abs(fs.localizerDev) < 0.35 && speedRaw >= 22 && speedRaw <= 26 ? 'good' : 'off');

    // Mission card: objective split on ' — ' (head = title, tail = sub).
    const objective = state.objectiveLine || (mission && mission.objective) || '';
    let title = '';
    let sub = '';
    if (objective) {
      const parts = String(objective).split(' — ');
      title = parts[0];
      sub = parts.slice(1).join(' — ');
    }
    if (!title) title = (mission && mission.title) || 'FREE FLIGHT';
    if (!sub) sub = state.progressLine || '';
    fs.missionTitle = String(title).toUpperCase();
    fs.missionSub = String(sub || '');
    buildFsGoals(mission, plane, state, elapsed);

    // Minimap (hud-full rotates the map; plane fixed at centre).
    fs.minimap.planeX = state.planeX;
    fs.minimap.planeZ = state.planeZ;
    fs.minimap.headingDeg = fs.headingDeg;
    fs.minimap.targetX = state.targetX;
    fs.minimap.targetZ = state.targetZ;
    fs.minimap.hasTarget = !!state.hasTargetPosition;

    // System chips (honest: fixed gear, dawn lights, flaps double as spoilers).
    const flapStage = clampNumber(Math.round(numOr(state.flapStage, 0)), 0, 2);
    fs.flapsDeg = flapStage * 15;
    fs.gear = plane.gearDown === false ? 'UP' : 'DOWN';
    if (typeof controls.brake === 'boolean') fs.brakes = controls.brake ? 'ON' : 'OFF';
    else fs.brakes = onGround && throttleRaw < 0.05 && gsRaw < prevGsFs - 0.01 ? 'ON' : 'OFF';
    fs.lights = plane.engineOn === false ? 'OFF' : 'ON'; // no light switch in sim; dawn ops = lights with engine
    fs.spoilers = flapStage > 0 ? 'ARMED' : 'OFF';
    prevGsFs = gsRaw;

    // Destination bar (initial distance tracked per target).
    fs.destLabel = (state.targetLabel || '').toUpperCase();
    fs.destDistM = distRaw;
    const destKey = state.hasTargetPosition
      ? fs.destLabel + '@' + Math.round(state.targetX) + ',' + Math.round(state.targetZ)
      : '';
    if (destKey !== destInitialKey) {
      destInitialKey = destKey;
      destInitialDist = distRaw;
    }
    fs.destProgress01 = destInitialDist > 1
      ? clampNumber(1 - distRaw / destInitialDist, 0, 1)
      : (state.hasTargetPosition && distRaw <= 1 ? 1 : 0);

    // Fuel family from smoothed values (160 L tank).
    fs.fuelLitres = fs.fuelPct * 1.6;
    fs.fuelFlowLh = 4 + fs.throttle01 * 52;
    fs.fuelTimeH = fs.fuelLitres / Math.max(fs.fuelFlowLh, 1);
    fs.trim = Math.round(clampNumber(-pitchRaw / 8, -2, 2) * 10) / 10;

    // Caution: highest-severity active warning (red before amber).
    let topWarning = null;
    for (const warning of state.warnings) {
      if (!topWarning) topWarning = warning;
      if (warning.red) { topWarning = warning; break; }
    }
    if (topWarning) {
      fsCaution.level = topWarning.red ? 'red' : 'amber';
      fsCaution.label = topWarning.text;
      fs.caution = fsCaution;
    } else {
      fs.caution = null;
    }
    fs.systemsOk = state.warnings.length === 0;

    return fs;
  }

  function applyFullHudMode(hide) {
    const want = hide ? 'OFF' : hudDisplayMode;
    setClassFlag(stage, 'stage', 'hud-mode-full', want === 'FULL');
    setClassFlag(stage, 'stage', 'hud-mode-minimal', want === 'MINIMAL');
    setClassFlag(stage, 'stage', 'hud-mode-off', want === 'OFF');
    if (!fullHud || typeof fullHud.setMode !== 'function') return;
    if (want === lastAppliedHudMode) return;
    lastAppliedHudMode = want;
    try { fullHud.setMode(want); } catch (error) { /* view dressing only */ }
  }

  // H key: in flight, H cycles FULL -> MINIMAL -> OFF and must NOT
  // open input.js's help overlay. Capture phase on window fires
  // before input.js's bubble-phase listener; stopPropagation keeps
  // the key from ever reaching it. In menus/pause this handler does
  // nothing, so the existing help flow (hud.js VD6-14 + input.js
  // overlay) is untouched.
  function onHudModeKeyDown(event) {
    if (event.code !== 'KeyH') return;
    const target = event.target;
    if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    const inFlight = lastSimPhase === 'flying' && currentScreenName === null && !lastHideFlightHud;
    if (!inFlight) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    hudDisplayMode = hudDisplayMode === 'FULL' ? 'MINIMAL' : (hudDisplayMode === 'MINIMAL' ? 'OFF' : 'FULL');
    applyFullHudMode(false);
    toast('HUD ' + hudDisplayMode, 1400);
  }
  window.addEventListener('keydown', onHudModeKeyDown, true);

  // ---------- HUD update (throttled by value-change cache) ----------

  function update(sim) {
    const state = extractHudState(sim);
    lastSimPhase = state.phase;

    const screenPhases = ['menu', 'briefing', 'debrief', 'crashed'];
    const hideFlightHud = !state.forceHud && (currentScreenName !== null || screenPhases.includes(state.phase));
    lastHideFlightHud = hideFlightHud;
    setClassFlag(stage, 'stage', 'hud-flight-hidden', hideFlightHud);
    setClassFlag(stage, 'stage', 'hud-minimal', state.hudMinimal);
    setClassFlag(stage, 'stage', 'hud-cockpit', state.cameraMode === 'cockpit');
    setClassFlag(stage, 'stage', 'hud-shot-cockpit', state.forceHud && state.cameraMode === 'cockpit');
    // FULL HUD (hud-full.js): visible in every camera mode while
    // flying; OFF whenever a screen or menu phase hides the flight
    // HUD (same rule the old panels followed). sim.hudMinimal no
    // longer drives the mode — H owns FULL/MINIMAL/OFF in flight.
    applyFullHudMode(hideFlightHud);
    if (!hideFlightHud && fullHud) {
      try {
        fullHud.update(buildFlightState(sim, state));
      } catch (error) { /* view dressing only; game keeps flying */ }
    }

    // View label: live play fades it fully out after 2 s (no 0.35
    // ghost), and in shot mode (forceHud) it never appears at all —
    // a pinned label would sit in every judged frame.
    const viewNames = { chase: 'CHASE', cockpit: 'COCKPIT', tower: 'TOWER' };
    const viewText = viewNames[state.cameraMode] || state.cameraMode.toUpperCase();
    setStyle(viewLabel, 'view', 'display', state.forceHud ? 'none' : '');
    if (viewText !== lastViewLabel) {
      lastViewLabel = viewText;
      setText(viewLabel, 'view', viewText);
      viewLabel.classList.remove('faded');
      if (viewLabelTimerId) clearTimeout(viewLabelTimerId);
      viewLabelTimerId = state.forceHud
        ? null
        : setTimeout(() => viewLabel.classList.add('faded'), 2000);
    } else if (state.forceHud) {
      viewLabel.classList.add('faded');
      if (viewLabelTimerId) {
        clearTimeout(viewLabelTimerId);
        viewLabelTimerId = null;
      }
    }

    syncWarnings(state.warnings);
    if (instruments) {
      try {
        instruments.update(state, (sim && sim.plane) || null);
      } catch (error) { /* instruments are optional */ }
    }
    if (lensFlare) {
      try {
        if (hideFlightHud) lensFlare.hide();
        else lensFlare.update();
      } catch (error) { /* optical dressing only */ }
    }
  }

  // ---------- screens ----------

  const screens = new Map();

  function makeScreen(screenName) {
    const screen = makeNode('div', 'screen');
    screen.id = 'screen-' + screenName;
    stage.appendChild(screen);
    screens.set(screenName, screen);
    return screen;
  }

  function makeStatRow(label, value, isTotal) {
    const row = makeNode('div', 'stat-row' + (isTotal ? ' stat-row-total' : ''));
    row.append(makeNode('div', 'stat-row-label', label), makeNode('div', 'stat-row-value', value));
    return row;
  }

  function focusFirstButton(screen) {
    const firstButton = screen.querySelector('button:not(:disabled)');
    if (firstButton) firstButton.focus();
  }

  // Title emblem — original vector badge (dawn sun rising out of
  // the sea behind the mail plane), inline SVG so nothing is fetched.
  function createTitleEmblem() {
    const holder = makeNode('div', 'title-emblem');
    holder.setAttribute('aria-hidden', 'true');
    const defs = '<defs>'
      + '<radialGradient id="ae-sun" cx="50%" cy="55%" r="55%">'
      + '<stop offset="0" stop-color="#FFF0C2"/><stop offset="0.5" stop-color="#FFB35C"/>'
      + '<stop offset="1" stop-color="#D64541"/></radialGradient>'
      + '<linearGradient id="ae-sky" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#2B3A67"/><stop offset="0.62" stop-color="#7A5C8F"/>'
      + '<stop offset="1" stop-color="#FF9E64"/></linearGradient>'
      + '<clipPath id="ae-clip"><circle cx="66" cy="66" r="55"/></clipPath>'
      + '</defs>';
    const frame = '<circle cx="66" cy="66" r="62" fill="#0A0E18" stroke="#FFD166" stroke-width="2.5"/>'
      + '<circle cx="66" cy="66" r="57.5" fill="none" stroke="rgba(255,217,160,0.35)" stroke-width="1"/>';
    const rays = '<g stroke="rgba(255,209,102,0.33)" stroke-width="2" stroke-linecap="round">'
      + '<path d="M66 86 L66 34"/><path d="M66 86 L36 42"/><path d="M66 86 L96 42"/>'
      + '<path d="M66 86 L18 62"/><path d="M66 86 L114 62"/></g>';
    const scene = '<g clip-path="url(#ae-clip)">'
      + '<rect width="132" height="132" fill="url(#ae-sky)"/>' + rays
      + '<circle cx="66" cy="88" r="26" fill="url(#ae-sun)"/>'
      + '<path d="M0 86 Q22 76 44 86 Z" fill="#2F5D2A"/>'
      + '<path d="M92 86 Q112 72 132 86 Z" fill="#3E6B32"/>'
      + '<rect y="86" width="132" height="46" fill="#123C5A"/>'
      + '<path d="M44 93 H88 M50 100 H82 M57 107 H75" stroke="#FF9E64" stroke-width="2.6" stroke-linecap="round" opacity="0.85"/>'
      + '</g>';
    const plane = '<g transform="translate(66 52) rotate(7)">'
      + '<rect x="-16" y="-11" width="30" height="3.4" rx="1.7" fill="#F2EDE4"/>'
      + '<path d="M-7 -8 L-3 3 M4 -8 L1 3" stroke="#F2EDE4" stroke-width="1.4"/>'
      + '<path d="M-30 3 C-30 -3 -25 -6 -17 -6 L17 -4 L33 -12 L37 -12 L34 2 L-16 6 C-24 7 -30 7 -30 3 Z" fill="#F2EDE4"/>'
      + '<path d="M-26 1.5 L31 -2" stroke="#D64541" stroke-width="1.8"/>'
      + '<path d="M-21 -4.5 L-12 -4.8 L-12 -1 L-21 -0.6 Z" fill="#1A2634"/>'
      + '<rect x="-33.5" y="-7" width="2.2" height="17" rx="1.1" fill="#FFD166" opacity="0.9"/>'
      + '<circle cx="-14" cy="10" r="3.2" fill="#22242A" stroke="#F2EDE4" stroke-width="1"/>'
      + '<circle cx="2" cy="9" r="3.2" fill="#22242A" stroke="#F2EDE4" stroke-width="1"/>'
      + '</g>';
    const caption = '<text x="66" y="115" text-anchor="middle"'
      + ' font-family="AuroraSans, Segoe UI, system-ui, Arial, sans-serif" font-size="8.5"'
      + ' font-weight="800" letter-spacing="2.4" fill="#FFD9A0">DAWN MAIL</text>';
    holder.innerHTML = '<svg viewBox="0 0 132 132" width="132" height="132" xmlns="http://www.w3.org/2000/svg">'
      + defs + frame + scene + plane + caption + '</svg>';
    return holder;
  }

  // Menu screens. Every screen keeps its action names, keyboard
  // shortcuts and data payloads (main.js is untouched); what the
  // layout and art do: icon buttons with keycaps, a pilot's
  // logbook, a two-pane mission select with a live route chart,
  // chart-led briefings, medal debriefs and a keycap help sheet.

  function chipNode(text, icon, extraClass) {
    const chip = makeNode('span', 'ui-chip' + (extraClass ? ' ' + extraClass : ''));
    if (icon) {
      const glyph = makeNode('span', 'ui-chip-icon');
      glyph.innerHTML = menuArtModule.iconSvg(icon, 14);
      chip.appendChild(glyph);
    }
    chip.appendChild(makeNode('span', 'ui-chip-text', text));
    return chip;
  }

  function tileNode(label, icon) {
    const tile = makeNode('div', 'ui-tile');
    const head = makeNode('div', 'ui-tile-head');
    if (icon) {
      const glyph = makeNode('span', 'ui-tile-icon');
      glyph.innerHTML = menuArtModule.iconSvg(icon, 14);
      head.appendChild(glyph);
    }
    head.appendChild(makeNode('span', 'ui-tile-label', label));
    tile.appendChild(head);
    const value = makeNode('div', 'ui-tile-value', '—');
    tile.appendChild(value);
    tile.valueElement = value;
    return tile;
  }

  function tierPips(tier) {
    const pips = makeNode('span', 'tier-pips');
    const lit = tier || 1;
    for (let k = 1; k <= 3; k++) {
      pips.appendChild(makeNode('span', 'tier-pip' + (k <= lit ? ' on' : '')));
    }
    return pips;
  }

  function medalKey(medal) {
    const key = String(medal || '').toLowerCase();
    if (key === 'gold' || key === 'silver' || key === 'bronze') return key;
    return 'none';
  }

  function campaignOf(data) {
    return (data && data.campaign) || {};
  }

  function nextSortieDefinition(campaign) {
    const done = Array.isArray(campaign.completed) ? campaign.completed : [];
    const list = Array.isArray(MENU_MISSIONS) ? MENU_MISSIONS : [];
    const next = list.find((definition) => !done.includes(definition.id));
    if (next) return next;
    return list[list.length - 1] || null;
  }

  // Shared screen chrome — a slim top bar with the wordmark, a
  // breadcrumb trail and the dawn clock, on every menu screen but
  // the title (which is the wordmark). Decorative; no actions
  // live here.
  function addScreenChrome(screen, crumbs) {
    const bar = makeNode('div', 'screen-topbar');
    const brand = makeNode('div', 'topbar-brand');
    const mark = makeNode('span', 'topbar-mark');
    mark.innerHTML = menuArtModule.iconSvg('plane', 16);
    brand.append(mark, makeNode('span', 'topbar-word', 'AURORA POST'));
    bar.appendChild(brand);
    const trail = makeNode('div', 'topbar-crumbs');
    crumbs.forEach((crumb, index) => {
      if (index > 0) trail.appendChild(makeNode('span', 'topbar-sep', '›'));
      const isCurrent = index === crumbs.length - 1;
      trail.appendChild(makeNode('span', 'topbar-crumb' + (isCurrent ? ' current' : ''), crumb));
    });
    bar.appendChild(trail);
    const status = makeNode('div', 'topbar-status');
    status.append(chipNode('DAWN 06:12', 'clock'), chipNode('AURORA ARCHIPELAGO', 'map'));
    bar.appendChild(status);
    screen.classList.add('has-chrome');
    screen.appendChild(bar);
    return bar;
  }

  // Score lines that repeat per ring / parcel are merged for
  // display ("Ring 3" ×10 -> "Rings threaded ×10"); the points are
  // summed, so the total is unchanged. Unique lines pass through
  // as they are.
  function mergeBreakdown(lines) {
    const families = [
      [/^ring\s*\d+/i, 'Rings threaded'],
      [/^parcel delivered/i, 'Parcels delivered'],
      [/^parcel near miss/i, 'Near misses'],
    ];
    const byKey = new Map();
    const groups = [];
    for (const line of lines || []) {
      if (!line || typeof line !== 'object' || line.label === undefined) continue;
      const rawLabel = String(line.label);
      let label = rawLabel;
      for (const [pattern, name] of families) {
        if (pattern.test(rawLabel)) { label = name; break; }
      }
      const value = typeof line.value === 'number' ? line.value : 0;
      const existing = byKey.get(label);
      if (existing) {
        existing.value += value;
        existing.count += 1;
      } else {
        const group = { label, value, count: 1, hasValue: typeof line.value === 'number' };
        byKey.set(label, group);
        groups.push(group);
      }
    }
    return groups.map((group) => ({
      label: group.count > 1 ? group.label + ' ×' + group.count : group.label,
      value: group.hasValue ? group.value : undefined,
    }));
  }

  // ---------------------------------------------------------- title

  const titleScreen = makeScreen('title');
  titleScreen.classList.add('screen-v6');
  const titleLeft = makeNode('div', 'title-left');
  const emblemStage = makeNode('div', 'title-emblem-stage');
  emblemStage.append(makeNode('div', 'title-rays'), createTitleEmblem());
  titleLeft.append(emblemStage, makeNode('div', 'title-kicker', 'AN ARCHIPELAGO AIRMAIL ADVENTURE'));
  // Concept neon logo (SVG): AURORA cyan outline glow, POST gold,
  // wing speed-lines flanking POST. The h1 stays for semantics/AT,
  // visually replaced by the neon mark (concept-ui.css .title-logo-sr).
  const neonLogo = makeNode('div', 'title-neon-logo');
  neonLogo.setAttribute('aria-hidden', 'true');
  neonLogo.innerHTML = neonLogoSvg();
  titleLeft.append(neonLogo, makeNode('h1', 'screen-title-display title-logo-sr', 'AURORA POST'), makeNode('div', 'title-rule'), makeNode('p', 'screen-subtitle', 'Dawn mail runs over the archipelago'));
  const titleMenu = makeNode('div', 'title-menu');
  const titleFlyButton = makeButton('FLY', 'fly', {}, 'btn-primary btn-menu',
    { icon: 'takeoff', sub: 'Continue the Morning Round', key: 'ENTER' });
  const titleHelpButton = makeButton('HOW TO FLY', 'help', {}, 'btn-menu',
    { icon: 'help', sub: 'Controls and a 30-second first flight', key: 'H' });
  const titleSoundButton = makeButton('SOUND: ON', 'sound', {}, 'btn-menu',
    { icon: 'soundOn', sub: 'Engine, wind and radio chatter', key: 'M' });
  titleMenu.append(titleFlyButton, titleHelpButton, titleSoundButton);
  // Concept corner brackets on every title button (glass + ticks in CSS).
  for (const btn of [titleFlyButton, titleHelpButton, titleSoundButton]) {
    btn.classList.add('btn-cornered');
    for (const corner of ['tl', 'tr', 'bl', 'br']) {
      btn.appendChild(makeNode('span', 'btn-corner btn-corner-' + corner));
    }
    btn.appendChild(makeNode('span', 'btn-ticks'));
  }
  titleLeft.appendChild(titleMenu);
  titleScreen.appendChild(titleLeft);

  // Pilot's logbook: campaign progress at a glance.
  const logbook = makeNode('div', 'logbook-card');
  const logbookHead = makeNode('div', 'card-head');
  const logbookIcon = makeNode('span', 'card-head-icon');
  logbookIcon.innerHTML = menuArtModule.iconSvg('map', 16);
  logbookHead.append(logbookIcon, makeNode('span', 'card-head-text', "PILOT'S LOGBOOK"));
  logbook.appendChild(logbookHead);
  logbook.classList.add('logbook-concept');
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    logbook.appendChild(makeNode('span', 'btn-corner btn-corner-' + corner));
  }
  // Concept dual progress rings (sorties % / medals %) + score ring.
  const logbookRings = makeNode('div', 'logbook-rings');
  logbook.appendChild(logbookRings);
  const logbookRing = makeNode('div', 'progress-ring');
  logbook.appendChild(logbookRing);
  // Concept telemetry block: max score / medals earned / score ceiling.
  const logbookTelemetry = makeNode('div', 'logbook-telemetry');
  logbookTelemetry.appendChild(makeNode('div', 'logbook-telemetry-head', 'TELEMETRY'));
  const telemetryRows = {};
  for (const [key, label] of [['maxScore', 'MAX SCORE'], ['medals', 'MEDALS EARNED'], ['ceiling', 'SCORE CEILING']]) {
    const row = makeNode('div', 'telemetry-row');
    row.appendChild(makeNode('span', 'telemetry-label', label));
    const value = makeNode('span', 'telemetry-value', '—');
    row.appendChild(value);
    const bar = makeNode('span', 'telemetry-bar');
    const fill = makeNode('span', 'telemetry-fill');
    bar.appendChild(fill);
    row.appendChild(bar);
    logbookTelemetry.appendChild(row);
    telemetryRows[key] = { value, fill };
  }
  logbook.appendChild(logbookTelemetry);
  const logbookTiles = makeNode('div', 'ui-tile-grid');
  const logScoreTile = tileNode('TOTAL SCORE', 'trophy');
  const logSortieTile = tileNode('SORTIES', 'check');
  logbookTiles.append(logScoreTile, logSortieTile);
  logbook.appendChild(logbookTiles);
  const logbookMedals = makeNode('div', 'logbook-medals');
  logbook.appendChild(logbookMedals);
  const logbookNext = makeNode('div', 'logbook-next');
  logbook.appendChild(logbookNext);
  const titleProgressLine = makeNode('div', 'screen-progress-line');
  logbook.appendChild(titleProgressLine);
  titleScreen.appendChild(logbook);

  const titleFooter = makeNode('div', 'title-footer');
  titleFooter.append(chipNode('PLAYS OFFLINE', 'check'), chipNode('KEYBOARD + MOUSE', 'plane'), chipNode('12 SORTIES · 3 TIERS', 'map'), makeNode('span', 'title-footer-spacer'), makeNode('span', 'title-footer-hint', 'ENTER  FLY   ·   H  HELP   ·   M  SOUND'));
  titleScreen.appendChild(titleFooter);

  // Concept neon logo: AURORA in cyan outline glow, POST in gold,
  // wing speed-lines flanking POST, tick ruler + corner ticks.
  function neonLogoSvg() {
    const wing = (x, flip) => {
      const lines = [[0, 0, 74], [8, 11, 58], [16, 22, 42]];
      return '<g transform="translate(' + x + ' 96)' + (flip ? ' scale(-1 1)' : '') + '" stroke="#4DE8FF" stroke-width="3.4" stroke-linecap="round" fill="none">'
        + lines.map(([dx, dy, len]) => '<path d="M' + dx + ' ' + dy + ' H' + (dx + len) + '"/>').join('')
        + '</g>';
    };
    let ticks = '';
    for (let k = 0; k <= 20; k++) {
      const x = 30 + k * 25;
      ticks += '<path d="M' + x + ' 140 V' + (k % 5 === 0 ? 150 : 146) + '"/>';
    }
    return '<svg viewBox="0 0 560 156" width="560" height="156" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AURORA POST">'
      + '<defs>'
      + '<filter id="neon-cyan" x="-30%" y="-30%" width="160%" height="160%">'
      + '<feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
      + '<filter id="neon-gold" x="-30%" y="-30%" width="160%" height="160%">'
      + '<feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
      + '<linearGradient id="logo-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE9A8"/>'
      + '<stop offset="0.55" stop-color="#FFD166"/><stop offset="1" stop-color="#FF9E64"/></linearGradient>'
      + '</defs>'
      + '<g stroke="rgba(77,232,255,0.55)" stroke-width="2" fill="none">'
      + '<path d="M6 22 V6 H22"/><path d="M538 6 H554 V22"/><path d="M6 134 V150 H22"/><path d="M538 150 H554 V134"/></g>'
      + '<text x="280" y="64" text-anchor="middle" font-family="AuroraSans, Segoe UI, system-ui, Arial, sans-serif"'
      + ' font-size="66" font-weight="900" letter-spacing="7" fill="rgba(77,232,255,0.10)" stroke="#4DE8FF" stroke-width="2.2" filter="url(#neon-cyan)">AURORA</text>'
      + wing(18, false) + wing(542, true)
      + '<text x="280" y="128" text-anchor="middle" font-family="AuroraSans, Segoe UI, system-ui, Arial, sans-serif"'
      + ' font-size="54" font-weight="900" letter-spacing="16" fill="url(#logo-gold)" stroke="#FFD166" stroke-width="1.4" filter="url(#neon-gold)">POST</text>'
      + '<g transform="translate(492 18) rotate(18) scale(0.9)" fill="#FFD166">'
      + '<path d="M2.5 13.5 L9.5 12 L14 4.5 L16.2 4.5 L14.4 11.4 L19.8 10.6 L21.6 8.2 L22.6 8.4 L21.8 12.6 L22.6 16.8 L21.6 17 L19.8 14.6 L14.4 13.8 L16.2 20.6 L14 20.6 L9.5 13.2 Z"/></g>'
      + '<g stroke="rgba(255,217,160,0.5)" stroke-width="1.6">' + ticks + '</g>'
      + '<path d="M280 132 l6 6 -6 6 -6 -6 Z" fill="#FFD166"/>'
      + '</svg>';
  }

  // Small concept progress ring: tick subdivisions, arc, % centre.
  function miniRingSvg(fraction, percentText, hue, gradId) {
    const radius = 38;
    const circumference = 2 * Math.PI * radius;
    const frac = Math.max(0, Math.min(1, fraction || 0));
    let ticks = '';
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const r1 = 44;
      const r2 = k % 6 === 0 ? 49 : 47;
      ticks += '<path d="M' + (48 + Math.cos(a) * r1).toFixed(1) + ' ' + (48 + Math.sin(a) * r1).toFixed(1)
        + ' L' + (48 + Math.cos(a) * r2).toFixed(1) + ' ' + (48 + Math.sin(a) * r2).toFixed(1) + '"/>';
    }
    return '<svg viewBox="0 0 96 96" width="96" height="96" aria-hidden="true">'
      + '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0" stop-color="' + hue[0] + '"/><stop offset="1" stop-color="' + hue[1] + '"/></linearGradient></defs>'
      + '<g stroke="rgba(255,255,255,0.28)" stroke-width="1.2">' + ticks + '</g>'
      + '<circle cx="48" cy="48" r="' + radius + '" fill="rgba(6,14,26,0.55)" stroke="rgba(255,255,255,0.14)" stroke-width="7"/>'
      + '<circle cx="48" cy="48" r="' + radius + '" fill="none" stroke="url(#' + gradId + ')" stroke-width="7" stroke-linecap="round"'
      + ' stroke-dasharray="' + (circumference * frac).toFixed(1) + ' ' + circumference.toFixed(1) + '" transform="rotate(-90 48 48)"/>'
      + '<text x="48" y="53" text-anchor="middle" font-size="19" font-weight="800" fill="#FFFFFF" font-family="AuroraSans, Segoe UI, system-ui, Arial">' + percentText + '</text>'
      + '</svg>';
  }

  function progressRingSvg(done, total) {
    const radius = 46;
    const circumference = 2 * Math.PI * radius;
    const fraction = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
    const dash = (circumference * fraction).toFixed(1) + ' ' + circumference.toFixed(1);
    const track = '<circle cx="60" cy="60" r="' + radius + '" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="9"/>';
    const arc = '<circle cx="60" cy="60" r="' + radius + '" fill="none" stroke="url(#ring-grad)" stroke-width="9" stroke-linecap="round"'
      + ' stroke-dasharray="' + dash + '" transform="rotate(-90 60 60)"/>';
    const gradient = '<defs><linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFD166"/>'
      + '<stop offset="1" stop-color="#FF9E64"/></linearGradient></defs>';
    const labels = '<text x="60" y="58" text-anchor="middle" font-size="30" font-weight="800" fill="#FFFFFF" font-family="AuroraSans, Segoe UI, system-ui, Arial">' + done + '</text>'
      + '<text x="60" y="80" text-anchor="middle" font-size="11" font-weight="700" letter-spacing="1.6" fill="#FFD9A0" font-family="AuroraSans, Segoe UI, system-ui, Arial">OF ' + total + ' FLOWN</text>';
    return '<svg viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">'
      + track + arc + gradient + labels + '</svg>';
  }

  function renderTitleScreen(data) {
    const campaign = campaignOf(data);
    const completedCount = firstDefined(data && data.completedCount,
      Array.isArray(campaign.completed) ? campaign.completed.length : null, 0);
    const totalSorties = firstDefined(data && data.totalSorties, campaign.totalSorties, 12);
    const totalScore = firstDefined(data && data.totalScore, campaign.totalScore, 0);
    titleProgressLine.textContent = 'Sorties ' + completedCount + '/' + totalSorties + ' · Total score ' + formatScore(totalScore);
    const soundOn = data && data.soundOn !== undefined ? data.soundOn : true;
    setButtonLabel(titleSoundButton, soundOn ? 'SOUND: ON' : 'SOUND: OFF');
    if (titleSoundButton.iconElement) {
      titleSoundButton.iconElement.innerHTML = menuArtModule.iconSvg(soundOn ? 'soundOn' : 'soundOff', 20);
    }
    setButtonLabel(titleFlyButton, completedCount > 0 ? 'CONTINUE' : 'FLY');
    logbookRing.innerHTML = progressRingSvg(completedCount, totalSorties);
    logScoreTile.valueElement.textContent = formatScore(totalScore);
    logSortieTile.valueElement.textContent = completedCount + ' / ' + totalSorties;
    const medals = Object.values(campaign.medals || {}).map(medalKey);
    // Concept rings + telemetry — real campaign data only. titleData()
    // passes no campaignStats, so telemetry derives from bestScores /
    // medals / totalScore (all on the campaign object it does pass).
    const medalsEarned = medals.filter((m) => m !== 'none').length;
    const bestScores = Object.values(campaign.bestScores || {}).filter((v) => typeof v === 'number');
    const maxScore = bestScores.length ? Math.max.apply(null, bestScores) : 0;
    const scoreCeiling = (Array.isArray(MENU_MISSIONS) ? MENU_MISSIONS : [])
      .reduce((sum, def) => sum + (typeof def.maxScore === 'number' ? def.maxScore : 0), 0);
    const sortiesFrac = totalSorties > 0 ? completedCount / totalSorties : 0;
    const medalsFrac = totalSorties > 0 ? medalsEarned / totalSorties : 0;
    const scoreFrac = scoreCeiling > 0 ? totalScore / scoreCeiling : 0;
    const pct = (f) => Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
    logbookRings.replaceChildren();
    const ringSpecs = [
      ['SORTIES', sortiesFrac, ['#FFD166', '#FF9E64'], 'ring-sorties'],
      ['MEDALS', medalsFrac, ['#4DE8FF', '#2B8FE8'], 'ring-medals'],
      ['SCORE', scoreFrac, ['#7DFFB2', '#2FBF71'], 'ring-score'],
    ];
    for (const [label, frac, hue, gid] of ringSpecs) {
      const cell = makeNode('div', 'logbook-ring-cell');
      const art = makeNode('div', 'logbook-ring-art');
      art.innerHTML = miniRingSvg(frac, pct(frac), hue, gid);
      cell.append(art, makeNode('div', 'logbook-ring-label', label));
      logbookRings.appendChild(cell);
    }
    telemetryRows.maxScore.value.textContent = formatScore(maxScore);
    telemetryRows.maxScore.fill.style.width = pct(scoreCeiling > 0 ? maxScore / (scoreCeiling / Math.max(1, totalSorties)) : 0);
    telemetryRows.medals.value.textContent = medalsEarned + ' / ' + totalSorties;
    telemetryRows.medals.fill.style.width = pct(medalsFrac);
    telemetryRows.ceiling.value.textContent = formatScore(totalScore) + ' / ' + formatScore(scoreCeiling);
    telemetryRows.ceiling.fill.style.width = pct(scoreFrac);
    logbookMedals.replaceChildren();
    for (const tier of ['gold', 'silver', 'bronze']) {
      const slot = makeNode('div', 'logbook-medal');
      const art = makeNode('div', 'logbook-medal-art');
      art.innerHTML = menuArtModule.medalSvg(medals.includes(tier) ? tier : 'none', 40);
      slot.append(art, makeNode('div', 'logbook-medal-count', String(medals.filter((m) => m === tier).length)), makeNode('div', 'logbook-medal-name', tier.toUpperCase()));
      logbookMedals.appendChild(slot);
    }
    const next = nextSortieDefinition(campaign);
    logbookNext.replaceChildren();
    if (next) {
      const typeInfo = menuArtModule.MISSION_TYPES[next.type] || menuArtModule.MISSION_TYPES['free-flight'];
      const nextLabel = completedCount >= totalSorties ? 'ROUND COMPLETE · FLY IT AGAIN' : 'NEXT SORTIE';
      logbookNext.appendChild(makeNode('div', 'logbook-next-label', nextLabel));
      const line = makeNode('div', 'logbook-next-line');
      line.append(chipNode(typeInfo.label, typeInfo.icon, 'chip-type'), makeNode('span', 'logbook-next-title', next.title));
      logbookNext.appendChild(line);
    }
  }

  // ---------------------------------------------------------- missions

  // Card goals are written at card length (two lines, no mid-word
  // ellipsis); the full briefing text stays on the briefing screen
  // and in the card tooltip. Display text only — mission
  // definitions and logic are untouched.
  const cardGoals = {
    'first-light': 'One calm circuit. Grease it on the centreline.',
    'thread-the-dawn': 'Thread the rings in order, then land.',
    'parcels-for-brine-cay': 'Three parcels, three drop zones. Then land.',
    'mail-for-gull-rock': 'Mail to Gull Rock, unload, fly home.',
    'grease-it-on': 'Crosswind approach. Crab in, stay on speed.',
    'the-lantern-loop': 'Ten rings in a fresh breeze.',
    'far-shore-post': 'Four parcels in a crosswind. Release early.',
    'the-long-way-home': 'Mail to Lantern Isle and back. Mind fuel.',
    'short-strip-long-day': 'Land on the short Twin Strip. Full flap.',
    'squall-line': 'Twelve tight rings, short fuel load.',
    'widows-reef-run': 'Five parcels, five small zones, gusty air.',
    'aurora-round': 'Mail to Twin Strip and home. The finale.',
  };

  function cardGoalText(mission) {
    const shortGoal = mission.id ? cardGoals[mission.id] : undefined;
    if (shortGoal) return shortGoal;
    const fullText = String(mission.goal || mission.briefing || '');
    if (fullText.length <= 64) return fullText;
    const head = fullText.slice(0, 64);
    const lastSpace = head.lastIndexOf(' ');
    return (lastSpace > 24 ? head.slice(0, lastSpace) : head) + '…';
  }

  const missionsScreen = makeScreen('missions');
  missionsScreen.classList.add('screen-v6');
  missionsScreen.classList.add('concept-missions');
  addScreenChrome(missionsScreen, ['MAIN MENU', 'MISSION SELECTION']);
  const missionsHeader = makeNode('div', 'missions-header');
  const missionsHeading = makeNode('div', 'missions-heading');
  missionsHeading.append(makeNode('h1', 'screen-heading', 'MISSION SELECTION'), makeNode('div', 'missions-subheading', 'THE MORNING ROUND · Choose a sortie · each tier unlocks the next'));
  missionsHeader.appendChild(missionsHeading);
  const missionsProgress = makeNode('div', 'missions-progress');
  const missionsProgressFill = makeNode('div', 'missions-progress-fill');
  missionsProgress.appendChild(missionsProgressFill);
  const missionsProgressText = makeNode('div', 'missions-progress-text');
  const missionsProgressBox = makeNode('div', 'missions-progress-box');
  missionsProgressBox.append(missionsProgressText, missionsProgress);
  missionsHeader.appendChild(missionsProgressBox);
  const missionsActions = makeNode('div', 'missions-actions');
  missionsHeader.appendChild(missionsActions);
  missionsScreen.appendChild(missionsHeader);

  const missionsBody = makeNode('div', 'missions-body');
  // Concept layout: stage-card rail (left) · 3D-map radar (centre) ·
  // sortie detail card (right). Same actions/data as before.
  const missionsRail = makeNode('div', 'missions-rail');
  const railChevronUp = makeNode('button', 'missions-scroll-btn missions-scroll-up');
  railChevronUp.type = 'button';
  railChevronUp.setAttribute('aria-label', 'Scroll sorties up');
  railChevronUp.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 14.5L12 7.5l7 7"/></svg>';
  missionsRail.appendChild(railChevronUp);
  const missionList = makeNode('div', 'mission-list');
  missionsRail.appendChild(missionList);
  const railChevronDown = makeNode('button', 'missions-scroll-btn missions-scroll-down');
  railChevronDown.type = 'button';
  railChevronDown.setAttribute('aria-label', 'Scroll sorties down');
  railChevronDown.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9.5L12 16.5l7-7"/></svg>';
  missionsRail.appendChild(railChevronDown);
  missionsBody.appendChild(missionsRail);
  function updateRailChevrons() {
    const maxScroll = missionList.scrollHeight - missionList.clientHeight;
    railChevronUp.disabled = missionList.scrollTop <= 2;
    railChevronDown.disabled = maxScroll <= 2 || missionList.scrollTop >= maxScroll - 2;
  }
  railChevronUp.addEventListener('click', () => missionList.scrollBy({ top: -300, behavior: 'smooth' }));
  railChevronDown.addEventListener('click', () => missionList.scrollBy({ top: 300, behavior: 'smooth' }));
  missionList.addEventListener('scroll', updateRailChevrons);
  const missionsRadarPanel = makeNode('div', 'missions-radar-panel');
  const radarHead = makeNode('div', 'missions-radar-head');
  const radarHeadIcon = makeNode('span', 'missions-radar-head-icon');
  radarHeadIcon.innerHTML = menuArtModule.iconSvg('map', 15);
  radarHead.append(radarHeadIcon, makeNode('span', 'missions-radar-head-text', '3D MAP'), makeNode('span', 'missions-radar-head-sub', 'SORTIE RADAR · NORTH UP'));
  missionsRadarPanel.appendChild(radarHead);
  const radarCanvas = document.createElement('canvas');
  radarCanvas.className = 'missions-radar-canvas';
  radarCanvas.width = 920;
  radarCanvas.height = 920;
  missionsRadarPanel.appendChild(radarCanvas);
  const radarCaption = makeNode('div', 'missions-radar-caption', '');
  missionsRadarPanel.appendChild(radarCaption);
  missionsBody.appendChild(missionsRadarPanel);
  const missionDetail = makeNode('div', 'mission-detail');
  const detailInfo = makeNode('div', 'detail-info');
  const detailChips = makeNode('div', 'detail-chips');
  detailInfo.appendChild(detailChips);
  const detailTitle = makeNode('h2', 'detail-title', '');
  detailInfo.appendChild(detailTitle);
  const detailGoal = makeNode('p', 'detail-goal', '');
  detailInfo.appendChild(detailGoal);
  const detailTiles = makeNode('div', 'ui-tile-grid ui-tile-grid-3');
  const detailWindTile = tileNode('WIND', 'wind');
  const detailBestTile = tileNode('BEST', 'trophy');
  const detailMaxTile = tileNode('MAX SCORE', 'medal');
  detailTiles.append(detailWindTile, detailBestTile, detailMaxTile);
  detailInfo.appendChild(detailTiles);
  const detailScoreBox = makeNode('div', 'detail-score-box');
  const detailScoreHead = makeNode('div', 'detail-score-head');
  detailScoreHead.appendChild(makeNode('span', 'detail-score-label', 'BEST SCORE'));
  const detailScoreValue = makeNode('span', 'detail-score-value', '—');
  detailScoreHead.appendChild(detailScoreValue);
  detailScoreBox.appendChild(detailScoreHead);
  const detailScoreBar = makeNode('div', 'detail-score-bar');
  const detailScoreFill = makeNode('div', 'detail-score-fill');
  detailScoreBar.appendChild(detailScoreFill);
  detailScoreBox.appendChild(detailScoreBar);
  const detailScoreRuler = makeNode('div', 'detail-score-ruler');
  const detailScoreTickLabels = [];
  for (let tickIndex = 0; tickIndex < 5; tickIndex++) {
    const tickLabel = makeNode('span', 'detail-score-tick-label', '');
    detailScoreRuler.appendChild(tickLabel);
    detailScoreTickLabels.push(tickLabel);
  }
  detailScoreBox.appendChild(detailScoreRuler);
  detailInfo.appendChild(detailScoreBox);
  const detailStatus = makeNode('div', 'detail-status');
  const detailStatusLabel = makeNode('span', 'detail-status-label', 'STATUS');
  detailStatus.appendChild(detailStatusLabel);
  const detailStatusBadge = makeNode('span', 'detail-status-badge', '—');
  detailStatus.appendChild(detailStatusBadge);
  detailInfo.appendChild(detailStatus);
  const detailMedal = makeNode('div', 'detail-medal');
  detailInfo.appendChild(detailMedal);
  const detailButton = makeNode('button', 'btn btn-primary btn-rich detail-go');
  detailButton.type = 'button';
  const detailButtonIcon = makeNode('span', 'btn-icon');
  detailButtonIcon.innerHTML = menuArtModule.iconSvg('map', 20);
  detailButton.appendChild(detailButtonIcon);
  const detailButtonText = makeNode('span', 'btn-text');
  const detailButtonLabel = makeNode('span', 'btn-label', 'BRIEFING');
  detailButtonText.appendChild(detailButtonLabel);
  detailButton.append(detailButtonText, makeNode('kbd', 'btn-key', 'ENTER'));
  detailInfo.appendChild(detailButton);
  missionDetail.appendChild(detailInfo);
  missionsBody.appendChild(missionDetail);
  missionsScreen.appendChild(missionsBody);

  missionsActions.append(makeButton('FREE FLIGHT', 'freeFlight', {}, 'btn-small', { icon: 'compass' }), makeButton('BACK', 'back', {}, 'btn-small', { icon: 'back', key: 'ESC' }));
  const missionsHint = makeNode('div', 'missions-hint');
  missionsHint.innerHTML = '<kbd class="keycap">↑</kbd><kbd class="keycap">↓</kbd><span>choose</span>'
    + '<kbd class="keycap">ENTER</kbd><span>briefing</span><kbd class="keycap">ESC</kbd><span>back</span>';
  missionsScreen.appendChild(missionsHint);

  let missionRows = [];
  let previewIndex = -1;
  let previewList = [];

  // Display-only wind readout: mirrors missions.js windForMission
  // (WIND_BY_TIER speeds + sortie-index direction). That helper is not
  // exported, so the same real values are derived here from the
  // already-imported MISSIONS table. No mission logic is changed.
  const WIND_BY_TIER_DISPLAY = { 1: { speed: 1, gustAmp: 0 }, 2: { speed: 4, gustAmp: 2 }, 3: { speed: 7.5, gustAmp: 4 } };
  function windForDisplay(missionId, tier) {
    const list = Array.isArray(MENU_MISSIONS) ? MENU_MISSIONS : [];
    const sortieIndex = list.findIndex((entry) => entry.id === missionId);
    const tierWind = WIND_BY_TIER_DISPLAY[tier] || WIND_BY_TIER_DISPLAY[1];
    const dirDeg = sortieIndex >= 0 ? (sortieIndex * 47 + 30) % 360 : 30;
    return { dirDeg, speed: tierWind.speed, gustAmp: tierWind.gustAmp };
  }
  function formatWind(wind) {
    const speedText = Number.isInteger(wind.speed) ? String(wind.speed) : wind.speed.toFixed(1);
    let text = padThreeDigits(wind.dirDeg) + '° · ' + speedText + ' M/S';
    if (wind.gustAmp > 0) text += ' · GUST ' + (Number.isInteger(wind.gustAmp) ? wind.gustAmp : wind.gustAmp.toFixed(1));
    return text;
  }

  // Centre radar: animated only while this screen is visible. The
  // loop checks the screen's .visible class every frame and stops
  // itself the moment another screen (or flight) takes over.
  let radarFrameId = null;
  let radarMissionId = null;
  function drawRadarFrame(timeMs) {
    radarFrameId = null;
    if (!missionsScreen.classList.contains('visible')) return;
    try {
      drawRadar(radarCanvas, {
        missionLike: radarMissionId ? { id: radarMissionId } : null,
        northUp: true,
        range: 6000,
      }, timeMs);
    } catch (error) { /* radar dressing only */ }
    radarFrameId = requestAnimationFrame(drawRadarFrame);
  }
  function startRadarLoop() {
    if (radarFrameId !== null || typeof requestAnimationFrame !== 'function') return;
    radarFrameId = requestAnimationFrame(drawRadarFrame);
  }

  // Status pill for the detail pane, picked from a small table so
  // the locked/next/completed precedence stays in one place.
  function missionStatus(mission, medal, bestScoreValue) {
    if (mission.locked) return ['LOCKED', 'status-locked'];
    if (mission.isNext) return ['NEXT UP', 'status-next'];
    if (medal !== 'none' || bestScoreValue > 0) return ['COMPLETED', 'status-done'];
    return ['OPEN', 'status-open'];
  }

  function previewMission(index) {
    const mission = previewList[index];
    if (!mission) return;
    previewIndex = index;
    missionRows.forEach((row, k) => row.classList.toggle('selected', k === index));
    const definition = menuArtModule.missionDefinition(mission.id) || mission;
    const typeInfo = menuArtModule.MISSION_TYPES[definition.type] || menuArtModule.MISSION_TYPES['free-flight'];
    const tier = definition.tier || 1;
    detailChips.replaceChildren();
    detailChips.append(chipNode(typeInfo.label, typeInfo.icon, 'chip-type'), chipNode('TIER ' + tier + ' · ' + (menuArtModule.TIER_NAMES[definition.tier] || ''), 'wind'));
    detailTitle.textContent = mission.title || definition.title || '';
    detailGoal.textContent = mission.goal || definition.briefing || '';
    detailWindTile.valueElement.textContent = formatWind(windForDisplay(mission.id, tier));
    detailBestTile.valueElement.textContent = mission.locked ? '—' : formatScore(mission.bestScore || 0);
    detailMaxTile.valueElement.textContent = definition.maxScore ? formatScore(definition.maxScore) : '—';
    const maxScoreValue = definition.maxScore || 0;
    const bestScoreValue = mission.locked ? 0 : (mission.bestScore || 0);
    const scorePct = maxScoreValue > 0 ? Math.min(100, Math.max(0, (bestScoreValue / maxScoreValue) * 100)) : 0;
    detailScoreFill.style.width = scorePct + '%';
    detailScoreValue.textContent = mission.locked ? '—' : formatScore(bestScoreValue) + ' / ' + formatScore(maxScoreValue);
    detailScoreTickLabels.forEach((tickLabel, tickIndex) => {
      tickLabel.textContent = maxScoreValue > 0 ? formatScore(Math.round((maxScoreValue * tickIndex) / 4)) : '';
    });
    const medal = medalKey(mission.medal);
    const [statusText, statusClass] = missionStatus(mission, medal, bestScoreValue);
    detailStatusBadge.textContent = statusText;
    detailStatusBadge.className = 'detail-status-badge ' + statusClass;
    detailMedal.replaceChildren();
    const medalArt = makeNode('span', 'detail-medal-art');
    medalArt.innerHTML = menuArtModule.medalSvg(medal, 28);
    detailMedal.appendChild(medalArt);
    let medalText = 'NO MEDAL YET';
    if (mission.locked) medalText = 'LOCKED — FINISH THE TIER BEFORE';
    else if (medal !== 'none') medalText = medal.toUpperCase() + ' MEDAL EARNED';
    detailMedal.appendChild(makeNode('span', 'detail-medal-text', medalText));
    detailButton.disabled = !!mission.locked;
    detailButtonLabel.textContent = mission.locked ? 'LOCKED' : 'BRIEFING';
    missionDetail.classList.toggle('locked', !!mission.locked);
    radarMissionId = mission.id || null;
    radarCaption.textContent = 'ROUTE · ' + typeInfo.label + ' · TIER ' + tier + ' · ' + (mission.title || definition.title || '');
    const selectedRow = missionRows[index];
    if (selectedRow && typeof selectedRow.scrollIntoView === 'function') {
      selectedRow.scrollIntoView({ block: 'nearest' });
    }
    updateRailChevrons();
  }

  detailButton.addEventListener('click', () => {
    const mission = previewList[previewIndex];
    if (mission && !mission.locked) emitAction('selectMission', { missionId: mission.id, index: previewIndex });
  });

  // One mission row (stage card) in the select rail.
  function buildMissionRow(mission, index, definition, tier) {
    const typeInfo = menuArtModule.MISSION_TYPES[definition.type] || menuArtModule.MISSION_TYPES['free-flight'];
    const rowClass = 'mission-row stage-card' + (mission.locked ? ' locked' : '') + (mission.isNext ? ' next' : '');
    const row = makeNode('button', rowClass);
    row.type = 'button';
    row.setAttribute('aria-disabled', mission.locked ? 'true' : 'false');
    const goalText = mission.goal || mission.briefing || '';
    if (goalText) row.title = goalText;
    if (row.style.setProperty) row.style.setProperty('--type-hue', typeInfo.hue);
    const thumb = makeNode('span', 'stage-thumb');
    const thumbChart = menuArtModule.createMissionChart(264, 58, definition, { compact: true });
    if (thumbChart) thumb.appendChild(thumbChart);
    if (mission.locked) {
      const lockOverlay = makeNode('span', 'stage-lock');
      lockOverlay.innerHTML = menuArtModule.iconSvg('lock', 22);
      thumb.appendChild(lockOverlay);
    }
    row.appendChild(thumb);
    const cardBody = makeNode('span', 'stage-card-body');
    const cardTop = makeNode('span', 'stage-card-top');
    cardTop.appendChild(makeNode('span', 'stage-label', 'STAGE ' + (index + 1)));
    const medal = medalKey(mission.medal);
    if (medal !== 'none') {
      const art = makeNode('span', 'mission-row-medal stage-medal');
      art.innerHTML = menuArtModule.medalSvg(medal, 18);
      cardTop.appendChild(art);
    }
    if (mission.isNext && !mission.locked) {
      cardTop.appendChild(makeNode('span', 'mission-row-next', 'NEXT'));
    }
    cardBody.append(cardTop, makeNode('span', 'mission-row-title', mission.title || ('Sortie ' + (index + 1))));
    const cardSub = makeNode('span', 'stage-card-sub');
    const typeTag = makeNode('span', 'stage-type-tag');
    typeTag.style.color = typeInfo.hue;
    const typeTagIcon = makeNode('span', 'stage-type-icon');
    typeTagIcon.innerHTML = menuArtModule.iconSvg(typeInfo.icon, 12);
    typeTag.append(typeTagIcon, makeNode('span', 'stage-type-text', typeInfo.label));
    cardSub.appendChild(typeTag);
    cardSub.appendChild(makeNode('span', 'mission-row-best',
      mission.locked ? 'LOCKED' : formatScore(mission.bestScore || 0)));
    cardBody.appendChild(cardSub);
    const goalLine = mission.locked
      ? 'Finish Tier ' + Math.max(1, tier - 1) + ' to unlock'
      : cardGoalText(mission);
    cardBody.appendChild(makeNode('span', 'mission-row-goal', goalLine));
    row.appendChild(cardBody);
    row.addEventListener('mouseenter', () => previewMission(index));
    row.addEventListener('focus', () => previewMission(index));
    row.addEventListener('click', () => {
      if (mission.locked) {
        row.classList.remove('shake');
        void row.offsetWidth; // restart the shake animation
        row.classList.add('shake');
        previewMission(index);
        return;
      }
      emitAction('selectMission', { missionId: mission.id, index });
    });
    return row;
  }

  function renderMissionsScreen(data) {
    missionList.replaceChildren();
    missionRows = [];
    previewList = (data && data.missions) || [];
    const campaign = campaignOf(data);
    const doneCount = Array.isArray(campaign.completed)
      ? campaign.completed.length
      : previewList.filter((m) => m.bestScore > 0).length;
    missionsProgressText.textContent = doneCount + ' / ' + previewList.length + ' SORTIES FLOWN';
    missionsProgressFill.style.width = (previewList.length ? (doneCount / previewList.length) * 100 : 0) + '%';
    let lastTier = null;
    let firstIndex = -1;
    previewList.forEach((mission, index) => {
      const definition = menuArtModule.missionDefinition(mission.id) || mission;
      const tier = mission.tier || definition.tier || 1;
      if (tier !== lastTier) {
        lastTier = tier;
        const header = makeNode('div', 'tier-header');
        header.append(tierPips(tier), makeNode('span', 'tier-name', 'TIER ' + tier + ' · ' + (menuArtModule.TIER_NAMES[tier] || '')));
        missionList.appendChild(header);
      }
      const row = buildMissionRow(mission, index, definition, tier);
      missionList.appendChild(row);
      missionRows.push(row);
      if (firstIndex === -1 && mission.isNext && !mission.locked) firstIndex = index;
    });
    if (firstIndex === -1) firstIndex = previewList.findIndex((m) => !m.locked);
    previewMission(Math.max(0, firstIndex));
    updateRailChevrons();
    startRadarLoop();
  }

  // ---------------------------------------------------------- briefing

  const briefingScreen = makeScreen('briefing');
  briefingScreen.classList.add('screen-v6');
  addScreenChrome(briefingScreen, ['THE MORNING ROUND', 'BRIEFING']);
  // CONCEPT: MISSION BRIEFING header (gold tick + title, micro-labels).
  const briefingHead = makeNode('div', 'concept-briefing-head');
  briefingHead.append(makeNode('span', 'concept-briefing-tick'), makeNode('span', 'concept-briefing-title', 'MISSION BRIEFING'), makeNode('span', 'concept-briefing-sub', 'AURORA ARCHIPELAGO · DAWN SORTIE'));
  briefingScreen.appendChild(briefingHead);
  const briefingLayout = makeNode('div', 'briefing-layout');
  const briefingChartCard = makeNode('div', 'briefing-chart-card concept-holo-frame');
  const briefingHoloLabel = makeNode('div', 'concept-holo-label');
  briefingHoloLabel.innerHTML = menuArtModule.iconSvg('map', 12) + '<span>HOLO-CHART</span>';
  briefingChartCard.appendChild(briefingHoloLabel);
  const briefingHoloCanvas = document.createElement('canvas');
  briefingHoloCanvas.className = 'briefing-holo-canvas';
  briefingHoloCanvas.width = 700;
  briefingHoloCanvas.height = 460;
  briefingHoloCanvas.setAttribute('aria-label', 'Holographic route chart of the Aurora Archipelago');
  briefingChartCard.appendChild(briefingHoloCanvas);
  ['tl', 'tr', 'bl', 'br'].forEach((corner) => {
    briefingChartCard.append(makeNode('span', 'concept-bracket concept-bracket-' + corner), makeNode('span', 'concept-screw concept-screw-' + corner));
  });
  const briefingChartCaption = makeNode('div', 'briefing-chart-caption');
  briefingChartCaption.innerHTML = menuArtModule.iconSvg('map', 14) + '<span>HOLO-CHART · ISOMETRIC · AURORA ARCHIPELAGO</span>';
  briefingChartCard.appendChild(briefingChartCaption);
  briefingLayout.appendChild(briefingChartCard);
  let briefingHoloMap = null;
  function stopBriefingHoloMap() {
    if (briefingHoloMap) { try { briefingHoloMap.stop(); } catch (error) { /* display only */ } briefingHoloMap = null; }
  }
  // Stop the holo rAF loop whenever the briefing screen is hidden.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (!briefingScreen.classList.contains('visible')) stopBriefingHoloMap();
    }).observe(briefingScreen, { attributes: true, attributeFilter: ['class'] });
  }
  const briefingCard = makeNode('div', 'briefing-info');
  const briefingChips = makeNode('div', 'detail-chips');
  briefingCard.appendChild(briefingChips);
  const briefingTitle = makeNode('h1', 'briefing-title', 'BRIEFING');
  briefingCard.appendChild(briefingTitle);
  const briefingBody = makeNode('p', 'briefing-body');
  briefingCard.appendChild(briefingBody);
  const briefingList = makeNode('ul', 'objective-list');
  briefingCard.appendChild(briefingList);
  const briefingTiles = makeNode('div', 'ui-tile-grid ui-tile-grid-3');
  const briefParTile = tileNode('PAR TIME', 'clock');
  const briefMaxTile = tileNode('MAX SCORE', 'trophy');
  const briefWindTile = tileNode('WIND', 'wind');
  const briefFuelTile = tileNode('FUEL', 'fuel');
  const briefDamageTile = tileNode('AIRFRAME', 'wrench');
  const briefStartTile = tileNode('START', 'takeoff');
  [briefParTile, briefMaxTile, briefWindTile, briefFuelTile, briefDamageTile, briefStartTile].forEach((tile) => briefingTiles.appendChild(tile));
  briefingCard.appendChild(briefingTiles);
  // CONCEPT: Statistics list (real values only; tiles stay in the DOM
  // and keep updating, concept-ui.css hides the tile grid on briefing).
  const briefingStats = makeNode('div', 'concept-stats');
  const briefingStatsHead = makeNode('div', 'concept-stats-head');
  briefingStatsHead.append(makeNode('span', 'concept-stats-title', 'Statistics'), makeNode('span', 'concept-stats-rule'));
  briefingStats.appendChild(briefingStatsHead);
  function makeBriefStatRow(label) {
    const row = makeNode('div', 'concept-stat-row');
    row.append(makeNode('span', 'concept-stat-tick'), makeNode('span', 'concept-stat-label', label));
    const value = makeNode('span', 'concept-stat-value', '—');
    row.appendChild(value);
    row.valueElement = value;
    briefingStats.appendChild(row);
    return row;
  }
  const briefTypeRow = makeBriefStatRow('Sortie Type');
  const briefTierRow = makeBriefStatRow('Tier');
  const briefMaxRow = makeBriefStatRow('Max Score');
  const briefBestRow = makeBriefStatRow('Best Score');
  const briefMedalRow = makeBriefStatRow('Medal');
  const briefWindRow = makeBriefStatRow('Wind');
  const briefParRow = makeBriefStatRow('Par Time');
  const briefStartRow = makeBriefStatRow('Start');
  briefingCard.appendChild(briefingStats);
  ['tl', 'tr', 'bl', 'br'].forEach((corner) => {
    briefingCard.append(makeNode('span', 'concept-bracket concept-bracket-' + corner), makeNode('span', 'concept-screw concept-screw-' + corner));
  });
  const briefingButtonRow = makeNode('div', 'btn-row concept-briefing-actions');
  const briefingTakeoffButton = makeButton('TAKE OFF', 'start', {}, 'btn-primary concept-takeoff', { icon: 'takeoff', key: 'ENTER' });
  const takeoffChevronLeft = makeNode('span', 'concept-chevron concept-chevron-left', '«');
  const takeoffChevronRight = makeNode('span', 'concept-chevron concept-chevron-right', '»');
  briefingTakeoffButton.insertBefore(takeoffChevronLeft, briefingTakeoffButton.firstChild);
  briefingTakeoffButton.appendChild(takeoffChevronRight);
  briefingButtonRow.append(briefingTakeoffButton, makeButton('BACK', 'back', {}, 'concept-back', { icon: 'back', key: 'ESC' }));
  briefingCard.appendChild(briefingButtonRow);
  briefingLayout.appendChild(briefingCard);
  briefingScreen.appendChild(briefingLayout);

  function windDialSvg(fromDeg, speed) {
    const toward = (fromDeg + 180) % 360;
    const needleColour = speed > 5 ? '#FF9F1C' : '#7DFFB2';
    const dial = '<circle cx="20" cy="20" r="17" fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.35)" stroke-width="1.5"/>';
    const northMark = '<text x="20" y="9" text-anchor="middle" font-size="6.5" font-weight="800" fill="#FF9E64" font-family="Segoe UI, Arial">N</text>';
    const arrow = '<g transform="rotate(' + toward + ' 20 20)">'
      + '<path d="M20 8 L25 22 L20 19 L15 22 Z" fill="' + needleColour + '"/>'
      + '<path d="M20 19 L20 31" stroke="#F2EDE4" stroke-width="2" stroke-linecap="round"/></g>';
    return '<svg class="wind-dial" viewBox="0 0 40 40" width="34" height="34" aria-hidden="true">'
      + dial + northMark + arrow + '</svg>';
  }

  function renderBriefingScreen(data) {
    const mission = (data && data.mission) || data || {};
    const definition = (mission.id && menuArtModule.missionDefinition(mission.id)) || mission;
    const typeInfo = menuArtModule.MISSION_TYPES[definition.type] || menuArtModule.MISSION_TYPES['free-flight'];
    briefingChips.replaceChildren();
    briefingChips.appendChild(chipNode(typeInfo.label, typeInfo.icon, 'chip-type'));
    if (definition.tier) {
      briefingChips.appendChild(chipNode('TIER ' + definition.tier + ' · ' + (menuArtModule.TIER_NAMES[definition.tier] || ''), 'wind'));
    }
    briefingTitle.textContent = mission.title || 'BRIEFING';
    briefingBody.textContent = mission.briefing || mission.goal || '';
    briefingList.replaceChildren();
    const objectives = mission.objectives || (mission.objective ? [mission.objective] : []);
    for (const objective of objectives) {
      const item = makeNode('li', 'objective-item');
      const tick = makeNode('span', 'objective-icon');
      tick.innerHTML = menuArtModule.iconSvg(typeInfo.icon, 16);
      item.append(tick, makeNode('span', 'objective-text', objective));
      briefingList.appendChild(item);
    }
    briefParTile.valueElement.textContent = mission.parTimeSeconds !== undefined ? formatClock(mission.parTimeSeconds) : 'NONE';
    briefMaxTile.valueElement.textContent = mission.maxScore !== undefined ? formatScore(mission.maxScore) : '—';
    const wind = (data && data.wind) || mission.wind;
    const windFromDeg = wind ? Math.round(firstDefined(wind.directionDeg, wind.dirDeg, 0)) % 360 : 0;
    const windSpeed = wind ? Math.round(firstDefined(wind.speed, wind.speedMps, 0)) : 0;
    if (wind) {
      briefWindTile.valueElement.innerHTML = windDialSvg(windFromDeg, windSpeed)
        + '<span>' + padThreeDigits(windFromDeg) + '° · ' + windSpeed + ' M/S</span>';
    } else {
      briefWindTile.valueElement.textContent = 'CALM';
    }
    const startFuel = firstDefined(data && data.fuelPercent, mission.fuelPercent);
    const fuelPercent = startFuel !== null && startFuel !== undefined ? Math.round(toPercent(startFuel)) : null;
    briefFuelTile.valueElement.innerHTML = fuelPercent === null ? '—'
      : '<span>' + fuelPercent + '%</span><span class="ui-mini-bar"><span style="width:' + fuelPercent + '%"></span></span>';
    const startDamage = firstDefined(data && data.damagePercent, mission.damagePercent);
    const integrity = startDamage !== null && startDamage !== undefined ? Math.max(0, 100 - Math.round(toPercent(startDamage))) : null;
    briefDamageTile.valueElement.textContent = integrity === null ? '—' : integrity + '%';
    briefStartTile.valueElement.textContent = definition.airborneStart ? 'AIRBORNE' : 'RUNWAY';
    // CONCEPT: Statistics rows — real values only. Best score / medal
    // come from the payload when present (briefingData may not carry
    // them yet); absent values read as an honest em dash, never faked.
    const campaign = (data && data.campaign) || {};
    const bestScore = firstDefined(
      mission.bestScore,
      data && data.bestScore,
      campaign.bestScores && definition.id ? campaign.bestScores[definition.id] : undefined,
    );
    const medal = firstDefined(
      mission.medal,
      data && data.medal,
      campaign.medals && definition.id ? campaign.medals[definition.id] : undefined,
    );
    briefTypeRow.valueElement.textContent = typeInfo.label;
    briefTierRow.valueElement.textContent = definition.tier
      ? 'TIER ' + definition.tier + ' · ' + (menuArtModule.TIER_NAMES[definition.tier] || '') : '—';
    briefMaxRow.valueElement.textContent = mission.maxScore !== undefined ? formatScore(mission.maxScore) : '—';
    const hasBestScore = bestScore !== null && bestScore !== undefined;
    briefBestRow.valueElement.textContent = hasBestScore ? formatScore(bestScore) : '—';
    briefBestRow.valueElement.classList.toggle('is-empty', !hasBestScore);
    briefMedalRow.valueElement.textContent = medal ? String(medal).toUpperCase() : '—';
    briefMedalRow.valueElement.classList.toggle('is-empty', !medal);
    briefWindRow.valueElement.textContent = wind
      ? padThreeDigits(windFromDeg) + '° · ' + windSpeed + ' M/S'
      : 'CALM';
    briefParRow.valueElement.textContent = mission.parTimeSeconds !== undefined ? formatClock(mission.parTimeSeconds) : 'NONE';
    briefStartRow.valueElement.textContent = definition.airborneStart ? 'AIRBORNE' : 'RUNWAY';
    // CONCEPT: holographic route chart. First draw per mission builds
    // the cached terrain layer (~0.4–1.3 s one-time); later opens reuse
    // it. The MutationObserver above stops the loop on screen exit.
    stopBriefingHoloMap();
    try {
      const holoArg = definition && definition.type
        ? definition
        : (definition && definition.id ? { id: definition.id } : null);
      briefingHoloMap = drawHoloMap(briefingHoloCanvas, holoArg, { animate: true });
    } catch (error) { briefingHoloMap = null; /* display only */ }
  }

  // ---------------------------------------------------------- pause

  const pauseScreen = makeScreen('pause');
  pauseScreen.classList.add('screen-v6');
  const pausePanel = makeNode('div', 'pause-panel');
  const pauseHead = makeNode('div', 'pause-head');
  const pauseGlyph = makeNode('span', 'pause-glyph');
  pauseGlyph.innerHTML = '<span></span><span></span>';
  pauseHead.append(pauseGlyph, makeNode('h1', 'screen-heading', 'PAUSED'));
  pausePanel.appendChild(pauseHead);
  const pauseTiles = makeNode('div', 'ui-tile-grid');
  const pauseScoreTile = tileNode('SCORE SO FAR', 'trophy');
  const pauseTimeTile = tileNode('FLIGHT TIME', 'clock');
  pauseTiles.append(pauseScoreTile, pauseTimeTile);
  pausePanel.appendChild(pauseTiles);
  const pauseStats = makeNode('div', 'stat-table');
  pausePanel.appendChild(pauseStats);
  const pauseMenu = makeNode('div', 'pause-menu');
  pauseMenu.append(makeButton('RESUME', 'resume', {}, 'btn-primary btn-wide', { icon: 'play', key: 'P' }), makeButton('RESTART SORTIE', 'restart', {}, 'btn-wide', { icon: 'retry', key: 'R' }), makeButton('ABANDON → MENU', 'quit', {}, 'btn-wide btn-danger', { icon: 'exit', key: 'Q' }));
  pausePanel.appendChild(pauseMenu);
  const pauseKeys = makeNode('div', 'pause-keys');
  pauseKeys.innerHTML = '<kbd class="keycap">C</kbd><span>camera</span><kbd class="keycap">H</kbd><span>controls</span>'
    + '<kbd class="keycap">M</kbd><span>sound</span>';
  pausePanel.appendChild(pauseKeys);
  pauseScreen.appendChild(pausePanel);

  function renderPauseScreen(data) {
    pauseStats.replaceChildren();
    pauseScoreTile.valueElement.textContent = formatScore((data && data.score) || 0);
    pauseTimeTile.valueElement.textContent = formatClock((data && data.time) || 0);
  }

  // ---------------------------------------------------------- debrief

  const debriefScreen = makeScreen('debrief');
  debriefScreen.classList.add('screen-v6');
  addScreenChrome(debriefScreen, ['THE MORNING ROUND', 'SORTIE REPORT']);
  const debriefTitle = makeNode('h1', 'screen-heading', 'SORTIE COMPLETE');
  debriefScreen.appendChild(debriefTitle);
  const debriefLayout = makeNode('div', 'debrief-layout');
  const debriefHero = makeNode('div', 'debrief-hero');
  const debriefMedalArt = makeNode('div', 'debrief-medal-art');
  debriefHero.appendChild(debriefMedalArt);
  const debriefMedal = makeNode('div', 'medal-line');
  debriefHero.appendChild(debriefMedal);
  const debriefGradeRing = makeNode('div', 'grade-ring');
  const debriefGrade = makeNode('div', 'grade-letter');
  debriefGradeRing.append(debriefGrade, makeNode('div', 'grade-caption', 'LANDING GRADE'));
  debriefHero.appendChild(debriefGradeRing);
  debriefLayout.appendChild(debriefHero);
  const debriefCard = makeNode('div', 'screen-card debrief-card');
  const debriefVerdict = makeNode('div', 'verdict-line');
  debriefCard.appendChild(debriefVerdict);
  const debriefStats = makeNode('div', 'stat-table stat-table-2col');
  debriefCard.appendChild(debriefStats);
  const debriefFlight = makeNode('div', 'ui-tile-grid ui-tile-grid-3 debrief-flight');
  const debriefTimeTile = tileNode('FLIGHT TIME', 'clock');
  const debriefFuelTile = tileNode('FUEL LEFT', 'fuel');
  const debriefDamageTile = tileNode('DAMAGE', 'wrench');
  debriefFlight.append(debriefTimeTile, debriefFuelTile, debriefDamageTile);
  debriefCard.appendChild(debriefFlight);
  const debriefTotal = makeNode('div', 'debrief-total');
  const debriefTotalLabel = makeNode('span', 'debrief-total-label', 'SCORE');
  const debriefTotalValue = makeNode('span', 'debrief-total-value', '0');
  debriefTotal.append(debriefTotalLabel, debriefTotalValue);
  debriefCard.appendChild(debriefTotal);
  debriefLayout.appendChild(debriefCard);
  debriefScreen.appendChild(debriefLayout);
  const debriefButtonRow = makeNode('div', 'btn-row');
  debriefButtonRow.append(makeButton('NEXT SORTIE', 'next', {}, 'btn-primary', { icon: 'next', key: 'ENTER' }), makeButton('RETRY', 'retry', {}, '', { icon: 'retry', key: 'R' }), makeButton('MENU', 'menu', {}, '', { icon: 'menu', key: 'ESC' }));
  debriefScreen.appendChild(debriefButtonRow);

  let countUpFrame = null;
  function countUp(element, target) {
    const value = Math.max(0, Math.round(target || 0));
    if (countUpFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(countUpFrame);
    if (typeof requestAnimationFrame !== 'function' || value === 0) {
      element.textContent = formatScore(value);
      return;
    }
    const startMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const durationMs = 900;
    const tick = (nowMs) => {
      const elapsed = Math.min(1, (nowMs - startMs) / durationMs);
      const eased = 1 - Math.pow(1 - elapsed, 3);
      element.textContent = formatScore(Math.round(value * eased));
      countUpFrame = elapsed < 1 ? requestAnimationFrame(tick) : null;
    };
    element.textContent = formatScore(0);
    countUpFrame = requestAnimationFrame(tick);
  }

  function renderDebriefScreen(data) {
    const result = data || {};
    const failed = !!result.failed;
    // VD-26 (visual_spec §2.5): the two failure dialects stay distinct
    // — debrief cream 40 px, crash #FF6B6B 48 px — and a crash-class
    // ending always shows the crash styling, whichever screen the
    // (frozen) routing landed on. Display only; routing untouched.
    const crashEnd = ['crashed', 'wrecked', 'ditched'].includes(result.endReason);
    debriefTitle.textContent = crashEnd ? 'CRASHED' : (failed ? 'SORTIE FAILED' : 'SORTIE COMPLETE');
    debriefTitle.classList.toggle('heading-crash', crashEnd);
    debriefScreen.classList.toggle('debrief-failed', crashEnd || failed);
    debriefVerdict.textContent = result.verdict || '';
    // Grade letter (ui_spec §2.5 S/A/B/C): missions.js exposes the
    // already-computed touchdown grade total; the letter reuses the
    // design §2.4 verdict bands (900/700/400). Display only — no
    // scoring change. An explicit result.grade still wins.
    const touchdownGrade = result.touchdownGrade || null;
    let gradeLetter = result.grade || '';
    if (!gradeLetter && touchdownGrade && typeof touchdownGrade.total === 'number') {
      gradeLetter = touchdownGrade.total >= 900 ? 'S'
        : touchdownGrade.total >= 700 ? 'A'
        : touchdownGrade.total >= 400 ? 'B' : 'C';
    }
    debriefGrade.textContent = gradeLetter;
    debriefGradeRing.style.display = gradeLetter ? '' : 'none';
    debriefGradeRing.className = 'grade-ring grade-' + String(gradeLetter || 'none').toLowerCase();
    const medal = medalKey(result.medal);
    debriefMedalArt.innerHTML = menuArtModule.medalSvg(medal, 112);
    debriefMedalArt.classList.toggle('no-medal', medal === 'none');
    debriefMedal.textContent = result.medal ? String(result.medal).toUpperCase() + ' MEDAL' : 'NO MEDAL THIS TIME';
    debriefStats.replaceChildren();
    const breakdown = result.breakdown || [];
    for (const line of breakdown) {
      if (typeof line === 'string') debriefStats.appendChild(makeStatRow(line, ''));
    }
    for (const line of mergeBreakdown(breakdown)) {
      const row = makeStatRow(line.label, line.value !== undefined ? formatScore(line.value) : '');
      if (typeof line.value === 'number' && line.value < 0) row.classList.add('stat-row-negative');
      debriefStats.appendChild(row);
    }
    debriefTimeTile.valueElement.textContent = result.flightTimeSeconds !== undefined ? formatClock(result.flightTimeSeconds) : '—';
    debriefFuelTile.valueElement.textContent = result.fuelRemainingPercent !== undefined ? Math.round(toPercent(result.fuelRemainingPercent)) + '%' : '—';
    debriefDamageTile.valueElement.textContent = result.damageTakenPercent !== undefined ? Math.round(toPercent(result.damageTakenPercent)) + '%' : '—';
    // Landing detail (ui_spec §2.5): sink / centreline / speed from
    // the already-computed touchdown grade, when one exists.
    if (touchdownGrade) {
      if (typeof touchdownGrade.sinkRate === 'number') {
        debriefStats.appendChild(makeStatRow('Touchdown sink', touchdownGrade.sinkRate.toFixed(1) + ' m/s'));
      }
      if (typeof touchdownGrade.centreOffset === 'number') {
        const offsetText = isFinite(touchdownGrade.centreOffset)
          ? touchdownGrade.centreOffset.toFixed(1) + ' m' : 'off strip';
        debriefStats.appendChild(makeStatRow('Centreline offset', offsetText));
      }
      if (typeof touchdownGrade.touchdownSpeed === 'number') {
        debriefStats.appendChild(makeStatRow('Touchdown speed', Math.round(touchdownGrade.touchdownSpeed) + ' m/s'));
      }
    }
    countUp(debriefTotalValue, result.score || 0);
  }

  // ---------------------------------------------------------- crashed

  const crashedScreen = makeScreen('crashed');
  crashedScreen.classList.add('screen-v6', 'screen-crash');
  const crashedBadge = makeNode('div', 'crash-badge');
  crashedBadge.innerHTML = menuArtModule.iconSvg('warning', 44);
  crashedScreen.append(crashedBadge, makeNode('h1', 'screen-heading heading-crash', 'CRASHED'));
  const crashedCard = makeNode('div', 'screen-card crash-card');
  const crashedCause = makeNode('div', 'verdict-line');
  crashedCard.appendChild(crashedCause);
  const crashedTiles = makeNode('div', 'ui-tile-grid ui-tile-grid-3');
  const crashScoreTile = tileNode('SCORE', 'trophy');
  const crashTimeTile = tileNode('FLIGHT TIME', 'clock');
  const crashDamageTile = tileNode('DAMAGE', 'wrench');
  crashedTiles.append(crashScoreTile, crashTimeTile, crashDamageTile);
  crashedCard.appendChild(crashedTiles);
  const crashedStats = makeNode('div', 'stat-table');
  crashedCard.appendChild(crashedStats);
  crashedCard.appendChild(makeNode('div', 'crash-tip',
    'Tip: a go-around always beats a bent aeroplane — throttle up, nose down a little, fly away and try again.'));
  crashedScreen.appendChild(crashedCard);
  const crashedButtonRow = makeNode('div', 'btn-row');
  crashedButtonRow.append(makeButton('RETRY SORTIE', 'retry', {}, 'btn-primary', { icon: 'retry', key: 'R' }), makeButton('MENU', 'menu', {}, '', { icon: 'menu', key: 'ESC' }));
  crashedScreen.appendChild(crashedButtonRow);

  function renderCrashedScreen(data) {
    const result = data || {};
    crashedCause.textContent = result.cause || result.reason || result.verdict || '';
    crashedStats.replaceChildren();
    crashScoreTile.valueElement.textContent = result.score !== undefined ? formatScore(result.score) : '—';
    crashTimeTile.valueElement.textContent = result.flightTimeSeconds !== undefined ? formatClock(result.flightTimeSeconds) : '—';
    crashDamageTile.valueElement.textContent = result.damageTakenPercent !== undefined ? Math.round(toPercent(result.damageTakenPercent)) + '%' : '—';
  }

  // ---------------------------------------------------------- campaign

  const campaignScreen = makeScreen('campaign');
  campaignScreen.classList.add('screen-v6');
  addScreenChrome(campaignScreen, ['THE MORNING ROUND', 'COMPLETE']);
  campaignScreen.append(makeNode('div', 'title-kicker', 'THE MORNING ROUND IS DONE'), makeNode('h1', 'screen-heading heading-campaign', 'ALL MAIL DELIVERED'));
  const campaignMedals = makeNode('div', 'campaign-medals');
  campaignScreen.appendChild(campaignMedals);
  const campaignCard = makeNode('div', 'screen-card');
  const campaignStats = makeNode('div', 'stat-table');
  campaignCard.appendChild(campaignStats);
  campaignScreen.appendChild(campaignCard);
  const campaignButtonRow = makeNode('div', 'btn-row');
  campaignButtonRow.append(makeButton('FLY AGAIN', 'fly', {}, 'btn-primary', { icon: 'takeoff', key: 'ENTER' }), makeButton('MENU', 'menu', {}, '', { icon: 'menu', key: 'ESC' }));
  campaignScreen.appendChild(campaignButtonRow);

  function renderCampaignScreen(data) {
    const result = data || {};
    campaignMedals.replaceChildren();
    const counts = { gold: result.goldCount || 0, silver: result.silverCount || 0, bronze: result.bronzeCount || 0 };
    for (const tier of ['silver', 'gold', 'bronze']) {
      const slot = makeNode('div', 'campaign-medal campaign-medal-' + tier);
      const art = makeNode('div', 'campaign-medal-art');
      art.innerHTML = menuArtModule.medalSvg(counts[tier] > 0 ? tier : 'none', tier === 'gold' ? 108 : 84);
      slot.append(art, makeNode('div', 'campaign-medal-count', '× ' + counts[tier]), makeNode('div', 'campaign-medal-name', tier.toUpperCase()));
      campaignMedals.appendChild(slot);
    }
    campaignStats.replaceChildren();
    campaignStats.appendChild(makeStatRow('Total score', formatScore(result.totalScore || 0), true));
    if (result.goldCount !== undefined) {
      const medalSummary = result.goldCount + ' Gold · ' + (result.silverCount || 0)
        + ' Silver · ' + (result.bronzeCount || 0) + ' Bronze';
      campaignStats.appendChild(makeStatRow('Medals', medalSummary));
    }
    if (result.totalFlightTimeSeconds !== undefined) campaignStats.appendChild(makeStatRow('Total flight time', formatClock(result.totalFlightTimeSeconds)));
    if (result.totalDistanceMetres !== undefined) campaignStats.appendChild(makeStatRow('Total distance', formatDistance(result.totalDistanceMetres)));
    if (result.parcelsDelivered !== undefined) campaignStats.appendChild(makeStatRow('Parcels delivered', result.parcelsDelivered));
    if (result.bestLandingGrade !== undefined) campaignStats.appendChild(makeStatRow('Best landing grade', result.bestLandingGrade));
  }

  // ---------------------------------------------------------- help

  // Help overlay (D-146): rows copied verbatim from input.js HELP_HTML,
  // the single source of truth for key mappings. input.js shows its own
  // overlay in flight; this screen serves the menu phases (main.js
  // routes 'help' here on title/missions/briefing). Both surfaces must
  // stay identical — if input.js HELP_HTML changes, mirror it here.
  // Stick convention: ArrowDown/S = pull = nose up; ArrowUp/W = push =
  // nose down. Roll is ArrowLeft/ArrowRight only; A/D (+Q) is rudder yaw.
  // Keys render as keycaps, grouped into four labelled panels.
  const helpScreen = makeScreen('help');
  helpScreen.classList.add('screen-v6');
  addScreenChrome(helpScreen, ['MAIN MENU', 'HOW TO FLY']);
  helpScreen.appendChild(makeNode('h1', 'screen-heading', 'HOW TO FLY'));
  const helpCard = makeNode('div', 'screen-card screen-card-wide');
  helpCard.appendChild(makeNode('p', 'screen-subtitle',
    'Throttle = up/down. Stick back = nose up = slower. Keep speed above 20. Land slow, flat, on the centreline.'));
  const helpSteps = makeNode('div', 'help-steps');
  const firstFlightSteps = [
    ['1', 'Full throttle', '9'], ['2', 'Release brake', 'V'], ['3', 'Rotate at 22 m/s', '↓'],
    ['4', 'Climb to 200 m', '↓'], ['5', 'Bank to turn', '← →'], ['6', 'Flare, then brake', 'SPACE'],
  ];
  for (const [number, text, key] of firstFlightSteps) {
    const step = makeNode('div', 'help-step');
    step.append(makeNode('span', 'help-step-number', number), makeNode('span', 'help-step-text', text), makeNode('kbd', 'keycap', key));
    helpSteps.appendChild(step);
  }
  helpCard.appendChild(helpSteps);
  helpSteps.title = 'First flight (30 seconds): full throttle (9) → release brake → pull gently (ArrowDown) at 22 m/s → climb to 200 m → turn with bank (ArrowLeft / ArrowRight) → throttle back → descend → flare (pull gently) → brakes (Space).';
  const helpRows = [
    ['ArrowDown / S', 'Pull stick — nose up (climb, slower)'],
    ['ArrowUp / W', 'Push stick — nose down (descend, faster)'],
    ['ArrowLeft / ArrowRight', 'Bank left / right (turn)'],
    ['A / D (Q = left too)', 'Rudder left / right (yaw, ground steering)'],
    ['Shift / Ctrl (hold)', 'Throttle up / down (fine)'],
    ['+ / -', 'Throttle step up / down'],
    ['PageUp / PageDown', 'Throttle coarse step up / down'],
    ['0 / 9 or Home / End', 'Throttle idle / full (1-8 = 10%-80%)'],
    ['Space (hold)', 'Brakes'],
    ['V', 'Parking brake toggle'],
    ['F', 'Flaps cycle: up → approach → full'],
    ['B', 'Release parcel (cargo missions)'],
    ['E', 'Engine start / stop'],
    ['C', 'Camera: chase → cockpit → tower'],
    ['P / Esc', 'Pause / resume'],
    ['R', 'Restart sortie'],
    ['M', 'Mute / unmute'],
    ['H', 'Help (menus) · HUD full/minimal/off (flight)'],
    ['Mouse drag', 'Look around (double-click recentres)'],
    ['Mouse wheel', 'Chase camera distance'],
    ['Right mouse (hold)', 'Mouse-as-stick: mouse position = pitch/roll'],
  ];
  const helpGroups = [
    ['FLIGHT CONTROLS', 'plane', 0, 4],
    ['ENGINE & THROTTLE', 'fuel', 4, 9],
    ['AIRCRAFT & MISSION', 'cargo', 9, 13],
    ['VIEW & GAME', 'compass', 13, 21],
  ];
  const helpGrid = makeNode('div', 'help-groups');
  // Two balanced columns: flight + engine (9 rows) | aircraft + view (12).
  const helpColumns = [makeNode('div', 'help-column'), makeNode('div', 'help-column')];
  helpColumns.forEach((column) => helpGrid.appendChild(column));
  helpGroups.forEach(([groupName, groupIcon, from, to], groupIndex) => {
    const group = makeNode('div', 'help-group');
    const head = makeNode('div', 'help-group-head');
    const glyph = makeNode('span', 'help-group-icon');
    glyph.innerHTML = menuArtModule.iconSvg(groupIcon, 15);
    head.append(glyph, makeNode('span', 'help-group-name', groupName));
    group.appendChild(head);
    for (const [keyLabel, actionLabel] of helpRows.slice(from, to)) {
      const row = makeNode('div', 'help-row');
      const keys = makeNode('div', 'help-key');
      for (const token of menuArtModule.keyTokens(keyLabel)) {
        keys.appendChild(token.kind === 'key'
          ? makeNode('kbd', 'keycap', token.text)
          : makeNode('span', 'help-key-word', token.text));
      }
      row.append(keys, makeNode('div', 'help-action', actionLabel));
      group.appendChild(row);
    }
    helpColumns[groupIndex < 2 ? 0 : 1].appendChild(group);
  });
  helpCard.appendChild(helpGrid);
  helpCard.appendChild(makeNode('p', 'help-note',
    'Stall is at 18 m/s (16 with full flaps). Approach at 24-27, touch down at 22-26. If in doubt: throttle up, nose down a little, fly away and try again — a go-around always beats a bent aeroplane.'));
  helpScreen.append(helpCard, makeButton('BACK', 'back', {}, 'btn-primary btn-help-back', { icon: 'back', key: 'ESC' }));

  // The bundled typeface (style.css @font-face AuroraSans) loads
  // asynchronously; once it is ready, re-render the visible screen
  // so its canvas charts redraw in it too.
  try {
    if (typeof document !== 'undefined' && document.fonts && typeof document.fonts.load === 'function') {
      Promise.all([document.fonts.load('800 16px AuroraSans'), document.fonts.load('400 16px AuroraSans')])
        .then(() => { if (currentScreenName) showScreen(currentScreenName, currentScreenData); })
        .catch(() => {});
    }
  } catch (error) { /* system fonts stand in */ }

  const screenRenderers = {
    title: renderTitleScreen,
    missions: renderMissionsScreen,
    briefing: renderBriefingScreen,
    pause: renderPauseScreen,
    debrief: renderDebriefScreen,
    crashed: renderCrashedScreen,
    campaign: renderCampaignScreen,
    help: () => {},
  };

  function showScreen(screenName, data) {
    const hideNames = [null, undefined, '', 'none', 'flight', 'hud'];
    for (const [name, screen] of screens) {
      screen.classList.toggle('visible', name === screenName);
    }
    if (hideNames.includes(screenName)) {
      currentScreenName = null;
      currentScreenData = null;
      return;
    }
    currentScreenName = screenName;
    currentScreenData = data || null;
    const renderer = screenRenderers[screenName];
    if (renderer) renderer(data || {});
    const screen = screens.get(screenName);
    if (screen) focusFirstButton(screen);
  }

  // ---------- keyboard shortcuts (screen navigation only; flight keys
  // belong to input.js and are ignored here while no screen is visible) ----------

  function onKeyDown(event) {
    if (!currentScreenName) return;
    const key = event.key;
    let actionName = null;
    if (currentScreenName === 'title') {
      if (key === 'Enter') actionName = 'fly';
      else if (key === 'h' || key === 'H' || key === '?') actionName = 'help';
    } else if (currentScreenName === 'missions') {
      if (key === 'Escape') actionName = 'back';
      else if (key === 'h' || key === 'H' || key === '?') actionName = 'help';
      else if (key === 'ArrowDown' || key === 'ArrowUp') {
        // Step the highlighted sortie; the briefing opens on Enter.
        event.preventDefault();
        const step = key === 'ArrowDown' ? 1 : -1;
        const count = previewList.length;
        if (count > 0) {
          const baseIndex = previewIndex < 0 ? 0 : previewIndex + step;
          const nextIndex = ((baseIndex % count) + count) % count;
          previewMission(nextIndex);
          const row = missionRows[nextIndex];
          if (row && typeof row.focus === 'function') row.focus();
        }
        return;
      } else if (key === 'Enter') {
        const mission = previewList[previewIndex];
        event.preventDefault();
        if (mission && !mission.locked) emitAction('selectMission', { missionId: mission.id, index: previewIndex });
        return;
      }
    } else if (currentScreenName === 'briefing') {
      if (key === 'Enter') actionName = 'start';
      else if (key === 'Escape') actionName = 'back';
      else if (key === 'h' || key === 'H' || key === '?') actionName = 'help';
    } else if (currentScreenName === 'pause') {
      // D-144: P/Esc pause toggling is owned solely by input.js (it queues
      // 'pause' for both keys). Hud used to also emit 'resume' here, so one
      // keypress toggled pause twice and resume never stuck. The RESUME
      // button still emits 'resume' on click (no key involved, no double).
      if (key === 'r' || key === 'R') actionName = 'restart';
      else if (key === 'q' || key === 'Q') actionName = 'quit';
    } else if (currentScreenName === 'debrief') {
      if (key === 'Enter') actionName = 'next';
      else if (key === 'r' || key === 'R') actionName = 'retry';
      else if (key === 'Escape') actionName = 'menu';
    } else if (currentScreenName === 'crashed') {
      if (key === 'Enter' || key === 'r' || key === 'R') actionName = 'retry';
      else if (key === 'Escape') actionName = 'menu';
    } else if (currentScreenName === 'campaign') {
      if (key === 'Enter') actionName = 'fly';
      else if (key === 'Escape') actionName = 'menu';
    } else if (currentScreenName === 'help') {
      if (key === 'Escape' || key === 'h' || key === 'H') actionName = 'back';
    }
    if (actionName) {
      event.preventDefault();
      // VD6-14: on menu screens the HUD help screen is the one help
      // surface. input.js (window keydown, later in the bubble path)
      // also toggles its own overlay on KeyH, so one H press used to
      // open BOTH surfaces. Claim H here: stopPropagation keeps the
      // flight overlay shut in menus; main.js still receives 'help'
      // via emitAction below. In flight no screen is visible, this
      // handler returns early, and input.js owns H alone.
      if (key === 'h' || key === 'H' || key === '?') event.stopPropagation();
      emitAction(actionName, {});
    }
  }
  document.addEventListener('keydown', onKeyDown);

  function destroy() {
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', fitStageToWindow);
    window.removeEventListener('keydown', onHudModeKeyDown, true);
    if (toastTimerId) clearTimeout(toastTimerId);
    if (viewLabelTimerId) clearTimeout(viewLabelTimerId);
    if (fullHud && typeof fullHud.dispose === 'function') {
      try { fullHud.dispose(); } catch (error) { /* view dressing only */ }
    }
    stage.remove();
  }

  return {
    update,
    showScreen,
    toast,
    onAction,
    setActionHandler: onAction,
    destroy,
  };
}

export default createHud;
