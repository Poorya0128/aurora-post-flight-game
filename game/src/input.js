// AURORA POST — input.js (A11 Input & Controls Engineer)
// One job: turn keyboard + mouse into the live `controls` object that
// flight.js consumes, queue one-shot actions for main.js, and own the
// "How to Fly" help overlay (design.md §7.4).
//
// Contract (interfaces.md + task spec):
//   createInput(canvas, hudRoot) -> {
//     controls,          // live object, mutated in place every frame
//     consumeActions(),  // -> string[] queued since last call, then clears
//     resetControls(),   // spawn-safe reset (D-143): pitch/roll/yaw 0,
//                        // throttle 0, flaps UP (0), brake + parkingBrake
//                        // off, held keys + mouse-stick + look offset +
//                        // queued actions cleared. main.js MUST call this
//                        // at every sortie start (beginSortie/launch) so a
//                        // previous sortie's lever/flaps never auto-roll
//                        // the next spawn. Alias: reset().
//     setHelpVisible(bool),
//     dispose(),         // remove listeners, cancel loop, remove DOM
//   }
//
// Fresh page load starts spawn-safe by construction: throttle 0, flaps
// UP (0), axes centred, brakes off (D-143).
//
// controls shape:
//   {
//     pitch:   -1..1,   // +1 = nose UP (climb), -1 = nose down
//     roll:    -1..1,   // +1 = bank RIGHT,     -1 = bank left
//     yaw:     -1..1,   // +1 = nose RIGHT,     -1 = nose left (rudder)
//     throttle: 0..1,   // 0 = idle, 1 = full
//     brake:   boolean, // held brake (Space) OR parking brake latched
//     parkingBrake: boolean,
//     flaps:   0 | 1 | 2, // 0 up, 1 approach, 2 full (design.md §7.1)
//     lookOffset: { yaw, pitch }, // radians, mouse-drag look-around
//     cameraDistance: number,     // metres, mouse wheel (chase cam)
//     mouseStickActive: boolean,  // right mouse held = mouse-as-stick
//   }
//
// STICK CONVENTION (aviation, documented for flight.js / A4):
//   ArrowDown / S = pull stick BACK  = nose up   (pitch -> +1)
//   ArrowUp   / W = push stick FWD   = nose down (pitch -> -1)
// This matches a real stick and design.md §7.4: "Stick back = nose up".
// It is the opposite of many arcade games; the help overlay says so.
//
// Actions emitted by consumeActions() (one-shot, repeat-ignored):
//   'pause'        P or Escape
//   'camera'       C  (cycle chase -> cockpit -> tower)
//   'restart'      R
//   'drop'         B  (release parcel — cargo missions)
//   'flaps'        F  (also cycles controls.flaps 0->1->2->0)
//   'parkingBrake' V  (also toggles controls.parkingBrake)
//   'engine'       E  (engine start/stop toggle)
//   'mute'         M
//   'help'         H  (also toggles the overlay; main.js may just listen)
//   'quit'         Escape while already paused is main.js's call; input
//                  also emits 'quit' on Shift+Escape for menus that want it.
//
// No network, no eval, no external assets. Inline styles only, so this
// file has zero coupling to style.css (A8).

const THROTTLE_RAMP_PER_SECOND = 0.7; // Shift/Ctrl held: fine ramp
const THROTTLE_COARSE_STEP = 0.15; // PageUp/PageDown tap
const THROTTLE_FINE_STEP = 0.05; // +/- tap
const AXIS_RESPONSE_PER_SECOND = 6; // key -> full deflection speed
const AXIS_RELEASE_PER_SECOND = 8; // spring back to centre on release
const LOOK_YAW_LIMIT_RAD = (120 * Math.PI) / 180; // design.md §7.2
const LOOK_PITCH_LIMIT_RAD = (60 * Math.PI) / 180;
const LOOK_SENSITIVITY_RAD_PER_PX = 0.005;
const LOOK_SPRINGBACK_PER_SECOND = 1.5; // chase orbit springs back
const CAMERA_DISTANCE_DEFAULT_M = 18;
const CAMERA_DISTANCE_MIN_M = 6;
const CAMERA_DISTANCE_MAX_M = 60;
const CAMERA_WHEEL_STEP_M = 2;

// Keys that must never scroll the page or trigger browser shortcuts
// while flying. Matched against KeyboardEvent.code.
const GAME_KEY_CODES = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyF', 'KeyB',
  'KeyC', 'KeyP', 'KeyR', 'KeyM', 'KeyH', 'KeyV',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
  'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'Home', 'End', 'PageUp', 'PageDown', 'Escape',
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function moveToward(current, target, maxDelta) {
  if (current < target) return Math.min(target, current + maxDelta);
  return Math.max(target, current - maxDelta);
}

function isTypingTarget(event) {
  const target = event.target;
  if (!target || typeof target.tagName !== 'string') return false;
  const tag = target.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

const HELP_HTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:10px;">
    <h2 style="margin:0;font-size:40px;font-weight:800;letter-spacing:0.12em;color:#F2EDE4;">HOW TO FLY</h2>
    <button type="button" data-aurora-help-close aria-label="Close help"
      style="background:rgba(10,14,24,0.82);color:#FFFFFF;border:1px solid rgba(255,255,255,0.28);border-radius:10px;
             padding:8px 18px;font-size:16px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;cursor:pointer;font-family:inherit;">Close (H)</button>
  </div>
  <p style="margin:0 0 8px;font-size:16px;line-height:1.5;color:#FFFFFF;">
    <strong>Throttle = up/down. Stick back = nose up = slower.</strong>
    Keep speed above 20. Land slow, flat, on the centreline.
  </p>
  <p style="margin:0 0 12px;font-size:16px;line-height:1.5;color:#FFFFFF;">
    First flight (30 seconds): full throttle (9) &rarr; release brake &rarr;
    pull gently (ArrowDown) at 22 m/s &rarr; climb to 200 m &rarr; turn with
    bank (ArrowLeft / ArrowRight) &rarr; throttle back &rarr; descend &rarr;
    flare (pull gently) &rarr; brakes (Space).
  </p>
  <table style="border-collapse:collapse;width:100%;font-size:16px;line-height:1.45;color:#FFFFFF;">
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>ArrowDown / S</b></td><td>Pull stick — nose up (climb, slower)</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>ArrowUp / W</b></td><td>Push stick — nose down (descend, faster)</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>ArrowLeft / ArrowRight</b></td><td>Bank left / right (turn)</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>A / D</b> (Q = left too)</td><td>Rudder left / right (yaw, ground steering)</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>Shift / Ctrl</b> (hold)</td><td>Throttle up / down (fine)</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>+ / -</b></td><td>Throttle step up / down</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>PageUp / PageDown</b></td><td>Throttle coarse step up / down</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>0 / 9</b> or <b>Home / End</b></td><td>Throttle idle / full (1-8 = 10%-80%)</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>Space</b> (hold)</td><td>Brakes</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>V</b></td><td>Parking brake toggle</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>F</b></td><td>Flaps cycle: up &rarr; approach &rarr; full</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>B</b></td><td>Release parcel (cargo missions)</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>E</b></td><td>Engine start / stop</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>C</b></td><td>Camera: chase &rarr; cockpit &rarr; tower</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>P / Esc</b></td><td>Pause / resume</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>R</b></td><td>Restart sortie</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>M</b></td><td>Mute / unmute</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>H</b></td><td>This help screen</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>Mouse drag</b></td><td>Look around (double-click recentres)</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>Mouse wheel</b></td><td>Chase camera distance</td></tr>
    <tr><td style="padding:1px 10px 1px 0;white-space:nowrap;color:#FFD166;font-weight:800;"><b>Right mouse (hold)</b></td><td>Mouse-as-stick: mouse position = pitch/roll</td></tr>
  </table>
  <p style="margin:12px 0 0;font-size:16px;line-height:1.5;color:#FFFFFF;">
    Stall is at 18 m/s (16 with full flaps). Approach at 24-27, touch down
    at 22-26. If in doubt: throttle up, nose down a little, fly away and
    try again — a go-around always beats a bent aeroplane.
  </p>
`;

export function createInput(canvas, hudRoot) {
  const controls = {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0,
    brake: false,
    parkingBrake: false,
    flaps: 0,
    lookOffset: { yaw: 0, pitch: 0 },
    cameraDistance: CAMERA_DISTANCE_DEFAULT_M,
    mouseStickActive: false,
  };

  const heldKeys = new Set();
  const actionQueue = [];
  let disposed = false;
  let animationFrameId = null;
  let lastFrameTimestampMs = null;

  // --- Mouse state -------------------------------------------------------
  let lookDragPointerId = null;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let mouseStickPitch = 0;
  let mouseStickRoll = 0;

  // --- Help overlay DOM ----------------------------------------------------
  const overlayRoot = hudRoot || (canvas && canvas.parentElement) || document.body;

  const helpOverlay = document.createElement('div');
  helpOverlay.setAttribute('role', 'dialog');
  helpOverlay.setAttribute('aria-label', 'How to fly — controls help');
  helpOverlay.style.cssText = [
    'position:absolute',
    'inset:0',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'background:rgba(10,14,24,0.55)',
    'z-index:40',
    'pointer-events:auto',
  ].join(';');

  const helpPanel = document.createElement('div');
  helpPanel.style.cssText = [
    'max-width:min(680px,92vw)',
    'max-height:88vh',
    'overflow:auto',
    'background:rgba(10,14,24,0.82)',
    'color:#FFFFFF',
    'border:1px solid rgba(255,255,255,0.28)',
    'border-radius:10px',
    'padding:20px 28px',
    'font-family:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif',
    'box-shadow:0 12px 40px rgba(0,0,0,0.5)',
  ].join(';');
  helpPanel.innerHTML = HELP_HTML;
  helpOverlay.appendChild(helpPanel);
  overlayRoot.appendChild(helpOverlay);

  // Help button in the navy .btn language (VD-13), hidden in flight
  // + shot mode: help opens with the H key (keys hint) in flight or
  // HOW TO FLY in the menus. Kept in the DOM for the click callback.
  const helpButton = document.createElement('button');
  helpButton.type = 'button';
  helpButton.textContent = '? Help (H)';
  helpButton.setAttribute('aria-label', 'Show controls help');
  helpButton.style.cssText = [
    'position:absolute',
    'right:12px',
    'bottom:12px',
    'z-index:39',
    'background:rgba(10,14,24,0.82)',
    'color:#FFFFFF',
    'border:1px solid rgba(255,255,255,0.28)',
    'border-radius:10px',
    'padding:8px 16px',
    'font-family:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif',
    'font-size:16px',
    'font-weight:700',
    'letter-spacing:0.14em',
    'text-transform:uppercase',
    'min-height:40px',
    'cursor:pointer',
    // VD-13: navy .btn language, hidden in flight + shot mode —
    // help opens with H (keys hint) or HOW TO FLY in the menus.
    'display:none',
  ].join(';');
  overlayRoot.appendChild(helpButton);

  let helpVisible = false;
  function setHelpVisible(visible) {
    helpVisible = Boolean(visible);
    helpOverlay.style.display = helpVisible ? 'flex' : 'none';
  }
  function toggleHelp() {
    setHelpVisible(!helpVisible);
  }

  const closeButton = helpPanel.querySelector('[data-aurora-help-close]');
  function onCloseButtonClick() {
    setHelpVisible(false);
  }
  function onHelpButtonClick() {
    toggleHelp();
    actionQueue.push('help');
  }
  function onOverlayClick(event) {
    if (event.target === helpOverlay) setHelpVisible(false);
  }
  if (closeButton) closeButton.addEventListener('click', onCloseButtonClick);
  helpButton.addEventListener('click', onHelpButtonClick);
  helpOverlay.addEventListener('click', onOverlayClick);

  // --- Keyboard -------------------------------------------------------------
  function queueAction(actionName) {
    actionQueue.push(actionName);
  }

  function setThrottle(value) {
    controls.throttle = clamp(value, 0, 1);
  }

  function handleActionKey(code, event) {
    // One-shot actions: ignore auto-repeat so holding a key fires once.
    if (event.repeat) return;
    switch (code) {
      case 'KeyF':
        controls.flaps = (controls.flaps + 1) % 3;
        queueAction('flaps');
        break;
      case 'KeyB':
        queueAction('drop');
        break;
      case 'KeyC':
        queueAction('camera');
        break;
      case 'KeyP':
        queueAction('pause');
        break;
      case 'Escape':
        queueAction(event.shiftKey ? 'quit' : 'pause');
        break;
      case 'KeyR':
        queueAction('restart');
        break;
      case 'KeyM':
        queueAction('mute');
        break;
      case 'KeyH':
        toggleHelp();
        queueAction('help');
        break;
      case 'KeyE':
        queueAction('engine');
        break;
      case 'KeyV':
        controls.parkingBrake = !controls.parkingBrake;
        queueAction('parkingBrake');
        break;
      case 'Equal':
      case 'NumpadAdd':
        setThrottle(controls.throttle + THROTTLE_FINE_STEP);
        break;
      case 'Minus':
      case 'NumpadSubtract':
        setThrottle(controls.throttle - THROTTLE_FINE_STEP);
        break;
      case 'PageUp':
        setThrottle(controls.throttle + THROTTLE_COARSE_STEP);
        break;
      case 'PageDown':
        setThrottle(controls.throttle - THROTTLE_COARSE_STEP);
        break;
      case 'Digit0':
      case 'Home':
        setThrottle(0);
        break;
      case 'Digit9':
      case 'End':
        setThrottle(1);
        break;
      case 'Digit1': setThrottle(0.1); break;
      case 'Digit2': setThrottle(0.2); break;
      case 'Digit3': setThrottle(0.3); break;
      case 'Digit4': setThrottle(0.4); break;
      case 'Digit5': setThrottle(0.5); break;
      case 'Digit6': setThrottle(0.6); break;
      case 'Digit7': setThrottle(0.7); break;
      case 'Digit8': setThrottle(0.8); break;
      default:
        break;
    }
  }

  function onKeyDown(event) {
    if (isTypingTarget(event)) return;
    const code = event.code;
    if (GAME_KEY_CODES.has(code)) event.preventDefault();
    heldKeys.add(code);
    handleActionKey(code, event);
  }

  function onKeyUp(event) {
    heldKeys.delete(event.code);
  }

  function onWindowBlur() {
    // Never leave a key stuck down when focus leaves the game.
    heldKeys.clear();
    lookDragPointerId = null;
    controls.mouseStickActive = false;
    mouseStickPitch = 0;
    mouseStickRoll = 0;
  }

  // --- Mouse ------------------------------------------------------------------
  function onPointerDown(event) {
    if (!canvas) return;
    if (event.button === 2) {
      // Right mouse held = mouse-as-stick (design.md §7.2 nice-to-have).
      controls.mouseStickActive = true;
      updateMouseStickFromEvent(event);
      event.preventDefault();
      return;
    }
    if (event.button === 0) {
      lookDragPointerId = event.pointerId;
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      if (canvas.setPointerCapture) {
        try { canvas.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
      }
    }
  }

  function updateMouseStickFromEvent(event) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const offsetX = (event.clientX - rect.left) / rect.width - 0.5; // -0.5..0.5
    const offsetY = (event.clientY - rect.top) / rect.height - 0.5;
    // Mouse right = bank right; mouse down (pull toward you) = nose up.
    mouseStickRoll = clamp(offsetX * 2, -1, 1);
    mouseStickPitch = clamp(offsetY * 2, -1, 1);
  }

  function onPointerMove(event) {
    if (controls.mouseStickActive) {
      updateMouseStickFromEvent(event);
      return;
    }
    if (lookDragPointerId === null || event.pointerId !== lookDragPointerId) return;
    const deltaX = event.clientX - lastPointerX;
    const deltaY = event.clientY - lastPointerY;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    // Drag right = look right; drag up = look up (natural grab-the-world
    // inverted: moving mouse up raises the view).
    controls.lookOffset.yaw = clamp(
      controls.lookOffset.yaw + deltaX * LOOK_SENSITIVITY_RAD_PER_PX,
      -LOOK_YAW_LIMIT_RAD, LOOK_YAW_LIMIT_RAD,
    );
    controls.lookOffset.pitch = clamp(
      controls.lookOffset.pitch - deltaY * LOOK_SENSITIVITY_RAD_PER_PX,
      -LOOK_PITCH_LIMIT_RAD, LOOK_PITCH_LIMIT_RAD,
    );
  }

  function onPointerUp(event) {
    if (event.button === 2) {
      controls.mouseStickActive = false;
      mouseStickPitch = 0;
      mouseStickRoll = 0;
    }
    if (event.pointerId === lookDragPointerId) lookDragPointerId = null;
  }

  function onDoubleClick() {
    controls.lookOffset.yaw = 0;
    controls.lookOffset.pitch = 0;
  }

  function onWheel(event) {
    event.preventDefault();
    const direction = event.deltaY > 0 ? 1 : -1; // wheel down = pull back
    controls.cameraDistance = clamp(
      controls.cameraDistance + direction * CAMERA_WHEEL_STEP_M,
      CAMERA_DISTANCE_MIN_M, CAMERA_DISTANCE_MAX_M,
    );
  }

  function onContextMenu(event) {
    event.preventDefault();
  }

  // --- Per-frame axis update ---------------------------------------------------
  function readAxisTarget(positiveCodes, negativeCodes) {
    let target = 0;
    for (const code of positiveCodes) if (heldKeys.has(code)) target += 1;
    for (const code of negativeCodes) if (heldKeys.has(code)) target -= 1;
    return clamp(target, -1, 1);
  }

  function updateControls(deltaSeconds) {
    // Pitch: ArrowDown/S = pull = nose up (+1); ArrowUp/W = push (-1).
    let pitchTarget = readAxisTarget(['ArrowDown', 'KeyS'], ['ArrowUp', 'KeyW']);
    let rollTarget = readAxisTarget(['ArrowRight'], ['ArrowLeft']);
    // Yaw: A/D primary. Q also yaws left. E is reserved for engine
    // start/stop (task spec lists both Q/E yaw and E engine; E-as-yaw
    // would cut the engine on every right-rudder press, so engine wins
    // and A/D carries yaw fully).
    const yawTarget = readAxisTarget(['KeyD'], ['KeyA', 'KeyQ']);

    if (controls.mouseStickActive) {
      pitchTarget = mouseStickPitch;
      rollTarget = mouseStickRoll;
    }

    const pitchRate = pitchTarget !== 0 ? AXIS_RESPONSE_PER_SECOND : AXIS_RELEASE_PER_SECOND;
    const rollRate = rollTarget !== 0 ? AXIS_RESPONSE_PER_SECOND : AXIS_RELEASE_PER_SECOND;
    const yawRate = yawTarget !== 0 ? AXIS_RESPONSE_PER_SECOND : AXIS_RELEASE_PER_SECOND;
    controls.pitch = moveToward(controls.pitch, pitchTarget, pitchRate * deltaSeconds);
    controls.roll = moveToward(controls.roll, rollTarget, rollRate * deltaSeconds);
    controls.yaw = moveToward(controls.yaw, yawTarget, yawRate * deltaSeconds);

    // Throttle fine ramp while Shift (up) / Ctrl (down) is held.
    if (heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight')) {
      setThrottle(controls.throttle + THROTTLE_RAMP_PER_SECOND * deltaSeconds);
    }
    if (heldKeys.has('ControlLeft') || heldKeys.has('ControlRight')) {
      setThrottle(controls.throttle - THROTTLE_RAMP_PER_SECOND * deltaSeconds);
    }

    controls.brake = heldKeys.has('Space') || controls.parkingBrake;

    // Chase look offset springs back when not dragging (design.md §7.2).
    if (lookDragPointerId === null && !controls.mouseStickActive) {
      const springStep = LOOK_SPRINGBACK_PER_SECOND * deltaSeconds;
      controls.lookOffset.yaw = moveToward(controls.lookOffset.yaw, 0, springStep);
      controls.lookOffset.pitch = moveToward(controls.lookOffset.pitch, 0, springStep);
    }
  }

  function frameLoop(timestampMs) {
    if (disposed) return;
    if (lastFrameTimestampMs !== null) {
      const deltaSeconds = clamp((timestampMs - lastFrameTimestampMs) / 1000, 0, 0.1);
      updateControls(deltaSeconds);
    }
    lastFrameTimestampMs = timestampMs;
    animationFrameId = requestAnimationFrame(frameLoop);
  }

  // --- Wire up ------------------------------------------------------------------
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);
  if (canvas) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
  }
  animationFrameId = requestAnimationFrame(frameLoop);

  function consumeActions() {
    const actions = actionQueue.slice();
    actionQueue.length = 0;
    return actions;
  }

  // D-143: spawn-safe reset. Called by main.js at every sortie start.
  // Zeroes axes, throttle, flaps and brakes, and drops any held-key,
  // mouse-stick, look-drag or queued-action state from the previous
  // sortie so the plane never rolls unattended on spawn. cameraDistance
  // (player preference) is intentionally preserved.
  function resetControls() {
    controls.pitch = 0;
    controls.roll = 0;
    controls.yaw = 0;
    controls.throttle = 0;
    controls.flaps = 0;
    controls.brake = false;
    controls.parkingBrake = false;
    controls.lookOffset.yaw = 0;
    controls.lookOffset.pitch = 0;
    controls.mouseStickActive = false;
    heldKeys.clear();
    actionQueue.length = 0;
    lookDragPointerId = null;
    mouseStickPitch = 0;
    mouseStickRoll = 0;
  }

  function dispose() {
    disposed = true;
    if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onWindowBlur);
    if (canvas) {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    }
    if (closeButton) closeButton.removeEventListener('click', onCloseButtonClick);
    helpButton.removeEventListener('click', onHelpButtonClick);
    helpOverlay.removeEventListener('click', onOverlayClick);
    helpOverlay.remove();
    helpButton.remove();
    heldKeys.clear();
  }

  return { controls, consumeActions, resetControls, reset: resetControls, setHelpVisible, dispose };
}

export default createInput;
